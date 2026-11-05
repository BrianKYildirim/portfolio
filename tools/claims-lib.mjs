// Claims checker core: checks numbers shown in the portfolio (and later the upstream READMEs) against
// bench/claims.json and its evidence files (CLAIM-01..06), and validates benchmark results directories
// (BENCH-01..03/05/06). Pure: no file system and no network; callers pass text in and inject readers
// (readEvidence, readFile/readdir), so tests run on plain fixtures.
import { createHash } from 'node:crypto';

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const CLAIMS_FILE = 'bench/claims.json';
const SI = Object.freeze({ k: 1e3, M: 1e6, G: 1e9 });
// spread.kind names the pair of stats keys that gives low and high.
const SPREAD_KEYS = Object.freeze({ 'min-max': ['min', 'max'], 'p25-p75': ['p25', 'p75'], 'pooled-p25-p75': ['pooled_p25', 'pooled_p75'] });
const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', thinsp: '\u2009',
  times: '\u00d7', micro: '\u00b5', ndash: '\u2013', mdash: '\u2014', minus: '\u2212', asymp: '\u2248' });

const byteLength = (text) => new TextEncoder().encode(text).length;
const finding = (file, line, code, message) => ({ file, line, code, message });
// lineIndex(text) -> (offset -> 1-based line), by binary search over the line starts.
function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}
// NFC, one micro sign (U+03BC Greek mu folds to U+00B5), collapsed whitespace. Case is kept: M and m differ.
const fold = (s) => String(s).normalize('NFC').replace(/\u03bc/g, '\u00b5').replace(/\s+/g, ' ').trim();
const lookup = (byId, id) => (byId instanceof Map ? byId.get(id) : (byId && Object.hasOwn(byId, id) ? byId[id] : undefined));

// ---------- Input ----------
// loadClaims(text) -> { doc, findings }; never throws. Oversized or unparseable input is a finding, never a pass.
export function loadClaims(text, file = CLAIMS_FILE) {
  if (byteLength(text) > MAX_INPUT_BYTES) return { doc: null, findings: [finding(file, 1, 'INPUT_TOO_LARGE', `larger than ${MAX_INPUT_BYTES} bytes`)] };
  try {
    return { doc: JSON.parse(text), findings: [] };
  } catch (err) {
    return { doc: null, findings: [finding(file, 1, 'SCHEMA_PARSE', `not valid JSON (${err.message})`)] };
  }
}

// RFC 6901: '' is the whole document; segments unescape ~1 -> '/' then ~0 -> '~'. Missing -> undefined.
export function resolvePointer(obj, pointer) {
  if (pointer === '') return obj;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  let cur = obj;
  for (const raw of pointer.slice(1).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// ---------- Display numbers ----------
// A number not glued to a preceding letter or digit (so "WSL2" and "v1.2" are skipped), with optional
// thousands separators and decimals, then an optional SI suffix that is not the start of a word ("MiB", "ms").
const NUM_PART = String.raw`([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
const SUFFIX = String.raw`(?:\s?([kMG])(?![A-Za-z]))?`;
const DISPLAY_NUMBER = new RegExp(String.raw`(?<![A-Za-z0-9_.,])` + NUM_PART + SUFFIX);
const DISPLAY_RANGE = new RegExp(String.raw`(?<![A-Za-z0-9_.,])` + NUM_PART + SUFFIX
  + String.raw`\s?(?:[\u2013\u2014-]|to)\s?` + NUM_PART + SUFFIX);

function displayText(str) {
  return fold(str).replace(/\u2212/g, '-').replace(/^(?:~|\u2248|about\b)\s*/i, '');
}
function part(sign, int, frac, suffix) {
  const scale = suffix ? SI[suffix] : 1;
  return { number: Number(`${sign}${int.replace(/,/g, '')}${frac ? `.${frac}` : ''}`) * scale, decimals: frac ? frac.length : 0, scale };
}
// Closed interval: |number - value| <= half a unit in the last digit shown (BENCH-03 precision contract).
// The tiny relative slack absorbs binary floating-point error at exactly the boundary.
function within(p, value) {
  if (!p || typeof value !== 'number' || !Number.isFinite(value)) return false;
  const tol = (0.5 * p.scale) / 10 ** p.decimals;
  return Math.abs(p.number - value) <= tol + 4 * Number.EPSILON * Math.max(Math.abs(value), Math.abs(p.number), tol);
}

// parseDisplayNumber('~153.0M') -> { number: 153000000, decimals: 1, scale: 1e6 }; null when there is no number.
export function parseDisplayNumber(str) {
  const m = DISPLAY_NUMBER.exec(displayText(str));
  return m ? part(m[1], m[2], m[3], m[4]) : null;
}
export function parseDisplayRange(str) {
  const m = DISPLAY_RANGE.exec(displayText(str));
  if (!m) return null;
  const s1 = m[4] || m[8], s2 = m[8] || m[4];   // "128\u2013162M": the suffix applies to both ends
  return { low: part(m[1], m[2], m[3], s1), high: part(m[5], m[6], m[7], s2) };
}
export function matchesDisplay(value, str) {
  return within(parseDisplayNumber(str), value);
}
export function matchesRange(low, high, str) {
  const r = parseDisplayRange(str);
  return !!r && within(r.low, low) && within(r.high, high);
}

// ---------- HTML leaves ----------
function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (m, e) => {
    if (e[0] !== '#') return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : m;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}
const textOf = (fragment) => fold(decodeEntities(fragment.replace(/<[^>]*>/g, ' ')));
const blankComments = (html) => html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
const attr = (attrs, name) => {
  const m = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2]) : null;
};
// The enclosing <li> is the display context of a metric (".pd-metrics li"); otherwise the source line(s).
function contextOf(html, start, end) {
  for (let i = html.lastIndexOf('<li', start); i !== -1; i = html.lastIndexOf('<li', i - 1)) {
    if (!/[\s>]/.test(html[i + 3] || '')) continue;
    if (html.lastIndexOf('</li', start) > i) break;
    const close = html.indexOf('</li', end);
    return textOf(html.slice(i, close === -1 ? html.length : close));
  }
  const from = html.lastIndexOf('\n', start) + 1, to = html.indexOf('\n', end);
  return textOf(html.slice(from, to === -1 ? html.length : to));
}

// extractTaggedLeaves(html) -> [{ id, field, text, line, context, notLeaf }]. Zero-dependency parser rule
// (RESEARCH Pattern 6): a data-claim element must be a leaf, so an element whose content holds '<' is flagged.
export function extractTaggedLeaves(html, file = '') {
  const src = blankComments(html), leaves = [], lineOf = lineIndex(src);
  const open = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g;
  for (let m = open.exec(src); m; m = open.exec(src)) {
    const attrs = m[2] || '', id = attr(attrs, 'data-claim');
    if (id === null) continue;
    const start = m.index + m[0].length, line = lineOf(m.index), field = attr(attrs, 'data-claim-field') || 'value';
    const close = new RegExp(String.raw`</${m[1]}\s*>`, 'ig');
    close.lastIndex = start;
    const c = close.exec(src);
    const inner = c ? src.slice(start, c.index) : null;
    const notLeaf = inner === null || inner.includes('<');
    leaves.push({ file, id, field, line, notLeaf, text: notLeaf ? null : fold(decodeEntities(inner)),
      context: contextOf(src, m.index, c ? c.index : start) });
  }
  return leaves;
}

// ---------- Tagged check ----------
async function evidenceFindings(claim, readEvidence, at) {
  const ev = claim.evidence, out = [];
  let text;
  try {
    text = await readEvidence(ev.repo, ev.sha, ev.path);
  } catch (err) {
    return [at('EVIDENCE_VALUE', `${claim.id}: cannot read evidence ${ev.repo}@${String(ev.sha).slice(0, 7)}:${ev.path} (${err.message})`)];
  }
  if (byteLength(text) > MAX_INPUT_BYTES) return [at('INPUT_TOO_LARGE', `${claim.id}: evidence ${ev.path} is larger than ${MAX_INPUT_BYTES} bytes`)];
  let summary;
  try {
    summary = JSON.parse(text);
  } catch {
    return [at('EVIDENCE_VALUE', `${claim.id}: evidence ${ev.path} is not valid JSON`)];
  }
  const stats = resolvePointer(summary, ev.pointer);
  if (stats === null || typeof stats !== 'object') return [at('EVIDENCE_VALUE', `${claim.id}: pointer ${ev.pointer} does not resolve to a stats object`)];
  if (stats[claim.stat] !== claim.value) out.push(at('EVIDENCE_VALUE', `${claim.id}: value ${claim.value} != evidence ${claim.stat} ${stats[claim.stat]}`));
  if (claim.n !== undefined && stats.n !== claim.n) out.push(at('EVIDENCE_VALUE', `${claim.id}: n ${claim.n} != evidence n ${stats.n}`));
  const keys = SPREAD_KEYS[claim.spread?.kind];
  if (keys && (stats[keys[0]] !== claim.spread.low || stats[keys[1]] !== claim.spread.high)) {
    out.push(at('EVIDENCE_VALUE', `${claim.id}: spread ${claim.spread.low}..${claim.spread.high} != evidence ${keys[0]}/${keys[1]} ${stats[keys[0]]}..${stats[keys[1]]}`));
  }
  return out;
}

function displayFindings(claim, leaf, at) {
  const shown = claim.display?.[leaf.field];
  if (!['value', 'spread', 'n', 'environment'].includes(leaf.field)) return [at('CLAIM_MISMATCH', `${claim.id}: unknown data-claim-field "${leaf.field}"`)];
  if (!Array.isArray(shown) || !shown.some((s) => fold(s) === leaf.text)) {
    return [at('CLAIM_MISMATCH', `${claim.id}: "${leaf.text}" is not one of display.${leaf.field}`)];
  }
  if (claim.kind === 'comparison' && leaf.field === 'value') {
    const r = ratioIn(leaf.text);
    return lowerFold(leaf.text).includes(NO_DIFFERENCE) || within(r, claim.value) ? []
      : [at('CLAIM_MISMATCH', `${claim.id}: "${leaf.text}" does not give the comparison's ratio ${claim.value}`)];
  }
  const ok = leaf.field === 'value' ? matchesDisplay(claim.value, leaf.text)
    : leaf.field === 'spread' ? matchesRange(claim.spread?.low, claim.spread?.high, leaf.text)
      : leaf.field === 'n' ? matchesDisplay(claim.n, leaf.text) : true;
  return ok ? [] : [at('CLAIM_MISMATCH', `${claim.id}: "${leaf.text}" does not round to the claim's ${leaf.field}`)];
}

