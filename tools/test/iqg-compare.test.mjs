// Pure tests of the native-vs-Pyodide comparison (D-17) and the near-threshold note's bound (D-21): what counts as
// "the same result", including the inclusive boundary. No Pyodide is loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareOutcome, measureOutcome, toleranceRule, wasserstein1 } from '../iqg-parity.mjs';
import { failOf, nearThreshold, toleranceFor } from '../../scripts/demos/iqg-pyodide.js';

// The shape of upstream tests/parity/golden/sharp_small.json, with a 4-bin histogram.
const GOLDEN = Object.freeze({
  blur_score: 1033.1184387207031,
  brightness: 64.75344848632812,
  diagnostics: {
    decision: {
      checks: [
        { comparator: '>=', margin: 893.1184387207031, measurement: 'blur_score', name: 'blur_min', passed: true, threshold: 140.0, value: 1033.1184387207031 },
        { comparator: '>=', margin: 44.753448486328125, measurement: 'brightness', name: 'bright_min', passed: true, threshold: 20, value: 64.75344848632812 },
        { comparator: '<=', margin: 170.24655151367188, measurement: 'brightness', name: 'bright_max', passed: true, threshold: 235, value: 64.75344848632812 },
      ],
      combine: 'all',
      is_ok: true,
      rule: 'is_ok = (blur_score >= blur_min) AND (bright_min <= brightness) AND (brightness <= bright_max)',
    },
    image: {
      content_type: 'image/jpeg', exif_orientation: null, format: 'JPEG', mode: 'RGB', orientation_applied: false,
      oriented_height: 4, oriented_width: 4, original_height: 4, original_width: 4, processed_height: 4,
      processed_width: 4, resized: false, scale: 1.0, upload_bytes: 2294,
    },
    laplacian_histogram: { bin_edges: [-4, -2, 0, 2, 4], bins: 4, counts: [2, 4, 8, 2] },
    measurements: {
      blur_score: 1033.1184387207031, brightness: 64.75344848632812, brightness_std: 110.9875994256436, gray_max: 255,
      gray_min: 0, laplacian_max: 4.0, laplacian_mean: 0.0, laplacian_min: -4.0, pixel_count: 16,
    },
    request_id: null,
    schema_version: 1,
    settings: {
      blur_min: { source: 'default', value: 140.0 },
      bright_max: { source: 'default', value: 235 },
      bright_min: { source: 'default', value: 20 },
    },
  },
  height: 4,
  is_ok: true,
  thresholds: { blur_min: 140.0, bright_max: 235, bright_min: 20 },
  width: 4,
});
const ERROR = Object.freeze({ error: { status: 400, detail: 'Invalid image data', cause: 'OSError' } });
const TOL = Object.freeze({
  blur_score: { rel: 1e-2 }, brightness: { abs: 1e-2 }, brightness_std: { abs: 1e-2 }, laplacian_mean: { abs: 1e-5 },
  laplacian_extremes: { abs: 4 }, gray_extremes: { abs: 4 }, histogram_w1_bins: { abs: 0.5 },
});

const copy = () => structuredClone(GOLDEN);
// A session.analyze outcome carrying a response, plus the diagnostics fields a golden leaves out.
const ok = (response) => ({ status: 200, response: { ...response, diagnostics: { ...response.diagnostics, timings: {}, versions: {} } } });
const paths = (diffs) => diffs.map((d) => d.path);

// Neighbouring doubles, for the exact boundary of an inclusive bound.
const f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer);
const step = (x, dir) => { f64[0] = x; i64[0] += (x >= 0) === (dir > 0) ? 1n : -1n; return f64[0]; };
// The largest value v above native with |v - native| <= bound; the next double above is the first that exceeds it.
function edge(native, bound) {
  let v = native + bound;
  while (Math.abs(v - native) > bound) v = step(v, -1);
  while (Math.abs(step(v, 1) - native) <= bound) v = step(v, 1);
  return v;
}

test('identical success outcomes give no differences, and identical error outcomes give none', () => {
  assert.deepEqual(compareOutcome(ok(copy()), copy(), TOL), []);
  assert.deepEqual(compareOutcome({ fail: 'invalid_image', status: 400, detail: 'Invalid image data', cause: 'OSError' }, ERROR, TOL), []);
  assert.deepEqual(compareOutcome(ERROR, ERROR, TOL), []);
  const m = measureOutcome(ok(copy()), copy());
  assert.deepEqual(m, { maxima: Object.fromEntries(Object.keys(TOL).map((k) => [k, 0])), exactMismatches: [],
    decisionFlips: [], kindMismatch: false });
});

