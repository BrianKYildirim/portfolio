// Tests of the pyodide check (D-01, D-06): scripts/demos/<dir>-py/<name>.manifest.json against every byte it lists
// (wheels, vendored sources, the vendored parity set, samples), the same sources and parity JSON at the pinned upstream
// commit, golden/meta.json at that commit, reachability, the page pin and the page facts. Every problem is a finding
// (fail closed). Reachability and upstream reads go to an evidence root or a mocked fetch, never the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  },
  page_repos: { 'rate-limiter': 'ratelimit-cpp', 'image-quality-gate': 'image-quality-gate' },
};
const SHA = (c) => c.repeat(40);
const S = SHA('a');
const TOKEN = 'ghp_mocktoken_must_never_be_printed';
const DIR = 'scripts/demos/x-py';
const MANIFEST = `${DIR}/x.manifest.json`;
const PAGE = 'pages/projects/image-quality-gate.html';
const PARITY = 'tools/test/fixtures/x-parity';
const EV = `ev/image-quality-gate/${S}`;
const SAMPLE = 'static/demo/x/a.png';
const BOM = '﻿';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const entry = (text) => ({ bytes: Buffer.byteLength(text), sha256: sha256(text) });
const entries = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, entry(v)]));
const json = (v) => `${JSON.stringify(v, null, 1)}\n`;

const SOURCES = { 'app/__init__.py': '', 'app/main.py': 'def run():\n    return 1\n' };
const WHEELS = { 'wheels/dep-1.0-py3-none-any.whl': 'PK\u0003\u0004 a wheel' };
const PNG = '\u0089PNG\r\n fixture a';
const CASES = `${JSON.stringify({ bins: 64, cases: [{ name: 'a', file: 'fixtures/a.png', content_type: 'image/png', settings: {}, expect: { status: 200 } }] })}\n`;
const metaOf = (over = {}) => `${JSON.stringify({ bins: 64, fixtures: { 'fixtures/a.png': sha256(PNG) }, ...over })}\n`;
const PARITY_FILES = { 'cases.json': CASES, 'fixtures/a.png': PNG, 'golden/a.json': '{"status": 200}\n', 'golden/meta.json': metaOf(),
  'tolerances.json': '{"blur_score": {"rel": 0.01}}\n' };
const CDN = entries(Object.fromEntries(['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'].map((n) => [n, n])));
const PIN_HTML = `<p>at <code data-pyodide-pin="x">${S.slice(0, 7)}</code></p>\n`;

// A valid manifest x for image-quality-gate at S: one wheel, two sources, a parity set with cases.json, golden/meta.json,
// a golden and a fixture, and one sample that is that fixture.
function manifestOf(over = {}) {
  return { schema: 'pyodide-manifest/1', name: 'x', repo: 'image-quality-gate', sha: S,
    source: { tree_url: `https://github.com/BrianKYildirim/image-quality-gate/tree/${S}`, entry: 'app/main.py' },
    pyodide: { version: '1.2.3', cdn_base: 'https://cdn.jsdelivr.net/pyodide/v1.2.3/full/', files: CDN },
    packages: ['numpy'],
    wheels: Object.fromEntries(Object.entries(WHEELS).map(([k, v]) => [k, { ...entry(v), pypi_sha256: sha256(v) }])),
    sources: { dir: DIR, files: entries(SOURCES) },
    parity: { bins: 64, dir: PARITY, files: entries(PARITY_FILES), source_path: 'tests/parity',
      tolerances: { blur_score: { rel: 0.01, measured_max: 0.004, rationale: 'measured over the cases' },
        brightness: { abs: 0.01, measured_max: 0.002, rationale: 'measured over the cases' } } },
    samples: { a: { label: 'A', path: SAMPLE, content_type: 'image/png', case: 'a' } }, ...over };
}
// Upstream at S: the sources and the parity JSON files below tests/parity (null in `over` leaves a file out).
function upstreamOf(over = {}) {
  const up = { ...SOURCES };
  for (const [k, v] of Object.entries(PARITY_FILES)) if (k.endsWith('.json')) up[`tests/parity/${k}`] = v;
  return Object.fromEntries(Object.entries({ ...up, ...over }).filter(([, v]) => v !== null));
}
function miniFiles({ manifest = manifestOf(), page = PIN_HTML, upstream = {} } = {}) {
  const files = { [MANIFEST]: typeof manifest === 'string' ? manifest : json(manifest), [SAMPLE]: PNG };
  for (const [k, v] of Object.entries({ ...SOURCES, ...WHEELS })) files[`${DIR}/${k}`] = v;
  for (const [k, v] of Object.entries(PARITY_FILES)) files[`${PARITY}/${k}`] = v;
  // The evidence root: S is reachable because its commit directory exists, and readEvidence reads below it.
  for (const [k, v] of Object.entries(upstreamOf(upstream))) files[`${EV}/${k}`] = v;
  if (page !== null) files[PAGE] = page;
  return files;
}

