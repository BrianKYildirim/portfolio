// Binds the C API of ratelimit-cpp (include/ratelimit/ratelimit_c.h) compiled to wasm32 by scripts/build-wasm.sh;
// the commit is in wasm/ratelimit.manifest.json. Structs follow the wasm32 Basic C ABI: by-value structs go by
// pointer, struct returns via a leading sret pointer.

// Clock (D-01): callers pass their own virtual now_ns to rl_allow_at/rl_inspect_at, where the header says times
// must come from rl_now_ns. The demo never calls rl_evict_idle, the only operation that compares stored times with
// the library's clock, and the module does not export it (nor rl_now_ns). Every decision and inspection value
// returned here is read from WASM memory; this file only marshals and formats them.

// Struct sizes (ratelimit_c.h): rl_limit_t, rl_decision_t, rl_bucket_state_t.
export const LIMIT_BYTES = 16;
export const DECISION_BYTES = 24;
export const STATE_BYTES = 56;
// ratelimit_c.h: #define RL_NEVER UINT64_MAX; "Nanotokens: 1 token = 1'000'000'000".
export const RL_NEVER = 0xFFFF_FFFF_FFFF_FFFFn;
export const NS_PER_MS = 1_000_000n;
export const NANOTOKENS_PER_TOKEN = 1_000_000_000n;

const ENCODER = new TextEncoder(), DECODER = new TextDecoder();

// ---------- Loading ----------

const DEFAULT_GLUE = new URL('./wasm/ratelimit.mjs', import.meta.url).href;
const glue = new Map(), failedGlue = new Set(); // specifier -> pending import of the factory; URLs whose import failed

// Imports the generated ES-module glue (D-03) once per specifier and instantiates a fresh module on every call, so
// a Retry re-instantiates a dead module. A failed import is forgotten; because Chromium keeps a failed module
// import in its module map, a retry (attempt > 0) of a URL that failed imports it with a cache-busting query.
export async function loadLimiterModule({ url = DEFAULT_GLUE, attempt = 0 } = {}) {
  let spec = url;
  if (attempt > 0 && failedGlue.has(url)) {
    const u = new URL(url, import.meta.url);
    u.searchParams.set('r', String(attempt));
    spec = u.href;
  }
  let pending = glue.get(spec);
  if (!pending) {
    pending = import(spec).then((m) => m.default);
    glue.set(spec, pending);
    pending.catch(() => { if (glue.get(spec) === pending) glue.delete(spec); failedGlue.add(url); });
  }
  const factory = await pending;
  return await factory();
}

// ---------- Input checks (all run before any WASM call) ----------

function u64(v, name) {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new RangeError(`${name} must be a safe integer or a bigint`);
    v = BigInt(v);
  } else if (typeof v !== 'bigint') {
    throw new TypeError(`${name} must be a bigint or a safe-integer number`);
  }
  if (v < 0n || v > RL_NEVER) throw new RangeError(`${name} is outside the uint64_t range`);
  return v;
}

function u32(v, name) {
  if (!Number.isInteger(v) || v < 0 || v > 0xFFFF_FFFF) throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  return v;
}

// Keys are passed as their bytes plus a NUL, so an embedded NUL ends the key in C exactly as in the native API.
function keyBytes(key) {
  if (typeof key === 'string') return { id: `s${key}`, bytes: ENCODER.encode(key) };
  if (key instanceof Uint8Array) return { id: `b${key.join(',')}`, bytes: key };
  throw new TypeError('key must be a string or Uint8Array');
}

function call(key, limit, now_ns) {
  const k = keyBytes(key);
  if (limit === null || typeof limit !== 'object') throw new TypeError('limit must be an object');
  return { k, capacity: u64(limit.capacity, 'limit.capacity'), refill_per_sec: u64(limit.refill_per_sec, 'limit.refill_per_sec'),
    now: u64(now_ns, 'now_ns') };
}

// ---------- Limiter ----------

