// AUDIT-01 and common-phrasing regression guard for the untagged-number scan (CLAIM-05, D-05): the figures Phase 1
// removed, and the usual ways of writing a rate, a time or a speedup, fail UNTAGGED_NUMBER in HTML, demo JS and READMEs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const MD = path.join(HERE, 'fixtures', 'md');
const MiB = 1024 * 1024;

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const run = (root, extra = []) => cli(['--root', root, '--claims', path.join(BASIC, 'claims.json'), '--evidence-root', path.join(BASIC, 'evidence'), ...extra]);
// The README checks on one file, against the md fixture claims and the basic fixture evidence tree.
const checkReadme = (file) => cli(['--only', 'readme', '--readme-file', `ratelimit-cpp=${file}`,
  '--claims', path.join(MD, 'claims.md.json'), '--evidence-root', path.join(BASIC, 'evidence')]);
// A throwaway root holding `files` ({ 'pages/projects.html': '<text>' }); removed after `body` runs.
async function withRoot(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'untagged-forms-'));
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
// Check mode writes nothing: the root holds exactly the files written, with the bytes written.
async function assertUntouched(dir, files) {
  const listed = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).split(path.sep).join('/')).sort();
  assert.deepEqual(listed, Object.keys(files).sort());
  for (const [rel, text] of Object.entries(files)) assert.equal(await readFile(path.join(dir, rel), 'utf8'), text, rel);
}
const fixture = (dir, name) => readFile(path.join(dir, name), 'utf8');
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
const tokens = (s) => [...s.matchAll(lib.UNIT_NUMBER)].map((m) => m[0]);
// Finding lines of CLI stdout (the summary line dropped), parsed into { file, line, code, token }.
function findingsOf(stdout) {
  return stdout.trim().split('\n').slice(0, -1).map((l) => {
    const m = /^\[check-claims\] (.+):(\d+) (\S+) (.*)$/.exec(l);
    assert.ok(m, l);
    return { file: m[1], line: Number(m[2]), code: m[3], token: /^"(.*?)" has a unit/.exec(m[4])?.[1] };
  });
}
// Every finding is UNTAGGED_NUMBER; returns the tokens in output order.
function untaggedTokens(stdout) {
  const f = findingsOf(stdout);
  assert.deepEqual([...new Set(f.map((x) => x.code))], ['UNTAGGED_NUMBER'], stdout);
  return f.map((x) => x.token);
}
const NOT_UNITS = 'Not units: CMake 3.16+, bits 32+ pick a shard, over 30+ images, 2.8M+ impressions, retried 3 times, dated 10 s/2026.';

// ---------- Tracer (CLI) ----------
test('the Phase 1 card stat 100+ req/s fails UNTAGGED_NUMBER through the CLI', async () => {
  const text = await fixture(HTML, 'audit-01.html');
  await withRoot({ 'pages/projects.html': text }, async (dir) => {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1, r.stdout);
    const line = lineOf(text, 'project-stat">100+ req/s');
    assert.ok(line > 0);
    assert.match(r.stdout, new RegExp(String.raw`^\[check-claims\] pages/projects\.html:${line} UNTAGGED_NUMBER "100\+ req/s"`, 'm'));
  });
});

// ---------- CLI: HTML, demo JS, README ----------
// The CLI orders findings by file, line, code, then message (sortFindings), so two figures on one line print in
// message order; the pure scanners keep source order. Both lists are pinned.
test('HTML: every AUDIT-01 form and escaping phrasing fails UNTAGGED_NUMBER; waived and non-units stay quiet', async () => {
  const text = await fixture(HTML, 'audit-01.html'), files = { 'pages/projects.html': text };
  const tail = ['40 ns', '25–300 ns', '100+ requests/sec', '30-60 ms', '375 times faster', '1,200 requests/sec', '5,000 ops/sec',
    '12,000 commands per second', '2.1 million operations per second', '3 milliseconds'];
  assert.deepEqual(lib.scanHtml(text, 'p.html').map((f) => /^"(.*?)" has a unit/.exec(f.message)?.[1]),
    ['100+ req/s', '75.7M ops/s', '40ns', '375×', ...tail]);
  await withRoot(files, async (dir) => {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(untaggedTokens(r.stdout), ['100+ req/s', '75.7M ops/s', '375×', '40ns', ...tail]);
    const lines = findingsOf(r.stdout).map((x) => x.line);
    assert.ok(!lines.includes(lineOf(text, 'Waived:')) && !lines.includes(lineOf(text, 'Not units')), r.stdout);
    await assertUntouched(dir, files);
  });
});

