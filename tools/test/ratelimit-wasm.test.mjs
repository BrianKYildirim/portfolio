// Tests of the WASM binding (scripts/demos/ratelimit-wasm.js) against the real module in scripts/demos/wasm/,
// with known values copied from ratelimit-cpp tests/test_c_api.c check_inspection() and tests/test_core.cpp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadLimiterModule, Limiter, RL_NEVER, NS_PER_MS, NANOTOKENS_PER_TOKEN, LIMIT_BYTES, DECISION_BYTES, STATE_BYTES,
  formatTokens, formatWait,
} from '../../scripts/demos/ratelimit-wasm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLUE = pathToFileURL(path.join(HERE, '..', '..', 'scripts', 'demos', 'wasm', 'ratelimit.mjs')).href;

const MS = 1_000_000n, SEC = 1_000_000_000n, TOKEN = 1_000_000_000n, U64_MAX = 2n ** 64n - 1n;
const t = 60n * SEC; // test_c_api.c runs 60 s ahead of the limiter's clock; only differences enter the math
const lim = { capacity: 2n, refill_per_sec: 10n }; // a token per 100 ms

const module = await loadLimiterModule();

// One Limiter per test, always freed.
function withLimiter(fn, m = module) {
  const rl = new Limiter(m);
  try { return fn(rl); } finally { rl.free(); }
}

test('a new key starts full', () => withLimiter((rl) => {
  assert.deepEqual(rl.allow('k', { capacity: 2n, refill_per_sec: 0n }, 0n), { allowed: true, remaining: 1n, reset_ms: 0n });
}));

test('the constants match the C header and the wasm32 struct layouts', () => {
  assert.equal(RL_NEVER, 18446744073709551615n);
  assert.equal(NS_PER_MS, MS);
  assert.equal(NANOTOKENS_PER_TOKEN, TOKEN);
  assert.equal(LIMIT_BYTES, 16);
  assert.equal(DECISION_BYTES, 24);
  assert.equal(STATE_BYTES, 56);
});

test('check_inspection known values from test_c_api.c match field by field', () => withLimiter((rl) => {
  // Untracked: a full bucket derived from the limit, nothing stored or inserted.
  const full = { tracked: false, would_allow: true, stored_nanotokens: 0n, stored_at_ns: 0n, nanotokens: 2n * TOKEN,
    tokens: 2n, until_token_ns: 0n, until_full_ns: 0n };
  assert.deepEqual(rl.inspect('k', lim, t), full);
  assert.deepEqual(rl.inspect('k', lim, t), full);

  assert.deepEqual(rl.allow('k', lim, t), { allowed: true, remaining: 1n, reset_ms: 0n });
  assert.deepEqual(rl.inspect('k', lim, t), { tracked: true, would_allow: true, stored_nanotokens: TOKEN, stored_at_ns: t,
    nanotokens: TOKEN, tokens: 1n, until_token_ns: 0n, until_full_ns: 100n * MS });
  assert.equal(rl.allow('k', lim, t).allowed, true);

  const s = rl.inspect('k', lim, t + 30n * MS + 1n), d = rl.allow('k', lim, t + 30n * MS + 1n);
  assert.deepEqual(s, { tracked: true, would_allow: false, stored_nanotokens: 0n, stored_at_ns: t, nanotokens: 300000010n,
    tokens: 0n, until_token_ns: 70n * MS - 1n, until_full_ns: 170n * MS - 1n });
  assert.deepEqual(d, { allowed: false, remaining: 0n, reset_ms: 70n });
  assert.equal(d.reset_ms, (s.until_token_ns + MS - 1n) / MS, 'reset_ms is until_token_ns / 1e6 rounded up');

  const s2 = rl.inspect('k', lim, t + 100n * MS), d2 = rl.allow('k', lim, t + 100n * MS);
  assert.equal(s2.would_allow, true);
  assert.equal(s2.tokens, 1n);
  assert.deepEqual(d2, { allowed: true, remaining: 0n, reset_ms: d2.reset_ms });
  assert.equal(d2.remaining, s2.tokens - 1n);

  // Never: capacity 0, or no refill once empty.
  const zero = rl.inspect('zero', { capacity: 0n, refill_per_sec: 5n }, t);
  assert.equal(zero.tracked, false);
  assert.equal(zero.tokens, 0n);
  assert.equal(zero.would_allow, false);
  assert.equal(zero.until_token_ns, RL_NEVER);
  assert.equal(zero.until_full_ns, 0n);

  const dry = { capacity: 1n, refill_per_sec: 0n };
  assert.equal(rl.allow('dry', dry, t).allowed, true);
  const sd = rl.inspect('dry', dry, t + 1000n * SEC);
  assert.equal(sd.tracked, true);
  assert.equal(sd.stored_at_ns, t);
  assert.equal(sd.until_token_ns, RL_NEVER);
  assert.equal(sd.until_full_ns, RL_NEVER);
  assert.equal(rl.allow('dry', dry, t + 1000n * SEC).reset_ms, 0n);

  // Keys end at the first NUL, for every function alike.
  assert.equal(rl.inspect('k\u0000ignored', lim, t).tracked, true);
  assert.equal(rl.inspect('dry\u0000x', dry, t).stored_at_ns, t + 1000n * SEC);
}));

