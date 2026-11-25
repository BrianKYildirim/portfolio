// Tests of the pure helpers over the engine's event text (scripts/demos/kv-events.js), run on the vendored native
// goldens. Those goldens hold events as objects with masked clocks ("<x:int>"), so each is re-serialized to a text first;
// the helpers read structure from the text and must tolerate the masks. No Pyodide here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_LABEL, DURATION_KEYS, RECORDED_LABEL, changedKeys, durationFields, eventSummary, fieldText, isLockEvent, keyMatch,
  parseEvents,
} from '../../scripts/demos/kv-events.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const golden = (name) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'kv-parity', 'golden', `${name}.json`), 'utf8'));
const texts = (events) => events.map((e) => JSON.stringify(e));
const field = (text, chars = text.length, truncated = false) => ({ text, chars, truncated, redacted: false });

const edges = golden('edges');
const restart = golden('restart');
const step = (g, text) => g.steps.find((s) => s.text === text);

test('parseEvents keeps each text exactly and parses it once', () => {
  const raw = ['{"v":1,"seq":1,"ts_ns":1790000000000000001,"type":"store.load","data":{}}', 'not json'];
  const out = parseEvents(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, raw[0], 'the big integer stays in the text even though parsing rounds it');
  assert.equal(out[0].event.type, 'store.load');
  assert.equal(out[1].text, 'not json');
  assert.equal(out[1].event, null);
  assert.deepEqual(parseEvents([]), []);
});

test('changedKeys returns the store.mutation events in seq order and nothing for a command that changed no key', () => {
  const set = changedKeys(parseEvents(texts(step(edges, 'ſet k v').events)));
  assert.equal(set.length, 1);
  assert.deepEqual({ ...set[0], seq: undefined, generation: undefined }, { seq: undefined, op: 'set', key: field('k'), existed: false, generation: undefined });
  assert.equal(typeof set[0].generation, 'number');

  const over = changedKeys(parseEvents(texts(step(edges, 'SET k v2').events)));
  assert.equal(over.length, 1);
  assert.equal(over[0].existed, true, 'an overwrite says the key existed');
  assert.equal(over[0].generation, set[0].generation + 1);

  assert.deepEqual(changedKeys(parseEvents(texts(step(edges, 'REMOVE missing').events))), [], 'REMOVE of a missing key');
  assert.deepEqual(changedKeys(parseEvents(texts(step(edges, 'GET k').events))), [], 'GET');
  assert.deepEqual(changedKeys(parseEvents(texts(step(edges, 'SET a b c').events))), [], 'a rejected command');
  assert.deepEqual(changedKeys(parseEvents(texts(edges.steps[0].events))), [], 'boot');
  assert.deepEqual(changedKeys([]), []);

  const two = parseEvents([
    '{"seq":9,"type":"store.mutation","data":{"op":"set","key":{"text":"b","chars":1,"truncated":false,"redacted":false},"existed":false,"generation":2}}',
    '{"seq":4,"type":"store.mutation","data":{"op":"remove","key":{"text":"a","chars":1,"truncated":false,"redacted":false},"existed":true,"generation":1}}',
  ]);
  assert.deepEqual(changedKeys(two).map((c) => c.seq), [4, 9], 'listed in seq order');
});

test('keyMatch: exact for equal untruncated fields, prefix for equal truncated fields, null when text, chars or truncated differ', () => {
  assert.equal(keyMatch(field('k'), field('k')), 'exact');
  assert.equal(keyMatch(field('k'), field('j')), null);
  assert.equal(keyMatch(field('abc', 3, false), field('abc', 9, true)), null, 'a cut key never matches an uncut one');
  assert.equal(keyMatch(field('abc', 9, true), field('abc', 9, true)), 'prefix');
  assert.equal(keyMatch(field('abc', 9, true), field('abc', 12, true)), null, 'same prefix, different length: different keys');
  assert.equal(keyMatch(field('abc', 9, true), field('abd', 9, true)), null, 'keys that differ within the prefix');
  assert.equal(keyMatch({ text: null, chars: 3, truncated: false, redacted: true }, { text: null, chars: 3, truncated: false, redacted: true }), null, 'redacted never matches');
  assert.equal(keyMatch(undefined, field('k')), null);
});

test('on edges.json the long key matches its state entry by prefix (max_chars 256) and the short ones exactly', () => {
  const long = edges.steps.find((s) => s.text?.startsWith('SET xxxx'));
  const [change] = changedKeys(parseEvents(texts(long.events)));
  assert.equal(change.key.truncated, true);
  assert.equal(long.state.redaction.max_chars, 256);
  assert.equal(change.key.text.length, 256);
  const rows = long.state.store.entries.map((e) => keyMatch(e.key, change.key));
  assert.equal(rows.filter((m) => m === 'prefix').length, 1, 'exactly one row is the long key');
  assert.equal(rows.filter((m) => m === 'exact').length, 0);
  assert.equal(rows.filter((m) => m === null).length, long.state.store.entries.length - 1);

  const short = step(edges, 'ſet k v');
  const [c2] = changedKeys(parseEvents(texts(short.events)));
  assert.deepEqual(short.state.store.entries.map((e) => keyMatch(e.key, c2.key)), ['exact']);
});

