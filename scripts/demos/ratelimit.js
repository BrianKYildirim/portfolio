// Rate Limiter Playground: simulated clients call the ported token-bucket decision
// (ratelimit-core.js) on a virtual clock. Traffic is pure and exported for tests; mount() builds the UI.
import { TokenBucketLimiter } from './ratelimit-core.js';

const CAP = 10_000; // ring-buffer size for drawn events
const DEFAULT_RATES = [8, 3, 12, 1];
const RUNS = [[10, '10 s'], [30, '30 s'], [60, '60 s'], [0, 'Unlimited']];
const SPEEDS = [0.5, 1, 2];

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Arrivals per client on a BigInt nanosecond clock. Steady clients arrive every round(1e9 / rate) ns,
// random ones after exponential gaps (Poisson arrivals) from a seeded generator, so a reset replays exactly.
export class Traffic {
  constructor(cfg) {
    this.cfg = cfg; // { capacity, refill, shared, clientCount, clients: [{ rate, pattern }] }
    this.limiter = new TokenBucketLimiter();
    this.now = 0n;
    this.onDecision = () => {};
    this.clients = cfg.clients.map((c, i) => ({ ...c, i, rng: mulberry32(42 + i), next: null }));
    this.clients.forEach((c) => this.reschedule(c));
  }
  key(i) { return this.cfg.shared ? 'global' : `user:${i + 1}`; }
  limit() { return { capacity: this.cfg.capacity, refill_per_sec: this.cfg.refill }; }
  gap(c) {
    if (!(c.rate > 0)) return null;
    const s = c.pattern === 'random' ? -Math.log(1 - c.rng()) / c.rate : 1 / c.rate;
    return BigInt(Math.max(1, Math.round(s * 1e9)));
  }
  reschedule(c) { const g = this.gap(c); c.next = g === null ? null : this.now + g; }
  call(key, lane, t = this.now) {
    const d = this.limiter.allow(key, this.limit(), t);
    this.onDecision({ t, key, lane, ...d });
    return d;
  }
  // Runs every arrival due at or before t, in time order, then moves the clock to t.
  advanceTo(t) {
    for (;;) {
      let c = null;
      for (let i = 0; i < this.cfg.clientCount; i++) {
        const x = this.clients[i];
        if (x.next !== null && x.next <= t && (!c || x.next < c.next)) c = x;
      }
      if (!c) break;
      this.call(this.key(c.i), c.i, c.next);
      const g = this.gap(c);
      c.next = g === null ? null : c.next + g;
    }
    this.now = t;
  }
}

