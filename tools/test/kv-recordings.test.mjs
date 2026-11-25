// Semantic checks of the vendored native recordings (scripts/demos/kv-py/recordings): that each file is what the page says it
// is and shows the behavior its scenario claims. Byte identity with upstream is the claims checker's job (05-08), not this test's.
// Mirrors the check_* functions of bench/record_scenarios.py at the pinned commit, so a swapped or fabricated file fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonl } from '../../scripts/demos/kv-timeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'demos', 'kv-py', 'kv.manifest.json'), 'utf8'));
const DIR = path.join(ROOT, ...MANIFEST.recordings.dir.split('/'));
const NAMES = Object.keys(MANIFEST.recordings.scenarios);
const read = (name, rel) => readFileSync(path.join(DIR, name, ...rel.split('/')), 'utf8');
const meta = (name) => JSON.parse(read(name, 'meta.json'));
const events = (name, rel) => parseJsonl(read(name, rel), `${name}/${rel}`).map((l) => l.event);
const of = (evs, type) => evs.filter((e) => e.type === type);
const traceFiles = (name) => Object.keys(MANIFEST.recordings.scenarios[name].files).filter((r) => /^raw\/trace.*\.jsonl$/.test(r));
const clientFiles = (name) => Object.keys(MANIFEST.recordings.scenarios[name].files).filter((r) => /^raw\/clients.*\.jsonl$/.test(r));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ABSOLUTE = /^(\/|~|[A-Za-z]:[\\/]|\\\\)/;

test('the manifest lists the four scenarios the page plays', () => {
  assert.deepEqual([...NAMES].sort(), ['backlog', 'contention', 'framing', 'shutdown']);
});

test('every trace parses line by line and its seq runs 1..N with no gap, already in file order', () => {
  for (const name of NAMES) {
    assert.ok(traceFiles(name).length >= 1, `${name} has a trace`);
    for (const rel of traceFiles(name)) {
      const evs = events(name, rel);
      assert.ok(evs.length > 0, `${name}/${rel} has events`);
      evs.forEach((e, i) => assert.equal(e.seq, i + 1, `${name}/${rel} line ${i + 1} has seq ${e.seq}`));
      for (const e of evs) assert.equal(e.v, 1, `${name}/${rel} seq ${e.seq} is schema version 1`);
    }
    for (const rel of clientFiles(name)) {
      const log = events(name, rel);
      assert.ok(log.length > 0);
      for (const r of log) assert.ok(typeof r.client === 'string' && typeof r.op === 'string', `${name}/${rel} rows carry client and op`);
    }
  }
});

test('every recording meta names its source commit, environment, date and interpreter, and holds no absolute path', () => {
  for (const name of NAMES) {
    const m = meta(name), entry = MANIFEST.recordings.scenarios[name];
    assert.equal(m.schema, 'kv-recording/1', name);
    assert.equal(m.scenario, name);
    assert.equal(m.source.sha, entry.source_sha, `${name}: meta.source.sha equals the manifest source_sha`);
    assert.match(m.source.sha, /^[0-9a-f]{40}$/);
    assert.equal(m.source.dirty, false, `${name} was captured from a clean tree`);
    assert.equal(m.environment_id, MANIFEST.native.environment, `${name}: environment_id equals native.environment`);
    assert.match(m.date_utc, ISO, `${name}: date_utc is an ISO date-time`);
    assert.ok(Number.isFinite(Date.parse(m.date_utc)));
    assert.equal(m.toolchain.implementation, 'cpython');
    assert.equal(m.toolchain.version, MANIFEST.native.python, `${name}: the interpreter equals native.python`);
    assert.ok(typeof m.os.name === 'string' && m.os.name.length > 0);
    assert.ok(Array.isArray(m.command) && m.command.length > 0);
    for (const part of m.command) assert.doesNotMatch(String(part), ABSOLUTE, `${name}: command element ${part} is repo-relative`);
    assert.ok(Array.isArray(m.notes), `${name}: notes are a list the page shows`);
  }
});

test('no recorded file contains a home, temp or Windows drive path', () => {
  for (const name of NAMES) {
    for (const rel of Object.keys(MANIFEST.recordings.scenarios[name].files)) {
      const text = read(name, rel);
      assert.doesNotMatch(text, /\/home\/|\/tmp\/|[A-Za-z]:[\\/]/, `${name}/${rel} holds an absolute path`);
    }
  }
});

test("each meta.raw_files entry equals the file on disk, so the notes the page shows describe these exact files", () => {
  for (const name of NAMES) {
    const m = meta(name);
    assert.deepEqual(m.raw_files.map((f) => f.path).sort(), Object.keys(MANIFEST.recordings.scenarios[name].files).filter((r) => r !== 'meta.json').sort());
    for (const f of m.raw_files) {
      const bytes = readFileSync(path.join(DIR, name, ...f.path.split('/')));
      assert.equal(bytes.length, f.bytes, `${name}/${f.path} bytes`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), f.sha256, `${name}/${f.path} sha256`);
    }
  }
});

