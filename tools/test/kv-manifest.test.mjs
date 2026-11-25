// Tests of the exact branch of the pyodide check (D-02, D-03, D-14): a pyodide-exact-manifest/1 manifest (the key-value
// demo) against every byte it lists (sources, the vendored parity set, the recordings), the same files at the pinned
// upstream commit, golden/meta.json at that commit, each recording's meta.json, the reachability of the manifest sha and
// of every recording's source commit, and the engine sources at that source commit. Every problem is a finding (fail
// closed). Reachability and upstream reads go to an evidence root or a mocked fetch, never the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '../claims-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');
const CLI = path.join(HERE, '..', 'check-claims.mjs');
const fn = (name) => { assert.equal(typeof lib[name], 'function', `claims-lib.mjs exports ${name}`); return lib[name]; };

const DOC = {
  repos: {
    'ratelimit-cpp': { owner: 'BrianKYildirim', default_branch: 'main', local: '../ratelimit-cpp' },
    'image-quality-gate': { owner: 'BrianKYildirim', default_branch: 'main', local: '../image-quality-gate' },
    'key-value-storage': { owner: 'BrianKYildirim', default_branch: 'main', local: '../key-value-storage' },
  },
  page_repos: { 'rate-limiter': 'ratelimit-cpp', 'image-quality-gate': 'image-quality-gate', 'kv-server': 'key-value-storage' },
};
const SHA = (c) => c.repeat(40);
const S = SHA('a'); // the manifest sha
const T = SHA('b'); // the commit the recordings ran at
const R = 'key-value-storage';
const TOKEN = 'ghp_mocktoken_must_never_be_printed';
const DIR = 'scripts/demos/y-py';
const MANIFEST = `${DIR}/y.manifest.json`;
const PAGE = 'pages/projects/kv-server.html';
const PARITY = 'tools/test/fixtures/y-parity';
const REC_UP = 'bench/recordings/r/s1';
const EV = (sha) => `ev/${R}/${sha}`;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const entry = (text) => ({ bytes: Buffer.byteLength(text), sha256: sha256(text) });
const entries = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, entry(v)]));
const json = (v) => `${JSON.stringify(v, null, 1)}\n`;

const SOURCES = { 'server.py': 'class Session:\n    pass\n', 'observability.py': 'class Observer:\n    pass\n' };
const SCRIPT = '{"steps": ["SET a 1"]}\n';
const GOLDEN = '{"replies": ["OK"]}\n';
const TRACE = '{"seq": 1}\n{"seq": 2}\n';
const KEYS = ['pid', 'ts_ns'];
const PATHS = ['state.store.memory_bytes.value'];
const CDN = entries(Object.fromEntries(['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'].map((n) => [n, n])));
const PIN_HTML = `<p>at <code data-pyodide-pin="y">${S.slice(0, 7)}</code></p>\n`;

