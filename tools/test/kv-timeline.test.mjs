// Tests of the pure timeline helpers (scripts/demos/kv-timeline.js): recorded JSONL to steps, lanes and lock spans. Small
// inline traces test each rule alone; the vendored native contention trace tests the real thing. No DOM, no Pyodide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTimeline, lockSpans, parseJsonl, recordingHeader } from '../../scripts/demos/kv-timeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const REC = path.join(ROOT, 'scripts', 'demos', 'kv-py', 'recordings');
const rec = (...p) => readFileSync(path.join(REC, ...p), 'utf8');

// An event line the way observability.py writes it: key order and a 19-digit clock value that parsing would round.
const line = (seq, type, thread, data = {}, ts = '1795192394924738239') =>
  `{"v":1,"seq":${seq},"ts_ns":${ts},"mono_ns":${seq},"type":"${type}","thread":"${thread}","thread_id":1,"conn":null,"cmd":null,"data":${JSON.stringify(data)}}`;
const jsonl = (...lines) => `${lines.join('\n')}\n`;

test('parseJsonl keeps each line byte for byte, ignores only a final empty line, and names file and line for a bad line', () => {
  const a = line(1, 'server.start', 'MainThread'), b = line(2, 'server.stop', 'MainThread');
  const out = parseJsonl(`${a}\n${b}\n`, 'raw/trace.jsonl');
  assert.deepEqual(out.map((o) => o.text), [a, b]);
  assert.deepEqual(out.map((o) => o.line), [1, 2]);
  assert.equal(out[0].file, 'raw/trace.jsonl');
  assert.ok(out[0].text.includes('"ts_ns":1795192394924738239'), 'the 19-digit value is not rounded in the text');
  assert.equal(out[0].event.type, 'server.start');
  assert.deepEqual(parseJsonl('', 'x'), []);
  assert.throws(() => parseJsonl('\n', 'x'), /x line 1/, 'a lone newline is one empty line, not a final empty one');
  assert.equal(parseJsonl(a, 'x').length, 1, 'no trailing newline is fine');
  assert.throws(() => parseJsonl(`${a}\nnot json\n${b}\n`, 'raw/t.jsonl'), /raw\/t\.jsonl line 2/);
  assert.throws(() => parseJsonl(`${a}\n\n${b}\n`, 'raw/t.jsonl'), /raw\/t\.jsonl line 2/, 'an empty line in the middle is not skipped');
  assert.throws(() => parseJsonl('[1]\n', 'f'), /f line 1/);
});

test('buildTimeline orders by seq and never by a recorded clock, keeps lanes in order of first appearance, and keeps one step per event', () => {
  const text = jsonl(
    line(2, 'conn.open', 'client 127.0.0.1:1', {}, '100'), // the clock goes backwards here on purpose
    line(1, 'server.start', 'MainThread', {}, '900'),
    line(3, 'conn.open', 'client 127.0.0.1:2', {}, '50'),
    line(4, 'conn.recv', 'client 127.0.0.1:1', {}, '10'),
  );
  const t = buildTimeline([{ name: 'a.jsonl', text }]);
  assert.deepEqual(t.steps.map((s) => s.seq), [1, 2, 3, 4]);
  assert.deepEqual(t.steps.map((s) => s.index), [0, 1, 2, 3]);
  assert.deepEqual(t.lanes, ['MainThread', 'client 127.0.0.1:1', 'client 127.0.0.1:2']);
  assert.deepEqual(t.steps.map((s) => s.lane), [0, 1, 2, 1]);
  assert.equal(t.steps.length, 4, 'as many steps as event lines');
  for (const s of t.steps) assert.equal(s.text, text.split('\n').find((l) => l.includes(`"seq":${s.seq},`)), 'the step keeps its source line');
  assert.deepEqual(t.dividers, []);
});

test('buildTimeline keeps a file already in seq order exactly as recorded', () => {
  const text = jsonl(line(1, 'a', 'MainThread'), line(2, 'b', 'MainThread'), line(3, 'c', 'MainThread'));
  assert.deepEqual(buildTimeline([{ name: 'f', text }]).steps.map((s) => s.text), text.trimEnd().split('\n'));
});

test('buildTimeline marks where a later file starts and keys steps by file and seq', () => {
  const a = jsonl(line(1, 'server.start', 'MainThread'), line(2, 'server.stop', 'MainThread'));
  const b = jsonl(line(1, 'server.start', 'MainThread'), line(2, 'conn.open', 'client 127.0.0.1:9'));
  const t = buildTimeline([{ name: 'run-a.jsonl', text: a }, { name: 'run-b.jsonl', text: b }]);
  assert.equal(t.steps.length, 4);
  assert.deepEqual(t.dividers, [2]);
  assert.deepEqual(t.steps.map((s) => s.key), ['run-a.jsonl:1', 'run-a.jsonl:2', 'run-b.jsonl:1', 'run-b.jsonl:2']);
  assert.equal(new Set(t.steps.map((s) => s.key)).size, 4, 'seq restarts, so keys stay unique only through the file');
  assert.deepEqual(t.lanes, ['MainThread', 'client 127.0.0.1:9'], 'one lane per thread name across both runs');
  assert.deepEqual(t.files, [{ name: 'run-a.jsonl', first: 0, count: 2 }, { name: 'run-b.jsonl', first: 2, count: 2 }]);
});