test('demo JS: every form fails UNTAGGED_NUMBER on its own line; the claim-waiver line passes', async () => {
  const text = await fixture(JS, 'audit-01.js'), files = { 'scripts/demos/ratelimit.js': text };
  const expected = ['100+ req/s', '75.7M ops/s', '40 ns', '375 times faster', '100+ requests/sec', '1,200 requests/sec', '5,000 ops/sec',
    '12,000 commands per second', '2.1 million operations per second', '3 milliseconds'];
  assert.deepEqual(lib.scanJsLines(text, 'r.js').map((f) => /^"(.*?)" has a unit/.exec(f.message)?.[1]), expected);
  await withRoot(files, async (dir) => {
    const r = await run(dir, ['--only', 'js']);
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(untaggedTokens(r.stdout), expected);
    assert.ok(!findingsOf(r.stdout).some((x) => x.line === lineOf(text, 'SYNTHETIC')), r.stdout);
    await assertUntouched(dir, files);
  });
});

test('README: prose, list item and fenced forms fail UNTAGGED_NUMBER; the marker still verifies and the waiver passes', async () => {
  const text = await fixture(MD, 'README.audit-01.md'), files = { 'README.md': text };
  const tail = ['100+ requests/sec', '100+ req/s', '1,200 requests/sec', '5,000 ops/sec', '12,000 commands per second',
    '2.1 million operations per second', '3 milliseconds'];
  const pure = lib.scanMarkdown(text, 'README.md');
  assert.deepEqual(pure.markers.map((m) => [m.id, m.text]), [['rl.fixture.clock_fast', '10.2 ns']]);
  assert.deepEqual(pure.findings.map((f) => /^"(.*?)" has a unit/.exec(f.message)?.[1]), ['75.7M ops/s', '40 ns', '375 times faster', ...tail]);
  await withRoot(files, async (dir) => {
    const r = await checkReadme(path.join(dir, 'README.md'));
    assert.equal(r.code, 1, r.stdout);
    assert.doesNotMatch(r.stdout, /CLAIM_|EVIDENCE_/);
    assert.deepEqual(untaggedTokens(r.stdout), ['375 times faster', '40 ns', '75.7M ops/s', ...tail]);
    const f = findingsOf(r.stdout);
    assert.equal(f.find((x) => x.token === '100+ req/s').line, lineOf(text, 'throughput:'));
    assert.ok(!f.some((x) => x.line === lineOf(text, 'claim-waiver')), r.stdout);
    await assertUntouched(dir, files);
  });
});

test('a reasoned waiver exempts a new-form figure in each context', () => {
  assert.deepEqual(lib.scanHtml('<p><span data-claim-waiver="workload parameter, not a measurement">5,000 ops/sec</span></p>\n', 'w.html'), []);
  assert.deepEqual(lib.scanJsLines("const R = '12,000 commands per second'; // claim-waiver: workload parameter, not a measurement\n", 'w.js'), []);
  assert.deepEqual(lib.scanMarkdown('<!-- claim-waiver: workload parameter, not a measurement --> 1,200 requests/sec.\n', 'w.md').findings, []);
});

// ---------- Unit regex ----------
test('a glued + is part of the number; a spaced + is not', () => {
  assert.deepEqual(tokens('2.8M+ ops/s'), ['2.8M+ ops/s']);
  assert.deepEqual(tokens('1,200+ ms'), ['1,200+ ms']);
  assert.deepEqual(tokens('100 + 5 ms'), ['5 ms']);
  assert.deepEqual(tokens('C++ 17 ms'), ['17 ms']);
});

