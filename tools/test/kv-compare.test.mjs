// Pure tests of the native-vs-Pyodide transcript comparison for key-value-storage (D-04): which fields the mask
// hides, and that a single changed reply character, event field, store byte or state field is still reported at its
// exact path. The records are small inline copies of the shape of upstream tests/parity/golden/restart.json, so no
// upstream checkout and no Pyodide is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXCLUDED_KEYS, EXCLUDED_PATHS, compareTranscript, maskRecord } from '../kv-parity.mjs';

const event = (seq, type, data) => ({ cmd: null, conn: null, data, mono_ns: 1794706748267000064, seq, thread: 'MainThread',
  thread_id: 4012832, ts_ns: 1794706748267000064, type, v: 1 });

// One send record with a raw (unmasked) clock value in every excluded place the README lists.
const send = (wait = 1300) => ({
  op: 'send', text: 'SET a 1', keep: true, replies: ['OK: SET a=1\n'],
  events: [
    event(5, 'cmd.parse', { command: 'SET', args: 2 }),
    event(6, 'lock.acquired', { contended: false, lock: 'store', wait_ns: wait, waiting: 0 }),
    event(7, 'store.mutation', { existed: false, generation: 1, key: { chars: 1, redacted: false, text: 'a', truncated: false }, op: 'set' }),
    event(8, 'lock.released', { hold_ns: 21000, lock: 'store' }),
    event(9, 'store.save_end', { duration_ns: 55000, mtime_ns: 1794706748267000000, ok: true }),
  ],
  state: {
    file: { exists: true, mtime_ns: 1794706748267000000, size_bytes: 8 },
    store: { memory_bytes: { value: 64 }, payload_bytes: { value: 4 }, generation: 1 },
    taken: { mono_ns: 1794706748267000064, ts_ns: 1794706748267000064 },
  },
  inspect_events: [event(10, 'lock.wait_start', { lock: 'store', owner_thread: null, owner_thread_id: null, waiting: 1 })],
  diagnostics: {
    derived: { lock_means: { value: { store: { hold_ns_mean: 700, wait_ns_mean: 1300 } } } },
    locks: { store: { acquisitions: 2, hold_ns_max: 786100, hold_ns_total: 800000, wait_ns_max: 3400, wait_ns_total: 4700 } },
    persistence: { last_save: null, save_ns_max: 55000, save_ns_total: 55000, saves_ok: 1 },
    server: { bound_port: null, pid: 42, port: 3490, running: false },
  },
  store_txt: 'a 1\n', stdout: [],
});

const transcript = (record = send()) => ({ script: 'demo', steps: [{ op: 'boot', events: [], state: {}, stdout: [] }, record, structuredClone(record)] });
// The mask runs per record (its excluded path is from the record root), as runScript applies it.
const masked = (t) => ({ ...t, steps: t.steps.map(maskRecord) });
const golden = () => masked(transcript());
const actual = (edit) => { const t = transcript(); edit(t); return masked(t); };

test('the exclusion lists are the 19 keys and one path of run_native.py', () => {
  assert.equal(EXCLUDED_KEYS.length, 19);
  assert.deepEqual([...EXCLUDED_KEYS], [...EXCLUDED_KEYS].sort());
  assert.deepEqual([...EXCLUDED_PATHS], ['state.store.memory_bytes.value']);
  assert.ok(Object.isFrozen(EXCLUDED_KEYS) && Object.isFrozen(EXCLUDED_PATHS));
});

