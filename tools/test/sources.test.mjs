// Tests of the upstream sources (D-19): API mode against a mocked fetch, --local mode against a mocked execFile
// (plus one real git call on a non-repo), the evidence-root fixture seam, checkEvidence and fillValues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '../claims-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'check-claims.mjs');
const BASIC = path.join(HERE, 'fixtures', 'basic');
const EVIDENCE = path.join(BASIC, 'evidence');
const MD_CLAIMS = path.join(HERE, 'fixtures', 'md', 'claims.md.json');
const fn = (name) => { assert.equal(typeof lib[name], 'function', `claims-lib.mjs exports ${name}`); return lib[name]; };
const SHA = (c) => c.repeat(40);
const REPOS = { 'ratelimit-cpp': { owner: 'BrianKYildirim', default_branch: 'main', local: '../ratelimit-cpp' } };
const codes = (fs) => fs.map((f) => f.code);

async function withDir(body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sources-'));
  try { return await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, GITHUB_TOKEN: '' } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

// A mocked fetch: files maps a URL path to a body (string), a status number, or an Error to throw.
function mockFetch(files = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const p = new URL(url).pathname;
    const spec = p === '/repos/BrianKYildirim/ratelimit-cpp' ? JSON.stringify({ default_branch: 'main' }) : files[p] ?? 404;
    if (spec instanceof Error) throw spec;
    const status = typeof spec === 'number' ? spec : 200;
    return { ok: status === 200, status, url, headers: new Headers(), body: null, text: async () => (typeof spec === 'string' ? spec : '') };
  };
  return { fetchImpl, calls };
}
// A mocked execFile: answer(args) -> { code, stdout, stderr }.
function mockGit(answer) {
  const calls = [];
  const execFileImpl = async (file, args) => { calls.push({ file, args }); return answer(args); };
  return { execFileImpl, calls };
}

// ---------- Sources ----------
test('api: readReadme reads README.md at the default branch from raw.githubusercontent.com; readEvidence reads at the SHA', async () => {
  const p = `/BrianKYildirim/ratelimit-cpp/${SHA('1')}/bench/results/2026 run/summary.json`;
  const mock = mockFetch({ '/BrianKYildirim/ratelimit-cpp/main/README.md': '# readme\n', [encodeURI(p)]: '{"a":1}' });
  const src = fn('createSources')('api', { repos: REPOS, fetchImpl: mock.fetchImpl, token: 'tok' });
  assert.equal(await src.readReadme('ratelimit-cpp'), '# readme\n');
  assert.equal(await src.readEvidence('ratelimit-cpp', SHA('1'), 'bench/results/2026 run/summary.json'), '{"a":1}');
  const raw = mock.calls.filter((c) => new URL(c.url).host === 'raw.githubusercontent.com');
  assert.equal(raw.length, 2);
  for (const c of raw) assert.equal(c.headers.Authorization, undefined, 'the token is not sent to raw.githubusercontent.com');
  await assert.rejects(src.readEvidence('ratelimit-cpp', SHA('1'), 'missing.json'), { code: 'NOT_FOUND' });
});

test('api: a server error or a thrown fetch rejects COULD_NOT_VERIFY; a body above MAX_INPUT_BYTES rejects INPUT_TOO_LARGE', async () => {
  const base = `/BrianKYildirim/ratelimit-cpp/${SHA('1')}`;
  const mock = mockFetch({ [`${base}/a.json`]: 503, [`${base}/b.json`]: new TypeError('fetch failed'),
    [`${base}/big.json`]: 'x'.repeat(lib.MAX_INPUT_BYTES + 1) });
  const src = fn('createSources')('api', { repos: REPOS, fetchImpl: mock.fetchImpl });
  await assert.rejects(src.readEvidence('ratelimit-cpp', SHA('1'), 'a.json'), { code: 'COULD_NOT_VERIFY' });
  await assert.rejects(src.readEvidence('ratelimit-cpp', SHA('1'), 'b.json'), { code: 'COULD_NOT_VERIFY' });
  await assert.rejects(src.readEvidence('ratelimit-cpp', SHA('1'), 'big.json'), { code: 'INPUT_TOO_LARGE' });
});

