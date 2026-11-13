// tools/ratelimit-trace.mjs: writes the seeded random parity traces for ratelimit-cpp/tests/parity from the demo's own
// traffic generator (scripts/demos/ratelimit-traffic.js, D-16), and runs a trace through the shipped WASM wrapper
// (scripts/demos/ratelimit-wasm.js) into N/A/I outcome lines. Node built-ins only. Exit 0 = ok, 1 = trace parse
// error, 2 = usage or I/O error.
// Usage: node tools/ratelimit-trace.mjs --preset <name> [--out <file>] | --run <trace.jsonl> | --list
// Trace (canonical JSONL, LF, final newline): {"op":"new","shards":S,"hint":H} once, first; then
// {"op":"allow"|"inspect","key":"<lowercase hex of the key bytes>","cap":C,"rate":R,"t":T}. Every value is an
// unsigned decimal without leading zeros (shards and hint 32-bit, the rest 64-bit). A line that does not
// re-serialize to itself byte for byte is rejected; the native runner upstream is just as strict.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadLimiterModule, Limiter } from '../scripts/demos/ratelimit-wasm.js';
import { Run, ALL_KEYS } from '../scripts/demos/ratelimit-traffic.js';

const MS = 1_000_000n, U64_MAX = 2n ** 64n - 1n, U32_MAX = 2n ** 32n - 1n, MAX_KEY_BYTES = 256;
const ENCODER = new TextEncoder();
const USAGE = '[ratelimit-trace] usage: node tools/ratelimit-trace.mjs --preset <name> [--out <file>] | --run <trace.jsonl> | --list';

// ---------- Presets ----------

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};
const client = (rate, pattern = 'steady') => ({ rate, pattern });
const DEMO_CLIENTS = [client(8), client(3), client(12), client(1)]; // the playground's default rates (ratelimit.js)
const DURATION_MS = 10_000, INSPECT_EVERY_MS = 250;
const withTiming = (presets) => Object.fromEntries(Object.entries(presets).map(([k, p]) =>
  [k, { ...p, durationMs: DURATION_MS, inspectEveryMs: INSPECT_EVERY_MS }]));

// Event times are virtual milliseconds, in order; each preset runs DURATION_MS and inspects every key every
// INSPECT_EVERY_MS. The traces committed upstream name the preset and seed they came from.
export const PRESETS = deepFreeze(withTiming({
  r1: {
    seed: 1,
    config: { capacity: 10, refill: 5, shared: false, clientCount: 2, clients: DEMO_CLIENTS },
    events: [
      { at: 2500, kind: 'burst', key: 'user:1', lane: 0, n: 15 },
      { at: 4000, kind: 'click', key: 'user:2', lane: 1 },
    ],
  },
  r2: {
    seed: 2,
    config: { capacity: 5, refill: 2, shared: true, clientCount: 4,
      clients: [client(8, 'random'), client(3, 'random'), client(12, 'random'), client(1, 'random')] },
    events: [
      { at: 1000, kind: 'click', key: 'global', lane: 0 },
      { at: 1001, kind: 'click', key: 'global', lane: 0 }, // quiet-denial adjacency
      { at: 6000, kind: 'burst', key: 'global', lane: 0, n: 10 },
    ],
  },
  r3: {
    seed: 3,
    config: { capacity: 1, refill: 0, shared: false, clientCount: 3,
      clients: [client(40, 'random'), client(40, 'random'), client(40, 'random'), client(1)] },
    events: [{ at: 500, kind: 'click', key: 'user:1', lane: 0 }],
  },
  r4: {
    seed: 4,
    config: { capacity: 20, refill: 50, shared: false, clientCount: 4,
      clients: [client(10), client(6, 'random'), client(15), client(4, 'random')] },
    events: [
      { at: 2000, kind: 'config', patch: { capacity: 3 } },
      { at: 4000, kind: 'config', patch: { refill: 0 } },
      { at: 5000, kind: 'config', patch: { refill: 7 } },
      { at: 6000, kind: 'config', patch: { clientCount: 1 } },
      { at: 7000, kind: 'config', patch: { shared: true } },
      { at: 8000, kind: 'config', patch: { clientCount: 3 } },
      { at: 8500, kind: 'config', patch: { client: 2, pattern: 'random' } },
    ],
  },
}));