async function withRoot(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pyodide-'));
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
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, GITHUB_TOKEN: '' } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const cliArgs = (dir, ...more) => ['--root', dir, '--claims', path.join(dir, 'claims.json'), '--evidence-root', path.join(dir, 'ev'), ...more];

// ---------- Valid, empty and the real manifest ----------
test('a valid mini root (wheel, sources, parity set, sample, page pin, upstream at the sha) gives no findings; CLI prints 1 pyodide manifest(s)', async () => {
  await withRoot(miniFiles(), async (dir) => {
    assert.deepEqual(await check(dir), []);
    const r = await cli(cliArgs(dir, '--only', 'pyodide'));
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] ok \(checks: pyodide; 0 claim\(s\), 0 tagged value\(s\), 0 pin\(s\), 1 pyodide manifest\(s\)\)$/m);
  });
});

test('a root without scripts/demos/*-py has no manifests, and the ok line names pyodide only when the pyodide check runs', async () => {
  await withRoot({ 'pages/about.html': '<p>about</p>' }, async (dir) => {
    assert.deepEqual(await check(dir), []);
    const py = await cli(cliArgs(dir, '--only', 'pyodide'));
    assert.equal(py.code, 0, py.stdout);
    assert.match(py.stdout, /, 0 pyodide manifest\(s\)\)$/m);
    const wasm = await cli(cliArgs(dir, '--only', 'wasm'));
    assert.equal(wasm.code, 0, wasm.stdout);
    assert.doesNotMatch(wasm.stdout, /pyodide/);
  });
});

test('the real scripts/demos/iqg-py/iqg.manifest.json parses with no findings (schema, tolerances, wheels, samples)', async () => {
  const file = 'scripts/demos/iqg-py/iqg.manifest.json';
  const r = fn('parsePyodideManifest')(await readFile(path.join(REPO_ROOT, file), 'utf8'), file, { repos: DOC.repos });
  assert.deepEqual(r.findings, []);
  assert.equal(r.manifest.name, 'iqg');
  assert.equal(lib.PYODIDE_MANIFEST_SCHEMA, 'pyodide-manifest/1');
});

test('extractPyodidePins and extractPyodideFacts read their attributes with lines, ignore comments and mark non-leaves', () => {
  const html = ['<p>one</p>', `<!-- <code data-pyodide-pin="x">${SHA('b').slice(0, 7)}</code> <b data-pyodide-fact="x:sha">z</b> -->`,
    `<p><code data-pyodide-pin="x"> ${S.slice(0, 7)} </code> <span data-pyodide-fact="x:pyodide.version"> 1.2.3 </span></p>`,
    '<p><span data-pyodide-fact="x:packages"><b>numpy</b></span> <i data-pyodide-fact="nocolon">v</i></p>'].join('\n');
  assert.deepEqual(fn('extractPyodidePins')(html, PAGE).map((p) => [p.name, p.sha, p.tag, p.line]), [['x', S.slice(0, 7), 'code', 3]]);
  assert.deepEqual(fn('extractPyodideFacts')(html, PAGE).map((f) => [f.name, f.path, f.text, f.leaf, f.line]),
    [['x', 'pyodide.version', '1.2.3', true, 3], ['x', 'packages', '<b>numpy</b>', false, 4], ['', '', 'v', true, 4]]);
});

