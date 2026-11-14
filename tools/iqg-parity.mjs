// tools/iqg-parity.mjs: the comparison and measurement behind native-vs-Pyodide parity for image-quality-gate (D-17).
// Goldens come only from upstream tests/parity/run_native.py; this file never writes one. --measure runs every case
// through upstream pipeline.outcome in Pyodide (scripts/demos/iqg-pyodide.js) and reports the differences.
// Exit 0 = ok, 1 = a difference, mismatch or source/fixture hash mismatch, 2 = usage or I/O error.
// Usage: node tools/iqg-parity.mjs --measure --upstream <image-quality-gate dir> [--only <case>] [--write-manifest]
//        [--write-upstream] [--check-tolerances]
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { toleranceFor } from '../scripts/demos/iqg-pyodide.js';
import { loadIqgNode } from './pyodide-cache.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'scripts', 'demos', 'iqg-py', 'iqg.manifest.json');
const USAGE = '[iqg-parity] usage: node tools/iqg-parity.mjs --measure --upstream <dir> [--only <case>] [--write-manifest] '
  + '[--write-upstream] [--check-tolerances]';
const say = (line) => process.stderr.write(`${line}\n`);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ---------- Fields ----------

// Every toleranced field; anything not listed here is compared exactly.
export const TOLERANCE_KEYS = Object.freeze(['blur_score', 'brightness', 'brightness_std', 'laplacian_mean',
  'laplacian_extremes', 'gray_extremes', 'histogram_w1_bins']);
const INTEGER_KEYS = new Set(['laplacian_extremes', 'gray_extremes']);
const MEASUREMENT_KEYS = Object.freeze({ blur_score: 'blur_score', brightness: 'brightness', brightness_std: 'brightness_std',
  laplacian_mean: 'laplacian_mean', laplacian_min: 'laplacian_extremes', laplacian_max: 'laplacian_extremes',
  gray_min: 'gray_extremes', gray_max: 'gray_extremes' });
const DECISION_FIELDS = new Set(['is_ok', 'passed']);
const HISTOGRAM = 'diagnostics.laplacian_histogram';

// A golden-shaped copy of a response: diagnostics.timings and diagnostics.versions are recorded once in meta.json.
export function stripGolden(response) {
  const copy = structuredClone(response);
  if (copy?.diagnostics) { delete copy.diagnostics.timings; delete copy.diagnostics.versions; }
  return copy;
}

// A session.analyze outcome ({ status, response } or { status, detail, cause }) or a golden, as the golden's shape.
function comparable(o) {
  if (o && typeof o === 'object' && 'status' in o && !('error' in o)) {
    return o.status === 200 ? stripGolden(o.response) : { error: { status: o.status, detail: o.detail, cause: o.cause ?? null } };
  }
  return o?.error ? o : stripGolden(o);
}

// The tolerance key for a path, and the native value a relative bound scales with; null when the path is exact.
function toleranceOf(parts, golden) {
  const p = parts.join('.');
  if (p === 'blur_score' || p === 'brightness') return { key: p };
  if (parts.length === 3 && p.startsWith('diagnostics.measurements.') && MEASUREMENT_KEYS[parts[2]]) {
    return { key: MEASUREMENT_KEYS[parts[2]] };
  }
  if (parts.length === 5 && p.startsWith('diagnostics.decision.checks.') && (parts[4] === 'value' || parts[4] === 'margin')) {
    const check = golden.diagnostics.decision.checks[parts[3]];
    return { key: check.measurement, scale: check.value };
  }
  return null;
}