test('local: readReadme reads <dir>/<repo>/README.md from the working tree; readEvidence runs git show <sha>:<path> with an argument array', async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, 'ratelimit-cpp'));
    await writeFile(path.join(dir, 'ratelimit-cpp', 'README.md'), 'working tree\n');
    const git = mockGit(() => ({ code: 0, stdout: Buffer.from('{"b":2}'), stderr: '' }));
    const src = fn('createSources')('local', { dir, repos: REPOS, execFileImpl: git.execFileImpl });
    assert.equal(await src.readReadme('ratelimit-cpp'), 'working tree\n');
    assert.equal(await src.readEvidence('ratelimit-cpp', SHA('1'), 'bench/results/x/summary.json'), '{"b":2}');
    assert.deepEqual(git.calls, [{ file: 'git', args: ['-C', path.join(dir, 'ratelimit-cpp'), 'show', `${SHA('1')}:bench/results/x/summary.json`] }]);
    await writeFile(path.join(dir, 'ratelimit-cpp', 'README.md'), 'x'.repeat(lib.MAX_INPUT_BYTES + 1));
    await assert.rejects(src.readReadme('ratelimit-cpp'), { code: 'INPUT_TOO_LARGE' });
  });
});

test('local: git show of a missing path rejects NOT_FOUND, an oversized blob INPUT_TOO_LARGE, any other failure COULD_NOT_VERIFY', async () => {
  const answers = {
    'a.json': { code: 128, stdout: Buffer.alloc(0), stderr: `fatal: path 'a.json' does not exist in '${SHA('1')}'` },
    'b.json': { code: null, stdout: Buffer.alloc(0), stderr: '', tooLarge: true },
    'c.json': { code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: not a git repository' },
  };
  const git = mockGit((args) => answers[args[3].split(':')[1]]);
  const src = fn('createSources')('local', { dir: 'C:/x', repos: REPOS, execFileImpl: git.execFileImpl });
  await assert.rejects(src.readEvidence('ratelimit-cpp', SHA('1'), 'a.json'), { code: 'NOT_FOUND' });
  await assert.rejects(src.readEvidence('ratelimit-cpp', SHA('1'), 'b.json'), { code: 'INPUT_TOO_LARGE' });
  await assert.rejects(src.readEvidence('ratelimit-cpp', SHA('1'), 'c.json'), { code: 'COULD_NOT_VERIFY' });
});

test('local: reachability is git merge-base --is-ancestor <sha> <ref>: exit 0 reachable, 1 unreachable, anything else unknown', async () => {
  const exits = { [SHA('1')]: 0, [SHA('2')]: 1, [SHA('3')]: 128 };
  const git = mockGit((args) => ({ code: exits[args[4]], stdout: Buffer.alloc(0), stderr: '' }));
  const src = fn('createSources')('local', { dir: 'C:/x', ref: 'origin/main', repos: REPOS, execFileImpl: git.execFileImpl });
  assert.equal((await src.isReachable('ratelimit-cpp', SHA('1'))).state, 'reachable');
  assert.equal((await src.isReachable('ratelimit-cpp', SHA('2'))).state, 'unreachable');
  assert.equal((await src.isReachable('ratelimit-cpp', SHA('3'))).state, 'unknown');
  assert.deepEqual(git.calls[0], { file: 'git', args: ['-C', path.join('C:/x', 'ratelimit-cpp'), 'merge-base', '--is-ancestor', SHA('1'), 'origin/main'] });
  const pins = [SHA('1'), SHA('2'), SHA('3')].map((sha, i) => ({ repo: 'ratelimit-cpp', sha, file: 'p.html', line: i + 1, kind: 'short' }));
  assert.deepEqual(codes(await fn('checkPins')(pins, { isReachable: src.isReachable })), ['PIN_UNREACHABLE', 'COULD_NOT_VERIFY']);
  const head = mockGit(() => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }));
  await fn('createSources')('local', { dir: 'C:/x', repos: REPOS, execFileImpl: head.execFileImpl }).isReachable('ratelimit-cpp', SHA('1'));
  assert.equal(head.calls[0].args.at(-1), 'HEAD', '--local-ref defaults to HEAD');
  assert.throws(() => fn('createSources')('local', { dir: 'C:/x', ref: '--upload-pack=x', repos: REPOS }), /ref/);
});

