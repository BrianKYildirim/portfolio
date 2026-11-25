// Key-value demo: the real key-value-storage server.py and observability.py, at the commit pinned in
// kv-py/kv.manifest.json, run in Pyodide in a module worker (kv-worker.js). This file only renders what Python returns:
// replies, Observer.state() and diagnostics() text, and the events, each as the engine wrote them (kv-events.js selects).
// Below the console, the recordings of real native runs are stepped through from their files (kv-timeline.js orders them).
import { MAX_COMMAND_BYTES, sri } from './kv-pyodide.js';
import { BROWSER_LABEL, RECORDED_LABEL, changedKeys, durationFields, eventSummary, fieldText, isLockEvent, keyMatch, parseEvents } from './kv-events.js';
import { buildTimeline, lockSpans, parseJsonl, recordingHeader } from './kv-timeline.js';

const MANIFEST_URL = new URL('./kv-py/kv.manifest.json', import.meta.url);
const SITE_ROOT = new URL('../../', import.meta.url); // the manifest's repo-relative paths resolve from here
const SKELETON = '<div class="pd-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
// Retry is bound by the demo's own data-retry: the case study's global retry class reloads the whole write-up.
const LOAD_ERROR = '<div class="pd-error"><p>Couldn’t load this demo.</p><div><button type="button" class="project-link" data-retry>Retry</button></div></div>';
const CHIPS = [['SET', 'SET key value'], ['GET', 'GET key'], ['REMOVE', 'REMOVE key'], ['PRINT', 'PRINT'], ['quit', 'quit']];
const FATAL_LINES = ['The Python runtime stopped working in this tab. Your next command starts it again.'];
const INPUT_LINES = ['That command was not sent: it must be 1 to 1024 bytes.']; // claim-waiver: states server.py's recv(1024) framing (design fact kv.design.recv_bytes)
const ENDED = 'Session ended: server.py stopped reading from this session (quit).';
// What each group of events is headed with. A restart or reset builds a new Observer, so seq starts again (RESEARCH Pitfall 11).
const HEADS = {
  boot: 'Server started',
  restart: 'Server restarted: new Observer, seq restarts',
  reset: 'Store reset: store.txt removed, new Observer',
  new_session: 'New session: a new Session on the same server',
};
const READ_HEAD = "From Observer.state() (this panel's read)";
const RESTART_NOTE = 'Server restarted: a new Observer and Server over the same store.txt, so load() ran again.';
const SCENARIO = ['SET user:42 Brian', 'GET user:42'];
const MAX_EVENT_ROWS = 300; // rows kept in the page; the engine's own ring buffer bounds its memory
// Only one thread runs in the browser, so a lock's contended is always false. waiting counts the thread itself: one when it
// starts waiting (lock.wait_start), none once it holds the lock (lock.acquired).
const LOCK_NOTE = 'Only one thread runs in your browser, so this lock is never contended here: contended is always false, and waiting only ever counts that one thread (one when it starts waiting, none once it holds the lock). The recordings below show real contention.';
const TIMER_NOTE = `Durations: ${BROWSER_LABEL}. Browsers coarsen timers, so short ones often read 0 or a round number; they say nothing about server.py's speed on a server.`;
// K1 (owner answer): the Observer is bound to a Server that is built with its defaults and never started.
const DIAG_NOTE = "Connections stay at zero, and so do the command, byte and handler-thread counts that come from connections, because no TCP connection exists in a browser: commands here go straight to Session.handle. process_total reads one because only the main thread runs. The server object was built with its defaults and start() never runs, so it reports running false and no bound port. The process id it shows is a constant of WebAssembly's C library, not a real process.";

// ---------- Recorded runs ----------
const REC_ORDER = ['contention', 'shutdown', 'framing', 'backlog'];
// Which recorded files each scenario plays. Every file must be listed in the manifest, which gives its sha256.
const REC_FILES = {
  contention: { trace: ['raw/trace.jsonl'] },
  shutdown: { trace: ['raw/trace-run-a.jsonl', 'raw/trace-run-b.jsonl'] },
  framing: { trace: ['raw/trace.jsonl'], clients: 'raw/clients.jsonl' },
  backlog: { trace: ['raw/trace.jsonl'], clients: 'raw/clients.jsonl' },
};
const PLAY_TICK_MS = 700; // one event per tick; a pace for watching, not a recorded time
const RESTART_DIVIDER = 'Server restarted: new process, new Observer, seq restarts';
const REC_ERROR_LINES = ['Couldn’t load this recording.'];

export class DemoError extends Error {
  constructor(lines) { super(lines.join(' ')); this.lines = lines; }
}
const enc = new TextEncoder();
const make = (tag, props) => Object.assign(document.createElement(tag), props);
// The full download a visitor's tab may fetch: the Pyodide files and the vendored engine sources.
const totalBytes = (m) => [m.pyodide.files, m.sources.files].reduce((n, files) => n + Object.values(files).reduce((s, e) => s + e.bytes, 0), 0);

// The server's reply as text exactly as Python returned it. Each newline and tab keeps its real character and gets a
// muted marker drawn by CSS (data-mark), so the text stays copyable as sent and the trailing newline of a SET reply
// stays visible against a bare GET value.
function replyNodes(text) {
  const nodes = [];
  for (const part of text.split(/(\n|\t)/)) {
    if (part === '\n' || part === '\t') {
      const mark = make('span', { className: 'demo-kv-mark' });
      mark.dataset.mark = part === '\n' ? '↵' : '⇥';
      mark.setAttribute('aria-hidden', 'true');
      nodes.push(mark, part);
    } else if (part) nodes.push(part);
  }
  return nodes;
}

