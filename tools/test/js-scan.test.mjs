// WR-02 regression guard for the demo-JS scan (CLAIM-05, D-05): comments are found outside strings, template
// literals and regex literals, and a waiver counts only as a real trailing // comment.
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
const MiB = 1024 * 1024;
// Line terminators are built from char codes: typed raw, U+2028 and U+2029 end a regex or string literal.
const CR = String.fromCharCode(13), LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const run = (root, extra = []) => cli(['--root', root, '--claims', path.join(BASIC, 'claims.json'), '--evidence-root', path.join(BASIC, 'evidence'), ...extra]);
// A throwaway root holding `files` ({ 'scripts/demos/demo.js': '<text>' }); removed after `body` runs.
async function withRoot(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'js-scan-'));
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
const tokenOf = (f) => /^"(.*?)" has a unit/.exec(f.message)?.[1];
// [line, token] for UNTAGGED_NUMBER findings; [line, code, token] for every finding (token absent for a waiver).
const untagged = (text) => lib.scanJsLines(text, 'demo.js').map((f) => [f.line, tokenOf(f)]);
const scan = (text) => lib.scanJsLines(text, 'demo.js').map((f) => (f.code === 'UNTAGGED_NUMBER' ? [f.line, f.code, tokenOf(f)] : [f.line, f.code]));
// The two reproductions from REVIEW WR-02: a waiver inside a string, and a '//' inside a string.
const REPRO = "const a = '5 ms // claim-waiver: x', b = '9 ms';\nconst s = 'see // notes'; const t = '7 ms';\n";

// ---------- Tracer (CLI) ----------
test('a waiver or // inside a string no longer hides a figure through the CLI', async () => {
  const files = { 'scripts/demos/demo.js': REPRO };
  await withRoot(files, async (dir) => {
    const r = await run(dir, ['--only', 'js']);
    assert.equal(r.code, 1, r.stdout);
    const f = findingsOf(r.stdout);
    assert.deepEqual([...new Set(f.map((x) => x.code))], ['UNTAGGED_NUMBER'], r.stdout);
    assert.deepEqual(f.map((x) => x.token), ['5 ms', '9 ms', '7 ms']);
    assert.deepEqual(f.map((x) => x.line), [1, 1, 2]);
    await assertUntouched(dir, files);
  });
});

test('scanJsLines reports figures after a // inside a string and ignores a waiver written inside a string', () => {
  assert.deepEqual(untagged(REPRO), [[1, '5 ms'], [1, '9 ms'], [2, '7 ms']]);
});

// ---------- Line ends ----------
test('a lone CR, U+2028, U+2029 and CRLF each end a line, so a waiver does not reach the next line', () => {
  for (const eol of [CR, LS, PS, `${CR}\n`]) {
    const text = `const a = '1 s'; // claim-waiver: fine${eol}const b = '5 ms';${eol}`;
    assert.deepEqual(scan(text), [[2, 'UNTAGGED_NUMBER', '5 ms']], JSON.stringify(eol));
  }
});

// ---------- Waiver forms ----------
test('a // claim-waiver-begin comment is not a waiver, so its line is scanned', () => {
  assert.deepEqual(scan("const c = '7 ms'; // claim-waiver-begin: x"), [[1, 'UNTAGGED_NUMBER', '7 ms']]);
});

test('a bare // claim-waiver with no colon or reason is WAIVER_NO_REASON', () => {
  assert.deepEqual(scan("const q = '2 ms'; // claim-waiver"), [[1, 'WAIVER_NO_REASON']]);
});

test('an HTML comment inside a template literal is markup, not a waiver', () => {
  const text = 'const t = `\n<p>last 10 s</p><!-- // claim-waiver: window -->\n`;\n';
  assert.deepEqual(scan(text), [[2, 'UNTAGGED_NUMBER', '10 s']]);
});

// ---------- Strings, templates and regex ----------
test('a quote inside a regex literal does not start a string', () => {
  assert.deepEqual(scan("const re = /'/g; const t = '5 ms'; // claim-waiver: reason"), []);
  assert.deepEqual(scan('const re = /"/; const u = \'a // b\'; const v = \'6 ms\';'), [[1, 'UNTAGGED_NUMBER', '6 ms']]);
});

test('nested ${} expressions and object braces inside a template resume the template at the right brace', () => {
  assert.deepEqual(scan('const h = `${n.map((x) => `<b>${x}</b> // not a comment`).join(\'\')} 7 ms`;'), [[1, 'UNTAGGED_NUMBER', '7 ms']]);
  assert.deepEqual(scan('const h = `${ {a: 1}.a } 5 ms`; // claim-waiver: reason\nconst k = \'6 ms\';'), [[2, 'UNTAGGED_NUMBER', '6 ms']]);
});

test('a / after a name or a number is division, so the comment after it still counts', () => {
  assert.deepEqual(scan("const r = a / b; const t = '8 ms'; // claim-waiver: reason\nx = 10 / 2; // 9 ms in a comment"), []);
});

test('a multi-line block comment is not scanned; the code after it is', () => {
  assert.deepEqual(scan("/* 4 ms\n 5 ms */ const z = '6 ms';"), [[2, 'UNTAGGED_NUMBER', '6 ms']]);
});