test('local: the default execFile runs the real git, and a directory that is not a clone is unknown, not reachable', async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, 'ratelimit-cpp'));
    const src = fn('createSources')('local', { dir, repos: REPOS });
    const r = await src.isReachable('ratelimit-cpp', SHA('1'));
    assert.equal(r.state, 'unknown', JSON.stringify(r));
  });
});

test('evidence-root: evidence is read below the root (never outside it); a SHA is reachable when <root>/<repo>/<sha>/ exists', async () => {
  const src = fn('createSources')('evidence-root', { dir: EVIDENCE });
  const text = await src.readEvidence('ratelimit-cpp', SHA('0').slice(0, 39) + '1', 'bench/results/2026-01-01-0000000/ubuntu-wsl2/summary.json');
  assert.match(text, /bench-summary\/1/);
  await assert.rejects(src.readEvidence('ratelimit-cpp', SHA('1'), '../../x'));
  assert.equal((await src.isReachable('ratelimit-cpp', `${'0'.repeat(39)}1`)).state, 'reachable');
  assert.equal((await src.isReachable('ratelimit-cpp', `${'0'.repeat(39)}2`)).state, 'reachable');
  assert.equal((await src.isReachable('ratelimit-cpp', SHA('9'))).state, 'unreachable');
  await assert.rejects(src.readReadme('ratelimit-cpp'), { code: 'NO_SOURCE' });
});

// ---------- checkEvidence ----------
const SUMMARY = (stats) => JSON.stringify({ schema: 'bench-summary/1', rl_bench: { BM: { wall_ops_s: stats } } });
const STATS = { n: 10, median: 36312345.6, min: 31012345, max: 37287654, p25: 35500000, p75: 36900000,
  pooled_p25: 35000000, pooled_p75: 37000000, unit: 'calls/s', measure: 'throughput', build: 'uninstrumented' };
const DIR = 'bench/results/2026-01-01-0000000/windows-native';
function pointerClaim(over = {}) {
  return { id: 'rl.t.p', project: 'ratelimit-cpp', kind: 'throughput', status: 'approved', approved_by: 'o', approved_on: '2026-01-02',
    statement: 's', value: 36312345.6, unit: 'calls/s', stat: 'median', n: 10, spread: { kind: 'min-max', low: 31012345, high: 37287654 },
    measure: 'throughput', build: 'uninstrumented', environment: 'windows-native',
    evidence: { repo: 'ratelimit-cpp', sha: SHA('1'), path: `${DIR}/summary.json`, pointer: '/rl_bench/BM/wall_ops_s' },
    source_sha: SHA('2'), display: { value: ['36.3M'] }, label_required: null, ...over };
}
function patternClaim(over = {}) {
  return { id: 'rl.t.tests', project: 'ratelimit-cpp', kind: 'test_count', status: 'approved', approved_by: 'o', approved_on: '2026-01-02',
    statement: 's', value: 54, unit: 'tests', evidence: { repo: 'ratelimit-cpp', sha: SHA('1'), path: 'ctest.log', pattern: String.raw`(\d+) tests passed` },
    source_sha: SHA('2'), display: { value: ['54'] }, label_required: null, ...over };
}
// Mock sources over a map of `${sha}:${path}` -> text and a set of reachable SHAs.
function mockSources(files, { reachable = [SHA('1'), SHA('2')], unknown = [] } = {}) {
  const reads = [];
  return {
    reads,
    readEvidence: async (repo, sha, p) => {
      reads.push(`${sha}:${p}`);
      if (Object.hasOwn(files, `${sha}:${p}`)) return files[`${sha}:${p}`];
      throw Object.assign(new Error(`no ${p}`), { code: 'NOT_FOUND' });
    },
    isReachable: async (repo, sha) => (unknown.includes(sha) ? { state: 'unknown', reason: 'offline' }
      : reachable.includes(sha) ? { state: 'reachable', ref: 'main', status: 'ok' } : { state: 'unreachable', ref: 'main', status: 'compare status diverged' }),
  };
}
const GOOD = { [`${SHA('1')}:${DIR}/summary.json`]: SUMMARY(STATS), [`${SHA('1')}:${DIR}/meta.json`]: JSON.stringify({ source: { sha: SHA('2') } }),
  [`${SHA('1')}:ctest.log`]: '100% tests passed, 0 tests failed out of 54\n54 tests passed\n' };