test('blur_score exactly rel * |native| away passes and the next double above fails; brightness the same with abs', () => {
  for (const key of ['blur_score', 'brightness']) {
    const native = GOLDEN[key], bound = toleranceFor(key, native, TOL);
    assert.equal(bound, key === 'blur_score' ? 1e-2 * native : 1e-2);
    const at = edge(native, bound), above = step(at, 1);
    assert.ok(Math.abs(at - native) <= bound && Math.abs(above - native) > bound);
    const set = (v) => { const r = copy(); r[key] = v; r.diagnostics.measurements[key] = v; return r; };
    assert.deepEqual(compareOutcome(ok(set(at)), copy(), TOL), [], `${key}: at the bound`);
    const diffs = compareOutcome(ok(set(above)), copy(), TOL);
    assert.deepEqual(paths(diffs), [key, `diagnostics.measurements.${key}`], `${key}: just above`);
    assert.equal(diffs[0].bound, bound);
  }
});

test('a changed width, format, exif_orientation, content_type or settings source is a difference at that path', () => {
  const edits = {
    width: (r) => { r.width = 5; },
    'diagnostics.image.format': (r) => { r.diagnostics.image.format = 'PNG'; },
    'diagnostics.image.exif_orientation': (r) => { r.diagnostics.image.exif_orientation = 1; },
    'diagnostics.image.content_type': (r) => { r.diagnostics.image.content_type = 'image/png'; },
    'diagnostics.settings.blur_min.source': (r) => { r.diagnostics.settings.blur_min.source = 'init'; },
    'thresholds.bright_min': (r) => { r.thresholds.bright_min = '20'; }, // same value, other type
  };
  for (const [p, edit] of Object.entries(edits)) {
    const r = copy();
    edit(r);
    assert.deepEqual(paths(compareOutcome(ok(r), copy(), TOL)), [p], p);
    assert.deepEqual(measureOutcome(ok(r), copy()).exactMismatches, [p], p);
  }
});

test('flipping is_ok or one check\'s passed is a difference even when every number is within bounds', () => {
  const r = copy();
  r.is_ok = false;
  r.diagnostics.decision.checks[1].passed = false;
  assert.deepEqual(paths(compareOutcome(ok(r), copy(), TOL)), ['diagnostics.decision.checks.1.passed', 'is_ok']);
  const m = measureOutcome(ok(r), copy());
  assert.deepEqual(m.decisionFlips, ['diagnostics.decision.checks.1.passed', 'is_ok']);
  assert.deepEqual(m.exactMismatches, []);
});

test('a check\'s margin uses the tolerance of the check\'s measurement', () => {
  const r = copy();
  r.diagnostics.decision.checks[0].margin += 5; // within 1e-2 relative of a blur_score of 1033
  assert.deepEqual(compareOutcome(ok(r), copy(), TOL), []);
  r.diagnostics.decision.checks[1].margin += 5; // far outside 1e-2 absolute brightness
  const diffs = compareOutcome(ok(r), copy(), TOL);
  assert.deepEqual(paths(diffs), ['diagnostics.decision.checks.1.margin']);
  assert.equal(diffs[0].bound, 1e-2);
  assert.equal(measureOutcome(ok(r), copy()).maxima.brightness, 5);
});

test('histograms: equal give W1 0, edges shifted one native bin give W1 1, other bins or count totals fail', () => {
  const h = GOLDEN.diagnostics.laplacian_histogram;
  assert.equal(wasserstein1(h, h), 0);
  const shifted = { ...h, bin_edges: h.bin_edges.map((e) => e + 2) };
  assert.equal(wasserstein1(shifted, h), 1);
  const r = copy();
  r.diagnostics.laplacian_histogram = structuredClone(shifted);
  assert.deepEqual(paths(compareOutcome(ok(r), copy(), TOL)), ['diagnostics.laplacian_histogram.w1_bins']);
  assert.deepEqual(compareOutcome(ok(r), copy(), { ...TOL, histogram_w1_bins: { abs: 1 } }), []);
  assert.equal(measureOutcome(ok(r), copy()).maxima.histogram_w1_bins, 1);
  const bins = copy();
  bins.diagnostics.laplacian_histogram.bins = 5;
  assert.ok(paths(compareOutcome(ok(bins), copy(), TOL)).includes('diagnostics.laplacian_histogram.bins'));
  const total = copy();
  total.diagnostics.laplacian_histogram.counts = [2, 4, 8, 3];
  assert.ok(paths(compareOutcome(ok(total), copy(), TOL)).includes('diagnostics.laplacian_histogram.counts.sum'));
  const edge0 = copy();
  edge0.diagnostics.laplacian_histogram.bin_edges[0] = -9;
  assert.ok(paths(compareOutcome(ok(edge0), copy(), TOL)).includes('diagnostics.laplacian_histogram.bin_edges.0'));
});