// checkTagged(claimsById, leaves, readEvidence) -> Promise<findings>. readEvidence(repo, sha, path) is async
// and returns the evidence file's text; each claim's evidence is read and reported once per call.
export function checkTagged(claimsById, leaves, readEvidence) {
  return tagged(claimsById, leaves, readEvidence);
}
async function tagged(claimsById, leaves, readEvidence) {
  const out = [], seen = new Set(), labelled = new Set();
  for (const leaf of leaves) {
    const at = (code, message) => finding(leaf.file, leaf.line, code, message);
    if (leaf.notLeaf) { out.push(at('LEAF_NOT_LEAF', `data-claim="${leaf.id}" must be on a leaf element with a closing tag`)); continue; }
    const claim = lookup(claimsById, leaf.id);
    if (!claim) { out.push(at('CLAIM_UNKNOWN', `"${leaf.id}" is not in ${CLAIMS_FILE}`)); continue; }
    if (claim.status !== 'approved') { out.push(at('CLAIM_NOT_APPROVED', `${claim.id} has status ${claim.status}; only approved claims may be shown`)); continue; }
    out.push(...displayFindings(claim, leaf, at));
    // Labels are judged on the leaf's display context (its <li>), once per claim and context.
    const context = leaf.context ?? leaf.text, key = `${claim.id}\u0000${context}`;
    if (!labelled.has(key)) { labelled.add(key); for (const f of checkLabels(claim, context)) out.push(at(f.code, f.message)); }
    if (claim.evidence?.pointer !== undefined && !seen.has(claim.id)) {
      seen.add(claim.id);
      out.push(...await evidenceFindings(claim, readEvidence, at));
    }
  }
  return out;
}

// ---------- Scan ----------
// CLAIM-02 / D-05: every visible number with a performance unit carries a data-claim marker or a reasoned waiver.
// Patterns are raw strings (RESEARCH Pitfall 11) with no nested quantifiers (T-02-01). A number may not be glued to
// a preceding letter, digit, '.' or ',' ("WSL2", "v1.2" and the tail of "1,2,3" never start one, which also keeps
// the scan linear). An en-dash or hyphen range is one token. × and x count only when no digit follows, so
// "12000 × 12000" is a dimension; an ASCII x before a template `${` is a hex prefix (`0x${hex}`), not a
// multiplier. px and MP are not units here (RESEARCH Open Question 3).
export const NUM = String.raw`(?<![\w.,])[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?[–-]\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)?\s?(?:[kKMG](?![A-Za-z]))?`;
export const UNIT = String.raw`(?:Mops\/s|ops\/s|cmd\/s|calls\/s|req\/s|seconds?|secs?|ns|µs|μs|us|ms|s|×(?!\s?\d)|x(?!\s?\d|\$\{)|KiB|MiB|GiB|KB|MB|GB|bytes?|%|tests?)`;
export const UNIT_NUMBER = new RegExp(NUM + String.raw`[\s-]?` + UNIT + String.raw`(?![\w/])`, 'g');

const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?>/g;
// One token of visible text: a tag, an entity, a whitespace run, a text run, or a lone '<' / '&'.
const VISIBLE_TOKEN = /<[A-Za-z/!?][^<>]*>|&(?:#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});|\s+|[^<&\s]+|[<&]/g;
const hasClass = (attrs, name) => (attr(attrs, 'class') ?? '').split(/\s+/).includes(name);
const blank = (s) => s.replace(/[^\n]/g, ' ');
// Same-length blanking of [start, end) ranges in one pass, so offsets and line numbers stay true.
function blankRanges(src, ranges) {
  if (!ranges.length) return src;
  let out = '', at = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (b <= at) continue;
    const from = Math.max(a, at);
    out += src.slice(at, from) + blank(src.slice(from, b));
    at = b;
  }
  return out + src.slice(at);
}
// A comment (or script/style block) with no end runs to the end of the file, as in a browser.
function blockRanges(src, openRe, closeOf) {
  const ranges = [];
  openRe.lastIndex = 0;
  for (let m = openRe.exec(src); m; m = openRe.exec(src)) {
    const close = closeOf(m);
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(src), end = c ? c.index + c[0].length : src.length;
    ranges.push([m.index, end]);
    if (!c) break;
    openRe.lastIndex = end;
  }
  return ranges;
}
// End of the element opened at `m` when it is a leaf (its next '<' starts its own closing tag), else -1.
function leafEnd(src, m) {
  const next = src.indexOf('<', m.index + m[0].length);
  if (next === -1) return -1;
  const close = new RegExp(String.raw`</${m[1]}\s*>`, 'iy');
  close.lastIndex = next;
  return close.exec(src) ? close.lastIndex : -1;
}
// Ranges of every data-claim leaf: those are verified by checkTagged and never scanned twice.
function claimedRanges(src) {
  const ranges = [];
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(src); m; m = OPEN_TAG.exec(src)) {
    if (attr(m[2] || '', 'data-claim') === null) continue;
    const end = leafEnd(src, m);
    if (end !== -1) ranges.push([m.index, end]);
  }
  return ranges;
}
// Results headline values (".pd-metrics .v") that hold a digit and no marker: METRIC_UNTAGGED, then blanked.
function metricFindings(src, file, lineOf) {
  const out = [], ranges = [];
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(src); m; m = OPEN_TAG.exec(src)) {
    if (!hasClass(m[2] || '', 'pd-metrics')) continue;
    const close = new RegExp(String.raw`</${m[1]}\s*>`, 'ig');
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(src), regionEnd = c ? c.index : src.length;
    const span = new RegExp(OPEN_TAG.source, 'g');
    span.lastIndex = m.index + m[0].length;
    for (let v = span.exec(src); v && v.index < regionEnd; v = span.exec(src)) {
      if (!hasClass(v[2] || '', 'v') || attr(v[2], 'data-claim') !== null) continue;
      const vClose = new RegExp(String.raw`</${v[1]}\s*>`, 'ig');
      vClose.lastIndex = v.index + v[0].length;
      const e = vClose.exec(src), end = e && e.index < regionEnd ? e.index + e[0].length : regionEnd;
      const text = textOf(src.slice(v.index + v[0].length, e && e.index < regionEnd ? e.index : regionEnd));
      if (/\d/.test(text)) {
        out.push(finding(file, lineOf(v.index), 'METRIC_UNTAGGED', `headline value "${text}" in .pd-metrics has no data-claim marker or data-claim-waiver`));
        ranges.push([v.index, end]);
      }
      span.lastIndex = Math.max(span.lastIndex, end);
    }
    OPEN_TAG.lastIndex = Math.max(OPEN_TAG.lastIndex, regionEnd);
  }
  return { findings: out, ranges };
}
// Visible text: every tag becomes one space (so 10<sup>9</sup> never reads as 109; attribute values such as
// data-placeholder vanish with their tags), entities are decoded, whitespace runs collapse to one space.
// Returns the text and lineAt(offset) -> 1-based source line.
function visibleText(src) {
  // Parts are joined once at the end: appending to one growing string and reading its last character would
  // flatten it on every token (quadratic on a 1 MiB input).
  let length = 0, line = 1, lastSpace = true;
  const parts = [], starts = [], lines = [];
  const push = (s) => {
    if (s === ' ' && lastSpace) return;
    starts.push(length); lines.push(line); parts.push(s);
    length += s.length; lastSpace = s.endsWith(' ');
  };
  for (const [t] of src.matchAll(VISIBLE_TOKEN)) {
    if (t.length > 1 && t[0] === '<') push(' ');
    else if (t.length > 1 && t[0] === '&') { const d = decodeEntities(t); push(/^\s+$/.test(d) ? ' ' : d); }
    else push(/^\s/.test(t) ? ' ' : t);
    for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) line += 1;
  }
  const lineAt = (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lines[lo] ?? 1;
  };
  return { text: parts.join(''), lineAt };
}
const untagged = (file, line, token) => finding(file, line, 'UNTAGGED_NUMBER', `"${token}" has a unit but no data-claim marker or data-claim-waiver`);