// Wasserstein-1 distance between two histograms ({ bin_edges, counts }), each bin's mass spread uniformly over the
// bin and the counts normalized to 1, in units of b's bin width (b is the native golden).
export function wasserstein1(a, b) {
  const cdf = (h) => {
    const e = h.bin_edges, c = h.counts, total = c.reduce((n, x) => n + x, 0);
    return (x) => {
      if (!total || x <= e[0]) return 0;
      let below = 0;
      for (let i = 0; i < c.length; i++) {
        if (x >= e[i + 1]) { below += c[i]; continue; }
        return (below + c[i] * (x - e[i]) / (e[i + 1] - e[i])) / total;
      }
      return 1;
    };
  };
  const fa = cdf(a), fb = cdf(b);
  const xs = [...new Set([...a.bin_edges, ...b.bin_edges])].sort((x, y) => x - y);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    // Both CDFs are linear between merged edge points, so |fa - fb| integrates exactly per piece.
    const dx = xs[i + 1] - xs[i], g0 = fa(xs[i]) - fb(xs[i]), g1 = fa(xs[i + 1]) - fb(xs[i + 1]);
    area += (g0 >= 0) === (g1 >= 0) || g0 === 0 || g1 === 0
      ? (Math.abs(g0) + Math.abs(g1)) / 2 * dx
      : (g0 * g0 + g1 * g1) / (2 * (Math.abs(g0) + Math.abs(g1))) * dx;
  }
  const be = b.bin_edges, width = (be[be.length - 1] - be[0]) / b.counts.length;
  return area / width;
}

// Every compared field as { path, kind, ... }: 'kind' (success vs error), 'exact' and 'decision' entries only when
// they differ; 'toleranced' entries always, with key, scale (the native value) and the absolute difference.
function fieldDiffs(actual, golden) {
  const a = comparable(actual), g = comparable(golden), out = [];
  if (Boolean(a?.error) !== Boolean(g?.error)) return [{ path: '', kind: 'kind', actual: a, expected: g }];
  const exact = (parts, x, y) => {
    const p = parts.join('.');
    if (x === y || (Number.isNaN(x) && Number.isNaN(y))) return;
    out.push({ path: p, kind: DECISION_FIELDS.has(parts[parts.length - 1]) ? 'decision' : 'exact', actual: x, expected: y });
  };
  const walk = (parts, x, y) => {
    const p = parts.join('.');
    if (p === HISTOGRAM && x && y) return histogram(x, y);
    const tol = toleranceOf(parts, g);
    if (tol && typeof x === 'number' && typeof y === 'number') {
      out.push({ path: p, kind: 'toleranced', key: tol.key, scale: tol.scale ?? y, actual: x, expected: y, diff: Math.abs(x - y) });
      return;
    }
    const obj = (v) => v !== null && typeof v === 'object';
    if (obj(x) && obj(y) && Array.isArray(x) === Array.isArray(y)) {
      if (Array.isArray(x) && x.length !== y.length) exact([...parts, 'length'], x.length, y.length);
      const keys = Array.isArray(x) ? [...Array(Math.min(x.length, y.length)).keys()].map(String)
        : [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const k of keys) {
        if (!Array.isArray(x) && (!(k in x) || !(k in y))) { exact([...parts, k], x[k], y[k]); continue; }
        walk([...parts, k], x[k], y[k]);
      }
      return;
    }
    exact(parts, x, y);
  };
  const histogram = (x, y) => {
    const h = HISTOGRAM.split('.'), sum = (c) => (Array.isArray(c) ? c.reduce((n, v) => n + v, 0) : NaN);
    exact([...h, 'bins'], x.bins, y.bins);
    exact([...h, 'counts', 'length'], x.counts?.length, y.counts?.length);
    exact([...h, 'counts', 'sum'], sum(x.counts), a.diagnostics.measurements.pixel_count);
    exact([...h, 'counts', 'sum(native)'], sum(y.counts), g.diagnostics.measurements.pixel_count);
    for (const k of Object.keys({ ...x, ...y })) if (!['bins', 'bin_edges', 'counts'].includes(k)) exact([...h, k], x[k], y[k]);
    const xe = x.bin_edges ?? [], ye = y.bin_edges ?? [];
    for (const [name, i, j] of [['0', 0, 0], ['last', xe.length - 1, ye.length - 1]]) {
      out.push({ path: `${HISTOGRAM}.bin_edges.${name}`, kind: 'toleranced', key: 'laplacian_extremes', scale: ye[j],
        actual: xe[i], expected: ye[j], diff: Math.abs(xe[i] - ye[j]) });
    }
    const w1 = wasserstein1(x, y);
    out.push({ path: `${HISTOGRAM}.w1_bins`, kind: 'toleranced', key: 'histogram_w1_bins', scale: 0, actual: w1, expected: 0, diff: w1 });
  };
  if (a.error) for (const k of ['status', 'detail', 'cause']) exact(['error', k], a.error[k], g.error[k]);
  else walk([], a, g);
  return out;
}