// A coherent mini world: the vendored files on disk, upstream at S and at T, and the manifest that lists them. Options
// change one thing while the rest stays consistent, so a single rule can fail alone:
//   recMeta / recSource   fields of the recording's meta.json (undefined drops a field); recMetaText replaces the text
//   goldenMeta            fields of golden/meta.json (also the vendored copy, its manifest entry and its upstream copy)
//   upstream / upstreamT  files at S / at T (null leaves a file out); disk replaces vendored files; edit(m) changes the manifest
function world(o = {}) {
  const recDir = o.recDir ?? `${DIR}/recordings`;
  const recMeta = o.recMetaText ?? json({ schema: 'kv-recording/1', source: { sha: T, dirty: false, ...o.recSource }, environment_id: 'env1', date_utc: '2026-11-20T16:33:27Z', ...o.recMeta });
  const goldenMeta = json({ schema: 'kv-parity/1', sources: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, sha256(v)])),
    scripts: { 'scripts/a.json': sha256(SCRIPT) }, excluded_keys: KEYS, excluded_paths: PATHS, ...o.goldenMeta });
  const parity = { 'scripts/a.json': SCRIPT, 'golden/a.json': GOLDEN, 'golden/meta.json': goldenMeta };
  const rec = { 'meta.json': recMeta, 'raw/trace.jsonl': TRACE };
  const manifest = { schema: 'pyodide-exact-manifest/1', name: 'y', repo: R, sha: S,
    source: { tree_url: `https://github.com/BrianKYildirim/${R}/tree/${S}`, entry: 'server.py' },
    pyodide: { version: '1.2.3', cdn_base: 'https://cdn.jsdelivr.net/pyodide/v1.2.3/full/', files: CDN }, packages: [],
    sources: { dir: DIR, files: entries(SOURCES) },
    parity: { mode: 'exact', dir: PARITY, source_path: 'tests/parity', excluded_keys: KEYS, excluded_paths: PATHS, files: entries(parity) },
    recordings: { dir: recDir, scenarios: { s1: { label: 'One scenario', upstream_dir: REC_UP, source_sha: T, files: entries(rec) } } },
    native: { environment: 'env1', python: '3.11.18' } };
  o.edit?.(manifest);
  const files = { [MANIFEST]: json(manifest) };
  for (const [k, v] of Object.entries(SOURCES)) files[`${DIR}/${k}`] = v;
  for (const [k, v] of Object.entries(parity)) files[`${PARITY}/${k}`] = v;
  for (const [k, v] of Object.entries(rec)) files[`${recDir}/s1/${k}`] = v;
  const atS = { ...SOURCES }, atT = { ...SOURCES };
  for (const [k, v] of Object.entries(parity)) atS[`tests/parity/${k}`] = v;
  for (const [k, v] of Object.entries(rec)) atS[`${REC_UP}/${k}`] = v;
  for (const [k, v] of Object.entries({ ...atS, ...o.upstream })) if (v !== null) files[`${EV(S)}/${k}`] = v;
  for (const [k, v] of Object.entries({ ...atT, ...o.upstreamT })) if (v !== null) files[`${EV(T)}/${k}`] = v;
  Object.assign(files, o.disk);
  const page = o.page === undefined ? PIN_HTML : o.page;
  if (page !== null) files[PAGE] = page;
  return files;
}

async function withRoot(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kvexact-'));
  try {
    await writeFile(path.join(dir, 'claims.json'), JSON.stringify({ schema_version: 1, ...DOC, environments: {}, tables: [], claims: [] }));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The library call the CLI makes, on a root on disk; reachability and upstream reads default to the evidence root.
async function check(dir, opts = {}) {
  let dirs = [];
  try {
    dirs = (await readdir(path.join(dir, 'scripts', 'demos'), { withFileTypes: true })).filter((d) => d.isDirectory() && d.name.endsWith('-py')).map((d) => d.name).sort();
  } catch { /* no scripts/demos */ }
  const manifests = [];
  for (const d of dirs) {
    for (const f of (await readdir(path.join(dir, 'scripts', 'demos', d))).filter((n) => n.endsWith('.manifest.json')).sort()) {
      const file = `scripts/demos/${d}/${f}`;
      manifests.push({ name: f.slice(0, -'.manifest.json'.length), file, text: await readFile(path.join(dir, file), 'utf8') });
    }
  }
  let html = '';
  try { html = await readFile(path.join(dir, PAGE), 'utf8'); } catch { /* no page */ }
  const src = fn('createSources')('evidence-root', { dir: path.join(dir, 'ev') });
  return fn('checkPyodideManifests')({ manifests, pins: fn('extractPyodidePins')(html, PAGE), facts: fn('extractPyodideFacts')(html, PAGE),
    repos: DOC.repos, root: dir, isReachable: opts.isReachable ?? src.isReachable,
    readEvidence: Object.hasOwn(opts, 'readEvidence') ? opts.readEvidence : src.readEvidence, project: opts.project });
}
const codes = (fs) => fs.map((f) => f.code);
const show = (fs) => JSON.stringify(fs, null, 1);
// A world's findings on a fresh root.
const findingsOf = (o, opts) => withRoot(world(o), (dir) => check(dir, opts));
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, GITHUB_TOKEN: '' } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const cliArgs = (dir, ...more) => ['--root', dir, '--claims', path.join(dir, 'claims.json'), '--evidence-root', path.join(dir, 'ev'), ...more];

// ---------- Valid and the real manifest ----------
test('a valid exact mini root (sources, parity set with golden/meta.json, a recording, upstream at S and at T, page pin) gives no findings; CLI prints 1 pyodide manifest(s)', async () => {
  await withRoot(world(), async (dir) => {
    assert.deepEqual(await check(dir), []);
    const r = await cli(cliArgs(dir, '--only', 'pyodide'));
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] ok \(checks: pyodide; 0 claim\(s\), 0 tagged value\(s\), 0 pin\(s\), 1 pyodide manifest\(s\)\)$/m);
  });
});

