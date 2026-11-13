// Tests of the Rate Limiter Playground's traffic and replay engine (scripts/demos/ratelimit-traffic.js) driving the
// real WASM module through the binding (scripts/demos/ratelimit-wasm.js): determinism, replay, fork, chunking, tie
// order, bursts, key independence and modes, seeds, and the handle lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLimiterModule, Limiter } from '../../scripts/demos/ratelimit-wasm.js';
import { Run, ALL_KEYS, SEED_LIMIT, parseSeed, randomSeed, mulberry32 } from '../../scripts/demos/ratelimit-traffic.js';

const MS = 1_000_000n, SEC = 1_000_000_000n;

const module = await loadLimiterModule();

// The demo default config (ratelimit.js), four client slots always present.
function demoConfig() {
  return {
    capacity: 10, refill: 5, shared: false, clientCount: 2,
    clients: [{ rate: 8, pattern: 'steady' }, { rate: 3, pattern: 'steady' }, { rate: 12, pattern: 'steady' }, { rate: 1, pattern: 'steady' }],
  };
}

function randomConfig() {
  const cfg = demoConfig();
  cfg.clients[0].pattern = 'random'; cfg.clients[1].pattern = 'random';
  return cfg;
}

// No synthetic traffic: every decision comes from apply().
function quietConfig(overrides = {}) {
  return { ...demoConfig(), clients: demoConfig().clients.map(() => ({ rate: 0, pattern: 'steady' })), ...overrides };
}

// A Run whose decisions are collected in run.log; freed by withRuns.
function makeRun(seed, config, counter = { n: 0 }) {
  const run = new Run({ seed, config, createLimiter: () => { counter.n++; return new Limiter(module); } });
  run.log = [];
  run.onDecision = (d) => run.log.push(d);
  return run;
}

function withRuns(runs, fn) {
  try { return fn(...runs); } finally { for (const r of runs) r.free(); }
}

// The live session of the behavior list: a click, a burst and config changes at fixed virtual times.
const SESSION = [
  [1_234n * MS, { kind: 'click', key: 'user:1', lane: 0 }],
  [2n * SEC, { kind: 'burst', key: 'user:1', lane: 0, n: 15 }], // capacity 10 + 5
  [3n * SEC, { kind: 'config', patch: { capacity: 4 } }],
  [4n * SEC, { kind: 'config', patch: { clientCount: 4 } }],
  [5n * SEC, { kind: 'config', patch: { client: 0, rate: 20 } }],
  [6n * SEC, { kind: 'config', patch: { shared: true } }],
];

function playSession(run, end = 10n * SEC) {
  for (const [t, input] of SESSION) { run.advanceTo(t); run.apply(input); }
  run.advanceTo(end);
}

// Advances in steps ending at the given instants, optionally inspecting random keys at random instants in between.
function advanceInSteps(run, ends, rng = null) {
  for (const t of ends) {
    run.advanceTo(t);
    if (rng) {
      const key = ALL_KEYS[Math.floor(rng() * ALL_KEYS.length)];
      run.inspect(key, run.now + BigInt(Math.floor(rng() * 1e9)));
    }
  }
}

test('two runs with the same seed and config make the same real decisions', () => withRuns(
  [makeRun(42, randomConfig()), makeRun(42, randomConfig())], (a, b) => {
    a.advanceTo(10n * SEC); b.advanceTo(10n * SEC);
    assert.ok(a.log.length > 0);
    assert.ok(a.log.some((d) => d.allowed) && a.log.some((d) => !d.allowed));
    assert.deepEqual(a.log, b.log);
    for (const d of a.log) {
      assert.deepEqual(Object.keys(d), ['t', 'key', 'lane', 'source', 'allowed', 'remaining', 'reset_ms']);
      assert.equal(d.source, 'synthetic');
    }
  }));

test('replay and a fresh run reproduce a live session with clicks, a burst and config changes', () => withRuns(
  [makeRun(7, randomConfig()), makeRun(7, randomConfig())], (live, fresh) => {
    playSession(live);
    const original = live.log;
    assert.ok(original.some((d) => d.source === 'you') && original.some((d) => d.key === 'global'));
    assert.deepEqual(live.events.map((e) => [e.t, e.seq, e.kind]), SESSION.map(([t, e], i) => [t, i + 1, e.kind]));
    assert.equal(live.config.capacity, 4);
    live.log = [];
    live.replay();
    assert.equal(live.now, 0n);
    live.advanceTo(10n * SEC);
    assert.deepEqual(live.log, original);
    playSession(fresh);
    assert.deepEqual(fresh.log, original);
    assert.deepEqual(live.initialConfig, randomConfig());
    assert.ok(Object.isFrozen(live.initialConfig) && Object.isFrozen(live.initialConfig.clients[0]));
  }));

