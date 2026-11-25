// The Node leg of exact native-vs-Pyodide parity for key-value-storage (D-04): every script vendored from tests/parity
// at the manifest sha runs through the shipped loader and session, and its transcript must equal the native golden after
// the shared mask. Goldens come only from upstream tests/parity/run_native.py; nothing here writes or edits one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORK_DIR } from '../../scripts/demos/kv-pyodide.js';
import { EXCLUDED_KEYS, EXCLUDED_PATHS, compareTranscript, maskRecord, parseRecord, runScript } from '../kv-parity.mjs';
import { loadKvNode } from '../pyodide-cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const PY_DIR = path.join(ROOT, 'scripts', 'demos', 'kv-py');
const manifest = JSON.parse(readFileSync(path.join(PY_DIR, 'kv.manifest.json'), 'utf8'));
const FIX = path.join(ROOT, 'tools', 'test', 'fixtures', 'kv-parity');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const byteSorted = (keys) => [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const readJson = (...parts) => JSON.parse(readFileSync(path.join(FIX, ...parts), 'utf8'));

// Every file under dir as a '/'-separated path relative to it.
function walk(dir, rel = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

const names = walk(path.join(FIX, 'scripts')).map((f) => f.replace(/\.json$/, '')).sort();
const script = (name) => readJson('scripts', `${name}.json`);
const golden = (name) => readJson('golden', `${name}.json`);

const describe = (diffs) => diffs.map((d) => `${d.path}: pyodide ${JSON.stringify(d.actual)}, native ${JSON.stringify(d.expected)}`).join('; ');

const kv = await loadKvNode(manifest, { root: ROOT });

// Each script starts in an empty working directory, as upstream run_native.py gives it.
const runFresh = async (name) => {
  if (kv.pyodide.FS.analyzePath(`${WORK_DIR}/store.txt`).exists) kv.pyodide.FS.unlink(`${WORK_DIR}/store.txt`);
  return runScript(kv.session, script(name));
};

test('the vendored parity set is the manifest\'s, from the pinned sha, and every script has a golden', () => {
  assert.equal(manifest.schema, 'pyodide-exact-manifest/1');
  assert.equal(manifest.parity?.mode, 'exact');
  assert.equal(manifest.parity.dir, 'tools/test/fixtures/kv-parity');
  assert.equal(manifest.parity.source_path, 'tests/parity');
  assert.match(manifest.sha, /^[0-9a-f]{40}$/);
  const listed = Object.keys(manifest.parity.files ?? {});
  assert.deepEqual(listed, byteSorted(listed), 'manifest parity entries are sorted by path');
  assert.deepEqual(byteSorted(walk(FIX)), byteSorted(listed), 'files on disk equal the files listed in the manifest');
  assert.ok(names.length > 0, 'no vendored script');
  for (const n of names) assert.ok(existsSync(path.join(FIX, 'golden', `${n}.json`)), `${n}: no golden`);
  const goldens = walk(path.join(FIX, 'golden')).filter((f) => f !== 'meta.json').map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual(goldens.sort(), names, 'every golden has a script');
});

test('every parity file matches its bytes and sha256', () => {
  for (const [rel, entry] of Object.entries(manifest.parity?.files ?? {})) {
    const b = readFileSync(path.join(FIX, ...rel.split('/')));
    assert.equal(b.length, entry.bytes, `${rel}: bytes`);
    assert.equal(sha256(b), entry.sha256, `${rel}: sha256`);
  }
});

test('golden/meta.json binds the vendored sources, scripts and exclusion lists, and the native environment', () => {
  const meta = readJson('golden', 'meta.json');
  assert.equal(meta.schema, 'kv-parity/1');
  assert.deepEqual(Object.keys(manifest.sources.files).sort(), Object.keys(meta.sources).sort(), 'same source closure');
  for (const [rel, entry] of Object.entries(manifest.sources.files)) assert.equal(entry.sha256, meta.sources[rel], `${rel}: sha256`);
  assert.deepEqual(Object.keys(meta.scripts).sort(), names.map((n) => `scripts/${n}.json`), 'same scripts');
  for (const [rel, hash] of Object.entries(meta.scripts)) {
    assert.equal(sha256(readFileSync(path.join(FIX, ...rel.split('/')))), hash, `${rel}: sha256`);
  }
  assert.deepEqual(meta.excluded_keys, [...EXCLUDED_KEYS].sort(), 'excluded_keys equal tools/kv-parity.mjs');
  assert.deepEqual(meta.excluded_paths, [...EXCLUDED_PATHS], 'excluded_paths equal tools/kv-parity.mjs');
  assert.deepEqual(manifest.parity.excluded_keys, meta.excluded_keys, 'manifest excluded_keys');
  assert.deepEqual(manifest.parity.excluded_paths, meta.excluded_paths, 'manifest excluded_paths');
  assert.deepEqual(manifest.native, { environment: meta.environment, python: meta.python });
});

for (const name of names) {
  test(`script ${name}: the Pyodide transcript equals the native golden`, async () => {
    const diffs = compareTranscript(await runFresh(name), golden(name));
    assert.equal(diffs.length, 0, describe(diffs));
  });
}

test('the comparison has teeth on a real golden: one reply character, event field or store.txt byte is reported at its path, a raw ts_ns is not', async () => {
  const name = names[0];
  const actual = await runFresh(name), g = golden(name);
  assert.deepEqual(compareTranscript(actual, g), [], 'the unmodified golden gives no difference');
  const paths = (mutate) => { const m = structuredClone(g); mutate(m); return compareTranscript(actual, m).map((d) => d.path); };

  const r = g.steps.findIndex((s) => s.replies?.[0]?.length > 0);
  assert.ok(r >= 0, `${name}: no reply to change`);
  assert.deepEqual(paths((m) => { m.steps[r].replies[0] = `${m.steps[r].replies[0].slice(0, -1)}!`; }), [`steps[${r}].replies[0]`]);

  assert.equal(g.steps[0].events[0].type, 'store.load', `${name}: the boot record starts with store.load`);
  assert.deepEqual(paths((m) => { m.steps[0].events[0].data.path = 'other.txt'; }), ['steps[0].events[0].data.path']);

  const s = g.steps.findIndex((x) => typeof x.store_txt === 'string' && x.store_txt.length > 0);
  assert.ok(s >= 0, `${name}: no store.txt to change`);
  assert.deepEqual(paths((m) => { m.steps[s].store_txt = `${m.steps[s].store_txt}X`; }), [`steps[${s}].store_txt`]);

  // The mask: a changed raw ts_ns does not show, a changed seq does (same record, same walk).
  const rec = parseRecord(await kv.session.reset());
  const moved = structuredClone(rec);
  moved.events[0].ts_ns = 1;
  assert.deepEqual(compareTranscript(maskRecord(moved), maskRecord(rec)), [], 'ts_ns is masked');
  assert.equal(maskRecord(rec).events[0].ts_ns, '<x:int>', 'the golden side shows the mask');
  moved.events[0].seq += 1;
  assert.deepEqual(compareTranscript(maskRecord(moved), maskRecord(rec)).map((d) => d.path), ['events[0].seq']);
});

// ---------- Recordings and upstream identity (T-05-16) ----------

const recordings = manifest.recordings ?? { dir: null, scenarios: {} };

test('the recordings are exactly the manifest\'s: four scenarios, every file with its bytes and sha256, meta.json naming the source commit', () => {
  assert.equal(recordings.dir, 'scripts/demos/kv-py/recordings');
  assert.deepEqual(Object.keys(recordings.scenarios), ['backlog', 'contention', 'framing', 'shutdown']);
  const dir = path.join(ROOT, ...recordings.dir.split('/'));
  assert.deepEqual(byteSorted(walk(dir)), byteSorted(Object.entries(recordings.scenarios)
    .flatMap(([n, s]) => Object.keys(s.files).map((f) => `${n}/${f}`))), 'files on disk equal the files listed in the manifest');
  for (const [scenario, s] of Object.entries(recordings.scenarios)) {
    assert.ok(typeof s.label === 'string' && s.label.length > 0, `${scenario}: label`);
    assert.match(s.source_sha, /^[0-9a-f]{40}$/, `${scenario}: source_sha`);
    const keys = Object.keys(s.files);
    assert.deepEqual(keys, byteSorted(keys), `${scenario}: files sorted`);
    for (const [rel, entry] of Object.entries(s.files)) {
      const b = readFileSync(path.join(dir, scenario, ...rel.split('/')));
      assert.equal(b.length, entry.bytes, `${scenario}/${rel}: bytes`);
      assert.equal(sha256(b), entry.sha256, `${scenario}/${rel}: sha256`);
    }
    const meta = JSON.parse(readFileSync(path.join(dir, scenario, 'meta.json'), 'utf8'));
    assert.equal(meta.source.sha, s.source_sha, `${scenario}: meta.json source.sha`);
    assert.equal(meta.source.dirty, false, `${scenario}: captured from a clean tree`);
    assert.equal(meta.environment_id, manifest.native.environment, `${scenario}: environment`);
  }
});

// CI has no sibling clone; the checker in 05-08 is the CI-side identity check. Everywhere else every vendored byte is
// compared with `git show <sha>:<path>` of the pinned commit, so a fetch that lacks the commit fails instead of skipping.
const UPSTREAM = path.join(ROOT, '..', 'key-value-storage');
const haveUpstream = existsSync(path.join(UPSTREAM, '.git'));

test('every vendored source, parity file and recording equals `git show` of the pinned commit', {
  skip: haveUpstream ? false : 'no sibling ../key-value-storage clone here (CI): the identity check in tools/check-claims.mjs covers it',
}, () => {
  const show = (rel) => {
    const r = spawnSync('git', ['-C', UPSTREAM, 'show', `${manifest.sha}:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `git show ${manifest.sha}:${rel} failed: ${r.stderr}`);
    return r.stdout;
  };
  const same = (rel, file) => assert.ok(readFileSync(file).equals(show(rel)), `${file} differs from ${rel} at ${manifest.sha}`);
  for (const rel of Object.keys(manifest.sources.files)) same(rel, path.join(PY_DIR, rel));
  for (const rel of Object.keys(manifest.parity.files)) same(`${manifest.parity.source_path}/${rel}`, path.join(FIX, ...rel.split('/')));
  for (const [scenario, s] of Object.entries(recordings.scenarios)) {
    for (const rel of Object.keys(s.files)) same(`${s.upstream_dir}/${rel}`, path.join(ROOT, ...recordings.dir.split('/'), scenario, ...rel.split('/')));
  }
});
