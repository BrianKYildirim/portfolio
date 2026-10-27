// TCP Server Playground: the ported KeyValueStore and CommandParser (kv-core.js) inside a simulated
// server.py — accept loop, a daemon thread per client, store.lock and store.txt. No network is used.
import { KeyValueStore, CommandParser } from './kv-core.js';

// Fixed durations in virtual ms, slowed for visibility (not measured).
const D = { transit: 280, accept: 120, start: 80, parse: 60, op: 80, save: 120, perKey: 20, send: 40, restart: 700, linger: 2000 };
const IDS = ['A', 'B', 'C', 'D'];
const CHIPS = [['SET', 'SET key value'], ['GET', 'GET key'], ['REMOVE', 'REMOVE key'], ['PRINT', 'PRINT'], ['quit', 'quit']];
const LANE = { start: 'starting', recv: 'recv()', parse: 'parse', wait: 'waiting for lock', hold: 'holding lock', save: 'save() → store.txt', send: 'sendall()', closed: 'closed' };
const enc = new TextEncoder();
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const tokens = (s) => s.split(/\s+/).filter(Boolean); // str.split()

// bytes.decode() with Python's UnicodeDecodeError wording for the cases a 1024-byte cut can produce.
function pyDecode(b) {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b) }; } catch { /* describe below */ }
  for (let i = 0; i < b.length;) {
    const c = b[i], n = c < 0x80 ? 1 : c >= 0xc2 && c < 0xe0 ? 2 : c >= 0xe0 && c < 0xf0 ? 3 : c >= 0xf0 && c < 0xf5 ? 4 : 0;
    const hex = `0x${c.toString(16)}`;
    if (!n) return { error: `'utf-8' codec can't decode byte ${hex} in position ${i}: invalid start byte` };
    let j = 1;
    while (j < n && i + j < b.length && (b[i + j] & 0xc0) === 0x80) j++;
    if (j < n) {
      if (i + j < b.length) return { error: `'utf-8' codec can't decode byte ${hex} in position ${i}: invalid continuation byte` };
      return { error: j === 1 ? `'utf-8' codec can't decode byte ${hex} in position ${i}: unexpected end of data` : `'utf-8' codec can't decode bytes in position ${i}-${i + j - 1}: unexpected end of data` };
    }
    i += n;
  }
  return { error: "'utf-8' codec can't decode the data" };
}

const TEMPLATE = `
<div class="demo-kv-bar">
  <div class="demo-chips" role="group" aria-label="Scenarios">
    <button type="button" class="demo-chip" data-scenario="three">Three clients write at once</button>
    <button type="button" class="demo-chip" data-scenario="restart">Write, restart, read</button>
  </div>
  <div class="demo-seg" role="group" aria-label="Speed">${[0.5, 1, 2].map((s) => `<button type="button" data-speed="${s}" aria-pressed="${s === 1}">${s}×</button>`).join('')}</div>
</div>
<p class="demo-kv-strip" data-strip></p>
<div class="demo-kv" data-kv>
  <svg class="demo-kv-wires" aria-hidden="true" data-wires></svg>
  <div class="demo-kv-clients">
    <div data-clients></div>
    <button type="button" class="project-link" data-add>+ Add client</button>
  </div>
  <div class="demo-card demo-kv-server">
    <div class="demo-kv-head"><code>server.py</code><span class="demo-badge" data-badge></span></div>
    <p class="demo-small demo-mono">0.0.0.0:3490 · listen(10)</p>
    <button type="button" class="project-link" data-restart>Restart server</button>
    <ul class="demo-kv-lanes" data-lanes aria-label="Server threads"></ul>
    <p class="demo-small demo-mono" data-lock></p>
    <table class="demo-kv-table"><caption class="demo-label">Store (dict order)</caption><thead><tr><th>KEY</th><th>VALUE</th></tr></thead><tbody data-store></tbody></table>
    <div><p class="demo-label">store.txt</p><pre class="demo-code demo-kv-file" data-file tabindex="0"></pre></div>
  </div>
  <div class="demo-kv-logwrap">
    <div class="demo-row"><span class="demo-label">Server log</span>
      <div class="demo-chips" role="group" aria-label="Log filter">${[['all', 'All'], ['out', 'Server output'], ['note', 'Notes']].map(([k, l]) => `<button type="button" class="demo-chip" data-filter="${k}" aria-pressed="${k === 'all'}">${l}</button>`).join('')}</div>
    </div>
    <ol class="demo-kv-log" role="log" aria-label="Server log" data-log tabindex="0"></ol>
  </div>
</div>`;

