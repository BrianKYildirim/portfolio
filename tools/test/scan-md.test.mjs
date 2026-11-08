// Tests of the README checks (CLAIM-03, CLAIM-05, BENCH-04): inline markers, waivers, fences, numeric table cells,
// generated claims-table blocks and the bench-methodology block, through tools/check-claims.mjs and as pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import * as lib from '../claims-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'check-claims.mjs');
const MD = path.join(HERE, 'fixtures', 'md');
const CLAIMS = path.join(MD, 'claims.md.json');
const EVIDENCE = path.join(HERE, 'fixtures', 'basic', 'evidence');

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
// The README checks on one file, against the md fixture claims and the basic fixture evidence tree.
const checkReadme = (file, only = 'readme', extra = []) => cli(['--only', only, '--readme-file', `ratelimit-cpp=${file}`,
  '--claims', CLAIMS, '--evidence-root', EVIDENCE, ...extra]);
// A throwaway directory holding `files` ({ 'README.md': '<text>' }); removed after `body` runs.
async function withDir(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scan-md-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const fixture = (name) => readFile(path.join(MD, name), 'utf8');
const codes = (findings) => findings.map((f) => f.code);
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

// ---------- Tracer (CLI) ----------
test('an inline README marker is verified end to end against its approved claim and evidence (exit 0)', async () => {
  const r = await checkReadme(path.join(MD, 'README.basic.md'));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /\[check-claims\] ok .*1 tagged value\(s\)/);
});

test('a README value that differs from the approved claim fails CLAIM_MISMATCH (exit 1)', async () => {
  const text = (await fixture('README.basic.md')).replace('10.2 ns', '12.0 ns');
  await withDir({ 'README.md': text }, async (dir) => {
    const r = await checkReadme(path.join(dir, 'README.md'));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, new RegExp(String.raw`README\.md:${lineOf(text, '12.0 ns')} CLAIM_MISMATCH rl\.fixture\.clock_fast: "12\.0 ns"`));
  });
});

test('an unmarked unit-number in the same README fails UNTAGGED_NUMBER on its true line (exit 1)', async () => {
  const text = `${await fixture('README.basic.md')}\nA steady_clock read took about 16 ns.\n`;
  await withDir({ 'README.md': text }, async (dir) => {
    const r = await checkReadme(path.join(dir, 'README.md'));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, new RegExp(String.raw`README\.md:${lineOf(text, 'about 16 ns')} UNTAGGED_NUMBER "16 ns"`));
    assert.doesNotMatch(r.stdout, /CLAIM_MISMATCH|"10\.2 ns"/);
  });
});

test('the basic HTML fixture still passes --only html with the windows-native evidence file added', async () => {
  const basic = path.join(HERE, 'fixtures', 'basic');
  const r = await cli(['--root', basic, '--claims', path.join(basic, 'claims.json'), '--evidence-root', EVIDENCE, '--only', 'html']);
  assert.equal(r.code, 0, r.stdout);
});