// ---------- Recording ----------

// Wraps a Limiter and records every successful allow and inspect as { op, key (UTF-8 bytes), cap, rate, t }.
export function recordingLimiter(limiter) {
  const ops = [];
  const record = (op, key, limit, t) => ops.push({
    op, key: typeof key === 'string' ? ENCODER.encode(key) : Uint8Array.from(key),
    cap: BigInt(limit.capacity), rate: BigInt(limit.refill_per_sec), t: BigInt(t),
  });
  return {
    ops,
    allow(key, limit, t) { const d = limiter.allow(key, limit, t); record('allow', key, limit, t); return d; },
    inspect(key, limit, t) { const s = limiter.inspect(key, limit, t); record('inspect', key, limit, t); return s; },
    version: () => limiter.version(),
    free: () => limiter.free(),
    get freed() { return limiter.freed; },
  };
}

// Drives the preset's Run on the real module. At every inspection instant and every event time, in order, the run
// advances to that instant, applies the events due then, and inspects every key of ALL_KEYS at that instant.
export function exportPreset(name, module) {
  const p = Object.hasOwn(PRESETS, name) ? PRESETS[name] : null;
  if (!p) throw new RangeError(`unknown preset: ${name}`);
  let rec = null;
  const run = new Run({ seed: p.seed, config: p.config, createLimiter: () => (rec = recordingLimiter(new Limiter(module))) });
  try {
    const instants = new Set(p.events.map((e) => e.at));
    for (let ms = 0; ms <= p.durationMs; ms += p.inspectEveryMs) instants.add(ms);
    let next = 0;
    for (const ms of [...instants].sort((a, b) => a - b)) {
      const t = BigInt(ms) * MS;
      run.advanceTo(t);
      for (; next < p.events.length && p.events[next].at === ms; next++) {
        const { at, ...input } = p.events[next];
        run.apply(input);
      }
      for (const key of ALL_KEYS) run.inspect(key, t);
    }
    return toJsonl(rec.ops);
  } finally { run.free(); }
}

// ---------- Trace format ----------

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function opLine({ op, key, cap, rate, t }) {
  return `{"op":"${op}","key":"${hex(key)}","cap":${cap},"rate":${rate},"t":${t}}`;
}

export function toJsonl(ops, { shards = 0, hint = 0 } = {}) {
  return [`{"op":"new","shards":${shards},"hint":${hint}}`, ...ops.map(opLine)].map((l) => `${l}\n`).join('');
}

const DEC = '(0|[1-9][0-9]{0,19})';
const NEW_LINE = new RegExp(`^\\{"op":"new","shards":${DEC},"hint":${DEC}\\}$`);
const OP_LINE = new RegExp(`^\\{"op":"(allow|inspect)","key":"((?:[0-9a-f]{2}){0,${MAX_KEY_BYTES}})","cap":${DEC},"rate":${DEC},"t":${DEC}\\}$`);

function decimal(s, max, n, field) {
  const v = BigInt(s);
  if (v > max) throw new Error(`line ${n}: ${field} ${s} is out of range`);
  return v;
}

// Strict parser: returns { shards, hint, ops } or throws Error('line N: ...') naming the first bad line.
export function parseTrace(text) {
  if (typeof text !== 'string') throw new Error('line 1: trace must be text');
  const cr = text.indexOf('\r');
  if (cr !== -1) throw new Error(`line ${text.slice(0, cr).split('\n').length}: carriage return (CR) is not allowed`);
  const lines = text.split('\n');
  if (lines.at(-1) !== '') throw new Error(`line ${lines.length}: missing final newline`);
  lines.pop();
  if (!lines.length) throw new Error('line 1: the trace is empty; the first line must be the "new" op');
  let shards = 0, hint = 0;
  const ops = [];
  lines.forEach((line, i) => {
    const n = i + 1, m = (i === 0 ? NEW_LINE : OP_LINE).exec(line);
    if (!m) {
      const op = /^\{"op":"([^"]*)"/.exec(line)?.[1];
      if (i === 0) throw new Error(`line 1: the first line must be the canonical "new" op`);
      if (op === 'new') throw new Error(`line ${n}: "new" may appear only once, on the first line`);
      if (op !== undefined && op !== 'allow' && op !== 'inspect') throw new Error(`line ${n}: unknown op "${op}"`);
      throw new Error(`line ${n}: not a canonical allow or inspect op`);
    }
    let again;
    if (i === 0) {
      shards = Number(decimal(m[1], U32_MAX, n, 'shards')); hint = Number(decimal(m[2], U32_MAX, n, 'hint'));
      again = `{"op":"new","shards":${shards},"hint":${hint}}`;
    } else {
      const op = { op: m[1], key: Uint8Array.from(m[2].match(/../g) ?? [], (h) => parseInt(h, 16)),
        cap: decimal(m[3], U64_MAX, n, 'cap'), rate: decimal(m[4], U64_MAX, n, 'rate'), t: decimal(m[5], U64_MAX, n, 't') };
      ops.push(op);
      again = opLine(op);
    }
    if (again !== line) throw new Error(`line ${n}: does not re-serialize to itself`);
  });
  return { shards, hint, ops };
}