const docOf = (...claims) => ({ repos: REPOS, claims });
const evidence = (doc, sources, opts) => fn('checkEvidence')(doc, sources, opts);

test('checkEvidence: a pointer claim whose evidence and meta agree, and a pattern claim whose capture equals value, pass', async () => {
  assert.deepEqual(await evidence(docOf(pointerClaim(), patternClaim()), mockSources(GOOD)), []);
});

test('checkEvidence: evidence.sha and source_sha go through reachability: unreachable fails PIN_UNREACHABLE, unknown COULD_NOT_VERIFY', async () => {
  const doc = docOf(pointerClaim());
  const text = JSON.stringify(doc, null, 2), line = text.split('\n').findIndex((l) => l.includes('"id": "rl.t.p"')) + 1;
  const orphaned = await evidence(doc, mockSources(GOOD, { reachable: [SHA('2')] }), { text, file: 'bench/claims.json' });
  assert.deepEqual(orphaned.map((f) => [f.code, f.file, f.line]), [['PIN_UNREACHABLE', 'bench/claims.json', line]]);
  assert.match(orphaned[0].message, /rl\.t\.p: evidence\.sha 1111111 is not reachable from main/);
  const offline = await evidence(doc, mockSources(GOOD, { unknown: [SHA('2')] }));
  assert.deepEqual(codes(offline), ['COULD_NOT_VERIFY']);
  assert.match(offline[0].message, /source_sha 2222222/);
});

test('checkEvidence: meta.json next to summary.json must name source_sha (EVIDENCE_SOURCE_SHA); stats must carry the claim measure and build (EVIDENCE_LABEL)', async () => {
  const wrongMeta = { ...GOOD, [`${SHA('1')}:${DIR}/meta.json`]: JSON.stringify({ source: { sha: SHA('3') } }) };
  assert.deepEqual(codes(await evidence(docOf(pointerClaim()), mockSources(wrongMeta))), ['EVIDENCE_SOURCE_SHA']);
  const noMeta = { ...GOOD };
  delete noMeta[`${SHA('1')}:${DIR}/meta.json`];
  assert.deepEqual(codes(await evidence(docOf(pointerClaim()), mockSources(noMeta))), ['EVIDENCE_SOURCE_SHA']);
  const labels = await evidence(docOf(pointerClaim({ measure: 'per_op_latency', build: 'instrumented:x', label_required: 'x' })), mockSources(GOOD));
  assert.deepEqual(codes(labels), ['EVIDENCE_LABEL', 'EVIDENCE_LABEL']);
  const said = labels.map((f) => f.message).join('\n');
  assert.match(said, /measure throughput/);
  assert.match(said, /build uninstrumented/);
});