// Waivers are for non-claims (dimensions, configuration limits, worked arithmetic, anecdotes); the owner reviews
// every reason, so an empty or placeholder reason is a finding.
const WAIVER_PLACEHOLDERS = Object.freeze(['', 'tbd', 'todo', 'n/a', '-']);
const noReason = (reason) => WAIVER_PLACEHOLDERS.includes(fold(reason).toLowerCase());
const WAIVER_ATTR = /(?:^|\s)data-claim-waiver(?=[\s=/]|$)/;
// data-claim-waiver leaves: the reason is checked (WAIVER_NO_REASON), then the leaf is blanked. A waiver on an
// element that is not a leaf is LEAF_NOT_LEAF and is not blanked, so its numbers are still scanned.
function waiverFindings(src, file, lineOf) {
  const out = [], ranges = [];
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(src); m; m = OPEN_TAG.exec(src)) {
    const attrs = m[2] || '';
    if (!WAIVER_ATTR.test(attrs) || attr(attrs, 'data-claim') !== null) continue;
    const reason = decodeEntities(attr(attrs, 'data-claim-waiver') ?? ''), line = lineOf(m.index), end = leafEnd(src, m);
    if (noReason(reason)) out.push(finding(file, line, 'WAIVER_NO_REASON', `data-claim-waiver needs a reason the owner can review (got "${fold(reason)}")`));
    if (end === -1) out.push(finding(file, line, 'LEAF_NOT_LEAF', 'data-claim-waiver must be on a leaf element with a closing tag'));
    else ranges.push([m.index, end]);
  }
  return { findings: out, ranges };
}

// scanHtml(text, file) -> findings (UNTAGGED_NUMBER, METRIC_UNTAGGED, WAIVER_NO_REASON, LEAF_NOT_LEAF,
// INPUT_TOO_LARGE), in source order. Pipeline (RESEARCH Pattern 6): comments, <script> and <style> out; waived
// leaves checked and out; data-claim leaves out (checkTagged verifies them); untagged headline values reported;
// every tag to a space; entities decoded; NFC; then UNIT_NUMBER. Every removal is same-length whitespace with
// newlines kept, so each finding carries its true source line.
export function scanHtml(text, file = '') {
  if (byteLength(text) > MAX_INPUT_BYTES) return [finding(file, 1, 'INPUT_TOO_LARGE', `larger than ${MAX_INPUT_BYTES} bytes`)];
  let src = String(text).normalize('NFC');
  const lineOf = lineIndex(src);
  src = blankRanges(src, blockRanges(src, /<!--/g, () => /-->/g));
  src = blankRanges(src, blockRanges(src, /<(script|style)\b[^<>]*>/gi, (m) => new RegExp(String.raw`</${m[1]}\s*>`, 'ig')));
  const waivers = waiverFindings(src, file, lineOf), out = [...waivers.findings];
  src = blankRanges(src, waivers.ranges);
  src = blankRanges(src, claimedRanges(src));
  const metrics = metricFindings(src, file, lineOf);
  out.push(...metrics.findings);
  src = blankRanges(src, metrics.ranges);
  const { text: visible, lineAt } = visibleText(src);
  for (const m of visible.matchAll(UNIT_NUMBER)) out.push(untagged(file, lineAt(m.index), m[0]));
  return out.sort((a, b) => a.line - b.line);
}

// A trailing `// claim-waiver: <reason>` exempts its line. A `//` starts a comment only at the start of the line or
// after whitespace, so the `//` of a URL inside a string survives.
const JS_WAIVER = /(?:^|\s)\/\/\s*claim-waiver\b(.*)$/;
const JS_LINE_COMMENT = /(?:^|\s)\/\//;
const JS_TAG = /<[A-Za-z/!][^<>]*>/g;
function dropBlockComments(line) {
  let out = '', at = 0;
  for (let a = line.indexOf('/*'); a !== -1; a = line.indexOf('/*', at)) {
    const b = line.indexOf('*/', a + 2);
    if (b === -1) break;
    out += `${line.slice(at, a)} `;
    at = b + 2;
  }
  return out + line.slice(at);
}

// scanJsLines(text, file) -> findings (UNTAGGED_NUMBER, WAIVER_NO_REASON, INPUT_TOO_LARGE) for the user-visible
// string literals of a demo module, line by line: waiver check, single-line block and // comments dropped,
// template-markup tags to spaces, entities decoded, then UNIT_NUMBER.
export function scanJsLines(text, file = '') {
  if (byteLength(text) > MAX_INPUT_BYTES) return [finding(file, 1, 'INPUT_TOO_LARGE', `larger than ${MAX_INPUT_BYTES} bytes`)];
  const out = [];
  String(text).normalize('NFC').split(/\r?\n/).forEach((raw, i) => {
    const w = JS_WAIVER.exec(raw);
    if (w) {
      const colon = /^\s*:/.test(w[1]), reason = w[1].replace(/^\s*:/, '');
      if (!colon || noReason(reason)) out.push(finding(file, i + 1, 'WAIVER_NO_REASON', `write // claim-waiver: <reason> with a reason the owner can review (got "${fold(reason)}")`));
      return;
    }
    let code = dropBlockComments(raw);
    const c = JS_LINE_COMMENT.exec(code);
    if (c) code = code.slice(0, c.index);
    code = decodeEntities(code.replace(JS_TAG, ' ')).replace(/\s+/g, ' ');
    for (const m of code.matchAll(UNIT_NUMBER)) out.push(finding(file, i + 1, 'UNTAGGED_NUMBER', `"${m[0]}" has a unit but no // claim-waiver: <reason> comment`));
  });
  return out;
}

// ---------- Schema ----------
export const CLAIM_KINDS = Object.freeze(['latency', 'throughput', 'memory', 'ratio', 'comparison', 'design_fact', 'test_count', 'observation']);
export const PERF_KINDS = Object.freeze(['latency', 'throughput', 'memory', 'ratio', 'comparison', 'observation']);
export const MEASURES = Object.freeze(['per_op_latency', 'amortized_per_op', 'throughput', 'heap_bytes', 'derived_ratio', 'request_wall_time']);
export const STATUSES = Object.freeze(['proposed', 'approved', 'retired']);
export const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BUILD_RE = /^(?:uninstrumented|instrumented:\S.*)$/;
const FACT_KINDS = Object.freeze(['design_fact', 'test_count']);
const isNil = (v) => v === null || v === undefined;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStrList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isInstrumented = (c) => typeof c?.build === 'string' && c.build.startsWith('instrumented:');
function validDate(s) {
  const m = DATE_RE.exec(typeof s === 'string' ? s : '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
// A repo-relative POSIX path that cannot climb out of the repo (evidence is read below a root directory).
const safePath = (p) => isStr(p) && !p.startsWith('/') && !p.includes('\\') && !/^[A-Za-z]:/.test(p)
  && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
// Number of capture groups; throws when the pattern does not compile.
function captureGroups(pattern) {
  new RegExp(pattern);
  return new RegExp(`(?:${pattern})|`).exec('').length - 1;
}

// locateClaims(text, claims) -> line of each claim's "id" in the claims file text (1 when unknown).
export function locateClaims(text, claims) {
  const found = new Map();
  if (typeof text === 'string') {
    const from = Math.max(0, text.search(/"claims"\s*:\s*\[/)), lineOf = lineIndex(text);
    const re = /"id"\s*:\s*"((?:[^"\\\n]|\\.)*)"/g;
    re.lastIndex = from;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      let id;
      try { id = JSON.parse(`"${m[1]}"`); } catch { continue; /* not a JSON string; cannot be a claim id */ }
      if (!found.has(id)) found.set(id, []);
      found.get(id).push(lineOf(m.index));
    }
  }
  const seen = new Map();
  return claims.map((c) => {
    const id = c?.id, k = seen.get(id) ?? 0;
    seen.set(id, k + 1);
    return found.get(id)?.[k] ?? 1;
  });
}

