// Helpers over the event and state JSON text that the real observability.py emits (Observer.recent_events(), state()).
// Selection and lookup only: nothing is computed from, rounded or added to the engine's data, and no DOM is touched.

// The only place these two labels are spelled. A browser-measured duration carries BROWSER_LABEL and is never put next to
// a native figure; a native recording carries RECORDED_LABEL (D-12, KV-07).
export const BROWSER_LABEL = 'measured in your browser (Pyodide)';
export const RECORDED_LABEL = 'recorded in a native run';

// Data keys of events that hold a time span. mtime_ns is a timestamp, not a duration, so it is not here.
export const DURATION_KEYS = Object.freeze(['duration_ns', 'hold_ns', 'latency_ns', 'send_ns', 'wait_ns']);

// Each text exactly as Python wrote it, parsed once to read structure. Big integers (ts_ns, mono_ns, thread_id) lose
// digits when parsed, so values for display come from the text, never from the parsed object. An unparseable text keeps
// event: null and is still shown raw.
export function parseEvents(texts) {
  return texts.map((text) => {
    let event = null;
    try { event = JSON.parse(text); } catch { /* shown as raw text only; the engine always writes JSON, so this is defensive */ }
    return { text, event };
  });
}

// The store.mutation events of one command, in seq order. Empty when the command changed no key.
export function changedKeys(parsed) {
  return parsed
    .filter(({ event }) => event?.type === 'store.mutation' && event.data)
    .map(({ event }) => ({ seq: event.seq, op: event.data.op, key: event.data.key, existed: event.data.existed, generation: event.data.generation }))
    .sort((a, b) => a.seq - b.seq);
}

// Whether a state() entry key and a mutation key are the same key: 'exact' for equal untruncated text fields, 'prefix' for
// equal truncated ones (text, chars and truncated all equal, so the keys agree on the first max_chars characters and on
// their length, but may differ after that), null otherwise. A redacted field (text null) never matches.
export function keyMatch(entryKey, mutationKey) {
  if (!entryKey || !mutationKey || typeof entryKey.text !== 'string') return null;
  if (entryKey.text !== mutationKey.text || entryKey.chars !== mutationKey.chars || entryKey.truncated !== mutationKey.truncated) return null;
  return entryKey.truncated ? 'prefix' : 'exact';
}

// [[name, raw value text]] for the duration keys present in the event's data, in DURATION_KEYS order. The raw value is cut
// from the event's own JSON text so a large number is not rounded; zero stays "0". A null value (nothing was measured) is
// skipped. Accepts a parseEvents() item or a bare text.
export function durationFields(item) {
  const text = typeof item === 'string' ? item : item.text;
  const event = typeof item === 'string' ? safeParse(item) : item.event;
  const data = event?.data;
  if (!data) return [];
  const out = [];
  for (const name of DURATION_KEYS) {
    if (!(name in data) || data[name] === null) continue;
    const m = new RegExp(`"${name}":("[^"\\\\]*"|-?[0-9][0-9.eE+-]*)`).exec(text);
    out.push([name, m ? m[1].replace(/^"|"$/g, '') : String(data[name])]);
  }
  return out;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; /* no structure to read */ }
}

export const isLockEvent = (type) => typeof type === 'string' && type.startsWith('lock.');

// A TextField ({ text, chars, truncated, redacted }) as it is shown: its text, then the original length when it was cut.
export function fieldText(field) {
  if (field === null || field === undefined) return 'null';
  if (typeof field.text !== 'string') return field.redacted ? '(hidden)' : 'null';
  return field.truncated ? `${field.text}… (${field.chars} characters)` : field.text;
}

// One line saying what an event is, from its own data fields only.
export function eventSummary(event) {
  const d = event?.data ?? {};
  switch (event?.type) {
    case 'store.mutation': return `${d.op} ${fieldText(d.key)}`;
    case 'store.lookup': return d.op === 'print' ? 'print' : `${d.op} ${fieldText(d.key)}, found ${d.found}`;
    case 'cmd.parse': return d.valid ? `${d.verb}, valid` : `${d.verb}, rejected: ${d.reason}`;
    case 'lock.wait_start': return `${d.lock}, waiting ${d.waiting}`;
    case 'lock.acquired': return `${d.lock}, contended ${d.contended}, waiting ${d.waiting}`;
    case 'lock.acquire_failed': return `${d.lock}, waiting ${d.waiting}`;
    case 'lock.released': return `${d.lock}`;
    case 'store.save_start': return `generation ${d.generation}, keys ${d.keys}`;
    case 'store.save_end': return `bytes ${d.bytes}, ok ${d.ok}`;
    case 'store.load': return `exists ${d.exists}, ok ${d.ok}, keys ${d.keys}`;
    default: return '';
  }
}