test('an empty untracked bucket of capacity 0 never gets a token and formats as never', () => withLimiter((rl) => {
  const s = rl.inspect('z', { capacity: 0n, refill_per_sec: 5n }, t);
  assert.deepEqual([s.tracked, s.tokens, s.until_token_ns, s.until_full_ns], [false, 0n, RL_NEVER, 0n]);
  assert.equal(formatWait(s.until_token_ns), 'never');
}));

test('a drained bucket with refill 0 never refills and its denial reports reset_ms 0', () => withLimiter((rl) => {
  const dry = { capacity: 1n, refill_per_sec: 0n };
  assert.equal(rl.allow('dry', dry, t).allowed, true);
  const s = rl.inspect('dry', dry, t + 1000n * SEC);
  assert.deepEqual([s.tokens, s.until_token_ns, s.until_full_ns], [0n, RL_NEVER, RL_NEVER]);
  assert.deepEqual(rl.allow('dry', dry, t + 1000n * SEC), { allowed: false, remaining: 0n, reset_ms: 0n });
}));

test('a token arrives exactly at the first nanosecond the wait names', () => withLimiter((rl) => {
  const one = { capacity: 1n, refill_per_sec: 10n };
  assert.equal(rl.allow('k', one, t).allowed, true);
  assert.equal(rl.inspect('k', one, t + 100n * MS - 1n).until_token_ns, 1n);
  assert.deepEqual(rl.allow('k', one, t + 100n * MS - 1n), { allowed: false, remaining: 0n, reset_ms: 1n });
  assert.equal(rl.allow('k', one, t + 100n * MS).allowed, true);
}));

test('the bucket is full exactly when until_full_ns runs out', () => withLimiter((rl) => {
  assert.equal(rl.allow('k', lim, t).allowed, true);
  const before = rl.inspect('k', lim, t + 100n * MS - 1n), at = rl.inspect('k', lim, t + 100n * MS);
  assert.deepEqual([before.until_full_ns, before.nanotokens], [1n, 1999999990n]);
  assert.deepEqual([at.until_full_ns, at.nanotokens], [0n, 2n * TOKEN]);
}));

test('waits count from the stored time when inspecting at an earlier time', () => withLimiter((rl) => {
  assert.equal(rl.allow('k', lim, t).allowed, true);
  const s = rl.inspect('k', lim, t - SEC);
  assert.deepEqual([s.stored_nanotokens, s.stored_at_ns, s.until_full_ns], [TOKEN, t, 100n * MS]);
}));

test('capacities at and above the library clamp read the same', () => withLimiter((rl) => {
  const read = (capacity) => rl.inspect(`c${capacity}`, { capacity, refill_per_sec: 1n }, t);
  for (const capacity of [18446744073n, 18446744074n, U64_MAX]) {
    const s = read(capacity);
    assert.equal(s.tokens, 18446744073n, `capacity ${capacity}`);
    assert.equal(s.nanotokens, 18446744073n * TOKEN, `capacity ${capacity}`);
  }
}));

test('uint64 extremes cross the boundary without loss', () => withLimiter((rl) => {
  const huge = { capacity: 3n, refill_per_sec: U64_MAX };
  for (let i = 0; i < 3; i++) assert.equal(rl.allow('h', huge, t).allowed, true);
  assert.deepEqual(rl.inspect('h', huge, U64_MAX), { tracked: true, would_allow: true, stored_nanotokens: 0n, stored_at_ns: t,
    nanotokens: 3n * TOKEN, tokens: 3n, until_token_ns: 0n, until_full_ns: 0n });
  const s = rl.inspect('fresh', huge, U64_MAX);
  for (const [name, v] of Object.entries(s)) if (typeof v !== 'boolean') assert.equal(typeof v, 'bigint', name);
}));

test('empty, NUL-embedded, byte-array and long keys behave as C keys', () => withLimiter((rl) => {
  const once = { capacity: 1n, refill_per_sec: 0n };
  assert.equal(rl.allow('', once, t).allowed, true);
  assert.equal(rl.inspect('', once, t).tracked, true);
  assert.equal(rl.allow('', once, t).allowed, false);

  assert.equal(rl.allow('k\u0000x', once, t).allowed, true);       // the key is "k"
  assert.equal(rl.inspect('k', once, t).tracked, true);
  assert.equal(rl.allow(new Uint8Array([0x6b]), once, t).allowed, false); // also "k"
  assert.equal(rl.allow(new Uint8Array([0x75, 0x38]), once, t).allowed, true);
  assert.equal(rl.inspect('u8', once, t).tracked, true);

  // A string key and a byte key whose cache entries could look alike stay distinct.
  assert.equal(rl.allow('117', once, t).allowed, true);
  assert.equal(rl.inspect(new Uint8Array([117]), once, t).tracked, false);

  for (const n of [27, 28, 29, 200]) assert.equal(rl.allow('q'.repeat(n), once, t).allowed, true, `${n} bytes`);
  for (const n of [27, 28, 29, 200]) assert.equal(rl.inspect('q'.repeat(n), once, t).tracked, true, `${n} bytes`);
  assert.equal(rl.inspect('q'.repeat(30), once, t).tracked, false);
}));

