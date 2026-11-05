// bench-summary/1: validateSummary and recomputeStats on the reference results session
// (tools/test/fixtures/results/2026-01-01-0000000) and on edited copies of its summary.json files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEASURES, recomputeStats, validateSummary } from '../claims-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(HERE, 'fixtures', 'results', '2026-01-01-0000000');
const load = async (env, name) => JSON.parse(await readFile(path.join(SESSION, env, name), 'utf8'));
const codes = (findings) => findings.map((f) => f.code);
// Validate the env's summary after `edit(summary, meta)`; returns the findings.
async function check(env, edit = () => {}) {
  const summary = await load(env, 'summary.json'), meta = await load(env, 'meta.json');
  edit(summary, meta);
  return validateSummary(summary, meta);
}
const hasSummary = (f, text) => f.some((x) => x.code === 'RESULTS_SUMMARY' && x.message.includes(text));
// A stats object whose five stats are recomputed from `values`, so only the edited field is wrong.
const stats = (values, extra) => ({ n: values.length, values, ...recomputeStats(values), unit: 'ns', measure: 'per_op_latency', build: 'uninstrumented', ...extra });

test('both fixture summaries validate', async () => {
  assert.deepEqual(await check('windows-native'), []);
  assert.deepEqual(await check('ubuntu-wsl2'), []);
});

test('the inclusive recomputation of [1, 2, 3, 4] gives p25 1.75 and p75 3.25, median 2.5', () => {
  assert.deepEqual(recomputeStats([1, 2, 3, 4]), { median: 2.5, min: 1, max: 4, p25: 1.75, p75: 3.25 });
  assert.deepEqual(recomputeStats([4, 3, 2, 1]), recomputeStats([1, 2, 3, 4]));
});

test('a single value gives five equal stats', () => {
  assert.deepEqual(recomputeStats([7.5]), { median: 7.5, min: 7.5, max: 7.5, p25: 7.5, p75: 7.5 });
});

test('a stats object with p25 greater than median fails RESULTS_SUMMARY', async () => {
  const f = await check('windows-native', (s) => { s.fixture_bench.throughput.p25 = 2.6; });
  assert.ok(hasSummary(f, 'min <= p25 <= median <= p75 <= max'), JSON.stringify(f));
});

test('a stats object whose median differs from the recomputation fails RESULTS_SUMMARY', async () => {
  const f = await check('ubuntu-wsl2', (s) => { s.fixture_throughput.median = 10000001; });
  assert.ok(hasSummary(f, '/fixture_throughput: median 10000001 != 10000000'), JSON.stringify(f));
});

test('a difference inside relative 1e-12 passes and one outside it fails', async () => {
  assert.deepEqual(await check('ubuntu-wsl2', (s) => { s.fixture_throughput.median = 10000000 * (1 + 1e-13); }), []);
  assert.ok(codes(await check('ubuntu-wsl2', (s) => { s.fixture_throughput.median = 10000000 * (1 + 1e-11); })).includes('RESULTS_SUMMARY'));
});

test('values that do not hold n run-level values fail RESULTS_SUMMARY', async () => {
  assert.ok(codes(await check('windows-native', (s) => { s.fixture_bench.throughput.n = 5; })).includes('RESULTS_SUMMARY'));
});

test('a parent whose per_op_latency children have percentiles 50 and 90 but no 99 fails RESULTS_SUMMARY', async () => {
  const f = await check('ubuntu-wsl2', (s) => { s.fixture_latency.p99.percentile = 90; });
  assert.ok(hasSummary(f, '/fixture_latency: per_op_latency percentiles 50, 90 must include 50 and 99'), JSON.stringify(f));
});

test('a per_op_latency stats object without a valid percentile fails RESULTS_SUMMARY', async () => {
  assert.ok(codes(await check('ubuntu-wsl2', (s) => { delete s.fixture_latency.p50.percentile; })).includes('RESULTS_SUMMARY'));
  assert.ok(codes(await check('ubuntu-wsl2', (s) => { s.fixture_latency.p50.percentile = 75; })).includes('RESULTS_SUMMARY'));
  assert.ok(codes(await check('ubuntu-wsl2', (s) => { s.fixture_latency.p50.samples = 0; })).includes('RESULTS_SUMMARY'));
});