test('the real scripts/demos/kv-py/kv.manifest.json parses with no findings under pyodide-exact-manifest/1', async () => {
  const file = 'scripts/demos/kv-py/kv.manifest.json';
  const r = fn('parsePyodideManifest')(await readFile(path.join(REPO_ROOT, file), 'utf8'), file, { repos: DOC.repos });
  assert.deepEqual(r.findings, []);
  assert.equal(r.manifest.name, 'kv');
  assert.equal(lib.PYODIDE_EXACT_MANIFEST_SCHEMA, 'pyodide-exact-manifest/1');
  assert.equal(r.manifest.schema, lib.PYODIDE_EXACT_MANIFEST_SCHEMA);
});

// With a sibling clone that holds the pinned commit, the real tree's only finding is the missing page pin (05-12 adds it).
const sibling = path.join(REPO_ROOT, '..', R);
const hasPin = await (async () => {
  try {
    await access(sibling);
    const m = JSON.parse(await readFile(path.join(REPO_ROOT, 'scripts/demos/kv-py/kv.manifest.json'), 'utf8'));
    return await new Promise((resolve) => execFile('git', ['-C', sibling, 'cat-file', '-e', `${m.sha}^{commit}`], (err) => resolve(!err)));
  } catch { return false; }
})();
test('the real KV manifest against the sibling clone: bytes, upstream files, meta binding and recordings are clean (only a missing page pin may remain)', { skip: hasPin ? false : `no sibling ../${R} clone with the pinned commit` }, async () => {
  const manifests = [];
  for (const name of ['kv', 'iqg']) {
    const file = `scripts/demos/${name}-py/${name}.manifest.json`;
    manifests.push({ name, file, text: await readFile(path.join(REPO_ROOT, file), 'utf8') });
  }
  const src = fn('createSources')('local', { dir: path.join(REPO_ROOT, '..'), ref: await new Promise((resolve) => execFile('git', ['-C', sibling, 'rev-parse', 'origin/main'], (err, out) => resolve(err ? 'HEAD' : out.trim()))) });
  const f = await fn('checkPyodideManifests')({ manifests: manifests.filter((m) => m.name === 'kv'), repos: DOC.repos, root: REPO_ROOT, isReachable: src.isReachable, readEvidence: src.readEvidence });
  assert.deepEqual(codes(f).filter((c) => c !== 'PYODIDE_UNPINNED'), [], show(f));
});

// ---------- PYODIDE_MANIFEST ----------
test('PYODIDE_MANIFEST: a non-empty packages, a wheels key, samples, another parity.mode, bins or tolerances, empty excluded lists, parity files without golden/meta.json or a script', async () => {
  const cases = {
    'packages not empty': (m) => { m.packages = ['numpy']; },
    'packages missing': (m) => { delete m.packages; },
    'wheels key': (m) => { m.wheels = { 'wheels/a.whl': { bytes: 1, sha256: 'c'.repeat(64) } }; },
    'samples key': (m) => { m.samples = {}; },
    'mode tolerance': (m) => { m.parity.mode = 'tolerance'; },
    'mode missing': (m) => { delete m.parity.mode; },
    'bins present': (m) => { m.parity.bins = 64; },
    'tolerances present': (m) => { m.parity.tolerances = { a: { abs: 1, measured_max: 0, rationale: 'r' } }; },
    'empty excluded_keys': (m) => { m.parity.excluded_keys = []; },
    'excluded_keys not strings': (m) => { m.parity.excluded_keys = [1]; },
    'empty excluded_paths': (m) => { m.parity.excluded_paths = []; },
    'no golden/meta.json': (m) => { delete m.parity.files['golden/meta.json']; },
    'no scripts/*.json': (m) => { delete m.parity.files['scripts/a.json']; },
    'unsafe parity dir': (m) => { m.parity.dir = '../outside'; },
    'unsafe source_path': (m) => { m.parity.source_path = '/etc'; },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const f = await findingsOf({ edit });
    assert.ok(codes(f).includes('PYODIDE_MANIFEST'), `${name}: ${show(f)}`);
    assert.ok(!codes(f).includes('PYODIDE_UNPINNED'), `${name}: an invalid manifest is not used at all`);
  }
});