// ---------- UI ----------
const TEMPLATE = `
<div class="demo-kv-layout">
<div class="demo-kv-console">
  <p class="demo-small">Each command goes to the key-value server's own session code, <code>Session.handle</code> in <code>server.py</code>, running in your browser (Pyodide). Commands stay in this tab; nothing is sent to a server.</p>
  <ol class="demo-kv-transcript" role="log" aria-label="Server replies" tabindex="0" data-transcript></ol>
  <div class="demo-load" data-load hidden>
    <p class="demo-small" data-load-size></p>
    <ol class="demo-stages" data-stages aria-label="Loading the Python runtime"></ol>
  </div>
  <div data-load-error hidden></div>
  <div class="demo-error" data-error role="alert" hidden></div>
  <div class="demo-kv-ended" data-ended hidden>
    <button type="button" class="project-link-accent" data-newsession>Start new session</button>
  </div>
  <form class="demo-kv-form" data-form>
    <input class="demo-input" type="text" placeholder="SET user:42 Brian" aria-label="Command" aria-describedby="demo-kv-hint" autocomplete="off" autocapitalize="off" spellcheck="false" data-input>
    <button type="submit" class="project-link-accent" data-send disabled>Send</button>
  </form>
  <p class="demo-small" id="demo-kv-hint" data-hint hidden></p>
  <div class="demo-chips" role="group" aria-label="Command templates">${CHIPS.map(([l, t]) => `<button type="button" class="demo-chip" data-tpl="${t}">${l}</button>`).join('')}<button type="button" class="demo-chip" data-scenario>Write, restart, read</button></div>
  <div class="demo-kv-controls">
    <button type="button" class="project-link" data-restart disabled>Restart server</button>
    <p class="demo-small">Builds a new Observer and Server over the same store.txt, so the real load() runs again.</p>
  </div>
</div>
<div class="demo-kv-inspect">
  <section class="demo-kv-panel" aria-labelledby="demo-kv-store-h">
    <h4 class="demo-kv-h" id="demo-kv-store-h">Storage</h4>
    <table class="demo-kv-table">
      <caption>Observer.state() · store</caption>
      <thead><tr><th scope="col">key</th><th scope="col">value</th></tr></thead>
      <tbody data-rows></tbody>
    </table>
    <p class="demo-small" data-empty></p>
    <dl class="demo-kv-facts" data-facts></dl>
    <h5 class="demo-kv-sub" id="demo-kv-file-h">store.txt</h5>
    <pre class="demo-kv-file" data-file role="region" aria-labelledby="demo-kv-file-h" tabindex="0"></pre>
  </section>
  <section class="demo-kv-panel" aria-labelledby="demo-kv-events-h">
    <h4 class="demo-kv-h" id="demo-kv-events-h">Events</h4>
    <div class="demo-chips" role="group" aria-label="Filter events">
      <button type="button" class="demo-chip" data-view="all" aria-pressed="true">All</button>
      <button type="button" class="demo-chip" data-view="store" aria-pressed="false">Store and commands</button>
      <button type="button" class="demo-chip" data-view="locks" aria-pressed="false">Locks</button>
    </div>
    <p class="demo-small" data-lock-note></p>
    <p class="demo-small" data-timer-note></p>
    <p class="demo-small" data-trimmed hidden></p>
    <div class="demo-kv-scroll" data-scroll data-view="all" role="region" aria-label="Events the engine emitted" tabindex="0">
      <ol class="demo-kv-events" data-events></ol>
    </div>
  </section>
  <details class="demo-kv-diag">
    <summary>Observer.diagnostics() · unfiltered</summary>
    <p class="demo-small" data-diag-note></p>
    <pre class="demo-kv-raw" data-diag tabindex="0"></pre>
  </details>
</div>
</div>
<section class="demo-kv-rec" aria-labelledby="demo-kv-rec-h" data-rec>
  <h4 class="demo-kv-h" id="demo-kv-rec-h">Recordings of real native runs <span class="demo-kv-badge">Recording, not live</span></h4>
  <p class="demo-small">A browser cannot run threads, sockets or a server that stops with connections open, so these runs of the real <code>server.py</code> were captured once on Linux. You step through what was written down, in the order it was recorded. Nothing here is running: every event, thread and duration comes from the recorded files, and the files are checked against the pinned manifest before they are shown.</p>
  <div class="demo-chips" role="group" aria-label="Recordings" data-rec-chips></div>
  <p class="demo-small" data-rec-head>Choose a recording to step through it.</p>
  <ul class="demo-kv-notes demo-small" data-rec-notes hidden></ul>
  <div data-rec-error hidden></div>
  <p class="demo-small" data-rec-empty hidden>This recording has no events</p>
  <div class="demo-kv-recview" data-rec-view hidden>
    <div class="demo-kv-recbar">
      <button type="button" class="project-link" data-rec-step="first">First</button>
      <button type="button" class="project-link" data-rec-step="back">Back</button>
      <button type="button" class="project-link" data-rec-step="next">Next</button>
      <button type="button" class="project-link" data-rec-step="last">Last</button>
      <span class="demo-kv-pos" data-rec-pos></span>
      <span class="demo-kv-playwrap" data-rec-playwrap>
        <button type="button" class="project-link-accent" data-rec-play>Play</button>
        <span class="demo-small">Playback speed, not recorded time</span>
      </span>
    </div>
    <p class="demo-small">With focus on a control here, the left and right arrow keys step back and forward. Each lane is one thread; the marks are events in recorded order, evenly spaced, not spaced by time.</p>
    <div class="demo-kv-lanes" data-rec-scroll role="region" aria-label="Timeline of the recorded events, one lane per thread" tabindex="0">
      <div class="demo-kv-lanes-inner" data-rec-lanes></div>
    </div>
    <div class="demo-kv-recdetail">
      <p class="demo-kv-divider-note" data-rec-divider hidden></p>
      <p class="demo-kv-recsum" data-rec-summary></p>
      <p class="demo-small" data-rec-where></p>
      <ul class="demo-kv-durs" data-rec-durs></ul>
      <ul class="demo-kv-durs" data-rec-spans aria-label="Lock spans on this thread around this event"></ul>
      <pre class="demo-kv-raw" data-rec-raw tabindex="0" aria-label="The recorded line"></pre>
    </div>
    <div class="demo-kv-client" data-rec-clients hidden>
      <h5 class="demo-kv-sub">Client side · the capture script's own log and clock</h5>
      <p class="demo-small" data-rec-clientnote></p>
      <ol class="demo-kv-clientlog" data-rec-clientlog role="region" aria-label="The capture script's own log of what its clients did" tabindex="0"></ol>
    </div>
  </div>
</section>`;