// ---------- PYODIDE_MANIFEST ----------
test('PYODIDE_MANIFEST: invalid JSON, wrong schema, name not the stem, unknown repo, short sha, other sources.dir, unlisted entry, wrong tree_url, empty packages, a missing CDN file', async () => {
  await withRoot(miniFiles({ manifest: '{ not json' }), async (dir) => assert.deepEqual(codes(await check(dir)), ['PYODIDE_MANIFEST']));
  const m = manifestOf(), noLock = { ...CDN };
  delete noLock['pyodide-lock.json'];
  for (const over of [{ schema: 'pyodide-manifest/2' }, { name: 'y' }, { repo: 'strivoai' }, { sha: S.slice(0, 7) },
    { sources: { ...m.sources, dir: 'scripts/demos/other-py' } }, { source: { ...m.source, entry: 'app/nope.py' } },
    { source: { ...m.source, tree_url: `https://github.com/BrianKYildirim/image-quality-gate/tree/${SHA('b')}` } },
    { packages: [] }, { pyodide: { ...m.pyodide, files: noLock } }]) {
    await withRoot(miniFiles({ manifest: manifestOf(over) }), async (dir) => {
      const f = await check(dir);
      assert.ok(codes(f).includes('PYODIDE_MANIFEST'), `${JSON.stringify(over).slice(0, 80)}: ${show(f)}`);
      assert.ok(!codes(f).includes('PYODIDE_UNPINNED'), 'an invalid manifest is not used at all');
    });
  }
  const big = JSON.stringify({ ...manifestOf(), pad: 'y'.repeat(lib.MAX_INPUT_BYTES) });
  assert.deepEqual(codes(fn('parsePyodideManifest')(big, MANIFEST, { repos: DOC.repos }).findings), ['INPUT_TOO_LARGE']);
});

test('PYODIDE_MANIFEST: a cdn_base for another version or another host, or a version that is not x.y.z', async () => {
  const py = manifestOf().pyodide;
  for (const pyodide of [{ ...py, cdn_base: 'https://cdn.jsdelivr.net/pyodide/v9.9.9/full/' },
    { ...py, cdn_base: 'https://evil.example/pyodide/v1.2.3/full/' }, { ...py, cdn_base: 'http://cdn.jsdelivr.net/pyodide/v1.2.3/full/' },
    { ...py, version: '1.2', cdn_base: 'https://cdn.jsdelivr.net/pyodide/v1.2/full/' }]) {
    await withRoot(miniFiles({ manifest: manifestOf({ pyodide }) }), async (dir) => {
      assert.deepEqual(codes(await check(dir)), ['PYODIDE_MANIFEST'], JSON.stringify(pyodide.cdn_base));
    });
  }
});

test('PYODIDE_MANIFEST: a tolerance whose measured_max exceeds its bound, with both or neither bound, negative, or without a rationale', async () => {
  const par = manifestOf().parity, t = par.tolerances;
  for (const tolerances of [{ ...t, blur_score: { ...t.blur_score, measured_max: 0.02 } }, { ...t, brightness: { ...t.brightness, measured_max: 0.0100001 } },
    { ...t, brightness: { ...t.brightness, rel: 0.1 } }, { ...t, brightness: { measured_max: 0, rationale: 'r' } },
    { ...t, brightness: { abs: -1, measured_max: 0, rationale: 'r' } }, { ...t, brightness: { ...t.brightness, rationale: ' ' } },
    { ...t, brightness: { ...t.brightness, measured_max: null } }, {}]) {
    await withRoot(miniFiles({ manifest: manifestOf({ parity: { ...par, tolerances } }) }), async (dir) => {
      const f = await check(dir);
      assert.deepEqual(codes(f), ['PYODIDE_MANIFEST'], JSON.stringify(tolerances));
    });
  }
  const exact = { ...t, brightness: { ...t.brightness, measured_max: 0.01 } };
  await withRoot(miniFiles({ manifest: manifestOf({ parity: { ...par, tolerances: exact } }) }), async (dir) => assert.deepEqual(await check(dir), []));
});