test('PYODIDE_MANIFEST: a recording without a label, with a short or missing source_sha, an unsafe upstream_dir or dir, no meta.json, no scenarios, or a bad scenario name', async () => {
  const sc = (m) => m.recordings.scenarios.s1;
  const cases = {
    'no label': (m) => { delete sc(m).label; },
    'blank label': (m) => { sc(m).label = '  '; },
    'short source_sha': (m) => { sc(m).source_sha = T.slice(0, 7); },
    'no source_sha': (m) => { delete sc(m).source_sha; },
    'upstream_dir with ..': (m) => { sc(m).upstream_dir = '../x'; },
    'upstream_dir absolute': (m) => { sc(m).upstream_dir = '/x'; },
    'files without meta.json': (m) => { delete sc(m).files['meta.json']; },
    'no files': (m) => { sc(m).files = {}; },
    'unsafe recordings dir': (m) => { m.recordings.dir = '../rec'; },
    'no scenarios': (m) => { m.recordings.scenarios = {}; },
    'scenario name with a slash': (m) => { m.recordings.scenarios['a/b'] = sc(m); },
    'recordings not an object': (m) => { m.recordings = []; },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const f = await findingsOf({ edit });
    assert.ok(codes(f).includes('PYODIDE_MANIFEST'), `${name}: ${show(f)}`);
    assert.ok(!codes(f).includes('PYODIDE_UNPINNED'), name);
  }
});

test('PYODIDE_MANIFEST: native without environment or python, or missing', async () => {
  for (const edit of [(m) => { delete m.native.python; }, (m) => { delete m.native.environment; }, (m) => { m.native.python = ''; }, (m) => { delete m.native; }]) {
    const f = await findingsOf({ edit });
    assert.ok(codes(f).includes('PYODIDE_MANIFEST'), show(f));
    assert.match(f.find((x) => x.code === 'PYODIDE_MANIFEST').message, /native must be an object/);
  }
});

test('PYODIDE_MANIFEST: an unknown schema string names both schemas and is still validated as pyodide-manifest/1; the exact shape under pyodide-manifest/1 is rejected', async () => {
  for (const schema of ['pyodide-exact-manifest/2', 'pyodide-manifest/2', 'pyodide-exact-manifest', '']) {
    const f = await findingsOf({ edit: (m) => { m.schema = schema; } });
    assert.ok(codes(f).every((c) => c === 'PYODIDE_MANIFEST'), show(f));
    assert.ok(f.some((x) => /schema is .* expected "pyodide-manifest\/1" or "pyodide-exact-manifest\/1"/.test(x.message)), show(f));
    // The exact fields get no exact leniency: packages [] and a missing bins fail the old rules.
    assert.ok(f.some((x) => /packages must be a non-empty array/.test(x.message)), show(f));
  }
  const f = await findingsOf({ edit: (m) => { m.schema = 'pyodide-manifest/1'; } });
  assert.ok(f.some((x) => /packages must be a non-empty array/.test(x.message)) && f.some((x) => /parity\.bins/.test(x.message)), show(f));
});

// ---------- PYODIDE_HASH and PYODIDE_UNLISTED ----------
test('PYODIDE_HASH: a changed byte in a recording file, a missing recording file, and a changed vendored script or source', async () => {
  const rec = `${DIR}/recordings/s1/raw/trace.jsonl`;
  for (const rel of [rec, `${DIR}/recordings/s1/meta.json`, `${PARITY}/scripts/a.json`, `${DIR}/server.py`]) {
    const f = await findingsOf({ disk: { [rel]: 'tampered\n' } });
    assert.deepEqual(codes(f).filter((c) => c === 'PYODIDE_HASH'), ['PYODIDE_HASH'], `${rel}: ${show(f)}`);
    assert.ok(f.find((x) => x.code === 'PYODIDE_HASH').message.startsWith(`${rel}: on disk`));
  }
  const files = world();
  delete files[rec];
  await withRoot(files, async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['PYODIDE_HASH'], show(f));
    assert.match(f[0].message, /is listed but missing on disk/);
  });
});

