// Rate Limiter Playground: synthetic clients call ratelimit-cpp's rl_allow_at, compiled to WebAssembly, on a virtual
// clock (ratelimit-traffic.js, ratelimit-wasm.js). mount() builds the UI; Replay reruns a recorded session from time 0.
import { Run, ALL_KEYS, parseSeed, randomSeed } from './ratelimit-traffic.js';
import { loadLimiterModule, Limiter, RL_NEVER, formatTokens, formatWait } from './ratelimit-wasm.js';

const CAP = 10_000; // ring-buffer size for drawn events
const DEFAULT_RATES = [8, 3, 12, 1];
const RUNS = [[10, '10 s'], [30, '30 s'], [60, '60 s'], [0, 'Unlimited']]; // claim-waiver: run-length option labels in the playground, not measurements
const SPEEDS = [0.5, 1, 2];
const SKELETON = '<div class="pd-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
// Retry is bound by the demo's own data-retry: the case study's global retry class reloads the whole write-up.
const LOAD_ERROR = '<div class="pd-error"><p>Couldn’t load this demo.</p><div><button type="button" class="project-link" data-retry>Retry</button></div></div>';

const TIMELINE_LABEL = 'Decisions · last 10 s of virtual time'; // claim-waiver: window of the playground timeline on the playground's virtual clock, not a measurement
const THROUGHPUT_LABEL = 'Throughput · per virtual second, last 30 s'; // claim-waiver: window of the playground throughput chart on the playground's virtual clock, not a measurement
const TABLE_CAPTION = 'Requests per virtual second, last 10 seconds'; // claim-waiver: window of the playground table on the playground's virtual clock, not a measurement
const TEMPLATE = (cfg, seed) => `
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
      <div class="demo-row demo-rl-seed">
        <label class="demo-field"><span class="demo-small">Seed</span><input class="demo-input demo-seed" data-seed inputmode="numeric" autocomplete="off" spellcheck="false" value="${seed}"></label>
        <button type="button" class="project-link" data-new-seed>New seed</button>
      </div>
    </fieldset>
    <div class="demo-row">
      <button type="button" class="project-link-accent" data-toggle>Start</button>
      <button type="button" class="project-link" data-burst>Send burst</button>
      <button type="button" class="project-link" data-replay>Replay</button>
    </div>
  </div>
  <div class="demo-rl-viz">
    <div class="demo-buckets" data-buckets></div>
    <p class="pd-caption">Each bucket is read with the library's inspection API (<code>rl_inspect_at</code>) at the current virtual instant; reading changes nothing. Click a bucket to send one request.</p>
    <div class="demo-card">
      <p class="demo-label" id="rl-tl">${TIMELINE_LABEL}</p>
      <canvas class="demo-canvas" height="120" data-timeline role="img" aria-labelledby="rl-tl" aria-describedby="rl-table"></canvas>
      <p class="demo-legend-row"><span class="demo-sw demo-sw-ok"></span>accepted (filled, above the line) <span class="demo-sw demo-sw-no"></span>rejected (hollow, below)</p>
    </div>
    <div class="demo-card">
      <p class="demo-label" id="rl-tp">${THROUGHPUT_LABEL}</p>
      <canvas class="demo-canvas" height="110" data-throughput role="img" aria-labelledby="rl-tp" aria-describedby="rl-table"></canvas>
      <p class="demo-legend-row"><span class="demo-sw demo-sw-ok"></span>accepted <span class="demo-sw demo-sw-hatch"></span>rejected <span class="demo-sw demo-sw-line"></span><span data-limit-label></span></p>
      <div class="vh"><table id="rl-table"><caption>${TABLE_CAPTION}</caption><thead><tr><th>Second</th><th>Accepted</th><th>Rejected</th></tr></thead><tbody data-table></tbody></table></div>
    </div>
    <dl class="demo-counters" data-counters></dl>
    <div>
      <p class="demo-label">Decision log · newest first</p>
      <ol class="demo-log" data-log aria-label="Decision log, newest first"></ol>
    </div>
  </div>
</div>`;