// Differences between an outcome and its native golden under the tolerances: [{ path, actual, expected, bound }].
// Bounds are inclusive (toleranceFor, the formula the demo's near-threshold note uses); a non-finite difference fails.
export function compareOutcome(actual, golden, tolerances) {
  const out = [];
  for (const d of fieldDiffs(actual, golden)) {
    if (d.kind !== 'toleranced') { out.push({ path: d.path, actual: d.actual, expected: d.expected, bound: 0 }); continue; }
    const bound = d.key === 'histogram_w1_bins' ? toleranceFor(d.key, 0, tolerances) : toleranceFor(d.key, d.scale, tolerances);
    if (!(d.diff <= bound)) out.push({ path: d.path, actual: d.actual, expected: d.expected, bound });
  }
  return out;
}

// Per tolerance key the largest difference (blur_score relative to the native value), plus every exact field that
// differs, every decision that flips and whether one side is an error and the other is not.
export function measureOutcome(actual, golden) {
  const maxima = Object.fromEntries(TOLERANCE_KEYS.map((k) => [k, 0]));
  const res = { maxima, exactMismatches: [], decisionFlips: [], kindMismatch: false };
  for (const d of fieldDiffs(actual, golden)) {
    if (d.kind === 'kind') res.kindMismatch = true;
    else if (d.kind === 'exact') res.exactMismatches.push(d.path);
    else if (d.kind === 'decision') res.decisionFlips.push(d.path);
    else {
      const v = d.key === 'blur_score' ? (d.diff === 0 ? 0 : d.diff / Math.abs(d.scale)) : d.diff;
      if (!(v <= maxima[d.key])) maxima[d.key] = v; // NaN or Infinity stays visible
    }
  }
  return res;
}

// Owner rule P6=A: exact when never differing; integer-valued fields exactly twice the measured maximum; float fields
// the smallest 1, 2 or 5 times a power of ten that is at least twice it.
export function toleranceRule(maxDiff, { integer = false } = {}) {
  if (maxDiff === 0) return 0;
  if (!(maxDiff > 0) || !Number.isFinite(maxDiff)) throw new RangeError(`no tolerance for a maximum of ${maxDiff}`);
  const target = 2 * maxDiff;
  if (integer) return target;
  for (let k = Math.floor(Math.log10(target)) - 1; ; k++) {
    for (const m of [1, 2, 5]) {
      const v = Number(`${m}e${k}`); // the decimal value itself, not m * 10 ** k with its rounding
      if (v >= target) return v;
    }
  }
}

// ---------- CLI ----------

const sortedJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x), 1) + '\n';

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (err) { throw new Fail(2, `cannot read ${file}: ${err.message}`); }
}

// The upstream working tree's closure sources, each required to hash (LF form) to what golden/meta.json recorded,
// so the measurement runs the code the goldens were made from (T-04-13). The fixtures and case list are checked too.
async function verifiedUpstream(dir, meta) {
  const sources = {};
  for (const [rel, want] of Object.entries(meta.sources)) {
    let text;
    try { text = await readFile(path.join(dir, ...rel.split('/'))); } catch (err) { throw new Fail(2, `cannot read ${rel}: ${err.message}`); }
    const lf = Buffer.from(text.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    if (sha256(lf) !== want) throw new Fail(1, `${rel}: sha256 differs from golden/meta.json; the goldens were made from different sources`);
    sources[rel] = lf;
  }
  for (const [rel, want] of Object.entries(meta.fixtures)) {
    let b;
    try { b = await readFile(path.join(dir, 'tests', 'parity', ...rel.split('/'))); } catch (err) { throw new Fail(2, `cannot read ${rel}: ${err.message}`); }
    if (sha256(b) !== want) throw new Fail(1, `tests/parity/${rel}: sha256 differs from golden/meta.json`);
  }
  const casesBytes = await readFile(path.join(dir, 'tests', 'parity', 'cases.json')).catch((err) => { throw new Fail(2, `cannot read cases.json: ${err.message}`); });
  if (sha256(casesBytes) !== meta.cases_sha256) throw new Fail(1, 'tests/parity/cases.json: sha256 differs from golden/meta.json');
  return { sources, cases: JSON.parse(casesBytes.toString('utf8')) };
}

// A Pyodide session over the verified upstream sources and the manifest's vendored wheels, laid out in a temporary
// root the way the portfolio vendors them (scripts/demos/iqg-py/).
async function upstreamSession(manifest, sources, tempRoot) {
  const base = path.join(tempRoot, ...manifest.sources.dir.split('/'));
  const files = {};
  for (const rel of Object.keys(sources).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))) {
    const file = path.join(base, ...rel.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, sources[rel]);
    files[rel] = { bytes: sources[rel].length, sha256: sha256(sources[rel]) };
  }
  for (const rel of Object.keys(manifest.wheels)) {
    const file = path.join(base, ...rel.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await readFile(path.join(ROOT, ...manifest.sources.dir.split('/'), ...rel.split('/'))));
  }
  const m = structuredClone(manifest);
  m.sources.files = files;
  return loadIqgNode(m, { root: tempRoot });
}