test('PYODIDE_MANIFEST: a wheel whose sha256 is not its PyPI digest, or a wheel path outside wheels/', async () => {
  const [[k, w]] = Object.entries(manifestOf().wheels);
  for (const wheels of [{ [k]: { ...w, pypi_sha256: 'c'.repeat(64) } }, { [k]: { ...w, pypi_sha256: undefined } },
    { 'dep-1.0-py3-none-any.whl': w }, { 'wheels/../dep.whl': w }, { 'wheels/dep.zip': w }]) {
    await withRoot(miniFiles({ manifest: manifestOf({ wheels }) }), async (dir) => {
      assert.ok(codes(await check(dir)).includes('PYODIDE_MANIFEST'), JSON.stringify(Object.keys(wheels)));
    });
  }
});

test('PYODIDE_MANIFEST: a parity dir, source_path, file or sample path with "..", a leading "/" or a backslash, or bins out of range', async () => {
  const par = manifestOf().parity, pf = par.files, sample = manifestOf().samples.a;
  for (const over of [{ parity: { ...par, dir: '../outside' } }, { parity: { ...par, dir: '/etc' } }, { parity: { ...par, dir: 'tools\\test' } },
    { parity: { ...par, source_path: '../tests' } }, { parity: { ...par, files: { ...pf, '../../../secret': pf['cases.json'] } } },
    { parity: { ...par, bins: 1 } }, { parity: { ...par, bins: 257 } }, { parity: { ...par, bins: 64.5 } },
    { samples: { a: { ...sample, path: '../a.png' } } }, { samples: { a: { ...sample, content_type: 'text/plain' } } },
    { sources: { dir: DIR, files: { ...entries(SOURCES), '../x.py': entry('') } } }]) {
    await withRoot(miniFiles({ manifest: manifestOf(over) }), async (dir) => {
      const f = await check(dir);
      assert.ok(codes(f).includes('PYODIDE_MANIFEST'), `${JSON.stringify(over).slice(0, 100)}: ${show(f)}`);
      for (const x of f) assert.ok(!x.message.includes(dir), `no absolute path in ${x.message}`);
    });
  }
});

// ---------- PYODIDE_HASH ----------
test('PYODIDE_HASH: a changed byte in a source, a wheel or a parity file, a missing source, and a missing sample', async () => {
  for (const [rel, text] of [[`${DIR}/app/main.py`, 'def run():\n    return 2\n'], [`${DIR}/wheels/dep-1.0-py3-none-any.whl`, 'PK\u0003\u0004 b wheel'],
    [`${PARITY}/golden/a.json`, '{"status": 201}\n'], [`${PARITY}/fixtures/a.png`, '\u0089PNG\r\n fixture b']]) {
    await withRoot({ ...miniFiles(), [rel]: text }, async (dir) => {
      const f = await check(dir);
      assert.deepEqual(codes(f), ['PYODIDE_HASH'], `${rel}: ${show(f)}`);
      assert.ok(f[0].message.startsWith(`${rel}: on disk`), f[0].message);
    });
  }
  for (const rel of [`${DIR}/app/main.py`, SAMPLE]) {
    const files = miniFiles();
    delete files[rel];
    await withRoot(files, async (dir) => {
      const f = await check(dir);
      assert.deepEqual(codes(f), ['PYODIDE_HASH'], rel);
      assert.match(f[0].message, /is listed but missing on disk/);
    });
  }
});

