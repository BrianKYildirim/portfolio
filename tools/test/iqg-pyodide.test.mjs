// Node leg of the IQG Pyodide loader (D-01, D-20): the runtime comes from CDN bytes verified against
// scripts/demos/iqg-py/iqg.manifest.json, and the vendored upstream code runs on the demo's sample images.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IqgLoadError, loadIqg, nearThreshold } from '../../scripts/demos/iqg-pyodide.js';
import { createWorkerHandler } from '../../scripts/demos/iqg-worker.js';
import { defaultCacheDir, ensurePyodideCache, loadIqgNode } from '../pyodide-cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const PY_DIR = path.join(ROOT, 'scripts', 'demos', 'iqg-py');
const manifest = JSON.parse(readFileSync(path.join(PY_DIR, 'iqg.manifest.json'), 'utf8'));
const SAMPLES = path.join(ROOT, 'static', 'demo', 'iqg');
const PARITY = path.join(ROOT, 'tools', 'test', 'fixtures', 'iqg-parity');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const byteSorted = (keys) => [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

// Every file under dir as a '/'-separated path relative to it.
function walk(dir, rel = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

const vendored = () => ({ ...manifest.wheels, ...manifest.sources.files });

const iqg = await loadIqgNode(manifest, { root: ROOT });

test('the vendored files are exactly the manifest\'s sources and wheels, listed in byte order', () => {
  assert.equal(manifest.schema, 'pyodide-manifest/1');
  assert.equal(manifest.sources.dir, 'scripts/demos/iqg-py');
  assert.match(manifest.sha, /^[0-9a-f]{40}$/);
  for (const files of [manifest.sources.files, manifest.wheels, manifest.pyodide.files]) {
    const keys = Object.keys(files);
    assert.deepEqual(keys, byteSorted(keys), 'manifest entries are sorted');
  }
  const onDisk = walk(PY_DIR).filter((f) => f !== 'iqg.manifest.json');
  assert.deepEqual(byteSorted(onDisk), byteSorted(Object.keys(vendored())), 'files on disk equal the files listed');
});

test('every vendored file matches its bytes and sha256, with LF endings and no BOM', () => {
  for (const [rel, entry] of Object.entries(vendored())) {
    const b = readFileSync(path.join(PY_DIR, ...rel.split('/')));
    assert.equal(b.length, entry.bytes, `${rel}: bytes`);
    assert.equal(sha256(b), entry.sha256, `${rel}: sha256`);
    if (rel.endsWith('.py')) {
      assert.equal(b.indexOf(0x0d), -1, `${rel}: carriage return`);
      assert.ok(!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), `${rel}: UTF-8 BOM`);
    }
  }
});

for (const [sample, ok] of [['sharp_small.jpg', true], ['blurry_small.jpg', false]]) {
  test(`upstream preprocess and quality in Pyodide: ${sample} ${ok ? 'passes' : 'fails'}`, () => {
    const preprocess = iqg.pyimport('app.services.preprocess'), quality = iqg.pyimport('app.services.quality');
    const bytes = iqg.pyodide.toPy(new Uint8Array(readFileSync(path.join(SAMPLES, sample))));
    const loaded = preprocess.load_and_normalize(bytes, 1600);
    const bgr = loaded.get(0), gray = preprocess.to_gray(bgr);
    const thr = quality.Thresholds(140.0, 20, 235);
    const out = quality.assess(gray, thr);
    const r = out.toJs({ dict_converter: Object.fromEntries });
    for (const p of [out, thr, gray, bgr, loaded, bytes, quality, preprocess]) p.destroy();
    assert.equal(r.is_ok, ok);
    assert.ok(Number.isFinite(r.blur_score), 'blur_score is finite');
    assert.ok(Number.isFinite(r.brightness), 'brightness is finite');
  });
}

test('the cache fails closed: a failed download or a different hash throws, naming the file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iqg-cache-test-'));
  try {
    const good = new TextEncoder().encode('verified bytes');
    const fake = { pyodide: { cdn_base: 'https://cdn.invalid/', files: { 'x.bin': { bytes: good.length, sha256: sha256(good) } } } };
    const reply = (status, body) => async () => ({ ok: status === 200, status, arrayBuffer: async () => body.buffer });
    await assert.rejects(ensurePyodideCache(fake, { dir, fetchImpl: reply(404, good) }), /x\.bin: download failed \(HTTP 404\)/);
    await assert.rejects(ensurePyodideCache(fake, { dir, fetchImpl: async () => { throw new Error('offline'); } }),
      /x\.bin: download failed \(offline\)/);
    await assert.rejects(ensurePyodideCache(fake, { dir, fetchImpl: reply(200, new TextEncoder().encode('tampered bytes')) }),
      /x\.bin: bytes or sha256 differ/);
    assert.deepEqual(readdirSync(dir), [], 'nothing unverified is left in the cache');
    assert.equal(await ensurePyodideCache(fake, { dir, fetchImpl: reply(200, good) }), dir);
    let calls = 0;
    await ensurePyodideCache(fake, { dir, fetchImpl: async () => { calls++; throw new Error('unused'); } });
    assert.equal(calls, 0, 'a verified cached file is not downloaded again');
    writeFileSync(path.join(dir, 'x.bin'), 'verified bytez');
    await ensurePyodideCache(fake, { dir, fetchImpl: reply(200, good) });
    assert.equal(readFileSync(path.join(dir, 'x.bin'), 'utf8'), 'verified bytes', 'a corrupted cache file is replaced');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the loader rejects a lock file whose bytes differ from the manifest, before importing Pyodide', async () => {
  const lock = new TextEncoder().encode('{"tampered": true}');
  let imported = false;
  const err = await loadIqg({ manifest, pyodideUrl: 'data:text/javascript,globalThis.x=1', indexURL: '/',
    readCdn: async () => lock, readVendored: async () => { imported = true; return lock; } }).catch((e) => e);
  assert.ok(err instanceof IqgLoadError, String(err));
  assert.equal(err.kind, 'integrity');
  assert.equal(err.what, 'pyodide-lock.json');
  assert.equal(imported, false);
});

