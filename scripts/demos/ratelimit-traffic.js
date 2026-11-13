// Seeded traffic and replay engine of the Rate Limiter Playground, DOM-free, extracted from ratelimit.js. Every decision
// is ratelimit-cpp's rl_allow_at through the injected Limiter (ratelimit-wasm.js) on a virtual clock the caller advances.

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Arrivals per client on a BigInt nanosecond clock. Steady clients arrive every round(1e9 / rate) ns,
// random ones after exponential gaps (Poisson arrivals) from a seeded generator, so a reset replays exactly.
export class Traffic {
  constructor(cfg, { limiter, seed }) {
    this.cfg = cfg; // { capacity, refill, shared, clientCount, clients: [{ rate, pattern }] }
    this.limiter = limiter;
    this.now = 0n;
    this.onDecision = () => {};
    this.clients = cfg.clients.map((c, i) => ({ ...c, i, rng: mulberry32((seed + i) >>> 0), next: null }));
    this.clients.forEach((c) => this.reschedule(c));
  }
  key(i) { return this.cfg.shared ? 'global' : `user:${i + 1}`; }
  keys() { return this.cfg.shared ? ['global'] : Array.from({ length: this.cfg.clientCount }, (_, i) => `user:${i + 1}`); }
  limit() { return { capacity: this.cfg.capacity, refill_per_sec: this.cfg.refill }; }
  gap(c) {
    if (!(c.rate > 0)) return null;
    const s = c.pattern === 'random' ? -Math.log(1 - c.rng()) / c.rate : 1 / c.rate;
    return BigInt(Math.max(1, Math.round(s * 1e9)));
  }
  reschedule(c) { const g = this.gap(c); c.next = g === null ? null : this.now + g; }
  call(key, lane, t = this.now, source = 'synthetic') {
    const r = { t, key, lane, source, ...this.limiter.allow(key, this.limit(), t) };
    this.onDecision(r);
    return r;
  }
  // Runs every arrival due at or before t, in time order, then moves the clock to t.
  advanceTo(t) {
    for (;;) {
      let c = null;
      for (let i = 0; i < this.cfg.clientCount; i++) {
        const x = this.clients[i];
        if (x.next !== null && x.next <= t && (!c || x.next < c.next)) c = x;
      }
      if (!c) break;
      this.call(this.key(c.i), c.i, c.next);
      const g = this.gap(c);
      c.next = g === null ? null : c.next + g;
    }
    this.now = t;
  }
}

// ---------- Seeds and keys ----------

// Every key the playground can call: per-client keys for up to four clients, and the shared key.
export const ALL_KEYS = Object.freeze(['user:1', 'user:2', 'user:3', 'user:4', 'global']);
export const SEED_LIMIT = 2 ** 32;
const MAX_CLIENTS = 4, PATTERNS = ['steady', 'random'];

// A seed is an integer in [0, 2^32): a Number, or a plain decimal string without sign, spaces or leading zeros.
export function parseSeed(value) {
  let n = null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) n = value;
  else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 10) n = Number(value);
  return n !== null && n >= 0 && n < SEED_LIMIT ? n : null;
}

export function randomSeed() { return crypto.getRandomValues(new Uint32Array(1))[0]; }

// ---------- Input checks (a bad input throws before it is logged or executed) ----------

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isRate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function check(ok, msg) { if (!ok) throw new RangeError(msg); }

function checkConfig(cfg) {
  if (cfg === null || typeof cfg !== 'object' || !Array.isArray(cfg.clients)) throw new TypeError('config must be an object with clients');
  check(cfg.clients.length >= 1 && cfg.clients.length <= MAX_CLIENTS, 'config.clients must hold 1 to 4 clients');
  check(isCount(cfg.capacity) && isCount(cfg.refill), 'capacity and refill must be non-negative integers');
  check(typeof cfg.shared === 'boolean', 'shared must be a boolean');
  check(Number.isInteger(cfg.clientCount) && cfg.clientCount >= 1 && cfg.clientCount <= cfg.clients.length, 'clientCount is out of range');
  for (const c of cfg.clients) check(isRate(c.rate) && PATTERNS.includes(c.pattern), 'each client needs a rate >= 0 and a pattern');
}

function checkPatch(p, cfg) {
  if (p === null || typeof p !== 'object') throw new TypeError('patch must be an object');
  const k = Object.keys(p).sort().join();
  if (k === 'capacity' || k === 'refill') return check(isCount(p[k]), `${k} must be a non-negative integer`);
  if (k === 'shared') return check(typeof p.shared === 'boolean', 'shared must be a boolean');
  if (k === 'clientCount') return check(Number.isInteger(p.clientCount) && p.clientCount >= 1 && p.clientCount <= cfg.clients.length, 'clientCount is out of range');
  check(k === 'client,rate' || k === 'client,pattern', `unknown config patch: ${k || 'empty'}`);
  check(Number.isInteger(p.client) && p.client >= 0 && p.client < cfg.clients.length, 'client is out of range');
  check('rate' in p ? isRate(p.rate) : PATTERNS.includes(p.pattern), 'bad client rate or pattern');
}