// ---------- PYODIDE_UNLISTED ----------
test('PYODIDE_UNLISTED: an extra file in the manifest directory (top level or below) or in the parity dir', async () => {
  for (const rel of [`${DIR}/extra.py`, `${DIR}/app/services/new.py`, `${DIR}/wheels/other-1.0-py3-none-any.whl`, `${DIR}/y.manifest.json`, `${PARITY}/golden/new.json`]) {
    await withRoot({ ...miniFiles(), [rel]: 'x' }, async (dir) => {
      const f = await check(dir);
      const own = rel.endsWith('y.manifest.json') ? f.filter((x) => x.file === MANIFEST) : f;
      assert.deepEqual(codes(own), ['PYODIDE_UNLISTED'], `${rel}: ${show(f)}`);
      assert.ok(own[0].message.startsWith(rel), own[0].message);
    });
  }
});

// ---------- PYODIDE_SAMPLE ----------
test('PYODIDE_SAMPLE: a sample whose bytes differ from its fixture, whose case is unknown, or whose content type is not the case\'s', async () => {
  await withRoot({ ...miniFiles(), [SAMPLE]: '\u0089PNG\r\n fixture B' }, async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['PYODIDE_SAMPLE']);
    assert.match(f[0].message, /static\/demo\/x\/a\.png: .* but its fixture tools\/test\/fixtures\/x-parity\/fixtures\/a\.png/);
  });
  const sample = manifestOf().samples.a;
  for (const samples of [{ a: { ...sample, case: 'nope' } }, { a: { ...sample, content_type: 'image/jpeg' } }]) {
    await withRoot(miniFiles({ manifest: manifestOf({ samples }) }), async (dir) => assert.deepEqual(codes(await check(dir)), ['PYODIDE_SAMPLE'], JSON.stringify(samples)));
  }
});

// ---------- PYODIDE_SOURCE_MISMATCH ----------
test('PYODIDE_SOURCE_MISMATCH: a vendored source that starts with a UTF-8 BOM', async () => {
  const bommed = `${BOM}${SOURCES['app/main.py']}`, m = manifestOf();
  m.sources.files['app/main.py'] = entry(bommed);
  // The evidence root keeps the BOM (fs utf8 reads do not strip it), so only the BOM rule can fail here.
  await withRoot({ ...miniFiles({ manifest: m, upstream: { 'app/main.py': bommed } }), [`${DIR}/app/main.py`]: bommed }, async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['PYODIDE_SOURCE_MISMATCH'], show(f));
    assert.match(f[0].message, /scripts\/demos\/x-py\/app\/main\.py starts with a UTF-8 BOM/);
  });
});

test('PYODIDE_SOURCE_MISMATCH: a source or parity JSON file whose upstream text differs, or that is missing, at the sha', async () => {
  for (const [upstream, re] of [[{ 'app/main.py': 'def run():\n    return 3\n' }, /app\/main\.py at image-quality-gate@aaaaaaa has sha256/],
    [{ 'app/__init__.py': null }, /app\/__init__\.py is not in image-quality-gate at aaaaaaa/],
    [{ 'tests/parity/golden/a.json': '{"status": 500}\n' }, /tests\/parity\/golden\/a\.json at image-quality-gate@aaaaaaa/],
    [{ 'tests/parity/cases.json': null }, /tests\/parity\/cases\.json is not in image-quality-gate/]]) {
    await withRoot(miniFiles({ upstream }), async (dir) => {
      const f = await check(dir);
      assert.deepEqual(codes(f), ['PYODIDE_SOURCE_MISMATCH'], show(f));
      assert.match(f[0].message, re);
    });
  }
});

