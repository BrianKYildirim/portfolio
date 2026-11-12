// Claim-unit coverage for the untagged-number scan (CLAIM-05, D-05): every unit bench/claims.json uses is either
// scanned, with a fixed list of its usual spellings that must each match as one token, or listed as not a performance unit with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { UNIT_NUMBER, scanHtml, scanJsLines, scanMarkdown } from '../claims-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const CLI = path.join(ROOT, 'tools', 'check-claims.mjs');
const BASIC = path.join(HERE, 'fixtures', 'basic');
const CLAIMS = JSON.parse(await readFile(path.join(ROOT, 'bench', 'claims.json'), 'utf8'));

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const run = (root, extra = []) => cli(['--root', root, '--claims', path.join(BASIC, 'claims.json'), '--evidence-root', path.join(BASIC, 'evidence'), ...extra]);
// A throwaway root holding `files` ({ 'pages/projects.html': '<text>' }); removed after `body` runs.
async function withRoot(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'unit-coverage-'));
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
// Finding lines of CLI stdout (the summary line dropped), parsed into { file, line, code, token }.
function findingsOf(stdout) {
  return stdout.trim().split('\n').slice(0, -1).map((l) => {
    const m = /^\[check-claims\] (.+):(\d+) (\S+) (.*)$/.exec(l);
    assert.ok(m, l);
    return { file: m[1], line: Number(m[2]), code: m[3], token: /^"(.*?)" has a unit/.exec(m[4])?.[1] };
  });
}
const tokens = (s) => [...s.matchAll(UNIT_NUMBER)].map((m) => m[0]);
const tokenOf = (f) => /^"(.*?)" has a unit/.exec(f.message)?.[1];
// The tokens of `It ran <s>, then stopped.` from UNIT_NUMBER, an HTML <p>, a demo JS string and a README line.
function inAllContexts(s) {
  const sentence = `It ran ${s}, then stopped.`;
  return {
    regex: tokens(sentence),
    html: scanHtml(`<p>${sentence}</p>\n`, 'c.html').map(tokenOf),
    js: scanJsLines(`const S = '${sentence}';\n`, 'c.js').map(tokenOf),
    md: scanMarkdown(`${sentence}\n`, 'c.md').findings.map(tokenOf),
  };
}
// Every spelling that is not exactly [s] in some context, so one run lists all misses at once.
function assertOneTokenEverywhere(spellings) {
  const misses = [];
  for (const s of spellings) {
    for (const [where, list] of Object.entries(inAllContexts(s))) {
      if (list.length !== 1 || list[0] !== s) misses.push(`${s} (${where}): ${JSON.stringify(list)}`);
    }
  }
  assert.deepEqual(misses, [], `${misses.length} miss(es):\n${misses.join('\n')}`);
}

// The usual spellings of each scanned claim unit; each must be one whole token in every context.
const VARIANTS = Object.freeze({
  ns: ['40 ns', '40ns', '40-ns', '40 nsec', '40 nsecs', '40 nanosec', '40 nanoseconds', '1 nanosecond'],
  µs: ['100 µs', '100 μs', '100 us', '100 usec', '100 µsec', '100 μsec', '100 microsec', '100 microseconds', '1 microsecond'],
  ms: ['3 ms', '3ms', '3 msec', '3 msecs', '3 millisec', '3 milliseconds', '1 millisecond'],
  s: ['5 s', '5 sec', '5 secs', '1 second', '5 seconds'],
  'ops/s': ['75.7M ops/s', '75.7M op/s', '75.7M ops/sec', '75.7M op/sec', '75.7M ops/second', '1 operation/s', '75.7M operations/sec',
    '75.7M ops per second', '1 op per second', '75.7M operations per second', '75.7 million operations per second', '75.7M ops per sec',
    '75.7M ops a second', '75.7M/s', '75.7M/sec', '75.7M per second', '75.7M per sec', '2 Mops/s'],
  'cmd/s': ['12,403 cmd/s', '12,403 cmds/s', '12,403 cmd/sec', '12,403 cmds/sec', '4 command/s', '12,403 commands/s', '12,403 commands/sec',
    '12,403 commands per second', '1 command per second', '12,403 commands a second', '12,403 commands per sec', '1 request/s', '100+ req/s',
    '100+ reqs/s', '1,200 requests/sec', '1 query/sec', '6 queries/s', '1 call/s', '4 calls/s', '4 calls per second'],
  ratio: ['3.5×', '3.5x', '3.5 ×', '2–3×', '375 times faster', '9 times slower', '3 times better', '375-fold faster', '375 fold faster', '375-fold'],
  '%': ['95%', '14.12 %', '95 percent', '95 per cent'],
  MiB: ['101 MiB', '101MiB', '1.5 GiB', '101 MB', '1.5 GB'],
  KiB: ['9.1 KiB', '64 KiB', '64 KB'],
  bytes: ['28 bytes', '1 byte', '28-byte'],
  tests: ['54 tests', '1 test'],
});
// How each scanned unit is written in a display string (the claims file names the ratio unit "ratio").
const SPELLING = Object.freeze({ ratio: '×' });
const spelling = (unit) => SPELLING[unit] ?? unit;