test('checkEvidence: a missing summary, invalid JSON or a pointer that does not resolve to a stats object fails EVIDENCE_POINTER', async () => {
  const missing = pointerClaim({ evidence: { ...pointerClaim().evidence, path: `${DIR}/nope.json` } });
  const bad = pointerClaim({ evidence: { ...pointerClaim().evidence, pointer: '/rl_bench/Nope/wall_ops_s' } });
  const notJson = { ...GOOD, [`${SHA('1')}:${DIR}/summary.json`]: '{not json' };
  assert.deepEqual(codes(await evidence(docOf(missing), mockSources(GOOD))), ['EVIDENCE_POINTER']);
  assert.deepEqual(codes(await evidence(docOf(bad), mockSources(GOOD))), ['EVIDENCE_POINTER']);
  assert.deepEqual(codes(await evidence(docOf(pointerClaim()), mockSources(notJson))), ['EVIDENCE_POINTER']);
});

test('checkEvidence: a pattern claim fails EVIDENCE_PATTERN when its capture differs from value or does not match', async () => {
  assert.deepEqual(codes(await evidence(docOf(patternClaim({ value: 55 })), mockSources(GOOD))), ['EVIDENCE_PATTERN']);
  const noMatch = patternClaim({ evidence: { ...patternClaim().evidence, pattern: String.raw`(\d+) widgets` } });
  assert.deepEqual(codes(await evidence(docOf(noMatch), mockSources(GOOD))), ['EVIDENCE_PATTERN']);
});

test('checkEvidence: retired claims and (with project) other projects are skipped; an oversized fetched file is INPUT_TOO_LARGE', async () => {
  assert.deepEqual(await evidence(docOf(pointerClaim({ status: 'retired', source_sha: SHA('9') })), mockSources(GOOD)), []);
  assert.deepEqual(await evidence(docOf(pointerClaim({ project: 'other', source_sha: SHA('9') })), mockSources(GOOD), { project: 'ratelimit-cpp' }), []);
  const p = `/BrianKYildirim/ratelimit-cpp/${SHA('1')}/${DIR}/summary.json`;
  const api = fn('createSources')('api', { repos: REPOS, fetchImpl: mockFetch({ [p]: 'x'.repeat(lib.MAX_INPUT_BYTES + 1) }).fetchImpl });
  const big = await evidence(docOf(pointerClaim()), { ...api, isReachable: async () => ({ state: 'reachable', ref: 'main', status: 'ok' }) });
  assert.deepEqual(codes(big), ['INPUT_TOO_LARGE']);
});

// ---------- fillValues ----------
test('fillValues copies value, n and spread from evidence into proposed entries, for each spread kind', async () => {
  const read = mockSources(GOOD).readEvidence;
  const blank = { value: 0, n: 1, status: 'proposed', approved_by: null, approved_on: null };
  const doc = docOf(pointerClaim({ id: 'a', ...blank }), pointerClaim({ id: 'b', ...blank, spread: { kind: 'p25-p75', low: 0, high: 0 } }),
    pointerClaim({ id: 'c', ...blank, stat: 'p25', spread: { kind: 'pooled-p25-p75', low: 0, high: 0 } }));
  const r = await fn('fillValues')(doc, read);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.changed, [0, 1, 2]);
  assert.deepEqual(r.doc.claims.map((c) => [c.value, c.n, c.spread]), [
    [36312345.6, 10, { kind: 'min-max', low: 31012345, high: 37287654 }],
    [36312345.6, 10, { kind: 'p25-p75', low: 35500000, high: 36900000 }],
    [35500000, 10, { kind: 'pooled-p25-p75', low: 35000000, high: 37000000 }]]);
  assert.equal(r.doc.claims[0].status, 'proposed');
  assert.equal(r.doc.claims[0].approved_by, null);
  assert.equal(doc.claims[0].value, 0, 'the input document is not mutated');
});

test('fillValues never modifies an approved or retired entry, even when its evidence disagrees (D-02)', async () => {
  const approved = pointerClaim({ id: 'a', value: 1, n: 3 }), retired = pointerClaim({ id: 'r', status: 'retired', value: 2 });
  const before = [JSON.stringify(approved), JSON.stringify(retired)];
  const r = await fn('fillValues')(docOf(approved, retired), mockSources(GOOD).readEvidence);
  assert.deepEqual(r.changed, []);
  assert.equal(r.doc.claims[0], approved);
  assert.equal(r.doc.claims[1], retired);
  assert.deepEqual([JSON.stringify(r.doc.claims[0]), JSON.stringify(r.doc.claims[1])], before);
});

