// Turns the recorded JSONL of real native server.py runs into playback steps (no DOM). Ordering and grouping only: every
// value shown comes from the recorded lines, steps follow the recorded seq, and no clock reading is used to order or space them.
import { durationFields } from './kv-events.js';

const NO_THREAD = '(no thread recorded)';

// One { file, line, text, event } per line. text is the line byte for byte, so key order and digits stay as recorded. Only a
// final empty line is ignored; any other line that is not a JSON object throws an error naming the file and line.
export function parseJsonl(text, file) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line, i) => {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`${file} line ${i + 1} is not JSON`); }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new Error(`${file} line ${i + 1} is not a JSON object`);
    return { file, line: i + 1, text: line, event };
  });
}

// files: [{ name, text }] in the order to play them (a restart is a second file). Returns
//   steps    one per event line, file by file, each file in seq order (the recorded order; a file already in seq order is not changed)
//   lanes    thread names in order of first appearance across all steps
//   dividers step indexes where a later file starts (a new process: seq starts again)
//   files    [{ name, first, count }] per file
// A step is { index, key, file, line, seq, type, thread, lane, text, event }; key is `${file}:${seq}` because seq restarts per file.
export function buildTimeline(files) {
  const steps = [], lanes = [], dividers = [], summary = [];
  for (const { name, text } of files) {
    const items = parseJsonl(text, name);
    const ordered = items.every((it) => Number.isInteger(it.event.seq)) ? items.slice().sort((a, b) => a.event.seq - b.event.seq) : items;
    if (steps.length && ordered.length) dividers.push(steps.length);
    summary.push({ name, first: steps.length, count: ordered.length });
    for (const { file, line, text: raw, event } of ordered) {
      const thread = typeof event.thread === 'string' ? event.thread : NO_THREAD;
      let lane = lanes.indexOf(thread);
      if (lane < 0) lane = lanes.push(thread) - 1;
      steps.push({ index: steps.length, key: `${file}:${event.seq ?? `line${line}`}`, file, line, seq: event.seq, type: event.type, thread, lane, text: raw, event });
    }
  }
  return { steps, lanes, dividers, files: summary };
}

// The lock events as spans, paired per file, thread and lock name as recorded: lock.wait_start (optional), lock.acquired,
// lock.released. A span is { file, thread, lock, lane, waitStart, acquired, released, failed, from, to, contended, wait_ns, hold_ns }.
// The indexes are step indexes (null when that event was not recorded); from..to is the drawn extent; wait_ns and hold_ns are
// the recorded values as text. One thread's release and another thread's acquire are always two spans, never merged.
export function lockSpans(steps) {
  const spans = [], open = new Map();
  const slot = (s) => `${s.file}\u0000${s.thread}\u0000${s.event.data?.lock}`;
  const close = (span) => { span.from = span.waitStart ?? span.acquired ?? span.released ?? span.failed; span.to = span.released ?? span.acquired ?? span.failed ?? span.waitStart; spans.push(span); };
  const blank = (s) => ({ file: s.file, thread: s.thread, lock: s.event.data?.lock, lane: s.lane, waitStart: null, acquired: null, released: null, failed: null, from: null, to: null, contended: null, wait_ns: null, hold_ns: null });
  const field = (s, name) => durationFields({ text: s.text, event: s.event }).find(([n]) => n === name)?.[1] ?? null;
  for (const s of steps) {
    const key = slot(s);
    switch (s.type) {
      case 'lock.wait_start': {
        const stale = open.get(key); // a wait with no later event for this thread and lock: keep what was recorded
        if (stale) close(stale);
        open.set(key, { ...blank(s), waitStart: s.index });
        break;
      }
      case 'lock.acquired': {
        let span = open.get(key);
        if (!span || span.acquired !== null) { if (span) close(span); span = blank(s); open.set(key, span); }
        span.acquired = s.index; span.contended = s.event.data.contended ?? null; span.wait_ns = field(s, 'wait_ns');
        break;
      }
      case 'lock.acquire_failed': {
        const span = open.get(key) ?? blank(s);
        span.failed = s.index; span.wait_ns = field(s, 'wait_ns');
        open.delete(key); close(span);
        break;
      }
      case 'lock.released': {
        const span = open.get(key) ?? blank(s);
        span.released = s.index; span.hold_ns = field(s, 'hold_ns');
        open.delete(key); close(span);
        break;
      }
    }
  }
  for (const span of open.values()) close(span); // still open when the recording ends
  return spans.sort((a, b) => a.from - b.from || a.to - b.to);
}

// The header line of a recording, built only from its own meta.json. Throws when a field it needs is missing, so a recording
// is never shown without its source commit, environment and date.
export function recordingHeader(meta) {
  const sha = meta?.source?.sha, os = meta?.os?.name, version = meta?.toolchain?.version, impl = meta?.toolchain?.implementation, date = meta?.date_utc;
  if (typeof sha !== 'string' || sha.length < 7 || typeof os !== 'string' || typeof version !== 'string' || typeof impl !== 'string' || typeof date !== 'string' || date.length < 10) {
    throw new Error('the recording metadata lacks its source commit, environment or date');
  }
  return `Recording of a real native run · server.py @ ${sha.slice(0, 7)} · ${os}, ${impl === 'cpython' ? 'CPython' : impl} ${version} · captured ${date.slice(0, 10)}`;
}