test('load timings list the runtime, packages and sources stages in order', () => {
  assert.deepEqual(iqg.loadTimings.map((t) => t.stage), ['runtime', 'packages', 'sources']);
  for (const t of iqg.loadTimings) assert.ok(Number.isFinite(t.ms) && t.ms >= 0, `${t.stage}: ms`);
});

// ---------- Settings and versions (D-07: the demo runs the real upstream Settings) ----------

test('the verified lock lists every manifest wheel with its sha256, and the packages\' closure is exactly those wheels', () => {
  const lock = JSON.parse(readFileSync(path.join(defaultCacheDir(manifest), 'pyodide-lock.json'), 'utf8'));
  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
  const seen = new Set(), todo = manifest.packages.map(norm);
  while (todo.length) {
    const n = todo.pop();
    if (seen.has(n)) continue;
    assert.ok(lock.packages[n], `${n}: in the lock`);
    seen.add(n);
    todo.push(...lock.packages[n].depends.map(norm));
  }
  const closure = [...seen].map((n) => lock.packages[n]);
  const wheels = Object.keys(manifest.pyodide.files).filter((f) => f.endsWith('.whl'));
  assert.deepEqual(byteSorted(closure.map((p) => p.file_name)), byteSorted(wheels));
  for (const p of closure) assert.equal(p.sha256, manifest.pyodide.files[p.file_name].sha256, `${p.file_name}: sha256`);
});

test('every vendored wheel\'s sha256 equals its PyPI digest', () => {
  assert.deepEqual(Object.keys(manifest.wheels), ['wheels/pydantic_settings-2.16.2-py3-none-any.whl',
    'wheels/python_dotenv-1.2.4-py3-none-any.whl']);
  for (const [rel, w] of Object.entries(manifest.wheels)) {
    assert.match(w.pypi_sha256, /^[0-9a-f]{64}$/, `${rel}: pypi_sha256`);
    assert.equal(w.sha256, w.pypi_sha256, `${rel}: sha256`);
    assert.ok(w.url.startsWith('https://files.pythonhosted.org/') && w.url.endsWith(rel.slice('wheels/'.length)), `${rel}: url`);
  }
});

const CONFIGURED = ['blur_min', 'bright_min', 'bright_max', 'resize_max_dim', 'max_upload_mb', 'max_image_pixels'];

