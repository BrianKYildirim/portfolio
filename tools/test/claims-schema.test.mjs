// Schema, approval (D-02) and D-14 comparison-rule tests for tools/claims-lib.mjs, plus the CLI's --only claims run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAIM_KINDS, PERF_KINDS, MEASURES, STATUSES, ID_RE, MAX_INPUT_BYTES, validateClaims, checkComparison, loadClaims,
  resolvePointer, parseDisplayNumber, matchesDisplay, extractTaggedLeaves, checkTagged, sortFindings, formatFinding } from '../claims-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const CLI = path.join(ROOT, 'tools', 'check-claims.mjs');
const SHA = 'a'.repeat(40);
const ENVIRONMENTS = { 'windows-native': { label: 'Windows 11, native' }, 'ubuntu-wsl2': { label: 'Ubuntu on WSL2' } };

const doc = (claims) => ({
  schema_version: 1,
  repos: { 'ratelimit-cpp': { owner: 'BrianKYildirim', default_branch: 'main', local: '../ratelimit-cpp' } },
  page_repos: { 'rate-limiter': 'ratelimit-cpp' },
  environments: ENVIRONMENTS,
  tables: [],
  claims,
});
const perf = (over = {}) => ({
  id: 'rl.a', project: 'ratelimit-cpp', kind: 'throughput', status: 'proposed', approved_by: null, approved_on: null,
  statement: 'One hot key, 8 threads', value: 153012345.6, unit: 'calls/s', stat: 'median', n: 10,
  spread: { kind: 'min-max', low: 128000000, high: 162000000 }, measure: 'throughput', build: 'uninstrumented',
  environment: 'ubuntu-wsl2',
  evidence: { repo: 'ratelimit-cpp', sha: SHA, path: 'bench/results/2026-01-01-0000000/ubuntu-wsl2/summary.json', pointer: '/rl_bench/x/wall_ops_s' },
  source_sha: SHA, display: { value: ['153.0M'] }, label_required: null, ...over,
});
const fact = (over = {}) => ({
  id: 'rl.slot_bytes', project: 'ratelimit-cpp', kind: 'design_fact', status: 'proposed', approved_by: null, approved_on: null,
  statement: 'Each slot is 64 bytes', value: 64, unit: 'bytes', stat: 'value',
  evidence: { repo: 'ratelimit-cpp', sha: SHA, path: 'src/inproc_rate_limiter.cpp', pattern: String.raw`struct alignas\((\d+)\) Slot` },
  source_sha: SHA, display: { value: ['64-byte'] }, label_required: null, ...over,
});
const codes = (findings) => findings.map((f) => f.code);
const without = (obj, key) => { const c = { ...obj }; delete c[key]; return c; };

// ---------- Constants ----------
test('kind, measure and status vocabularies match the claims.json contract', () => {
  assert.deepEqual([...CLAIM_KINDS], ['latency', 'throughput', 'memory', 'ratio', 'comparison', 'design_fact', 'test_count', 'observation']);
  assert.deepEqual([...PERF_KINDS], ['latency', 'throughput', 'memory', 'ratio', 'comparison', 'observation']);
  assert.deepEqual([...MEASURES], ['per_op_latency', 'amortized_per_op', 'throughput', 'heap_bytes', 'derived_ratio', 'request_wall_time']);
  assert.deepEqual([...STATUSES], ['proposed', 'approved', 'retired']);
  assert.ok(ID_RE.test('rl.hot_denied.t8-ubuntu'));
  assert.ok(!ID_RE.test('rl.A') && !ID_RE.test('Rl.a') && !ID_RE.test('.rl') && !ID_RE.test(''));
});

// ---------- Top level ----------
test('an empty claims array validates', () => {
  assert.deepEqual(validateClaims(doc([])), []);
});

test('the real bench/claims.json validates', async () => {
  const text = await readFile(path.join(ROOT, 'bench', 'claims.json'), 'utf8');
  assert.deepEqual(validateClaims(JSON.parse(text), { text }), []);
});

test('a well-formed performance claim and a well-formed design fact validate', () => {
  assert.deepEqual(validateClaims(doc([perf(), fact()])), []);
});

test('a wrong schema_version or a missing top-level key fails SCHEMA_FIELD naming it', () => {
  const v2 = validateClaims({ ...doc([]), schema_version: 2 });
  assert.ok(v2.some((f) => f.code === 'SCHEMA_FIELD' && f.message.includes('schema_version')));
  for (const key of ['repos', 'page_repos', 'environments', 'tables', 'claims']) {
    const f = validateClaims(without(doc([]), key));
    assert.ok(f.some((x) => x.code === 'SCHEMA_FIELD' && x.message.includes(key)), key);
  }
});