function claimFindings(c, i, ctx) {
  const name = typeof c?.id === 'string' && c.id ? c.id : `claims[${i}]`, out = [];
  const bad = (code, msg) => out.push(finding(ctx.file, ctx.lines[i], code, `${name}: ${msg}`));
  const field = (msg) => bad('SCHEMA_FIELD', msg);
  if (!isObj(c)) { field('a claim must be an object'); return out; }

  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) field(`id "${c.id}" does not match ${ID_RE.source}`);
  else if (ctx.seen.has(c.id)) bad('SCHEMA_DUPLICATE_ID', 'duplicate id (ids are compared exactly)');
  else ctx.seen.add(c.id);
  if (!Object.hasOwn(ctx.repos, c.project)) field(`project "${c.project}" is not a key of repos`);
  if (!CLAIM_KINDS.includes(c.kind)) field(`kind "${c.kind}" is not one of ${CLAIM_KINDS.join(', ')}`);
  if (!STATUSES.includes(c.status)) field(`status "${c.status}" is not one of ${STATUSES.join(', ')}`);

  // D-02: only the owner approves. An approved entry names who and when; a proposed one carries neither.
  if (c.status === 'approved') {
    if (!isStr(c.approved_by)) bad('SCHEMA_APPROVAL', 'status approved needs a non-empty approved_by');
    if (!validDate(c.approved_on)) bad('SCHEMA_APPROVAL', 'status approved needs approved_on as a YYYY-MM-DD date');
  } else if (c.status === 'proposed' && !(isNil(c.approved_by) && isNil(c.approved_on))) {
    bad('SCHEMA_APPROVAL', 'a proposed claim must have approved_by and approved_on null (only the owner approves)');
  } else if (c.status === 'retired' && !isNil(c.approved_on) && !validDate(c.approved_on)) {
    bad('SCHEMA_APPROVAL', 'approved_on must be a YYYY-MM-DD date or null');
  }

  if (!isStr(c.statement)) field('statement must be a non-empty string');
  if (!isNum(c.value)) field('value must be a finite number');
  if (!isStr(c.unit)) field('unit must be a non-empty string');
  if (!isNil(c.label_required) && !isStr(c.label_required)) field('label_required must be a non-empty string or null');
  const display = isObj(c.display) ? c.display : null;
  if (!display || !isStrList(display.value)) field('display.value must be a list of strings');
  for (const k of ['spread', 'n', 'environment']) if (display && display[k] !== undefined && !isStrList(display[k])) field(`display.${k} must be a list of strings`);

  const perf = PERF_KINDS.includes(c.kind), cmp = c.kind === 'comparison', fact = FACT_KINDS.includes(c.kind);
  if (perf) {
    if (!MEASURES.includes(c.measure)) field(`measure "${c.measure}" is not one of ${MEASURES.join(', ')}`);
    if (typeof c.build !== 'string' || !BUILD_RE.test(c.build)) field(`build "${c.build}" must be uninstrumented or instrumented:<what>`);
    else if (isInstrumented(c) && !isStr(c.label_required)) field('an instrumented build needs label_required (BENCH-06)');
  }
  if (perf && !cmp) {
    if (!Object.hasOwn(ctx.environments, c.environment)) field(`environment "${c.environment}" is not a key of environments`);
    if (!isStr(c.stat)) field('stat must name the stats key that gives value');
    if (!Number.isInteger(c.n) || c.n < 1) field(`n must be an integer >= 1 (got ${JSON.stringify(c.n)})`);
    const s = c.spread;
    if (!isObj(s) || !Object.hasOwn(SPREAD_KEYS, s.kind) || !isNum(s.low) || !isNum(s.high) || s.low > s.high) {
      field(`spread must be { kind: ${Object.keys(SPREAD_KEYS).join(' | ')}, low, high } with low <= high`);
    }
  }
  if ((perf && !cmp) || fact) {
    const ev = isObj(c.evidence) ? c.evidence : {};
    if (!Object.hasOwn(ctx.repos, ev.repo)) field(`evidence.repo "${ev.repo}" is not a key of repos`);
    if (!SHA_RE.test(ev.sha ?? '')) field('evidence.sha must be 40 lowercase hex characters');
    if (!safePath(ev.path)) field(`evidence.path "${ev.path}" must be a repo-relative path without . or .. segments`);
    if (!SHA_RE.test(c.source_sha ?? '')) field('source_sha must be 40 lowercase hex characters');
    if (perf && (typeof ev.pointer !== 'string' || (ev.pointer !== '' && !ev.pointer.startsWith('/')))) {
      field('evidence.pointer must be an RFC 6901 pointer to a stats object');
    }
    if (fact) {
      let groups = -1;
      try { groups = captureGroups(String(ev.pattern ?? '')); } catch { field('evidence.pattern does not compile as a regular expression'); }
      if (groups !== -1 && (typeof ev.pattern !== 'string' || groups !== 1)) field(`evidence.pattern must have exactly one capture group (has ${groups})`);
      if (c.stat !== undefined && c.stat !== 'value') field('stat must be "value" for a design_fact or test_count');
    }
  }
  if (cmp) {
    const ids = c.compare;
    if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1] || ids.includes(c.id) || !ids.every((id) => ctx.ids.has(id))) {
      field('compare must name two other, different claims in this file');
    }
    if (c.cause !== undefined && (!isObj(c.cause) || !isStr(c.cause.text) || typeof c.cause.verified !== 'boolean')) {
      field('cause must be { text, verified }');
    }
  }

  // Every display string must round to the stored full-precision value (BENCH-03). Comparisons are checked by checkComparison.
  if (display && !cmp && isNum(c.value)) {
    for (const s of isStrList(display.value) ? display.value : []) if (!matchesDisplay(c.value, s)) field(`display.value "${s}" does not round to value ${c.value}`);
    for (const s of isStrList(display.spread) ? display.spread : []) if (!matchesRange(c.spread?.low, c.spread?.high, s)) field(`display.spread "${s}" does not round to spread ${c.spread?.low}..${c.spread?.high}`);
    for (const s of isStrList(display.n) ? display.n : []) if (!matchesDisplay(c.n, s)) field(`display.n "${s}" does not round to n ${c.n}`);
  }
  return out;
}

// validateClaims(doc, { text }) -> findings (SCHEMA_*) for bench/claims.json. `text` (optional) gives line numbers.
export function validateClaims(doc, { text, file = CLAIMS_FILE } = {}) {
  const out = [], top = (msg) => out.push(finding(file, 1, 'SCHEMA_FIELD', msg));
  if (!isObj(doc)) { top('the top level must be an object'); return out; }
  if (doc.schema_version !== 1) top(`schema_version must be 1 (got ${JSON.stringify(doc.schema_version)})`);
  for (const key of ['repos', 'page_repos', 'environments']) if (!isObj(doc[key])) top(`${key} must be an object`);
  for (const key of ['tables', 'claims']) if (!Array.isArray(doc[key])) top(`${key} must be an array`);
  const repos = isObj(doc.repos) ? doc.repos : {}, environments = isObj(doc.environments) ? doc.environments : {};
  for (const [name, r] of Object.entries(repos)) {
    if (!isObj(r) || !isStr(r.owner) || !isStr(r.default_branch) || !isStr(r.local)) top(`repos.${name} needs owner, default_branch and local`);
  }
  for (const [page, repo] of Object.entries(isObj(doc.page_repos) ? doc.page_repos : {})) {
    if (!Object.hasOwn(repos, repo)) top(`page_repos.${page} names unknown repo "${repo}"`);
  }
  for (const [key, e] of Object.entries(environments)) if (!isObj(e) || !isStr(e.label)) top(`environments.${key} needs a label`);
  const claims = Array.isArray(doc.claims) ? doc.claims : [];
  const ctx = { file, repos, environments, lines: locateClaims(text, claims), seen: new Set(),
    ids: new Set(claims.filter(isObj).map((c) => c.id)) };
  claims.forEach((c, i) => out.push(...claimFindings(c, i, ctx)));
  return out;
}

