// tools/kv-parity.mjs: compares the Pyodide session's transcript for key-value-storage with the native goldens (D-04).
// Goldens are written only by upstream tests/parity/run_native.py; this file never writes one. --check runs every
// upstream script through scripts/demos/kv-pyodide.js with the upstream working tree's sources and reports differences.
// Exit 0 = equal, 1 = a difference or a source/script/exclusion mismatch, 2 = usage or I/O error.
// Usage: node tools/kv-parity.mjs --check --upstream <key-value-storage dir> [--only <script>]
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MAX_COMMAND_BYTES, WORK_DIR } from '../scripts/demos/kv-pyodide.js';
import { loadKvNode } from './pyodide-cache.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IQG_MANIFEST = path.join(ROOT, 'scripts', 'demos', 'iqg-py', 'iqg.manifest.json');
const CORE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const USAGE = '[kv-parity] usage: node tools/kv-parity.mjs --check --upstream <key-value-storage dir> [--only <script>]';
const say = (line) => process.stderr.write(`${line}\n`);
const out = (line) => process.stdout.write(`${line}\n`);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const lf = (b) => Buffer.from(b.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'); // git's view of a text file

// ---------- Mask ----------

// The exact lists of upstream tests/parity/run_native.py (each entry has a written reason there and in the README).
// The CLI exits 1 when golden/meta.json lists anything else, so both sides mask the same fields.
export const EXCLUDED_KEYS = Object.freeze(['duration_ns', 'hold_ns', 'hold_ns_max', 'hold_ns_mean', 'hold_ns_total',
  'latency_ns', 'mono_ns', 'mtime_ns', 'owner_thread_id', 'pid', 'save_ns_max', 'save_ns_total', 'send_ns', 'thread_id',
  'ts_ns', 'wait_ns', 'wait_ns_max', 'wait_ns_mean', 'wait_ns_total']);
export const EXCLUDED_PATHS = Object.freeze(['state.store.memory_bytes.value']);

// The Python type name of a JSON value. JSON cannot tell 1 from 1.0, so a whole number is an int; every masked field
// is a Python int on both runtimes.
const typeName = (v) => (Array.isArray(v) ? 'list' : typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'bool'
  : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : 'dict');

// A copy where a non-null value under an excluded key (anywhere) or at an excluded path (from the record root) is
// "<x:TYPE>". Null stays null, so type and null-ness are still compared; only the value is not.
export function maskRecord(record) {
  const walk = (value, trail) => {
    if (Array.isArray(value)) return value.map((v) => walk(v, trail));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      const here = [...trail, key];
      const masked = v !== null && (EXCLUDED_KEYS.includes(key) || EXCLUDED_PATHS.includes(here.join('.')));
      return [key, masked ? `<x:${typeName(v)}>` : walk(v, here)];
    }));
  };
  return walk(structuredClone(record), []);
}

// ---------- Transcript ----------

// A session snapshot (texts Python produced) in the golden's record shape; epoch is the demo's own counter.
export function parseRecord(snapshot) {
  const { op, keep, replies, events, state, inspect_events, diagnostics, store_txt, stdout } = snapshot;
  return { op, ...(keep === undefined ? {} : { keep, replies }), events: events.map((t) => JSON.parse(t)),
    state: JSON.parse(state), inspect_events: inspect_events.map((t) => JSON.parse(t)), diagnostics: JSON.parse(diagnostics),
    store_txt, stdout };
}

// One script through a session, step for step as run_native.py does: the boot record first, then one per step, masked.
export const runScript = async (session, script) => {
  const steps = [maskRecord(parseRecord(await session.boot()))];
  for (const { op, text } of script.steps) {
    let snapshot, extra = {};
    if (op === 'send') { snapshot = await session.send(new TextEncoder().encode(text)); extra = { text }; }
    else if (op === 'restart') snapshot = await session.restart();
    else if (op === 'reset') snapshot = await session.reset();
    else if (op === 'new_session') snapshot = await session.newSession();
    else throw new Error(`unknown step op: ${op}`);
    steps.push(maskRecord({ ...parseRecord(snapshot), ...extra }));
  }
  return { script: script.name, steps };
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every difference between two masked transcripts, exact: [{ path, actual, expected }], paths like
// steps[3].events[2].data.key. A missing or extra array element or key is a difference at its own path.
export function compareTranscript(actual, golden) {
  const diffs = [];
  const walk = (a, e, at) => {
    if (Array.isArray(a) && Array.isArray(e)) {
      for (let i = 0; i < Math.max(a.length, e.length); i++) walk(a[i], e[i], `${at}[${i}]`);
    } else if (isObject(a) && isObject(e)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(e)])) walk(a[k], e[k], at ? `${at}.${k}` : k);
    } else if (a !== e) {
      diffs.push({ path: at, actual: a, expected: e });
    }
  };
  walk(actual, golden, '');
  return diffs;
}

// ---------- CLI ----------

class Fail extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

const readJson = async (file) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (err) { throw new Fail(`${file}: ${err.message}`, 2); }
};

