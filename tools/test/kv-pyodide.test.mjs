// The Node leg of the KV Pyodide loader and session (D-01..D-03): the runtime comes from CDN bytes verified against
// scripts/demos/kv-py/kv.manifest.json, and the vendored server.py and observability.py run the real session protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KvLoadError, WORK_DIR, loadKv } from '../../scripts/demos/kv-pyodide.js';
import { createWorkerHandler } from '../../scripts/demos/kv-worker.js';
import { loadKvNode } from '../pyodide-cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const PY_DIR = path.join(ROOT, 'scripts', 'demos', 'kv-py');
const manifest = JSON.parse(readFileSync(path.join(PY_DIR, 'kv.manifest.json'), 'utf8'));
const iqg = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'demos', 'iqg-py', 'iqg.manifest.json'), 'utf8'));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const byteSorted = (keys) => [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

// Every file under dir as a '/'-separated path relative to it.
function walk(dir, rel = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

const BROWSER_TYPES = ['store.load', 'cmd.parse', 'lock.wait_start', 'lock.acquired', 'lock.released', 'store.lookup',
  'store.mutation', 'store.save_start', 'store.save_end'];
const FORBIDDEN = ['runPython', 'setup_server', '.start(', 'InspectionServer', 'JsonlSink', 'add_listener', 'connection_opened',
  'performance.now', 'Date.now'];
const send = (text) => new TextEncoder().encode(text);
const events = (snapshot) => [...snapshot.events, ...snapshot.inspect_events].map((t) => JSON.parse(t));

const kv = await loadKvNode(manifest, { root: ROOT });
const { session, pyodide } = kv;

test('the vendored sources are exactly the manifest\'s, listed in byte order, matching bytes and sha256, with LF and no BOM', () => {
  assert.equal(manifest.sources.dir, 'scripts/demos/kv-py');
  assert.deepEqual(Object.keys(manifest.sources.files), ['observability.py', 'server.py']);
  for (const files of [manifest.sources.files, manifest.pyodide.files]) {
    const keys = Object.keys(files);
    assert.deepEqual(keys, byteSorted(keys), 'manifest entries are sorted');
  }
  const onDisk = walk(PY_DIR).filter((f) => f !== 'kv.manifest.json' && !f.startsWith('recordings/'));
  assert.deepEqual(byteSorted(onDisk), byteSorted(Object.keys(manifest.sources.files)), 'files on disk equal the files listed');
  for (const [rel, entry] of Object.entries(manifest.sources.files)) {
    const b = readFileSync(path.join(PY_DIR, ...rel.split('/')));
    assert.equal(b.length, entry.bytes, `${rel}: bytes`);
    assert.equal(sha256(b), entry.sha256, `${rel}: sha256`);
    assert.equal(b.indexOf(0x0d), -1, `${rel}: carriage return`);
    assert.ok(!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), `${rel}: UTF-8 BOM`);
  }
});

test('the runtime is the IQG build\'s: the same five core files, version, CDN base and Python', () => {
  assert.deepEqual(Object.keys(manifest.pyodide.files), ['pyodide-lock.json', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'pyodide.mjs',
    'python_stdlib.zip']);
  for (const [name, entry] of Object.entries(manifest.pyodide.files)) assert.deepEqual(entry, iqg.pyodide.files[name], name);
  for (const k of ['version', 'cdn_base', 'python']) assert.equal(manifest.pyodide[k], iqg.pyodide[k], k);
  assert.deepEqual(manifest.packages, []);
});

test('the loader rejects a lock file or a vendored source whose bytes differ from the manifest, naming it', async () => {
  const lock = new TextEncoder().encode('{"tampered": true}');
  let imported = false;
  const bad = await loadKv({ manifest, pyodideUrl: 'data:text/javascript,globalThis.x=1', indexURL: '/', readCdn: async () => lock,
    readVendored: async () => { imported = true; return lock; } }).catch((e) => e);
  assert.ok(bad instanceof KvLoadError, String(bad));
  assert.equal(bad.kind, 'integrity');
  assert.equal(bad.what, 'pyodide-lock.json');
  assert.equal(imported, false, 'nothing vendored is read before the runtime is verified');
  const real = await loadKvNode({ ...manifest, sources: { ...manifest.sources, files: { 'server.py': { ...manifest.sources.files['server.py'],
    sha256: '0'.repeat(64) } } } }, { root: ROOT }).catch((e) => e);
  assert.ok(real instanceof KvLoadError, String(real));
  assert.deepEqual([real.kind, real.what], ['integrity', 'server.py']);
});

test('boot, send, restart and reset on the committed tree: the engine\'s real events, replies, diagnostics and store.txt', async () => {
  if (pyodide.FS.analyzePath(`${WORK_DIR}/store.txt`).exists) pyodide.FS.unlink(`${WORK_DIR}/store.txt`);
  const boot = await session.boot();
  const bootEvents = events(boot);
  const loads = bootEvents.filter((e) => e.type === 'store.load');
  assert.equal(loads.length, 1, 'boot emits one store.load');
  assert.equal(loads[0].data.exists, false);
  assert.equal(boot.store_txt, null);

  const set = await session.send(send('SET a 1'));
  assert.equal(set.keep, true);
  assert.deepEqual(set.replies, ["Added key 'a' with value '1'\n"]);
  assert.equal(set.store_txt, 'a\t1\n');
  for (const e of [...bootEvents, ...events(set)]) assert.ok(BROWSER_TYPES.includes(e.type), `event type ${e.type} is not a browser type`);

  const d = JSON.parse(set.diagnostics);
  assert.equal(d.trace.internal_errors, 0);
  assert.deepEqual(d.connections, { current: 0, total: 0 });
  assert.equal(d.threads.process_total, 1);
  assert.equal(d.server.running, false);

  const restart = await session.restart();
  const reload = events(restart).find((e) => e.type === 'store.load');
  assert.equal(reload.data.exists, true);
  assert.equal(reload.data.keys, 1);
  assert.equal(restart.store_txt, 'a\t1\n');

  const reset = await session.reset();
  const cleared = events(reset).find((e) => e.type === 'store.load');
  assert.equal(cleared.data.exists, false);
  assert.equal(reset.store_txt, null);
});

test('a command of 0 or 1025 bytes is refused before Python, and a quit ends the session until newSession', async () => {
  await session.reset();
  for (const n of [0, 1025]) {
    await assert.rejects(async () => session.send(new Uint8Array(n).fill(65)), RangeError, `${n} bytes`);
  }
  assert.throws(() => session.send('SET a 1'), RangeError, 'a string is not bytes');
  const quit = await session.send(send('QUIT'));
  assert.equal(quit.keep, false);
  assert.throws(() => session.send(send('PRINT')), /session ended/);
  await session.newSession();
  const after = await session.send(send('PRINT'));
  assert.equal(after.keep, true);
});

test('kv-pyodide.js contains none of the forbidden calls: no Python source from input, no server, no listener, no clock', () => {
  const src = readFileSync(path.join(ROOT, 'scripts', 'demos', 'kv-pyodide.js'), 'utf8');
  for (const word of FORBIDDEN) assert.ok(!src.includes(word), `kv-pyodide.js contains ${word}`);
});

// ---------- Worker protocol (05-09): the handler kv-worker.js wires to self.onmessage, over the real session ----------

// Each message goes through the real handler; load hands it the already-loaded runtime. Replies are what the page sees.
function harness(load = async () => kv, report = () => {}) {
  const posted = [];
  const handle = createWorkerHandler({ load, post: (m) => posted.push(m), report });
  let id = 0;
  const ask = async (msg) => { const n = ++id; posted.length = 0; await handle({ id: n, ...msg }); return posted.filter((m) => m.id === n); };
  return { ask, posted };
}
const last = (replies) => replies[replies.length - 1];

test('worker load posts progress then done with the boot snapshot, whose first event is store.load', async () => {
  const { ask } = harness(async (m, url, onProgress) => { onProgress({ stage: 'runtime', done: true }); return kv; });
  const replies = await ask({ op: 'load', manifest, manifestUrl: 'x' });
  assert.deepEqual(replies[0], { id: 1, progress: { stage: 'runtime', done: true } });
  const done = last(replies);
  assert.equal(done.done, true);
  assert.equal(done.op, 'boot');
  assert.equal(JSON.parse(done.events[0]).type, 'store.load');
});

test('worker send of "SET a 1" posts done with keep true and the real reply; 0 bytes posts fail input', async () => {
  const { ask } = harness();
  await ask({ op: 'load', manifest, manifestUrl: 'x' });
  await ask({ op: 'reset' });
  const set = last(await ask({ op: 'send', bytes: send('SET a 1').buffer }));
  assert.equal(set.done, true);
  assert.equal(set.keep, true);
  assert.deepEqual(set.replies, ["Added key 'a' with value '1'\n"]);
  assert.deepEqual(last(await ask({ op: 'send', bytes: new ArrayBuffer(0) })), { id: 4, fail: 'input' });
  assert.deepEqual(last(await ask({ op: 'send', bytes: new Uint8Array(1025).fill(65).buffer })), { id: 5, fail: 'input' });
});

test('worker whitespace-only input is sent unchanged and the server answers it', async () => {
  const { ask } = harness();
  await ask({ op: 'load', manifest, manifestUrl: 'x' });
  const m = last(await ask({ op: 'send', bytes: send('   ').buffer }));
  assert.equal(m.done, true);
  assert.deepEqual(m.replies, ['ERROR: Empty command\n']);
});

test('worker restart reloads the saved store: store.load says exists true', async () => {
  const { ask } = harness();
  await ask({ op: 'load', manifest, manifestUrl: 'x' });
  await ask({ op: 'reset' });
  await ask({ op: 'send', bytes: send('SET a 1').buffer });
  const m = last(await ask({ op: 'restart' }));
  assert.equal(m.done, true);
  assert.equal(m.op, 'restart');
  assert.equal(events(m).find((e) => e.type === 'store.load').data.exists, true);
  const reset = last(await ask({ op: 'reset' }));
  assert.equal(events(reset).find((e) => e.type === 'store.load').data.exists, false);
});

test('worker quit ends the session (keep false, no reply) and new_session starts the next one on the same server', async () => {
  const reported = [];
  const { ask } = harness(async () => kv, (e) => reported.push(e));
  await ask({ op: 'load', manifest, manifestUrl: 'x' });
  await ask({ op: 'reset' });
  await ask({ op: 'send', bytes: send('SET k v').buffer });
  const quit = last(await ask({ op: 'send', bytes: send('quit').buffer }));
  assert.equal(quit.done, true);
  assert.equal(quit.keep, false);
  assert.deepEqual(quit.replies, []);
  assert.equal(last(await ask({ op: 'send', bytes: send('PRINT').buffer })).fail, 'fatal', 'a send after quit is refused by the engine');
  assert.equal(reported.length, 1);
  const fresh = last(await ask({ op: 'new_session' }));
  assert.equal(fresh.done, true);
  assert.equal(fresh.op, 'new_session');
  const print = last(await ask({ op: 'send', bytes: send('PRINT').buffer }));
  assert.equal(print.keep, true);
  assert.equal(print.replies.join(''), '[KEY]: k\t[VALUE]: v\n', 'the store survives the quit; the next session reads it');
});

test('worker load failures: an integrity error and a load error post their kind, anything else posts load', async () => {
  const reported = [];
  for (const [err, fail] of [[new KvLoadError('integrity', 'x'), 'integrity'], [new KvLoadError('load', 'y'), 'load'], [new Error('boom'), 'load']]) {
    const { ask } = harness(async () => { throw err; }, (e) => reported.push(e));
    assert.deepEqual(last(await ask({ op: 'load', manifest, manifestUrl: 'x' })), { id: 1, fail });
  }
  assert.equal(reported.length, 3);
});

test('worker: a session that throws a plain Error posts fatal and reports it; an op before load and an unknown op are fatal', async () => {
  const reported = [];
  const boom = { session: { boot: () => ({ op: 'boot' }), send: () => { throw new Error('boom'); } } };
  const { ask } = harness(async () => boom, (e) => reported.push(e));
  assert.deepEqual(last(await ask({ op: 'send', bytes: send('a').buffer })), { id: 1, fail: 'fatal' }, 'send before load');
  await ask({ op: 'load', manifest, manifestUrl: 'x' });
  assert.deepEqual(last(await ask({ op: 'send', bytes: send('a').buffer })), { id: 3, fail: 'fatal' });
  assert.deepEqual(last(await ask({ op: 'nope' })), { id: 4, fail: 'fatal' });
  assert.equal(reported.length, 3);
});

test('the hand-ported engine is gone: no kv-core module, nothing under scripts/ names it, and kv.js has no simulation left', () => {
  assert.equal(existsSync(path.join(ROOT, 'scripts', 'demos', 'kv-core.js')), false);
  const files = walk(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js'));
  for (const f of files) assert.ok(!readFileSync(path.join(ROOT, 'scripts', ...f.split('/')), 'utf8').includes('kv-core'), `${f} names kv-core`);
  const MARKERS = ['kv-core', 'pyDecode', 'const D = ', 'LANE', 'data-wires', 'data-lanes', '0.0.0.0:3490', 'listen(10)', 'data-speed',
    'data-scenario="three"', 'requestAnimationFrame', 'performance.now', 'Date.now'];
  for (const name of ['kv.js', 'kv-worker.js']) {
    const src = readFileSync(path.join(ROOT, 'scripts', 'demos', name), 'utf8');
    for (const marker of MARKERS) assert.ok(!src.includes(marker), `${name} contains ${marker}`);
    for (const word of ['runPython', 'eval(', 'new Function']) assert.ok(!src.includes(word), `${name} contains ${word}`);
  }
});