// ---------- Labels ----------
const lowerFold = (s) => fold(String(s).normalize('NFC').toLowerCase());
const LATENCY_WORD = /\blatenc(?:y|ies)\b/;

// checkLabels(claim, contextText) -> [{ code, message }]. contextText is the text of the element, table row or
// line that displays the claim. BENCH-05: an amortized time is never called latency. BENCH-06: an instrumented
// result always shows its label_required phrase (fails closed when the claim names none).
export function checkLabels(claim, contextText) {
  const out = [], t = lowerFold(contextText ?? '');
  if (claim.measure === 'amortized_per_op' && LATENCY_WORD.test(t)) {
    out.push({ code: 'LABEL_LATENCY_WORDING', message: `${claim.id}: an amortized per-op time is shown with the word latency; call it time per call, amortized` });
  }
  if (isInstrumented(claim) && !(isStr(claim.label_required) && t.includes(lowerFold(claim.label_required)))) {
    out.push({ code: 'LABEL_INSTRUMENTED_MISSING', message: `${claim.id}: ${claim.build} result shown without its label "${claim.label_required ?? ''}"` });
  }
  return out;
}

// ---------- Comparison ----------
const NO_DIFFERENCE = 'no measurable difference';
const RATIO = new RegExp(String.raw`(?<![A-Za-z0-9_.,])(\d[\d,]*(?:\.\d+)?)\s?(?:\u00d7|x)(?![A-Za-z0-9])`);
const ratioIn = (s) => { const m = RATIO.exec(fold(s)); return m ? parseDisplayNumber(m[1]) : null; };

// checkComparison(claim, claimsById, { environments }) -> findings (COMPARISON_INVALID). D-14: both compared
// claims give medians over n >= 5 runs with min-max spreads; a difference may be shown only when the two
// ranges are disjoint (touching ranges overlap), as the ratio of medians naming the faster environment.
export function checkComparison(claim, claimsById, { environments = {}, file = CLAIMS_FILE, line = 1 } = {}) {
  const out = [], bad = (msg) => out.push(finding(file, line, 'COMPARISON_INVALID', `${claim.id}: ${msg}`));
  const ids = Array.isArray(claim.compare) ? claim.compare : [];
  if (ids.length !== 2 || ids[0] === ids[1]) { bad('compare must name two different claims'); return out; }
  const [a, b] = ids.map((id) => lookup(claimsById, id));
  if (!a || !b) { bad(`compare names an unknown claim (${ids.filter((id) => !lookup(claimsById, id)).join(', ')})`); return out; }
  for (const c of [a, b]) {
    if (c.spread?.kind !== 'min-max' || !isNum(c.spread.low) || !isNum(c.spread.high)) bad(`${c.id} must use spread kind min-max (the range of run-level values)`);
    if (!Number.isInteger(c.n) || c.n < 5) bad(`${c.id} has n ${c.n}; a comparison needs n >= 5 for both claims`);
    if (c.stat !== 'median' || !isNum(c.value) || c.value <= 0) bad(`${c.id} must give a positive median (stat median)`);
    if (claim.status === 'approved' && c.status !== 'approved') bad(`${c.id} is not approved`);
  }
  if (a.unit !== b.unit || a.measure !== b.measure) bad('compared claims must share unit and measure');
  if ((a.build !== b.build || isInstrumented(a) || isInstrumented(b)) && !isInstrumented(claim)) {
    bad('an instrumented result is compared; the comparison build must be instrumented:<what> so its label is shown (BENCH-06)');
  }
  if (isObj(claim.cause) && claim.cause.verified !== true && !/\bhypothes[ie]s\b/i.test(String(claim.cause.text))) {
    bad('an unverified cause must be labelled a hypothesis');
  }
  const shown = isStrList(claim.display?.value) ? claim.display.value : [];
  if (!shown.length) bad('display.value is empty');
  if (out.length) return out;

  const disjoint = a.spread.high < b.spread.low || b.spread.high < a.spread.low;
  if (!disjoint) {
    for (const s of shown) if (!lowerFold(s).includes(NO_DIFFERENCE)) bad(`ranges overlap, so display must say "${NO_DIFFERENCE}" (got "${s}")`);
    return out;
  }
  const higherWins = a.measure === 'throughput';
  const win = (higherWins ? a.value > b.value : a.value < b.value) ? a : b;
  const ratio = Math.max(a.value, b.value) / Math.min(a.value, b.value);
  if (!isNum(claim.value) || Math.abs(claim.value - ratio) > 1e-9 * ratio) bad(`value ${claim.value} is not the ratio of medians ${ratio}`);
  const names = [win.environment, environments[win.environment]?.label].filter(isStr).map(lowerFold);
  for (const s of shown) {
    const t = lowerFold(s), r = ratioIn(s);
    if (t.includes(NO_DIFFERENCE)) bad(`ranges are disjoint; "${s}" may not say "${NO_DIFFERENCE}"`);
    if (a.environment !== b.environment && !names.some((n) => t.includes(n))) bad(`"${s}" must name the faster environment (${names.join(' or ')})`);
    if (!r || !within(r, ratio)) bad(`"${s}" must give the ratio of medians (${ratio.toPrecision(4)}\u00d7)`);
    for (const f of checkLabels(claim, s)) bad(f.message);
  }
  return out;
}

// ---------- Results ----------
/* Evidence contracts written by the upstream runners (bench/run_bench.py, plans 02-07 to 02-09) and read
   through claim pointers. Layout (D-11): bench/results/<YYYY-MM-DD>-<sha7>[-<tag>]/<env>/{meta.json,summary.json,raw/}
   where <env> is windows-native or ubuntu-wsl2. All files are LF; raw files are hashed byte for byte.

   bench-meta/1 (meta.json). Every field is required and non-null unless noted.
   - schema "bench-meta/1"; project (string); environment_id (windows-native | ubuntu-wsl2, equal to the <env>
     directory name); date_utc (ISO 8601 UTC, "2026-11-12T18:03:11Z", fractional seconds allowed);
     session_date (YYYY-MM-DD, the date in the session directory name); tag (string or null: the optional
     -<tag> suffix of the session directory name, [A-Za-z0-9][A-Za-z0-9._-]*)
   - source { repo "BrianKYildirim/<repo>", sha (40 lowercase hex, the code measured), dirty (bool),
     untracked (array of paths), describe (git describe output) }
   - command: non-empty array of strings; repo-relative paths only (no absolute path, no home directory)
   - hardware { cpu_model (never matching /Family \d+ Model/, the platform.processor() text on Windows),
     physical_cores, logical_cpus, memory_bytes (positive integers) }
   - os { family, name, build (strings), kernel (string; required for ubuntu-wsl2, null allowed for
     windows-native), wsl ({ version, wslconfig: null | object } for ubuntu-wsl2, null for windows-native) }
   - power { ac_line (bool, or null with a non-empty power.note when it cannot be observed), scheme }
   - toolchain: C++ { compiler_id, compiler_version, generator, build_type, cxx_flags_release (strings),
     cmake_options (array of strings) } or Python { version, implementation, build, executable_name
     (a bare name, no path), packages (object: name -> version string, may be empty) }
   - library (object, may be empty); instrumentation (string: "none" or the instrumented variants in this run)
   - workload (non-empty object: harness parameters verbatim)
   - timer { name, resolution_ns (> 0), overhead_ns (>= 0, or null when not applicable) }
   - load { loadavg_1m_start, loadavg_1m_end (>= 0; null only for windows-native), cpu_busy_pct_start,
     cpu_busy_pct_end (0..100; null only for ubuntu-wsl2) }
   - validity { valid (bool), reasons (array of strings, non-empty when valid is false) }
   - raw_files: non-empty array of { path ("raw/..."), bytes, sha256 (64 lowercase hex) }, sorted by path in
     byte order (UTF-8 bytes, i.e. Python's sorted()), and listing every file under raw/
   - notes (array of strings)

   bench-summary/1 (summary.json).
   - schema "bench-summary/1"; project (equal to meta.project); environment_id (equal to meta's);
     source_sha (equal to meta source.sha); policy { quantile_method "inclusive", runs (integer >= 1),
     warmup, outliers }; generated_from (non-empty, sorted raw paths, each listed in meta raw_files)
   - Any nested object holding `n` and `median` is a stats object: n (integer >= 1), values (the n run-level
     values in run order), median, min, max, p25, p75, unit, measure (MEASURES), build (uninstrumented |
     instrumented:<what>); min <= p25 <= median <= p75 <= max. median, min, max, p25 and p75 must equal a
     recomputation from values within relative 1e-12: median as statistics.median; p25/p75 as
     statistics.quantiles(values, n=4, method="inclusive"), i.e. for sorted d of length L, m = L - 1,
     cut i of 3 is (d[j] * (4 - delta) + d[j + 1] * delta) / 4 with j, delta = divmod(i * m, 4).
     When L = 1 all five equal the single value.
   - A stats object with measure per_op_latency also carries percentile (the per-operation percentile its
     run-level values represent: 50, 90, 95, 99 or 99.9), optionally pooled (that percentile over all pooled
     samples) and samples (pooled sample count). Within one parent object the per_op_latency children must
     include percentiles 50 and 99 (BENCH-03; rl_latency reports p90 where the others report p95).
   - Optional tests { passed, failed, skipped, total } (integers, total = passed + failed + skipped) and
     derived { <name>: stats object with measure derived_ratio }. */