test('bad keys, times and limits throw before WASM is called', () => withLimiter((rl) => {
  for (const key of [null, undefined, 42]) {
    assert.throws(() => rl.allow(key, lim, t), TypeError);
    assert.throws(() => rl.inspect(key, lim, t), TypeError);
  }
  for (const now of [-1n, 2n ** 64n, 1.5, -1, Number.NaN, 2 ** 53]) assert.throws(() => rl.allow('k', lim, now), RangeError);
  assert.throws(() => rl.allow('k', lim, '5'), TypeError);
  assert.throws(() => rl.allow('k', { capacity: -1, refill_per_sec: 1n }, t), RangeError);
  assert.throws(() => rl.allow('k', { capacity: 1n, refill_per_sec: 2n ** 64n }, t), RangeError);
  assert.throws(() => rl.allow('k', { capacity: 1n }, t), TypeError);
  assert.throws(() => rl.allow('k', null, t), TypeError);
  assert.equal(rl.inspect('k', lim, t).tracked, false, 'no rejected call inserted the key');

  assert.deepEqual(rl.allow('n', { capacity: 2, refill_per_sec: 10 }, 5), { allowed: true, remaining: 1n, reset_ms: 0n });
  assert.equal(rl.inspect('n', lim, 5n).stored_at_ns, 5n);
}));

test('values stay exact after the module memory grows', async () => {
  const fresh = await loadLimiterModule(); // its own memory, so growth is not hidden by earlier tests
  withLimiter((rl) => {
    const before = fresh.HEAPU8.buffer.byteLength;
    rl.allow('k', lim, t); rl.allow('k', lim, t);
    for (let i = 0; i < 5000; i++) rl.allow(`key:${i}`, lim, t);
    assert.ok(fresh.HEAPU8.buffer.byteLength > before, `memory grew (${before} -> ${fresh.HEAPU8.buffer.byteLength})`);
    assert.equal(rl.inspect('k', lim, t + 30n * MS + 1n).nanotokens, 300000010n);
    assert.equal(rl.inspect('key:4999', lim, t).tracked, true);
  }, fresh);
});

test('free is idempotent and a freed limiter refuses calls', () => {
  const rl = new Limiter(module);
  assert.equal(rl.freed, false);
  rl.free();
  rl.free();
  assert.equal(rl.freed, true);
  assert.throws(() => rl.allow('k', lim, t), /freed/);
  assert.throws(() => rl.inspect('k', lim, t), /freed/);
});

test('version reports the library version string', () => withLimiter((rl) => {
  assert.equal(rl.version(), '0.1.0');
}));

test('the loader recovers from a failed load and returns a fresh module each time', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rlw-load-'));
  try {
    const url = pathToFileURL(path.join(dir, 'ratelimit.mjs')).href;
    await assert.rejects(loadLimiterModule({ url }));
    const a = await loadLimiterModule(), b = await loadLimiterModule();
    assert.notEqual(a, b);
    withLimiter((rl) => assert.equal(rl.version(), '0.1.0'), a);
    // Node does not cache a failed import, but Chromium does, so a retry (attempt > 0) of the URL that failed
    // must use a new specifier. A stub glue reports the specifier it was imported under.
    await writeFile(path.join(dir, 'ratelimit.mjs'), 'export default async () => ({ spec: import.meta.url });\n');
    const c = await loadLimiterModule({ url, attempt: 1 }), d = await loadLimiterModule({ url, attempt: 1 });
    assert.equal(c.spec, `${url}?r=1`);
    assert.notEqual(c, d, 'the factory runs again for every call');
    assert.equal((await loadLimiterModule({ url: GLUE, attempt: 2 })).HEAPU8 instanceof Uint8Array, true,
      'a retry attempt of a URL that never failed still loads the module');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('formatTokens and formatWait format BigInt values exactly', () => {
  assert.equal(formatTokens(1500000000n), '1.500000000');
  assert.equal(formatTokens(0n), '0.000000000');
  assert.equal(formatTokens(18446744073000000000n), '18446744073.000000000');
  assert.equal(formatWait(RL_NEVER), 'never');
  assert.equal(formatWait(69999999n), '69.999999 ms');
  assert.equal(formatWait(1n), '0.000001 ms');
  assert.equal(formatWait(0n), '0.000000 ms');
});
