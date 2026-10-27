// Port of the per-key token-bucket decision in ratelimit-cpp (src/inproc_rate_limiter.cpp:
// consume(), Full::allowed/denied, decide_locked's "new keys start full").
// uint64 arithmetic is emulated with BigInt; values wrap/saturate exactly as the C++ does.
const U64 = (1n << 64n) - 1n;
const UNIT = 1_000_000_000n;            // nanotokens per token (kUnit)
const MAX_CAP = U64 / UNIT;             // kMaxCapacity = 18'446'744'073
const QUIET_NS = 1_000_000n;            // kQuietNs
const mulOverflows = (a, b) => a * b > U64;

export class TokenBucketLimiter {
  constructor() { this.keys = new Map(); } // key -> { tokens: BigInt nanotokens, last: BigInt ns }
  size() { return this.keys.size; }
  clear() { this.keys.clear(); }

  // allow(key, {capacity, refill_per_sec}, now_ns) -> { allowed, remaining, reset_ms }  (BigInt fields as Number)
  allow(key, limit, nowNs) {
    const now = BigInt(nowNs), capTokens = BigInt(limit.capacity), rate = BigInt(limit.refill_per_sec);
    const cap = (capTokens < MAX_CAP ? capTokens : MAX_CAP) * UNIT;
    let st = this.keys.get(key);
    if (!st) { st = { tokens: cap, last: now }; this.keys.set(key, st); } // new keys start full
    let tokens = st.tokens < cap ? st.tokens : cap;                       // capacity may have been lowered
    let at = st.last;
    if (now > st.last) {
      const dt = now - st.last;
      if (mulOverflows(dt, rate) || dt * rate >= cap - tokens) tokens = cap; else tokens += dt * rate;
      at = now;
    }
    if (tokens >= UNIT) {
      st.tokens = tokens - UNIT; st.last = at;
      return { allowed: true, remaining: Number(st.tokens / UNIT), reset_ms: 0 };
    }
    if (st.tokens > cap || at - st.last >= QUIET_NS) { st.tokens = tokens; st.last = at; }
    if (rate === 0n || cap < UNIT) return { allowed: false, remaining: 0, reset_ms: 0 };
    const missing = UNIT - tokens;
    if (mulOverflows(rate, 1_000_000n)) return { allowed: false, remaining: 0, reset_ms: 1 };
    const perMs = rate * 1_000_000n;
    return { allowed: false, remaining: 0, reset_ms: Number((missing - 1n) / perMs + 1n) };
  }

  // Read-only view for visualization: the balance a call at `nowNs` would see, in tokens (float).
  peek(key, limit, nowNs) {
    const st = this.keys.get(key), capTokens = BigInt(limit.capacity), rate = BigInt(limit.refill_per_sec);
    const cap = (capTokens < MAX_CAP ? capTokens : MAX_CAP) * UNIT;
    if (!st) return Number(cap) / 1e9;
    let tokens = st.tokens < cap ? st.tokens : cap; const now = BigInt(nowNs);
    if (now > st.last) { const dt = now - st.last; tokens = mulOverflows(dt, rate) || dt * rate >= cap - tokens ? cap : tokens + dt * rate; }
    return Number(tokens) / 1e9;
  }
}