test('PYODIDE_SOURCE_MISMATCH: a fixture whose sha256 differs from golden/meta.json at the sha, a meta fixture not vendored, other bins, no meta', async () => {
  for (const [meta, re] of [[metaOf({ fixtures: { 'fixtures/a.png': sha256('other') } }), /fixtures\/a\.png: sha256 .* but tests\/parity\/golden\/meta\.json/],
    [metaOf({ fixtures: { 'fixtures/a.png': sha256(PNG), 'fixtures/b.png': sha256('b') } }), /fixtures\/b\.png is in tests\/parity\/golden\/meta\.json .* not listed/],
    [metaOf({ bins: 32 }), /parity\.bins is 64, but tests\/parity\/golden\/meta\.json .* says 32/]]) {
    // The vendored meta.json and its manifest entry match upstream, so only the meta binding can fail.
    const m = manifestOf();
    m.parity.files['golden/meta.json'] = entry(meta);
    await withRoot({ ...miniFiles({ manifest: m, upstream: { 'tests/parity/golden/meta.json': meta } }), [`${PARITY}/golden/meta.json`]: meta }, async (dir) => {
      const f = await check(dir);
      assert.deepEqual(codes(f), ['PYODIDE_SOURCE_MISMATCH'], show(f));
      assert.match(f[0].message, re);
    });
  }
  await withRoot(miniFiles({ upstream: { 'tests/parity/golden/meta.json': null } }), async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['PYODIDE_SOURCE_MISMATCH', 'PYODIDE_SOURCE_MISMATCH'], show(f));
  });
});

// ---------- Reachability and unreadable upstream: fail closed ----------
test('PIN_UNREACHABLE at the manifest sha line when the commit is not reachable', async () => {
  await withRoot(miniFiles(), async (dir) => {
    const f = await check(dir, { isReachable: async () => ({ state: 'unreachable', ref: 'main', status: 'compare status diverged' }) });
    assert.deepEqual(codes(f), ['PIN_UNREACHABLE']);
    assert.equal(f[0].file, MANIFEST);
    assert.equal(f[0].line, 5);
  });
});

test('COULD_NOT_VERIFY, never a pass: unknown or failed reachability, a readEvidence that cannot read, and no upstream source at all', async () => {
  await withRoot(miniFiles(), async (dir) => {
    for (const isReachable of [async () => ({ state: 'unknown', reason: 'rate limited' }), async () => { throw new Error('boom'); }, async () => undefined]) {
      assert.deepEqual(codes(await check(dir, { isReachable })), ['COULD_NOT_VERIFY']);
    }
    const reads = [];
    const flaky = async (repo, sha, rel) => { reads.push(rel); throw Object.assign(new Error('network error'), { code: 'COULD_NOT_VERIFY' }); };
    const f = await check(dir, { readEvidence: flaky });
    // Every source (2) and parity JSON file (4), plus golden/meta.json again for the fixture binding.
    assert.equal(f.length, 2 + 4 + 1, show(f));
    assert.ok(f.every((x) => x.code === 'COULD_NOT_VERIFY'), show(f));
    assert.equal(reads.length, 7);
    const none = await check(dir, { readEvidence: undefined });
    assert.ok(none.length > 0 && none.every((x) => x.code === 'COULD_NOT_VERIFY'), show(none));
    const big = await check(dir, { readEvidence: async () => { throw Object.assign(new Error('too big'), { code: 'INPUT_TOO_LARGE' }); } });
    assert.ok(big.length > 0 && big.every((x) => x.code === 'INPUT_TOO_LARGE'), show(big));
  });
});

// ---------- Page pins ----------
test('PYODIDE_UNPINNED, PYODIDE_PIN_MISMATCH (a <span>, another sha, not a sha) and PYODIDE_NO_MANIFEST', async () => {
  await withRoot(miniFiles({ page: '<p>no pin</p>' }), async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['PYODIDE_UNPINNED']);
    assert.equal(f[0].file, MANIFEST);
  });
  for (const page of [`<span data-pyodide-pin="x">${S.slice(0, 7)}</span>`, `<code data-pyodide-pin="x">${SHA('b').slice(0, 7)}</code>`,
    '<code data-pyodide-pin="x">abc</code>']) {
    await withRoot(miniFiles({ page }), async (dir) => {
      const f = await check(dir);
      assert.deepEqual(codes(f), ['PYODIDE_PIN_MISMATCH'], page);
      assert.equal(f[0].file, PAGE);
    });
  }
  await withRoot(miniFiles({ page: `${PIN_HTML}<code data-pyodide-pin="nope">${S.slice(0, 7)}</code>` }), async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['PYODIDE_NO_MANIFEST']);
    assert.match(f[0].message, /nope\.manifest\.json, which does not exist/);
  });
});