const TEMPLATE = (cfg) => `
<div class="demo-rl">
  <div class="demo-card demo-rl-controls">
    <fieldset class="demo-group"><legend class="demo-legend">Limit</legend>
      <label class="demo-field"><span class="demo-small">Capacity (burst) <output data-out="capacity">${cfg.capacity}</output></span><input type="range" min="1" max="50" value="${cfg.capacity}" data-in="capacity"></label>
      <label class="demo-field"><span class="demo-small">Refill rate <output data-out="refill">${cfg.refill} tokens/s</output></span><input type="range" min="0" max="50" value="${cfg.refill}" data-in="refill"></label>
    </fieldset>
    <fieldset class="demo-group"><legend class="demo-legend">Clients</legend>
      <div class="demo-seg" role="group" aria-label="Number of clients">${[1, 2, 3, 4].map((n) => `<button type="button" data-clients="${n}" aria-pressed="${n === cfg.clientCount}">${n}</button>`).join('')}</div>
      <div class="demo-clients" data-client-rows>${cfg.clients.map((c, i) => `
        <div class="demo-client" data-client="${i}">
          <label class="demo-field"><span class="demo-small">Client ${i + 1} rate <output data-out="rate${i}">${c.rate} req/s</output></span><input type="range" min="0" max="40" value="${c.rate}" data-rate="${i}"></label>
          <label class="demo-field"><span class="vh">Client ${i + 1} pattern</span><select class="demo-input" data-pattern="${i}"><option value="steady">Steady</option><option value="random">Random</option></select></label>
        </div>`).join('')}
      </div>
    </fieldset>
    <fieldset class="demo-group"><legend class="demo-legend">Keys</legend>
      <label class="demo-radio"><input type="radio" name="rl-keys" value="per" checked><span>Key per client (<code>user:1</code>…)</span></label>
      <label class="demo-radio"><input type="radio" name="rl-keys" value="shared"><span>One shared key (<code>global</code>)</span></label>
    </fieldset>
    <fieldset class="demo-group"><legend class="demo-legend">Run</legend>
      <div class="demo-seg" role="group" aria-label="Run length">${RUNS.map(([s, l]) => `<button type="button" data-run="${s}" aria-pressed="${s === 30}">${l}</button>`).join('')}</div>
      <div class="demo-seg" role="group" aria-label="Speed">${SPEEDS.map((s) => `<button type="button" data-speed="${s}" aria-pressed="${s === 1}">${s}×</button>`).join('')}</div>
    </fieldset>
    <div class="demo-row">
      <button type="button" class="project-link-accent" data-toggle>Start</button>
      <button type="button" class="project-link" data-burst>Send burst</button>
    </div>
  </div>
  <div class="demo-rl-viz">
    <div class="demo-buckets" data-buckets></div>
    <p class="pd-caption">The library refills lazily, only when <code>allow()</code> is called; the level shown between calls is computed for display. Click a bucket to send one request.</p>
    <div class="demo-card">
      <p class="demo-label" id="rl-tl">Decisions · last 10 s</p>
      <canvas class="demo-canvas" height="120" data-timeline role="img" aria-labelledby="rl-tl" aria-describedby="rl-table"></canvas>
      <p class="demo-legend-row"><span class="demo-sw demo-sw-ok"></span>accepted (filled, above the line) <span class="demo-sw demo-sw-no"></span>rejected (hollow, below)</p>
    </div>
    <div class="demo-card">
      <p class="demo-label" id="rl-tp">Throughput · per second, last 30 s</p>
      <canvas class="demo-canvas" height="110" data-throughput role="img" aria-labelledby="rl-tp" aria-describedby="rl-table"></canvas>
      <p class="demo-legend-row"><span class="demo-sw demo-sw-ok"></span>accepted <span class="demo-sw demo-sw-hatch"></span>rejected <span class="demo-sw demo-sw-line"></span><span data-limit-label></span></p>
      <div class="vh"><table id="rl-table"><caption>Requests per second, last 10 seconds</caption><thead><tr><th>Second</th><th>Accepted</th><th>Rejected</th></tr></thead><tbody data-table></tbody></table></div>
    </div>
    <dl class="demo-counters" data-counters></dl>
    <div>
      <p class="demo-label">Decision log · newest first</p>
      <ol class="demo-log" data-log aria-label="Decision log, newest first"></ol>
    </div>
  </div>
</div>`;