test('--readme-file is listed in the usage text, and --only readme without one is a usage error (exit 2)', async () => {
  const bad = await cli(['--nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.stdout, /--readme-file <project>=<path>/);
  // --evidence-root: the fixture seam has no README source (API and --local modes read the upstream READMEs).
  const none = await cli(['--only', 'readme', '--claims', CLAIMS, '--evidence-root', EVIDENCE]);
  assert.equal(none.code, 2);
  assert.match(none.stdout, /needs --readme-file/);
});

// ---------- Full markdown rules ----------
// Library calls go through a guard, so a missing export is an assertion failure rather than a TypeError.
const fn = (name) => { assert.equal(typeof lib[name], 'function', `claims-lib.mjs exports ${name}`); return lib[name]; };
const scan = (text) => fn('scanMarkdown')(text, 'README.md');
const tables = (text, d = DOC) => fn('checkTables')(text, 'README.md', d);
const methodology = (text) => fn('checkMethodology')(text, 'README.md');
const DOC = JSON.parse(await readFile(CLAIMS, 'utf8'));
const BY_ID = new Map(DOC.claims.map((c) => [c.id, c]));
const SPEC = (id) => DOC.tables.find((t) => t.id === id);
const on = (findings, code) => findings.filter((f) => f.code === code).map((f) => f.line);
const tmpFiles = async (dir) => (await readdir(dir)).filter((f) => f.includes('.tmp-'));
const EXAMPLE_TABLE = [
  '| Scenario | 1 thread |',
  '|---|---:|',
  '| One hot key, every call allowed (`Hot_Allowed`) | 36.3M (31.0–37.3M) |',
  '| One hot key, almost every call denied (`Hot_Denied`) | 44.5M (41.5–45.2M) |',
].join('\n');
const block = (id, body) => `<!-- claims-table:begin id=${id} -->\n${body}\n<!-- claims-table:end -->\n`;

test('[adjacency] a marker binds to the first number token after it on its line, with its unit or "runs"', () => {
  const r = scan('About <!-- claim:a --> roughly 10.2 ns, then 16 ns.\n<!-- claim:b#n --> 10 runs; <!-- claim:c#spread --> 31.0–37.3M\n');
  assert.deepEqual(r.markers.map((m) => [m.id, m.field, m.text, m.line]),
    [['a', 'value', '10.2 ns', 1], ['b', 'n', '10 runs', 2], ['c', 'spread', '31.0–37.3M', 2]]);
  assert.deepEqual(r.findings.map((f) => [f.code, f.line]), [['UNTAGGED_NUMBER', 1]]);
  assert.match(r.findings[0].message, /^"16 ns"/);
  assert.doesNotMatch(r.markers[0].context, /claim:a/, 'the label context is the line without its comments');
});

test('[adjacency] a marker with no number after it on its line fails MD_MARKER_NO_NUMBER and never reaches the next line', () => {
  const r = scan('It took 10 ns <!-- claim:a -->\n20 ns later\n');
  assert.deepEqual(r.markers, []);
  assert.deepEqual(r.findings.map((f) => [f.code, f.line]), [['MD_MARKER_NO_NUMBER', 1], ['UNTAGGED_NUMBER', 1], ['UNTAGGED_NUMBER', 2]]);
});

test('a comparison marker in a README matches the whole display string on its line; its token must be the ratio', async () => {
  const cmp = (id, value, display) => ({ id, kind: 'comparison', status: 'approved', value, display: { value: [display] } });
  const byId = new Map([
    ['cmp.fast', cmp('cmp.fast', 3.012, 'faster on Ubuntu on WSL2 by ~3.0×, medians of 10 runs each')],
    ['cmp.same', cmp('cmp.same', 1.1, 'no measurable difference (medians of 7 runs each)')],
  ]);
  const check = (text) => fn('checkTagged')(byId, scan(text).markers, async () => { throw new Error('no evidence read expected'); });
  assert.deepEqual(await check('Hot_Denied at 8 threads was <!-- claim:cmp.fast -->faster on Ubuntu on WSL2 by ~3.0×, medians of 10 runs each.\n'), []);
  assert.deepEqual(await check('p50: <!-- claim:cmp.same -->no measurable difference (medians of 7 runs each).\n'), []);
  // The line holds only the token, or another ratio: the display string is not there in full.
  assert.deepEqual(codes(await check('It was <!-- claim:cmp.fast -->3.0× faster.\n')), ['CLAIM_MISMATCH']);
  assert.deepEqual(codes(await check('Was <!-- claim:cmp.fast -->faster on Ubuntu on WSL2 by ~2.0×, medians of 10 runs each.\n')), ['CLAIM_MISMATCH']);
  // An HTML leaf still has to hold a display string exactly.
  const leaf = { file: 'p.html', id: 'cmp.fast', field: 'value', line: 1, notLeaf: false, text: '3.0×', context: 'faster on Ubuntu on WSL2 by ~3.0×, medians of 10 runs each' };
  assert.deepEqual(codes(await fn('checkTagged')(byId, [leaf], async () => '')), ['CLAIM_MISMATCH']);
});

test('[empty] a README with no unit-numbers and no markers passes the scan', () => {
  assert.deepEqual(scan('# Title\n\nNothing is measured here; the table has 128 shards.\n'), { markers: [], findings: [] });
});

test('a reasoned waiver exempts the number after it; an empty or placeholder reason fails WAIVER_NO_REASON', () => {
  assert.deepEqual(scan('<!-- claim-waiver: dimension, not a measurement --> 12000 × 12000\n').findings, []);
  assert.deepEqual(scan('Capped at <!-- claim-waiver: configuration limit, not a measurement --> 6 MB.\n').findings, []);
  assert.deepEqual(codes(scan('Capped at 6 MB.\n').findings), ['UNTAGGED_NUMBER']);
  for (const w of ['<!-- claim-waiver: -->', '<!-- claim-waiver: TBD -->', '<!-- claim-waiver: n/a -->', '<!-- claim-waiver -->']) {
    assert.deepEqual(codes(scan(`Capped at ${w} 6 MB.\n`).findings), ['WAIVER_NO_REASON'], w);
  }
  assert.deepEqual(codes(scan('A note <!-- claim-waiver: stale, nothing follows -->\n').findings), ['MD_MARKER_NO_NUMBER']);
});

test('text inside a block waiver is not scanned; a begin without an end fails WAIVER_UNTERMINATED and the rest is still scanned', () => {
  const ok = '<!-- claim-waiver-begin: example trace output -->\n```\ntook 31 ns\n```\n<!-- claim-waiver-end -->\nAfter: 5 ms\n';
  assert.deepEqual(scan(ok).findings.map((f) => [f.code, f.line]), [['UNTAGGED_NUMBER', 6]]);
  const open = 'Before.\n<!-- claim-waiver-begin: example trace output -->\ntook 31 ns\n';
  assert.deepEqual(scan(open).findings.map((f) => [f.code, f.line]), [['WAIVER_UNTERMINATED', 2], ['UNTAGGED_NUMBER', 3]]);
  assert.deepEqual(codes(scan('<!-- claim-waiver-begin: -->\ntook 31 ns\n<!-- claim-waiver-end -->\n').findings), ['WAIVER_NO_REASON']);
  assert.deepEqual(codes(scan('stray <!-- claim-waiver-end -->\n').findings), ['WAIVER_UNTERMINATED']);
});

test('a unit-number inside a fenced code block outside any block waiver fails UNTAGGED_NUMBER; a waiver inside a fence is just text', () => {
  assert.deepEqual(on(scan('Run:\n```sh\n./rl_latency 0.5 8   # took 31 ns\n```\n').findings, 'UNTAGGED_NUMBER'), [3]);
  assert.deepEqual(on(scan('~~~\n<!-- claim-waiver: example --> 31 ns\n~~~\n').findings, 'UNTAGGED_NUMBER'), [2]);
});

test('a numeric table cell outside a claims-table block fails TABLE_CELL_UNTAGGED; header and separator rows are exempt', () => {
  const one = scan('| Scenario | 1 thread |\n|---|---|\n| Hot_Allowed | 36.3M (31.0–37.3M) |\n');
  assert.deepEqual(one.findings.map((f) => [f.code, f.line]), [['TABLE_CELL_UNTAGGED', 3]]);
  assert.match(one.findings[0].message, /36\.3M \(31\.0–37\.3M\)/);
  // Units in the header do not exempt unit-less cells (RESEARCH Pitfall 9); the leading-sign variants all count.
  const units = scan('  | Keys | Bytes per key |\n  |---:|---:|\n  | 700,000 | ~97 |\n');
  assert.deepEqual(on(units.findings, 'TABLE_CELL_UNTAGGED'), [3, 3]);
  const signs = scan('| a | b | c | d | e |\n|---|---|---|---|---|\n| +0.05 [−0.37, +0.50] | −3 | ≈5 | **36.3M** | One hot key |\n');
  assert.equal(on(signs.findings, 'TABLE_CELL_UNTAGGED').length, 4);
});

test('a marked or waived table cell passes, and a table inside a fence is not a table', () => {
  const marked = scan('| Scenario | 1 thread |\n|---|---|\n| Hot | <!-- claim:rl.fixture.hot_allowed.t1 --> 36.3M |\n| Keys | <!-- claim-waiver: key count, a configuration --> 700,000 |\n');
  assert.deepEqual(marked.findings, []);
  assert.deepEqual(marked.markers.map((m) => [m.text, m.line]), [['36.3M', 3]]);
  assert.deepEqual(scan('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n').findings, []);
});

test('the same row inside a rendered claims-table block passes every README check through the CLI', async () => {
  const r = await checkReadme(path.join(MD, 'README.tables.md'), 'readme,tables,methodology');
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /ok \(checks: readme, tables, methodology; .*6 tagged value\(s\)/);
  assert.deepEqual(scan(await fixture('README.tables.md')).findings, []);
});

test('renderTable gives a GFM table: header, ---: for numeric columns, one row per spec row in order', () => {
  const render = fn('renderTable');
  const r = render(SPEC('rl.fixture.example_run'), BY_ID);
  assert.deepEqual(r.findings, []);
  assert.equal(r.text, EXAMPLE_TABLE);
  assert.equal(render(SPEC('rl.fixture.example_run'), BY_ID).text, r.text, 'rendering twice is byte-identical');
  const reversed = { ...SPEC('rl.fixture.example_run'), rows: [...SPEC('rl.fixture.example_run').rows].reverse() };
  assert.deepEqual(render(reversed, BY_ID).text.split('\n').slice(2), EXAMPLE_TABLE.split('\n').slice(2).reverse());
});

test('[empty] a spec with zero rows fails TABLE_EMPTY; a proposed claim fails CLAIM_NOT_APPROVED; an unknown claim fails CLAIM_UNKNOWN', () => {
  const render = fn('renderTable');
  assert.deepEqual(codes(render(SPEC('rl.fixture.empty'), BY_ID).findings), ['TABLE_EMPTY']);
  assert.deepEqual(codes(render(SPEC('rl.fixture.proposed_table'), BY_ID).findings), ['CLAIM_NOT_APPROVED']);
  const unknown = { ...SPEC('rl.fixture.proposed_table'), rows: [{ cells: [{ text: 'x' }, { claim: 'rl.nope' }] }] };
  assert.deepEqual(codes(render(unknown, BY_ID).findings), ['CLAIM_UNKNOWN']);
  assert.equal(render(SPEC('rl.fixture.empty'), BY_ID).text, null);
});

test('checkTables: a committed block that matches its render passes and yields the claim cells for checkTagged', async () => {
  const r = tables(await fixture('README.tables.md'));
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.markers.map((m) => [m.id, m.field, m.text, m.line]), [
    ['rl.fixture.hot_allowed.t1', 'value', '36.3M', 10], ['rl.fixture.hot_allowed.t1', 'spread', '31.0–37.3M', 10],
    ['rl.fixture.hot_denied.t1', 'value', '44.5M', 11], ['rl.fixture.hot_denied.t1', 'spread', '41.5–45.2M', 11]]);
});

test('checkTables: a block that differs from its render fails TABLE_DRIFT at the first differing line', async () => {
  const text = await fixture('README.tables.md');
  assert.deepEqual(tables(text.replace('36.3M (31.0–37.3M)', '36.4M (31.0–37.3M)')).findings.map((f) => [f.code, f.line]), [['TABLE_DRIFT', 10]]);
  assert.deepEqual(on(tables(text.replace(/^\| One hot key, almost.*\n/m, '')).findings, 'TABLE_DRIFT'), [11]);
  assert.deepEqual(on(tables(text.replace('|---|---:|', '|---|---|')).findings, 'TABLE_DRIFT'), [9]);
});

test('checkTables: unknown, empty, proposed and unterminated blocks fail with their own codes', () => {
  assert.deepEqual(codes(tables(block('rl.fixture.nope', 'x')).findings), ['TABLE_UNKNOWN']);
  assert.deepEqual(codes(tables(block('rl.fixture.empty', '')).findings), ['TABLE_EMPTY']);
  assert.deepEqual(codes(tables(block('rl.fixture.proposed_table', '| Scenario | 1 thread |\n|---|---:|\n| Proposed | 44.5M |')).findings), ['CLAIM_NOT_APPROVED']);
  assert.deepEqual(codes(tables(`<!-- claims-table:begin id=rl.fixture.example_run -->\n${EXAMPLE_TABLE}\n`).findings), ['TABLE_UNTERMINATED']);
});

test('a table display string that does not round to its claim value fails CLAIM_MISMATCH through the CLI', async () => {
  const doc = JSON.parse(JSON.stringify(DOC));
  doc.claims.find((c) => c.id === 'rl.fixture.hot_allowed.t1').display.value = ['36.4M'];
  const text = (await fixture('README.tables.md')).replace('36.3M (31.0–37.3M)', '36.4M (31.0–37.3M)');
  await withDir({ 'claims.json': JSON.stringify(doc), 'README.md': text }, async (dir) => {
    const r = await cli(['--only', 'tables', '--readme-file', `ratelimit-cpp=${path.join(dir, 'README.md')}`,
      '--claims', path.join(dir, 'claims.json'), '--evidence-root', EVIDENCE]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /README\.md:10 CLAIM_MISMATCH rl\.fixture\.hot_allowed\.t1: "36\.4M" does not round/);
    assert.doesNotMatch(r.stdout, /TABLE_DRIFT/);
  });
});

test('--render-tables rewrites a drifted block through a temp file and rename; check mode then passes', async () => {
  const good = await fixture('README.tables.md');
  await withDir({ 'README.md': good.replace('44.5M (41.5–45.2M)', '45.0M (41.5–45.2M)') }, async (dir) => {
    const file = path.join(dir, 'README.md');
    assert.match((await checkReadme(file, 'tables')).stdout, /TABLE_DRIFT/);
    const r = await cli(['--render-tables', `ratelimit-cpp=${file}`, '--claims', CLAIMS]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(await readFile(file, 'utf8'), good);
    assert.deepEqual(await tmpFiles(dir), []);
    const after = await checkReadme(file, 'readme,tables,methodology');
    assert.equal(after.code, 0, after.stdout);
  });
});

test('--render-tables keeps a CRLF README CRLF', async () => {
  const good = (await fixture('README.tables.md')).replace(/\n/g, '\r\n');
  await withDir({ 'README.md': good.replace('36.3M (31.0–37.3M)', '1M (1–2M)') }, async (dir) => {
    const file = path.join(dir, 'README.md');
    const r = await cli(['--render-tables', `ratelimit-cpp=${file}`, '--claims', CLAIMS]);
    assert.equal(r.code, 0, r.stdout);
    const out = await readFile(file, 'utf8');
    assert.equal(out, good);
    assert.doesNotMatch(out, /[^\r]\n/);
  });
});

test('--render-tables refuses a table that cannot be rendered and leaves the file unchanged', async () => {
  const text = `# T\n\n${block('rl.fixture.proposed_table', 'old')}`;
  await withDir({ 'README.md': text }, async (dir) => {
    const file = path.join(dir, 'README.md');
    const r = await cli(['--render-tables', `ratelimit-cpp=${file}`, '--claims', CLAIMS]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /CLAIM_NOT_APPROVED/);
    assert.equal(await readFile(file, 'utf8'), text);
    assert.deepEqual(await tmpFiles(dir), []);
  });
});

test('[concurrency] check mode never writes: mtimes and the directory listing are unchanged after a failing run', async () => {
  const text = (await fixture('README.tables.md')).replace('36.3M (31.0–37.3M)', '36.4M (31.0–37.3M)');
  await withDir({ 'README.md': text }, async (dir) => {
    const file = path.join(dir, 'README.md');
    const before = (await stat(file)).mtimeMs, listing = await readdir(dir);
    const r = await checkReadme(file, 'readme,tables,methodology');
    assert.equal(r.code, 1, r.stdout);
    assert.equal((await stat(file)).mtimeMs, before);
    assert.deepEqual(await readdir(dir), listing);
    assert.equal(await readFile(file, 'utf8'), text);
  });
});

test('a README without a bench-methodology block fails METHODOLOGY_MISSING; a complete block passes', async () => {
  assert.deepEqual(codes(methodology(await fixture('README.basic.md'))), ['METHODOLOGY_MISSING']);
  assert.deepEqual(methodology(await fixture('README.tables.md')), []);
  assert.deepEqual(codes(methodology('<!-- bench-methodology:begin -->\n- Warm-up: x\n')), ['METHODOLOGY_MISSING']);
  const r = await checkReadme(path.join(MD, 'README.basic.md'), 'methodology');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /README\.basic\.md:1 METHODOLOGY_MISSING/);
});

test('a methodology block missing a label (at the start of a line or list item) fails METHODOLOGY_FIELD naming it', async () => {
  const text = await fixture('README.tables.md');
  const noOutliers = methodology(text.replace(/^- \*\*Outliers:\*\*.*\n/m, ''));
  assert.deepEqual(codes(noOutliers), ['METHODOLOGY_FIELD']);
  assert.match(noOutliers[0].message, /"Outliers:"/);
  const inline = methodology(text.replace('- **Timer:**', '- See the Timer: section.'));
  assert.deepEqual(codes(inline), ['METHODOLOGY_FIELD']);
  assert.match(inline[0].message, /"Timer:"/);
  const empty = methodology(text.replace(/(\*\*Noise control:\*\*).*$/m, '$1'));
  assert.deepEqual(codes(empty), ['METHODOLOGY_FIELD']);
  assert.match(empty[0].message, /"Noise control:"/);
});

test('the CRLF fixture yields the same findings and line numbers as its LF twin', async () => {
  const crlf = await fixture('README.crlf.md');
  assert.match(crlf, /\r\n/);
  assert.doesNotMatch(crlf, /[^\r]\n/, 'the fixture is CRLF throughout (.gitattributes keeps it -text)');
  const twin = crlf.replace(/\r\n/g, '\n');
  const all = (t) => [...scan(t).findings, ...tables(t).findings, ...methodology(t)].map((f) => [f.code, f.line])
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  assert.deepEqual(all(crlf), all(twin));
  assert.deepEqual(all(crlf), [['UNTAGGED_NUMBER', 4], ['TABLE_CELL_UNTAGGED', 8], ['TABLE_CELL_UNTAGGED', 8], ['WAIVER_NO_REASON', 10],
    ['METHODOLOGY_FIELD', 12], ['WAIVER_UNTERMINATED', 19], ['UNTAGGED_NUMBER', 20]]);
  assert.deepEqual(scan(crlf).markers.map((m) => [m.text, m.line]), scan(twin).markers.map((m) => [m.text, m.line]));
});

test('--only tables and --only methodology need --readme-file; the default run includes the README checks', async () => {
  for (const only of ['tables', 'methodology']) assert.equal((await cli(['--only', only, '--claims', CLAIMS, '--evidence-root', EVIDENCE])).code, 2, only);
  await withDir({}, async (dir) => {
    const r = await cli(['--root', dir, '--claims', CLAIMS, '--evidence-root', EVIDENCE, '--readme-file', `ratelimit-cpp=${path.join(MD, 'README.basic.md')}`]);
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(r.stdout.trim().split('\n').slice(0, -1).map((l) => / ([A-Z_]+) /.exec(l)[1]), ['METHODOLOGY_MISSING']);
  });
});

test('a 3 MiB README gives INPUT_TOO_LARGE from every markdown check', () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  assert.deepEqual(codes(scan(big).findings), ['INPUT_TOO_LARGE']);
  assert.deepEqual(codes(tables(big).findings), ['INPUT_TOO_LARGE']);
  assert.deepEqual(codes(methodology(big)), ['INPUT_TOO_LARGE']);
});

test('pathological 1 MiB README inputs are scanned in linear time (under 1 second each)', () => {
  for (const shape of ['<!-- ', '| 1 ', '<!-- claim:a -->', '```\n', '|---|\n', '<!-- claims-table:begin id=x -->']) {
    const text = shape.repeat(Math.ceil((1024 * 1024) / shape.length));
    const t0 = performance.now();
    scan(text); tables(text); methodology(text);
    assert.ok(performance.now() - t0 < 1000, `${JSON.stringify(shape)} took ${Math.round(performance.now() - t0)} ms`);
  }
});