export const ENVIRONMENTS = Object.freeze(['windows-native', 'ubuntu-wsl2']);
export const META_SCHEMA = 'bench-meta/1';
export const SUMMARY_SCHEMA = 'bench-summary/1';
const STAT_KEYS = Object.freeze(['median', 'min', 'max', 'p25', 'p75']);
const REL_TOL = 1e-12;
const UTF8 = new TextEncoder();
const SHA256_RE = /^[0-9a-f]{64}$/;
const UTC_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO_RE = /^BrianKYildirim\/[A-Za-z0-9._-]+$/;
const SESSION_RE = /^(\d{4}-\d{2}-\d{2})-([0-9a-f]{7})(?:-([A-Za-z0-9][A-Za-z0-9._-]*))?$/;
const CPU_MODEL_BAD = /Family \d+ Model/;   // platform.processor() text on Windows (RESEARCH Pitfall 3)
// A command word that is an absolute path (at its start or after =), or that names a home directory anywhere.
const ABS_WORD = /(?:^|=)(?:[A-Za-z]:[\\/]|[\\/])/;
const HOME_WORD = /(?:^|[=\s,;:])(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/|\/Users\/|\/root\/)/i;
const PERCENTILES = Object.freeze([50, 90, 95, 99, 99.9]);
const isPosInt = (v) => Number.isSafeInteger(v) && v >= 1;
const isNonNeg = (v) => isNum(v) && v >= 0;
const sameNumber = (a, b) => a === b || (isNum(a) && isNum(b) && Math.abs(a - b) <= REL_TOL * Math.max(Math.abs(a), Math.abs(b)));
const escPointer = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined), obj);
// Byte order of the UTF-8 encodings (= code point order, which is what Python's sorted() gives for str).
function byteOrder(a, b) {
  const x = UTF8.encode(a), y = UTF8.encode(b), n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
// Index of the first entry not strictly after its predecessor; -1 when sorted without duplicates.
const unsortedAt = (list) => list.findIndex((p, i) => i > 0 && byteOrder(list[i - 1], p) >= 0);
const has = (obj, dotted) => {
  const keys = dotted.split('.'), last = keys.pop(), parent = keys.length ? get(obj, keys.join('.')) : obj;
  return isObj(parent) && Object.hasOwn(parent, last);
};

// recomputeStats(values) -> { median, min, max, p25, p75 } exactly as Python's statistics module computes them.
export function recomputeStats(values) {
  const d = [...values].sort((a, b) => a - b), L = d.length;
  if (!L) return null;
  if (L === 1) return { median: d[0], min: d[0], max: d[0], p25: d[0], p75: d[0] };
  const median = L % 2 ? d[(L - 1) / 2] : (d[L / 2 - 1] + d[L / 2]) / 2, m = L - 1;
  const cut = (i) => { const j = Math.floor((i * m) / 4), delta = i * m - j * 4; return (d[j] * (4 - delta) + d[j + 1] * delta) / 4; };
  return { median, min: d[0], max: d[L - 1], p25: cut(1), p75: cut(3) };
}

// validateMeta(meta, envDirName) -> findings (RESULTS_META_FIELD, RESULTS_ENV_MISMATCH, RESULTS_EMPTY).
export function validateMeta(meta, envDirName, { file = 'meta.json' } = {}) {
  const out = [], at = (code, msg) => out.push(finding(file, 1, code, msg)), field = (msg) => at('RESULTS_META_FIELD', msg);
  if (!isObj(meta)) { field('meta.json must be a JSON object'); return out; }
  if (meta.schema !== META_SCHEMA) field(`schema must be "${META_SCHEMA}" (got ${JSON.stringify(meta.schema)})`);
  const env = meta.environment_id, win = env === 'windows-native', wsl = env === 'ubuntu-wsl2';
  if (!ENVIRONMENTS.includes(env)) field(`environment_id ${JSON.stringify(env)} is not one of ${ENVIRONMENTS.join(', ')}`);
  if (envDirName !== undefined && env !== envDirName) at('RESULTS_ENV_MISMATCH', `environment_id ${JSON.stringify(env)} does not match its directory "${envDirName}"`);

  const str = (k) => { if (!isStr(get(meta, k))) field(`${k} must be a non-empty string (got ${JSON.stringify(get(meta, k))})`); };
  const posInt = (k) => { if (!isPosInt(get(meta, k))) field(`${k} must be a positive integer (got ${JSON.stringify(get(meta, k))})`); };
  const obj = (k) => { if (!isObj(get(meta, k))) field(`${k} must be an object`); return isObj(get(meta, k)); };
  const present = (k) => { if (!has(meta, k)) field(`${k} is missing (write null where null is allowed)`); return has(meta, k); };

  str('project');
  const utc = UTC_RE.exec(typeof meta.date_utc === 'string' ? meta.date_utc : '');
  if (!utc || !validDate(utc[1])) field(`date_utc must be an ISO 8601 UTC time such as 2026-11-12T18:03:11Z (got ${JSON.stringify(meta.date_utc)})`);
  if (!validDate(meta.session_date)) field(`session_date must be a YYYY-MM-DD date (got ${JSON.stringify(meta.session_date)})`);
  if (present('tag') && meta.tag !== null && !(typeof meta.tag === 'string' && TAG_RE.test(meta.tag))) field(`tag must be null or match ${TAG_RE.source}`);

  if (obj('source')) {
    if (!REPO_RE.test(String(meta.source.repo ?? ''))) field(`source.repo must be BrianKYildirim/<repo> (got ${JSON.stringify(meta.source.repo)})`);
    if (!SHA_RE.test(String(meta.source.sha ?? ''))) field('source.sha must be 40 lowercase hex characters');
    if (typeof meta.source.dirty !== 'boolean') field('source.dirty must be true or false');
    if (!isStrList(meta.source.untracked)) field('source.untracked must be an array of paths');
    str('source.describe');
  }
  if (!Array.isArray(meta.command) || !meta.command.length || !meta.command.every(isStr)) field('command must be a non-empty array of non-empty strings');
  else meta.command.forEach((w, i) => {
    if (ABS_WORD.test(w) || HOME_WORD.test(w)) field(`command[${i}] ${JSON.stringify(w)} must be repo-relative (no absolute or home directory path)`);
  });

  if (obj('hardware')) {
    str('hardware.cpu_model');
    if (CPU_MODEL_BAD.test(String(meta.hardware.cpu_model ?? ''))) {
      field(`hardware.cpu_model ${JSON.stringify(meta.hardware.cpu_model)} is the platform.processor() text; record the processor name (ProcessorNameString, /proc/cpuinfo model name)`);
    }
    for (const k of ['physical_cores', 'logical_cpus', 'memory_bytes']) posInt(`hardware.${k}`);
  }
  if (obj('os')) {
    for (const k of ['family', 'name', 'build']) str(`os.${k}`);
    if (present('os.kernel') && !(win && meta.os.kernel === null)) str('os.kernel');
    if (present('os.wsl')) {
      if (win && meta.os.wsl !== null) field('os.wsl must be null for windows-native');
      else if (!win && !isObj(meta.os.wsl)) field(`os.wsl must be an object { version, wslconfig } for ${env}`);
      else if (isObj(meta.os.wsl)) {
        str('os.wsl.version');
        const c = meta.os.wsl.wslconfig;
        if (!has(meta, 'os.wsl.wslconfig') || !(c === null || isObj(c))) field('os.wsl.wslconfig must be null (no .wslconfig) or an object');
      }
    }
  }
  if (obj('power')) {
    if (present('power.ac_line') && typeof meta.power.ac_line !== 'boolean') {
      if (meta.power.ac_line !== null) field('power.ac_line must be true, false or null');
      else if (!isStr(meta.power.note)) field('power.ac_line is null, so power.note must say why it cannot be observed');
    }
    str('power.scheme');
  }
  if (obj('toolchain')) {
    const t = meta.toolchain;
    if (Object.hasOwn(t, 'compiler_id')) {
      for (const k of ['compiler_id', 'compiler_version', 'generator', 'build_type', 'cxx_flags_release']) str(`toolchain.${k}`);
      if (!isStrList(t.cmake_options)) field('toolchain.cmake_options must be an array of strings');
    } else if (Object.hasOwn(t, 'implementation')) {
      for (const k of ['version', 'implementation', 'build', 'executable_name']) str(`toolchain.${k}`);
      if (/[\\/]/.test(String(t.executable_name ?? ''))) field('toolchain.executable_name must be a bare name, not a path');
      if (!isObj(t.packages) || !Object.values(t.packages).every(isStr)) field('toolchain.packages must be an object of name -> version strings');
    } else field('toolchain must be the C++ shape (compiler_id, ...) or the Python shape (implementation, ...)');
  }
  obj('library');
  str('instrumentation');
  if (!isObj(meta.workload) || !Object.keys(meta.workload).length) field('workload must be a non-empty object');
  if (obj('timer')) {
    str('timer.name');
    if (!(isNum(meta.timer.resolution_ns) && meta.timer.resolution_ns > 0)) field('timer.resolution_ns must be a number > 0');
    if (present('timer.overhead_ns') && meta.timer.overhead_ns !== null && !isNonNeg(meta.timer.overhead_ns)) field('timer.overhead_ns must be a number >= 0 or null');
  }
  if (obj('load')) {
    for (const k of ['loadavg_1m_start', 'loadavg_1m_end', 'cpu_busy_pct_start', 'cpu_busy_pct_end']) {
      if (!present(`load.${k}`)) continue;
      const v = meta.load[k], busy = k.startsWith('cpu_busy');
      if (v === null) { if (busy ? !wsl : !win) field(`load.${k} is null; it may be null only for ${busy ? 'ubuntu-wsl2' : 'windows-native'}`); }
      else if (!isNonNeg(v) || (busy && v > 100)) field(`load.${k} must be a number ${busy ? 'from 0 to 100' : '>= 0'}`);
    }
  }
  if (obj('validity')) {
    if (typeof meta.validity.valid !== 'boolean') field('validity.valid must be true or false');
    if (!isStrList(meta.validity.reasons)) field('validity.reasons must be an array of strings');
    else if (meta.validity.valid === false && !meta.validity.reasons.length) field('validity.valid is false, so validity.reasons must say why');
  }
  if (!Array.isArray(meta.raw_files)) field('raw_files must be an array');
  else if (!meta.raw_files.length) at('RESULTS_EMPTY', 'raw_files is empty; every result needs its raw harness output');
  else meta.raw_files.forEach((r, i) => {
    if (!isObj(r) || !safePath(r.path) || !r.path.startsWith('raw/')) field(`raw_files[${i}].path must be a safe path under raw/ (got ${JSON.stringify(r?.path)})`);
    if (!Number.isSafeInteger(r?.bytes) || r.bytes < 0) field(`raw_files[${i}].bytes must be an integer >= 0`);
    if (!SHA256_RE.test(String(r?.sha256 ?? ''))) field(`raw_files[${i}].sha256 must be 64 lowercase hex characters`);
  });
  if (Array.isArray(meta.raw_files) && meta.raw_files.every((r) => typeof r?.path === 'string')) {
    const i = unsortedAt(meta.raw_files.map((r) => r.path));
    if (i !== -1) at('RESULTS_UNSORTED', `raw_files must be sorted by path in byte order without duplicates ("${meta.raw_files[i].path}" follows "${meta.raw_files[i - 1].path}")`);
  }
  if (!isStrList(meta.notes)) field('notes must be an array of strings');
  return out;
}

const isStats = (o) => isObj(o) && Object.hasOwn(o, 'n') && Object.hasOwn(o, 'median');
function walkSummary(node, ptr, visit, depth = 0) {
  if (depth > 64) return;
  if (Array.isArray(node)) { node.forEach((v, i) => walkSummary(v, `${ptr}/${i}`, visit, depth + 1)); return; }
  if (!isObj(node)) return;
  if (isStats(node)) { visit.stats(node, ptr); return; }
  visit.parent(node, ptr);
  for (const [k, v] of Object.entries(node)) walkSummary(v, `${ptr}/${escPointer(k)}`, visit, depth + 1);
}

function statsFindings(s, ptr, bad) {
  const where = ptr || '/';
  // BENCH-05/06: every stats object says what kind of number it is and which build produced it.
  if (!MEASURES.includes(s.measure)) bad(`${where}: measure ${JSON.stringify(s.measure)} is not one of ${MEASURES.join(', ')}`);
  if (typeof s.build !== 'string' || !BUILD_RE.test(s.build)) bad(`${where}: build ${JSON.stringify(s.build)} must be uninstrumented or instrumented:<what>`);
  if (s.measure === 'per_op_latency') {
    if (!PERCENTILES.includes(s.percentile)) bad(`${where}: a per_op_latency stats object needs percentile (one of ${PERCENTILES.join(', ')})`);
    if (s.pooled !== undefined && !isNum(s.pooled)) bad(`${where}: pooled must be a number`);
    if (s.samples !== undefined && !isPosInt(s.samples)) bad(`${where}: samples must be an integer >= 1`);
  }
  if (!isPosInt(s.n)) { bad(`${where}: n must be an integer >= 1`); return; }
  if (!Array.isArray(s.values) || s.values.length !== s.n || !s.values.every(isNum)) { bad(`${where}: values must hold the n = ${s.n} run-level values`); return; }
  if (!isStr(s.unit)) bad(`${where}: unit must be a non-empty string`);
  if (STAT_KEYS.every((k) => isNum(s[k])) && !(s.min <= s.p25 && s.p25 <= s.median && s.median <= s.p75 && s.p75 <= s.max)) {
    bad(`${where}: stats must satisfy min <= p25 <= median <= p75 <= max`);
  }
  const want = recomputeStats(s.values);
  for (const k of STAT_KEYS) {
    if (!isNum(s[k])) bad(`${where}: ${k} must be a number`);
    else if (!sameNumber(s[k], want[k])) bad(`${where}: ${k} ${s[k]} != ${want[k]} recomputed from values (inclusive quantiles)`);
  }
}

// BENCH-03: where per-operation latency applies, a group reports p50 and p99 (and p95, or p90 for rl_latency).
function latencyGroupFindings(node, ptr, bad) {
  const ps = Object.values(node).filter((c) => isStats(c) && c.measure === 'per_op_latency').map((c) => c.percentile);
  if (!ps.length) return;
  if (!ps.includes(50) || !ps.includes(99)) bad(`${ptr || '/'}: per_op_latency percentiles ${ps.join(', ')} must include 50 and 99`);
  if (new Set(ps).size !== ps.length) bad(`${ptr || '/'}: per_op_latency percentiles ${ps.join(', ')} repeat`);
}

// validateSummary(summary, meta) -> findings (RESULTS_SUMMARY, RESULTS_ENV_MISMATCH). meta may be null.
export function validateSummary(summary, meta, { file = 'summary.json' } = {}) {
  const out = [], at = (code, msg) => out.push(finding(file, 1, code, msg)), bad = (msg) => at('RESULTS_SUMMARY', msg);
  if (!isObj(summary)) { bad('summary.json must be a JSON object'); return out; }
  const m = isObj(meta) ? meta : null;
  if (summary.schema !== SUMMARY_SCHEMA) bad(`schema must be "${SUMMARY_SCHEMA}" (got ${JSON.stringify(summary.schema)})`);
  if (!isStr(summary.project)) bad('project must be a non-empty string');
  else if (m && summary.project !== m.project) bad(`project "${summary.project}" != meta.json project "${m.project}"`);
  if (m && summary.environment_id !== m.environment_id) at('RESULTS_ENV_MISMATCH', `environment_id ${JSON.stringify(summary.environment_id)} != meta.json environment_id ${JSON.stringify(m.environment_id)}`);
  if (!SHA_RE.test(String(summary.source_sha ?? ''))) bad('source_sha must be 40 lowercase hex characters');
  else if (m && summary.source_sha !== m.source?.sha) bad(`source_sha ${summary.source_sha} != meta.json source.sha ${m.source?.sha}`);
  const p = summary.policy;
  if (!isObj(p)) bad('policy must be an object');
  else {
    if (p.quantile_method !== 'inclusive') bad(`policy.quantile_method must be "inclusive" (got ${JSON.stringify(p.quantile_method)})`);
    if (!isPosInt(p.runs)) bad('policy.runs must be an integer >= 1');
    for (const k of ['warmup', 'outliers']) if (isNil(p[k]) || p[k] === '') bad(`policy.${k} must be stated`);
  }
  const listed = new Set(Array.isArray(m?.raw_files) ? m.raw_files.map((r) => r?.path) : []);
  if (!isStrList(summary.generated_from) || !summary.generated_from.length) bad('generated_from must be a non-empty array of raw paths');
  else {
    if (m) for (const g of summary.generated_from) if (!listed.has(g)) bad(`generated_from "${g}" is not listed in meta.json raw_files`);
    const i = unsortedAt(summary.generated_from);
    if (i !== -1) at('RESULTS_UNSORTED', `generated_from must be sorted in byte order without duplicates ("${summary.generated_from[i]}" follows "${summary.generated_from[i - 1]}")`);
  }
  const t = summary.tests;
  if (t !== undefined) {
    if (!isObj(t) || !['passed', 'failed', 'skipped', 'total'].every((k) => Number.isSafeInteger(t[k]) && t[k] >= 0)) bad('tests must be { passed, failed, skipped, total } with integers >= 0');
    else if (t.passed + t.failed + t.skipped !== t.total) bad(`tests: passed ${t.passed} + failed ${t.failed} + skipped ${t.skipped} != total ${t.total}`);
  }
  if (summary.derived !== undefined) {
    if (!isObj(summary.derived)) bad('derived must be an object of stats objects');
    else for (const [k, v] of Object.entries(summary.derived)) {
      if (!isStats(v) || v.measure !== 'derived_ratio') bad(`/derived/${escPointer(k)}: a derived entry must be a stats object with measure derived_ratio`);
    }
  }

  let count = 0;
  walkSummary(summary, '', { stats: (s, ptr) => { count += 1; statsFindings(s, ptr, bad); }, parent: (node, ptr) => latencyGroupFindings(node, ptr, bad) });
  if (!count) bad('summary.json holds no stats object');
  return out;
}

// ---------- Results directories ----------
const joinPath = (a, b) => (/[\\/]$/.test(a) ? `${a}${b}` : `${a}/${b}`);
const segments = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
const bytesOf = (x) => (typeof x === 'string' ? UTF8.encode(x) : x);

async function readJson(readFile, p, label, code) {
  let buf;
  try {
    buf = bytesOf(await readFile(p));
  } catch (err) {
    return { doc: null, findings: [finding(label, 1, code, err?.code === 'ENOENT' ? 'file is missing' : `cannot read (${err?.code ?? err?.message})`)] };
  }
  if (buf.length > MAX_INPUT_BYTES) return { doc: null, findings: [finding(label, 1, 'INPUT_TOO_LARGE', `larger than ${MAX_INPUT_BYTES} bytes`)] };
  try {
    return { doc: JSON.parse(new TextDecoder().decode(buf)), findings: [] };
  } catch (err) {
    return { doc: null, findings: [finding(label, 1, code, `not valid JSON (${err.message})`)] };
  }
}

async function listFiles(readdir, dir, rel, depth = 0) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) { if (depth < 8) out.push(...await listFiles(readdir, joinPath(dir, e.name), r, depth + 1)); } else out.push(r);
  }
  return out;
}

