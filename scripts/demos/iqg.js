// Image Quality Gate demo: the real image-quality-gate pipeline, at the commit pinned in iqg-py/iqg.manifest.json, runs
// in Pyodide in a module worker (iqg-worker.js). This file only renders what Python returns.
import { nearThreshold, totalBytes } from './iqg-pyodide.js';

const MANIFEST_URL = new URL('./iqg-py/iqg.manifest.json', import.meta.url);
const SKELETON = '<div class="pd-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
// Retry is bound by the demo's own data-retry: the case study's global retry class reloads the whole write-up.
const LOAD_ERROR = '<div class="pd-error"><p>Couldn’t load this demo.</p><div><button type="button" class="project-link" data-retry>Retry</button></div></div>';
// Failures after which the runtime is still sound (RESEARCH Pattern 5); any other one stops the worker.
const RUNTIME_KEPT = new Set(['unsupported_type', 'too_large', 'too_many_pixels', 'invalid_image']);
const SAYS = { '>=': 'at least', '<=': 'at most', '>': 'more than', '<': 'less than' };
// The thresholds a visitor can edit: upstream Settings field names and their environment variable names.
const THRESHOLDS = [['blur_min', 'BLUR_MIN'], ['bright_min', 'BRIGHT_MIN'], ['bright_max', 'BRIGHT_MAX']];
const nearNote = (names) => `This result is within the measured native/Pyodide difference of a threshold (${names.join(', ')}), so the native service could decide differently.`;

export class DemoError extends Error {
  constructor(lines) { super(lines.join(' ')); this.lines = lines; }
}
const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : fmtMB(n));
const fmtMs = (ms) => (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms';
const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const middle = (s, n = 34) => (s.length > n ? `${s.slice(0, n - 13)}…${s.slice(-12)}` : s);
const says = (c) => `${SAYS[c.comparator] ?? c.comparator} ${num(c.threshold)}`;
const make = (tag, props) => Object.assign(document.createElement(tag), props);
const shown = (v, none = 'null') => (v === null || v === undefined ? none : String(v));

// A <dl> of [name, value] pairs, every value as text exactly as Python returned it.
function defList(pairs) {
  const dl = make('dl', { className: 'demo-iqg-dl' });
  for (const [k, v] of pairs) dl.append(make('dt', { textContent: k }), make('dd', { textContent: v }));
  return dl;
}

// diagnostics.laplacian_histogram drawn as returned: one bar per Python bin, never re-binned or smoothed. Bar height is
// log10(1 + count) over the largest such value; that display geometry is the only arithmetic.
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}
function histogram(h) {
  const fig = make('figure', { className: 'demo-iqg-hist' });
  if (!h) {
    fig.append(make('p', { className: 'demo-small', textContent: 'This response has no histogram (laplacian_histogram is null).' }));
    return fig;
  }
  const { bins, bin_edges: edges, counts } = h, lo = edges[0].toPrecision(4), hi = edges[edges.length - 1].toPrecision(4);
  const logs = counts.map((c) => Math.log10(1 + c)), top = Math.max(...logs) || 1;
  const chart = svgEl('svg', { viewBox: `0 0 ${counts.length} 100`, preserveAspectRatio: 'none', role: 'img',
    'aria-label': `Laplacian histogram: ${bins} equal-width bins from ${lo} to ${hi}; bar height is the count on a log scale. Each bin's count is in the Response JSON.` });
  counts.forEach((c, i) => {
    const ht = (logs[i] / top) * 100, bar = svgEl('rect', { class: 'demo-iqg-bar', x: i + 0.1, y: 100 - ht, width: 0.8, height: ht });
    bar.append(Object.assign(svgEl('title', {}), { textContent: `${edges[i]} to ${edges[i + 1]}: ${c}` }));
    chart.append(bar);
  });
  const axis = make('div', { className: 'demo-iqg-axis' });
  axis.append(make('span', { textContent: lo }), make('span', { textContent: `${bins} bins · count (log scale)` }), make('span', { textContent: hi }));
  fig.append(chart, axis, make('figcaption', { className: 'pd-caption',
    textContent: 'diagnostics.laplacian_histogram from the service’s code: equal-width bins of the signed Laplacian of the processed grayscale image. Its variance is the blur score.' }));
  return fig;
}

// Browser measurements only: Python's perf_counter_ns stages in milliseconds, the loader's stages in seconds.
const nsToMs = (ns) => `${(ns / 1e6).toFixed(3)} ms`;
const msToS = (ms) => `${(ms / 1000).toFixed(2)} s`;
const LOAD_LABELS = { runtime: 'runtime', packages: 'packages', sources: 'pipeline sources' };
const stageList = (t) => defList([...t.stages.map((s) => [s.name, nsToMs(s.duration_ns)]),
  ['stages_sum_ns', nsToMs(t.stages_sum_ns)], ['handler_total_ns', nsToMs(t.handler_total_ns)]]);