// ---------- Outcomes ----------

export const formatAllow = (d) => `A ${d.allowed ? 1 : 0} ${d.remaining} ${d.reset_ms}`;
export const formatInspect = (s) => `I ${s.tracked ? 1 : 0} ${s.would_allow ? 1 : 0} ${s.stored_nanotokens} ${s.stored_at_ns} `
  + `${s.nanotokens} ${s.tokens} ${s.until_token_ns} ${s.until_full_ns}`;

// One Limiter per trace; one outcome line per op, each ending in "\n".
export function runTrace(text, module) {
  const { shards, hint, ops } = parseTrace(text);
  const rl = new Limiter(module, { shards, hint });
  try {
    const out = [`N ${rl.version()}`];
    for (const o of ops) {
      const limit = { capacity: o.cap, refill_per_sec: o.rate };
      out.push(o.op === 'allow' ? formatAllow(rl.allow(o.key, limit, o.t)) : formatInspect(rl.inspect(o.key, limit, o.t)));
    }
    return out.map((l) => `${l}\n`).join('');
  } finally { rl.free(); }
}

// ---------- CLI ----------

// stdout carries only the trace or the outcome lines; every message goes to stderr.
const say = (line) => process.stderr.write(`${line}\n`);

async function main() {
  let opt;
  try {
    ({ values: opt } = parseArgs({ options: { preset: { type: 'string' }, out: { type: 'string' }, run: { type: 'string' },
      list: { type: 'boolean' } } }));
  } catch (err) {
    say(`[ratelimit-trace] ${err.message}`); say(USAGE);
    return 2;
  }
  const modes = ['preset', 'run', 'list'].filter((k) => opt[k] !== undefined);
  if (modes.length !== 1 || (opt.out !== undefined && !opt.preset)) { say(USAGE); return 2; }
  if (opt.list) {
    process.stdout.write(Object.entries(PRESETS).map(([k, p]) => `${k} seed ${p.seed}\n`).join(''));
    return 0;
  }
  if (opt.preset !== undefined && !Object.hasOwn(PRESETS, opt.preset)) {
    say(`[ratelimit-trace] unknown preset "${opt.preset}"; try --list`);
    return 2;
  }
  let text;
  if (opt.run !== undefined) {
    try { text = await readFile(opt.run, 'utf8'); } catch (err) { say(`[ratelimit-trace] cannot read ${opt.run}: ${err.message}`); return 2; }
  }
  const module = await loadLimiterModule();
  if (opt.preset !== undefined) {
    const jsonl = exportPreset(opt.preset, module);
    if (opt.out === undefined) { process.stdout.write(jsonl); return 0; }
    try { await writeFile(opt.out, jsonl); } catch (err) { say(`[ratelimit-trace] cannot write ${opt.out}: ${err.message}`); return 2; }
    return 0;
  }
  let outcome;
  try { outcome = runTrace(text, module); } catch (err) {
    if (!/^line \d+: /.test(err.message)) throw err;
    say(`[ratelimit-trace] ${opt.run}: ${err.message}`);
    return 1;
  }
  process.stdout.write(outcome);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main().catch((err) => { say(`[ratelimit-trace] unexpected error: ${err.message}`); return 2; });
}