// Claim units that are not performance units, each with the reason the scan leaves it alone.
const NOT_SCANNED = Object.freeze({
  fraction: 'A bare proportion such as 0.16 carries no unit word and appears only in tagged leaves and markers.',
  'ticks/ns': 'A hardware clock rate, a design fact; its README marker binds the bare number 2.995 that its display lists, and the rate rule deliberately has no sub-millisecond denominator so that binding holds.',
  shards: 'A count or configuration value, a D-05 non-claim category, not a performance unit.',
  workers: 'A count or configuration value, a D-05 non-claim category, not a performance unit.',
  connections: 'A count or configuration value, a D-05 non-claim category, not a performance unit.',
  events: 'A count or configuration value, a D-05 non-claim category, not a performance unit.',
  characters: 'A count or configuration value, a D-05 non-claim category, not a performance unit.',
  'exception names': 'A count or configuration value, a D-05 non-claim category, not a performance unit.',
  port: 'A count or configuration value, a D-05 non-claim category, not a performance unit.',
  'load average': 'A dimensionless score or level, a design fact.',
  'blur score': 'A dimensionless score or level, a design fact.',
  'gray level': 'A dimensionless score or level, a design fact.',
  px: 'An image dimension; px and MP are not units here (RESEARCH Open Question 3).',
  pixels: 'An image dimension; px and MP are not units here (RESEARCH Open Question 3).',
});

// ---------- Claim units ----------
test('every unit in bench/claims.json is classified', () => {
  const units = [...new Set(CLAIMS.claims.map((c) => c.unit))].sort();
  assert.ok(units.length > 0);
  for (const unit of units) {
    const homes = [Object.hasOwn(VARIANTS, unit), Object.hasOwn(NOT_SCANNED, unit)].filter(Boolean).length;
    assert.equal(homes, 1, `claim unit "${unit}" must be in exactly one of VARIANTS or NOT_SCANNED`);
  }
  for (const [unit, reason] of Object.entries(NOT_SCANNED)) assert.ok(typeof reason === 'string' && reason.trim().length > 0, unit);
});

test('each spelling of a scanned claim unit is one whole token in UNIT_NUMBER, scanHtml, scanJsLines and scanMarkdown', () => {
  assertOneTokenEverywhere(Object.values(VARIANTS).flat());
});

test("each scanned unit's list holds the claim's own spelling", () => {
  for (const [unit, list] of Object.entries(VARIANTS)) {
    assert.ok(list.some((s) => /^\d/.test(s) && s.endsWith(spelling(unit))), `${unit}: no variant ends with "${spelling(unit)}"`);
  }
});