test('PYODIDE_UNLISTED: an extra file in the recordings dir (below or outside the manifest directory), a scenario dir, or the parity dir', async () => {
  for (const rel of [`${DIR}/recordings/s1/raw/extra.jsonl`, `${DIR}/recordings/other/meta.json`, `${DIR}/recordings/stray.txt`, `${PARITY}/golden/new.json`]) {
    const f = await findingsOf({ disk: { [rel]: 'x' } });
    assert.deepEqual(codes(f), ['PYODIDE_UNLISTED'], `${rel}: ${show(f)}`);
    assert.ok(f[0].message.startsWith(rel), f[0].message);
  }
  // A recordings dir outside the manifest's directory is scanned on its own.
  const outside = (extra) => ({ recDir: 'static/rec-y', disk: extra, edit: (m) => { m.recordings.dir = 'static/rec-y'; } });
  assert.deepEqual(await findingsOf(outside({})), []);
  const f = await findingsOf(outside({ 'static/rec-y/s1/extra.bin': 'x' }));
  assert.deepEqual(codes(f), ['PYODIDE_UNLISTED'], show(f));
  assert.match(f[0].message, /static\/rec-y\/s1\/extra\.bin is in static\/rec-y but is not a listed recording file/);
});

// ---------- PYODIDE_SOURCE_MISMATCH ----------
test('PYODIDE_SOURCE_MISMATCH: golden/meta.json at S naming other sources, other scripts, other excluded lists, or a map the manifest lacks', async () => {
  const cases = [
    [{ sources: { 'server.py': sha256('other'), 'observability.py': sha256(SOURCES['observability.py']) } }, /sources server\.py: sha256 "[0-9a-f]{64}", but tests\/parity\/golden\/meta\.json at aaaaaaa says "/],
    [{ sources: { 'server.py': sha256(SOURCES['server.py']) } }, /sources observability\.py: .* says null/],
    [{ sources: { ...Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, sha256(v)])), 'session.py': sha256('x') } }, /sources session\.py: sha256 null, but .* says "/],
    [{ scripts: { 'scripts/a.json': sha256('other') } }, /scripts scripts\/a\.json: sha256 /],
    [{ scripts: { 'scripts/a.json': sha256(SCRIPT), 'scripts/b.json': sha256('b') } }, /scripts scripts\/b\.json: sha256 null/],
    [{ scripts: undefined }, /has no scripts map/],
    [{ sources: undefined }, /has no sources map/],
    [{ excluded_keys: ['pid'] }, /parity\.excluded_keys is \["pid","ts_ns"\], but .* says \["pid"\]/],
    [{ excluded_keys: ['ts_ns', 'pid'] }, /parity\.excluded_keys/],
    [{ excluded_paths: [] }, /parity\.excluded_paths is /],
    [{ excluded_paths: undefined }, /parity\.excluded_paths is .* says null/],
  ];
  for (const [goldenMeta, re] of cases) {
    const f = await findingsOf({ goldenMeta });
    assert.deepEqual(codes(f), ['PYODIDE_SOURCE_MISMATCH'], `${JSON.stringify(goldenMeta)}: ${show(f)}`);
    assert.match(f[0].message, re);
  }
});

test('PYODIDE_SOURCE_MISMATCH: golden/meta.json that is not JSON, not an object, or absent at S', async () => {
  for (const [text, re] of [['not json', /golden\/meta\.json at aaaaaaa is not valid JSON/], ['[]\n', /is not a JSON object/]]) {
    const m = world({ edit: () => {} });
    const f = await withRoot({ ...m, [`${PARITY}/golden/meta.json`]: text, [`${EV(S)}/tests/parity/golden/meta.json`]: text,
      [MANIFEST]: json({ ...JSON.parse(m[MANIFEST]), parity: { ...JSON.parse(m[MANIFEST]).parity, files: { ...JSON.parse(m[MANIFEST]).parity.files, 'golden/meta.json': entry(text) } } }) }, (dir) => check(dir));
    assert.deepEqual(codes(f), ['PYODIDE_SOURCE_MISMATCH'], show(f));
    assert.match(f[0].message, re);
  }
  const f = await findingsOf({ upstream: { 'tests/parity/golden/meta.json': null } });
  assert.deepEqual(codes(f), ['PYODIDE_SOURCE_MISMATCH', 'PYODIDE_SOURCE_MISMATCH'], show(f));
});