test('maskRecord masks time, identity and pointer-size fields and nothing else', () => {
  const m = maskRecord(send());
  for (const e of m.events.concat(m.inspect_events)) {
    assert.deepEqual([e.ts_ns, e.mono_ns, e.thread_id], ['<x:int>', '<x:int>', '<x:int>']);
  }
  assert.equal(m.events[1].data.wait_ns, '<x:int>');
  assert.equal(m.events[3].data.hold_ns, '<x:int>');
  assert.deepEqual([m.events[4].data.duration_ns, m.events[4].data.mtime_ns], ['<x:int>', '<x:int>']);
  assert.deepEqual([m.state.taken.ts_ns, m.state.file.mtime_ns], ['<x:int>', '<x:int>']);
  assert.equal(m.state.store.memory_bytes.value, '<x:int>');
  const d = m.diagnostics;
  assert.deepEqual([d.locks.store.wait_ns_total, d.locks.store.hold_ns_max, d.persistence.save_ns_total, d.server.pid],
    ['<x:int>', '<x:int>', '<x:int>', '<x:int>']);
  assert.deepEqual([d.derived.lock_means.value.store.wait_ns_mean, d.derived.lock_means.value.store.hold_ns_mean], ['<x:int>', '<x:int>']);
  // Everything else is compared exactly.
  assert.equal(m.state.store.payload_bytes.value, 4);
  assert.equal(m.state.store.generation, 1);
  assert.deepEqual([m.events[0].seq, m.events[0].thread, m.events[2].data.generation], [5, 'MainThread', 1]);
  assert.equal(m.diagnostics.server.port, 3490);
  // A null stays null, and the input record is not changed.
  assert.equal(m.inspect_events[0].data.owner_thread_id, null);
  assert.equal(send().events[0].ts_ns, 1794706748267000064);
});

test('a transcript equals itself', () => {
  assert.deepEqual(compareTranscript(golden(), golden()), []);
});

test('one changed reply character is reported at that reply', () => {
  const diffs = compareTranscript(actual((t) => { t.steps[1].replies = ['OK: SET a=2\n']; }), golden());
  assert.deepEqual(diffs.map((d) => d.path), ['steps[1].replies[0]']);
  assert.equal(diffs[0].actual, 'OK: SET a=2\n');
});

test('one changed event data field is reported at its path', () => {
  const diffs = compareTranscript(actual((t) => { t.steps[2].events[2].data.key.text = 'b'; }), golden());
  assert.deepEqual(diffs.map((d) => d.path), ['steps[2].events[2].data.key.text']);
});

test('one changed store.txt byte is reported', () => {
  const diffs = compareTranscript(actual((t) => { t.steps[1].store_txt = 'a 2\n'; }), golden());
  assert.deepEqual(diffs.map((d) => d.path), ['steps[1].store_txt']);
});

test('a changed non-excluded state field (payload_bytes) is reported while memory_bytes is not', () => {
  const diffs = compareTranscript(actual((t) => { t.steps[1].state.store.payload_bytes.value = 5; t.steps[1].state.store.memory_bytes.value = 99; }), golden());
  assert.deepEqual(diffs.map((d) => d.path), ['steps[1].state.store.payload_bytes.value']);
});

test('a missing step and an extra event are each reported once', () => {
  const missing = compareTranscript(actual((t) => { t.steps.pop(); }), golden());
  assert.deepEqual(missing.map((d) => d.path), ['steps[2]']);
  assert.equal(missing[0].actual, undefined);
  const extra = compareTranscript(actual((t) => { t.steps[1].events.push(event(11, 'cmd.parse', {})); }), golden());
  assert.deepEqual(extra.map((d) => d.path), ['steps[1].events[5]']);
  assert.equal(extra[0].expected, undefined);
});

test('a different raw value of a masked field is not a difference', () => {
  const other = transcript(send(99999));
  other.steps[1].events[0].ts_ns = 1;
  other.steps[1].state.taken.ts_ns = 2;
  other.steps[1].diagnostics.server.pid = 7;
  assert.deepEqual(compareTranscript(masked(other), golden()), []);
});

test('a masked field that is null on one side and a number on the other is a difference', () => {
  const diffs = compareTranscript(actual((t) => { t.steps[1].inspect_events[0].data.owner_thread_id = 12; }), golden());
  assert.deepEqual(diffs.map((d) => d.path), ['steps[1].inspect_events[0].data.owner_thread_id']);
  assert.equal(diffs[0].actual, '<x:int>');
  assert.equal(diffs[0].expected, null);
  const back = compareTranscript(actual((t) => { t.steps[1].diagnostics.persistence.save_ns_total = null; }), golden());
  assert.deepEqual(back.map((d) => d.path), ['steps[1].diagnostics.persistence.save_ns_total']);
});