function checkInput(input, cfg) {
  if (input === null || typeof input !== 'object') throw new TypeError('input must be an object');
  if (input.kind === 'config') { checkPatch(input.patch, cfg); return { kind: 'config', patch: { ...input.patch } }; }
  check(input.kind === 'click' || input.kind === 'burst', `unknown event kind: ${input.kind}`);
  check(ALL_KEYS.includes(input.key), 'key must be one of ALL_KEYS');
  check(Number.isInteger(input.lane) && input.lane >= 0 && input.lane < cfg.clients.length, 'lane is out of range');
  if (input.kind === 'click') return { kind: 'click', key: input.key, lane: input.lane };
  check(isCount(input.n), 'burst size must be a non-negative integer');
  return { kind: 'burst', key: input.key, lane: input.lane, n: input.n };
}

// ---------- Run (event-sourced) ----------

const cloneConfig = (cfg) => ({ ...cfg, clients: cfg.clients.map((c) => ({ ...c })) });
const freezeConfig = (cfg) => Object.freeze({ ...cfg, clients: Object.freeze(cfg.clients.map((c) => Object.freeze(c))) });

// Determinism contract: the same seed, initial config and event log give the same decisions on the same JavaScript
// engine, however advanceTo splits time and whatever is inspected in between (rl_inspect_at writes nothing). Equality
// across engines is not claimed: Math.log in gap() is implementation-approximated. Pause and speed are not events,
// because they never change a decision; clicks, bursts and config changes are, stamped with the virtual time.
export class Run {
  constructor({ seed, config, createLimiter }) {
    if (parseSeed(seed) === null) throw new RangeError('seed must be an integer in [0, 2^32)');
    checkConfig(config);
    this.seed = seed;
    this.initialConfig = freezeConfig(cloneConfig(config));
    this.createLimiter = createLimiter;
    this.onDecision = () => {};
    this.events = [];
    this.seq = 0;
    this.limiter = null;
    this.start();
  }

  // One limiter handle per run or replay (D-01): the old one is freed, never swept for idle keys.
  start() {
    this.limiter?.free();
    this.limiter = null;
    this.limiter = this.createLimiter();
    this.traffic = new Traffic(cloneConfig(this.initialConfig), { limiter: this.limiter, seed: this.seed });
    this.traffic.onDecision = (d) => this.onDecision(d);
    this.cursor = 0;
  }

  get now() { return this.traffic.now; }
  get config() { return this.traffic.cfg; }
  keys() { return this.traffic.keys(); }
  limit() { return this.traffic.limit(); }

  // Re-applies the logged events due by t (each after the arrivals due by its own time), then the arrivals up to t.
  advanceTo(t) {
    if (typeof t !== 'bigint') throw new TypeError('t must be a bigint nanosecond time');
    if (t < this.now) throw new RangeError('the virtual clock never moves back');
    while (this.cursor < this.events.length && this.events[this.cursor].t <= t) {
      const e = this.events[this.cursor];
      this.traffic.advanceTo(e.t);
      this.execute(e);
      this.cursor++;
    }
    this.traffic.advanceTo(t);
  }

  // Records a live input at the current virtual time and runs it. During a replay, logged events due by now run
  // first and every logged event after them is dropped (a deterministic fork). Returns the decisions it caused.
  apply(input) {
    const e = checkInput(input, this.config);
    this.advanceTo(this.now);
    if (this.cursor < this.events.length) this.events.length = this.cursor;
    const ev = Object.freeze({ t: this.now, seq: ++this.seq, ...e });
    this.events.push(ev);
    this.cursor = this.events.length;
    return this.execute(ev);
  }

  // The one code path for live input and replay.
  execute(e) {
    const T = this.traffic, out = [];
    if (e.kind === 'click') out.push(T.call(e.key, e.lane, e.t, 'you'));
    else if (e.kind === 'burst') for (let i = 0; i < e.n; i++) out.push(T.call(e.key, e.lane, e.t, 'you'));
    else this.applyConfig(e.patch);
    return out;
  }

  // Mirrors the live controls of ratelimit.js: newly active clients and changed clients are rescheduled from now.
  applyConfig(p) {
    const T = this.traffic, cfg = T.cfg;
    if ('capacity' in p) cfg.capacity = p.capacity;
    else if ('refill' in p) cfg.refill = p.refill;
    else if ('shared' in p) cfg.shared = p.shared;
    else if ('clientCount' in p) {
      for (let i = cfg.clientCount; i < p.clientCount; i++) T.reschedule(T.clients[i]);
      cfg.clientCount = p.clientCount;
    } else {
      const c = T.clients[p.client];
      if ('rate' in p) cfg.clients[c.i].rate = c.rate = p.rate;
      else cfg.clients[c.i].pattern = c.pattern = p.pattern;
      T.reschedule(c);
    }
  }

  // Replays the recorded seed, initial config and event log through the library from virtual time 0.
  replay() { this.start(); }

  inspect(key, t = this.now) { return this.limiter.inspect(key, this.limit(), t); }

  // The C API has no key count, so tracked keys are counted by inspecting every possible key.
  trackedCount() { return ALL_KEYS.filter((k) => this.inspect(k).tracked).length; }

  free() { this.limiter?.free(); }
}