// One line per tolerance: the measured maximum, where it occurred and which kinds of image differed at all, read from
// the goldens' format and mode (RESEARCH A1: the cause is worded as different decoder and library versions).
const rationale = ({ key, max, maxCase, n, differing, kinds, manifest, meta }) => {
  const unit = key === 'blur_score' ? 'relative' : key === 'histogram_w1_bins' ? 'native bin widths' : 'absolute';
  if (max === 0) return `Never differed over the ${n} parity cases, so exact.`;
  const kind = (c) => (kinds[c] === 'JPEG RGB' ? 'YCbCr JPEG' : kinds[c]);
  const groups = new Map();
  for (const [c, k] of Object.entries(kinds)) {
    if (differing.includes(c)) continue;
    groups.set(kind(c), [...(groups.get(kind(c)) ?? []), c]);
  }
  const differingKinds = [...new Set(differing.map(kind))].join(' and ');
  const same = [...groups].map(([k, cs]) => (differingKinds === k ? `the other ${k} cases (${cs.join(', ')})` : `${k} (${cs.length})`));
  const lib = manifest.pyodide.libraries, nat = meta.versions;
  const count = differing.length === 1 ? `1 ${differingKinds} case` : `${differing.length} ${differingKinds} cases`;
  return `Measured max ${max} (${unit}, ${maxCase}) over ${n} cases; nonzero only in ${count} `
    + `(${differing.join(', ')}); identical: ${same.join(', ')}. Likely cause: different JPEG decoder and library versions `
    + `(native libjpeg-turbo ${nat.libjpeg_turbo}, OpenCV ${nat.opencv}, Pillow ${nat.pillow}; Pyodide IJG libjpeg ${lib.libjpeg}, `
    + `OpenCV ${lib.opencv}, Pillow ${lib.pillow}).`;
};

