// Image Quality Gate demo: decodes an image in the browser and runs a JavaScript port of the service's analysis
// (iqg-core.js) in a module worker. mount() builds the UI; analyze() is also used by tests/demos.html.
import { DEFAULTS, DOCKER_ENV, MAX_UPLOAD_BYTES, analyzeRGBA, decide } from './iqg-core.js';

const MAX_PIXELS = 32e6; // browser-only guard
const PRESETS = { service: DEFAULTS, docker: DOCKER_ENV };
const STAGE_NAMES = { decode: 'Decode + orient', pixels: 'Read pixels', resize: 'Resize', grayscale: 'Grayscale', laplacian: 'Laplacian', decide: 'Decide' };
const SAMPLES = {
  sharp: { label: 'Sharp', url: 'static/demo/iqg/sharp_small.jpg' },
  blurry: { label: 'Blurry', url: 'static/demo/iqg/blurry_small.jpg' },
  dark: { label: 'Dark UI', url: 'static/strivoimg1.jpg' },
  under: { label: 'Underexposed', url: 'static/demo/iqg/sharp_small.jpg', scale: 0.15 },
};

export class DemoError extends Error {
  constructor(lines) { super(lines.join(' ')); this.lines = lines; }
}
const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : fmtMB(n));
const fmtMs = (ms) => (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms';
const pyFloat = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v)); // Python float repr
const middle = (s, n = 34) => (s.length > n ? `${s.slice(0, n - 13)}…${s.slice(-12)}` : s);
const decodeError = (name = '') => new DemoError(["Your browser couldn't open this image." + (/\.hei[cf]$/i.test(name) ? ' HEIC opens only in Safari.' : ''), 'The service would answer 400 Invalid image data.']);
const pixelError = (w, h) => new DemoError([`This image is ${Math.round((w * h) / 1e6)} MP. To protect memory, the in-browser demo stops at 32 MP.`, "This is the demo's own guard; the service itself rejects images over 25 MP with 400 Invalid image data."]);

// ---------- Pipeline ----------
// Main-thread decode for the fallbacks and the darkened sample (the worker has its own copy).
async function decode(blob, name) {
  try { return await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
  catch (e) {
    if (e instanceof TypeError) { try { return await createImageBitmap(blob); } catch { /* fall through */ } }
    throw decodeError(name);
  }
}
function readPixels(bitmap) {
  const c = document.createElement('canvas');
  c.width = bitmap.width; c.height = bitmap.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}
let offscreenOK = null;
const hasOffscreen2D = () => offscreenOK ??= (() => { try { return !!new OffscreenCanvas(1, 1).getContext('2d'); } catch { return false; } })();

let worker = null, workerBroken = false, seq = 0;
const jobs = new Map();
function getWorker() {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try { worker = new Worker(new URL('./iqg-worker.js', import.meta.url), { type: 'module' }); }
  catch { workerBroken = true; return null; }
  // Not every engine fires `error` for a module worker that fails to load, so it must say it's ready.
  readyTimer = setTimeout(failWorker, 4000);
  worker.onmessage = ({ data }) => (data.ready ? clearTimeout(readyTimer) : jobs.get(data.id)?.(data));
  worker.onerror = (e) => { e.preventDefault(); failWorker(); }; // e.g. no module-worker support
  return worker;
}
let readyTimer = 0;
function failWorker() {
  clearTimeout(readyTimer);
  workerBroken = true; worker?.terminate(); worker = null;
  for (const cb of jobs.values()) cb({ workerFailed: true });
  jobs.clear();
}
export function terminateWorker() { clearTimeout(readyTimer); worker?.terminate(); worker = null; jobs.clear(); }

function viaWorker(wk, payload, transfer, thresholds, onStage) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, (m) => {
      if (m.workerFailed) return reject(Object.assign(new Error('worker failed'), { workerFailed: true }));
      if (m.stage) return onStage(m.stage, m.ms);
      jobs.delete(id);
      if (m.fail) return reject(Object.assign(new Error(m.fail), { fail: m.fail, width: m.width, height: m.height }));
      if (m.error) reject(new DemoError([`The analysis failed in this browser: ${m.error}`]));
      else resolve({ response: m.response, source: m.source, edges: m.edges, thread: 'worker' });
    });
    wk.postMessage({ id, thresholds: { ...thresholds }, ...payload }, transfer);
  });
}