export function mount(root, { status }) {
  const mountEl = root.querySelector('.demo-mount');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cfg = { capacity: 10, refill: 5, shared: false, clientCount: 2, clients: DEFAULT_RATES.map((rate) => ({ rate, pattern: 'steady' })) };
  let runS = 30, speed = 1, mode = 'idle', hostPaused = false, raf = 0, lastFrame = 0, lastDraw = 0, lastAnnounce = 0;
  let T, ev, bins, counts, last, log, logDirty, flashes;
  mountEl.innerHTML = TEMPLATE(cfg);
  const q = (s) => mountEl.querySelector(s);
  const el = {
    toggle: q('[data-toggle]'), buckets: q('[data-buckets]'), timeline: q('[data-timeline]'), throughput: q('[data-throughput]'),
    counters: q('[data-counters]'), log: q('[data-log]'), table: q('[data-table]'), limitLabel: q('[data-limit-label]'), rows: q('[data-client-rows]'),
  };
  const css = getComputedStyle(root), C = Object.fromEntries(['accent', 'signal-bad', 'text', 'muted', 'border', 'border-strong', 'bg'].map((n) => [n, css.getPropertyValue(`--${n}`).trim()]));
  const runNs = () => (runS ? BigInt(runS) * 1_000_000_000n : null);
  const sec = (t) => Number(t) / 1e9;
  const keys = () => (cfg.shared ? ['global'] : Array.from({ length: cfg.clientCount }, (_, i) => `user:${i + 1}`));

  function reset() {
    T = new Traffic(cfg);
    T.onDecision = record;
    ev = { t: new Float64Array(CAP), lane: new Uint8Array(CAP), ok: new Uint8Array(CAP), n: 0 };
    bins = new Map(); counts = { offered: 0, ok: 0, no: 0 }; last = new Map(); log = []; logDirty = true; flashes = new Map();
    el.table.replaceChildren();
    renderBuckets(true);
  }
  function record(d) {
    const i = ev.n % CAP, s = sec(d.t);
    ev.t[i] = s; ev.lane[i] = d.lane; ev.ok[i] = d.allowed ? 1 : 0; ev.n++;
    const b = Math.floor(s), bin = bins.get(b) || bins.set(b, [0, 0]).get(b);
    bin[d.allowed ? 0 : 1]++;
    if (bins.size > 90) bins.delete(bins.keys().next().value);
    counts.offered++; d.allowed ? counts.ok++ : counts.no++;
    last.set(d.key, d);
    log.unshift(d); if (log.length > 40) log.length = 40;
    logDirty = true;
    const f = flashes.get(d.key), now = performance.now();
    if (!reduced && (!f || now - f.start >= 333)) flashes.set(d.key, { start: now, ok: d.allowed, until: now + (d.allowed ? 200 : 300) });
  }

  // ---------- Rendering ----------
  let bucketEls = new Map();
  function renderBuckets(rebuild = false) {
    const ks = keys();
    if (rebuild || ks.join() !== [...bucketEls.keys()].join()) {
      bucketEls = new Map(ks.map((k) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'demo-bucket'; b.dataset.key = k;
        b.innerHTML = '<span class="demo-tube"><span class="demo-tube-fill"></span></span><span class="demo-bk-key"></span><span class="demo-bk-level"></span><span class="demo-bk-note"></span>';
        b.querySelector('.demo-bk-key').textContent = k;
        return [k, { b, fill: b.querySelector('.demo-tube-fill'), tube: b.querySelector('.demo-tube'), level: b.querySelector('.demo-bk-level'), note: b.querySelector('.demo-bk-note'), whole: -1 }];
      }));
      el.buckets.replaceChildren(...[...bucketEls.values()].map((x) => x.b));
    }
    const lim = T.limit(), now = performance.now();
    for (const [k, x] of bucketEls) {
      const lvl = T.limiter.peek(k, lim, T.now), d = last.get(k);
      x.tube.style.setProperty('--lvl', `${(lvl / cfg.capacity) * 100}%`);
      x.tube.style.setProperty('--n', String(cfg.capacity <= 20 ? cfg.capacity : cfg.capacity / 5));
      x.level.textContent = `${lvl.toFixed(2)} / ${cfg.capacity}`;
      x.note.textContent = !T.limiter.keys.has(k) ? 'new key: starts full'
        : lvl < 1 ? (cfg.refill === 0 ? 'never refills (rate 0)' : `next token in ${Math.ceil(((1 - lvl) * 1000) / cfg.refill)} ms`)
        : d ? `{ allowed: ${d.allowed}, remaining: ${d.remaining}, reset_ms: ${d.reset_ms} }` : '';
      const whole = Math.floor(lvl + 1e-9);
      if (whole !== x.whole) { x.whole = whole; x.b.setAttribute('aria-label', `${k}, ${whole} of ${cfg.capacity} tokens. Send one request.`); }
      const f = flashes.get(k), on = f && now < f.until;
      x.b.classList.toggle('is-ok', !!on && f.ok);
      x.b.classList.toggle('is-no', !!on && !f.ok);
    }
  }

  function canvas2d(c) {
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = '10px "JetBrains Mono", monospace';
    return [g, w, h];
  }
  function drawTimeline() {
    const [g, w, h] = canvas2d(el.timeline), now = sec(T.now), lanes = cfg.clientCount, axis = 16, lh = (h - axis) / lanes;
    g.fillStyle = C.muted; g.textBaseline = 'alphabetic';
    for (let l = 0; l < lanes; l++) {
      const y = Math.round(lh * l + lh / 2) + 0.5;
      g.strokeStyle = C.border; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      g.fillStyle = C.muted; g.fillText(`client ${l + 1}`, 2, y - lh / 2 + 10);
    }
    g.lineWidth = 1;
    for (let k = Math.max(0, ev.n - CAP); k < ev.n; k++) {
      const i = k % CAP, t = ev.t[i];
      if (t < now - 10 || t > now || ev.lane[i] >= lanes) continue;
      const x = Math.round(((t - (now - 10)) / 10) * (w - 4)) + 1, y = Math.round(lh * ev.lane[i] + lh / 2);
      if (ev.ok[i]) { g.fillStyle = C.accent; g.fillRect(x, y - 8, 2, 7); }
      else { g.strokeStyle = C['signal-bad']; g.strokeRect(x + 0.5, y + 2.5, 2, 6); }
    }
    g.fillStyle = C.muted;
    [[0, '-10s', 'left'], [0.5, '-5s', 'center'], [1, 'now', 'right']].forEach(([p, s, a]) => { g.textAlign = a; g.fillText(s, p * w, h - 3); });
    g.textAlign = 'left';
  }
  let hatch = null;
  function drawThroughput() {
    const [g, w, h] = canvas2d(el.throughput), cur = Math.floor(sec(T.now)), top = 14, bottom = h - 16;
    const limit = cfg.refill * (cfg.shared ? 1 : cfg.clientCount);
    let max = Math.max(1, limit);
    for (let s = cur - 29; s <= cur; s++) { const b = bins.get(s); if (b) max = Math.max(max, b[0] + b[1]); }
    max *= 1.15;
    const y = (v) => bottom - (v / max) * (bottom - top), bw = w / 30;
    if (!hatch) {
      const p = Object.assign(document.createElement('canvas'), { width: 6, height: 6 }), pg = p.getContext('2d');
      pg.strokeStyle = C['signal-bad']; pg.lineWidth = 1; pg.beginPath(); pg.moveTo(0, 6); pg.lineTo(6, 0); pg.stroke();
      hatch = g.createPattern(p, 'repeat');
    }
    for (let s = cur - 29, i = 0; s <= cur; s++, i++) {
      const b = bins.get(s);
      if (!b) continue;
      const x = i * bw + 1, bwi = Math.max(1, bw - 2);
      g.fillStyle = C.accent; g.fillRect(x, y(b[0]), bwi, bottom - y(b[0]));
      if (b[1]) {
        const y0 = y(b[0] + b[1]), hh = y(b[0]) - y0;
        g.fillStyle = hatch; g.fillRect(x, y0, bwi, hh);
        g.strokeStyle = C['signal-bad']; g.strokeRect(x + 0.5, y0 + 0.5, bwi - 1, Math.max(0, hh - 1));
      }
    }
    g.strokeStyle = C.text; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(0, Math.round(y(limit)) + 0.5); g.lineTo(w, Math.round(y(limit)) + 0.5); g.stroke(); g.setLineDash([]);
    g.fillStyle = C.muted;
    g.fillText(`${Math.round(max)}/s`, 2, 10);
    g.textAlign = 'left'; g.fillText('-30s', 0, h - 3); g.textAlign = 'right'; g.fillText('now', w, h - 3); g.textAlign = 'left';
    el.limitLabel.textContent = cfg.shared ? `limit ${limit}/s (one shared key)` : `limit ${limit}/s (${cfg.refill}/s × ${cfg.clientCount} key${cfg.clientCount > 1 ? 's' : ''})`;
  }
  let tableSec = null, countersHtml = '';
  function renderText() {
    const pct = counts.offered ? ((counts.ok / counts.offered) * 100).toFixed(1) + '%' : '–';
    const items = [['Offered', counts.offered], ['Accepted', counts.ok], ['Rejected', counts.no], ['Acceptance', pct], ['Keys tracked', T.limiter.size()]];
    const html = items.map(([k, v]) => `<div><dt class="demo-label">${k}</dt><dd class="demo-num">${v}</dd></div>`).join('');
    if (countersHtml !== html) el.counters.innerHTML = countersHtml = html;
    if (logDirty) {
      logDirty = false;
      el.log.replaceChildren(...log.map((d) => Object.assign(document.createElement('li'), {
        className: d.allowed ? 'is-ok' : 'is-no',
        textContent: `t=${sec(d.t).toFixed(3)}s  ${d.key} -> allowed=${d.allowed ? 'yes' : 'no'} remaining=${d.remaining} reset_ms=${d.reset_ms}`,
      })));
    }
    const cur = Math.floor(sec(T.now));
    if (cur !== tableSec) {
      tableSec = cur;
      const rows = [];
      for (let s = cur - 10; s < cur; s++) if (s >= 0) { const b = bins.get(s) || [0, 0]; rows.push(`<tr><td>${s}–${s + 1} s</td><td>${b[0]}</td><td>${b[1]}</td></tr>`); }
      el.table.innerHTML = rows.join('');
    }
  }
  function draw(force = false) {
    const now = performance.now();
    if (!force && reduced && now - lastDraw < 250) return;
    lastDraw = now;
    renderBuckets(); drawTimeline(); drawThroughput(); renderText();
  }

  // ---------- Clock ----------
  function frame(ts) {
    raf = 0;
    const dt = Math.min(lastFrame ? ts - lastFrame : 16, 100) * speed;
    lastFrame = ts;
    let target = T.now + BigInt(Math.round(dt * 1e6));
    const end = runNs();
    if (end !== null && target >= end) target = end > T.now ? end : T.now; // a shortened run never moves the clock back
    T.advanceTo(target);
    if (end !== null && T.now >= end) {
      mode = 'finished'; syncToggle(); draw(true);
      return status(`${runS} s simulated: ${counts.ok} accepted, ${counts.no} rejected.`);
    }
    if (ts - lastAnnounce >= 5000) { lastAnnounce = ts; status(`t=${Math.floor(sec(T.now))} s: ${counts.ok} accepted, ${counts.no} rejected.`); }
    draw();
    loop();
  }
  const loop = () => { if (mode === 'running' && !hostPaused && !raf) raf = requestAnimationFrame(frame); };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; lastFrame = 0; };
  function syncToggle() {
    el.toggle.textContent = { idle: 'Start', running: 'Pause', paused: 'Resume', finished: 'Restart' }[mode];
    el.toggle.setAttribute('aria-pressed', String(mode === 'running'));
  }
  function start() {
    if (mode === 'finished') { reset(); }
    mode = 'running'; lastAnnounce = performance.now(); syncToggle(); loop();
    status(`Running: ${cfg.clientCount} client${cfg.clientCount > 1 ? 's' : ''}, capacity ${cfg.capacity}, refill ${cfg.refill}/s${runS ? `, ${runS} s` : ''}.`);
  }
  function pause() { mode = 'paused'; stop(); syncToggle(); draw(true); status(`Paused at t=${sec(T.now).toFixed(1)} s.`); }

  // ---------- Controls ----------
  const setPressed = (sel, btn) => mountEl.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  function syncClientRows() {
    el.rows.querySelectorAll('[data-client]').forEach((r) => { r.hidden = +r.dataset.client >= cfg.clientCount; });
  }
  mountEl.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.in) {
      cfg[t.dataset.in] = t.valueAsNumber;
      q(`[data-out="${t.dataset.in}"]`).textContent = t.dataset.in === 'refill' ? `${t.value} tokens/s` : t.value;
      t.setAttribute('aria-valuetext', t.dataset.in === 'refill' ? `${t.value} tokens per second` : `${t.value} tokens`);
    } else if (t.dataset.rate) {
      const c = T.clients[+t.dataset.rate];
      cfg.clients[c.i].rate = c.rate = t.valueAsNumber;
      T.reschedule(c);
      q(`[data-out="rate${c.i}"]`).textContent = `${t.value} req/s`;
      t.setAttribute('aria-valuetext', `${t.value} requests per second`);
    }
    draw(true);
  });
  mountEl.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.pattern) { const c = T.clients[+t.dataset.pattern]; cfg.clients[c.i].pattern = c.pattern = t.value; T.reschedule(c); }
    else if (t.name === 'rl-keys') { cfg.shared = t.value === 'shared'; status(cfg.shared ? 'All clients now share the key global.' : 'Each client now has its own key.'); draw(true); }
  });
  mountEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.clients) {
      const n = +b.dataset.clients;
      for (let i = cfg.clientCount; i < n; i++) T.reschedule(T.clients[i]); // newly active clients start from now
      cfg.clientCount = n; setPressed('[data-clients]', b); syncClientRows(); draw(true);
    } else if (b.dataset.run != null) {
      runS = +b.dataset.run; setPressed('[data-run]', b);
      if (mode === 'finished' && (!runS || T.now < runNs())) { mode = 'paused'; syncToggle(); }
    } else if (b.dataset.speed) {
      speed = +b.dataset.speed; setPressed('[data-speed]', b);
    } else if (b.matches('[data-toggle]')) {
      mode === 'running' ? pause() : start();
    } else if (b.matches('[data-burst]')) {
      const key = keys()[0], n = cfg.capacity + 5;
      let ok = 0;
      for (let i = 0; i < n; i++) ok += T.call(key, 0).allowed;
      draw(true);
      status(`Burst of ${n} to ${key} at t=${sec(T.now).toFixed(3)} s: ${ok} allowed, ${n - ok} denied.`);
    } else if (b.dataset.key) {
      const d = T.call(b.dataset.key, cfg.shared ? 0 : keys().indexOf(b.dataset.key));
      draw(true);
      status(`${b.dataset.key}: ${d.allowed ? `allowed, ${d.remaining} remaining` : d.reset_ms ? `denied, next token in ${d.reset_ms} ms` : 'denied, never refills'}.`);
    }
  });
  const resetBtn = root.querySelector('.demo-status .btn-ghost'), onReset = () => {
    stop(); mode = 'idle'; reset(); syncToggle(); draw(true);
    status('Reset. Press Start or click a bucket.');
  };
  resetBtn.addEventListener('click', onReset);
  const onResize = () => draw(true);
  addEventListener('resize', onResize);

  reset(); syncClientRows(); syncToggle(); draw(true);
  if (reduced) status('Press Start or click a bucket.');
  else start();

  return {
    pause() { hostPaused = true; stop(); },
    resume() { hostPaused = false; loop(); },
    destroy() { stop(); resetBtn.removeEventListener('click', onReset); removeEventListener('resize', onResize); mountEl.replaceChildren(); },
  };
}