// The session directory above <env> is <YYYY-MM-DD>-<sha7>[-<tag>]: meta session_date, source.sha and tag.
function dirNameFindings(dir, meta, file) {
  const name = segments(dir).at(-2) ?? '', m = SESSION_RE.exec(name), bad = (msg) => [finding(file, 1, 'RESULTS_DIR_NAME', msg)];
  if (!m) return bad(`session directory "${name}" must be named <YYYY-MM-DD>-<sha7>[-<tag>]`);
  const sha7 = String(meta.source?.sha ?? '').slice(0, 7), tag = isNil(meta.tag) ? null : meta.tag;
  if (m[1] !== meta.session_date) return bad(`session directory "${name}" has date ${m[1]} but session_date is ${JSON.stringify(meta.session_date)}`);
  if (m[2] !== sha7) return bad(`session directory "${name}" has sha ${m[2]} but source.sha starts ${sha7}`);
  if ((m[3] ?? null) !== tag) return bad(`session directory "${name}" has tag ${JSON.stringify(m[3] ?? null)} but meta tag is ${JSON.stringify(tag)}`);
  return [];
}

// One <env> directory: meta.json, summary.json and the sha256 of every raw file over its exact bytes.
async function envFindings(dir, label, { readFile, readdir }) {
  const metaLabel = `${label}/meta.json`, out = [];
  const meta = await readJson(readFile, joinPath(dir, 'meta.json'), metaLabel, 'RESULTS_META_FIELD');
  const summary = await readJson(readFile, joinPath(dir, 'summary.json'), `${label}/summary.json`, 'RESULTS_SUMMARY');
  out.push(...meta.findings, ...summary.findings);
  if (meta.doc) out.push(...validateMeta(meta.doc, segments(dir).pop(), { file: metaLabel }), ...dirNameFindings(dir, meta.doc, metaLabel));
  if (summary.doc) out.push(...validateSummary(summary.doc, meta.doc, { file: `${label}/summary.json` }));

  let onDisk = [];
  try { onDisk = await listFiles(readdir, joinPath(dir, 'raw'), 'raw'); } catch { /* a missing raw/ is reported as empty below */ }
  if (!onDisk.length) out.push(finding(`${label}/raw`, 1, 'RESULTS_EMPTY', 'raw/ is missing or empty; every result needs its raw harness output'));
  const listed = Array.isArray(meta.doc?.raw_files) ? meta.doc.raw_files.filter((r) => isObj(r) && safePath(r.path)) : [];
  const names = new Set(listed.map((r) => r.path));
  for (const f of onDisk) if (!names.has(f)) out.push(finding(metaLabel, 1, 'RESULTS_HASH', `${f} is under raw/ but not listed (and hashed) in raw_files`));
  for (const r of listed) {
    let buf;
    try {
      buf = bytesOf(await readFile(joinPath(dir, r.path)));
    } catch (err) {
      out.push(finding(metaLabel, 1, 'RESULTS_HASH', `${r.path} is listed in raw_files but ${err?.code === 'ENOENT' ? 'missing on disk' : `unreadable (${err?.code ?? err?.message})`}`));
      continue;
    }
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha !== r.sha256 || buf.length !== r.bytes) out.push(finding(metaLabel, 1, 'RESULTS_HASH', `${r.path}: on disk ${buf.length} bytes sha256 ${sha}, raw_files says ${r.bytes} bytes sha256 ${r.sha256}`));
  }
  return out;
}