// ---------- Ids ----------
test('two claims with id rl.a fail SCHEMA_DUPLICATE_ID', () => {
  assert.ok(codes(validateClaims(doc([perf(), perf()]))).includes('SCHEMA_DUPLICATE_ID'));
});

test('rl.A and Rl.a fail the id regex, and ids compare case-sensitively (no duplicate with rl.a)', () => {
  for (const id of ['rl.A', 'Rl.a']) {
    const f = validateClaims(doc([perf(), perf({ id })]));
    assert.ok(f.some((x) => x.code === 'SCHEMA_FIELD' && x.message.includes(id)), id);
    assert.ok(!codes(f).includes('SCHEMA_DUPLICATE_ID'), id);
  }
});

test('findings point at bench/claims.json and at the line of the offending claim id', () => {
  const d = doc([perf(), perf({ id: 'rl.b', n: 0 })]);
  const text = JSON.stringify(d, null, 2);
  const f = validateClaims(d, { text });
  const line = text.split('\n').findIndex((l) => l.includes('"id": "rl.b"')) + 1;
  assert.ok(f.length > 0);
  assert.ok(f.every((x) => x.file === 'bench/claims.json' && x.line === line));
});

// ---------- Approval (D-02) ----------
test('status approved without a non-empty approved_by fails SCHEMA_APPROVAL', () => {
  for (const approved_by of [null, '', '   ']) {
    const f = validateClaims(doc([perf({ status: 'approved', approved_by, approved_on: '2026-11-04' })]));
    assert.ok(codes(f).includes('SCHEMA_APPROVAL'), String(approved_by));
  }
});

test('status approved without an approved_on matching YYYY-MM-DD fails SCHEMA_APPROVAL', () => {
  for (const approved_on of [null, '2026-1-4', '04/11/2026', '2026-13-01']) {
    const f = validateClaims(doc([perf({ status: 'approved', approved_by: 'Brian Yildirim', approved_on })]));
    assert.ok(codes(f).includes('SCHEMA_APPROVAL'), String(approved_on));
  }
});

test('an approved claim with approved_by and approved_on validates', () => {
  assert.deepEqual(validateClaims(doc([perf({ status: 'approved', approved_by: 'Brian Yildirim', approved_on: '2026-11-04' })])), []);
});

test('a proposed claim that already carries approval fields fails SCHEMA_APPROVAL', () => {
  const f = validateClaims(doc([perf({ approved_by: 'Claude', approved_on: '2026-11-04' })]));
  assert.ok(codes(f).includes('SCHEMA_APPROVAL'));
});

test('an unknown status or kind fails SCHEMA_FIELD', () => {
  assert.ok(codes(validateClaims(doc([perf({ status: 'ok' })]))).includes('SCHEMA_FIELD'));
  assert.ok(codes(validateClaims(doc([perf({ kind: 'speed' })]))).includes('SCHEMA_FIELD'));
});

// ---------- Performance fields (D-04) ----------
test('a throughput claim without measure, build, environment, stat, n or spread fails SCHEMA_FIELD naming the field', () => {
  for (const field of ['measure', 'build', 'environment', 'stat', 'n', 'spread']) {
    const f = validateClaims(doc([without(perf(), field)]));
    assert.ok(f.some((x) => x.code === 'SCHEMA_FIELD' && x.message.includes(field)), field);
  }
});

test('every performance kind without a measure fails schema validation', () => {
  for (const kind of PERF_KINDS) {
    const f = validateClaims(doc([without(perf({ kind }), 'measure')]));
    assert.ok(f.some((x) => x.code === 'SCHEMA_FIELD' && x.message.includes('measure')), kind);
  }
});

test('n must be an integer >= 1 and spread needs a known kind with low <= high', () => {
  for (const n of [0, 2.5, '10']) assert.ok(codes(validateClaims(doc([perf({ n })]))).includes('SCHEMA_FIELD'), String(n));
  const bad = [{ kind: 'min-max', low: 2, high: 1 }, { kind: 'iqr', low: 1, high: 2 }, { kind: 'min-max', low: 1 }];
  for (const spread of bad) assert.ok(codes(validateClaims(doc([perf({ spread })]))).includes('SCHEMA_FIELD'), JSON.stringify(spread));
});