export class Limiter {
  constructor(module, { shards = 0, hint = 0 } = {}) {
    this.module = module;
    this.handle = module._rl_new_inproc(u32(shards, 'shards'), u32(hint, 'hint')); // 0, 0 = library defaults
    if (!this.handle) throw new Error('rl_new_inproc failed');
    this.keys = new Map(); // key id -> malloc'd NUL-terminated bytes
    this.scratch = this.malloc(LIMIT_BYTES + STATE_BYTES); // limit @0, result @LIMIT_BYTES (malloc aligns to 8+)
  }

  get freed() { return !this.handle; }

  live() { if (!this.handle) throw new Error('limiter is freed'); }

  malloc(n) {
    const p = this.module._malloc(n);
    if (!p) { this.free(); throw new Error('WASM malloc failed'); }
    return p;
  }

  // A fresh view on every call: memory growth detaches the old buffer.
  view() { return new DataView(this.module.HEAPU8.buffer); }

  keyPtr({ id, bytes }) {
    let p = this.keys.get(id);
    if (p !== undefined) return p;
    p = this.malloc(bytes.length + 1);
    const heap = this.module.HEAPU8; // read after malloc, which may grow memory
    heap.set(bytes, p);
    heap[p + bytes.length] = 0;
    this.keys.set(id, p);
    return p;
  }

  // Checks every argument, then writes the key and the limit; returns the key pointer and the BigInt time.
  prepare(key, limit, now_ns) {
    this.live();
    const c = call(key, limit, now_ns), k = this.keyPtr(c.k);
    const dv = this.view(); // rewritten before every call: the callee may modify its by-pointer copy
    dv.setBigUint64(this.scratch, c.capacity, true);
    dv.setBigUint64(this.scratch + 8, c.refill_per_sec, true);
    return { k, now: c.now };
  }

  // rl_decision_t: allowed u8 @0, remaining @8, reset_ms @16.
  allow(key, limit, now_ns) {
    const { k, now } = this.prepare(key, limit, now_ns), r = this.scratch + LIMIT_BYTES;
    this.module._rl_allow_at(r, this.handle, k, this.scratch, now);
    const dv = this.view();
    return { allowed: dv.getUint8(r) === 1, remaining: dv.getBigUint64(r + 8, true), reset_ms: dv.getBigUint64(r + 16, true) };
  }

  // rl_bucket_state_t: tracked u8 @0, would_allow u8 @1, then six uint64 fields from @8.
  inspect(key, limit, now_ns) {
    const { k, now } = this.prepare(key, limit, now_ns), r = this.scratch + LIMIT_BYTES;
    this.module._rl_inspect_at(r, this.handle, k, this.scratch, now);
    const dv = this.view();
    return {
      tracked: dv.getUint8(r) === 1,
      would_allow: dv.getUint8(r + 1) === 1,
      stored_nanotokens: dv.getBigUint64(r + 8, true),
      stored_at_ns: dv.getBigUint64(r + 16, true),
      nanotokens: dv.getBigUint64(r + 24, true),
      tokens: dv.getBigUint64(r + 32, true),
      until_token_ns: dv.getBigUint64(r + 40, true),
      until_full_ns: dv.getBigUint64(r + 48, true),
    };
  }

  version() {
    this.live();
    const p = this.module._rl_version() >>> 0, heap = this.module.HEAPU8;
    return DECODER.decode(heap.subarray(p, heap.indexOf(0, p)));
  }

  free() {
    if (!this.handle) return;
    for (const p of this.keys.values()) this.module._free(p);
    this.keys.clear();
    if (this.scratch) this.module._free(this.scratch);
    this.scratch = 0;
    this.module._rl_free(this.handle);
    this.handle = 0;
  }
}

// ---------- Formatting (BigInt only: no float, no rounding) ----------

export function formatTokens(nanotokens) {
  return `${nanotokens / NANOTOKENS_PER_TOKEN}.${String(nanotokens % NANOTOKENS_PER_TOKEN).padStart(9, '0')}`;
}

export function formatWait(ns) {
  if (ns === RL_NEVER) return 'never';
  return `${ns / NS_PER_MS}.${String(ns % NS_PER_MS).padStart(6, '0')} ms`;
}