// mount() stays synchronous (the host expects { pause, resume, destroy } at once): it shows a skeleton, loads the
// module, then builds the playground. A failed load or a WebAssembly abort shows the error block, whose Retry loads a
// fresh module instance (D-13). There is no JavaScript decision path to fall back to.
export function mount(root, { status }) {
  const mountEl = root.querySelector('.demo-mount');
  let alive = true, hostPaused = false, api = null, loadGen = 0, attempt = 0;
  const q = (s) => mountEl.querySelector(s);
  const showError = (refocus) => {
    mountEl.innerHTML = LOAD_ERROR;
    status('Couldn’t load this demo. Press Retry to load it again.');
    if (refocus) q('[data-retry]').focus();
  };
  async function load() {
    const g = ++loadGen, refocus = mountEl.contains(document.activeElement); // keep keyboard focus in the demo across a Retry
    mountEl.innerHTML = SKELETON;
    status('Loading the rate limiter (WebAssembly)…');
    try {
      const module = await loadLimiterModule({ attempt });
      if (!alive || g !== loadGen) return; // closed, or superseded by a later Retry: the late module builds nothing
      api = playground(root, mountEl, module, { status, paused: hostPaused, onAbort });
      if (refocus) q('[data-toggle]').focus();
    } catch (err) {
      if (!alive || g !== loadGen) return; // a stale attempt's failure is not this demo's state any more
      console.error(err);
      api = null; showError(refocus);
    }
  }
  function onAbort() { const refocus = mountEl.contains(document.activeElement); api = null; showError(refocus); }
  const onRetry = (e) => { if (alive && e.target.closest('[data-retry]')) { attempt++; load(); } };
  mountEl.addEventListener('click', onRetry);
  load();
  return {
    pause() { hostPaused = true; api?.pause(); },
    resume() { hostPaused = false; api?.resume(); },
    destroy() {
      alive = false; loadGen++;
      mountEl.removeEventListener('click', onRetry);
      api?.destroy(); api = null;
      mountEl.replaceChildren();
    },
  };
}