// An <env> directory holds meta.json or is named after an environment; anything else is a session or results
// directory whose subdirectories are searched (results -> session -> env, a few levels at most).
async function envDirs(readdir, dir, label, depth) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (ENVIRONMENTS.includes(segments(dir).pop()) || entries.some((e) => e.name === 'meta.json' && !e.isDirectory())) return [{ dir, label }];
  if (depth >= 3) return [];
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(byteOrder);
  const out = [];
  for (const name of subdirs) out.push(...await envDirs(readdir, joinPath(dir, name), `${label}/${name}`, depth + 1));
  return out;
}

// validateResultsDir(dir, { readFile, readdir, label }) -> Promise<{ findings, checked }>. dir is an env, session or
// results directory; every env directory below it is validated and listed in checked (the scan never stops at
// the first failure). I/O is injected (the CLI passes node:fs/promises): readFile(path) returns bytes,
// readdir(path, { withFileTypes: true }) returns Dirents. label is the path shown in findings (defaults to dir).
export async function validateResultsDir(dir, { readFile, readdir, label = dir } = {}) {
  const shown = String(label).replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  const found = await envDirs(readdir, dir, shown, 0), findings = [];
  if (!found.length) findings.push(finding(shown, 1, 'RESULTS_EMPTY', 'no environment directory (windows-native, ubuntu-wsl2 or one holding meta.json) below this path'));
  for (const e of found) findings.push(...await envFindings(e.dir, e.label, { readFile, readdir }));
  return { findings, checked: found.map((e) => e.label) };
}

// ---------- Findings ----------
const cmp =(a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Sorted by file, then line, then code (message breaks ties) so two runs print byte-identical reports.
export function sortFindings(list) {
  return [...list].sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.code, b.code) || cmp(a.message, b.message));
}
export function formatFinding(f) {
  return `[check-claims] ${f.file}:${f.line} ${f.code} ${f.message}`;
}