test('build must be uninstrumented or instrumented:<what>, and instrumented needs label_required', () => {
  assert.ok(codes(validateClaims(doc([perf({ build: 'instrumented:' })]))).includes('SCHEMA_FIELD'));
  assert.ok(codes(validateClaims(doc([perf({ build: 'debug' })]))).includes('SCHEMA_FIELD'));
  assert.ok(codes(validateClaims(doc([perf({ build: 'instrumented:kv-observability-ring' })]))).includes('SCHEMA_FIELD'));
  assert.deepEqual(validateClaims(doc([perf({ build: 'instrumented:kv-observability-ring', label_required: 'event buffer on' })])), []);
});

test('environment must be a key of environments, and project a key of repos', () => {
  assert.ok(codes(validateClaims(doc([perf({ environment: 'macos' })]))).includes('SCHEMA_FIELD'));
  assert.ok(codes(validateClaims(doc([perf({ project: 'other-repo' })]))).includes('SCHEMA_FIELD'));
});

test('evidence.sha and source_sha must be 40 lowercase hex', () => {
  for (const sha of ['abc1234', 'A'.repeat(40), 'g'.repeat(40)]) {
    assert.ok(codes(validateClaims(doc([perf({ source_sha: sha })]))).includes('SCHEMA_FIELD'), sha);
    assert.ok(codes(validateClaims(doc([perf({ evidence: { ...perf().evidence, sha } })]))).includes('SCHEMA_FIELD'), sha);
  }
});

test('evidence.path may not climb out of the repo', () => {
  for (const p of ['../secrets.json', 'bench/../../x.json', '/etc/passwd', 'bench\\x.json']) {
    assert.ok(codes(validateClaims(doc([perf({ evidence: { ...perf().evidence, path: p } })]))).includes('SCHEMA_FIELD'), p);
  }
});

test('a display string that does not round to the value fails SCHEMA_FIELD', () => {
  assert.ok(codes(validateClaims(doc([perf({ display: { value: ['160.0M'] } })]))).includes('SCHEMA_FIELD'));
});

// ---------- Design facts (D-03) ----------
test('a design_fact with an evidence.pattern of zero or two capture groups fails SCHEMA_FIELD', () => {
  for (const pattern of [String.raw`struct alignas\(64\) Slot`, String.raw`(struct) alignas\((\d+)\) Slot`]) {
    const f = validateClaims(doc([fact({ evidence: { ...fact().evidence, pattern } })]));
    assert.ok(f.some((x) => x.code === 'SCHEMA_FIELD' && x.message.includes('capture group')), pattern);
  }
});

test('a design_fact whose pattern does not compile fails SCHEMA_FIELD', () => {
  const f = validateClaims(doc([fact({ evidence: { ...fact().evidence, pattern: '(unclosed' } })]));
  assert.ok(codes(f).includes('SCHEMA_FIELD'));
});

// ---------- Comparison (D-14) ----------
const pair = (a = {}, b = {}) => [
  perf({ id: 'rl.win', environment: 'windows-native', value: 100, n: 5, spread: { kind: 'min-max', low: 90, high: 110 }, display: { value: ['100'] }, ...a }),
  perf({ id: 'rl.ubu', environment: 'ubuntu-wsl2', value: 150, n: 5, spread: { kind: 'min-max', low: 140, high: 160 }, display: { value: ['150'] }, ...b }),
];
const cmpClaim = (over = {}) => ({
  id: 'rl.cmp', project: 'ratelimit-cpp', kind: 'comparison', status: 'proposed', approved_by: null, approved_on: null,
  statement: 'Hot denied, 8 threads: Ubuntu vs Windows', value: 1.5, unit: 'x', measure: 'derived_ratio', build: 'uninstrumented',
  compare: ['rl.win', 'rl.ubu'], display: { value: ['faster on Ubuntu on WSL2 by ~1.5\u00d7, medians, n=5 each'] }, label_required: null, ...over,
});
const compare = (claim, claims) => checkComparison(claim, new Map(claims.map((c) => [c.id, c])), { environments: ENVIRONMENTS });

test('a comparison of two n=5 claims with disjoint ranges, naming the faster environment and the median ratio, is accepted', () => {
  assert.deepEqual(compare(cmpClaim(), pair()), []);
});

test('a well-formed comparison claim passes validateClaims together with the compared claims', () => {
  assert.deepEqual(validateClaims(doc([...pair(), cmpClaim()])), []);
});

test('a comparison where one compared claim has n=4 fails COMPARISON_INVALID', () => {
  assert.ok(codes(compare(cmpClaim(), pair({ n: 4 }))).includes('COMPARISON_INVALID'));
  assert.ok(codes(compare(cmpClaim(), pair({}, { n: 4 }))).includes('COMPARISON_INVALID'));
});