test('durationFields reads the raw value from the event text: lock.acquired gives wait_ns, store.save_end gives duration_ns only', () => {
  const raw = '{"v":1,"seq":3,"ts_ns":1790000000000000001,"type":"lock.acquired","data":{"lock":"store","wait_ns":0,"contended":false,"waiting":1}}';
  assert.deepEqual(durationFields(parseEvents([raw])[0]), [['wait_ns', '0']], 'a zero reading is kept');
  assert.deepEqual(durationFields(raw), [['wait_ns', '0']], 'a bare text works too');

  const big = '{"seq":4,"type":"lock.released","data":{"lock":"store","hold_ns":123456789012345678901}}';
  assert.deepEqual(durationFields(parseEvents([big])[0]), [['hold_ns', '123456789012345678901']], 'digits beyond 2^53 are not rounded');

  const save = parseEvents(texts(step(edges, 'ſet k v').events)).find(({ event }) => event.type === 'store.save_end');
  assert.ok('mtime_ns' in save.event.data);
  assert.deepEqual(durationFields(save).map(([n]) => n), ['duration_ns'], 'mtime_ns is a timestamp, not a duration');
  assert.equal(durationFields(save)[0][1], '<x:int>', 'a masked golden value is shown as it is, not invented');

  const parse = parseEvents(texts(step(edges, 'GET k').events)).find(({ event }) => event.type === 'cmd.parse');
  assert.deepEqual(durationFields(parse), []);
  assert.deepEqual(durationFields(parseEvents(['{"seq":1,"type":"store.load","data":{"duration_ns":null}}'])[0]), [], 'null: nothing was measured');
  assert.deepEqual(durationFields(parseEvents(['not json'])[0]), []);
  assert.deepEqual([...DURATION_KEYS], ['duration_ns', 'hold_ns', 'latency_ns', 'send_ns', 'wait_ns']);
});

test('a visitor key shaped like a duration field cannot be mistaken for one', () => {
  const text = JSON.stringify({ seq: 2, type: 'store.mutation', data: { op: 'set', key: field('x","wait_ns":99,"y'), value: field('1'), existed: false, generation: 1 } });
  assert.deepEqual(durationFields(parseEvents([text])[0]), []);
});

test('isLockEvent, fieldText and eventSummary read only the event\'s own fields', () => {
  assert.equal(isLockEvent('lock.acquired'), true);
  assert.equal(isLockEvent('store.mutation'), false);
  assert.equal(isLockEvent(undefined), false);
  assert.equal(fieldText(field('k')), 'k');
  assert.equal(fieldText(field('abc', 300, true)), 'abc… (300 characters)');
  assert.equal(fieldText(null), 'null');
  assert.equal(fieldText({ text: null, chars: 3, truncated: false, redacted: true }), '(hidden)');
  const by = (g, text, type) => parseEvents(texts(step(g, text).events)).find(({ event }) => event.type === type).event;
  assert.equal(eventSummary(by(edges, 'ſet k v', 'store.mutation')), 'set k');
  assert.equal(eventSummary(by(edges, 'REMOVE missing', 'store.lookup')), 'remove missing, found false');
  assert.equal(eventSummary(by(edges, 'SET a b c', 'cmd.parse')), 'SET, rejected: arity');
  assert.equal(eventSummary(by(edges, 'GET k', 'lock.acquired')), 'store, contended false, waiting 0');
  assert.equal(eventSummary(by(edges, 'GET k', 'lock.wait_start')), 'store, waiting 1', 'only the one thread is ever counted');
  assert.equal(eventSummary(by(restart, 'GET a', 'cmd.parse')), 'GET, valid');
  assert.equal(eventSummary(null), '');
});

test('restart.json: every state-read event is a lock.* event on MainThread with conn null, so the read can be grouped apart', () => {
  for (const s of restart.steps) {
    assert.ok(s.inspect_events.length > 0, `${s.op}: state() emits lock events`);
    for (const e of s.inspect_events) {
      assert.equal(isLockEvent(e.type), true, `${s.op}: ${e.type}`);
      assert.equal(e.thread, 'MainThread');
      assert.equal(e.conn, null);
    }
  }
  const restarted = restart.steps.find((s) => s.op === 'restart');
  const load = restarted.events.find((e) => e.type === 'store.load');
  assert.equal(load.data.exists, true, 'a restart really reloads the saved file');
  assert.equal(restart.steps.find((s) => s.op === 'reset').events.find((e) => e.type === 'store.load').data.exists, false);
});

test('the browser and native labels exist in kv-events.js only: no other demo script types them', () => {
  assert.equal(BROWSER_LABEL, 'measured in your browser (Pyodide)');
  assert.equal(RECORDED_LABEL, 'recorded in a native run');
  const dir = path.join(ROOT, 'scripts', 'demos');
  const demoFiles = ['kv.js', 'kv-timeline.js', 'kv-worker.js', 'kv-pyodide.js'].filter((f) => existsSync(path.join(dir, f)));
  assert.ok(demoFiles.includes('kv.js'));
  for (const f of demoFiles) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /measured in your browser|recorded in a native run/, `${f} types a label instead of importing it`);
  }
  assert.match(readFileSync(path.join(dir, 'kv.js'), 'utf8'), /BROWSER_LABEL/, 'kv.js imports the constant');
  const own = readFileSync(path.join(dir, 'kv-events.js'), 'utf8');
  assert.doesNotMatch(own, /JSON\.stringify/, 'an engine object is never re-serialized for display');
  assert.doesNotMatch(readFileSync(path.join(dir, 'kv.js'), 'utf8'), /JSON\.stringify/);
});
