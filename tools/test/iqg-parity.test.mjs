// The Node leg of native-vs-Pyodide parity (D-18, D-20): every case vendored from image-quality-gate tests/parity at
// the manifest sha runs through the shipped loader and the vendored pipeline, and must match its native golden under
// manifest.parity.tolerances with exact decisions. Goldens come only from upstream tests/parity/run_native.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toleranceFor } from '../../scripts/demos/iqg-pyodide.js';
import { compareOutcome, stripGolden } from '../iqg-parity.mjs';
import { loadIqgNode } from '../pyodide-cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const PY_DIR = path.join(ROOT, 'scripts', 'demos', 'iqg-py');
const manifest = JSON.parse(readFileSync(path.join(PY_DIR, 'iqg.manifest.json'), 'utf8'));
const FIX = path.join(ROOT, 'tools', 'test', 'fixtures', 'iqg-parity');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (...parts) => JSON.parse(readFileSync(path.join(FIX, ...parts), 'utf8'));
const cases = existsSync(path.join(FIX, 'cases.json')) ? readJson('cases.json') : { bins: null, cases: [] };
const golden = (name) => readJson('golden', `${name}.json`);
const tolerances = manifest.parity?.tolerances;

// Every file under dir as a '/'-separated path relative to it.
function walk(dir, rel = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

// One case through the vendored pipeline in Pyodide, in the golden's shape.
function run(c) {
  const bytes = new Uint8Array(readFileSync(path.join(FIX, ...c.file.split('/'))));
  const o = iqg.analyze(bytes, c.content_type, { overrides: c.settings, bins: cases.bins });
  return o.status === 200 ? stripGolden(o.response) : { error: { status: o.status, detail: o.detail, cause: o.cause ?? null } };
}

const describe = (diffs) => diffs.map((d) => `${d.path}: pyodide ${JSON.stringify(d.actual)}, native ${JSON.stringify(d.expected)}, `
  + `bound ${d.bound}`).join('; ');

const iqg = await loadIqgNode(manifest, { root: ROOT });

test('the vendored parity set is the manifest\'s, from the pinned sha, and every case has a golden', () => {
  assert.equal(manifest.parity?.dir, 'tools/test/fixtures/iqg-parity');
  assert.equal(manifest.parity.source_path, 'tests/parity');
  assert.match(manifest.sha, /^[0-9a-f]{40}$/);
  const listed = Object.keys(manifest.parity.files ?? {});
  assert.deepEqual(listed, [...listed].sort(), 'manifest parity entries are sorted by path');
  assert.deepEqual(walk(FIX).sort(), [...listed].sort(), 'files on disk equal the files listed in the manifest');
  const names = cases.cases.map((c) => c.name);
  assert.ok(names.length > 0, 'cases.json lists no case');
  assert.equal(new Set(names).size, names.length, 'case names are unique');
  for (const n of names) assert.ok(existsSync(path.join(FIX, 'golden', `${n}.json`)), `${n}: no golden`);
  const goldens = walk(path.join(FIX, 'golden')).filter((f) => f !== 'meta.json').map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual(goldens.sort(), [...names].sort(), 'every golden has a case');
});

test('every parity file matches its bytes and sha256', () => {
  for (const [rel, entry] of Object.entries(manifest.parity?.files ?? {})) {
    const b = readFileSync(path.join(FIX, ...rel.split('/')));
    assert.equal(b.length, entry.bytes, `${rel}: bytes`);
    assert.equal(sha256(b), entry.sha256, `${rel}: sha256`);
  }
});

test('golden/meta.json binds the vendored sources, fixtures, case list, bins and native versions', () => {
  const meta = readJson('golden', 'meta.json');
  assert.deepEqual(Object.keys(manifest.sources.files).sort(), Object.keys(meta.sources).sort(), 'same source closure');
  for (const [rel, entry] of Object.entries(manifest.sources.files)) assert.equal(entry.sha256, meta.sources[rel], `${rel}: sha256`);
  const fixtures = walk(path.join(FIX, 'fixtures')).map((f) => `fixtures/${f}`);
  assert.deepEqual(fixtures.sort(), Object.keys(meta.fixtures).sort(), 'same fixtures');
  for (const rel of fixtures) assert.equal(sha256(readFileSync(path.join(FIX, ...rel.split('/')))), meta.fixtures[rel], `${rel}: sha256`);
  assert.equal(sha256(readFileSync(path.join(FIX, 'cases.json'))), meta.cases_sha256, 'cases.json: sha256');
  assert.equal(manifest.parity.bins, meta.bins);
  assert.equal(cases.bins, meta.bins);
  assert.deepEqual(manifest.native, { environment: meta.environment, ...meta.versions });
});

test('upstream tolerances.json (P3=A) equals the manifest\'s tolerances and Pyodide versions', () => {
  const t = readJson('tolerances.json');
  assert.equal(t.schema, 'iqg-parity-tolerances/1');
  assert.deepEqual(t.tolerances, tolerances);
  assert.equal(t.pyodide.version, manifest.pyodide.version);
  assert.equal(t.pyodide.python, manifest.pyodide.python);
  assert.deepEqual(t.pyodide.libraries, manifest.pyodide.libraries);
});

for (const c of cases.cases) {
  test(c.name, () => {
    const diffs = compareOutcome(run(c), golden(c.name), tolerances);
    assert.equal(diffs.length, 0, describe(diffs));
  });
}

test('the comparison has teeth: a golden moved past one bound, or with is_ok flipped, is reported at that path', () => {
  const c = cases.cases.find((x) => !golden(x.name).error);
  assert.ok(c, 'no success case');
  const actual = run(c), g = golden(c.name);
  assert.deepEqual(compareOutcome(actual, g, tolerances), [], 'the unmodified golden gives no difference');
  const bound = toleranceFor('blur_score', g.blur_score, tolerances);
  assert.ok(bound > 0, 'blur_score has a bound');
  const moved = structuredClone(g);
  moved.blur_score = g.blur_score + 2 * bound;
  assert.deepEqual(compareOutcome(actual, moved, tolerances).map((d) => d.path), ['blur_score']);
  const flipped = structuredClone(g);
  flipped.is_ok = !g.is_ok;
  assert.deepEqual(compareOutcome(actual, flipped, tolerances).map((d) => d.path), ['is_ok']);
});

// ---------- Demo samples (D-14: every sample a visitor can pick is a parity fixture) ----------

test('every demo sample is a parity fixture with the same bytes and content type, and static/demo/iqg holds only samples', () => {
  const samples = manifest.samples ?? {};
  assert.deepEqual(Object.keys(samples), ['sharp', 'blurry', 'dark', 'under', 'near'], 'samples in display order');
  for (const [key, s] of Object.entries(samples)) {
    const c = cases.cases.find((x) => x.name === s.case);
    assert.ok(c, `${key}: no parity case "${s.case}"`);
    assert.ok(typeof s.label === 'string' && s.label.length > 0, `${key}: label`);
    assert.equal(s.content_type, c.content_type, `${key}: content type`);
    const shipped = readFileSync(path.join(ROOT, ...s.path.split('/')));
    assert.ok(shipped.equals(readFileSync(path.join(FIX, ...c.file.split('/')))), `${key}: ${s.path} differs from ${c.file}`);
  }
  const DIR = 'static/demo/iqg/';
  const listed = Object.values(samples).map((s) => s.path).filter((p) => p.startsWith(DIR)).map((p) => p.slice(DIR.length));
  assert.deepEqual(walk(path.join(ROOT, ...DIR.split('/').filter(Boolean))).sort(), listed.sort(), 'static/demo/iqg holds only sample files');
});