// ---------- Page facts ----------
test('data-pyodide-fact: the manifest value passes; another text, an unknown path, an object, a missing manifest, a non-leaf or a bad value is PYODIDE_FACT_MISMATCH', async () => {
  const ok = `${PIN_HTML}<p>Pyodide <span data-pyodide-fact="x:pyodide.version">1.2.3</span>, bins <b data-pyodide-fact="x:parity.bins">64</b></p>\n`;
  await withRoot(miniFiles({ page: ok }), async (dir) => assert.deepEqual(await check(dir), []));
  for (const fact of ['<span data-pyodide-fact="x:pyodide.version">1.2.4</span>', '<span data-pyodide-fact="x:pyodide.nope">1.2.3</span>',
    '<span data-pyodide-fact="x:pyodide">1.2.3</span>', '<span data-pyodide-fact="x:packages">numpy</span>',
    '<span data-pyodide-fact="y:pyodide.version">1.2.3</span>', '<span data-pyodide-fact="x:pyodide.version"><b>1.2.3</b></span>',
    '<span data-pyodide-fact="pyodide.version">1.2.3</span>']) {
    await withRoot(miniFiles({ page: `${PIN_HTML}${fact}\n` }), async (dir) => {
      const f = await check(dir);
      assert.deepEqual(codes(f), ['PYODIDE_FACT_MISMATCH'], `${fact}: ${show(f)}`);
      assert.equal(f[0].file, PAGE);
      assert.equal(f[0].line, 2);
      if (fact.includes('<b>')) assert.match(f[0].message, /must be a leaf element/);
    });
  }
  // An element with no closing tag has no text; it is not a leaf, so it cannot match an empty value either.
  await withRoot(miniFiles({ page: `${PIN_HTML}<span data-pyodide-fact="x:pyodide.version">1.2.3\n` }), async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['PYODIDE_FACT_MISMATCH']);
    assert.match(f[0].message, /must be a leaf element/);
  });
});

// ---------- GitHub mode (mocked fetch, no network) ----------
function mockGithub(files, { throws } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (throws) throw throws;
    const u = new URL(url), respond = (status, text) => ({ ok: status >= 200 && status < 300, status, url, headers: new Headers(), body: null, text: async () => text });
    if (u.host === 'raw.githubusercontent.com') {
      const rel = decodeURIComponent(u.pathname.split(`/${S}/`)[1] ?? '');
      return Object.hasOwn(files, rel) ? respond(200, files[rel]) : respond(404, '404: Not Found');
    }
    if (/\/compare\//.test(u.pathname)) return respond(200, JSON.stringify({ status: 'behind' }));
    return respond(200, JSON.stringify({ default_branch: 'main' }));
  };
  return { fetchImpl, calls };
}

test('GitHub mode: upstream read from raw.githubusercontent.com at the sha with no token; a network error is COULD_NOT_VERIFY and the token never appears', async () => {
  await withRoot(miniFiles(), async (dir) => {
    const mock = mockGithub(upstreamOf());
    const src = fn('createSources')('api', { repos: DOC.repos, fetchImpl: mock.fetchImpl, token: TOKEN });
    assert.deepEqual(await check(dir, { isReachable: src.isReachable, readEvidence: src.readEvidence }), []);
    const raw = mock.calls.filter((c) => new URL(c.url).host === 'raw.githubusercontent.com');
    assert.equal(raw.length, 6);
    assert.ok(raw.every((c) => !('Authorization' in c.headers) && c.url.includes(`/image-quality-gate/${S}/`)));
    const changed = mockGithub(upstreamOf({ 'app/main.py': 'tampered\n' }));
    const s2 = fn('createSources')('api', { repos: DOC.repos, fetchImpl: changed.fetchImpl, token: TOKEN });
    assert.deepEqual(codes(await check(dir, { isReachable: s2.isReachable, readEvidence: s2.readEvidence })), ['PYODIDE_SOURCE_MISMATCH']);
    const down = mockGithub({}, { throws: new TypeError(`fetch failed for ${TOKEN}`) });
    const s3 = fn('createSources')('api', { repos: DOC.repos, fetchImpl: down.fetchImpl, token: TOKEN });
    const f = await check(dir, { isReachable: s3.isReachable, readEvidence: s3.readEvidence });
    assert.ok(f.length > 0 && f.every((x) => x.code === 'COULD_NOT_VERIFY'), show(f));
    const out = f.map(lib.formatFinding).join('\n');
    assert.ok(!out.includes(TOKEN) && !out.includes('Bearer'), out);
  });
});