test('compared claims must both use spread kind min-max', () => {
  const f = compare(cmpClaim(), pair({ spread: { kind: 'p25-p75', low: 90, high: 110 } }));
  assert.ok(codes(f).includes('COMPARISON_INVALID'));
});

test('touching ranges [1,2] and [2,3] count as overlapping and require "no measurable difference"', () => {
  const claims = pair({ value: 1.5, spread: { kind: 'min-max', low: 1, high: 2 } }, { value: 2.5, spread: { kind: 'min-max', low: 2, high: 3 } });
  const faster = cmpClaim({ value: 2.5 / 1.5, display: { value: ['faster on Ubuntu on WSL2 by ~1.7\u00d7, medians, n=5 each'] } });
  assert.ok(codes(compare(faster, claims)).includes('COMPARISON_INVALID'));
  assert.deepEqual(compare(cmpClaim({ value: 2.5 / 1.5, display: { value: ['no measurable difference'] } }), claims), []);
});

test('disjoint ranges may not be displayed as "no measurable difference"', () => {
  assert.ok(codes(compare(cmpClaim({ display: { value: ['no measurable difference'] } }), pair())).includes('COMPARISON_INVALID'));
});

test('a disjoint comparison that names the slower environment or the wrong ratio fails COMPARISON_INVALID', () => {
  const wrongEnv = cmpClaim({ display: { value: ['faster on Windows 11, native by ~1.5\u00d7, medians, n=5 each'] } });
  assert.ok(codes(compare(wrongEnv, pair())).includes('COMPARISON_INVALID'));
  const wrongRatio = cmpClaim({ display: { value: ['faster on Ubuntu on WSL2 by ~2.0\u00d7, medians, n=5 each'] } });
  assert.ok(codes(compare(wrongRatio, pair())).includes('COMPARISON_INVALID'));
});

test('for a time measure the faster environment is the one with the lower median', () => {
  const lat = (o) => ({ measure: 'per_op_latency', unit: 'ns', kind: 'latency', ...o });
  const claims = pair(lat({ value: 30, spread: { kind: 'min-max', low: 28, high: 32 } }), lat({ value: 20, spread: { kind: 'min-max', low: 19, high: 21 } }));
  assert.deepEqual(compare(cmpClaim(), claims), []);
});

test('an unverified cause must say hypothesis', () => {
  const unverified = { text: 'Likely the different allocator', verified: false };
  assert.ok(codes(compare(cmpClaim({ cause: unverified }), pair())).includes('COMPARISON_INVALID'));
  assert.deepEqual(compare(cmpClaim({ cause: { text: 'Hypothesis: the different allocator', verified: false } }), pair()), []);
  assert.deepEqual(compare(cmpClaim({ cause: { text: 'glibc malloc arenas (perf profile, raw/perf.txt)', verified: true } }), pair()), []);
});

test('comparing an instrumented with an uninstrumented result needs an instrumented comparison build (BENCH-06)', () => {
  const claims = pair({ build: 'instrumented:kv-observability-ring', label_required: 'event buffer on' });
  assert.ok(codes(compare(cmpClaim(), claims)).includes('COMPARISON_INVALID'));
  const labelled = cmpClaim({ build: 'instrumented:kv-observability-ring', label_required: 'event buffer on',
    display: { value: ['faster on Ubuntu on WSL2 by ~1.5\u00d7, medians, n=5 each (event buffer on)'] } });
  assert.deepEqual(compare(labelled, claims), []);
});

test('a comparison that names an unknown claim fails COMPARISON_INVALID', () => {
  assert.ok(codes(compare(cmpClaim({ compare: ['rl.win', 'rl.nope'] }), pair())).includes('COMPARISON_INVALID'));
});

// ---------- Display rounding (BENCH-03) and pointers ----------
test('a display string matches only within half a unit of its last shown digit (closed interval)', () => {
  assert.ok(matchesDisplay(153012345.6, '153.0M'));
  assert.ok(matchesDisplay(152950000, '153.0M') && matchesDisplay(153050000, '153.0M'));       // both ends included
  assert.ok(!matchesDisplay(152949999, '153.0M') && !matchesDisplay(153050001, '153.0M'));
  assert.ok(matchesDisplay(153400000, '153M') && !matchesDisplay(153600000, '153M'));
  assert.ok(matchesDisplay(8800, '8,800') && matchesDisplay(8800, '~8.8k') && matchesDisplay(1.2e9, '1.2G'));
  assert.ok(matchesDisplay(-0.37, '\u22120.37') && matchesDisplay(12.3, 'about 12.3 ns'));
  assert.ok(!matchesDisplay(12.3, 'no number here'));
});