test('fillValues reports evidence it cannot read and leaves that entry unchanged', async () => {
  const p = pointerClaim({ status: 'proposed', approved_by: null, approved_on: null, value: 0, evidence: { ...pointerClaim().evidence, path: `${DIR}/nope.json` } });
  const r = await fn('fillValues')(docOf(p), mockSources(GOOD).readEvidence);
  assert.deepEqual(codes(r.findings), ['EVIDENCE_POINTER']);
  assert.deepEqual(r.changed, []);
  assert.equal(r.doc.claims[0].value, 0);
});

test('CLI --fill-values rewrites only proposed entries (2-space JSON, LF, temp then rename) and re-runs the schema check', async () => {
  await withDir(async (dir) => {
    // LF first: an autocrlf checkout may give this fixture CRLF, and the replacements below are LF.
    const original = (await readFile(MD_CLAIMS, 'utf8')).replace(/\r\n/g, '\n');
    const file = path.join(dir, 'claims.json');
    // Hand-typed values: a wrong proposed value (fixed) and a wrong approved value (must stay).
    const typed = original.replace('"value": 44512345.6,\n      "unit": "calls/s",\n      "stat": "median",\n      "n": 10,\n      "spread": {\n        "kind": "min-max",\n        "low": 41512345,\n        "high": 45187654\n      },\n      "measure": "throughput",\n      "build": "uninstrumented",\n      "environment": "windows-native",\n      "evidence": {\n        "repo": "ratelimit-cpp",\n        "sha": "0000000000000000000000000000000000000001",\n        "path": "bench/results/2026-01-01-0000000/windows-native/summary.json",\n        "pointer": "/rl_bench/BM_Hot_Denied.t1/wall_ops_s"\n      },\n      "source_sha": "0000000000000000000000000000000000000002",\n      "display": {\n        "value": [\n          "44.5M"\n        ]\n      }',
      '"value": 44512345.0,\n      "unit": "calls/s",\n      "stat": "median",\n      "n": 9,\n      "spread": {\n        "kind": "min-max",\n        "low": 1,\n        "high": 2\n      },\n      "measure": "throughput",\n      "build": "uninstrumented",\n      "environment": "windows-native",\n      "evidence": {\n        "repo": "ratelimit-cpp",\n        "sha": "0000000000000000000000000000000000000001",\n        "path": "bench/results/2026-01-01-0000000/windows-native/summary.json",\n        "pointer": "/rl_bench/BM_Hot_Denied.t1/wall_ops_s"\n      },\n      "source_sha": "0000000000000000000000000000000000000002",\n      "display": {\n        "value": [\n          "44.5M"\n        ]\n      }')
      .replace('"value": 10.21,', '"value": 10.2,');
    assert.notEqual(typed, original);
    await writeFile(file, typed);
    const r = await cli(['--fill-values', '--claims', file, '--evidence-root', EVIDENCE]);
    const after = await readFile(file, 'utf8');
    assert.equal(after, typed.replace('"value": 44512345.0,', '"value": 44512345.6,').replace('"n": 9,', '"n": 10,')
      .replace('"low": 1,\n        "high": 2', '"low": 41512345,\n        "high": 45187654'), 'only the proposed entry changed');
    assert.ok(!after.includes('\r'), 'LF line endings');
    assert.match(after, /"value": 10\.2,/, 'the approved entry keeps its (wrong) value');
    assert.match(r.stdout, /filled 1 proposed claim/);
    assert.deepEqual(await readdir(dir), ['claims.json'], 'no temp file is left behind');
    assert.equal(r.code, 0, r.stdout);
  });
});