test('upstream Settings in Pyodide reports default and init sources and rejects an invalid value', () => {
  const config = iqg.pyimport('app.core.config'), Settings = config.Settings;
  const s = Settings(), edited = Settings.callKwargs({ blur_min: 70 });
  try {
    for (const name of CONFIGURED) assert.equal(s.source_of(name), 'default', `${name}: source`);
    assert.equal(edited.source_of('blur_min'), 'init');
    assert.equal(edited.blur_min, 70);
    assert.equal(edited.source_of('bright_min'), 'default');
    const err = (() => { try { Settings.callKwargs({ blur_min: -1 }).destroy(); } catch (e) { return e; } })();
    assert.ok(err, 'blur_min=-1 raises');
    assert.equal(err.type, 'ValidationError');
  } finally {
    for (const p of [edited, s, Settings, config]) p.destroy();
  }
});

test('upstream diagnostics.config in Pyodide reports the rule, setting sources and the manifest\'s library versions', () => {
  const Settings = iqg.pyimport('app.core.config').Settings, diagnostics = iqg.pyimport('app.services.diagnostics');
  const s = Settings(), out = diagnostics.config(s);
  const c = JSON.parse(out.model_dump_json());
  for (const p of [out, s, diagnostics, Settings]) p.destroy();
  assert.equal(c.schema_version, 1);
  assert.equal(typeof c.decision_rule, 'string');
  assert.match(c.decision_rule, /blur_score >= blur_min/);
  assert.equal(c.settings.max_upload_bytes.source, 'derived');
  assert.equal(c.settings.pillow_max_image_pixels.source, 'pillow');
  for (const name of CONFIGURED) assert.equal(c.settings[name].source, 'default', `${name}: source`);
  const libs = manifest.pyodide.libraries;
  for (const k of ['python', 'numpy', 'opencv', 'pillow', 'libjpeg', 'libjpeg_turbo']) {
    assert.ok(k in libs, `${k}: recorded in the manifest`);
    assert.equal(c.versions[k], libs[k], `${k}: version`);
  }
  const pydantic = iqg.pyimport('pydantic');
  try { assert.equal(pydantic.VERSION, libs.pydantic); } finally { pydantic.destroy(); }
});

// ---------- Session on the pinned code (IQG-04, IQG-09, IQG-10): what the demo's worker calls ----------

const parityCases = JSON.parse(readFileSync(path.join(PARITY, 'cases.json'), 'utf8'));
const parityCase = (name) => parityCases.cases.find((c) => c.name === name);
const parityGolden = (name) => JSON.parse(readFileSync(path.join(PARITY, 'golden', `${name}.json`), 'utf8'));
const analyzeCase = (name) => {
  const c = parityCase(name);
  assert.ok(c, `${name}: a parity case`);
  const bytes = new Uint8Array(readFileSync(path.join(PARITY, ...c.file.split('/'))));
  return iqg.analyze(bytes, c.content_type, { overrides: c.settings, bins: parityCases.bins });
};

for (const [name, fail, status, detail, cause] of [
  ['not_image', 'unsupported_type', 415, 'Unsupported media type', null],
  ['no_content_type', 'unsupported_type', 415, 'Unsupported media type', null],
  ['too_large', 'too_large', 413, 'File too large', null],
  ['overlimit_header', 'too_many_pixels', 400, 'Invalid image data', 'ImageTooLarge'],
  ['truncated', 'invalid_image', 400, 'Invalid image data', 'OSError'],
  ['empty', 'invalid_image', 400, 'Invalid image data', 'UnidentifiedImageError'],
]) {
  test(`session.analyze on ${name} gives fail ${fail} with the status and detail Python returned`, () => {
    const o = analyzeCase(name);
    assert.deepEqual(o, { fail, status, detail, cause });
    assert.deepEqual({ status: o.status, detail: o.detail, cause: o.cause }, parityGolden(name).error, 'equals the native golden');
  });
}