// input: { blob, name } or { rgba, width, height }. Resolves to { response, source, edges, thread }.
async function decodeHere(input, onStage) {
  const t = performance.now(), bitmap = await decode(input.blob, input.name);
  onStage('decode', performance.now() - t);
  if (bitmap.width * bitmap.height > MAX_PIXELS) { bitmap.close(); throw pixelError(bitmap.width, bitmap.height); }
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

export async function analyze(input, { thresholds = DEFAULTS, onStage = () => {}, mainThread = false } = {}) {
  let bitmap = null, rgba = null, { width, height } = input;
  const wk = !mainThread && getWorker();
  if (wk) {
    try {
      // Decoding in the worker keeps large photos from blocking the page (some engines decode synchronously).
      if (input.blob && hasOffscreen2D()) return await viaWorker(wk, { blob: input.blob }, [], thresholds, onStage);
      if (input.blob) ({ bitmap, width, height } = await decodeHere(input, onStage));
      const t = performance.now();
      if (bitmap) { rgba = readPixels(bitmap); bitmap.close(); bitmap = null; onStage('pixels', performance.now() - t); }
      else rgba = input.rgba.slice();
      return await viaWorker(wk, { rgba: rgba.buffer, width, height }, [rgba.buffer], thresholds, onStage);
    } catch (e) {
      if (e.fail === 'decode') throw decodeError(input.name);
      if (e.fail === 'pixels') throw pixelError(e.width, e.height);
      if (!e.workerFailed) throw e;
    }
  }
  if (input.blob) ({ bitmap, width, height } = await decodeHere(input, onStage));
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r))); // let the UI paint first
  let t = performance.now();
  if (bitmap) { rgba = readPixels(bitmap); bitmap.close(); onStage('pixels', performance.now() - t); t = performance.now(); }
  else rgba = input.rgba;
  const r = analyzeRGBA(rgba, width, height, { thresholds, edges: true, onStage: (s) => { const now = performance.now(); onStage(s, now - t); t = now; } });
  onStage('decide', performance.now() - t);
  return { ...r, thread: 'main' };
}

// A missing sample is a site problem, not an image the service would reject: report the HTTP status.
async function fetchBlob(url) {
  const r = await fetch(url);
  if (!r.ok) throw new DemoError([`Couldn't load the sample (HTTP ${r.status}).`]);
  return r.blob();
}