const loadList = (load) => defList(load.map(({ stage, ms }) => [LOAD_LABELS[stage] ?? stage, msToS(ms)]));

// diagnostics.settings as a table; a threshold the visitor edited comes back from Python with source init.
function settingsTable(settings) {
  const table = make('table', { className: 'demo-iqg-table' }), head = make('thead'), body = make('tbody');
  head.append(make('tr'));
  head.firstChild.append(...['Setting', 'Value', 'Source'].map((t) => make('th', { scope: 'col', textContent: t })));
  for (const [name, { value, source }] of Object.entries(settings)) {
    const src = make('td', { textContent: source });
    if (source === 'init') src.append(' ', make('span', { className: 'demo-iqg-tag', textContent: 'override' }));
    const tr = make('tr');
    tr.append(make('th', { scope: 'row', textContent: name }), make('td', { textContent: shown(value) }), src);
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

// Plain-language lines for a failure the worker reported. The status, detail and limits are the ones Python returned.
function failureLines(m, item, settings) {
  const answer = `The service would answer ${m.status} ${m.detail}.`;
  switch (m.fail) {
    case 'unsupported_type': return [`That file isn't one the service accepts as an image (type: ${item.type || 'none'}).`, answer];
    case 'too_large': return [`That file is ${fmtMB(item.size)}. The service accepts up to ${settings.max_upload_mb.value} MB (max_upload_mb in config.py).`, answer];
    case 'too_many_pixels': return [`This image has more pixels than the service allows (max_image_pixels ${settings.max_image_pixels.value} in config.py). It is rejected from its header, before any decoding.`, answer];
    case 'invalid_image': return ["Pillow couldn't open this file as an image.", answer];
    case 'memory': return ['This tab ran out of memory for this image, so the Python runtime was stopped. The next run reloads it.'];
    case 'fatal':
    default: return ['The Python runtime stopped working in this tab. The next run reloads it.'];
  }
}

// ---------- UI ----------
const TEMPLATE = `
<div class="demo-iqg">
  <div class="demo-card demo-iqg-in">
    <div class="demo-drop" data-drop>
      <div class="demo-drop-empty" data-empty-in>
        <svg class="demo-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>
        <p class="demo-drop-title" data-drop-title>Drop an image here</p>
        <p class="demo-small">or</p>
        <label class="project-link demo-file">Choose file<input type="file" accept="image/*" class="vh" data-file></label>
        <p class="demo-small">Any image file; Pillow, in Python, decides whether it can open it.</p>
      </div>
      <img class="demo-preview" data-preview alt="" decoding="async" hidden>
      <p class="demo-small" data-nopreview hidden>Your browser can't preview this file. Python still decides whether it is an image.</p>
    </div>
    <p class="demo-filerow" data-filerow hidden></p>
    <div class="demo-row" data-actions hidden>
      <button type="button" class="project-link-accent" data-analyze>Analyze image</button>
      <button type="button" class="project-link" data-another>Choose another</button>
    </div>
    <div>
      <p class="demo-label" id="iqg-samples">No image handy?</p>
      <div class="demo-chips" role="group" aria-labelledby="iqg-samples" data-chips></div>
    </div>
    <p class="demo-small">Your image stays on this device. The service's own Python code analyzes it in this tab (Pyodide); nothing is uploaded.</p>
    <p class="demo-small" data-limits hidden></p>
  </div>
  <div class="demo-card demo-iqg-out">
    <p class="demo-small" data-empty-out>Results appear here: <code>is_ok</code>, each check and both scores, exactly as the service's Python code returns them.</p>
    <div class="demo-load" data-load hidden>
      <p class="demo-small" data-load-size></p>
      <ol class="demo-stages" data-stages aria-label="Loading the Python pipeline"></ol>
    </div>
    <div data-load-error hidden></div>
    <div class="demo-error" data-error role="alert" hidden></div>
    <div class="demo-result" data-result hidden>
      <div class="demo-row"><span class="demo-badge" data-badge></span><code class="demo-mono" data-isok></code></div>
      <ul class="demo-checks" data-checks aria-label="Checks, as Python returned them"></ul>
      <p class="demo-iqg-note" data-note hidden></p>
      <div class="demo-meter">
        <p class="demo-label" id="iqg-blur-l">Blur score · variance of Laplacian</p>
        <p class="demo-big" data-blur-v></p>
        <div class="demo-track" role="meter" aria-labelledby="iqg-blur-l" aria-valuemin="0" aria-valuemax="10000" data-blur-track><span class="demo-fill" data-blur-fill></span><span class="demo-tick"></span></div>
        <div class="demo-scale" aria-hidden="true"><span style="left:0">1</span><span style="left:25%">10</span><span style="left:50%">100</span><span style="left:75%">1k</span><span style="left:100%">10k</span></div>
        <p class="pd-caption" data-blur-cap></p>
      </div>
      <div class="demo-meter">
        <p class="demo-label" id="iqg-bright-l">Brightness · mean gray</p>
        <p class="demo-big" data-bright-v></p>
        <div class="demo-scale demo-bandlabels" aria-hidden="true"><span data-bmin></span><span data-bmax></span></div>
        <div class="demo-track" role="meter" aria-labelledby="iqg-bright-l" aria-valuemin="0" aria-valuemax="255" data-bright-track><span class="demo-band"></span><span class="demo-marker" data-marker></span></div>
        <div class="demo-scale" aria-hidden="true"><span style="left:0">0</span><span style="left:50.2%">128</span><span style="left:100%">255</span></div>
      </div>
      <p class="demo-small demo-mono" data-dims></p>
      <details data-d="thresholds"><summary>Thresholds</summary>
        <div class="demo-iqg-d">
          <div class="demo-thr">${THRESHOLDS.map(([k, label]) => `
            <div class="demo-field">
              <label class="demo-label" for="iqg-t-${k}">${label}</label>
              <input class="demo-input" id="iqg-t-${k}" type="number" step="any" inputmode="decimal" aria-describedby="iqg-t-${k}-d" data-t="${k}">
              <p class="demo-small" id="iqg-t-${k}-d" data-tdef="${k}"></p>
              <p class="demo-iqg-ferr" id="iqg-t-${k}-e" data-terr="${k}" hidden></p>
            </div>`).join('')}
          </div>
          <p class="pd-caption">Changing a threshold re-runs the service’s decision code on the same scores; the image is not analyzed again. The Response JSON below still shows the analysis at the defaults.</p>
        </div>
      </details>
      <details data-d="histogram"><summary>Laplacian histogram</summary><div class="demo-iqg-d" data-hist></div></details>
      <details data-d="measurements"><summary>All measurements</summary><div class="demo-iqg-d" data-meas></div></details>
      <details data-d="image"><summary>Image</summary><div class="demo-iqg-d" data-image></div></details>
      <details data-d="timings"><summary>Timings · measured in your browser (Pyodide)</summary>
        <div class="demo-iqg-d">
          <div data-timings></div>
          <p class="pd-caption">These are the pipeline’s own StageTimer stages (<code>perf_counter_ns</code>), measured in your browser (Pyodide), not the native service. Browsers coarsen timers, so very short stages can read as zero, and the first analysis after loading includes one-time imports. <code>read_upload</code> here is copying your file into Python.</p>
          <p class="demo-label">Loading the runtime, measured in your browser</p>
          <div data-loadtimes></div>
        </div>
      </details>
      <details data-d="settings"><summary>Settings</summary>
        <div class="demo-iqg-d">
          <div class="demo-iqg-scroll" data-settings></div>
          <p class="pd-caption">No <code>.env</code> file or environment variables exist in this tab, so values are config.py’s defaults (source <code>default</code>) unless you override a threshold (source <code>init</code>). <code>derived</code> values are computed from others; <code>pillow</code> is Pillow’s own limit.</p>
        </div>
      </details>
      <details data-d="versions"><summary>Versions</summary><div class="demo-iqg-d" data-versions></div></details>
      <details data-d="json"><summary>Response JSON</summary>
        <div class="demo-iqg-d">
          <pre class="demo-code" tabindex="0" role="region" aria-label="Response JSON" data-json></pre>
          <p class="pd-caption">The <code>QualityDiagnosticsResponse</code> the service’s code built, serialized by pydantic. <code>request_id</code> is null because the service takes it from the <code>X-Request-ID</code> header of an HTTP request, and this run had none.</p>
        </div>
      </details>
    </div>
    <button type="button" class="btn-ghost" data-clear hidden>Clear</button>
  </div>
</div>`;

// mount() stays synchronous (the host expects { pause, resume, destroy } at once). Scrolling to the demo fetches only
// the manifest; the Python runtime loads on the first sample or Analyze. There is no JavaScript analysis to fall back to.
export function mount(root, { status }) {
  const mountEl = root.querySelector('.demo-mount');
  let alive = true, manifest = null, el = null, manifestGen = 0;
  // A newer sample, file or Analyze supersedes older ones (job); a newer threshold edit supersedes older ones (rev).
  const S = { item: null, response: null, job: 0, rev: 0 };
  // One worker per runtime load. destroy(), Retry and a memory or fatal failure start the next one from scratch.
  let worker = null, booted = false, runtime = null, config = null, loadTimes = [], loadGen = 0, seq = 0, readyTimer = 0;
  const jobs = new Map();
  const loading = () => runtime !== null && !booted;

  // ---------- Worker ----------
  function startWorker() {
    const wk = new Worker(new URL('./iqg-worker.js', import.meta.url), { type: 'module' });
    worker = wk; booted = false;
    // Not every engine fires `error` for a module worker that fails to load, so it must say it's ready.
    readyTimer = setTimeout(() => { if (worker === wk) stopWorker('load'); }, 4000);
    wk.onmessage = ({ data }) => {
      if (worker !== wk) return;
      if (data.ready) clearTimeout(readyTimer); else jobs.get(data.id)?.(data);
    };
    wk.onerror = (e) => { e.preventDefault(); if (worker === wk) stopWorker(booted ? 'fatal' : 'load'); };
  }
  // Terminating releases the wasm heap, which never shrinks (RESEARCH Pitfall 7). Pending callers get `fail`.
  function stopWorker(fail = 'stopped') {
    clearTimeout(readyTimer);
    worker?.terminate();
    worker = null; booted = false; runtime = null;
    const pending = [...jobs.values()];
    jobs.clear();
    for (const cb of pending) cb({ fail });
  }
  function call(msg, transfer = [], onProgress = () => {}) {
    if (!worker) return Promise.resolve({ fail: 'fatal' });
    const id = ++seq;
    return new Promise((resolve) => {
      jobs.set(id, (m) => { if (m.progress) return onProgress(m.progress); jobs.delete(id); resolve(m); });
      worker.postMessage({ id, ...msg }, transfer);
    });
  }

  // Resolves to Python's config payload. A failed load (CDN error, integrity mismatch, ready timeout) stops the worker
  // and forgets it, so the next call, Retry included, starts a fresh one (RESEARCH Pitfall 10).
  function ensureRuntime() {
    if (runtime) return runtime;
    const g = ++loadGen;
    showLoad();
    status('Loading the Python runtime and the service’s pipeline…');
    runtime = (async () => {
      startWorker();
      const m = await call({ op: 'load', manifest, manifestUrl: MANIFEST_URL.href }, [], (p) => { if (g === loadGen) stageProgress(p); });
      if (!m.done) throw new Error(`the Python runtime did not load (${m.fail})`);
      if (g === loadGen) {
        booted = true; config = m.config; loadTimes = m.load ?? [];
        setThresholds();
        stageProgress({ stage: 'ready', done: true });
        showLimits();
      }
      return m.config;
    })().catch((err) => {
      if (alive && g === loadGen) { console.error('[iqg]', err); stopWorker(); }
      throw Object.assign(new Error('runtime load failed', { cause: err }), { runtimeLoad: true });
    });
    return runtime;
  }

  // ---------- Output region ----------
  function showLoad() {
    const mb = Math.ceil(totalBytes(manifest) / 1e6);
    el.loadSize.textContent = `Loads the Python runtime and libraries (up to ${mb} MB the first time; your browser caches them).`;
    const labels = [['runtime', 'Python runtime'], ['packages', `Packages: ${manifest.packages.join(', ')}`], ['sources', 'Pipeline sources'], ['ready', 'Ready']];
    el.stages.replaceChildren(...labels.map(([stage, label]) => {
      const li = make('li');
      li.dataset.stage = stage;
      li.append(make('span', { textContent: label }), make('span', { textContent: 'waiting' }));
      return li;
    }));
    el.loadError.hidden = true; el.loadError.replaceChildren();
    el.emptyOut.hidden = true; el.load.hidden = false;
  }
  function stageProgress({ stage, done, ms }) {
    const li = el.stages.querySelector(`[data-stage="${stage}"]`);
    if (!li) return;
    li.classList.toggle('is-active', !done);
    li.classList.toggle('is-done', !!done);
    li.lastChild.textContent = !done ? 'loading…' : ms == null ? 'done' : fmtMs(ms);
  }
  function showLimits() {
    const s = config.settings, mp = s.max_image_pixels.value / 1e6;
    el.limits.textContent = `Service limits: up to ${s.max_upload_mb.value} MB, up to ${mp} megapixels (from config.py).`;
    el.limits.hidden = false;
  }
  function showLoadError() {
    el.load.hidden = true; el.emptyOut.hidden = true; el.result.hidden = true; hideError();
    el.loadError.innerHTML = LOAD_ERROR;
    el.loadError.hidden = false;
    status('Couldn’t load this demo. Press Retry to load it again.');
  }
  const showError = (lines) => {
    el.error.replaceChildren(...lines.map((t) => make('p', { textContent: t })));
    el.error.hidden = false; el.emptyOut.hidden = true;
    status(lines.join(' '));
  };
  const hideError = () => { el.error.hidden = true; el.error.replaceChildren(); };
  function resetOutput() {
    S.response = null;
    el.result.hidden = true; hideError();
    for (const p of [el.hist, el.meas, el.image, el.timings, el.loadTimes, el.settings, el.versions, el.json]) p.replaceChildren();
    el.loadError.hidden = true; el.loadError.replaceChildren();
    el.load.hidden = !loading(); el.emptyOut.hidden = loading();
  }

  // Renders a Decision Python returned (the analysis's, or reevaluate's on the same scores): nothing here scores, compares
  // or decides; display geometry is the only arithmetic. Returns the near-threshold note's text, or '' when none applies.
  function renderDecision(decision) {
    const res = S.response, check = (name) => decision.checks.find((c) => c.name === name);
    el.badge.className = `demo-badge ${decision.is_ok ? 'is-pass' : 'is-fail'}`;
    el.badge.textContent = decision.is_ok ? '✓ PASS' : '× REJECT';
    el.isok.textContent = `is_ok: ${decision.is_ok}`;
    el.checks.replaceChildren(...decision.checks.map((c) => make('li', {
      className: c.passed ? 'is-pass' : 'is-fail',
      textContent: `${c.passed ? '✓' : '×'} ${c.name} ${c.passed ? 'passed' : 'failed'}: ${c.measurement} ${num(c.value)} ${c.comparator} ${num(c.threshold)}, margin ${num(c.margin)}`,
    })));
    // Blur meter: log10 track from 1 to 10,000.
    const blur = check('blur_min'), pos = (v) => Math.min(1, Math.log10(Math.max(1, v)) / 4) * 100;
    el.blurV.textContent = res.blur_score.toFixed(2);
    el.blurTrack.style.setProperty('--p', `${pos(res.blur_score)}%`);
    el.blurTrack.style.setProperty('--t', `${pos(blur.threshold)}%`);
    el.blurFill.classList.toggle('is-bad', !blur.passed);
    el.blurTrack.setAttribute('aria-valuenow', String(Math.min(res.blur_score, 10000)));
    el.blurTrack.setAttribute('aria-valuetext', `${res.blur_score.toFixed(2)}, ${blur.passed ? 'passes' : 'fails'}: ${says(blur)} required`);
    el.blurCap.textContent = `Higher means more edge detail. The check is ${blur.measurement} ${blur.comparator} ${blur.name} (${num(blur.threshold)}).`;
    // Brightness meter: linear 0–255 with the accepted band shaded; the marker shows the two checks Python ran on it.
    const lo = check('bright_min'), hi = check('bright_max'), inBand = lo.passed && hi.passed;
    const lin = (v) => (Math.max(0, Math.min(255, v)) / 255) * 100;
    el.brightV.textContent = res.brightness.toFixed(2);
    el.brightTrack.style.setProperty('--a', `${lin(lo.threshold)}%`);
    el.brightTrack.style.setProperty('--b', `${lin(Math.max(lo.threshold, hi.threshold))}%`);
    el.brightTrack.style.setProperty('--p', `${lin(res.brightness)}%`);
    el.marker.classList.toggle('is-bad', !inBand);
    el.bmin.textContent = num(lo.threshold); el.bmin.style.left = `${lin(lo.threshold)}%`;
    el.bmax.textContent = num(hi.threshold); el.bmax.style.left = `${lin(hi.threshold)}%`;
    el.brightTrack.setAttribute('aria-valuenow', String(res.brightness));
    el.brightTrack.setAttribute('aria-valuetext', `${res.brightness.toFixed(2)}, ${inBand ? 'passes' : 'fails'}: ${says(lo)} and ${says(hi)} required`);
    // D-21: manifest.parity.tolerances (the measured parity bounds) applied to the margins Python returned.
    const near = nearThreshold(decision.checks, manifest.parity.tolerances), note = near.length ? nearNote(near) : '';
    el.note.textContent = note; el.note.hidden = !note;
    return note;
  }

  // Renders an analysis: its Decision, then every diagnostics panel exactly as Python returned it.
  function render(res, item, jsonText) {
    S.response = res;
    const d = res.diagnostics, img = d.image;
    el.emptyOut.hidden = true; el.result.hidden = false;
    setThresholds();
    const note = renderDecision(d.decision);
    el.dims.textContent = `Original ${img.original_width} × ${img.original_height}, analyzed at ${img.processed_width} × ${img.processed_height}`
      + (img.resized ? ` (resized, scale ${+img.scale.toFixed(4)}).` : ' (not resized).');
    // Diagnostics panels: every field as Python returned it (String(), never rounded).
    el.hist.replaceChildren(histogram(d.laplacian_histogram));
    el.meas.replaceChildren(defList(Object.entries(d.measurements).map(([k, v]) => [k, shown(v)])));
    el.image.replaceChildren(defList(Object.entries(img).map(([k, v]) => [k, shown(v, k === 'exif_orientation' ? 'none' : 'null')])));
    el.timings.replaceChildren(stageList(d.timings));
    el.loadTimes.replaceChildren(loadList(loadTimes));
    el.settings.replaceChildren(settingsTable(d.settings));
    el.versions.replaceChildren(defList([['pyodide', manifest.pyodide.version],
      ...Object.entries(d.versions).map(([k, v]) => [k, shown(v, 'not used')])]));
    el.json.textContent = jsonText;
    status(`${item.name}: ${res.is_ok ? 'PASS' : 'REJECT'}, blur score ${res.blur_score.toFixed(2)}, brightness ${res.brightness.toFixed(2)}.${note ? ` ${note}` : ''}`);
  }

  // ---------- Threshold editor (D-09) ----------
  // Inputs carry no min or max: upstream Settings (config.py) decides which values are valid. Edits go to Python's
  // reevaluate on the analysis's stored scores; only the fields that differ from config.py's defaults are sent.
  const inputs = () => [...el.thr.querySelectorAll('[data-t]')];
  const defaultOf = (k) => config.settings[k].value;
  function fieldError(k, text) {
    const input = el.thr.querySelector(`[data-t="${k}"]`), err = el.thr.querySelector(`[data-terr="${k}"]`);
    err.textContent = text; err.hidden = !text;
    input.setAttribute('aria-invalid', String(!!text));
    input.setAttribute('aria-describedby', text ? `${input.id}-d ${err.id}` : `${input.id}-d`);
  }
  // Back to config.py's defaults (prefilled once the runtime has loaded); any re-evaluation in flight is dropped.
  function setThresholds() {
    if (!config || !el) return;
    S.rev++;
    for (const i of inputs()) {
      const k = i.dataset.t;
      i.value = String(defaultOf(k));
      el.thr.querySelector(`[data-tdef="${k}"]`).textContent = `config.py default: ${defaultOf(k)}`;
      fieldError(k, '');
    }
  }
  const edited = () => !!config && inputs().some((i) => i.valueAsNumber !== defaultOf(i.dataset.t));

  async function onThreshold() {
    if (!S.response || !config) return;
    const overrides = {}, job = S.job, rev = ++S.rev;
    let blank = false;
    for (const i of inputs()) {
      const k = i.dataset.t, v = i.valueAsNumber;
      fieldError(k, Number.isNaN(v) ? 'Enter a number.' : '');
      if (Number.isNaN(v)) blank = true; else if (v !== defaultOf(k)) overrides[k] = v;
    }
    if (blank) return;
    if (!Object.keys(overrides).length) return showDefaults('Thresholds are config.py’s defaults again');
    const scores = { blur_score: S.response.blur_score, brightness: S.response.brightness };
    const m = await call({ op: 'reevaluate', scores, overrides });
    if (job !== S.job || rev !== S.rev || !alive || !S.response) return; // a newer edit or analysis supersedes this one
    if (m.fail === 'invalid_override') {
      for (const k of m.fields) fieldError(k, 'config.py rejects this value');
      return status(`config.py rejects ${m.fields.join(', ')}; the result still shows the last valid thresholds.`);
    }
    if (!m.done) {
      if (!RUNTIME_KEPT.has(m.fail)) stopWorker();
      return showError(failureLines(m, S.item, config.settings));
    }
    const note = renderDecision(m.decision);
    el.settings.replaceChildren(settingsTable(m.settings));
    const used = m.decision.checks.map((c) => `${c.name} ${c.threshold}`).join(', ');
    status(`Thresholds ${used}: ${m.decision.is_ok ? 'PASS' : 'REJECT'}.${note ? ` ${note}` : ''}`);
  }
  // The analysis's own Decision and settings, as Python returned them at the defaults.
  function showDefaults(lead) {
    const d = S.response.diagnostics, note = renderDecision(d.decision);
    el.settings.replaceChildren(settingsTable(d.settings));
    status(`${lead}: ${d.decision.is_ok ? 'PASS' : 'REJECT'}.${note ? ` ${note}` : ''}`);
  }

  // ---------- Input ----------
  const pressSample = (key) => el.chips.querySelectorAll('[data-sample]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sample === key)));
  const busy = (on) => { el.analyze.disabled = on; el.analyze.textContent = on ? 'Analyzing…' : 'Analyze image'; };

  function clearAll() {
    S.job++;
    if (S.item?.url) URL.revokeObjectURL(S.item.url);
    S.item = null;
    el.preview.hidden = true; el.preview.removeAttribute('src'); el.noPreview.hidden = true; el.emptyIn.hidden = false;
    el.fileRow.hidden = true; el.actions.hidden = true; el.clear.hidden = true; el.file.value = '';
    busy(false); pressSample(null); resetOutput();
  }
  function setItem(item) {
    if (S.item?.url) URL.revokeObjectURL(S.item.url);
    S.item = item;
    el.noPreview.hidden = true;
    el.preview.alt = `Preview of ${item.name}`;
    el.preview.src = item.url;
    el.preview.hidden = false; el.emptyIn.hidden = true;
    el.fileRow.textContent = [middle(item.name), item.type || 'no type', fmtBytes(item.size)].join(' · ');
    el.fileRow.hidden = false; el.actions.hidden = false; el.clear.hidden = false;
    resetOutput();
  }

  // A visitor's file is only previewed here: its type, size and pixels are Python's to judge.
  function loadFile(file) {
    if (!file) return;
    S.job++; busy(false); pressSample(null);
    setItem({ blob: file, name: file.name || 'pasted image', type: file.type, size: file.size, url: URL.createObjectURL(file) });
    status(`Loaded ${S.item.name}. Press Analyze image.`);
  }

  // A missing sample is a site problem, not an image the service would reject: report the HTTP status.
  async function loadSample(key) {
    const s = manifest.samples[key], job = ++S.job;
    busy(false); hideError(); pressSample(key);
    try {
      const r = await fetch(s.path);
      if (!r.ok) throw new DemoError([`Couldn't load the sample (HTTP ${r.status}).`]);
      const blob = await r.blob();
      if (job !== S.job || !alive) return;
      setItem({ blob, name: s.path.split('/').pop(), type: s.content_type, size: blob.size, url: URL.createObjectURL(blob) });
      runAnalyze();
    } catch (err) {
      if (job !== S.job || !alive) return;
      if (!err.lines) console.error('[iqg]', err);
      showError(err.lines || ["Couldn't load the sample. Check your connection and try again."]);
    }
  }

  async function runAnalyze() {
    const item = S.item;
    if (!item) return;
    const job = ++S.job;
    resetOutput(); busy(true);
    try {
      const cfg = await ensureRuntime();
      if (job !== S.job || !alive) return;
      status(`Analyzing ${item.name} in Python…`);
      // Like the service's read of max_upload_bytes + 1: enough to tell an over-limit file apart, never more.
      const bytes = await item.blob.slice(0, cfg.settings.max_upload_bytes.value + 1).arrayBuffer()
        .catch(() => { throw new DemoError(["Your browser couldn't read this file. Choose it again."]); });
      if (job !== S.job || !alive) return;
      const m = await call({ op: 'analyze', bytes, type: item.type }, [bytes]);
      if (job !== S.job || !alive) return; // superseded: an older analysis finishes in the worker but never renders
      if (m.done) return render(JSON.parse(m.response_json), item, m.response_json_indented);
      if (!RUNTIME_KEPT.has(m.fail)) stopWorker();
      showError(failureLines(m, item, cfg.settings));
    } catch (err) {
      if (job !== S.job || !alive) return;
      if (err.runtimeLoad) return showLoadError();
      if (!err.lines) console.error('[iqg]', err);
      showError(err.lines || ['Something went wrong while showing the result. Try again.']);
    } finally {
      if (job === S.job && alive) busy(false);
    }
  }

  function retry() {
    if (!manifest) return loadManifest();
    if (S.item) return runAnalyze();
    const job = ++S.job;
    resetOutput();
    ensureRuntime().catch(() => { if (job === S.job && alive) showLoadError(); });
  }

  // ---------- Build ----------
  const q = (s) => mountEl.querySelector(s);
  function build() {
    mountEl.innerHTML = TEMPLATE;
    el = {
      drop: q('[data-drop]'), dropTitle: q('[data-drop-title]'), emptyIn: q('[data-empty-in]'), file: q('[data-file]'), preview: q('[data-preview]'),
      noPreview: q('[data-nopreview]'), fileRow: q('[data-filerow]'), actions: q('[data-actions]'), analyze: q('[data-analyze]'), chips: q('[data-chips]'),
      limits: q('[data-limits]'), emptyOut: q('[data-empty-out]'), load: q('[data-load]'), loadSize: q('[data-load-size]'), stages: q('[data-stages]'),
      loadError: q('[data-load-error]'), error: q('[data-error]'), result: q('[data-result]'), badge: q('[data-badge]'), isok: q('[data-isok]'),
      checks: q('[data-checks]'), blurV: q('[data-blur-v]'), blurTrack: q('[data-blur-track]'), blurFill: q('[data-blur-fill]'), blurCap: q('[data-blur-cap]'),
      brightV: q('[data-bright-v]'), brightTrack: q('[data-bright-track]'), marker: q('[data-marker]'), bmin: q('[data-bmin]'), bmax: q('[data-bmax]'),
      dims: q('[data-dims]'), clear: q('[data-clear]'), note: q('[data-note]'), thr: q('[data-d="thresholds"]'),
      hist: q('[data-hist]'), meas: q('[data-meas]'), image: q('[data-image]'),
      timings: q('[data-timings]'), loadTimes: q('[data-loadtimes]'), settings: q('[data-settings]'), versions: q('[data-versions]'), json: q('[data-json]'),
    };
    el.chips.replaceChildren(...Object.entries(manifest.samples).map(([key, s]) => {
      const b = make('button', { type: 'button', className: 'demo-chip', textContent: s.label });
      b.dataset.sample = key;
      b.setAttribute('aria-pressed', 'false');
      return b;
    }));
    // Events on elements inside the demo go away with it.
    const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const setOver = (on) => { el.drop.classList.toggle('is-over', on); el.dropTitle.textContent = on ? 'Release to load' : 'Drop an image here'; };
    el.drop.addEventListener('dragenter', (e) => { if (isFileDrag(e)) { e.preventDefault(); setOver(true); } });
    el.drop.addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    el.drop.addEventListener('dragleave', (e) => { if (!el.drop.contains(e.relatedTarget)) setOver(false); });
    el.drop.addEventListener('drop', (e) => {
      e.preventDefault(); setOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) loadFile(f); else status('Drop a file to analyze it; text and links can’t be analyzed.');
    });
    el.file.addEventListener('change', () => loadFile(el.file.files[0]));
    el.preview.addEventListener('error', () => { if (S.item && el.preview.getAttribute('src')) { el.preview.hidden = true; el.noPreview.hidden = false; } });
    status('Choose an image or a sample.');
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
      if (refocus) el.chips.querySelector('button')?.focus();
    } catch (err) {
      if (!alive || g !== manifestGen) return;
      console.error('[iqg]', err);
      mountEl.innerHTML = LOAD_ERROR;
      status('Couldn’t load this demo. Press Retry to load it again.');
      if (refocus) q('[data-retry]').focus();
    }
  }

  // ---------- Listeners ----------
  const onClick = (e) => {
    const t = e.target.closest('button');
    if (!t || !alive) return;
    const kb = t.matches(':focus-visible'); // the pressed button may be hidden next; keep keyboard focus in the demo
    if (t.matches('[data-retry]')) { retry(); if (kb && el && !el.clear.hidden) el.clear.focus(); }
    else if (!el) return;
    else if (t.dataset.sample) loadSample(t.dataset.sample);
    else if (t.matches('[data-analyze]')) runAnalyze();
    else if (t.matches('[data-another]')) el.file.click();
    else if (t.matches('[data-clear]')) { clearAll(); if (kb) el.file.focus(); status('Cleared.'); }
  };
  const onPaste = (e) => {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f && el) { e.preventDefault(); loadFile(f); }
  };
  const onInput = (e) => { if (alive && el && e.target.matches('[data-t]')) onThreshold(); };
  // Reset first undoes threshold edits (back to the analysis at config.py's defaults); with none, it clears the demo.
  const resetBtn = root.querySelector('.demo-status .btn-ghost'), onReset = () => {
    if (!el) return status('Reset.');
    if (S.response && edited()) { setThresholds(); return showDefaults('Thresholds reset to config.py’s defaults'); }
    clearAll(); status('Reset.');
  };
  mountEl.addEventListener('click', onClick);
  mountEl.addEventListener('input', onInput);
  root.addEventListener('paste', onPaste);
  resetBtn?.addEventListener('click', onReset);
  loadManifest();

  return {
    pause() {},
    resume() {},
    destroy() {
      alive = false; S.job++; loadGen++; manifestGen++;
      stopWorker();
      if (S.item?.url) URL.revokeObjectURL(S.item.url);
      S.item = S.response = null;
      mountEl.removeEventListener('click', onClick);
      mountEl.removeEventListener('input', onInput);
      root.removeEventListener('paste', onPaste);
      resetBtn?.removeEventListener('click', onReset);
      mountEl.replaceChildren();
    },
  };
}