test('session.reevaluate runs upstream Settings and the Decision on blurry_small\'s scores', () => {
  const r = analyzeCase('blurry_small');
  assert.equal(r.status, 200);
  const scores = { blur_score: r.response.blur_score, brightness: r.response.brightness };
  const edited = iqg.reevaluate(scores, { blur_min: 70 });
  assert.equal(edited.settings.blur_min.source, 'init');
  assert.equal(edited.settings.blur_min.value, 70);
  assert.equal(edited.settings.bright_min.source, 'default');
  assert.deepEqual(edited.decision.checks.map((c) => [c.name, c.comparator]), [['blur_min', '>='], ['bright_min', '>='], ['bright_max', '<=']]);
  // The same edit as the blurry_small_overrides case gives native's Decision and settings for it exactly.
  const g = parityGolden('blurry_small_overrides');
  const same = iqg.reevaluate(scores, parityCase('blurry_small_overrides').settings);
  assert.deepEqual(same.decision, g.diagnostics.decision);
  assert.deepEqual(same.settings, g.diagnostics.settings);
  assert.deepEqual(iqg.reevaluate(scores, { blur_min: -1 }), { invalid: ['blur_min'] });
  const at = iqg.reevaluate(scores, { blur_min: scores.blur_score });
  const blur = at.decision.checks.find((c) => c.name === 'blur_min');
  assert.equal(blur.threshold, scores.blur_score);
  assert.equal(blur.margin, 0);
  assert.equal(blur.passed, true, 'a blur threshold exactly at blur_score passes (>=)');
});

test('nearThreshold flags near_threshold\'s blur check from the manifest tolerances, and nothing on sharp_small', () => {
  const near = analyzeCase('near_threshold'), sharp = analyzeCase('sharp_small');
  assert.equal(near.status, 200);
  assert.equal(sharp.status, 200);
  assert.ok(nearThreshold(near.response.diagnostics.decision.checks, manifest.parity.tolerances).includes('blur_min'));
  assert.deepEqual(nearThreshold(sharp.response.diagnostics.decision.checks, manifest.parity.tolerances), []);
});

// ---------- Worker protocol (iqg-worker.js createWorkerHandler, the demo's message contract) ----------