test('PYODIDE_SOURCE_MISMATCH: a recording file that differs from upstream at S, or is absent there', async () => {
  for (const [upstream, re] of [
    [{ [`${REC_UP}/raw/trace.jsonl`]: '{"seq": 9}\n' }, new RegExp(`${REC_UP}/raw/trace\\.jsonl at ${R}@aaaaaaa has sha256`)],
    [{ [`${REC_UP}/meta.json`]: '{}\n' }, new RegExp(`${REC_UP}/meta\\.json at ${R}@aaaaaaa has sha256`)],
    [{ [`${REC_UP}/raw/trace.jsonl`]: null }, new RegExp(`${REC_UP}/raw/trace\\.jsonl is not in ${R} at aaaaaaa`)],
  ]) {
    const f = await findingsOf({ upstream });
    assert.deepEqual(codes(f), ['PYODIDE_SOURCE_MISMATCH'], show(f));
    assert.match(f[0].message, re);
    assert.equal(f[0].file, MANIFEST);
  }
});

test('PYODIDE_SOURCE_MISMATCH: an engine source that differs, or is absent, at the recording\'s source_sha (the recording ran other engine code)', async () => {
  for (const [upstreamT, re] of [
    [{ 'server.py': 'class Session:\n    changed = 1\n' }, new RegExp(`server\\.py at ${R}@bbbbbbb has sha256 .*the recording ran other engine code than the vendored server\\.py`)],
    [{ 'observability.py': null }, new RegExp(`observability\\.py is not in ${R} at bbbbbbb`)],
  ]) {
    const f = await findingsOf({ upstreamT });
    assert.deepEqual(codes(f), ['PYODIDE_SOURCE_MISMATCH'], show(f));
    assert.match(f[0].message, re);
  }
});

test('a recording whose source_sha is the manifest sha reads each source once (no second read at the same commit)', async () => {
  const reads = [];
  const src = (dir) => fn('createSources')('evidence-root', { dir: path.join(dir, 'ev') });
  const files = world({ recSource: { sha: S }, edit: (m) => { m.recordings.scenarios.s1.source_sha = S; } });
  await withRoot(files, async (dir) => {
    const s = src(dir);
    const f = await check(dir, { readEvidence: async (repo, sha, rel) => { reads.push(`${sha.slice(0, 1)}:${rel}`); return s.readEvidence(repo, sha, rel); } });
    assert.deepEqual(f, []);
    assert.equal(reads.filter((r) => r === 'a:server.py').length, 1);
    assert.ok(!reads.some((r) => r.startsWith('b:')), reads.join(','));
  });
});

// ---------- PYODIDE_RECORDING ----------
test('PYODIDE_RECORDING: a meta.json whose source.sha is not the scenario\'s, whose tree was dirty, or that is missing the field', async () => {
  for (const [o, re] of [
    [{ recSource: { sha: SHA('c') } }, /says source\.sha "c{40}", the manifest says source_sha b{40}/],
    [{ recSource: { sha: undefined } }, /says source\.sha null/],
    [{ recSource: { dirty: true } }, /says source\.dirty true, expected false/],
    [{ recSource: { dirty: undefined } }, /says source\.dirty null/],
    [{ recSource: { dirty: 'false' } }, /source\.dirty "false"/],
  ]) {
    const f = await findingsOf(o);
    assert.deepEqual(codes(f), ['PYODIDE_RECORDING'], `${JSON.stringify(o)}: ${show(f)}`);
    assert.match(f[0].message, re);
    assert.equal(f[0].file, MANIFEST);
    assert.ok(f[0].message.startsWith('s1: '), f[0].message);
  }
});