test('an error golden against a success outcome, or against an error with another cause, is a difference', () => {
  assert.deepEqual(paths(compareOutcome(ok(copy()), ERROR, TOL)), ['']);
  assert.equal(measureOutcome(ok(copy()), ERROR).kindMismatch, true);
  assert.equal(measureOutcome({ status: 400, detail: 'Invalid image data', cause: 'OSError' }, copy()).kindMismatch, true);
  const other = { fail: 'too_many_pixels', status: 400, detail: 'Invalid image data', cause: 'ImageTooLarge' };
  assert.deepEqual(paths(compareOutcome(other, ERROR, TOL)), ['error.cause']);
  assert.deepEqual(measureOutcome(other, ERROR).exactMismatches, ['error.cause']);
  assert.deepEqual(paths(compareOutcome({ status: 415, detail: 'Unsupported media type', cause: null }, ERROR, TOL)),
    ['error.status', 'error.detail', 'error.cause']);
});

test('measureOutcome gives blur_score relative to the native value and the others absolute', () => {
  const r = copy();
  r.blur_score = GOLDEN.blur_score * (1 + 2e-3);
  r.diagnostics.measurements.gray_min = 3;
  r.diagnostics.measurements.laplacian_mean = 1.5e-6;
  const m = measureOutcome(ok(r), copy());
  assert.ok(Math.abs(m.maxima.blur_score - 2e-3) < 1e-15, String(m.maxima.blur_score));
  assert.equal(m.maxima.gray_extremes, 3);
  assert.equal(m.maxima.laplacian_mean, 1.5e-6);
});

test('toleranceRule: exact when never differing, twice an integer maximum, else the next 1-2-5 step at twice it', () => {
  assert.equal(toleranceRule(0), 0);
  assert.equal(toleranceRule(4.2e-3), 1e-2);
  assert.equal(toleranceRule(3, { integer: true }), 6);
  assert.equal(toleranceRule(1.56e-6), 5e-6);
  assert.equal(toleranceRule(2.67e-3), 1e-2);
  assert.equal(toleranceRule(1e-3), 2e-3); // exactly twice is enough
  assert.equal(toleranceRule(0.31), 1);
  assert.equal(toleranceRule(0.2), 0.5);
  assert.throws(() => toleranceRule(-1), RangeError);
  assert.throws(() => toleranceRule(Number.NaN), RangeError);
});

test('nearThreshold flags a check whose |margin| equals its bound, not one just above, and always a margin of 0', () => {
  const check = (name, measurement, value, margin) => ({ name, measurement, value, margin, comparator: '>=', threshold: 0, passed: margin >= 0 });
  const bound = toleranceFor('brightness', 20.5, TOL);
  assert.deepEqual(nearThreshold([check('bright_min', 'brightness', 20.5, bound)], TOL), ['bright_min']);
  assert.deepEqual(nearThreshold([check('bright_min', 'brightness', 20.5, step(bound, 1))], TOL), []);
  assert.deepEqual(nearThreshold([check('bright_min', 'brightness', 20.5, -bound)], TOL), ['bright_min']);
  assert.deepEqual(nearThreshold([check('blur_min', 'blur_score', 140, 0)], {}), ['blur_min'], 'exact field, margin 0');
  const blur = toleranceFor('blur_score', 140, TOL);
  assert.equal(blur, 1e-2 * 140);
  assert.deepEqual(nearThreshold([check('blur_min', 'blur_score', 140, blur), check('bright_max', 'brightness', 100, 135)], TOL),
    ['blur_min']);
});

test('failOf maps the status and cause Python returned to the worker\'s fail codes', () => {
  assert.equal(failOf({ status: 415, cause: null }), 'unsupported_type');
  assert.equal(failOf({ status: 413, cause: null }), 'too_large');
  assert.equal(failOf({ status: 400, cause: 'ImageTooLarge' }), 'too_many_pixels');
  assert.equal(failOf({ status: 400, cause: 'MemoryError' }), 'memory');
  assert.equal(failOf({ status: 400, cause: 'OSError' }), 'invalid_image');
  assert.equal(failOf({ status: 400, cause: 'UnidentifiedImageError' }), 'invalid_image');
  assert.equal(failOf({ status: 500, cause: null }), 'fatal');
});

test('toleranceFor: abs as is, rel scaled by |native value|, no entry exact', () => {
  assert.equal(toleranceFor('brightness', 64, TOL), 1e-2);
  assert.equal(toleranceFor('blur_score', -200, TOL), 2);
  assert.equal(toleranceFor('width', 4, TOL), 0);
  assert.equal(toleranceFor('blur_score', 1, undefined), 0);
});
