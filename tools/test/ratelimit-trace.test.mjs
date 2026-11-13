// Tests of the parity trace exporter and strict runner (tools/ratelimit-trace.mjs, D-16): byte-identical exports,
// the canonical round trip, line-numbered rejection of every non-canonical form, runner outcomes against direct
// Limiter calls on the real module, and the CLI's output and exit codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLimiterModule, Limiter } from '../../scripts/demos/ratelimit-wasm.js';
import {
  PRESETS, recordingLimiter, exportPreset, toJsonl, parseTrace, runTrace, formatAllow, formatInspect,
} from '../ratelimit-trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'ratelimit-trace.mjs');
const NEW = '{"op":"new","shards":0,"hint":0}\n';
const ALLOW = '{"op":"allow","key":"757365723a31","cap":10,"rate":5,"t":0}\n';
const INSPECT = '{"op":"inspect","key":"757365723a31","cap":10,"rate":5,"t":250000000}\n';

const module = await loadLimiterModule();

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

const allowOps = (text) => parseTrace(text).ops.filter((o) => o.op === 'allow');

test('exportPreset writes byte-identical canonical JSONL on every run', () => {
  const a = exportPreset('r1', module), b = exportPreset('r1', module);
  assert.equal(a, b);
  assert.ok(a.startsWith(NEW));
  assert.ok(a.endsWith('\n') && !a.includes('\r') && !a.includes('\n\n'));
  assert.ok(a.split('\n').length > 100);
  assert.match(a, /\{"op":"allow","key":"757365723a31","cap":10,"rate":5,"t":\d+\}\n/);
  assert.match(a, /\{"op":"inspect","key":"676c6f62616c","cap":10,"rate":5,"t":250000000\}\n/);
});

test('every exported line parses and re-serializes to itself', () => {
  assert.deepEqual(Object.keys(PRESETS), ['r1', 'r2', 'r3', 'r4']);
  assert.ok(Object.isFrozen(PRESETS) && Object.isFrozen(PRESETS.r4.events) && Object.isFrozen(PRESETS.r4.config.clients));
  for (const name of Object.keys(PRESETS)) {
    const text = exportPreset(name, module), parsed = parseTrace(text);
    assert.equal(toJsonl(parsed.ops, parsed), text, name);
    assert.ok(parsed.ops.some((o) => o.op === 'allow') && parsed.ops.some((o) => o.op === 'inspect'), name);
  }
});

test('parseTrace rejects every non-canonical form with its line number', () => {
  const cases = [
    ['leading zero', NEW + ALLOW.replace('"cap":10', '"cap":05'), 2],
    ['uppercase hex', NEW + ALLOW.replace('3a31', '3A31'), 2],
    ['odd-length hex', NEW + INSPECT.replace('3a31', '3a3'), 2],
    ['2^64', NEW + ALLOW + ALLOW.replace('"t":0', '"t":18446744073709551616'), 3],
    ['extra space', NEW + ALLOW.replace('"op":"allow",', '"op":"allow", '), 2],
    ['unknown op', NEW + ALLOW.replace('"allow"', '"evict"'), 2],
    ['missing final newline', NEW + ALLOW.slice(0, -1), 2],
    ['CRLF', NEW + ALLOW.replace('\n', '\r\n'), 2],
    ['second new line', NEW + ALLOW + NEW, 3],
    ['first line not new', ALLOW + NEW, 1],
    ['empty text', '', 1],
    ['blank line', NEW + '\n' + ALLOW, 2],
    ['key longer than 512 hex chars', NEW + ALLOW.replace('757365723a31', '61'.repeat(257)), 2],
    ['shards beyond 32 bits', '{"op":"new","shards":4294967296,"hint":0}\n', 1],
    ['reordered fields', NEW + '{"op":"allow","cap":10,"key":"757365723a31","rate":5,"t":0}\n', 2],
    ['negative value', NEW + ALLOW.replace('"rate":5', '"rate":-5'), 2],
    ['not a string', null, 1],
  ];
  for (const [name, text, line] of cases) {
    assert.throws(() => parseTrace(text), (err) => err instanceof Error && err.message.startsWith(`line ${line}: `), name);
  }
  // The limits themselves are accepted.
  const max = NEW + ALLOW.replace('"t":0', '"t":18446744073709551615').replace('757365723a31', '61'.repeat(256))
    + '{"op":"allow","key":"","cap":0,"rate":0,"t":0}\n';
  const parsed = parseTrace(max);
  assert.equal(parsed.ops[0].t, 18446744073709551615n);
  assert.equal(parsed.ops[0].key.length, 256);
  assert.equal(parsed.ops[1].key.length, 0);
  assert.equal(toJsonl(parsed.ops, parsed), max);
});

