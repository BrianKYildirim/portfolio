// Tests of the untagged-number scan (CLAIM-02, D-05): UNIT_NUMBER, scanHtml over the portfolio pages and
// scanJsLines over the demo string literals, end to end through tools/check-claims.mjs and as pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import * as lib from '../claims-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'check-claims.mjs');
const BASIC = path.join(HERE, 'fixtures', 'basic');
const HTML = path.join(HERE, 'fixtures', 'html');
const JS = path.join(HERE, 'fixtures', 'js');
const MiB = 1024 * 1024;

function run(root, extra = []) {
  const args = [CLI, '--root', root, '--claims', path.join(BASIC, 'claims.json'), '--evidence-root', path.join(BASIC, 'evidence'), ...extra];
  return new Promise((resolve) => {
    execFile(process.execPath, args, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
// A throwaway root holding `files` ({ 'pages/projects/x.html': '<text>' }); removed after `body` runs.
async function withRoot(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scan-html-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const fixture = (dir, name) => readFile(path.join(dir, name), 'utf8');
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
// The quoted token of an UNTAGGED_NUMBER message.
const token = (f) => /^"(.*)" has a unit/.exec(f.message)?.[1];
const untaggedOn = (findings, line) => findings.filter((f) => f.code === 'UNTAGGED_NUMBER' && f.line === line).map(token);
const codesOn = (findings, line) => findings.filter((f) => f.line === line).map((f) => f.code);
// scanJsLines through a guard, so a missing export is an assertion failure rather than a TypeError.
function scanJs(text, file = 'demo.js') {
  assert.equal(typeof lib.scanJsLines, 'function', 'claims-lib.mjs exports scanJsLines');
  return lib.scanJsLines(text, file);
}

// ---------- Tracer (CLI) ----------
test('the basic fixture still passes --only html: its tagged leaves are not reported again as untagged', async () => {
  const r = await run(BASIC, ['--only', 'html']);
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /UNTAGGED_NUMBER|METRIC_UNTAGGED|CLAIM_|EVIDENCE_/);
});

test('an untagged headline value and an untagged prose figure fail through the CLI with their true lines', async () => {
  const text = await fixture(HTML, 'metrics-untagged.html');
  await withRoot({ 'pages/projects/rate-limiter.html': text }, async (dir) => {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1, r.stdout);
    const at = (needle) => `pages/projects/rate-limiter.html:${lineOf(text, needle)}`;
    assert.match(r.stdout, new RegExp(`^\\[check-claims\\] ${at('153M')} METRIC_UNTAGGED .*"153M"`, 'm'));
    assert.match(r.stdout, new RegExp(`^\\[check-claims\\] ${at('30 ms')} UNTAGGED_NUMBER "30 ms"`, 'm'));
    assert.doesNotMatch(r.stdout, /Live/);
    assert.equal(r.stdout.trim().split('\n').length, 3, r.stdout);
  });
});

// ---------- Unit regex ----------
test('UNIT_NUMBER is built without the u flag and matches the same tokens if u is added', async () => {
  const sample = (await fixture(HTML, 'unicode-and-adjacency.html')).replace(/<[^>]*>/g, ' ');
  assert.ok(!lib.UNIT_NUMBER.flags.includes('u'));
  const plain = [...sample.matchAll(lib.UNIT_NUMBER)].map((m) => [m.index, m[0]]);
  const unicode = [...sample.matchAll(new RegExp(lib.UNIT_NUMBER.source, 'gu'))].map((m) => [m.index, m[0]]);
  assert.ok(plain.length > 5);
  assert.deepEqual(unicode, plain);
});

test('words that only start like a unit and numbers glued to letters are not unit-numbers', () => {
  for (const s of ['128 shards', 'WSL2 ms', 'v1.2 ms', '8 threads', '10 users', '64x64 grid', '0x1F', '`0x${c.toString(16)}`', '3 MP', '640 px']) {
    assert.deepEqual([...s.matchAll(lib.UNIT_NUMBER)].map((m) => m[0]), [], s);
  }
});

// ---------- HTML: Unicode and adjacency ----------
test('12000 × 12000 is a dimension; 3.4× and 2–3× lower are matches', async () => {
  const text = await fixture(HTML, 'unicode-and-adjacency.html'), f = lib.scanHtml(text, 'u.html');
  assert.deepEqual(untaggedOn(f, lineOf(text, '12000')), []);
  assert.deepEqual(untaggedOn(f, lineOf(text, '3.4×')), ['3.4×']);
  assert.deepEqual(untaggedOn(f, lineOf(text, '2–3×')), ['2–3×']);
});

test('1.7 µs (U+00B5) and 1.7 μs (U+03BC) both match', async () => {
  const text = await fixture(HTML, 'unicode-and-adjacency.html'), f = lib.scanHtml(text, 'u.html');
  assert.deepEqual(untaggedOn(f, lineOf(text, 'micro sign')), ['1.7 µs']);
  assert.deepEqual(untaggedOn(f, lineOf(text, 'Greek mu')), ['1.7 μs']);
});

test('−0.37 ms with U+2212 matches as a negative value', async () => {
  const text = await fixture(HTML, 'unicode-and-adjacency.html'), f = lib.scanHtml(text, 'u.html');
  assert.deepEqual(untaggedOn(f, lineOf(text, '0.37')), ['−0.37 ms']);
});

test('10<sup>9</sup> ns is read as 10 9 ns (tag replaced by a space), never as 109 ns', async () => {
  const text = await fixture(HTML, 'unicode-and-adjacency.html'), f = lib.scanHtml(text, 'u.html');
  assert.deepEqual(untaggedOn(f, lineOf(text, '<sup>')), ['9 ns']);
  assert.ok(!f.some((x) => /109/.test(x.message)));
});

test('an en-dash range 31.0–37.3 ms is one finding, not two', async () => {
  const text = await fixture(HTML, 'unicode-and-adjacency.html'), f = lib.scanHtml(text, 'u.html');
  assert.deepEqual(untaggedOn(f, lineOf(text, '31.0')), ['31.0–37.3 ms']);
});

test('text inside a data-placeholder attribute value is not scanned', async () => {
  const text = await fixture(HTML, 'unicode-and-adjacency.html'), f = lib.scanHtml(text, 'u.html');
  assert.deepEqual(codesOn(f, lineOf(text, 'data-placeholder')), []);
});

test('a data-claim marker covers only its own leaf: the tagged 153.0M passes and 12 ms beside it is reported', async () => {
  const text = await fixture(HTML, 'unicode-and-adjacency.html'), f = lib.scanHtml(text, 'u.html');
  const line = lineOf(text, '153.0M');
  assert.deepEqual(codesOn(f, line), ['UNTAGGED_NUMBER']);
  assert.deepEqual(untaggedOn(f, line), ['12 ms']);
});

test('entities are decoded before the scan (&nbsp; &times; &micro; &minus;)', async () => {
  const text = await fixture(HTML, 'unicode-and-adjacency.html'), f = lib.scanHtml(text, 'u.html');
  assert.deepEqual(untaggedOn(f, lineOf(text, 'Entities')), ['5 ms', '2×', '4 µs', '−1.5 ms']);
  assert.deepEqual(codesOn(f, lineOf(text, 'Not units')), []);
});

// ---------- HTML: waivers ----------
test('a data-claim-waiver with a reason passes and its number is not reported', async () => {
  const text = await fixture(HTML, 'waivers.html'), f = lib.scanHtml(text, 'w.html');
  assert.deepEqual(codesOn(f, lineOf(text, '333 ns')), []);
  assert.deepEqual(codesOn(f, lineOf(text, 'largest upload')), [], 'a waived .pd-metrics value is not METRIC_UNTAGGED');
});

test('a waiver whose reason is empty or a placeholder fails WAIVER_NO_REASON', async () => {
  const text = await fixture(HTML, 'waivers.html'), f = lib.scanHtml(text, 'w.html');
  for (const needle of ['waiver=""', '"TBD"', '"n/a"', '" todo "', '"-"', 'waiver>']) {
    assert.deepEqual(codesOn(f, lineOf(text, needle)), ['WAIVER_NO_REASON'], needle);
  }
});

test('a waiver on an element that is not a leaf fails LEAF_NOT_LEAF and its numbers are still scanned', async () => {
  const text = await fixture(HTML, 'waivers.html'), f = lib.scanHtml(text, 'w.html');
  const line = lineOf(text, 'Not a leaf');
  assert.deepEqual(codesOn(f, line).sort(), ['LEAF_NOT_LEAF', 'UNTAGGED_NUMBER']);
  assert.deepEqual(untaggedOn(f, line), ['11 ms']);
});

// ---------- HTML: edge cases ----------
test('a data-claim leaf with empty text fails CLAIM_MISMATCH through the CLI', async () => {
  const page = '<p>Calls per second: <span data-claim="rl.fixture.hot_denied.t8"></span></p>\n';
  await withRoot({ 'pages/projects/rate-limiter.html': page }, async (dir) => {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /rate-limiter\.html:1 CLAIM_MISMATCH rl\.fixture\.hot_denied\.t8: "" /);
  });
});

test('a page with no numbers passes', () => {
  assert.deepEqual(lib.scanHtml('<section>\n  <p>Nothing here is measured.</p>\n</section>\n', 'empty.html'), []);
});

test('three untagged numbers in one file give three findings in source order', () => {
  const f = lib.scanHtml('<p>first 1 ms</p>\n<p>then 2 ms</p>\n<!-- 9 ms -->\n<p>last 3 ms</p>\n', 'three.html');
  assert.deepEqual(f.map((x) => [x.line, token(x)]), [[1, '1 ms'], [2, '2 ms'], [4, '3 ms']]);
});

test('a 3 MiB input yields INPUT_TOO_LARGE from both scans', () => {
  const big = 'a'.repeat(3 * MiB);
  assert.deepEqual(lib.scanHtml(big, 'big.html').map((f) => f.code), ['INPUT_TOO_LARGE']);
  assert.deepEqual(scanJs(big, 'big.js').map((f) => f.code), ['INPUT_TOO_LARGE']);
});

test('a 1 MiB pathological input is scanned in linear time (under 1 second)', () => {
  for (const input of ['1,'.repeat(MiB / 2), '<a 1 '.repeat(MiB / 5), '1-'.repeat(MiB / 2)]) {
    const t0 = performance.now();
    assert.deepEqual(lib.scanHtml(input, 'slow.html').filter((f) => f.code !== 'UNTAGGED_NUMBER').length, 0);
    const html = performance.now() - t0;
    scanJs(input, 'slow.js');
    const total = performance.now() - t0;
    assert.ok(html < 1000 && total - html < 1000, `${input.slice(0, 6)}...: html ${html.toFixed(0)} ms, js ${(total - html).toFixed(0)} ms`);
  }
});

// ---------- JS ----------
test('a JS line with a reasoned // claim-waiver passes; the same line without one fails', async () => {
  const text = await fixture(JS, 'demo-literals.js'), f = scanJs(text, 'demo.js');
  assert.deepEqual(codesOn(f, lineOf(text, "'10 s'")), []);
  assert.deepEqual(untaggedOn(f, lineOf(text, "'30 s'")), ['30 s']);
  // core.autocrlf=true checkouts: the waiver still applies on a CRLF line, and lines keep their numbers.
  const crlf = scanJs(text.replace(/\n/g, '\r\n'), 'demo.js');
  assert.deepEqual(crlf.map((x) => [x.line, x.code]), f.map((x) => [x.line, x.code]));
});

test('a JS claim-waiver with a placeholder reason fails WAIVER_NO_REASON', async () => {
  const text = await fixture(JS, 'demo-literals.js'), f = scanJs(text, 'demo.js');
  assert.deepEqual(codesOn(f, lineOf(text, "'60 s'")), ['WAIVER_NO_REASON']);
  assert.deepEqual(scanJs("x('1 s'); // claim-waiver:\n").map((x) => x.code), ['WAIVER_NO_REASON']);
});

test("'https://x//10 ms' inside a string is not cut by comment stripping", async () => {
  const text = await fixture(JS, 'demo-literals.js'), f = scanJs(text, 'demo.js');
  assert.deepEqual(untaggedOn(f, lineOf(text, 'https://')), ['10 ms']);
});

test('JS comments are not scanned; template markup tags become spaces', async () => {
  const text = await fixture(JS, 'demo-literals.js'), f = scanJs(text, 'demo.js');
  assert.deepEqual(codesOn(f, lineOf(text, '99 ms')), []);
  assert.deepEqual(untaggedOn(f, lineOf(text, '6 MB')), ['6 MB']);
  assert.deepEqual(untaggedOn(f, lineOf(text, '<b>10</b>')), ['10 s', '1024 bytes']);
  assert.deepEqual(codesOn(f, lineOf(text, '12 ms')), []);
  assert.deepEqual(codesOn(f, lineOf(text, 'no figures')), []);
});

test('--only js scans scripts/demos/*.js and reports every finding in source order', async () => {
  const text = await fixture(JS, 'demo-literals.js');
  await withRoot({ 'scripts/demos/demo-literals.js': text }, async (dir) => {
    const r = await run(dir, ['--only', 'js']);
    assert.equal(r.code, 1, r.stdout);
    const lines = r.stdout.trim().split('\n').slice(0, -1);
    assert.ok(lines.every((l) => l.startsWith('[check-claims] scripts/demos/demo-literals.js:')), r.stdout);
    assert.deepEqual(lines.map((l) => Number(/:(\d+) /.exec(l)[1])), [4, 5, 7, 9, 10, 10]);
  });
});

test('the default run (no --only) includes the html and js scans', async () => {
  const text = await fixture(JS, 'demo-literals.js');
  await withRoot({ 'scripts/demos/demo-literals.js': text, 'pages/projects/rate-limiter.html': '<p>about 30 ms</p>\n' }, async (dir) => {
    const r = await run(dir);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /rate-limiter\.html:1 UNTAGGED_NUMBER "30 ms"/);
    assert.match(r.stdout, /demo-literals\.js:4 UNTAGGED_NUMBER "30 s"/);
  });
});
