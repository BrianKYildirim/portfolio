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
import { IqgLoadError, loadIqg } from '../../scripts/demos/iqg-pyodide.js';
import { defaultCacheDir, ensurePyodideCache, loadIqgNode } from '../pyodide-cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const PY_DIR = path.join(ROOT, 'scripts', 'demos', 'iqg-py');
const manifest = JSON.parse(readFileSync(path.join(PY_DIR, 'iqg.manifest.json'), 'utf8'));
const SAMPLES = path.join(ROOT, 'static', 'demo', 'iqg');

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