test('a live event during a replay forks the log deterministically', () => withRuns([makeRun(7, randomConfig())], (run) => {
  playSession(run);
  const original = run.log;
  run.replay(); run.log = [];
  run.advanceTo(1_500n * MS);
  run.apply({ kind: 'click', key: 'user:2', lane: 1 });
  assert.equal(run.events.at(-1).kind, 'click');
  assert.equal(run.events.at(-1).key, 'user:2');
  assert.equal(run.events.at(-1).t, 1_500n * MS);
  assert.ok(run.events.every((e) => e.t <= 1_500n * MS));
  assert.deepEqual(run.events.map((e) => e.t), [1_234n * MS, 1_500n * MS]);
  run.advanceTo(10n * SEC);
  const forked = run.log;
  assert.notDeepEqual(forked, original);
  run.replay(); run.log = [];
  run.advanceTo(10n * SEC);
  assert.deepEqual(run.log, forked);
}));

test('splitting the time range into chunks or inspecting in between never changes a decision', () => {
  const end = 10n * SEC, rng = mulberry32(99), cuts = new Set();
  while (cuts.size < 996) cuts.add(BigInt(1 + Math.floor(rng() * Number(end - 1n))));
  const random997 = [...cuts].sort((x, y) => (x < y ? -1 : 1)).concat(end);
  const perMs = Array.from({ length: 10_000 }, (_, i) => BigInt(i + 1) * MS);
  withRuns([makeRun(11, randomConfig()), makeRun(11, randomConfig()), makeRun(11, randomConfig()), makeRun(11, randomConfig())],
    (one, many, ms, inspected) => {
      one.advanceTo(end);
      advanceInSteps(many, random997);
      advanceInSteps(ms, perMs);
      advanceInSteps(inspected, random997, mulberry32(5));
      assert.ok(one.log.length > 0);
      assert.deepEqual(many.log, one.log);
      assert.deepEqual(ms.log, one.log);
      assert.deepEqual(inspected.log, one.log);
    });
  // The same holds for a replay of a session with logged events.
  withRuns([makeRun(7, randomConfig())], (run) => {
    playSession(run);
    const original = run.log;
    run.replay(); run.log = [];
    advanceInSteps(run, perMs, mulberry32(6));
    assert.deepEqual(run.log, original);
  });
});

test('a burst of capacity + 5 into a full bucket with refill 0 gives capacity allowed, then 5 denied', () => withRuns(
  [makeRun(1, quietConfig({ capacity: 5, refill: 0, clientCount: 1 }))], (run) => {
    const out = run.apply({ kind: 'burst', key: 'user:1', lane: 0, n: 10 });
    assert.equal(out.length, 10);
    assert.deepEqual(out.map((d) => d.allowed), [true, true, true, true, true, false, false, false, false, false]);
    assert.deepEqual(out.map((d) => d.remaining), [4n, 3n, 2n, 1n, 0n, 0n, 0n, 0n, 0n, 0n]);
    assert.ok(out.every((d) => d.source === 'you' && d.t === 0n && d.key === 'user:1' && d.lane === 0));
    assert.deepEqual(run.log, out);
  }));

test('arrivals on the same nanosecond are decided lowest client index first, live and in replay', () => {
  const cfg = quietConfig({ clientCount: 2 });
  cfg.clients[0].rate = 4; cfg.clients[1].rate = 4;
  withRuns([makeRun(3, cfg)], (run) => {
    const check = (log) => {
      assert.equal(log.length, 16);
      for (let i = 0; i < log.length; i += 2) {
        assert.equal(log[i].t, log[i + 1].t);
        assert.deepEqual([log[i].lane, log[i + 1].lane], [0, 1]);
      }
    };
    run.advanceTo(2n * SEC);
    check(run.log);
    const live = run.log;
    run.replay(); run.log = [];
    run.advanceTo(2n * SEC);
    check(run.log);
    assert.deepEqual(run.log, live);
  });
});

test('each key reads its own state: calling user:1 leaves user:2 unchanged', () => withRuns([makeRun(1, quietConfig())], (run) => {
  run.apply({ kind: 'click', key: 'user:2', lane: 1 });
  run.advanceTo(SEC);
  const before = run.inspect('user:2');
  for (let i = 0; i < 3; i++) run.apply({ kind: 'click', key: 'user:1', lane: 0 });
  run.apply({ kind: 'burst', key: 'user:1', lane: 0, n: 20 });
  assert.deepEqual(run.inspect('user:2'), before);
  assert.equal(before.tracked, true);
  assert.equal(run.inspect('user:1').tokens, 0n);
}));