test('parseDisplayNumber skips digits glued to words and does not read units as SI suffixes', () => {
  assert.deepEqual(parseDisplayNumber('Ubuntu on WSL2: 41 \u00b5s'), { number: 41, decimals: 0, scale: 1 });
  assert.deepEqual(parseDisplayNumber('6 MiB'), { number: 6, decimals: 0, scale: 1 });
  assert.deepEqual(parseDisplayNumber('12.50 ms'), { number: 12.5, decimals: 2, scale: 1 });
  assert.equal(parseDisplayNumber('none'), null);
});

test('resolvePointer follows RFC 6901 and returns undefined for a missing segment', () => {
  const obj = { rl_bench: { 'a/b': { '~x': 1 }, list: [10, 20] } };
  assert.equal(resolvePointer(obj, '/rl_bench/a~1b/~0x'), 1);
  assert.equal(resolvePointer(obj, '/rl_bench/list/1'), 20);
  assert.equal(resolvePointer(obj, ''), obj);
  assert.equal(resolvePointer(obj, '/rl_bench/missing/x'), undefined);
  assert.equal(resolvePointer(obj, '/rl_bench/constructor'), undefined);
  assert.equal(resolvePointer(obj, 'rl_bench'), undefined);
});

test('an oversized or unparseable claims text is a finding, never a pass', () => {
  assert.deepEqual(loadClaims('{"a":').findings.map((f) => f.code), ['SCHEMA_PARSE']);
  assert.deepEqual(loadClaims(' '.repeat(MAX_INPUT_BYTES + 1)).findings.map((f) => f.code), ['INPUT_TOO_LARGE']);
});

// ---------- Tagged leaves ----------
test('a marker naming an id that is not in the claims file fails CLAIM_UNKNOWN', async () => {
  const f = await checkTagged(new Map(), extractTaggedLeaves('<span data-claim="rl.nope">1</span>', 'p.html'), async () => '{}');
  assert.deepEqual(f.map((x) => x.code), ['CLAIM_UNKNOWN']);
});

test('a data-claim element that is not a leaf fails LEAF_NOT_LEAF', async () => {
  const html = '<span data-claim="rl.a"><b>153.0M</b></span>\n<img data-claim="rl.a" alt="">';
  const f = await checkTagged(new Map([['rl.a', perf({ status: 'approved' })]]), extractTaggedLeaves(html, 'p.html'), async () => '{}');
  assert.deepEqual(f.map((x) => x.code), ['LEAF_NOT_LEAF', 'LEAF_NOT_LEAF']);
});

test('findings sort by file, then line, then code, and format as one line each', () => {
  const list = [
    { file: 'pages/b.html', line: 1, code: 'CLAIM_UNKNOWN', message: 'x' },
    { file: 'pages/a.html', line: 9, code: 'CLAIM_MISMATCH', message: 'x' },
    { file: 'pages/a.html', line: 2, code: 'LABEL_LATENCY_WORDING', message: 'x' },
    { file: 'pages/a.html', line: 2, code: 'CLAIM_MISMATCH', message: 'x' },
  ];
  assert.deepEqual(sortFindings(list).map((f) => `${f.file}:${f.line}:${f.code}`),
    ['pages/a.html:2:CLAIM_MISMATCH', 'pages/a.html:2:LABEL_LATENCY_WORDING', 'pages/a.html:9:CLAIM_MISMATCH', 'pages/b.html:1:CLAIM_UNKNOWN']);
  assert.deepEqual(sortFindings([...list].reverse()), sortFindings(list));
  assert.equal(formatFinding(list[0]), '[check-claims] pages/b.html:1 CLAIM_UNKNOWN x');
});

// ---------- CLI ----------
function cli(args) {
  return new Promise((resolve) => execFile(process.execPath, [CLI, ...args], { cwd: ROOT }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout })));
}

test('node tools/check-claims.mjs --only claims exits 0 on the real bench/claims.json', async () => {
  const r = await cli(['--only', 'claims']);
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /SCHEMA_/);
});

test('--only claims reports schema and comparison findings and exits 1', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'check-claims-'));
  try {
    const d = doc([...pair({ n: 4 }), cmpClaim(), perf({ id: 'rl.win' })]);
    await writeFile(path.join(dir, 'claims.json'), JSON.stringify(d, null, 2));
    const r = await cli(['--root', dir, '--claims', path.join(dir, 'claims.json'), '--only', 'claims']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /SCHEMA_DUPLICATE_ID/);
    assert.match(r.stdout, /COMPARISON_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