// A handler over the already-loaded session: load replays the loader's real progress order, then hands it over.
function workerOver(session, { load } = {}) {
  const posted = [];
  const handle = createWorkerHandler({
    load: load ?? (async (m, url, onProgress) => {
      for (const { stage, ms } of session.loadTimings) { onProgress({ stage, done: false }); onProgress({ stage, done: true, ms }); }
      return session;
    }),
    post: (m) => posted.push(m),
  });
  return { posted, handle, last: () => posted.at(-1) };
}
const sampleBytes = (name) => {
  const b = readFileSync(path.join(SAMPLES, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

test('worker load posts progress for each stage, then done with Python\'s config and the load timings', async () => {
  const w = workerOver(iqg);
  await w.handle({ id: 1, op: 'load', manifest, manifestUrl: 'https://example.invalid/iqg.manifest.json' });
  const progress = w.posted.filter((m) => m.progress);
  assert.ok(progress.length > 0, 'progress was posted');
  assert.ok(progress.every((m) => m.id === 1));
  assert.deepEqual(progress.filter((m) => m.progress.done).map((m) => m.progress.stage), ['runtime', 'packages', 'sources']);
  const done = w.last();
  assert.equal(done.id, 1);
  assert.equal(done.done, true);
  assert.deepEqual(done.config, iqg.config(), 'the config payload is diagnostics.config from Python');
  assert.ok(Number.isInteger(done.config.settings.max_upload_bytes.value) && done.config.settings.max_upload_bytes.value > 0);
  assert.equal(done.config.settings.max_upload_bytes.source, 'derived');
  assert.deepEqual(done.load, iqg.loadTimings);
});

test('worker analyze of sharp_small posts done with status 200 and Python\'s response_json', async () => {
  const w = workerOver(iqg);
  await w.handle({ id: 1, op: 'load', manifest, manifestUrl: 'x' });
  await w.handle({ id: 2, op: 'analyze', bytes: sampleBytes('sharp_small.jpg'), type: 'image/jpeg' });
  const m = w.last();
  assert.equal(m.id, 2);
  assert.equal(m.done, true);
  assert.equal(m.status, 200);
  const res = JSON.parse(m.response_json);
  assert.equal(res.is_ok, true);
  assert.equal(res.diagnostics.laplacian_histogram.counts.length, manifest.parity.bins, 'histogram uses the manifest bins');
  assert.deepEqual(res.diagnostics.decision.checks.map((c) => c.name), ['blur_min', 'bright_min', 'bright_max']);
});

test('session.analyze of sharp_small returns pydantic\'s indent-2 serialization of the same response', () => {
  const r = iqg.analyze(new Uint8Array(readFileSync(path.join(SAMPLES, 'sharp_small.jpg'))), 'image/jpeg', { bins: manifest.parity.bins });
  assert.equal(r.status, 200);
  assert.equal(typeof r.response_json_indented, 'string');
  assert.deepEqual(JSON.parse(r.response_json_indented), JSON.parse(r.response_json), 'the same QualityDiagnosticsResponse');
  assert.ok(r.response_json_indented.startsWith('{\n  "blur_score"'), 'pydantic model_dump_json(indent=2)');
});

test('worker analyze reply carries response_json_indented', async () => {
  const w = workerOver(iqg);
  await w.handle({ id: 1, op: 'load', manifest, manifestUrl: 'x' });
  await w.handle({ id: 2, op: 'analyze', bytes: sampleBytes('sharp_small.jpg'), type: 'image/jpeg' });
  const m = w.last();
  assert.equal(m.done, true);
  assert.equal(typeof m.response_json_indented, 'string');
  assert.deepEqual(JSON.parse(m.response_json_indented), JSON.parse(m.response_json));
});

test('worker analyze with type text/plain posts fail unsupported_type with the 415 Python returned', async () => {
  const w = workerOver(iqg);
  await w.handle({ id: 1, op: 'load', manifest, manifestUrl: 'x' });
  await w.handle({ id: 7, op: 'analyze', bytes: sampleBytes('sharp_small.jpg'), type: 'text/plain' });
  assert.deepEqual(w.last(), { id: 7, fail: 'unsupported_type', status: 415, detail: 'Unsupported media type', cause: null });
});

test('worker reevaluate posts Python\'s decision and settings, or invalid_override naming the field', async () => {
  const w = workerOver(iqg);
  await w.handle({ id: 1, op: 'load', manifest, manifestUrl: 'x' });
  const scores = { blur_score: 100, brightness: 128 };
  await w.handle({ id: 2, op: 'reevaluate', scores, overrides: { blur_min: 70 } });
  const ok = w.last();
  assert.equal(ok.done, true);
  assert.equal(ok.decision.is_ok, true);
  assert.equal(ok.settings.blur_min.source, 'init');
  await w.handle({ id: 3, op: 'reevaluate', scores, overrides: { blur_min: -1 } });
  assert.deepEqual(w.last(), { id: 3, fail: 'invalid_override', fields: ['blur_min'] });
});

test('worker load failures post the IqgLoadError kind, or load for any other error', async () => {
  const integrity = workerOver(iqg, { load: async () => { throw new IqgLoadError('integrity', 'x'); } });
  await integrity.handle({ id: 1, op: 'load', manifest, manifestUrl: 'x' });
  assert.deepEqual(integrity.posted, [{ id: 1, fail: 'integrity' }]);
  const other = workerOver(iqg, { load: async () => { throw new TypeError('Failed to fetch'); } });
  await other.handle({ id: 1, op: 'load', manifest, manifestUrl: 'x' });
  assert.deepEqual(other.posted, [{ id: 1, fail: 'load' }]);
  await other.handle({ id: 2, op: 'analyze', bytes: sampleBytes('sharp_small.jpg'), type: 'image/jpeg' });
  assert.deepEqual(other.last(), { id: 2, fail: 'fatal' }, 'no runtime after a failed load');
});

test('worker posts fail fatal when the session throws', async () => {
  const broken = { ...iqg, analyze: () => { throw new Error('RuntimeError: memory access out of bounds'); },
    reevaluate: () => { throw new Error('boom'); } };
  const w = workerOver(broken);
  await w.handle({ id: 1, op: 'load', manifest, manifestUrl: 'x' });
  await w.handle({ id: 2, op: 'analyze', bytes: sampleBytes('sharp_small.jpg'), type: 'image/jpeg' });
  assert.deepEqual(w.last(), { id: 2, fail: 'fatal' });
  await w.handle({ id: 3, op: 'reevaluate', scores: { blur_score: 1, brightness: 1 }, overrides: {} });
  assert.deepEqual(w.last(), { id: 3, fail: 'fatal' });
});