// The goldens only mean something for the files they were made from: every source and script must hash as meta says.
async function verifiedUpstream(dir, meta) {
  const parity = path.join(dir, 'tests', 'parity');
  const sources = {};
  for (const [name, hash] of Object.entries(meta.sources)) {
    const bytes = lf(await readFile(path.join(dir, name)));
    if (sha256(bytes) !== hash) throw new Fail(`${name} differs from the file the goldens were made from (golden/meta.json sha256)`);
    sources[name] = bytes;
  }
  const scripts = {};
  for (const [rel, hash] of Object.entries(meta.scripts)) {
    const bytes = lf(await readFile(path.join(parity, rel)));
    if (sha256(bytes) !== hash) throw new Fail(`${rel} differs from the file the goldens were made from (golden/meta.json sha256)`);
    scripts[path.basename(rel, '.json')] = JSON.parse(bytes.toString('utf8'));
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(meta.excluded_keys, [...EXCLUDED_KEYS].sort()) || !same(meta.excluded_paths, EXCLUDED_PATHS)) {
    throw new Fail('golden/meta.json excluded_keys or excluded_paths differ from the lists in tools/kv-parity.mjs');
  }
  return { sources, scripts };
}

// The manifest the vendored files will get at the repin (05-07), built in memory from the unmerged sources.
function memoryManifest(iqg, sources) {
  const entry = (b) => ({ bytes: b.length, sha256: sha256(b) });
  return { name: 'kv', pyodide: { version: iqg.pyodide.version, cdn_base: iqg.pyodide.cdn_base, python: iqg.pyodide.python,
    files: Object.fromEntries(CORE_FILES.map((n) => [n, iqg.pyodide.files[n]])) }, packages: [],
  sources: { dir: 'scripts/demos/kv-py', files: Object.fromEntries(Object.entries(sources).map(([n, b]) => [n, entry(b)])) } };
}

// D-10: a command of 0 or more than 1024 bytes never reaches Python; exactly 1024 bytes does.
async function inputRule(session) {
  await session.reset();
  const rejects = async (n) => {
    try { await session.send(new Uint8Array(n).fill(65)); } catch (err) { return err instanceof RangeError; }
    return false;
  };
  const head = new TextEncoder().encode('SET k ');
  const max = new Uint8Array(MAX_COMMAND_BYTES).fill(120);
  max.set(head);
  const reply = await session.send(max);
  return await rejects(0) && await rejects(MAX_COMMAND_BYTES + 1) && reply.keep === true && reply.replies.length === 1;
}

async function main() {
  let opt;
  try {
    ({ values: opt } = parseArgs({ options: { check: { type: 'boolean' }, upstream: { type: 'string' }, only: { type: 'string' } } }));
  } catch (err) {
    say(`[kv-parity] ${err.message}`); say(USAGE);
    return 2;
  }
  if (!opt.check || !opt.upstream) { say(USAGE); return 2; }
  const dir = path.resolve(opt.upstream), goldenDir = path.join(dir, 'tests', 'parity', 'golden');
  const meta = await readJson(path.join(goldenDir, 'meta.json'));
  const { sources, scripts } = await verifiedUpstream(dir, meta);
  const names = Object.keys(scripts).sort().filter((n) => opt.only === undefined || n === opt.only);
  if (!names.length) { say(`[kv-parity] no script named "${opt.only}"`); return 2; }

  const t0 = Date.now(), tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kv-parity-'));
  try {
    for (const [name, bytes] of Object.entries(sources)) {
      const file = path.join(tempRoot, 'scripts', 'demos', 'kv-py', name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    const { pyodide, session } = await loadKvNode(memoryManifest(await readJson(IQG_MANIFEST), sources), { root: tempRoot });
    let differences = 0;
    const types = new Set();
    for (const name of names) {
      // Each script starts in an empty working directory, as run_native.py gives it.
      if (pyodide.FS.analyzePath(`${WORK_DIR}/store.txt`).exists) pyodide.FS.unlink(`${WORK_DIR}/store.txt`);
      const actual = await runScript(session, scripts[name]), golden = await readJson(path.join(goldenDir, `${name}.json`));
      for (const rec of actual.steps) for (const e of [...rec.events, ...rec.inspect_events]) types.add(e.type);
      for (const d of compareTranscript(actual, golden)) {
        differences += 1;
        out(`KV_PARITY_DIFF ${name} ${d.path}: pyodide ${JSON.stringify(d.actual)} native ${JSON.stringify(d.expected)}`);
      }
    }
    if (opt.only === undefined) {
      if (await inputRule(session)) out('KV_INPUT_RULE_OK');
      else { out('KV_INPUT_RULE_DIFF: the 0-byte, 1025-byte or 1024-byte send did not behave as the input rule says'); differences += 1; }
    }
    say(`[kv-parity] ${names.length} script(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s; event types: ${[...types].sort().join(', ')}`);
    if (differences) return 1;
    out(`KV_PARITY_OK ${names.length} scripts`);
    return 0;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main().catch((err) => {
    if (err instanceof Fail) { say(`[kv-parity] ${err.message}`); return err.code; }
    say(`[kv-parity] unexpected error: ${err.stack ?? err.message}`);
    return 2;
  });
  process.exit(process.exitCode); // the Pyodide runtime keeps the event loop alive
}