test('PYODIDE_RECORDING: another environment_id than native.environment, no date_utc, text that is not JSON, or JSON that is not an object', async () => {
  for (const [o, re] of [
    [{ recMeta: { environment_id: 'windows' } }, /says environment_id "windows", the manifest's native\.environment is "env1"/],
    [{ recMeta: { environment_id: undefined } }, /says environment_id null/],
    [{ recMeta: { date_utc: undefined } }, /has no date_utc/],
    [{ recMeta: { date_utc: ' ' } }, /has no date_utc/],
    [{ recMetaText: 'not json' }, /is not valid JSON/],
    [{ recMetaText: '[]\n' }, /is not a JSON object/],
  ]) {
    const f = await findingsOf(o);
    assert.deepEqual(codes(f), ['PYODIDE_RECORDING'], `${JSON.stringify(o)}: ${show(f)}`);
    assert.match(f[0].message, re);
  }
});

// ---------- Reachability and unreadable upstream: fail closed ----------
test('PIN_UNREACHABLE when the recording\'s source commit is not reachable (the manifest sha being reachable does not help)', async () => {
  const reach = (bad) => async (repo, sha) => (sha === bad ? { state: 'unreachable', ref: 'main', status: 'compare status diverged' } : { state: 'reachable', ref: 'main', status: 'behind' });
  const f = await findingsOf({}, { isReachable: reach(T) });
  assert.deepEqual(codes(f), ['PIN_UNREACHABLE'], show(f));
  assert.equal(f[0].file, MANIFEST);
  assert.ok(f[0].message.includes(T), f[0].message);
  const g = await findingsOf({}, { isReachable: reach(S) });
  assert.deepEqual(codes(g), ['PIN_UNREACHABLE']);
  assert.ok(g[0].message.includes(S), g[0].message);
});

test('COULD_NOT_VERIFY, never a pass: unknown reachability of the recording\'s source commit, a failed reachability call, no reachability result', async () => {
  const only = (bad, result) => async (repo, sha) => (sha === bad ? result() : { state: 'reachable', ref: 'main', status: 'behind' });
  for (const result of [() => ({ state: 'unknown', reason: 'rate limited' }), () => { throw new Error('boom'); }, () => undefined]) {
    const f = await findingsOf({}, { isReachable: only(T, result) });
    assert.deepEqual(codes(f), ['COULD_NOT_VERIFY'], show(f));
    assert.ok(f[0].message.includes(T), f[0].message);
  }
});

test('COULD_NOT_VERIFY, never a pass: an upstream read that fails for a recording file, for golden/meta.json, or for a source at the recording\'s commit', async () => {
  const failing = (match, code = 'COULD_NOT_VERIFY') => async (repo, sha, rel) => {
    if (match(sha, rel)) throw Object.assign(new Error('network error'), { code });
    return world()[`${EV(sha)}/${rel}`];
  };
  for (const [name, match] of [['a recording file', (sha, rel) => rel === `${REC_UP}/raw/trace.jsonl`],
    ['golden/meta.json (read as a parity file and again for the binding)', (sha, rel) => rel === 'tests/parity/golden/meta.json'],
    ['a source at T', (sha, rel) => sha === T && rel === 'server.py']]) {
    const f = await findingsOf({}, { readEvidence: failing(match) });
    assert.ok(f.length >= 1 && f.every((x) => x.code === 'COULD_NOT_VERIFY'), `${name}: ${show(f)}`);
    const big = await findingsOf({}, { readEvidence: failing(match, 'INPUT_TOO_LARGE') });
    assert.ok(big.length >= 1 && big.every((x) => x.code === 'INPUT_TOO_LARGE'), `${name}: ${show(big)}`);
  }
  const reads = [];
  const all = await findingsOf({}, { readEvidence: async (repo, sha, rel) => { reads.push(`${sha}:${rel}`); throw Object.assign(new Error('down'), { code: 'COULD_NOT_VERIFY' }); } });
  // 2 sources + 3 parity JSON files + 2 recording files at S, 2 sources at T, and golden/meta.json again for the binding.
  assert.equal(all.length, 2 + 3 + 2 + 2 + 1, show(all));
  assert.ok(all.every((x) => x.code === 'COULD_NOT_VERIFY'), show(all));
  const none = await findingsOf({}, { readEvidence: undefined });
  assert.ok(none.length > 0 && none.every((x) => x.code === 'COULD_NOT_VERIFY'), show(none));
});

// ---------- Page pin, GitHub mode, CLI ----------
test('the exact manifest is pinned like any other: PYODIDE_UNPINNED without a page pin, PYODIDE_PIN_MISMATCH for another sha', async () => {
  const f = await findingsOf({ page: '<p>no pin</p>' });
  assert.deepEqual(codes(f), ['PYODIDE_UNPINNED']);
  assert.equal(f[0].file, MANIFEST);
  const g = await findingsOf({ page: `<code data-pyodide-pin="y">${T.slice(0, 7)}</code>` });
  assert.deepEqual(codes(g), ['PYODIDE_PIN_MISMATCH']);
});

function mockGithub(bySha) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url), respond = (status, text) => ({ ok: status >= 200 && status < 300, status, url, headers: new Headers(), body: null, text: async () => text });
    if (u.host === 'raw.githubusercontent.com') {
      const [, sha, rel] = /^\/[^/]+\/[^/]+\/([0-9a-f]{40})\/(.*)$/.exec(decodeURIComponent(u.pathname)) ?? [];
      const files = bySha[sha] ?? {};
      return Object.hasOwn(files, rel) ? respond(200, files[rel]) : respond(404, '404: Not Found');
    }
    if (/\/compare\//.test(u.pathname)) return respond(200, JSON.stringify({ status: 'behind' }));
    return respond(200, JSON.stringify({ default_branch: 'main' }));
  };
  return { fetchImpl, calls };
}
const upstreamTexts = (files) => {
  const out = { [S]: {}, [T]: {} };
  for (const [k, v] of Object.entries(files)) for (const sha of [S, T]) if (k.startsWith(`${EV(sha)}/`)) out[sha][k.slice(EV(sha).length + 1)] = v;
  return out;
};