function playground(root, mountEl, module, { status, paused, onAbort }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let seed = randomSeed();
  // cfg is the run's own config (run.config); the controls change it only through run.apply config events.
  let cfg = { capacity: 10, refill: 5, shared: false, clientCount: 2, clients: DEFAULT_RATES.map((rate) => ({ rate, pattern: 'steady' })) };
  let run = null, runS = 30, speed = 1, mode = 'idle', hostPaused = paused, raf = 0, lastFrame = 0, lastDraw = 0, lastAnnounce = 0;
  let ev, bins, counts, last, log, logDirty, flashes, tableSec = null, countersHtml = '', shownCfg = '';
  const newRun = () => {
    const r = new Run({ seed, config: cfg, createLimiter: () => new Limiter(module) });
    run?.free();
    run = r; cfg = run.config; run.onDecision = record;
  };
  newRun(); // before any DOM or listener, so a failure here leaves nothing behind
  mountEl.innerHTML = TEMPLATE(cfg, seed);
  const q = (s) => mountEl.querySelector(s);
  const el = {
    toggle: q('[data-toggle]'), buckets: q('[data-buckets]'), timeline: q('[data-timeline]'), throughput: q('[data-throughput]'),
    counters: q('[data-counters]'), log: q('[data-log]'), table: q('[data-table]'), limitLabel: q('[data-limit-label]'), rows: q('[data-client-rows]'),
    seed: q('[data-seed]'),
  };
  const css = getComputedStyle(root), C = Object.fromEntries(['accent', 'signal-bad', 'text', 'muted', 'border', 'border-strong', 'bg'].map((n) => [n, css.getPropertyValue(`--${n}`).trim()]));
  const runNs = () => (runS ? BigInt(runS) * 1_000_000_000n : null);
  const sec = (t) => Number(t) / 1e9;
  const keys = () => run.keys();
  const configure = (patch) => run.apply({ kind: 'config', patch });

  // ---------- Failure (owner decision 2026-11-12: a WebAssembly trap or abort kills the module) ----------
  // Every engine call (advanceTo, apply, inspect, replay, trackedCount) runs inside guard(), from the frame loop or a
  // control handler. A throw stops the loop, drops the run and shows the error block; Retry instantiates a fresh module.
  const listeners = new AbortController();
  const on = (target, type, fn) => target.addEventListener(type, (e) => guard(() => fn(e)), { signal: listeners.signal });
  function guard(fn) {
    if (!run) return;
    try { return fn(); } catch (err) {
      console.error(err);
      teardown(true); onAbort();
    }
  }
  function teardown(dead) {
    stop(); listeners.abort();
    try { run?.free(); } catch (err) {
      // A trapped or aborted module can throw again on free; its memory goes with the dropped instance.
      if (!dead) console.error(err);
    }
    run = null;
  }

  // Everything drawn is rebuilt only from run.onDecision, so a replay redraws exactly what the original run drew.
  function resetView() {
    ev = { t: new Float64Array(CAP), lane: new Uint8Array(CAP), ok: new Uint8Array(CAP), n: 0 };
    bins = new Map(); counts = { offered: 0, ok: 0, no: 0 }; last = new Map(); log = []; logDirty = true; flashes = new Map(); tableSec = null;
    el.table.replaceChildren();
    renderBuckets(true);
  }
  function reset(fresh = true) {
    if (fresh) newRun();
    resetView();
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
    const f = flashes.get(d.key), now = performance.now(); // browser clock: flash timing only
    if (!reduced && (!f || now - f.start >= 333)) flashes.set(d.key, { start: now, ok: d.allowed, until: now + (d.allowed ? 200 : 300) });
  }

  // ---------- Rendering ----------
  let bucketEls = new Map();
  const span = (className) => Object.assign(document.createElement('span'), { className });
  const wait = (ns) => (ns === 0n ? 'now' : ns === RL_NEVER ? 'never' : formatWait(ns));
  function renderBuckets(rebuild = false) {
    const ks = keys();
    if (rebuild || ks.join() !== [...bucketEls.keys()].join()) {
      bucketEls = new Map(ks.map((k) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'demo-bucket'; b.dataset.key = k;
        const x = { b, tube: span('demo-tube'), fill: span('demo-tube-fill'), key: span('demo-bk-key'), level: span('demo-bk-level'),
          exact: span('demo-bk-exact'), waits: span('demo-bk-waits'), note: span('demo-bk-note'), label: '' };
        x.tube.append(x.fill); x.key.textContent = k;
        b.append(x.tube, x.key, x.level, x.exact, x.waits, x.note);
        return [k, x];
      }));
      el.buckets.replaceChildren(...[...bucketEls.values()].map((x) => x.b));
    }
    const now = performance.now(); // browser clock: flash timing only
    for (const [k, x] of bucketEls) {
      // Every readout is an rl_inspect_at field at the current virtual instant (inspection changes nothing).
      const s = run.inspect(k), d = last.get(k);
      // Display geometry only: the tube height is the library's nanotokens over capacity.
      const pct = cfg.capacity ? (Number(s.nanotokens) / Number(BigInt(cfg.capacity) * 1_000_000_000n)) * 100 : 0;
      x.tube.style.setProperty('--lvl', `${pct}%`);
      x.tube.style.setProperty('--n', String(cfg.capacity <= 20 ? cfg.capacity : cfg.capacity / 5));
      x.level.textContent = `${s.tokens} / ${cfg.capacity}`;
      x.exact.textContent = `${formatTokens(s.nanotokens)} tokens`;
      x.waits.textContent = `next token: ${wait(s.until_token_ns)}\nfull: ${wait(s.until_full_ns)}`;
      x.note.textContent = !s.tracked ? 'new key: starts full'
        : d ? `{ allowed: ${d.allowed}, remaining: ${String(d.remaining)}, reset_ms: ${String(d.reset_ms)} }` : '';
      const label = `${k}, ${s.tokens} of ${cfg.capacity} tokens. Send one request.`;
      if (label !== x.label) { x.label = label; x.b.setAttribute('aria-label', label); }
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
    const [g, w, h] = canvas2d(el.timeline), now = sec(run.now), lanes = cfg.clientCount, axis = 16, lh = (h - axis) / lanes;
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
    [[0, '-10s', 'left'], [0.5, '-5s', 'center'], [1, 'now', 'right']].forEach(([p, s, a]) => { g.textAlign = a; g.fillText(s, p * w, h - 3); }); // claim-waiver: axis labels on the playground simulated clock, not measurements
    g.textAlign = 'left';
  }
  let hatch = null;
  function drawThroughput() {
    const [g, w, h] = canvas2d(el.throughput), cur = Math.floor(sec(run.now)), top = 14, bottom = h - 16;
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
    g.textAlign = 'left'; g.fillText('-30s', 0, h - 3); g.textAlign = 'right'; g.fillText('now', w, h - 3); g.textAlign = 'left'; // claim-waiver: axis labels on the playground simulated clock, not measurements
    el.limitLabel.textContent = cfg.shared ? `limit ${limit}/s (one shared key)` : `limit ${limit}/s (${cfg.refill}/s × ${cfg.clientCount} key${cfg.clientCount > 1 ? 's' : ''})`;
  }
  function renderText() {
    const pct = counts.offered ? ((counts.ok / counts.offered) * 100).toFixed(1) + '%' : '–';
    const items = [['Offered', counts.offered], ['Accepted', counts.ok], ['Rejected', counts.no], ['Acceptance', pct], ['Keys tracked', run.trackedCount()],
      ['Virtual time', `${sec(run.now).toFixed(1)} s`]];
    const html = items.map(([k, v]) => `<div><dt class="demo-label">${k}</dt><dd class="demo-num">${v}</dd></div>`).join('');
    if (countersHtml !== html) el.counters.innerHTML = countersHtml = html;
    if (logDirty) {
      logDirty = false;
      el.log.replaceChildren(...log.map((d) => {
        const li = Object.assign(document.createElement('li'), {
          className: d.allowed ? 'is-ok' : 'is-no',
          textContent: `t=${sec(d.t).toFixed(3)}s  ${d.key} -> allowed=${d.allowed ? 'yes' : 'no'} remaining=${String(d.remaining)} reset_ms=${String(d.reset_ms)}`,
        });
        li.append(Object.assign(span('demo-src'), { textContent: d.source })); // 'synthetic' or 'you'
        return li;
      }));
    }
    const cur = Math.floor(sec(run.now));
    if (cur !== tableSec) {
      tableSec = cur;
      const rows = [];
      for (let s = cur - 10; s < cur; s++) if (s >= 0) { const b = bins.get(s) || [0, 0]; rows.push(`<tr><td>${s}–${s + 1} s</td><td>${b[0]}</td><td>${b[1]}</td></tr>`); }
      el.table.innerHTML = rows.join('');
    }
  }
  function draw(force = false) {
    const now = performance.now(); // browser clock: draw throttling only
    if (!force && reduced && now - lastDraw < 250) return;
    lastDraw = now;
    renderBuckets(); drawTimeline(); drawThroughput(); renderText(); syncControls();
  }
  // The controls show the run's config. A replay rewinds it to the initial config and re-applies the logged config
  // events at their virtual times, so the controls follow the run, not the other way round.
  function syncControls() {
    const sig = JSON.stringify(cfg);
    if (sig === shownCfg) return;
    shownCfg = sig;
    setSlider(q('[data-in="capacity"]'), cfg.capacity, q('[data-out="capacity"]'), String(cfg.capacity), `${cfg.capacity} tokens`);
    setSlider(q('[data-in="refill"]'), cfg.refill, q('[data-out="refill"]'), `${cfg.refill} tokens/s`, `${cfg.refill} tokens per second`);
    cfg.clients.forEach((c, i) => {
      setSlider(q(`[data-rate="${i}"]`), c.rate, q(`[data-out="rate${i}"]`), `${c.rate} req/s`, `${c.rate} requests per second`);
      q(`[data-pattern="${i}"]`).value = c.pattern;
    });
    mountEl.querySelectorAll('[data-clients]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.clients === cfg.clientCount)));
    mountEl.querySelectorAll('[name="rl-keys"]').forEach((r) => { r.checked = (r.value === 'shared') === cfg.shared; });
    syncClientRows();
  }
  function setSlider(t, v, out, text, valuetext) {
    if (t.valueAsNumber !== v) t.value = String(v); // never rewrite a slider the visitor is dragging to the same value
    out.textContent = text; t.setAttribute('aria-valuetext', valuetext);
  }

  // ---------- Clock ----------
  function frame(ts) { raf = 0; guard(() => step(ts)); }
  function step(ts) {
    const dt = Math.min(lastFrame ? ts - lastFrame : 16, 100) * speed;
    lastFrame = ts;
    let target = run.now + BigInt(Math.round(dt * 1e6));
    const end = runNs();
    if (end !== null && target >= end) target = end > run.now ? end : run.now; // a shortened run never moves the clock back
    run.advanceTo(target);
    if (end !== null && run.now >= end) {
      mode = 'finished'; syncToggle(); draw(true);
      return status(`${runS} s of virtual time: ${counts.ok} accepted, ${counts.no} rejected.`);
    }
    if (ts - lastAnnounce >= 5000) { lastAnnounce = ts; status(`t=${Math.floor(sec(run.now))} s (virtual time): ${counts.ok} accepted, ${counts.no} rejected.`); }
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
    status(`Running: ${cfg.clientCount} client${cfg.clientCount > 1 ? 's' : ''}, capacity ${cfg.capacity}, refill ${cfg.refill}/s${runS ? `, ${runS} s of virtual time` : ''}.`);
  }
  function pause() { mode = 'paused'; stop(); syncToggle(); draw(true); status(`Paused at t=${sec(run.now).toFixed(1)} s (virtual time).`); }
  function newSession(msg) { stop(); mode = 'idle'; reset(); syncToggle(); draw(true); status(msg); }

  // ---------- Seed and replay (D-10; pause and speed are UI-only and never enter the event log) ----------
  function setSeed(s) {
    seed = s; el.seed.value = String(s); el.seed.removeAttribute('aria-invalid');
    newSession(`Seed ${seed}. Press Start or Replay.`);
  }
  function replay() {
    stop(); run.replay(); cfg = run.config; resetView();
    mode = reduced ? 'idle' : 'running'; lastAnnounce = performance.now(); // browser clock: status throttling only
    syncToggle(); draw(true); loop();
    status(`Replaying seed ${seed} from virtual time 0 with ${run.events.length} recorded input(s).${reduced ? ' Press Start to play it.' : ''}`);
  }

  // ---------- Controls (every change is a config event of the run) ----------
  const setPressed = (sel, btn) => mountEl.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  function syncClientRows() {
    el.rows.querySelectorAll('[data-client]').forEach((r) => { r.hidden = +r.dataset.client >= cfg.clientCount; });
  }
  on(mountEl, 'input', (e) => {
    const t = e.target;
    if (t.matches('[data-seed]')) return t.removeAttribute('aria-invalid'); // the visitor is correcting the entry
    if (t.dataset.in) configure({ [t.dataset.in]: t.valueAsNumber });
    else if (t.dataset.rate) configure({ client: +t.dataset.rate, rate: t.valueAsNumber });
    draw(true); // syncControls() writes the outputs and aria-valuetext from the run's config
  });
  on(mountEl, 'change', (e) => {
    const t = e.target;
    if (t.matches('[data-seed]')) {
      const s = parseSeed(t.value.trim());
      if (s !== null) return setSeed(s);
      t.setAttribute('aria-invalid', 'true'); t.value = String(seed); // the run is left unchanged
      return status('Seed must be a whole number from 0 to 4294967295.');
    }
    if (t.dataset.pattern) configure({ client: +t.dataset.pattern, pattern: t.value });
    else if (t.name === 'rl-keys') {
      configure({ shared: t.value === 'shared' });
      status(cfg.shared ? 'All clients now share the key global.' : 'Each client now has its own key.'); draw(true);
    }
  });
  on(mountEl, 'click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.clients) {
      configure({ clientCount: +b.dataset.clients }); // newly active clients start from now
      draw(true);
    } else if (b.dataset.run != null) {
      runS = +b.dataset.run; setPressed('[data-run]', b);
      if (mode === 'finished' && (!runS || run.now < runNs())) { mode = 'paused'; syncToggle(); }
    } else if (b.dataset.speed) {
      speed = +b.dataset.speed; setPressed('[data-speed]', b);
    } else if (b.matches('[data-toggle]')) {
      mode === 'running' ? pause() : start();
    } else if (b.matches('[data-replay]')) {
      replay();
    } else if (b.matches('[data-new-seed]')) {
      setSeed(randomSeed());
    } else if (b.matches('[data-burst]')) {
      const key = keys()[0], n = cfg.capacity + 5;
      const ok = run.apply({ kind: 'burst', key, lane: 0, n }).filter((d) => d.allowed).length;
      draw(true);
      status(`Burst of ${n} to ${key} at t=${sec(run.now).toFixed(3)} s (virtual time): ${ok} allowed, ${n - ok} denied.`);
    } else if (b.dataset.key && ALL_KEYS.includes(b.dataset.key)) {
      const d = run.apply({ kind: 'click', key: b.dataset.key, lane: cfg.shared ? 0 : keys().indexOf(b.dataset.key) })[0];
      draw(true);
      // ratelimit_c.h: a denied decision reports reset_ms 0 instead of RL_NEVER when no token will ever come.
      status(`${b.dataset.key}: ${d.allowed ? `allowed, ${String(d.remaining)} remaining` : d.reset_ms ? `denied, next token in ${String(d.reset_ms)} ms` : 'denied, never refills'}.`);
    }
  });
  // The Reset button and the window resize listener live outside mountEl; listeners.abort() removes them with the rest.
  on(root.querySelector('.demo-status .btn-ghost'), 'click', () => newSession('Reset. Press Start or click a bucket.'));
  on(window, 'resize', () => draw(true));

  try { reset(false); syncToggle(); draw(true); } catch (err) {
    teardown(true); // load() logs the error and shows the error block
    throw err;
  }
  if (reduced) status('Press Start or click a bucket.');
  else start(); // honors a host pause that arrived while the module was loading (hostPaused = paused)

  return {
    pause() { hostPaused = true; stop(); },
    resume() { hostPaused = false; loop(); },
    destroy() { teardown(false); mountEl.replaceChildren(); },
  };
}
