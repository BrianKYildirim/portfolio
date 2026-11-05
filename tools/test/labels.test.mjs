// BENCH-05/06 label-rule tests for tools/claims-lib.mjs: amortized times are never called latency, and an
// instrumented result is never shown without its instrumented label. Both run through checkTagged too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLabels, checkTagged, extractTaggedLeaves } from '../claims-lib.mjs';

const SHA = 'a'.repeat(40);
const claim = (over = {}) => ({
  id: 'rl.amortized', project: 'ratelimit-cpp', kind: 'latency', status: 'approved', approved_by: 'Brian Yildirim',
  approved_on: '2026-11-04', statement: 'gbench Time column', value: 12.3, unit: 'ns', stat: 'median', n: 10,
  spread: { kind: 'min-max', low: 11.9, high: 12.8 }, measure: 'amortized_per_op', build: 'uninstrumented',
  environment: 'ubuntu-wsl2', source_sha: SHA, display: { value: ['12.3 ns'] }, label_required: null, ...over,
});
const codes = (findings) => findings.map((f) => f.code);
const kv = (over = {}) => claim({ id: 'kv.p50', measure: 'per_op_latency', build: 'instrumented:kv-observability-ring',
  label_required: 'event buffer on', value: 41, unit: '\u00b5s', display: { value: ['41 \u00b5s'] }, ...over });

// ---------- Latency wording (BENCH-05) ----------
test('an amortized_per_op claim displayed with the word Latency fails LABEL_LATENCY_WORDING', () => {
  for (const context of ['Latency per call: 12.3 ns', 'LATENCY 12.3 ns', 'call latencies around 12.3 ns', 'p50 latency 12.3 ns']) {
    assert.deepEqual(codes(checkLabels(claim(), context)), ['LABEL_LATENCY_WORDING'], context);
  }
});

test('an amortized_per_op claim displayed as time per call passes', () => {
  assert.deepEqual(checkLabels(claim(), '12.3 ns time per call, amortized over the loop'), []);
});

test('a per_op_latency claim may use the word latency', () => {
  assert.deepEqual(checkLabels(claim({ measure: 'per_op_latency' }), 'p50 latency 12.3 ns'), []);
});

test('the latency check ignores words that only contain the letters (no false positive on unrelated text)', () => {
  assert.deepEqual(checkLabels(claim(), '12.3 ns per call; latent capacity unused'), []);
});

// ---------- Instrumented label (BENCH-06) ----------
test('an instrumented claim shown without its label_required phrase fails LABEL_INSTRUMENTED_MISSING', () => {
  assert.deepEqual(codes(checkLabels(kv(), 'p50 41 \u00b5s per command')), ['LABEL_INSTRUMENTED_MISSING']);
});

test('the instrumented label matches case-insensitively', () => {
  assert.deepEqual(checkLabels(kv(), 'p50 41 \u00b5s per command, Event Buffer ON'), []);
});

test('the micro sign U+00B5 and Greek mu U+03BC are the same unit prefix', () => {
  const micro = kv({ label_required: '\u00b5s, event buffer on' }), mu = kv({ label_required: '\u03bcs, event buffer on' });
  assert.deepEqual(checkLabels(micro, 'p50 41 \u03bcs, event buffer on'), []);
  assert.deepEqual(checkLabels(mu, 'p50 41 \u00b5s, event buffer on'), []);
});

test('the label check is NFC-normalized on both sides', () => {
  assert.deepEqual(checkLabels(kv({ label_required: 'caf\u00e9 mode' }), 'p50 41 \u00b5s in cafe\u0301 mode'), []);
});

test('an instrumented claim with no label_required fails closed', () => {
  assert.deepEqual(codes(checkLabels(kv({ label_required: null }), 'p50 41 \u00b5s')), ['LABEL_INSTRUMENTED_MISSING']);
});

test('an uninstrumented per-op claim needs no label', () => {
  assert.deepEqual(checkLabels(kv({ build: 'uninstrumented', label_required: null }), 'p50 41 \u00b5s'), []);
});

// ---------- Through checkTagged ----------
const page = (li) => `<ul class="pd-metrics">\n  <li>${li}</li>\n</ul>\n`;
const run = (c, html) => checkTagged(new Map([[c.id, c]]), extractTaggedLeaves(html, 'pages/projects/x.html'), async () => '{}');

test('checkTagged applies the latency rule to the enclosing <li> text', async () => {
  const html = page('<span class="v" data-claim="rl.amortized">12.3 ns</span><span class="l">Latency per call</span>');
  const f = await run(claim(), html);
  assert.deepEqual(f.map((x) => [x.code, x.file, x.line]), [['LABEL_LATENCY_WORDING', 'pages/projects/x.html', 2]]);
});

test('checkTagged applies the instrumented-label rule to the enclosing <li> text', async () => {
  const bare = page('<span class="v" data-claim="kv.p50">41 &micro;s</span><span class="l">p50 per command</span>');
  assert.deepEqual(codes(await run(kv(), bare)), ['LABEL_INSTRUMENTED_MISSING']);
  const labelled = page('<span class="v" data-claim="kv.p50">41 &micro;s</span><span class="l">p50 per command, event buffer on</span>');
  assert.deepEqual(await run(kv(), labelled), []);
});