test('GitHub mode: sources, parity JSON, recordings at S and the sources at T are read from raw.githubusercontent.com with no token; a tampered recording or a down network is caught', async () => {
  const files = world();
  await withRoot(files, async (dir) => {
    const mock = mockGithub(upstreamTexts(files));
    const src = fn('createSources')('api', { repos: DOC.repos, fetchImpl: mock.fetchImpl, token: TOKEN });
    assert.deepEqual(await check(dir, { isReachable: src.isReachable, readEvidence: src.readEvidence }), []);
    const raw = mock.calls.filter((u) => new URL(u).host === 'raw.githubusercontent.com');
    assert.ok(raw.some((u) => u.includes(`/${T}/server.py`)) && raw.some((u) => u.includes(`/${S}/${REC_UP}/raw/trace.jsonl`)), raw.join('\n'));
    const tampered = world({ upstream: { [`${REC_UP}/raw/trace.jsonl`]: 'tampered\n' } });
    const m2 = mockGithub(upstreamTexts(tampered));
    const s2 = fn('createSources')('api', { repos: DOC.repos, fetchImpl: m2.fetchImpl, token: TOKEN });
    assert.deepEqual(codes(await check(dir, { isReachable: s2.isReachable, readEvidence: s2.readEvidence })), ['PYODIDE_SOURCE_MISMATCH']);
    const down = { fetchImpl: async () => { throw new TypeError(`fetch failed for ${TOKEN}`); } };
    const s3 = fn('createSources')('api', { repos: DOC.repos, fetchImpl: down.fetchImpl, token: TOKEN });
    const f = await check(dir, { isReachable: s3.isReachable, readEvidence: s3.readEvidence });
    assert.ok(f.length > 0 && f.every((x) => x.code === 'COULD_NOT_VERIFY'), show(f));
    const out = f.map(lib.formatFinding).join('\n');
    assert.ok(!out.includes(TOKEN) && !out.includes('Bearer'), out);
  });
});

test('CLI --only pyodide: exit 1 with a PYODIDE_HASH line when a recording byte changes, and a PYODIDE_RECORDING line for a dirty recording', async () => {
  await withRoot(world({ disk: { [`${DIR}/recordings/s1/raw/trace.jsonl`]: 'changed\n' } }), async (dir) => {
    const r = await cli(cliArgs(dir, '--only', 'pyodide'));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] scripts\/demos\/y-py\/y\.manifest\.json:\d+ PYODIDE_HASH scripts\/demos\/y-py\/recordings\/s1\/raw\/trace\.jsonl: on disk/m);
    assert.match(r.stdout, /^\[check-claims\] 1 finding\(s\)$/m);
  });
  await withRoot(world({ recSource: { dirty: true } }), async (dir) => {
    const r = await cli(cliArgs(dir, '--only', 'pyodide'));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] scripts\/demos\/y-py\/y\.manifest\.json:\d+ PYODIDE_RECORDING s1: /m);
  });
});