test('rates, per-second phrases, spelled-out time units, N times comparatives and unit/word compounds are one token each', () => {
  for (const s of ['5,000 ops/sec', '20 req/sec', '4 requests/s', '1,200 requests/sec', '3 requests/second', '4 commands/s', '20 cmd/sec',
    '6 queries/s', '2 Mops/sec', '1 request per second', '4 calls per second', '7 commands a second', '5 requests a second',
    '12,000 commands per second', '2.1 million operations per second', '3 thousand requests/sec', '1.5 billion ops/s',
    '3 milliseconds', '1 millisecond', '7 microseconds', '900 nanoseconds', '375 times faster', '9 times slower', '2 times more',
    '2 times less', '4 times fewer', '3 times higher', '5 times lower', '500 MB/s', '1.2 GB/sec', '10 ns/op', '3 µs/call']) {
    assert.deepEqual(tokens(`It ran ${s}, then stopped.`), [s], s);
  }
});

test('UNIT_NUMBER is built without the u flag and matches the same tokens on the AUDIT-01 text if u is added', async () => {
  const sample = (await fixture(HTML, 'audit-01.html')).replace(/<[^>]*>/g, ' ');
  assert.ok(!lib.UNIT_NUMBER.flags.includes('u'));
  const plain = [...sample.matchAll(lib.UNIT_NUMBER)].map((m) => [m.index, m[0]]);
  const unicode = [...sample.matchAll(new RegExp(lib.UNIT_NUMBER.source, 'gu'))].map((m) => [m.index, m[0]]);
  assert.ok(plain.length > 10);
  assert.deepEqual(unicode, plain);
});

// ---------- Edges ----------
test('adjacency: a spaced +, a slash before a digit and 2x/3x; a README marker binds the whole token', () => {
  assert.deepEqual(tokens('100 + 5 ms'), ['5 ms']);
  assert.deepEqual(tokens('dated 10 s/2026'), []);
  assert.deepEqual(tokens('2x/3x'), ['2x', '3x']);
  for (const [line, id, text] of [['<!-- claim:x --> 100+ req/s\n', 'x', '100+ req/s'], ['<!-- claim:y --> 500 MB/s\n', 'y', '500 MB/s']]) {
    const r = lib.scanMarkdown(line, 'a.md');
    assert.deepEqual(r.markers.map((m) => [m.id, m.text]), [[id, text]], line);
    assert.deepEqual(r.findings.filter((f) => f.code === 'UNTAGGED_NUMBER'), [], line);
  }
});

test('empty input and numbers with no unit give zero findings from all three scanners', () => {
  for (const s of ['', NOT_UNITS, `<p>${NOT_UNITS}</p>\n`]) {
    assert.deepEqual(lib.scanHtml(s, 'n.html'), [], s);
    assert.deepEqual(lib.scanJsLines(s, 'n.js'), [], s);
    assert.deepEqual(lib.scanMarkdown(s, 'n.md').findings, [], s);
  }
});

test('ordering: two CLI runs on the HTML fixture print byte-identical stdout with non-decreasing lines', async () => {
  const files = { 'pages/projects.html': await fixture(HTML, 'audit-01.html') };
  await withRoot(files, async (dir) => {
    const a = await run(dir, ['--only', 'html']), b = await run(dir, ['--only', 'html']);
    assert.equal(a.stdout, b.stdout);
    const lines = findingsOf(a.stdout).map((x) => x.line);
    assert.ok(lines.every((n, i) => i === 0 || n >= lines[i - 1]), a.stdout);
    await assertUntouched(dir, files);
  });
});

test('a 1 MiB pathological input of each new form scans in linear time (under 1 second per scanner)', () => {
  for (const unit of ['1+', '1 million ', '1 times ', '1 requests per ', '1 MB/', '1 MB/abcdefghijk']) {
    const input = unit.repeat(Math.floor(MiB / unit.length));
    for (const [name, scan] of [['html', lib.scanHtml], ['js', lib.scanJsLines], ['md', lib.scanMarkdown]]) {
      const t0 = performance.now();
      scan(input, `slow.${name}`);
      const ms = performance.now() - t0;
      assert.ok(ms < 1000, `${JSON.stringify(unit)} ${name}: ${ms.toFixed(0)} ms`);
    }
  }
});