const CLIENT = (id) => `
<fieldset class="demo-kv-client" data-client="${id}">
  <legend class="demo-legend">Client ${id}</legend>
  <p class="demo-kv-state" data-state></p>
  <button type="button" class="project-link" data-conn></button>
  <form class="demo-kv-form" data-form>
    <input class="demo-input" maxlength="1024" placeholder="SET user:42 Brian" aria-label="Command for client ${id}" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button type="submit" class="project-link-accent">Send</button>
  </form>
  <p class="demo-small" data-hint hidden></p>
  <div class="demo-chips" role="group" aria-label="Command templates for client ${id}">${CHIPS.map(([l, t]) => `<button type="button" class="demo-chip" data-tpl="${t}">${l}</button>`).join('')}</div>
  <pre class="demo-kv-out" data-out></pre>
</fieldset>`;

export function mount(root, { status }) {
  const mountEl = root.querySelector('.demo-mount');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches, narrow = matchMedia('(max-width: 767.98px)');
  mountEl.innerHTML = TEMPLATE;
  const q = (s) => mountEl.querySelector(s);
  const el = { kv: q('[data-kv]'), wires: q('[data-wires]'), clients: q('[data-clients]'), add: q('[data-add]'), badge: q('[data-badge]'), lanes: q('[data-lanes]'), lock: q('[data-lock]'), store: q('[data-store]'), file: q('[data-file]'), log: q('[data-log]'), strip: q('[data-strip]') };
  let vt, timers, tseq, file, server, epoch, clients, dots, waiters, logLines, filter = 'all', speed = 1, lastUsed = null, scenario = 0;
  let raf = 0, lastTs = 0, hostPaused = false, dirty = true, flashUntil = 0;

  // ---------- Simulation ----------
  const at = (ms, fn, ep = null) => {
    const t = { due: vt + ms, seq: tseq++, fn, ep };
    let i = timers.length;
    while (i > 0 && (timers[i - 1].due > t.due || (timers[i - 1].due === t.due && timers[i - 1].seq > t.seq))) i--;
    timers.splice(i, 0, t);
    kick();
  };
  const srv = (ms, fn) => at(ms, fn, epoch); // server-side work dies with the process
  const out = (t) => { logLines.push({ k: 'out', t }); dirty = true; };
  const note = (t) => { logLines.push({ k: 'note', t: `# ${t}` }); dirty = true; };
  const lane = (th, s, extra = '') => { th.state = s; th.extra = extra; dirty = true; };
  const travel = (c, dir, fn) => { dots.push({ c, dir, start: vt, dur: D.transit }); at(D.transit, fn); };

  function boot() {
    epoch++;
    server = { up: true, kv: new KeyValueStore(file), threads: [], seq: 0, lock: { owner: null, count: 0, queue: [] } };
    server.parser = new CommandParser(server.kv);
    out('Server listening on 0.0.0.0:3490');
    const n = file.text.split('\n').filter((l) => l.trim().includes('\t')).length;
    note(`load(): read ${n} line${n === 1 ? '' : 's'} from store.txt`);
  }
  function reset() {
    vt = 0; timers = []; tseq = 0; file = { text: '' }; epoch = 0; dots = []; waiters = []; logLines = []; scenario++;
    clients = [];
    el.clients.replaceChildren();
    addClient(); addClient();
    boot();
    dirty = true;
  }

  // handle_client(), one step at a time.
  function threadRecv(th) {
    if (!th.alive) return;
    if (th.inBuf.length) {
      const data = th.inBuf.slice(0, 1024);
      th.inBuf = th.inBuf.slice(1024);
      return handle(th, data);
    }
    if (th.fin) { out(`Client ${th.addr} disconnected.`); return closeThread(th); }
    lane(th, 'recv');
  }
  function handle(th, data) {
    const d = pyDecode(data);
    if (d.error) { out(`Error handling client ${th.addr}: ${d.error}`); return closeThread(th); }
    const message = d.text.trim();
    out(`Received from ${th.addr}: ${message}`);
    if (message.toLowerCase() === 'quit') { out(`Client ${th.addr} requested to quit.`); return closeThread(th); }
    lane(th, 'parse');
    srv(D.parse, () => {
      const tk = tokens(message), cmd = tk[0]?.toUpperCase();
      const reaches = (cmd === 'SET' && tk.length === 3) || ((cmd === 'GET' || cmd === 'REMOVE') && tk.length === 2) || cmd === 'PRINT';
      if (!reaches) return send(th, server.parser.parse_and_execute(message)); // error branches never take the lock
      acquire(th, () => srv(D.op, () => {
        const response = server.parser.parse_and_execute(message);
        dirty = true;
        if (cmd === 'SET' || (cmd === 'REMOVE' && response.startsWith('Removed'))) {
          const n = server.kv.store.size;
          lane(th, 'save', ` · ${n} line${n === 1 ? '' : 's'}`);
          srv(D.save + D.perKey * n, () => { flashUntil = reduced ? 0 : performance.now() + 400; release(th); send(th, response); });
        } else { release(th); send(th, response); }
      }));
    });
  }
  function acquire(th, fn) {
    const L = server.lock;
    if (!L.owner) { L.owner = th; L.count = 1; lane(th, 'hold'); return fn(); }
    note(`${th.name} waiting for store.lock (held by ${L.owner.name})`);
    L.queue.push([th, fn]);
    lane(th, 'wait');
  }
  function release() {
    const L = server.lock, next = L.queue.shift();
    L.owner = null; L.count = 0; dirty = true;
    if (next) { L.owner = next[0]; L.count = 1; lane(next[0], 'hold'); next[1](); }
  }
  function send(th, response) {
    lane(th, 'send');
    srv(D.send, () => {
      const c = th.client, bytes = enc.encode(response);
      out(`Response sent to ${th.addr}: ${response.trim()}`);
      if (c.thread === th && !c.gone) travel(c, 'res', () => { if (c.thread === th) { c.buf = cat(c.buf, bytes); if (c.state === 'waiting') clientRead(c); } });
      threadRecv(th);
    });
  }
  function closeThread(th) {
    out(`Connection with ${th.addr} closed.`);
    th.alive = false; lane(th, 'closed');
    at(D.linger, () => { server.threads = server.threads.filter((t) => t !== th); dirty = true; });
    const c = th.client;
    if (c.thread === th) { c.peerClosed = true; if (c.state === 'waiting' && !c.buf.length) clientEOF(c); }
  }

  // ---------- client.py ----------
  function addClient() {
    const id = IDS[clients.length];
    if (!id) return;
    el.clients.insertAdjacentHTML('beforeend', CLIENT(id));
    const f = el.clients.lastElementChild;
    clients.push({ id, state: 'disconnected', out: '', buf: new Uint8Array(0), thread: null, peerClosed: false, gone: false, f, input: f.querySelector('input') });
    dirty = true;
  }
  const show = (c, line) => { c.out = line; dirty = true; if (c === lastUsed) status(`Client ${c.id}: ${line}`); };
  function connect(c) {
    if (c.state !== 'disconnected') return;
    c.state = 'connecting'; c.buf = new Uint8Array(0); c.peerClosed = false; c.gone = false; dirty = true;
    travel(c, 'req', () => {
      if (!server.up) { c.state = 'disconnected'; return show(c, 'Failed to connect to server: [Errno 111] Connection refused'); }
      srv(D.accept, () => {
        const th = { n: ++server.seq, client: c, inBuf: new Uint8Array(0), fin: false, alive: true, state: 'start', extra: '', addr: `('127.0.0.1', ${49152 + Math.floor(Math.random() * 16384)})` };
        th.name = `Thread-${th.n}`;
        server.threads.push(th); c.thread = th;
        note(`accept() returned; started ${th.name} (handle_client, daemon)`);
        srv(D.start, () => {
          out(`Connection from ${th.addr}`);
          c.state = 'connected'; show(c, 'Connected to server at localhost:3490');
          threadRecv(th);
        });
      });
    });
  }
  function clientSend(c, message) {
    const bytes = enc.encode(message), th = c.thread;
    lastUsed = c;
    travel(c, 'req', () => {
      if (!th?.alive) return; // bytes already sent still arrive after a quit or Ctrl+C
      th.inBuf = cat(th.inBuf, bytes);
      if (c.gone) th.fin = true; // quit: the socket closes right after the data
      if (th.state === 'recv') threadRecv(th);
    });
    if (message.toLowerCase() === 'quit') { c.gone = true; c.state = 'disconnected'; c.thread = null; return show(c, 'Exiting client.'); }
    c.state = 'waiting'; dirty = true;
    if (c.buf.length) { note(`Client ${c.id}: recv() returned bytes left over from an earlier response`); return clientRead(c); }
    if (c.peerClosed) at(D.transit, () => { if (c.state === 'waiting' && !c.buf.length) clientEOF(c); });
  }
  function clientRead(c) {
    const data = c.buf.slice(0, 1024), rest = c.buf.length - data.length;
    c.buf = c.buf.slice(data.length);
    if (rest) note(`Client ${c.id}: recv(1024) read 1024 of ${data.length + rest} bytes; the rest stays in the socket buffer`);
    const d = pyDecode(data);
    if (d.error) { show(c, `Error receiving data: ${d.error}\nServer disconnected.`); return hangUp(c); }
    c.state = 'connected';
    show(c, `Response: ${d.text.replace(/\n$/, '')}`);
  }
  function clientEOF(c) { show(c, 'Server disconnected.'); hangUp(c); }
  function hangUp(c) {
    const th = c.thread;
    c.state = 'disconnected'; c.thread = null; c.gone = true; dirty = true;
    if (th?.alive) travel(c, 'req', () => { th.fin = true; if (th.state === 'recv') threadRecv(th); });
  }
  function disconnect(c) { // Ctrl+C in client.py
    lastUsed = c;
    show(c, 'Client shutting down.');
    hangUp(c);
  }
  function restart() {
    if (!server.up) return;
    out('Server is shutting down gracefully.');
    out('Server socket closed.');
    note('The process exits; daemon threads stop without printing.');
    server.up = false; server.threads = []; server.lock = { owner: null, count: 0, queue: [] }; epoch++;
    for (const c of clients) {
      if (c.state === 'connecting') { c.state = 'disconnected'; show(c, 'Failed to connect to server: [Errno 111] Connection refused'); }
      else if (c.state !== 'disconnected') { c.state = 'disconnected'; c.thread = null; show(c, 'Server disconnected.'); }
    }
    note('client.py would notice the closed socket on its next recv(); shown immediately here');
    status('Server restarting.');
    at(D.restart, () => { boot(); status('Server listening on 0.0.0.0:3490.'); });
    dirty = true;
  }

  // ---------- Scenarios ----------
  const until = (tok, cond) => new Promise((resolve, reject) => { waiters.push({ tok, cond, resolve, reject }); kick(); });
  const idle = (c) => c.state === 'connected';
  async function runScenario(name) {
    const tok = ++scenario;
    try {
      if (name === 'three') {
        while (clients.length < 3) addClient();
        const cs = clients.slice(0, 3);
        await until(tok, () => server.up);
        cs.forEach(connect);
        await until(tok, () => cs.every(idle));
        cs.forEach((c, i) => { c.input.value = `SET counter ${i + 1}`; clientSend(c, c.input.value); });
        status('Three SETs sent in the same tick; watch the lock queue.');
      } else {
        const a = clients[0];
        await until(tok, () => server.up);
        connect(a);
        await until(tok, () => idle(a));
        clientSend(a, (a.input.value = 'SET language Python'));
        await until(tok, () => idle(a) && server.lock.owner === null);
        restart();
        await until(tok, () => server.up);
        connect(a);
        await until(tok, () => idle(a));
        clientSend(a, (a.input.value = 'GET language'));
      }
    } catch { /* cancelled by a reset or another scenario */ }
  }

  // ---------- Rendering ----------
  const clientState = (c) => (c.state === 'connected' ? `connected ${c.thread?.addr || ''}` : c.state === 'waiting' ? 'waiting for response…' : c.state === 'connecting' ? 'connecting…' : 'disconnected');
  function render() {
    dirty = false;
    for (const c of clients) {
      const s = c.f.querySelector('[data-state]'), conn = c.f.querySelector('[data-conn]'), send = c.f.querySelector('[type="submit"]'), hint = c.f.querySelector('[data-hint]');
      s.textContent = clientState(c); s.dataset.s = c.state;
      conn.textContent = c.state === 'disconnected' ? 'Connect' : 'Disconnect (Ctrl+C)';
      conn.disabled = c.state === 'connecting';
      const len = enc.encode(c.input.value).length;
      send.disabled = c.state !== 'connected' || !c.input.value || len > 1024;
      hint.hidden = len <= 1024;
      hint.textContent = `${len} bytes: server.py reads at most 1024 per recv(), so send 1024 bytes or fewer.`;
      c.f.querySelector('[data-out]').textContent = c.out;
    }
    el.add.hidden = clients.length >= 4;
    el.badge.className = `demo-badge ${server.up ? 'is-pass' : 'demo-badge-off'}`;
    el.badge.textContent = server.up ? '● LISTENING' : 'STOPPED';
    const L = server.lock;
    el.lock.textContent = `store.lock (RLock) · owner ${L.owner?.name || 'none'} · count ${L.count} · waiting [${L.queue.map(([t]) => t.name).join(', ')}]`;
    const live = server.threads.filter((t) => t.alive).length;
    el.strip.textContent = `${server.up ? 'LISTENING' : 'STOPPED'} · ${live} thread${live === 1 ? '' : 's'} · ${L.owner ? `lock held by ${L.owner.name}` : 'lock free'}`;
    const lanes = [`<li class="demo-lane"><span>main · accept()</span><span class="demo-state">${server.up ? 'accept()' : 'stopped'}</span></li>`];
    for (const th of server.threads) lanes.push(`<li class="demo-lane" data-lane="${th.client.id}"><span>${th.name} ←${th.client.id}</span><span class="demo-state is-${th.state}">${LANE[th.state]}${th.extra}</span><span class="demo-wire"><i></i></span></li>`);
    el.lanes.innerHTML = lanes.join('');
    el.store.replaceChildren(...(server.kv.store.size ? [...server.kv.store].map(([k, v]) => { const tr = document.createElement('tr'); tr.append(Object.assign(document.createElement('td'), { textContent: k }), Object.assign(document.createElement('td'), { textContent: v })); return tr; }) : [Object.assign(document.createElement('tr'), { innerHTML: '<td colspan="2">empty</td>' })]));
    el.file.textContent = file.text ? file.text.replace(/\t/g, '⇥') : '(empty)';
    const lines = logLines.filter((l) => filter === 'all' || l.k === filter).slice(narrow.matches ? -30 : -200);
    el.log.replaceChildren(...lines.map((l) => Object.assign(document.createElement('li'), { className: l.k === 'note' ? 'is-note' : '', textContent: l.t })));
    el.log.scrollTop = el.log.scrollHeight;
  }
  function renderMotion() {
    el.file.classList.toggle('is-flash', performance.now() < flashUntil);
    dots = dots.filter((d) => vt < d.start + d.dur);
    const showDots = !reduced, base = el.kv.getBoundingClientRect(), segs = [];
    if (!narrow.matches) {
      for (const c of clients) {
        const laneEl = c.thread && el.lanes.querySelector(`[data-lane="${c.id}"]`);
        if (!laneEl) continue;
        const a = c.f.getBoundingClientRect(), b = laneEl.getBoundingClientRect();
        const x1 = a.right - base.left, y1 = a.top + 24 - base.top, x2 = b.left - base.left, y2 = b.top + b.height / 2 - base.top;
        segs.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
        for (const d of dots) if (d.c === c && showDots) {
          const p = Math.min(1, (vt - d.start) / d.dur), k = d.dir === 'req' ? p : 1 - p;
          segs.push(`<circle class="${d.dir}" r="3" cx="${x1 + (x2 - x1) * k}" cy="${y1 + (y2 - y1) * k}"/>`);
        }
      }
    }
    el.wires.innerHTML = segs.join('');
    for (const li of el.lanes.querySelectorAll('[data-lane]')) { // narrow layouts: the dot travels inside the lane
      const d = showDots && dots.find((x) => x.c.id === li.dataset.lane), i = li.querySelector('.demo-wire i');
      i.style.display = d ? 'block' : 'none';
      if (d) { const p = Math.min(1, (vt - d.start) / d.dur); i.style.left = `${(d.dir === 'req' ? p : 1 - p) * 100}%`; i.className = d.dir; }
    }
  }

  // ---------- Clock ----------
  function frame(ts) {
    raf = 0;
    const dt = Math.min(lastTs ? ts - lastTs : 16, 100) * speed;
    lastTs = ts;
    const target = vt + dt;
    while (timers.length && timers[0].due <= target) {
      const t = timers.shift();
      vt = Math.max(vt, t.due);
      if (t.ep === null || t.ep === epoch) t.fn();
    }
    vt = target;
    for (const w of [...waiters]) {
      if (w.tok !== scenario) { waiters.splice(waiters.indexOf(w), 1); w.reject(); }
      else if (w.cond()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
    }
    if (dirty) render();
    renderMotion();
    if (timers.length || dots.length || waiters.length || performance.now() < flashUntil) kick();
    else lastTs = 0;
  }
  function kick() { if (!raf && !hostPaused) raf = requestAnimationFrame(frame); }

  // ---------- Events ----------
  const clientOf = (node) => clients.find((c) => c.f === node.closest('[data-client]'));
  mountEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const c = clientOf(b);
    if (b.matches('[data-conn]')) { lastUsed = c; c.state === 'disconnected' ? connect(c) : disconnect(c); }
    else if (b.dataset.tpl) {
      c.input.value = b.dataset.tpl; c.input.focus();
      const sp = b.dataset.tpl.indexOf(' ');
      if (sp > 0) c.input.setSelectionRange(sp + 1, b.dataset.tpl.length);
    } else if (b.matches('[data-add]')) addClient();
    else if (b.matches('[data-restart]')) restart();
    else if (b.dataset.scenario) runScenario(b.dataset.scenario);
    else if (b.dataset.speed) { speed = +b.dataset.speed; mountEl.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }
    else if (b.dataset.filter) { filter = b.dataset.filter; mountEl.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }
    dirty = true; kick();
  });
  mountEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = clientOf(e.target), v = c.input.value;
    if (c.state !== 'connected' || !v || enc.encode(v).length > 1024) return;
    clientSend(c, v);
    kick();
  });
  mountEl.addEventListener('input', () => { dirty = true; kick(); });
  const resetBtn = root.querySelector('.demo-status .btn-ghost'), onReset = () => { reset(); status('Reset: new store.txt, server listening, clients disconnected.'); kick(); };
  resetBtn.addEventListener('click', onReset);

  reset();
  status('Connect a client, then send a command.');
  kick();

  return {
    pause() { hostPaused = true; if (raf) cancelAnimationFrame(raf); raf = 0; lastTs = 0; },
    resume() { hostPaused = false; kick(); },
    destroy() { scenario++; this.pause(); resetBtn.removeEventListener('click', onReset); mountEl.replaceChildren(); },
  };
}