// mount() stays synchronous (the host expects { pause, resume, destroy } at once). Scrolling to the demo fetches only
// the manifest; the Python runtime loads on the first command. There is no JavaScript engine to fall back to.
export function mount(root, { status }) {
  const mountEl = root.querySelector('.demo-mount');
  let alive = true, manifest = null, el = null, manifestGen = 0;
  // gen: a send or a control supersedes older ones. pending: one command (or control) is in flight at a time.
  let gen = 0, pending = false, ended = false;
  // One worker per runtime load. destroy(), Retry and a fatal failure start the next one from scratch.
  let worker = null, booted = false, runtime = null, snapshot = null, loadGen = 0, seq = 0, readyTimer = 0;
  const jobs = new Map();

  // ---------- Worker ----------
  function startWorker() {
    const wk = new Worker(new URL('./kv-worker.js', import.meta.url), { type: 'module' });
    worker = wk; booted = false;
    // Not every engine fires `error` for a module worker that fails to load, so it must say it's ready.
    readyTimer = setTimeout(() => { if (worker === wk) stopWorker('load'); }, 4000);
    wk.onmessage = ({ data }) => {
      if (worker !== wk) return;
      if (data.ready) clearTimeout(readyTimer); else jobs.get(data.id)?.(data);
    };
    wk.onerror = (e) => { e.preventDefault(); if (worker === wk) stopWorker(booted ? 'fatal' : 'load'); };
  }
  // Terminating releases the wasm heap, which never shrinks. Pending callers get `fail`. The next session starts empty.
  function stopWorker(fail = 'stopped') {
    clearTimeout(readyTimer);
    worker?.terminate();
    worker = null; booted = false; runtime = null; snapshot = null;
    const waiting = [...jobs.values()];
    jobs.clear();
    for (const cb of waiting) cb({ fail });
    if (el) { setEnded(false); clearInspect(); } // a new runtime starts at epoch one again, so old rows must not stay
  }
  function call(msg, transfer = [], onProgress = () => {}) {
    if (!worker) return Promise.resolve({ fail: 'fatal' });
    const id = ++seq;
    return new Promise((resolve) => {
      jobs.set(id, (m) => { if (m.progress) return onProgress(m.progress); jobs.delete(id); resolve(m); });
      worker.postMessage({ id, ...msg }, transfer);
    });
  }

  // Resolves to the boot snapshot Python returned. A failed load (CDN error, integrity mismatch, ready timeout) stops
  // the worker and forgets it, so the next call, Retry included, starts a fresh one. Nothing here answers for Python.
  function ensureRuntime() {
    if (runtime) return runtime;
    const g = ++loadGen;
    showLoad();
    status('Loading the Python runtime and server.py…');
    runtime = (async () => {
      startWorker();
      const m = await call({ op: 'load', manifest, manifestUrl: MANIFEST_URL.href }, [], (p) => { if (g === loadGen) stageProgress(p); });
      if (!m.done) throw new Error(`the Python runtime did not load (${m.fail})`);
      if (g === loadGen) { booted = true; snapshot = m; stageProgress({ stage: 'ready', done: true }); renderSnapshot(m, HEADS.boot); sync(); }
      return m;
    })().catch((err) => {
      if (alive && g === loadGen) { console.error('[kv]', err); stopWorker(); }
      throw Object.assign(new Error('runtime load failed', { cause: err }), { runtimeLoad: true });
    });
    return runtime;
  }

  // ---------- Output regions ----------
  function showLoad() {
    const mb = Math.ceil(totalBytes(manifest) / 1e6);
    el.loadSize.textContent = `Starts the Python runtime and server.py on your first command (about ${mb} MB the first time; your browser may already have the runtime from the Image Quality Gate demo).`;
    const labels = [['runtime', 'Python runtime'], ['sources', 'server.py and observability.py'], ['ready', 'Ready']];
    el.stages.replaceChildren(...labels.map(([stage, label]) => {
      const li = make('li');
      li.dataset.stage = stage;
      li.append(make('span', { textContent: label }), make('span', { textContent: 'waiting' }));
      return li;
    }));
    el.loadError.hidden = true; el.loadError.replaceChildren();
    el.load.hidden = false;
  }
  function stageProgress({ stage, done }) {
    const li = el.stages.querySelector(`[data-stage="${stage}"]`);
    if (!li) return;
    li.classList.toggle('is-active', !done);
    li.classList.toggle('is-done', !!done);
    li.lastChild.textContent = done ? 'done' : 'loading…';
  }
  function showLoadError() {
    el.load.hidden = true; hideError();
    el.loadError.innerHTML = LOAD_ERROR;
    el.loadError.hidden = false;
    status('Couldn’t load this demo. Press Retry to load it again.');
  }
  const showError = (lines) => {
    el.error.replaceChildren(...lines.map((t) => make('p', { textContent: t })));
    el.error.hidden = false;
    status(lines.join(' '));
  };
  const hideError = () => { el.error.hidden = true; el.error.replaceChildren(); };
  function setEnded(on) {
    ended = on;
    el.ended.hidden = !on;
    el.input.disabled = on;
    sync();
  }

  // ---------- Inspection ----------
  // Everything below shows Python's own output: Observer.state() text, the event texts, diagnostics(). Selection and
  // lookup come from kv-events.js; nothing is diffed or computed here, and engine strings are set with textContent.
  let lastFile = null, removedRows = 0, flashing = 0;
  const show = (v) => String(v);

  function clearInspect() {
    lastFile = null; removedRows = 0;
    el.rows.replaceChildren();
    el.empty.textContent = 'Appears after the first command, once the Python runtime has loaded.';
    el.empty.hidden = false;
    el.facts.replaceChildren();
    el.file.textContent = '';
    el.events.replaceChildren();
    el.trimmed.hidden = true;
    el.diag.textContent = 'Not read yet.';
  }

  // The new snapshot, in the protocol's order. Returns the keys this command changed, from its own store.mutation events.
  function renderSnapshot(m, head) {
    const parsed = parseEvents(m.events), changed = changedKeys(parsed);
    renderState(m, changed);
    addEventGroup(m, head, parsed);
    el.diag.textContent = m.diagnostics;
    return changed;
  }

  function renderState(m, changed) {
    const { store, file, redaction, derived } = JSON.parse(m.state); // structure only; no value from it is recomputed
    el.rows.replaceChildren(...store.entries.map(({ key, value }) => {
      const tr = make('tr'), kc = make('td', { textContent: fieldText(key) });
      const hits = changed.map((c) => keyMatch(key, c.key));
      const hit = hits.includes('exact') ? 'exact' : hits.includes('prefix') ? 'prefix' : null;
      if (hit) {
        tr.className = 'is-changed';
        kc.append(make('span', { className: 'demo-kv-tag', textContent: hit === 'prefix' ? `changed · matched by the first ${redaction.max_chars} characters` : 'changed' }));
      }
      tr.append(kc, make('td', { textContent: fieldText(value) }));
      return tr;
    }));
    el.empty.hidden = store.entries.length > 0;
    el.empty.textContent = `Observer.state() returned no entries (keys: ${store.keys}).`;
    const sized = (f) => `${f.value} ${f.unit} (${f.kind}: ${f.method})`;
    const facts = [
      ['keys', store.keys], ['generation', store.generation],
      ['payload_bytes', sized(store.payload_bytes)], ['memory_bytes', sized(store.memory_bytes)],
      ['file.exists', file.exists], ['file.size_bytes', file.size_bytes], ['file.synced_generation', file.synced_generation],
      ['file_reflects_latest_change', derived.file_reflects_latest_change.value],
    ];
    if (store.entries_truncated) facts.push(['entries shown', `${store.entries_returned} of ${store.keys}`]);
    el.facts.replaceChildren(...facts.flatMap(([k, v]) => [make('dt', { textContent: k }), make('dd', { textContent: show(v) })]));
    renderFile(m.store_txt);
  }

  // store.txt from the real file bytes: tabs and newlines are marked, and a file that does not exist says so.
  function renderFile(text) {
    if (text === null) el.file.textContent = '(no store.txt yet)';
    else if (text === '') el.file.textContent = '(empty file)';
    else el.file.replaceChildren(...replyNodes(text));
    if (lastFile !== null && lastFile !== text) { // a brief background flash where the file changed (reduced motion: none)
      const n = ++flashing;
      el.file.classList.add('is-flash');
      setTimeout(() => { if (n === flashing && alive) el.file.classList.remove('is-flash'); }, 80); // the CSS transition fades it out
    }
    lastFile = text;
  }

  function eventRow(epoch, item, i) {
    const { text, event } = item, li = make('li', { className: 'demo-kv-event' }), det = make('details'), sum = make('summary');
    li.dataset.key = `${epoch}:${event?.seq ?? `?${i}`}`; // seq restarts with a new Observer, so the epoch is part of the key
    li.dataset.type = event?.type ?? 'unparsed';
    if (isLockEvent(event?.type)) li.dataset.lock = '';
    sum.append(make('span', { className: 'demo-kv-seq', textContent: event ? `#${event.seq}` : '#?' }), ' ',
      make('span', { className: 'demo-kv-type', textContent: event?.type ?? 'unparsed event' }), ' ',
      make('span', { textContent: eventSummary(event) }));
    for (const [name, raw] of durationFields(item)) {
      sum.append(make('span', { className: 'demo-kv-dur', textContent: `${name} ${raw} ns, ${BROWSER_LABEL}` }));
    }
    det.append(sum, make('pre', { className: 'demo-kv-raw', textContent: text, tabIndex: 0 }));
    li.append(det);
    return li;
  }

  function addEventGroup(m, head, parsed) {
    const group = make('li', { className: 'demo-kv-group' }), reads = parseEvents(m.inspect_events);
    if (m.op === 'restart' || m.op === 'reset') group.classList.add('is-divider');
    group.append(make('h5', { className: 'demo-kv-sub', textContent: head }));
    if (parsed.length) {
      const list = make('ol', { className: 'demo-kv-rows' });
      parsed.forEach((item, i) => list.append(eventRow(m.epoch, item, i)));
      group.append(list);
    } else group.append(make('p', { className: 'demo-small', textContent: 'The engine emitted no events here.' }));
    if (m.stdout.length) {
      group.append(make('p', { className: 'demo-small', textContent: 'Server output (Python stdout and stderr):' }), make('pre', { className: 'demo-kv-raw', textContent: m.stdout.join('\n'), tabIndex: 0 }));
    }
    if (reads.length) {
      const sub = make('div', { className: 'demo-kv-readgroup' }), list = make('ol', { className: 'demo-kv-rows' });
      reads.forEach((item, i) => list.append(eventRow(m.epoch, item, parsed.length + i)));
      sub.append(make('p', { className: 'demo-kv-sub', textContent: READ_HEAD }), list);
      group.append(sub);
    }
    if (parsed.length || reads.length) group.dataset.rows = '';
    el.events.append(group);
    trimRows();
    el.scroll.scrollTop = el.scroll.scrollHeight;
  }

  // Only the newest rows stay in the page; the engine's ring buffer already bounds its own memory.
  function trimRows() {
    const rows = el.events.querySelectorAll('.demo-kv-event'), extra = rows.length - MAX_EVENT_ROWS;
    if (extra <= 0) return;
    for (let i = 0; i < extra; i++) rows[i].remove();
    removedRows += extra;
    for (const sub of el.events.querySelectorAll('.demo-kv-readgroup')) if (!sub.querySelector('.demo-kv-event')) sub.remove();
    for (const g of el.events.querySelectorAll('.demo-kv-group')) if (g.dataset.rows !== undefined && !g.querySelector('.demo-kv-event')) g.remove();
    el.trimmed.textContent = `${removedRows} older event rows are no longer shown here; the newest ${MAX_EVENT_ROWS} are kept.`;
    el.trimmed.hidden = false;
  }

  // ---------- Transcript ----------
  function addEntry(command, replies, changed) {
    const li = make('li', { className: 'demo-kv-entry' }), pre = make('pre', { className: 'demo-kv-reply' });
    const cmd = make('p', { className: 'demo-kv-cmd' });
    cmd.append(make('span', { className: 'vh', textContent: 'Command: ' }), make('code', { textContent: command }));
    const text = replies.join('');
    if (replies.length) pre.append(...replyNodes(text));
    li.append(cmd, make('p', { className: 'vh', textContent: 'Server reply:' }));
    if (replies.length) li.append(pre);
    else li.append(make('p', { className: 'demo-small', textContent: 'The server sent no reply.' }));
    // The keys this command changed are the keys of its own store.mutation events, in seq order.
    if (changed.length) {
      const ul = make('ul', { className: 'demo-kv-changed' });
      ul.setAttribute('aria-label', 'Keys this command changed');
      ul.append(...changed.map((c) => make('li', { textContent: `Changed: ${fieldText(c.key)} (${c.op}, existed ${c.existed}, generation ${c.generation})` })));
      li.append(ul);
    } else li.append(make('p', { className: 'demo-small demo-kv-changed', textContent: 'No key changed' }));
    addItem(li);
    return text;
  }
  function addNote(text) { addItem(make('li', { className: 'demo-kv-note', textContent: text })); }
  function addItem(li) {
    el.transcript.append(li);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  // ---------- Input ----------
  // Send needs 1 to MAX_COMMAND_BYTES bytes of UTF-8, one command at a time, and a session that has not quit.
  function sync() {
    if (!el) return;
    const len = enc.encode(el.input.value).length, over = len > MAX_COMMAND_BYTES;
    el.send.disabled = !len || over || pending || ended;
    el.send.textContent = pending ? 'Working…' : 'Send';
    el.hint.hidden = !over;
    el.restart.disabled = !booted || !worker || pending;
    if (over) el.hint.textContent = `${len} bytes: server.py reads at most 1024 per recv(), so a longer send would be split across reads (the framing recording below shows this). Send 1024 bytes or fewer.`; // claim-waiver: states server.py's recv(1024) framing (design fact kv.design.recv_bytes)
  }
  // A reply that did not come back ok. The runtime is still sound only after a refused input.
  function failure(m) {
    if (m.fail === 'input') return new DemoError(INPUT_LINES);
    stopWorker();
    return new DemoError(FATAL_LINES);
  }

  // One unit of work with the one-in-flight rule: errors become the same messages for a command, a restart or a scenario.
  async function run(work) {
    if (!alive || !el || pending) return;
    const g = ++gen;
    pending = true; hideError(); sync();
    try {
      await work(g);
    } catch (err) {
      if (g !== gen || !alive) return;
      if (err.runtimeLoad) return showLoadError();
      if (!err.lines) console.error('[kv]', err);
      showError(err.lines || FATAL_LINES);
    } finally {
      if (g === gen && alive) {
        pending = false; sync();
        if (ended) el.newSession.focus({ preventScroll: true });
        else if (document.activeElement === document.body) el.input.focus({ preventScroll: true });
      }
    }
  }

  // One command through the runtime and the worker, then its transcript entry and the panels. False when superseded.
  async function sendCommand(text, g, fromField) {
    const bytes = enc.encode(text);
    await ensureRuntime();
    if (g !== gen || !alive) return false;
    const buf = bytes.slice().buffer;
    if (fromField && el.input.value === text) { el.input.value = ''; sync(); }
    const m = await call({ op: 'send', bytes: buf }, [buf]);
    if (g !== gen || !alive) return false; // superseded: an older command finishes in the worker but never renders
    if (!m.done) throw failure(m);
    snapshot = m;
    el.load.hidden = true;
    const shown = addEntry(text, m.replies, renderSnapshot(m, `Command: ${text}`));
    if (!m.keep) { addNote(ENDED); setEnded(true); status(ENDED); } // the engine decides what counts as quit
    else status(shown ? `Server replied: ${shown.trim().slice(0, 120)}` : 'The server sent no reply.');
    return true;
  }

  // A real reload: a new Observer and Server over the same store.txt, so load() runs again and store.load says exists true.
  async function restartCore(g) {
    const m = await call({ op: 'restart' });
    if (g !== gen || !alive) return false;
    if (!m.done) throw failure(m);
    snapshot = m;
    setEnded(false);
    renderSnapshot(m, HEADS.restart);
    addNote(RESTART_NOTE);
    status(RESTART_NOTE);
    return true;
  }

  function submit() {
    if (!alive || !el || pending || ended) return;
    const text = el.input.value, len = enc.encode(text).length;
    if (!len || len > MAX_COMMAND_BYTES) return;
    return run((g) => sendCommand(text, g, true));
  }
  const restartServer = () => { if (booted && worker) run(restartCore); };
  // Three real operations through the same path: SET, a restart that reloads store.txt, GET.
  const writeRestartRead = () => { if (!ended) run(async (g) => { if (await sendCommand(SCENARIO[0], g, false) && await restartCore(g)) await sendCommand(SCENARIO[1], g, false); }); };

  // A new Session on the same server: the store and its file are unchanged.
  async function newSession() {
    if (!alive || !el || pending || !ended || !worker) return;
    const g = ++gen;
    pending = true; sync();
    try {
      const m = await call({ op: 'new_session' });
      if (g !== gen || !alive) return;
      if (!m.done) throw failure(m);
      snapshot = m;
      setEnded(false);
      renderSnapshot(m, HEADS.new_session);
      addNote('New session: a new Session on the same server, with the same store.');
      status('New session started.');
    } catch (err) {
      if (g !== gen || !alive) return;
      if (!err.lines) console.error('[kv]', err);
      showError(err.lines || FATAL_LINES);
    } finally {
      if (g === gen && alive) { pending = false; sync(); if (!ended) el.input.focus({ preventScroll: true }); }
    }
  }

  function retry() {
    if (!manifest) return loadManifest();
    const g = ++gen;
    pending = false; hideError(); sync();
    const len = enc.encode(el.input.value).length;
    if (len && len <= MAX_COMMAND_BYTES) return submit(); // the command that was waiting for the runtime
    ensureRuntime().then(() => { if (g === gen && alive) status('Ready. Send a command.'); })
      .catch(() => { if (g === gen && alive) showLoadError(); });
  }

  // Clears the transcript; once the runtime is running, the in-browser server restarts with an empty store.
  async function reset() {
    const g = ++gen;
    el.transcript.replaceChildren(); clearInspect(); hideError();
    pending = false; setEnded(false);
    if (!booted || !worker) return status('Reset.');
    pending = true; sync();
    const m = await call({ op: 'reset' });
    if (g !== gen || !alive) return;
    pending = false;
    if (m.done) { snapshot = m; renderSnapshot(m, HEADS.reset); status('Reset: transcript cleared and the in-browser server restarted with an empty store.'); }
    else showError(failure(m).lines);
    sync();
  }

  // ---------- Recordings ----------
  // Stepping through files. Each recording is fetched with the manifest's sha256 as its integrity value, so a changed file
  // fails to load. Order, lanes and spans come from kv-timeline.js; every string shown is a recorded string, set with textContent.
  let rec = null, recName = null, recGen = 0, recIdx = 0, playing = false, playTimer = 0, rc = null, recTicks = [], recRows = [], recSeen = null;
  const recCache = new Map();
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const recorded = (name, raw) => `${name} ${raw} ns, ${RECORDED_LABEL} (${rec.meta.environment_id})`;

  async function fetchRecording(name) {
    const entry = manifest.recordings?.scenarios?.[name], spec = REC_FILES[name];
    if (!entry || !spec) throw new Error(`the manifest has no recording named ${name}`);
    const get = async (rel) => {
      const file = entry.files[rel];
      if (!file) throw new Error(`the manifest lists no ${rel} for ${name}`);
      const r = await fetch(new URL(`${manifest.recordings.dir}/${name}/${rel}`, SITE_ROOT), { integrity: sri(file.sha256) });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${rel}`);
      return r.text();
    };
    const [metaText, ...texts] = await Promise.all([get('meta.json'), ...spec.trace.map(get), ...(spec.clients ? [get(spec.clients)] : [])]);
    const meta = JSON.parse(metaText);
    if (meta.schema !== 'kv-recording/1' || meta.scenario !== name || meta.source?.sha !== entry.source_sha) throw new Error(`${name}: the recording metadata does not match the manifest`);
    const header = recordingHeader(meta), tl = buildTimeline(spec.trace.map((rel, i) => ({ name: rel, text: texts[i] })));
    const clients = spec.clients ? parseJsonl(texts[spec.trace.length], spec.clients).map((l) => l.event) : null;
    return { name, meta, header, tl, spans: lockSpans(tl.steps), clients };
  }

  // A newer chip click supersedes an older fetch. A failure shows in this section only; the console keeps working.
  async function loadRecording(name) {
    const g = ++recGen, refocus = rc.section.contains(document.activeElement);
    stopPlay(); recName = name; rec = null;
    for (const b of rc.chips.children) b.setAttribute('aria-pressed', String(b.dataset.recScenario === name));
    rc.error.hidden = true; rc.view.hidden = true; rc.empty.hidden = true; rc.notes.hidden = true;
    rc.head.textContent = 'Loading the recording…';
    status('Loading the recording…');
    try {
      let r = recCache.get(name);
      if (!r) {
        try { r = await fetchRecording(name); } catch (err) { console.error('[kv]', err); throw new DemoError(REC_ERROR_LINES); }
      }
      if (g !== recGen || !alive) return;
      recCache.set(name, r);
      renderRecording(r);
    } catch (err) {
      if (g !== recGen || !alive) return;
      rc.head.textContent = '';
      const retryBtn = make('button', { type: 'button', className: 'project-link', textContent: 'Retry' });
      retryBtn.dataset.recRetry = '';
      rc.error.replaceChildren(make('p', { textContent: err.lines ? err.lines.join(' ') : REC_ERROR_LINES[0] }), make('div'));
      rc.error.lastChild.append(retryBtn);
      rc.error.className = 'pd-error'; rc.error.hidden = false;
      status(REC_ERROR_LINES[0]);
      if (refocus) retryBtn.focus({ preventScroll: true });
    }
  }

  function renderRecording(r) {
    rec = r; recIdx = 0;
    rc.head.textContent = r.header;
    rc.notes.replaceChildren(...(r.meta.notes ?? []).map((t) => make('li', { textContent: t })));
    rc.notes.hidden = !rc.notes.children.length;
    rc.playwrap.hidden = reducedMotion();
    renderClients(r);
    if (!r.tl.steps.length) { rc.empty.hidden = false; rc.view.hidden = rc.clients.hidden = true; status('This recording has no events'); return; }
    rc.view.hidden = false;
    buildLanes();
    syncPlay();
    showStep(0);
    status(r.header);
  }

  // The capture script's own log of what its clients did: shown as the client's view, on the client's clock, which this
  // list does not print. Order is the log's own.
  function renderClients(r) {
    rc.clients.hidden = !r.clients;
    if (!r.clients) return;
    rc.clientNote.textContent = r.meta.client_side ?? '';
    rc.clientLog.replaceChildren(...r.clients.map((c) => {
      const li = make('li', { className: 'demo-kv-clientrow' }), head = [c.client, c.op];
      if (c.bytes !== null && c.bytes !== undefined) head.push(`${c.bytes} bytes`);
      if (c.timed_out === true) head.push('timed out, nothing received');
      li.append(make('span', { className: 'demo-kv-type', textContent: head.join(' · ') }));
      if (c.text) li.append(' ', make('code', { className: 'demo-kv-clienttext' }));
      if (c.text) li.lastChild.append(...replyNodes(c.text));
      return li;
    }));
  }

  // One lane per recorded thread; one mark per event at its index (evenly spaced, not by time); spans between step indexes.
  function buildLanes() {
    const { tl, spans } = rec, n = tl.steps.length;
    rc.lanes.style.setProperty('--n', n);
    rc.lanes.scrollLeft = 0;
    recRows = tl.lanes.map((name) => {
      const row = make('div', { className: 'demo-kv-lane' }), track = make('div', { className: 'demo-kv-track' });
      row.append(make('span', { className: 'demo-kv-lane-name', textContent: name }), track);
      return { row, track };
    });
    const at = (el, i, len) => { el.style.setProperty('--i', i); if (len) el.style.setProperty('--len', len); el.dataset.recI = i; return el; };
    for (const sp of spans) {
      const text = spanText(sp), cls = (kind) => `demo-kv-span is-${kind}${sp.contended ? ' is-contended' : ''}${sp.released === null ? ' is-open' : ''}`;
      const waitEnd = sp.acquired !== null ? sp.acquired - 1 : sp.failed ?? sp.waitStart;
      if (sp.waitStart !== null && waitEnd >= sp.waitStart) recRows[sp.lane].track.append(at(make('span', { className: cls('wait'), title: text }), sp.waitStart, waitEnd - sp.waitStart + 1));
      if (sp.acquired !== null) recRows[sp.lane].track.append(at(make('span', { className: cls('hold'), title: text }), sp.acquired, (sp.released ?? sp.acquired) - sp.acquired + 1));
    }
    recTicks = tl.steps.map((s) => {
      const tick = at(make('span', { className: `demo-kv-tick${isLockEvent(s.type) ? ' is-lock' : ''}` }), s.index);
      recRows[s.lane].track.append(tick);
      return tick;
    });
    const ruler = make('div', { className: 'demo-kv-ruler' });
    for (const d of tl.dividers) ruler.append(at(make('span', { className: 'demo-kv-ruler-mark', textContent: RESTART_DIVIDER }), d));
    rc.cursor = at(make('div', { className: 'demo-kv-cursor' }), 0);
    rc.lanes.replaceChildren(ruler, ...recRows.map((r) => r.row), rc.cursor, ...tl.dividers.map((d) => at(make('div', { className: 'demo-kv-divider' }), d)));
    recSeen = null;
  }

  // One span as text: what was recorded for it, and nothing else.
  function spanText(sp) {
    const parts = [`Lock ${sp.lock} on ${sp.thread}`, `contended ${sp.contended}`];
    if (sp.wait_ns !== null) parts.push(recorded('wait_ns', sp.wait_ns));
    if (sp.hold_ns !== null) parts.push(recorded('hold_ns', sp.hold_ns));
    if (sp.released === null) parts.push('no release recorded');
    return parts.join('; ');
  }

  function showStep(i, manual = false) {
    const { steps, dividers } = rec.tl, last = steps.length - 1;
    recIdx = Math.max(0, Math.min(last, i));
    const s = steps[recIdx];
    recSeen?.tick.classList.remove('is-current'); recSeen?.row.classList.remove('is-current');
    recTicks[recIdx].classList.add('is-current'); recRows[s.lane].row.classList.add('is-current');
    recSeen = { tick: recTicks[recIdx], row: recRows[s.lane].row };
    rc.cursor.style.setProperty('--i', recIdx);
    rc.pos.textContent = `Event ${recIdx + 1} of ${steps.length}`;
    for (const b of rc.steps) b.disabled = (b.dataset.recStep === 'first' || b.dataset.recStep === 'back') ? recIdx === 0 : recIdx === last;
    rc.divider.hidden = !dividers.includes(recIdx);
    rc.divider.textContent = rc.divider.hidden ? '' : RESTART_DIVIDER;
    const what = eventSummary(s.event);
    rc.summary.textContent = `#${s.seq ?? '?'} ${s.type ?? 'unknown type'} · ${s.thread}${what ? ` · ${what}` : ''}`;
    rc.where.textContent = `${s.file}, line ${s.line}`;
    rc.durs.replaceChildren(...durationFields({ text: s.text, event: s.event }).map(([name, raw]) => make('li', { className: 'demo-kv-dur', textContent: recorded(name, raw) })));
    rc.spanList.replaceChildren(...rec.spans.filter((sp) => sp.file === s.file && sp.thread === s.thread && sp.from <= recIdx && recIdx <= sp.to).map((sp) => make('li', { className: 'demo-kv-dur', textContent: spanText(sp) })));
    rc.raw.textContent = s.text;
    keepVisible();
    if (manual) status(`Event ${recIdx + 1} of ${steps.length}: ${s.type}, ${s.thread}`);
  }

  // Scroll the timeline sideways so the current event stays in view (reads first, then one write).
  function keepVisible() {
    const c = rc.cursor.getBoundingClientRect(), b = rc.scroll.getBoundingClientRect(), edge = b.left + (rc.lanes.querySelector('.demo-kv-lane-name')?.offsetWidth ?? 0);
    if (c.left < edge) rc.scroll.scrollLeft -= edge - c.left + 24;
    else if (c.right > b.right) rc.scroll.scrollLeft += c.right - b.right + 24;
  }

  const step = (to) => { if (rec && rec.tl.steps.length) { stopPlay(); showStep(to(recIdx), true); } };
  const STEPS = { first: () => 0, back: (i) => i - 1, next: (i) => i + 1, last: () => Infinity };

  // Play: one event per fixed tick, a chained timeout. It stops at the last event and when reduced motion is on.
  function syncPlay() { if (rc) rc.play.textContent = playing ? 'Pause' : 'Play'; }
  function startPlay() {
    if (!rec || playing || !rec.tl.steps.length || reducedMotion()) return;
    if (recIdx >= rec.tl.steps.length - 1) showStep(0);
    playing = true; syncPlay(); schedule();
  }
  function stopPlay() { playing = false; clearTimeout(playTimer); playTimer = 0; syncPlay(); }
  const schedule = () => { playTimer = setTimeout(playTick, PLAY_TICK_MS); };
  function playTick() {
    playTimer = 0;
    if (!alive || !playing || !rec) return;
    if (reducedMotion()) return stopPlay();
    showStep(recIdx + 1);
    if (recIdx >= rec.tl.steps.length - 1) stopPlay(); else schedule();
  }

  const onRecKey = (e) => {
    if (!alive || !rec || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    if (!e.target.closest('[data-rec]') || e.target.closest('pre, [data-rec-scroll]')) return; // those scroll sideways themselves
    e.preventDefault();
    step(e.key === 'ArrowLeft' ? STEPS.back : STEPS.next);
  };
  const onRecMark = (e) => { // a click on a mark or span jumps to that event
    const m = e.target.closest('[data-rec-i]');
    if (m && rec && alive) step(() => Number(m.dataset.recI));
  };

  // ---------- Build ----------
  const q = (s) => mountEl.querySelector(s);
  function build() {
    stopPlay(); recGen++; rec = null; recName = null; recCache.clear(); // a rebuilt page starts with nothing selected
    mountEl.innerHTML = TEMPLATE;
    el = {
      transcript: q('[data-transcript]'), load: q('[data-load]'), loadSize: q('[data-load-size]'), stages: q('[data-stages]'),
      loadError: q('[data-load-error]'), error: q('[data-error]'), ended: q('[data-ended]'), newSession: q('[data-newsession]'),
      input: q('[data-input]'), send: q('[data-send]'), hint: q('[data-hint]'), restart: q('[data-restart]'),
      rows: q('[data-rows]'), empty: q('[data-empty]'), facts: q('[data-facts]'), file: q('[data-file]'),
      events: q('[data-events]'), scroll: q('[data-scroll]'), trimmed: q('[data-trimmed]'), diag: q('[data-diag]'),
    };
    rc = {
      section: q('[data-rec]'), chips: q('[data-rec-chips]'), head: q('[data-rec-head]'), notes: q('[data-rec-notes]'), error: q('[data-rec-error]'),
      empty: q('[data-rec-empty]'), view: q('[data-rec-view]'), steps: [...mountEl.querySelectorAll('[data-rec-step]')], pos: q('[data-rec-pos]'),
      playwrap: q('[data-rec-playwrap]'), play: q('[data-rec-play]'), scroll: q('[data-rec-scroll]'), lanes: q('[data-rec-lanes]'), cursor: null,
      divider: q('[data-rec-divider]'), summary: q('[data-rec-summary]'), where: q('[data-rec-where]'), durs: q('[data-rec-durs]'),
      spanList: q('[data-rec-spans]'), raw: q('[data-rec-raw]'), clients: q('[data-rec-clients]'), clientNote: q('[data-rec-clientnote]'), clientLog: q('[data-rec-clientlog]'),
    };
    rc.chips.replaceChildren(...REC_ORDER.filter((n) => manifest.recordings?.scenarios?.[n]).map((n) => {
      const b = make('button', { type: 'button', className: 'demo-chip', textContent: manifest.recordings.scenarios[n].label });
      b.dataset.recScenario = n; b.setAttribute('aria-pressed', 'false');
      return b;
    }));
    q('[data-lock-note]').textContent = LOCK_NOTE;
    q('[data-timer-note]').textContent = TIMER_NOTE;
    q('[data-diag-note]').textContent = DIAG_NOTE;
    clearInspect();
    status('Type a command, or pick a template.');
  }

  async function loadManifest() {
    const g = ++manifestGen, refocus = mountEl.contains(document.activeElement);
    mountEl.innerHTML = SKELETON;
    status('Loading the demo…');
    try {
      const r = await fetch(MANIFEST_URL);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const m = await r.json();
      if (!alive || g !== manifestGen) return;
      manifest = m;
      build();
      if (refocus) el.input.focus({ preventScroll: true });
    } catch (err) {
      if (!alive || g !== manifestGen) return;
      console.error('[kv]', err);
      mountEl.innerHTML = LOAD_ERROR;
      status('Couldn’t load this demo. Press Retry to load it again.');
      if (refocus) q('[data-retry]').focus();
    }
  }

  // ---------- Listeners ----------
  const onClick = (e) => {
    const t = e.target.closest('button');
    if (!t || !alive) return;
    if (t.matches('[data-retry]')) retry();
    else if (!el) return;
    else if (t.matches('[data-newsession]')) newSession();
    else if (t.matches('[data-restart]')) restartServer();
    else if (t.matches('[data-scenario]')) writeRestartRead();
    else if (t.dataset.recScenario) loadRecording(t.dataset.recScenario);
    else if (t.matches('[data-rec-retry]')) loadRecording(recName);
    else if (t.dataset.recStep) step(STEPS[t.dataset.recStep]);
    else if (t.matches('[data-rec-play]')) { if (playing) stopPlay(); else startPlay(); }
    else if (t.dataset.view) { // the filter only hides rows (CSS reads data-view); it never removes or reorders them
      el.scroll.dataset.view = t.dataset.view;
      for (const b of mountEl.querySelectorAll('[data-view]')) if (b.matches('button')) b.setAttribute('aria-pressed', String(b === t));
    } else if (t.dataset.tpl && !ended) {
      el.input.value = t.dataset.tpl; el.input.focus(); sync();
      const sp = t.dataset.tpl.indexOf(' ');
      if (sp > 0) el.input.setSelectionRange(sp + 1, t.dataset.tpl.length);
    }
  };
  const onSubmit = (e) => { e.preventDefault(); submit(); };
  const onInput = (e) => { if (alive && el && e.target.matches('[data-input]')) sync(); };
  const resetBtn = root.querySelector('.demo-status .btn-ghost'), onReset = () => { if (alive && el) reset(); };
  mountEl.addEventListener('click', onClick);
  mountEl.addEventListener('submit', onSubmit);
  mountEl.addEventListener('input', onInput);
  mountEl.addEventListener('keydown', onRecKey);
  mountEl.addEventListener('click', onRecMark);
  resetBtn?.addEventListener('click', onReset);
  loadManifest();

  return {
    // Playback is the only timer here: the host stops it while the case study is hidden, and it resumes only if it was playing.
    pause() { clearTimeout(playTimer); playTimer = 0; },
    resume() { if (alive && playing && !playTimer) schedule(); },
    destroy() {
      alive = false; gen++; loadGen++; manifestGen++; recGen++;
      stopPlay();
      stopWorker();
      mountEl.removeEventListener('click', onClick);
      mountEl.removeEventListener('submit', onSubmit);
      mountEl.removeEventListener('input', onInput);
      mountEl.removeEventListener('keydown', onRecKey);
      mountEl.removeEventListener('click', onRecMark);
      resetBtn?.removeEventListener('click', onReset);
      mountEl.replaceChildren();
    },
  };
}
