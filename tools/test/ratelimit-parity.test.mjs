// The Node leg of native-vs-WASM parity (D-18): every trace vendored from ratelimit-cpp tests/parity at the manifest
// sha runs through the committed module and the shipped wrapper, and must equal the vendored native golden byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLimiterModule } from '../../scripts/demos/ratelimit-wasm.js';
import { runTrace } from '../ratelimit-trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const WASM_DIR = path.join(ROOT, 'scripts', 'demos', 'wasm');
const manifest = JSON.parse(readFileSync(path.join(WASM_DIR, 'ratelimit.manifest.json'), 'utf8'));
const FIX = path.join(ROOT, 'tools', 'test', 'fixtures', 'ratelimit-parity');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const stems = (sub, ext) => (existsSync(path.join(FIX, sub)) ? readdirSync(path.join(FIX, sub)) : [])
  .filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)).sort();
const TRACES = stems('traces', '.jsonl');

// Every file under dir as a '/'-separated path relative to it.
function walk(dir, rel = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

// First line where two outcome texts differ, or null when they are equal.
function firstDiff(actual, expected) {
  if (actual === expected) return null;
  const a = actual.split('\n'), e = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) return { line: i + 1, actual: a[i], expected: e[i] };
  }
  return { line: a.length, actual: '', expected: '' }; // unreachable: unequal texts differ on some line
}

const module = await loadLimiterModule();

test('the vendored fixtures are the manifest\'s parity set, from the pinned sha', () => {
  assert.equal(manifest.parity?.dir, 'tools/test/fixtures/ratelimit-parity');
  assert.equal(manifest.parity.source_path, 'tests/parity');
  assert.match(manifest.sha, /^[0-9a-f]{40}$/);
  assert.ok(TRACES.length > 0, 'no vendored traces');
  assert.deepEqual(stems('golden', '.out'), TRACES, 'every trace has a golden and every golden a trace');
  const listed = Object.keys(manifest.parity.files);
  assert.deepEqual(listed, [...listed].sort(), 'manifest parity entries are sorted by path');
  assert.deepEqual(walk(FIX).sort(), [...listed].sort(), 'files on disk equal the files listed in the manifest');
});

test('fixture and artifact bytes match the manifest hashes', () => {
  const check = (file, entry, name) => {
    const b = readFileSync(file);
    assert.equal(b.length, entry.bytes, `${name}: bytes`);
    assert.equal(sha256(b), entry.sha256, `${name}: sha256`);
  };
  for (const [rel, entry] of Object.entries(manifest.parity?.files ?? {})) check(path.join(FIX, rel), entry, rel);
  assert.deepEqual(Object.keys(manifest.files).sort(), ['ratelimit.mjs', 'ratelimit.wasm']);
  for (const [name, entry] of Object.entries(manifest.files)) check(path.join(WASM_DIR, name), entry, name);
});

for (const stem of TRACES) {
  test(stem, () => {
    const trace = readFileSync(path.join(FIX, 'traces', `${stem}.jsonl`), 'utf8');
    const golden = readFileSync(path.join(FIX, 'golden', `${stem}.out`), 'utf8');
    const d = firstDiff(runTrace(trace, module), golden);
    assert.equal(d, null, d && `line ${d.line}: wasm "${d.actual}", native "${d.expected}"`);
  });
}

test('the comparison has teeth: one changed digit in a golden is reported at its line', () => {
  assert.ok(TRACES.length > 0, 'no vendored traces');
  const stem = TRACES[0];
  const actual = runTrace(readFileSync(path.join(FIX, 'traces', `${stem}.jsonl`), 'utf8'), module);
  const lines = readFileSync(path.join(FIX, 'golden', `${stem}.out`), 'utf8').split('\n');
  const k = lines.findIndex((l, i) => i > 0 && /\d/.test(l)); // past the "N <version>" line
  assert.ok(k > 0, 'golden has an outcome line with a digit');
  const at = lines[k].search(/\d(?!.*\d)/); // last digit on the line
  lines[k] = lines[k].slice(0, at) + String((Number(lines[k][at]) + 1) % 10) + lines[k].slice(at + 1);
  const d = firstDiff(actual, lines.join('\n'));
  assert.ok(d, 'the changed golden is reported as different');
  assert.equal(d.line, k + 1);
  assert.equal(firstDiff(actual, actual), null);
});