test('spliceClaims rewrites only the named entries and keeps every other byte, including compact entries and CRLF', () => {
  const text = '{\r\n  "repos": { "a": { "owner": "o" } },\r\n  "claims": [\r\n    { "id": "kept", "value": 1, "nested": { "s": "}]\\"" } },\r\n'
    + '    {\r\n      "id": "filled",\r\n      "value": 0\r\n    }\r\n  ]\r\n}\r\n';
  const doc = JSON.parse(text);
  doc.claims[1] = { ...doc.claims[1], value: 2.5 };
  const out = fn('spliceClaims')(text, doc, [1]);
  assert.equal(out, text.replace('"value": 0', '"value": 2.5'));
  assert.throws(() => fn('spliceClaims')(text, { ...doc, claims: [doc.claims[0]] }, [1]), /not found|parse back/);
});

// ---------- CLI ----------
test('CLI: the default run includes evidence and pins; --local-ref needs --local; --local and --evidence-root exclude each other; --project must be a repo', async () => {
  const unknown = await cli(['--only', 'nope', '--claims', MD_CLAIMS]);
  assert.match(unknown.stdout, /known: .*evidence, pins/);
  assert.equal((await cli(['--local-ref', 'main', '--claims', MD_CLAIMS, '--only', 'claims'])).code, 2);
  assert.equal((await cli(['--local', '..', '--evidence-root', EVIDENCE, '--claims', MD_CLAIMS, '--only', 'claims'])).code, 2);
  const stray = await cli(['--project', 'nope', '--claims', MD_CLAIMS, '--evidence-root', EVIDENCE, '--only', 'claims']);
  assert.equal(stray.code, 2);
  assert.match(stray.stdout, /--project "nope" is not a key of repos/);
});

test('CLI --only evidence: the basic fixture passes; a meta.json naming another source SHA fails EVIDENCE_SOURCE_SHA', async () => {
  const ok = await cli(['--root', BASIC, '--claims', path.join(BASIC, 'claims.json'), '--evidence-root', EVIDENCE, '--only', 'evidence']);
  assert.equal(ok.code, 0, ok.stdout);
  await withDir(async (dir) => {
    await cp(BASIC, dir, { recursive: true });
    const meta = path.join(dir, 'evidence', 'ratelimit-cpp', `${'0'.repeat(39)}1`, 'bench', 'results', '2026-01-01-0000000', 'ubuntu-wsl2', 'meta.json');
    await writeFile(meta, (await readFile(meta, 'utf8')).replace(`${'0'.repeat(39)}2`, `${'0'.repeat(39)}3`));
    const r = await cli(['--root', dir, '--claims', path.join(dir, 'claims.json'), '--evidence-root', path.join(dir, 'evidence'), '--only', 'evidence']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] claims\.json:\d+ EVIDENCE_SOURCE_SHA rl\.fixture\.hot_denied\.t8: /m);
  });
});

test('CLI --project limits the HTML and JS scans to that project\'s partials and scripts/demos/<data-demo key>*.js', async () => {
  await withDir(async (dir) => {
    const files = {
      'pages/projects/rate-limiter.html': '<div class="demo" data-demo="ratelimit"></div>\n<p>about 30 ms</p>\n',
      'pages/projects/kv-server.html': '<div class="demo" data-demo="kv"></div>\n<p>about 40 ms</p>\n',
      'pages/about.html': '<p>about 50 ms</p>\n',
      'scripts/demos/ratelimit-core.js': "const a = '10 s';\n",
      'scripts/demos/kv.js': "const b = '20 s';\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
    const r = await cli(['--root', dir, '--claims', MD_CLAIMS, '--evidence-root', EVIDENCE, '--only', 'html,js', '--project', 'ratelimit-cpp']);
    assert.equal(r.code, 1, r.stdout);
    const lines = r.stdout.trim().split('\n').slice(0, -1);
    assert.deepEqual(lines.map((l) => /\] (\S+):/.exec(l)[1]), ['pages/projects/rate-limiter.html', 'scripts/demos/ratelimit-core.js']);
  });
});