test('every number-first display of a claim with a scanned unit yields one token', () => {
  let checked = 0;
  for (const claim of CLAIMS.claims) {
    if (!Object.hasOwn(VARIANTS, claim.unit)) continue;
    for (const value of claim.display?.value ?? []) {
      if (typeof value !== 'string' || !/^[~≈≥≤]?\s?[+−-]?\s?\d/.test(value) || !value.includes(spelling(claim.unit))) continue;
      assert.equal(tokens(value).length, 1, `${claim.id}: "${value}" gives ${JSON.stringify(tokens(value))}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'no display checked');
});

// ---------- Units no claim uses (owner decision 2026-11-08) ----------
test('units no claim uses are one whole token in UNIT_NUMBER, scanHtml, scanJsLines and scanMarkdown', () => {
  assertOneTokenEverywhere(['64 kB', '1 TB', '2 TiB', '10 Gbps', '100 Mbps', '56 kbps', '1,200 images/sec', '900 images per second',
    '1 image/s', '10 ops/ms', '5 req/min', '5 requests per minute', '20 requests/min', '3 requests/hour', '1,000 RPS', '500 QPS',
    '200 TPS', '5,000 IOPS', '30 fps', '12,000 requests per sec', '10,000 reads per second', '500 writes per second', '3 reads/s',
    '2 writes/sec', '40 decisions/s', '3 tokens/s', '60 frames per second', '10 Gb/s', '1,000 rows/sec', '5 files per minute',
    '100 events/h']);
});

// ---------- Edges ----------
test('WR-01: a unit before / falls back to the bare unit; only / plus a 4-digit year stays unmatched', () => {
  for (const [s, expected] of [['5 ms/transaction', ['5 ms']], ['5 ms/invocation', ['5 ms/invocation']], ['3 ms/2 ops', ['3 ms']],
    ['40 ns/', ['40 ns']], ['10 ns/allocation12', ['10 ns']], ['5 ms/26', ['5 ms']], ['10 s/20261', ['10 s']], ['10 s/2026', []],
    ['2x/3x', ['2x', '3x']], ['500 MB/s', ['500 MB/s']], ['10 ns/op', ['10 ns/op']]]) {
    assert.deepEqual(tokens(`It took ${s} then`), expected, s);
  }
});

test('non-units give no token', () => {
  for (const s of ['10 users', '8 threads', '128 shards', 'over 30+ images', '24/7 support', '1/2 cup', 'the 2 and/or 3 options', 'TCP/IP 4',
    'in 2026/27', 'pages 3/4', '0.114 B', '2.995 ticks/ns']) {
    for (const [where, list] of Object.entries(inAllContexts(s))) assert.deepEqual(list, [], `${s} (${where})`);
  }
});

test('a README marker binds the number its claim displays; a reasoned waiver exempts a reads-per-second rate', () => {
  for (const [line, id, text] of [['<!-- claim:t --> 2.995 ticks/ns\n', 't', '2.995'], ['<!-- claim:z --> 3 ms/2 ops\n', 'z', '3 ms']]) {
    const r = scanMarkdown(line, 'a.md');
    assert.deepEqual(r.markers.map((m) => [m.id, m.text]), [[id, text]], line);
    assert.deepEqual(r.findings.filter((f) => f.code === 'UNTAGGED_NUMBER'), [], line);
  }
  assert.deepEqual(scanMarkdown('<!-- claim-waiver: inspector read rate, a workload parameter --> 10,000 reads per second\n', 'w.md').findings, []);
});

test('a 1 MiB pathological input of each new shape scans in linear time (under 1 second per scanner)', () => {
  const MiB = 1024 * 1024;
  for (const unit of ['1 abcdefghijklmnopqrstuvwxyz ', '1 abcdefghij per ', '1 ms/', '1 ms/1', '1 s/2026 ', '1-fold ', '1 per ', '1/']) {
    const input = unit.repeat(Math.floor(MiB / unit.length));
    for (const [name, scan] of [['html', scanHtml], ['js', scanJsLines], ['md', scanMarkdown]]) {
      const t0 = performance.now();
      scan(input, `slow.${name}`);
      const ms = performance.now() - t0;
      assert.ok(ms < 1000, `${JSON.stringify(unit)} ${name}: ${ms.toFixed(0)} ms`);
    }
  }
});

// ---------- Tracer (CLI) ----------
test('75.7M op/s on a page fails UNTAGGED_NUMBER through the CLI', async () => {
  const text = [
    '<article class="projects-page-card" data-category="systems" data-project="rate-limiter">',
    '<div class="project-meta">',
    '<span class="project-stat">75.7M op/s</span>',
    '</div>',
    '</article>',
    '',
  ].join('\n');
  const files = { 'pages/projects.html': text };
  await withRoot(files, async (dir) => {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] pages\/projects\.html:3 UNTAGGED_NUMBER "75\.7M op\/s"/m);
    assert.deepEqual(findingsOf(r.stdout).map((f) => [f.line, f.code, f.token]), [[3, 'UNTAGGED_NUMBER', '75.7M op/s']]);
    await assertUntouched(dir, files);
  });
});

// ---------- Entities, invisible characters and uppercase X (02-21, CLAIM-05) ----------
// Invisible characters are built from char codes, never typed raw, so this file holds none.
const ch = (code) => String.fromCharCode(code);
// Greek mu (U+03BC) is written as the micro sign (U+00B5), as in VARIANTS: HTML text, demo JS and READMEs keep the
// decoded &mu; while the attribute path folds it.
const asMicro = (t) => (typeof t === 'string' ? t.replace(/μ/g, 'µ') : t);
// Printable form of a spelling for a failure message (every non-ASCII character as \uXXXX).
const shown = (s) => String(s).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
// The findings of `It ran <s>, then stopped.` in HTML text, an HTML alt attribute, a demo JS string and a README line.
function markupFindings(s) {
  const sentence = `It ran ${s}, then stopped.`;
  return {
    html: scanHtml(`<p>${sentence}</p>\n`, 'c.html'),
    attr: scanHtml(`<img src="x.png" alt="${sentence}">\n`, 'c.html'),
    js: scanJsLines(`const S = '${sentence}';\n`, 'c.js'),
    md: scanMarkdown(`${sentence}\n`, 'c.md').findings,
  };
}
// The token list of each markup context (keys html, attr, js, md).
function inMarkupContexts(s) {
  return Object.fromEntries(Object.entries(markupFindings(s)).map(([where, list]) => [where, list.map((f) => asMicro(tokenOf(f)))]));
}
// Every [written, expected] pair whose list is not exactly [expected] in some markup context, all listed at once.
function assertOneTokenInMarkup(pairs) {
  const misses = [];
  for (const [s, expected] of pairs) {
    for (const [where, list] of Object.entries(inMarkupContexts(s))) {
      if (list.length !== 1 || list[0] !== expected) misses.push(`${shown(s)} (${where}): ${shown(JSON.stringify(list))}, expected ${shown(expected)}`);
    }
  }
  assert.deepEqual(misses, [], `${misses.length} miss(es):\n${misses.join('\n')}`);
}

test('entity-written and invisible-character spellings of claimed units are one token in HTML text, an HTML attribute, demo JS and a README', () => {
  const pairs = [['1.7 &mu;s', '1.7 µs'], ['1.7&nbsp;&mu;s', '1.7 µs']];
  for (const e of ['ensp', 'emsp', 'hairsp', 'numsp', 'puncsp', 'MediumSpace', 'ThinSpace', 'NonBreakingSpace']) pairs.push([`75.7M&${e};ops/s`, '75.7M ops/s']);
  pairs.push(['75.7M ops&sol;s', '75.7M ops/s'], ['3&#8203;ms', '3ms'], ['3&shy;ms', '3ms'], ['3&NoBreak;ms', '3ms'], ['3&ZeroWidthSpace;ms', '3ms'],
    ['3 &ZeroWidthSpace; ms', '3 ms'], ['95&percnt;', '95%'], ['1&period;7 ms', '1.7 ms'], ['12&comma;403 cmd/s', '12,403 cmd/s']);
  for (const code of [0x200b, 0xad, 0x200c, 0x200d, 0x2060, 0xfeff]) pairs.push([`3${ch(code)}ms`, '3ms']);
  pairs.push([`75.7M${ch(0x200b)}ops/s`, '75.7Mops/s']);
  assertOneTokenInMarkup(pairs);
});

test('uppercase X is a multiplier wherever lowercase x is', () => {
  assertOneTokenEverywhere(['3.5X', '10X', '2–3X']);
  assertOneTokenInMarkup([['3.5X', '3.5X'], ['3.5X faster', '3.5X'], ['10X', '10X'], ['10X faster', '10X'], ['2–3X', '2–3X']]);
  const misses = [];
  for (const [s, expected] of [['3.5X faster', ['3.5X']], ['10X faster', ['10X']], ['1920 X 1080', []], ['0XFF', []], ['3 Xbox', []],
    ['Xeon 3', []], ['4X4', []], ['0X${h}', []]]) {
    for (const [where, list] of Object.entries(inAllContexts(s))) {
      if (JSON.stringify(list) !== JSON.stringify(expected)) misses.push(`${s} (${where}): ${JSON.stringify(list)}, expected ${JSON.stringify(expected)}`);
    }
  }
  assert.deepEqual(misses, [], `${misses.length} miss(es):\n${misses.join('\n')}`);
});

test('1.7 &mu;s and 3.5X faster on a page fail UNTAGGED_NUMBER through the CLI', async () => {
  const text = [
    '<article class="projects-page-card" data-category="systems" data-project="rate-limiter">',
    '<div class="project-meta">',
    '<span class="project-stat">1.7 &mu;s</span>',
    '<span class="project-stat">3.5X faster</span>',
    '</div>',
    '</article>',
    '',
  ].join('\n');
  const files = { 'pages/projects.html': text };
  await withRoot(files, async (dir) => {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(findingsOf(r.stdout).map((f) => [f.line, f.code, asMicro(f.token)]),
      [[3, 'UNTAGGED_NUMBER', '1.7 µs'], [4, 'UNTAGGED_NUMBER', '3.5X']]);
    await assertUntouched(dir, files);
  });
});

// ---------- Residue after decoding fails closed (02-21, CLAIM-05) ----------
// Every markup context whose findings, as [code, token or message], differ from `expected`, all listed at once.
function assertMarkupFindings(cases) {
  const misses = [];
  for (const [s, check] of cases) {
    for (const [where, list] of Object.entries(markupFindings(s))) {
      const why = check(list);
      if (why) misses.push(`${shown(s)} (${where}): ${why}: ${shown(JSON.stringify(list.map((f) => [f.code, f.message])))}`);
    }
  }
  assert.deepEqual(misses, [], `${misses.length} miss(es):\n${misses.join('\n')}`);
}
const exactlyOne = (code, quoted) => (list) => {
  if (list.length !== 1) return `expected exactly one finding, got ${list.length}`;
  if (list[0].code !== code) return `expected ${code}`;
  return list[0].message.includes(quoted) ? '' : `message does not name ${quoted}`;
};

test('an undecoded entity or an invisible format character directly after a number is reported in every markup context', () => {
  assertMarkupFindings([
    ['75.7M&VeryThinSpace;ops/s', exactlyOne('UNKNOWN_ENTITY', '"&VeryThinSpace;"')],
    ['1.7&Mu;s', exactlyOne('UNKNOWN_ENTITY', '"&Mu;"')],
    ['3&lrm;ms', exactlyOne('UNKNOWN_ENTITY', '"&lrm;"')],
    [`3${ch(0x2062)}ms`, exactlyOne('FORMAT_CHARACTER', 'U+2062')],
    [`3${ch(0x200e)}ms`, exactlyOne('FORMAT_CHARACTER', 'U+200E')],
    [`3 ${ch(0x202e)}sm`, exactlyOne('FORMAT_CHARACTER', 'U+202E')],
  ]);
});

test('text that cannot hide a figure gives no residue finding', () => {
  const none = (list) => (list.length ? `expected no finding, got ${list.length}` : '');
  assertMarkupFindings(['&copy; 2026 Brian', 'Python 3.11 &middot; FastAPI', 'step 1 &rarr; 2', 'R&amp;D 3', 'v2.0 &hellip;', '30&deg;',
    '3 &foo bar', 'a=1&b=2;', 'H2&foo;'].map((s) => [s, none]));
});

test('an unknown entity before a number hides nothing: only the figure after it is reported', () => {
  const only = (token) => (list) => (JSON.stringify(list.map((f) => [f.code, tokenOf(f)])) === JSON.stringify([['UNTAGGED_NUMBER', token]])
    ? '' : `expected only UNTAGGED_NUMBER ${token}`);
  assertMarkupFindings([['&sim;3 ms', only('3 ms')], ['5 &plusmn; 2 ms', only('2 ms')]]);
});

test('a 1 MiB input of each entity, invisible-character and uppercase-X shape scans in linear time (under 1 second per scanner)', () => {
  const MiB = 1024 * 1024;
  for (const unit of ['1 &abcdefghijklmnopqrstuvwxyzabcdef;', '&abcdefghijklmnopqrstuvwxyzabcdefg;', '1 &abcdefghijklmnopqrstuvwxyzabcdef ',
    `1${ch(0x2062)}abcdefghijklmnopqrstuvwxyz `, '&ZeroWidthSpace;', '1.5X ']) {
    const input = unit.repeat(Math.floor(MiB / unit.length));
    for (const [name, scan] of [['html', scanHtml], ['js', scanJsLines], ['md', scanMarkdown]]) {
      const t0 = performance.now();
      scan(input, `slow.${name}`);
      const ms = performance.now() - t0;
      assert.ok(ms < 1000, `${shown(JSON.stringify(unit))} ${name}: ${ms.toFixed(0)} ms`);
    }
  }
});