// The "Underexposed" sample: the sharp sample with R, G and B scaled in a canvas (Uint8Clamped rounding).
async function darkened(url, k) {
  const bmp = await decode(await fetchBlob(url), url);
  const px = readPixels(bmp), { width, height } = bmp;
  bmp.close();
  for (let i = 0; i < px.length; i += 4) { px[i] *= k; px[i + 1] *= k; px[i + 2] *= k; }
  return { rgba: px, width, height };
}
let noisy = null;
function canvasAddsNoise() {
  if (noisy !== null) return noisy;
  const ctx = Object.assign(document.createElement('canvas'), { width: 8, height: 8 }).getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(8, 8);
  for (let i = 0; i < img.data.length; i++) img.data[i] = i % 4 === 3 ? 255 : (i * 37 + 11) & 255;
  ctx.putImageData(img, 0, 0);
  const back = ctx.getImageData(0, 0, 8, 8).data;
  return (noisy = back.some((v, i) => v !== img.data[i]));
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
        <p class="demo-small">JPEG, PNG, WebP, GIF, AVIF — anything your browser can open · up to 6 MB</p>
      </div>
      <img class="demo-preview" data-preview alt="" decoding="async" hidden>
    </div>
    <p class="demo-filerow" data-filerow hidden></p>
    <div class="demo-row" data-actions hidden>
      <button type="button" class="project-link-accent" data-analyze>Analyze image</button>
      <button type="button" class="project-link" data-another>Choose another</button>
    </div>
    <div class="demo-error" data-error role="alert" hidden></div>
    <div>
      <p class="demo-label" id="iqg-samples">No image handy?</p>
      <div class="demo-chips" role="group" aria-labelledby="iqg-samples">
        ${Object.entries(SAMPLES).map(([k, s]) => `<button type="button" class="demo-chip" data-sample="${k}" aria-pressed="false">${s.label}</button>`).join('')}
      </div>
    </div>
    <p class="demo-small">Your image stays on this device. It's decoded and analyzed by JavaScript in this tab; nothing is sent over the network.</p>
  </div>
  <div class="demo-card demo-iqg-out">
    <p class="demo-small" data-empty-out>Results appear here: <code>is_ok</code>, scores and thresholds in the same shape as the service's response.</p>
    <ol class="demo-stages" data-stages aria-label="Analysis stages, measured in your browser" hidden></ol>
    <div class="demo-result" data-result hidden>
      <div class="demo-row"><span class="demo-badge" data-badge></span><code class="demo-mono" data-isok></code></div>
      <ul class="demo-reasons" data-reasons></ul>
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
      <p class="demo-small demo-mono" data-timing></p>
      <p class="demo-small" data-noise hidden>Your browser adds privacy noise to canvas pixel reads, so these scores may differ slightly from the service.</p>
      <details data-d="edges"><summary>Edge map</summary><canvas class="demo-edges" data-edges role="img" aria-label="Edge map of the processed image"></canvas><p class="pd-caption">|Laplacian| of the processed image: bright pixels are strong edges.</p></details>
      <details data-d="json"><summary>Response JSON</summary><pre class="demo-code" data-json tabindex="0"></pre></details>
      <details data-d="thr"><summary>Thresholds</summary>
        <div class="demo-thr">
          <label class="demo-field"><span class="demo-label">Preset</span><select class="demo-input" data-preset><option value="service">config.py defaults, no .env (140/20/235)</option><option value="docker">Docker image, .env.example (70/10/235)</option><option value="custom">Custom</option></select></label>
          <label class="demo-field"><span class="demo-label">BLUR_MIN</span><input class="demo-input" type="number" min="0" step="any" inputmode="decimal" data-t="blur_min"></label>
          <label class="demo-field"><span class="demo-label">BRIGHT_MIN</span><input class="demo-input" type="number" min="0" max="255" step="1" data-t="bright_min"></label>
          <label class="demo-field"><span class="demo-label">BRIGHT_MAX</span><input class="demo-input" type="number" min="0" max="255" step="1" data-t="bright_max"></label>
        </div>
        <p class="pd-caption">Changing a threshold re-applies the decision rule to the same scores; nothing is re-analyzed.</p>
      </details>
      <button type="button" class="btn-ghost" data-clear>Clear</button>
    </div>
  </div>
</div>`;

export function mount(root, { status }) {
  const mountEl = root.querySelector('.demo-mount');
  mountEl.innerHTML = TEMPLATE;
  const q = (s) => mountEl.querySelector(s);
  const el = {
    drop: q('[data-drop]'), dropTitle: q('[data-drop-title]'), emptyIn: q('[data-empty-in]'), file: q('[data-file]'), preview: q('[data-preview]'),
    fileRow: q('[data-filerow]'), actions: q('[data-actions]'), analyze: q('[data-analyze]'), error: q('[data-error]'),
    emptyOut: q('[data-empty-out]'), stages: q('[data-stages]'), result: q('[data-result]'), badge: q('[data-badge]'), isok: q('[data-isok]'),
    reasons: q('[data-reasons]'), blurV: q('[data-blur-v]'), blurTrack: q('[data-blur-track]'), blurFill: q('[data-blur-fill]'), blurCap: q('[data-blur-cap]'),
    brightV: q('[data-bright-v]'), brightTrack: q('[data-bright-track]'), marker: q('[data-marker]'), bmin: q('[data-bmin]'), bmax: q('[data-bmax]'),
    timing: q('[data-timing]'), noise: q('[data-noise]'), edges: q('[data-edges]'), edgesD: q('[data-d="edges"]'), json: q('[data-json]'), preset: q('[data-preset]'),
  };
  const S = { item: null, result: null, job: 0, thr: { ...DEFAULTS }, timings: [] }; // a newer job supersedes older ones
  const css = getComputedStyle(root), rgb = (v) => { const h = css.getPropertyValue(v).trim().slice(1); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const BG = rgb('--bg'), FG = rgb('--text');

  const showError = (lines) => {
    el.error.replaceChildren(...lines.map((t) => Object.assign(document.createElement('p'), { textContent: t })));
    el.error.hidden = false;
    status(lines.join(' '));
  };
  const hideError = () => { el.error.hidden = true; el.error.replaceChildren(); };
  const pressSample = (key) => mountEl.querySelectorAll('[data-sample]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sample === key)));

  function resetOutput() {
    S.result = null; S.timings = [];
    el.result.hidden = true; el.stages.hidden = true; el.stages.replaceChildren(); el.emptyOut.hidden = false;
    el.edges.width = el.edges.height = 0;
  }
  function clearAll() {
    S.job++;
    if (S.item?.url) URL.revokeObjectURL(S.item.url);
    S.item = null;
    el.preview.hidden = true; el.preview.removeAttribute('src'); el.emptyIn.hidden = false;
    el.fileRow.hidden = true; el.actions.hidden = true; el.file.value = '';
    el.analyze.disabled = false; el.analyze.textContent = 'Analyze image';
    hideError(); pressSample(null); resetOutput();
  }

  function setItem(item) {
    if (S.item?.url) URL.revokeObjectURL(S.item.url);
    S.item = item;
    el.preview.src = item.url || item.src;
    el.preview.alt = `Preview of ${item.name}`;
    el.preview.hidden = false; el.emptyIn.hidden = true;
    el.actions.hidden = false;
    resetOutput();
  }
  function fileRow() {
    const it = S.item, r = S.result;
    const parts = [middle(it.name), it.type || 'unknown type', it.size != null ? fmtBytes(it.size) : 'generated in a canvas'];
    if (it.width) parts.push(`${it.width} × ${it.height}`);
    if (r?.source.resized) parts.push(`analyzed at ${r.response.width} × ${r.response.height} (Lanczos)`);
    el.fileRow.textContent = parts.join(' · ');
    el.fileRow.hidden = false;
  }

  // User files: validated like the API, previewed, then analyzed on request.
  function loadFile(file) {
    if (!file) return;
    hideError(); pressSample(null);
    if (!file.type.startsWith('image/')) return showError([`That file isn't an image (${file.type || 'unknown type'}).`, 'The service would answer 415 Unsupported media type.']);
    if (file.size > MAX_UPLOAD_BYTES) return showError([`That file is ${fmtMB(file.size)}. The service accepts up to 6 MB.`, 'The service would answer 413 File too large.']);
    const item = { blob: file, name: file.name || 'pasted image', type: file.type, size: file.size, url: URL.createObjectURL(file) };
    const probe = Object.assign(new Image(), { decoding: 'async' });
    probe.onload = () => {
      if (S.item !== item) return;
      item.width = probe.naturalWidth; item.height = probe.naturalHeight;
      if (item.width * item.height > MAX_PIXELS) { clearAll(); return showError(pixelError(item.width, item.height).lines); }
      fileRow();
      status(`Loaded ${item.name}. Press Analyze image.`);
    };
    probe.onerror = () => { if (S.item !== item) return; clearAll(); showError(decodeError(item.name).lines); };
    setItem(item);
    probe.src = item.url;
    el.fileRow.hidden = true;
  }

  async function loadSample(key) {
    const s = SAMPLES[key], job = ++S.job;
    hideError();
    try {
      let item;
      if (s.scale) {
        const px = await darkened(s.url, s.scale);
        const c = Object.assign(document.createElement('canvas'), { width: px.width, height: px.height });
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.rgba), px.width, px.height), 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        item = { ...px, name: `${s.url.split('/').pop()} × ${s.scale}`, type: 'RGBA pixels', size: null, url: URL.createObjectURL(blob), under: true };
      } else {
        const blob = await fetchBlob(s.url);
        item = { blob, name: s.url.split('/').pop(), type: blob.type, size: blob.size, url: URL.createObjectURL(blob) };
      }
      if (job !== S.job) return URL.revokeObjectURL(item.url);
      setItem(item); pressSample(key);
      runAnalyze();
    } catch (err) {
      if (job === S.job) showError(err.lines || [`Couldn't load the sample: ${err.message}`]);
    }
  }

  async function runAnalyze() {
    if (!S.item) return;
    const job = ++S.job, item = S.item;
    hideError(); resetOutput();
    el.analyze.disabled = true; el.analyze.textContent = 'Analyzing…';
    el.emptyOut.hidden = true; el.stages.hidden = false;
    const onStage = (name, ms) => {
      if (job !== S.job) return;
      if (S.timings.some(([n]) => n === name)) { S.timings = []; el.stages.replaceChildren(); } // restarted on the fallback path
      S.timings.push([name, ms]);
      const li = document.createElement('li');
      li.append(Object.assign(document.createElement('span'), { textContent: STAGE_NAMES[name] }), Object.assign(document.createElement('span'), { textContent: fmtMs(ms) }));
      el.stages.append(li);
    };
    try {
      const r = await analyze(item.blob ? { blob: item.blob, name: item.name } : item, { thresholds: S.thr, onStage });
      if (job !== S.job) return;
      item.width = r.source.width; item.height = r.source.height;
      S.result = r;
      el.stages.hidden = true;
      fileRow();
      renderResult(true);
      if (el.edgesD.open) drawEdges();
    } catch (err) {
      if (job !== S.job) return;
      resetOutput();
      showError(err.lines || [`The analysis failed: ${err.message}`]);
    } finally {
      if (job === S.job) { el.analyze.disabled = false; el.analyze.textContent = 'Analyze image'; }
    }
  }

  function renderResult(announce = false) {
    const r = S.result;
    if (!r) return;
    const { blur_score: blur, brightness: bright } = r.response, t = S.thr, ok = decide(blur, bright, t);
    el.emptyOut.hidden = true; el.result.hidden = false;
    el.badge.className = `demo-badge ${ok ? 'is-pass' : 'is-fail'}`;
    el.badge.textContent = ok ? '✓ PASS' : '× REJECT';
    el.isok.textContent = `is_ok: ${ok}`;
    const reasons = [];
    if (blur < t.blur_min) reasons.push(`Blur score ${blur.toFixed(2)} is below BLUR_MIN ${t.blur_min}.`);
    if (bright < t.bright_min) reasons.push(`Brightness ${bright.toFixed(2)} is below BRIGHT_MIN ${t.bright_min}.`);
    if (bright > t.bright_max) reasons.push(`Brightness ${bright.toFixed(2)} is above BRIGHT_MAX ${t.bright_max}.`);
    if (S.item?.under && blur < t.blur_min) reasons.push('Darkening also lowers edge contrast, so the blur score falls with the brightness.');
    if (!reasons.length) reasons.push(`Blur score is at least ${t.blur_min} and brightness is within ${t.bright_min}–${t.bright_max}.`);
    el.reasons.replaceChildren(...reasons.map((s) => Object.assign(document.createElement('li'), { textContent: s })));
    // Blur meter: log10 track from 1 to 10,000.
    const pos = (v) => Math.min(1, Math.log10(Math.max(1, v)) / 4) * 100;
    const blurOk = blur >= t.blur_min;
    el.blurV.textContent = blur.toFixed(2);
    el.blurTrack.style.setProperty('--p', `${pos(blur)}%`);
    el.blurTrack.style.setProperty('--t', `${pos(t.blur_min)}%`);
    el.blurFill.classList.toggle('is-bad', !blurOk);
    el.blurTrack.setAttribute('aria-valuenow', String(Math.min(blur, 10000)));
    el.blurTrack.setAttribute('aria-valuetext', `${blur.toFixed(2)}, ${blurOk ? 'passes' : 'fails'}: at least ${t.blur_min} required`);
    el.blurCap.textContent = `Higher means more edge detail. Below ${t.blur_min} the service calls it blurry.`;
    // Brightness meter: linear 0–255 with the accepted band shaded.
    const brightOk = bright >= t.bright_min && bright <= t.bright_max, lin = (v) => (Math.max(0, Math.min(255, v)) / 255) * 100;
    el.brightV.textContent = bright.toFixed(2);
    el.brightTrack.style.setProperty('--a', `${lin(t.bright_min)}%`);
    el.brightTrack.style.setProperty('--b', `${lin(Math.max(t.bright_min, t.bright_max))}%`);
    el.brightTrack.style.setProperty('--p', `${lin(bright)}%`);
    el.marker.classList.toggle('is-bad', !brightOk);
    el.bmin.textContent = t.bright_min; el.bmin.style.left = `${lin(t.bright_min)}%`;
    el.bmax.textContent = t.bright_max; el.bmax.style.left = `${lin(t.bright_max)}%`;
    el.brightTrack.setAttribute('aria-valuenow', String(bright));
    el.brightTrack.setAttribute('aria-valuetext', `${bright.toFixed(2)}, ${brightOk ? 'passes' : 'fails'}: between ${t.bright_min} and ${t.bright_max} required`);
    const total = S.timings.reduce((s, [, ms]) => s + ms, 0), src = r.source;
    el.timing.textContent = `${S.timings.map(([n, ms]) => `${STAGE_NAMES[n]} ${fmtMs(ms)}`).join(' · ')} · total ${fmtMs(total)}, measured in your browser${r.thread === 'main' ? ' (main thread)' : ''}. Processed size ${r.response.width} × ${r.response.height}${src.resized ? ` (from ${src.width} × ${src.height})` : ' (not resized)'}.`;
    el.noise.hidden = !canvasAddsNoise();
    el.json.textContent = `{\n  "blur_score": ${pyFloat(blur)},\n  "brightness": ${pyFloat(bright)},\n  "width": ${r.response.width},\n  "height": ${r.response.height},\n  "is_ok": ${ok},\n  "thresholds": {\n    "blur_min": ${pyFloat(t.blur_min)},\n    "bright_min": ${t.bright_min},\n    "bright_max": ${t.bright_max}\n  }\n}`;
    if (announce) status(`${S.item?.name}: ${ok ? 'PASS' : 'REJECT'}, blur score ${blur.toFixed(2)}, brightness ${bright.toFixed(2)}.`);
  }

  function drawEdges() {
    const r = S.result;
    if (!r?.edges || el.edges.width === r.response.width) return;
    const { width: w, height: h } = r.response, ctx = (el.edges.width = w, el.edges.height = h, el.edges.getContext('2d'));
    const img = ctx.createImageData(w, h), d = img.data, e = r.edges;
    for (let i = 0, p = 0; i < e.length; i++, p += 4) {
      const k = e[i] / 255;
      d[p] = BG[0] + (FG[0] - BG[0]) * k; d[p + 1] = BG[1] + (FG[1] - BG[1]) * k; d[p + 2] = BG[2] + (FG[2] - BG[2]) * k; d[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function syncThresholdInputs() {
    mountEl.querySelectorAll('[data-t]').forEach((i) => { i.value = S.thr[i.dataset.t]; });
  }
  function onThresholdInput() {
    const v = Object.fromEntries([...mountEl.querySelectorAll('[data-t]')].map((i) => [i.dataset.t, i.valueAsNumber]));
    if (!(v.blur_min >= 0) || !Number.isInteger(v.bright_min) || !Number.isInteger(v.bright_max) || v.bright_min < 0 || v.bright_max > 255) return;
    S.thr = v;
    const match = Object.entries(PRESETS).find(([, p]) => p.blur_min === v.blur_min && p.bright_min === v.bright_min && p.bright_max === v.bright_max);
    el.preset.value = match ? match[0] : 'custom';
    renderResult();
    if (S.result) status(`Thresholds ${v.blur_min} / ${v.bright_min}–${v.bright_max}: ${decide(S.result.response.blur_score, S.result.response.brightness, v) ? 'PASS' : 'REJECT'}.`);
  }
  syncThresholdInputs();

  // ---------- Events (all on elements inside the demo, so they go away with it) ----------
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const setOver = (on) => { el.drop.classList.toggle('is-over', on); el.dropTitle.textContent = on ? 'Release to load' : 'Drop an image here'; };
  el.drop.addEventListener('dragenter', (e) => { if (isFileDrag(e)) { e.preventDefault(); setOver(true); } });
  el.drop.addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  el.drop.addEventListener('dragleave', (e) => { if (!el.drop.contains(e.relatedTarget)) setOver(false); });
  el.drop.addEventListener('drop', (e) => {
    e.preventDefault(); setOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) { el.emptyIn.hidden = true; loadFile(f); } else status('Only image files can be analyzed, not text or links.');
  });
  el.file.addEventListener('change', () => loadFile(el.file.files[0]));
  const onPaste = (e) => {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) { e.preventDefault(); loadFile(f); }
  };
  root.addEventListener('paste', onPaste);
  mountEl.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.sample) loadSample(t.dataset.sample);
    else if (t.matches('[data-analyze]')) runAnalyze();
    else if (t.matches('[data-another]')) el.file.click();
    else if (t.matches('[data-clear]')) { clearAll(); status('Cleared.'); }
  });
  el.edgesD.addEventListener('toggle', () => { if (el.edgesD.open) drawEdges(); });
  el.preset.addEventListener('change', () => {
    if (el.preset.value !== 'custom') { S.thr = { ...PRESETS[el.preset.value] }; syncThresholdInputs(); renderResult(); }
    if (S.result) status(`Thresholds: ${el.preset.selectedOptions[0].textContent}.`);
  });
  mountEl.querySelectorAll('[data-t]').forEach((i) => i.addEventListener('input', onThresholdInput));
  const resetBtn = root.querySelector('.demo-status .btn-ghost'), onReset = () => {
    clearAll(); S.thr = { ...DEFAULTS }; el.preset.value = 'service'; syncThresholdInputs();
    mountEl.querySelectorAll('details').forEach((d) => { d.open = false; });
    status('Reset.');
  };
  resetBtn.addEventListener('click', onReset);
  status('Choose an image or a sample.');

  return {
    pause() {},
    resume() {},
    destroy() {
      S.job++;
      if (S.item?.url) URL.revokeObjectURL(S.item.url);
      S.item = S.result = null;
      resetBtn.removeEventListener('click', onReset);
      root.removeEventListener('paste', onPaste);
      terminateWorker();
      mountEl.replaceChildren();
    },
  };
}