test('runTrace prints the version line and outcomes equal to direct Limiter calls', () => {
  for (const name of ['r1', 'r4']) {
    const text = exportPreset(name, module), out = runTrace(text, module).split('\n');
    assert.equal(out.at(-1), '');
    assert.equal(out[0], 'N 0.1.0');
    const rl = new Limiter(module), expected = ['N 0.1.0'];
    try {
      for (const o of parseTrace(text).ops) {
        const limit = { capacity: o.cap, refill_per_sec: o.rate };
        if (o.op === 'allow') {
          const d = rl.allow(o.key, limit, o.t);
          expected.push(`A ${d.allowed ? 1 : 0} ${d.remaining} ${d.reset_ms}`);
        } else {
          const s = rl.inspect(o.key, limit, o.t);
          expected.push(`I ${+s.tracked} ${+s.would_allow} ${s.stored_nanotokens} ${s.stored_at_ns} ${s.nanotokens} ${s.tokens} ${s.until_token_ns} ${s.until_full_ns}`);
        }
      }
    } finally { rl.free(); }
    assert.deepEqual(out.slice(0, -1), expected, name);
    assert.ok(out.some((l) => l.startsWith('A 0 ')) && out.some((l) => l.startsWith('A 1 ')), name);
  }
});

test('preset r4 changes capacity from 20 to 3 and passes its refill rate through 0', () => {
  const ops = allowOps(exportPreset('r4', module));
  const caps = ops.map((o) => o.cap), rates = ops.map((o) => o.rate);
  assert.equal(caps[0], 20n);
  assert.equal(caps.at(-1), 3n);
  assert.ok(caps.indexOf(3n) > caps.lastIndexOf(20n));
  const zero = rates.indexOf(0n);
  assert.ok(zero > rates.lastIndexOf(50n) && rates.indexOf(7n) > rates.lastIndexOf(0n));
  assert.ok(ops.some((o) => Buffer.from(o.key).toString() === 'global'));
});

test('formatAllow and formatInspect write the outcome fields in header order', () => {
  assert.equal(formatAllow({ allowed: true, remaining: 3n, reset_ms: 0n }), 'A 1 3 0');
  assert.equal(formatAllow({ allowed: false, remaining: 0n, reset_ms: 18446744073709551615n }), 'A 0 0 18446744073709551615');
  assert.equal(formatInspect({
    tracked: true, would_allow: false, stored_nanotokens: 1n, stored_at_ns: 2n, nanotokens: 3n, tokens: 4n,
    until_token_ns: 5n, until_full_ns: 6n,
  }), 'I 1 0 1 2 3 4 5 6');
});

test('recordingLimiter records each call as key bytes, limit and time, and passes results through', () => {
  const rec = recordingLimiter(new Limiter(module));
  try {
    const d = rec.allow('user:1', { capacity: 10, refill_per_sec: 5 }, 0n);
    const s = rec.inspect('user:1', { capacity: 10, refill_per_sec: 5 }, 250_000_000n);
    assert.deepEqual(d, { allowed: true, remaining: 9n, reset_ms: 0n });
    assert.equal(s.tracked, true);
    assert.equal(toJsonl(rec.ops), NEW + ALLOW + INSPECT);
    assert.throws(() => rec.allow(7, { capacity: 1, refill_per_sec: 1 }, 0n), TypeError);
    assert.equal(rec.ops.length, 2);
  } finally { rec.free(); }
  assert.equal(rec.freed, true);
});

test('the CLI exports deterministically, runs traces and reports errors with exit codes', async () => {
  const a = await cli(['--preset', 'r2']), b = await cli(['--preset', 'r2']);
  assert.equal(a.code, 0);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.stdout, exportPreset('r2', module));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rl-trace-'));
  try {
    const out = path.join(dir, 'r2.jsonl'), bad = path.join(dir, 'bad.jsonl');
    assert.equal((await cli(['--preset', 'r2', '--out', out])).code, 0);
    assert.equal(await readFile(out, 'utf8'), a.stdout);
    const run = await cli(['--run', out]);
    assert.equal(run.code, 0);
    assert.equal(run.stdout, runTrace(a.stdout, module));
    assert.ok(run.stdout.startsWith('N 0.1.0\n'));
    await writeFile(bad, NEW + ALLOW.replace('"cap":10', '"cap":010'));
    const fail = await cli(['--run', bad]);
    assert.equal(fail.code, 1);
    assert.match(fail.stderr, /line 2: /);
    assert.equal(fail.stdout, '');
    assert.equal((await cli(['--run', path.join(dir, 'missing.jsonl')])).code, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const list = await cli(['--list']);
  assert.equal(list.code, 0);
  assert.equal(list.stdout, 'r1 seed 1\nr2 seed 2\nr3 seed 3\nr4 seed 4\n');
  for (const args of [['--preset', 'nope'], [], ['--list', '--preset', 'r1'], ['--run'], ['--out', 'x'], ['--bogus']]) {
    assert.equal((await cli(args)).code, 2, args.join(' '));
  }
});