test('shared and per-key modes keep independent state, and trackedCount counts them by inspection', () => {
  for (const n of [1, 4]) {
    const cfg = demoConfig();
    cfg.clientCount = n;
    withRuns([makeRun(5, cfg)], (run) => {
      assert.equal(run.trackedCount(), 0);
      run.advanceTo(SEC);
      assert.deepEqual(new Set(run.log.map((d) => d.key)), new Set(ALL_KEYS.slice(0, n)));
      assert.equal(run.trackedCount(), n);
      run.apply({ kind: 'config', patch: { shared: true } });
      assert.deepEqual(run.keys(), ['global']);
      const mark = run.log.length;
      run.advanceTo(2n * SEC);
      const shared = run.log.slice(mark);
      assert.ok(shared.length > 0 && shared.every((d) => d.key === 'global'));
      assert.deepEqual(new Set(shared.map((d) => d.lane)), new Set(Array.from({ length: n }, (_, i) => i)));
      for (const k of ALL_KEYS.slice(0, n)) assert.equal(run.inspect(k).tracked, true);
      run.apply({ kind: 'config', patch: { shared: false } });
      assert.deepEqual(run.keys(), ALL_KEYS.slice(0, n));
      run.advanceTo(3n * SEC);
      assert.equal(run.inspect('global').tracked, true);
      assert.equal(run.trackedCount(), n + 1);
    });
  }
});

test('parseSeed accepts exactly the integers 0..4294967295 and randomSeed stays in range', () => {
  assert.equal(SEED_LIMIT, 2 ** 32);
  assert.equal(parseSeed('0'), 0);
  assert.equal(parseSeed('4294967295'), 4294967295);
  assert.equal(parseSeed(7), 7);
  assert.equal(parseSeed(0), 0);
  for (const bad of ['4294967296', '-1', '1.5', '1e3', ' 7', '7 ', '', 'abc', '07', '+7', '0x10', 2 ** 32, -1, NaN, 1.5,
    Infinity, null, undefined, 7n, {}, []]) {
    assert.equal(parseSeed(bad), null, `parseSeed(${String(bad)})`);
  }
  for (let i = 0; i < 100; i++) {
    const s = randomSeed();
    assert.ok(Number.isInteger(s) && s >= 0 && s < SEED_LIMIT);
  }
  assert.throws(() => new Run({ seed: -1, config: demoConfig(), createLimiter: () => new Limiter(module) }), RangeError);
});

test('per-client generators are seeded with (seed + i) mod 2^32', () => {
  const cfg = quietConfig({ clientCount: 1 });
  cfg.clients[0] = { rate: 5, pattern: 'random' };
  withRuns([makeRun(SEED_LIMIT - 1, cfg)], (run) => {
    run.advanceTo(5n * SEC);
    const rng = mulberry32(4294967295);
    let t = 0n;
    const expected = [];
    for (;;) {
      t += BigInt(Math.max(1, Math.round((-Math.log(1 - rng()) / 5) * 1e9)));
      if (t > 5n * SEC) break;
      expected.push(t);
    }
    assert.deepEqual(run.log.map((d) => d.t), expected);
  });
});

test('replay frees the previous limiter and creates exactly one new one', () => {
  const counter = { n: 0 };
  withRuns([makeRun(1, demoConfig(), counter)], (run) => {
    assert.equal(counter.n, 1);
    const first = run.limiter;
    run.advanceTo(SEC);
    run.replay();
    assert.equal(first.freed, true);
    assert.equal(counter.n, 2);
    assert.notEqual(run.limiter, first);
    assert.equal(run.limiter.freed, false);
    assert.equal(run.trackedCount(), 0);
  });
});

test('the virtual clock never moves back and bad inputs never enter the log', () => withRuns([makeRun(1, demoConfig())], (run) => {
  run.advanceTo(SEC);
  assert.throws(() => run.advanceTo(SEC - 1n), RangeError);
  assert.throws(() => run.advanceTo(2), TypeError);
  for (const bad of [
    null, {}, { kind: 'nope' }, { kind: 'click', key: 'user:9', lane: 0 }, { kind: 'click', key: 'user:1', lane: 4 },
    { kind: 'burst', key: 'user:1', lane: 0, n: -1 }, { kind: 'burst', key: 'user:1', lane: 0, n: 1.5 },
    { kind: 'config', patch: {} }, { kind: 'config', patch: { capacity: -1 } }, { kind: 'config', patch: { refill: 0.5 } },
    { kind: 'config', patch: { shared: 'yes' } }, { kind: 'config', patch: { clientCount: 0 } },
    { kind: 'config', patch: { clientCount: 5 } }, { kind: 'config', patch: { client: 4, rate: 1 } },
    { kind: 'config', patch: { client: 0, rate: -1 } }, { kind: 'config', patch: { client: 0, rate: NaN } },
    { kind: 'config', patch: { client: 0, pattern: 'bursty' } }, { kind: 'config', patch: { capacity: 3, refill: 3 } },
  ]) {
    assert.throws(() => run.apply(bad), (err) => err instanceof TypeError || err instanceof RangeError, JSON.stringify(bad));
  }
  assert.equal(run.events.length, 0);
}));