test('an empty recording has no steps, no lanes and no divider', () => {
  for (const files of [[], [{ name: 'e.jsonl', text: '' }]]) {
    const t = buildTimeline(files);
    assert.deepEqual([t.steps.length, t.lanes.length, t.dividers.length], [0, 0, 0]);
  }
  const t = buildTimeline([{ name: 'a', text: '' }, { name: 'b', text: jsonl(line(1, 'x', 'MainThread')) }]);
  assert.equal(t.steps.length, 1);
  assert.deepEqual(t.dividers, [], 'an empty first file is not a restart');
});

test('lockSpans pairs wait, acquire and release per thread and keeps the recorded duration texts', () => {
  const lock = 'store';
  const t = buildTimeline([{ name: 'f', text: jsonl(
    line(1, 'lock.wait_start', 'A', { lock, waiting: 1 }),
    line(2, 'lock.acquired', 'A', { lock, wait_ns: 826, contended: false, waiting: 0 }),
    line(3, 'lock.released', 'A', { lock, hold_ns: 530429 }),
  ) }]);
  const spans = lockSpans(t.steps);
  assert.equal(spans.length, 1);
  assert.deepEqual({ ...spans[0] }, { file: 'f', thread: 'A', lock, lane: 0, waitStart: 0, acquired: 1, released: 2, failed: null, from: 0, to: 2, contended: false, wait_ns: '826', hold_ns: '530429' });
});

test('a release on one thread followed at the next seq by an acquire on another is two spans, never merged', () => {
  const lock = 'store';
  const t = buildTimeline([{ name: 'f', text: jsonl(
    line(8, 'lock.wait_start', 'A', { lock, waiting: 1 }),
    line(9, 'lock.acquired', 'A', { lock, wait_ns: 5, contended: false, waiting: 0 }),
    line(10, 'lock.released', 'A', { lock, hold_ns: 70 }),
    line(11, 'lock.acquired', 'B', { lock, wait_ns: 9000, contended: true, waiting: 0 }),
    line(12, 'lock.released', 'B', { lock, hold_ns: 0 }),
  ) }]);
  const spans = lockSpans(t.steps);
  assert.equal(spans.length, 2);
  const [a, b] = spans;
  assert.equal(t.steps[a.released].seq, 10);
  assert.equal(t.steps[b.acquired].seq, 11);
  assert.equal(b.waitStart, null, 'no wait_start was recorded, so none is invented');
  assert.equal(b.contended, true);
  assert.equal(b.hold_ns, '0', 'a recorded zero stays 0');
  assert.notEqual(a.thread, b.thread);
  assert.ok(a.to < b.from, 'the second span starts after the first ends');
});

test('lockSpans keeps a wait that never ended, a failed acquire, and a hold still open at the end of the recording', () => {
  const lock = 'store';
  const t = buildTimeline([{ name: 'f', text: jsonl(
    line(1, 'lock.wait_start', 'A', { lock, waiting: 1 }),
    line(2, 'lock.acquire_failed', 'A', { lock, wait_ns: 12, waiting: 0 }),
    line(3, 'lock.wait_start', 'B', { lock, waiting: 1 }),
    line(4, 'lock.acquired', 'B', { lock, wait_ns: 3, contended: true, waiting: 0 }),
  ) }]);
  const [failed, open] = lockSpans(t.steps);
  assert.equal(failed.failed, 1);
  assert.equal(failed.wait_ns, '12');
  assert.equal(failed.hold_ns, null);
  assert.equal(open.released, null);
  assert.equal(open.hold_ns, null, 'no hold was recorded, so none is shown');
  assert.equal(open.to, 3);
});

test('the vendored contention trace: every step is its source line, one lane per thread, and a contended span exists', () => {
  const text = rec('contention', 'raw', 'trace.jsonl');
  const t = buildTimeline([{ name: 'raw/trace.jsonl', text }]);
  const source = text.split('\n').filter(Boolean);
  assert.equal(t.steps.length, source.length);
  t.steps.forEach((s, i) => assert.equal(s.text, source[i]));
  assert.ok(t.lanes.includes('MainThread'));
  const clients = t.lanes.filter((n) => /^client 127\.0\.0\.1:\d+$/.test(n));
  assert.equal(clients.length, 4);
  assert.equal(t.lanes.length, 5);
  const spans = lockSpans(t.steps);
  assert.ok(spans.some((s) => s.contended === true), 'at least one contended acquisition was recorded');
  const contended = spans.find((s) => s.contended === true);
  assert.match(contended.wait_ns, /^[1-9][0-9]*$/, 'the recorded wait is above zero');
  for (const s of spans) assert.ok(s.released !== null && s.acquired !== null, 'every recorded hold ends');
});

test('recordingHeader is built from the recording metadata and refuses a recording that lacks any of it', () => {
  const meta = JSON.parse(rec('contention', 'meta.json'));
  assert.equal(recordingHeader(meta), `Recording of a real native run · server.py @ 3e49009 · ${meta.os.name}, CPython ${meta.toolchain.version} · captured ${meta.date_utc.slice(0, 10)}`);
  for (const drop of [['source', 'sha'], ['os', 'name'], ['toolchain', 'version'], ['date_utc']]) {
    const bad = structuredClone(meta);
    if (drop.length === 2) delete bad[drop[0]][drop[1]]; else delete bad[drop[0]];
    assert.throws(() => recordingHeader(bad), /lacks/);
  }
});

test('kv-timeline.js orders and spaces steps by seq only: it names no recorded clock and holds neither label string', () => {
  const src = readFileSync(path.join(ROOT, 'scripts', 'demos', 'kv-timeline.js'), 'utf8');
  assert.doesNotMatch(src, /ts_ns|mono_ns/);
  assert.doesNotMatch(src, /measured in your browser|recorded in a native run/);
  assert.doesNotMatch(src, /Date\.now|performance\.now|requestAnimationFrame/);
});