test('per_op_latency groups with 50, 95 and 99 (or 50, 90, 99, 99.9) pass', async () => {
  const group = (ps) => Object.fromEntries(ps.map((p) => [`p${p}`, stats([1, 2, 3], { percentile: p })]));
  assert.deepEqual(await check('ubuntu-wsl2', (s) => { s.fixture_latency = group([50, 95, 99]); }), []);
  assert.deepEqual(await check('ubuntu-wsl2', (s) => { s.fixture_latency = group([50, 90, 99, 99.9]); }), []);
});

test('a measure outside MEASURES fails RESULTS_SUMMARY', async () => {
  assert.ok(!MEASURES.includes('wall_time'));
  const f = await check('windows-native', (s) => { s.fixture_bench.throughput.measure = 'wall_time'; });
  assert.ok(hasSummary(f, 'measure'), JSON.stringify(f));
});

test('a stats object without build fails RESULTS_SUMMARY', async () => {
  const f = await check('windows-native', (s) => { delete s.fixture_bench.throughput.build; });
  assert.ok(hasSummary(f, 'build'), JSON.stringify(f));
  assert.ok(codes(await check('windows-native', (s) => { s.fixture_bench.throughput.build = 'instrumented:'; })).includes('RESULTS_SUMMARY'));
  assert.deepEqual(await check('windows-native', (s) => { s.fixture_bench.throughput.build = 'instrumented:asan'; }), []);
});

test('summary environment_id differing from meta fails RESULTS_ENV_MISMATCH', async () => {
  assert.ok(codes(await check('windows-native', (s) => { s.environment_id = 'ubuntu-wsl2'; })).includes('RESULTS_ENV_MISMATCH'));
});

test('summary source_sha differing from meta source.sha fails RESULTS_SUMMARY', async () => {
  const f = await check('windows-native', (s) => { s.source_sha = '0000000000000000000000000000000000000003'; });
  assert.ok(hasSummary(f, 'source_sha'), JSON.stringify(f));
});

test('derived entries must be stats objects with measure derived_ratio', async () => {
  const ratio = { ...stats([1.5, 2, 2.5]), unit: 'ratio', measure: 'derived_ratio' };
  assert.deepEqual(await check('ubuntu-wsl2', (s) => { s.derived = { p99_over_p50: ratio }; }), []);
  assert.ok(codes(await check('ubuntu-wsl2', (s) => { s.derived = { p99_over_p50: { ...ratio, measure: 'throughput' } }; })).includes('RESULTS_SUMMARY'));
  assert.ok(codes(await check('ubuntu-wsl2', (s) => { s.derived = { p99_over_p50: 4 }; })).includes('RESULTS_SUMMARY'));
});

test('a tests block must count passed + failed + skipped = total', async () => {
  assert.ok(codes(await check('ubuntu-wsl2', (s) => { s.tests.total = 55; })).includes('RESULTS_SUMMARY'));
  assert.ok(codes(await check('ubuntu-wsl2', (s) => { s.tests.failed = -1; })).includes('RESULTS_SUMMARY'));
});

test('generated_from out of path order fails RESULTS_UNSORTED, and an unlisted path fails RESULTS_SUMMARY', async () => {
  const two = (s, m) => {
    m.raw_files = [{ path: 'raw/run-01.txt', bytes: 1, sha256: '0'.repeat(64) }, { path: 'raw/run-02.txt', bytes: 1, sha256: '0'.repeat(64) }];
    s.generated_from = ['raw/run-02.txt', 'raw/run-01.txt'];
  };
  assert.ok(codes(await check('windows-native', two)).includes('RESULTS_UNSORTED'));
  assert.ok(hasSummary(await check('windows-native', (s) => { s.generated_from = ['raw/other.txt']; }), 'raw/other.txt'));
});

test('a wrong schema or quantile method fails RESULTS_SUMMARY', async () => {
  assert.ok(codes(await check('windows-native', (s) => { s.schema = 'bench-summary/2'; })).includes('RESULTS_SUMMARY'));
  assert.ok(codes(await check('windows-native', (s) => { s.policy.quantile_method = 'exclusive'; })).includes('RESULTS_SUMMARY'));
});

test('a summary with no stats object fails RESULTS_SUMMARY', async () => {
  assert.ok(hasSummary(await check('windows-native', (s) => { delete s.fixture_bench; }), 'no stats object'));
});