test('GitHub mode: one transient raw server error (the empty-blob HTTP 501) is retried once; a persistent one is COULD_NOT_VERIFY', async () => {
  const flaky = (failures) => {
    const inner = mockGithub(upstreamOf()), left = { n: failures }, calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(url);
      if (url.endsWith(`/${S}/app/__init__.py`) && left.n-- > 0) return { ok: false, status: 501, url, headers: new Headers(), body: null, text: async () => '' };
      return inner.fetchImpl(url, init);
    };
    return { src: fn('createSources')('api', { repos: DOC.repos, fetchImpl }), calls };
  };
  await withRoot(miniFiles(), async (dir) => {
    const once = flaky(1);
    assert.deepEqual(await check(dir, { isReachable: once.src.isReachable, readEvidence: once.src.readEvidence }), []);
    assert.equal(once.calls.filter((u) => u.endsWith('/app/__init__.py')).length, 2);
    const always = flaky(Infinity);
    const f = await check(dir, { isReachable: always.src.isReachable, readEvidence: always.src.readEvidence });
    assert.deepEqual(codes(f), ['COULD_NOT_VERIFY']);
    assert.match(f[0].message, /app\/__init__\.py: HTTP 501/);
    assert.equal(always.calls.filter((u) => u.endsWith('/app/__init__.py')).length, 2);
  });
});

// ---------- CLI and --project ----------
test('CLI --only pyodide: exit 1 with a finding line when a vendored byte changes', async () => {
  await withRoot({ ...miniFiles(), [`${DIR}/app/main.py`]: 'changed\n' }, async (dir) => {
    const r = await cli(cliArgs(dir, '--only', 'pyodide'));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] scripts\/demos\/x-py\/x\.manifest\.json:\d+ PYODIDE_HASH scripts\/demos\/x-py\/app\/main\.py: on disk/m);
    assert.match(r.stdout, /^\[check-claims\] 1 finding\(s\)$/m);
  });
});

test('CLI --project: image-quality-gate checks the manifest, ratelimit-cpp skips it; an unreadable manifest is reported whatever the scope', async () => {
  await withRoot({ ...miniFiles(), [`${DIR}/app/main.py`]: 'changed\n', 'pages/projects/rate-limiter.html': '<p>rl</p>' }, async (dir) => {
    const iqg = await cli(cliArgs(dir, '--only', 'pyodide', '--project', 'image-quality-gate'));
    assert.equal(iqg.code, 1, iqg.stdout);
    assert.match(iqg.stdout, / PYODIDE_HASH /);
    const rl = await cli(cliArgs(dir, '--only', 'pyodide', '--project', 'ratelimit-cpp'));
    assert.equal(rl.code, 0, rl.stdout);
    assert.match(rl.stdout, /, 0 pyodide manifest\(s\)\)$/m);
  });
  await withRoot(miniFiles({ manifest: '{ not json' }), async (dir) => {
    const rl = await cli(cliArgs(dir, '--only', 'pyodide', '--project', 'ratelimit-cpp'));
    assert.equal(rl.code, 1, rl.stdout);
    assert.match(rl.stdout, /^\[check-claims\] scripts\/demos\/x-py\/x\.manifest\.json:1 PYODIDE_MANIFEST not valid JSON/m);
  });
});
