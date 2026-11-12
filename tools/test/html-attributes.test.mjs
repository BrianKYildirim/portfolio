// WR-03 regression guard: text a visitor sees or hears in an attribute (alt, title, aria-label, aria-description,
// placeholder, description meta) is scanned like visible text (CLAIM-05, D-05).
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

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const run = (root, extra = []) => cli(['--root', root, '--claims', path.join(BASIC, 'claims.json'), '--evidence-root', path.join(BASIC, 'evidence'), ...extra]);
// A throwaway root holding `files` ({ 'pages/projects.html': '<text>' }); removed after `body` runs.
async function withRoot(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'html-attributes-'));
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

// ---------- Tracer (CLI) ----------
test('a figure in an alt attribute fails UNTAGGED_NUMBER through the CLI', async () => {
  const page = [
    '<section class="projects-page">',
    '  <article class="projects-page-card" data-category="systems" data-project="rate-limiter">',
    '    <div class="project-media">',
    '      <img class="projects-page-image" src="static/ratelimit.jpg" alt="75.7M ops/s throughput">',
    '    </div>',
    '    <div class="projects-page-info">',
    '      <h2><button type="button" class="project-open">Rate Limiter Library</button></h2>',
    '    </div>',
    '  </article>',
    '</section>',
    '',
  ].join('\n');
  const files = { 'pages/projects.html': page };
  await withRoot(files, async (dir) => {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(findingsOf(r.stdout).map((f) => [f.file, f.line, f.code, f.token]),
      [['pages/projects.html', 4, 'UNTAGGED_NUMBER', '75.7M ops/s']], r.stdout);
    assert.match(r.stdout, /pages\/projects\.html:4 UNTAGGED_NUMBER "75\.7M ops\/s" .*\(in its alt attribute\)\n/);
    await assertUntouched(dir, files);
  });
});

// scanHtml findings as [line, code, token] (UNTAGGED_NUMBER) or [line, code] (every other code).
const MiB = 1024 * 1024;
const rows = (html) => lib.scanHtml(html, 'a.html').map((f) => (f.code === 'UNTAGGED_NUMBER'
  ? [f.line, f.code, /^"(.*?)" has a unit/.exec(f.message)[1]] : [f.line, f.code]));
const U = 'UNTAGGED_NUMBER';

// ---------- Attributes ----------
test('alt, title, aria-label, aria-description, placeholder and description or og meta content are scanned', () => {
  assert.deepEqual(rows('<button title="40 ns per check">Go</button>'), [[1, U, '40 ns']]);
  assert.deepEqual(rows('<span aria-label="12,000 commands per second">x</span>'), [[1, U, '12,000 commands per second']]);
  assert.deepEqual(rows('<div aria-description="about 2 µs">x</div>'), [[1, U, '2 µs']]);
  assert.deepEqual(rows('<input placeholder="e.g. 500 ms">'), [[1, U, '500 ms']]);
  assert.deepEqual(rows('<meta name="description" content="Rate limiter at 75.7M op/s">'), [[1, U, '75.7M op/s']]);
  assert.deepEqual(rows('<meta property="og:description" content="3 ms p50">'), [[1, U, '3 ms']]);
  assert.deepEqual(rows('<meta name="twitter:title" content="Up to 4 µs">'), [[1, U, '4 µs']]);
  assert.deepEqual(rows('<IMG ALT="9 ms">'), [[1, U, '9 ms']], 'attribute and tag names are case-insensitive');
  assert.match(lib.scanHtml('<img alt="5 ms">', 'a.html')[0].message, /\(in its alt attribute\)$/);
  assert.match(lib.scanHtml('<span ARIA-LABEL="5 ms">x</span>', 'a.html')[0].message, /\(in its aria-label attribute\)$/);
});

// ---------- Not scanned ----------
test('http-equiv and viewport meta content, data-placeholder and other data-* attributes are not scanned', () => {
  assert.deepEqual(rows('<meta http-equiv="refresh" content="5 s">'), []);
  assert.deepEqual(rows('<meta name="viewport" content="width=device-width, initial-scale=1">'), []);
  assert.deepEqual(rows('<p data-placeholder="about 30 ms">x</p>'), []);
  assert.deepEqual(rows('<span data-note="5 ms">x</span>'), []);
  assert.deepEqual(rows('<div content="5 ms">x</div>'), [], 'content counts only on a description meta');
  assert.deepEqual(rows('<span data-note="a title=5ms">x</span>'), [], 'a name inside another value is not an attribute');
  assert.deepEqual(rows(`<img data-x=' alt="' title="5 ms">`), [[1, U, '5 ms']], 'a quote inside another value hides nothing');
});

// ---------- Waivers ----------
test('a reasoned waiver exempts the attributes of its own void or leaf element; a placeholder reason still fails', async () => {
  assert.deepEqual(rows('<img alt="25–300 ns" data-claim-waiver="historical anecdote, not a measurement">'), []);
  assert.deepEqual(rows('<img alt="5 ms" data-claim-waiver="TBD">'), [[1, 'WAIVER_NO_REASON']]);
  assert.deepEqual(rows('<span data-claim-waiver="design fact" title="9 ms">x</span>'), []);
  const text = await readFile(path.join(HERE, 'fixtures', 'html', 'waivers.html'), 'utf8');
  const line = text.split('\n').findIndex((l) => l.includes('Not a leaf')) + 1;
  assert.deepEqual(rows(text).filter((r) => r[0] === line).sort(), [[line, 'LEAF_NOT_LEAF'], [line, U, '11 ms']]);
});

// ---------- Lines and decoding ----------
test('a finding carries its attribute line; entities are decoded; unquoted values count; data-claim leaves are skipped', () => {
  assert.deepEqual(rows('<img src="a.png"\n  alt="5 ms">'), [[2, U, '5 ms']]);
  assert.deepEqual(rows('<img alt="5&nbsp;ms">'), [[1, U, '5 ms']]);
  assert.deepEqual(rows('<img alt="&#53; ms">'), [[1, U, '5 ms']], 'a numeric entity is a digit');
  assert.deepEqual(rows('<img alt=5ms>'), [[1, U, '5ms']]);
  assert.deepEqual(rows('<span data-claim="rl.x" title="7 ms">7 ms</span>').filter((r) => r[1] === U), []);
});

// ---------- Linear time ----------
// The last input makes every tag a finding (65,536 of them), so the per-finding cost is pinned too.
test('1 MiB of attribute-heavy or unterminated input scans in under 1 second', () => {
  for (const unit of ['<img alt="1 ms ', "<p title='", ' alt=" title="', '<img alt="x">', '<meta name="description" content="x">', '<img alt="5 ms">']) {
    const input = unit.repeat(Math.ceil(MiB / unit.length)), t0 = performance.now();
    lib.scanHtml(input, 'slow.html');
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${unit}: ${ms.toFixed(0)} ms`);
  }
});