test('contention: some acquisition really waited behind another thread, and each connection had its own handler thread', () => {
  const evs = events('contention', 'raw/trace.jsonl');
  const waited = of(evs, 'lock.acquired').filter((e) => e.data.contended === true && e.data.wait_ns > 0);
  assert.ok(waited.length > 0, 'a lock.acquired with contended true and wait_ns above 0');
  const threads = new Set(of(evs, 'conn.open').map((e) => e.thread));
  assert.equal(threads.size, 4);
  for (const t of threads) assert.match(t, /^client 127\.0\.0\.1:\d+$/);
  assert.equal(of(evs, 'server.stop').length, 1);
  assert.equal(evs.at(-1).type, 'server.stop');
});

test('shutdown: run A ends every open connection from the server and stops; run B reloads the store the first run left', () => {
  const a = events('shutdown', 'raw/trace-run-a.jsonl'), b = events('shutdown', 'raw/trace-run-b.jsonl');
  const opened = of(a, 'conn.open');
  assert.ok(opened.length >= 2);
  const bySrv = of(a, 'conn.disconnect').filter((e) => e.data.by === 'server');
  assert.equal(bySrv.length, opened.length, 'every open connection was disconnected by the server');
  assert.equal(of(a, 'conn.close').filter((e) => e.data.reason === 'shutdown').length, opened.length);
  assert.equal(of(a, 'server.stop').length, 1);
  assert.ok(of(b, 'store.load').some((e) => e.data.exists === true), 'run B: store.load with exists true on reload');
  assert.equal(of(a, 'store.load')[0].data.exists, false, 'run A started from no store.txt');
});

test('framing: the oversize send is read in more than one recv (the first exactly 1024 bytes), and a long PRINT reply reaches the client in chunks', () => {
  const evs = events('framing', 'raw/trace.jsonl'), log = events('framing', 'raw/clients.jsonl');
  const over = log.find((r) => r.op === 'send' && r.bytes > 1024);
  assert.ok(over, 'the client log has a send of more than 1024 bytes');
  const recvs = of(evs, 'conn.recv');
  assert.equal(recvs[0].data.bytes, 1024, 'the first read is exactly 1024 bytes');
  assert.equal(recvs[1].conn, recvs[0].conn, 'the next read is on the same connection');
  assert.equal(recvs[0].data.bytes + recvs[1].data.bytes, over.bytes, 'the first two reads add up to the oversize send');
  assert.ok(of(evs, 'conn.send').some((e) => e.data.bytes > 1024), 'a reply longer than one client read');
  const at = log.findIndex((r) => r.op === 'send' && r.text.trim().toUpperCase() === 'PRINT');
  assert.ok(at >= 0, 'the client log has a PRINT send');
  const chunks = log.slice(at + 1).filter((r) => r.op === 'recv' && !r.timed_out && r.bytes);
  assert.ok(chunks.length >= 2 && chunks[0].bytes === 1024, 'the PRINT reply came in more than one read, the first 1024 bytes');
});

test('framing: the merged-sends note is true of the probe files, whichever way it went', () => {
  const m = meta('framing'), probe = m.workload.merged_sends_probe;
  const sum = probe.payloads.reduce((n, p) => n + Buffer.byteLength(p), 0);
  const merged = of(events('framing', 'raw/trace-merged.jsonl'), 'conn.recv').some((e) => e.data.bytes === sum);
  assert.equal(probe.observed, merged, 'observed matches whether one recv held both payloads');
  assert.ok(m.notes.some((n) => /merged-sends probe/.test(n) && /never retried/.test(n)), 'the note says it ran once');
});

test('backlog: with one slot, the second client is accepted only after the first connection closes', () => {
  const evs = events('backlog', 'raw/trace.jsonl'), log = events('backlog', 'raw/clients.jsonl');
  const [first, second] = of(evs, 'conn.accept');
  assert.ok(first && second, 'two conn.accept events');
  const closed = of(evs, 'conn.close').find((e) => e.conn === first.conn);
  assert.ok(closed, 'the first connection has a conn.close');
  assert.ok(second.seq > closed.seq, `the second accept (seq ${second.seq}) comes after the first close (seq ${closed.seq})`);
  const firstRead = log.find((r) => r.client === 'backlog-2' && r.op === 'recv');
  assert.equal(firstRead.timed_out, true, "client 2's first read timed out while client 1 held the slot");
});

test('the page plays the scenarios in the display order, each from files the manifest lists', () => {
  const src = readFileSync(path.join(ROOT, 'scripts', 'demos', 'kv.js'), 'utf8');
  const order = /const REC_ORDER = \[([^\]]*)\]/.exec(src)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(order, ['contention', 'shutdown', 'framing', 'backlog']);
  const re = /^ {2}(\w+): \{ trace: \[([^\]]*)\](?:, clients: '([^']*)')? \},$/gm;
  const seen = {};
  for (const [, name, traces, clients] of src.matchAll(re)) seen[name] = { trace: traces.split(',').map((s) => s.trim().replace(/'/g, '')), clients };
  assert.deepEqual(Object.keys(seen).sort(), [...order].sort());
  for (const name of order) {
    const files = MANIFEST.recordings.scenarios[name].files;
    for (const rel of [...seen[name].trace, ...(seen[name].clients ? [seen[name].clients] : [])]) assert.ok(files[rel], `${name}: the manifest lists ${rel}`);
  }
  assert.deepEqual(seen.shutdown.trace, ['raw/trace-run-a.jsonl', 'raw/trace-run-b.jsonl'], 'run A then run B');
  assert.ok(seen.framing.clients && seen.backlog.clients, 'framing and backlog also show the client-side log');
});