async function main() {
  let opt;
  try {
    ({ values: opt } = parseArgs({ options: { measure: { type: 'boolean' }, upstream: { type: 'string' },
      only: { type: 'string' }, 'write-manifest': { type: 'boolean' }, 'write-upstream': { type: 'boolean' },
      'check-tolerances': { type: 'boolean' } } }));
  } catch (err) {
    say(`[iqg-parity] ${err.message}`); say(USAGE);
    return 2;
  }
  if (!opt.measure || !opt.upstream || (opt.only !== undefined && (opt['write-manifest'] || opt['write-upstream']))) {
    say(USAGE);
    return 2;
  }
  const dir = path.resolve(opt.upstream), parityDir = path.join(dir, 'tests', 'parity');
  const manifestText = await readFile(MANIFEST, 'utf8');
  const manifest = JSON.parse(manifestText);
  const meta = await readJson(path.join(parityDir, 'golden', 'meta.json'));
  const { sources, cases } = await verifiedUpstream(dir, meta);
  const selected = opt.only === undefined ? cases.cases : cases.cases.filter((c) => c.name === opt.only);
  if (!selected.length) { say(`[iqg-parity] no case named "${opt.only}"`); return 2; }
  const tolerances = manifest.parity?.tolerances;
  if (opt['check-tolerances'] && !tolerances) { say('[iqg-parity] --check-tolerances: the manifest has no parity.tolerances'); return 2; }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'iqg-parity-'));
  const report = { cases: 0, maxima: Object.fromEntries(TOLERANCE_KEYS.map((k) => [k, 0])), maxima_case: {},
    exactMismatches: [], decisionFlips: [], kindMismatches: [] };
  const differing = Object.fromEntries(TOLERANCE_KEYS.map((k) => [k, []])), kinds = {};
  if (opt['check-tolerances']) report.differences = [];
  try {
    const iqg = await upstreamSession(manifest, sources, tempRoot);
    for (const c of selected) {
      const bytes = new Uint8Array(await readFile(path.join(parityDir, ...c.file.split('/'))));
      const golden = await readJson(path.join(parityDir, 'golden', `${c.name}.json`));
      const outcome = iqg.analyze(bytes, c.content_type, { overrides: c.settings, bins: cases.bins });
      const m = measureOutcome(outcome, golden);
      report.cases++;
      if (!golden.error) kinds[c.name] = `${golden.diagnostics.image.format} ${golden.diagnostics.image.mode}`;
      for (const [k, v] of Object.entries(m.maxima)) {
        if (v !== 0) differing[k].push(c.name);
        if (!(v <= report.maxima[k])) { report.maxima[k] = v; report.maxima_case[k] = c.name; }
      }
      report.exactMismatches.push(...m.exactMismatches.map((p) => `${c.name}: ${p}`));
      report.decisionFlips.push(...m.decisionFlips.map((p) => `${c.name}: ${p}`));
      if (m.kindMismatch) report.kindMismatches.push(c.name);
      if (opt['check-tolerances']) {
        report.differences.push(...compareOutcome(outcome, golden, tolerances).map((d) => ({ case: c.name, ...d })));
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  report.differing_cases = differing;
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  const bad = report.exactMismatches.length || report.decisionFlips.length || report.kindMismatches.length;
  if (bad) return 1;
  if (opt['check-tolerances'] && report.differences.length) return 1;

  if (opt['write-manifest']) {
    if (JSON.stringify(manifest, null, 1) + '\n' !== manifestText) { say('[iqg-parity] the manifest is not in 1-space JSON form; not rewriting it'); return 2; }
    const entries = {};
    for (const k of [...TOLERANCE_KEYS].sort()) {
      const bound = toleranceRule(report.maxima[k], { integer: INTEGER_KEYS.has(k) });
      const entry = { [k === 'blur_score' ? 'rel' : 'abs']: bound, measured_max: report.maxima[k],
        rationale: rationale({ key: k, max: report.maxima[k], maxCase: report.maxima_case[k], n: report.cases,
          differing: differing[k], kinds, manifest, meta }) };
      entries[k] = Object.fromEntries(Object.entries(entry).sort(([x], [y]) => (x < y ? -1 : 1)));
    }
    const v = meta.versions;
    manifest.parity = { ...manifest.parity, bins: cases.bins, tolerances: entries }; // keeps fields 04-06 adds (dir, files)
    manifest.native = { environment: meta.environment, libjpeg: v.libjpeg, libjpeg_turbo: v.libjpeg_turbo, numpy: v.numpy,
      opencv: v.opencv, pillow: v.pillow, pydantic: v.pydantic, pydantic_settings: v.pydantic_settings, python: v.python };
    await writeFile(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
    say(`[iqg-parity] wrote parity and native to ${path.relative(ROOT, MANIFEST)}`);
  }
  if (opt['write-upstream']) {
    if (!manifest.parity?.tolerances) { say('[iqg-parity] --write-upstream: the manifest has no parity.tolerances'); return 2; }
    const p = manifest.pyodide;
    const out = { schema: 'iqg-parity-tolerances/1', pyodide: { version: p.version, python: p.python, libraries: p.libraries },
      tolerances: manifest.parity.tolerances, measured_over: { cases: report.cases, cases_sha256: meta.cases_sha256 },
      command: 'node tools/iqg-parity.mjs --measure --upstream <image-quality-gate> --write-upstream',
      date: new Date().toISOString().slice(0, 10) };
    await writeFile(path.join(parityDir, 'tolerances.json'), sortedJson(out));
    say('[iqg-parity] wrote tests/parity/tolerances.json upstream');
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main().catch((err) => {
    if (err instanceof Fail) { say(`[iqg-parity] ${err.message}`); return err.code; }
    say(`[iqg-parity] unexpected error: ${err.stack ?? err.message}`);
    return 2;
  });
}