test('an unterminated string or regex never turns later text into a comment', () => {
  assert.deepEqual(scan("const u = 'abc // x 5 ms\nconst w = '3 ms'; // claim-waiver: reason"), [[1, 'UNTAGGED_NUMBER', '5 ms']]);
  assert.deepEqual(scan('x = (/[abc // 4 ms'), [[1, 'UNTAGGED_NUMBER', '4 ms']]);
});

// ---------- Linear time ----------
test('a 1 MiB pathological input of each tokenizer form scans in linear time (under 1 second)', () => {
  for (const unit of ["'", '"', '`', '`${', '${`', '/*', '(/[', '(/', '/', '\\', '{', '}', '`${{']) {
    const input = unit.repeat(Math.floor(MiB / unit.length));
    const t0 = performance.now();
    lib.scanJsLines(input, 'slow.js');
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${JSON.stringify(unit)}: ${ms.toFixed(0)} ms`);
  }
});

// ---------- Desync confined to its line (02-22, CR-02) ----------
// The verifier's reproduction: a regex after ')' that holds '/*'. Read as division, its '/*' opened a comment with
// no end, which hid every later line of the module while the gate printed ok.
const DESYNC = "if (m) /a\\/*b/.test(s);\nconst A = '5 ms';\nconst B = '6 ms';\n";
// Runs each unit repeated to 1 MiB through scanJsLines and asserts each finishes in under 1 second.
function assertLinear(units) {
  for (const unit of units) {
    const input = unit.repeat(Math.floor(MiB / unit.length));
    const t0 = performance.now();
    lib.scanJsLines(input, 'slow.js');
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${JSON.stringify(unit)}: ${ms.toFixed(0)} ms`);
  }
}

test('a misread regex holding /* no longer hides the rest of a demo module through the CLI', async () => {
  const files = { 'scripts/demos/demo.js': DESYNC };
  await withRoot(files, async (dir) => {
    const r = await run(dir, ['--only', 'js']);
    assert.equal(r.code, 1, r.stdout);
    const f = findingsOf(r.stdout);
    assert.deepEqual([...new Set(f.map((x) => x.code))], ['UNTAGGED_NUMBER'], r.stdout);
    assert.deepEqual(f.map((x) => x.token), ['5 ms', '6 ms']);
    assert.deepEqual(f.map((x) => x.line), [2, 3]);
    await assertUntouched(dir, files);
  });
});

test('a /* with no */ after it is read as code, and a backslash-newline continues a string', () => {
  // A backslash-newline continues the string (valid JS), so the '/*' on the next line is still inside it.
  assert.deepEqual(scan('const p = "a \\\nb /* c";\nconst A = \'5 ms\';\nconst B = \'6 ms\';\n'),
    [[3, 'UNTAGGED_NUMBER', '5 ms'], [4, 'UNTAGGED_NUMBER', '6 ms']]);
  assert.deepEqual(scan(DESYNC), [[2, 'UNTAGGED_NUMBER', '5 ms'], [3, 'UNTAGGED_NUMBER', '6 ms']]);
  // A genuinely unclosed comment is a syntax error, so its text is scanned (fail closed).
  assert.deepEqual(scan("const a = 1; /* note 5 ms\nconst b = '6 ms';"),
    [[1, 'UNTAGGED_NUMBER', '5 ms'], [2, 'UNTAGGED_NUMBER', '6 ms']]);
});

test('an opener with no */ anywhere scans in linear time (under 1 second)', () => {
  assertLinear(['/* ', '/*x']);
});

test('a / after the ) that closes an if, while or for condition starts a regex', () => {
  assert.deepEqual(scan("if (a) /'/.test(s); const q = 'see // 5 ms';"), [[1, 'UNTAGGED_NUMBER', '5 ms']]);
  assert.deepEqual(scan("while (x) /'/.test(s) && f('a // 5 ms');"), [[1, 'UNTAGGED_NUMBER', '5 ms']]);
  assert.deepEqual(scan("for (const k of ks) /'/.test(k) && f('a // 5 ms');"), [[1, 'UNTAGGED_NUMBER', '5 ms']]);
});

test('a / after any other ) is division', () => {
  assert.deepEqual(scan("if (a) b = c / d; const q = 'see // 5 ms';"), [[1, 'UNTAGGED_NUMBER', '5 ms']]);
  assert.deepEqual(scan("const r = (a + b) / 2; const t = '5 ms'; // claim-waiver: reason"), []);
});

test('a postfix ++ or -- ends an operand, so the / after it is division; prefix forms keep their reading', () => {
  assert.deepEqual(scan("n = i++ / 2; label = 'a/b // 5 ms';"), [[1, 'UNTAGGED_NUMBER', '5 ms']]);
  assert.deepEqual(scan("n = arr[0]-- / 2; z = 'q // 6 ms';"), [[1, 'UNTAGGED_NUMBER', '6 ms']]);
  assert.deepEqual(scan("x = --i / 2; y = 'p // 5 ms';"), [[1, 'UNTAGGED_NUMBER', '5 ms']]);
  assert.deepEqual(scan('return ++x / 2; // 9 ms'), []);
});

test('the condition and postfix rules scan in linear time (under 1 second)', () => {
  assertLinear(['++', 'i++ /', '(', 'if(', ') /*']);
});
