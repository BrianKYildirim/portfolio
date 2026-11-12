// Claims checker core: checks numbers shown in the portfolio and the upstream READMEs against
// bench/claims.json and its evidence files (CLAIM-01..06), and validates benchmark results directories
// (BENCH-01..03/05/06). The checks are pure: callers pass text in and inject readers (readEvidence,
// readFile/readdir), so tests run on plain fixtures. The GitHub and Sources regions do I/O (fetch, git through
// execFile, readFile) behind injectable defaults, so their tests run without the network or a clone.
import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile as fsReadFile, readdir as fsReaddir } from 'node:fs/promises';
import path from 'node:path';

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const CLAIMS_FILE = 'bench/claims.json';
const SI = Object.freeze({ k: 1e3, M: 1e6, G: 1e9 });
// spread.kind names the pair of stats keys that gives low and high.
const SPREAD_KEYS = Object.freeze({ 'min-max': ['min', 'max'], 'p25-p75': ['p25', 'p75'], 'pooled-p25-p75': ['pooled_p25', 'pooled_p75'] });
const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', thinsp: '\u2009',
  times: '\u00d7', micro: '\u00b5', ndash: '\u2013', mdash: '\u2014', minus: '\u2212', asymp: '\u2248',
  // &mu; is the Greek letter (fold maps it to the micro sign); the spacing entities each read as a space.
  mu: '\u03bc', ensp: '\u2002', emsp: '\u2003', hairsp: '\u200a', numsp: '\u2007', puncsp: '\u2008', MediumSpace: '\u205f',
  ThinSpace: '\u2009', NonBreakingSpace: '\u00a0', percnt: '%', sol: '/', period: '.', comma: ',',
  // Invisible joiners and the soft hyphen decode to nothing, so "3&ZeroWidthSpace;ms" reads "3ms".
  shy: '', NoBreak: '', ZeroWidthSpace: '',
  // Common typography after a number in ordinary prose; decoded so it never reads as residue ("3.11 &middot; FastAPI").
  middot: '·', bull: '•', hellip: '…', rarr: '→', larr: '←', copy: '©', deg: '°', plusmn: '±' });
// An entity name: the longest HTML5 name, CounterClockwiseContourIntegral, has 31 letters; names such as frac12 and
// emsp13 hold digits after the first letter.
const ENTITY_NAME = String.raw`[a-zA-Z][a-zA-Z0-9]{1,31}`;
const ENTITY_REF = new RegExp(String.raw`&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|` + ENTITY_NAME + ');', 'g');
// The soft hyphen and the invisible joiners (U+00AD, U+200B-U+200D, U+2060, U+FEFF) split a figure from its unit
// without showing anything, so every text path removes them before matching. Built from char codes for the same
// reason as JS_EOL: no invisible character is typed into this file.
const FORMAT_CHARS = new RegExp(`[${String.fromCharCode(0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff)}]`, 'g');

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
// NFC, invisible joiners removed, one micro sign (U+03BC Greek mu folds to U+00B5), collapsed whitespace. Case is
// kept: M and m differ.
const fold = (s) => String(s).normalize('NFC').replace(FORMAT_CHARS, '').replace(/\u03bc/g, '\u00b5').replace(/\s+/g, ' ').trim();
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
// Unknown names are returned unchanged (the residue check reports one directly after a number).
function decodeEntities(s) {
  return s.replace(ENTITY_REF, (m, e) => {
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
    // An oversized or unreachable source keeps its own code (INPUT_TOO_LARGE, COULD_NOT_VERIFY); anything else
    // means the evidence the claim names is not there.
    const code = SOURCE_CODES.includes(err?.code) ? err.code : 'EVIDENCE_VALUE';
    return [at(code, `${claim.id}: cannot read evidence ${ev.repo}@${String(ev.sha).slice(0, 7)}:${ev.path} (${err?.message})`)];
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

// A README marker binds only the number token after it (an HTML leaf holds the whole text), so a comparison's
// README marker matches the display string that its line (comments removed) holds in full and that contains the
// token. The D-14 wording then stays checked in markdown too: the string must still say "no measurable
// difference" or give the ratio, and the bound token must be that ratio.
function shownString(claim, leaf, shown) {
  const exact = shown.find((s) => fold(s) === leaf.text);
  if (exact !== undefined || !leaf.token || claim.kind !== 'comparison' || leaf.field !== 'value') return exact;
  const line = fold(leaf.context ?? '');
  return shown.find((s) => typeof s === 'string' && line.includes(fold(s)) && fold(s).includes(leaf.text));
}

function displayFindings(claim, leaf, at) {
  const shown = claim.display?.[leaf.field];
  if (!['value', 'spread', 'n', 'environment'].includes(leaf.field)) return [at('CLAIM_MISMATCH', `${claim.id}: unknown data-claim-field "${leaf.field}"`)];
  const s = Array.isArray(shown) ? shownString(claim, leaf, shown) : undefined;
  if (s === undefined) {
    return [at('CLAIM_MISMATCH', `${claim.id}: "${leaf.text}" is not one of display.${leaf.field}`)];
  }
  if (claim.kind === 'comparison' && leaf.field === 'value') {
    const r = ratioIn(leaf.text);
    return lowerFold(s).includes(NO_DIFFERENCE) || within(r, claim.value) ? []
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
// the scan linear). An en-dash or hyphen range is one token. ×, x and X count only when no digit follows, so
// "12000 × 12000" and "1920 X 1080" are dimensions; an ASCII x or X before a template `${` is a hex prefix
// (`0x${hex}`), and one before a letter starts a word ("0XFF", "3 Xbox"), not a multiplier. px and MP are not
// units here (RESEARCH Open Question 3).
// Entities are decoded through the one ENTITIES table in every scanner (spacing entities such as &ensp; read as a
// space, &mu; as μ); the invisible joiners and the soft hyphen (FORMAT_CHARS) are removed before matching.
// Whatever is still undecoded directly after a number (an unknown entity, another invisible format character) is
// UNKNOWN_ENTITY or FORMAT_CHARACTER (RESIDUE, residueFindings), in every scanner.
// Coverage anchor (CLAIM-05): tools/test/unit-coverage.test.mjs reads every unit bench/claims.json uses and holds a
// fixed list of usual spellings per scanned unit, each of which must be one whole token here; a new claim unit fails
// that test until it is classified. A glued '+' is part of the number ("100+ req/s", "2.8M+"). UNIT alternatives:
// (A) a count rate, optional scale word, noun, then '/' or 'per'/'a' and a time ("75.7M op/s", "12,000 cmds/sec",
//     "2.1 million operations per second", "4 commands a second", "10,000 reads per second", "5 req/min");
// (B) a comparative speedup ("375 times faster", "375-fold faster") or a hyphenated "375-fold";
// (C) a spelled-out or abbreviated time unit ("3 milliseconds", "100 microsec", "40 nsec", "3 msecs");
// (D) a spelled-out percent ("95 percent", "95 per cent");
// (G) an acronym rate ("1,000 RPS", "5,000 IOPS", "30 fps", "10 Gbps");
// (E) the symbol units ("40 ns", "1.7 µs", "3.5×", "101 MiB", "64 kB", "1 TB", "28 bytes", "95%", "54 tests");
// (F) a bare rate glued to the number ("75.7M/s", "5 per second");
// (H) last, so every specific unit wins first: a generic count rate ("1,000 rows/sec", "60 frames per second").
//     Being last keeps "10<sup>9</sup> ns per second" reporting only "9 ns".
// Deliberate non-forms: "N times" alone ("retried 3 times") is a count; a spaced '+' ("100 + 5 ms") is arithmetic;
// a bare 'B' collides with single-letter names (the blue channel weight "0.114 B" in image-quality-gate README:45);
// rate denominators stop at the millisecond, because a README marker must keep binding the bare number of a
// ticks/ns display ("2.995 ticks/ns" binds "2.995"); minutes and hours are denominators only, never a time unit
// on their own ("a 5 minute run" stays quiet).
// A unit glued to '/' and a 1-10 letter word is one token ("500 MB/s", "10 ns/op"). Any other '/' after a unit
// fails closed to the bare unit ("3 ms/2 ops" reports "3 ms", "2x/3x" reports both); only '/' plus a 4-digit
// year ("10 s/2026") stays unmatched.
// One \s between words is enough: every scanner collapses whitespace runs before matching.
export const NUM = String.raw`(?<![\w.,])[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?[–-]\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)?\s?(?:[kKMG](?![A-Za-z]))?(?:(?<!\s)\+)?`;
const SCALE_WORD = String.raw`(?:(?:thousand|million|billion|trillion)\s)?`;
const RATE_NOUN = String.raw`(?:Mops|ops?|operations?|requests?|reqs?|commands?|cmds?|calls?|quer(?:y|ies)|images?|reads?|writes?|decisions?|tokens?|transactions?)`;
// Rate denominators; no ns, µs or us (see the non-forms above).
const SLASH_TIME = String.raw`(?:seconds?|secs?|s|milliseconds?|msecs?|ms|minutes?|mins?|hours?|hrs?|h)`;
const PER_TIME = String.raw`(?:seconds?|secs?|milliseconds?|msecs?|ms|minutes?|mins?|hours?|hrs?)`;
const COMPARATIVE = String.raw`(?:faster|slower|more|less|fewer|higher|lower|better|worse|quicker|larger|smaller)`;
export const UNIT = '(?:'
  + SCALE_WORD + RATE_NOUN + String.raw`(?:\/` + SLASH_TIME + String.raw`|\s(?:per|a)\s` + PER_TIME + ')'   // (A)
  + String.raw`|(?:times|fold)\s` + COMPARATIVE + String.raw`|(?<=-)fold`                                   // (B)
  + String.raw`|(?:milli|micro|nano)(?:seconds?|secs?)|[nuµμm]secs?`                                        // (C)
  + String.raw`|percent|per\scent`                                                                           // (D)
  + String.raw`|IOPS|iops|[RQT]PS|[rqt]ps|fps|FPS|[kKMGT]bps`                                                // (G)
  + String.raw`|seconds?|secs?|ns|µs|μs|us|ms|s|×(?!\s?\d)|[xX](?!\s?\d|\$\{|[A-Za-z])|KiB|MiB|GiB|TiB|kB|KB|MB|GB|TB|bytes?|%|tests?` // (E)
  + String.raw`|\/` + SLASH_TIME + String.raw`|per\s` + PER_TIME                                            // (F)
  + '|' + SCALE_WORD + String.raw`[A-Za-z]{1,20}(?:\/` + SLASH_TIME + String.raw`|\sper\s` + PER_TIME + ')' // (H)
  + ')';
// Shared by UNIT_NUMBER and MD_BIND, so a README marker binds exactly the token the scan would report. A '/' and a
// 1-10 letter word stay part of the token ("500 MB/s"); otherwise the bare unit is the token (fail closed: "3 ms/2 ops"
// reports "3 ms"), unless '/' and exactly four digits follow, a year ("10 s/2026").
const UNIT_TAIL = String.raw`(?:\/[A-Za-z]{1,10}(?![\w/])|(?!\w)(?!\/\d{4}(?!\d)))`;
export const UNIT_NUMBER = new RegExp(NUM + String.raw`[\s-]?` + UNIT + UNIT_TAIL, 'g');
// Residue: anything left after decoding right after a number (an entity-shaped token the ENTITIES table does not
// decode, or an invisible format character FORMAT_CHARS does not remove) could hide the unit after it, so it is
// reported, not left as text (fail closed). A residue before a number hides nothing and is not reported. The u flag
// is needed only for \p{Cf}; UNIT_NUMBER keeps no u flag (02-03 decision).
const RESIDUE = new RegExp(NUM + String.raw`\s?(&#?[A-Za-z0-9]{1,32};|\p{Cf})`, 'gu');
// Pushes into the caller's `out` (spreading a large result into push overflows the call stack) and drives RESIDUE
// with exec (matchAll clones the pattern on every call; this runs once per line and per visible attribute).
function residueFindings(text, file, lineAt, out) {
  RESIDUE.lastIndex = 0;
  for (let m = RESIDUE.exec(text); m; m = RESIDUE.exec(text)) {
    const what = m[1], figure = m[0].slice(0, m[0].length - what.length).trim(), line = lineAt(m.index);
    if (what[0] === '&') {
      out.push(finding(file, line, 'UNKNOWN_ENTITY', `"${what}" after "${figure}" is an entity the checker does not decode, so the figure cannot be read; write the character itself`));
    } else {
      const code = `U+${what.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      out.push(finding(file, line, 'FORMAT_CHARACTER', `${code} after "${figure}" is an invisible format character that hides the figure; remove it`));
    }
  }
}

const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?>/g;
// One token of visible text: a tag, an entity, a whitespace run, a text run, or a lone '<' / '&'.
const VISIBLE_TOKEN = new RegExp(String.raw`<[A-Za-z/!?][^<>]*>|&(?:#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|` + ENTITY_NAME
  + String.raw`);|\s+|[^<&\s]+|[<&]`, 'g');
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
// REVIEW WR-03: attribute text a visitor sees or hears (a tooltip, a screen-reader label, an image description, a
// search-result snippet) is scanned like visible text. content counts only on a meta whose name or property is a
// description or a social title (META_TEXT); viewport, http-equiv and every data-* attribute stay internal.
// Attributes are tokenized in order (name, then an optional double-quoted, single-quoted or unquoted value), so a
// name inside another attribute's value never matches and a stray quote cannot swallow the next attribute.
const VOID_ELEMENTS = Object.freeze(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const VISIBLE_ATTR = Object.freeze(['alt', 'title', 'aria-label', 'aria-description', 'placeholder', 'content']);
const META_TEXT = /^(?:description|og:[\w:]+|twitter:title|twitter:description)$/i;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// A private copy driven by exec: matchAll clones UNIT_NUMBER on every call, which doubled the cost of a page where
// every tag holds a figure.
const ATTR_UNIT = new RegExp(UNIT_NUMBER.source, 'g');
// Each finding carries the line of the attribute itself and names it. A tag whose attribute text has no digit is
// skipped before any value is parsed (a numeric entity holds digits itself), which keeps 1 MiB of tags linear.
function attributeFindings(src, file, lineOf) {
  const out = [];
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(src); m; m = OPEN_TAG.exec(src)) {
    const attrs = m[2] || '';
    if (!/\d/.test(attrs)) continue;
    const base = m.index + 1 + m[1].length, list = [];
    for (const a of attrs.matchAll(ATTRIBUTE)) list.push({ name: a[1].toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? '', at: base + a.index });
    const isMetaText = m[1].toLowerCase() === 'meta'
      && list.some((a) => (a.name === 'name' || a.name === 'property') && META_TEXT.test(a.value.trim()));
    for (const a of list) {
      if (!VISIBLE_ATTR.includes(a.name) || (a.name === 'content' && !isMetaText) || !/\d/.test(a.value)) continue;
      const line = lineOf(a.at), value = fold(decodeEntities(a.value));
      ATTR_UNIT.lastIndex = 0;
      for (let t = ATTR_UNIT.exec(value); t; t = ATTR_UNIT.exec(value)) {
        out.push(finding(file, line, 'UNTAGGED_NUMBER', `"${t[0]}" has a unit but no data-claim marker or data-claim-waiver (in its ${a.name} attribute)`));
      }
      residueFindings(value, file, () => line, out);
    }
  }
  return out;
}
// Visible text: every tag becomes one space (so 10<sup>9</sup> never reads as 109; attribute values vanish with
// their tags, and the visitor-visible ones are scanned separately by the attribute pass above), entities are decoded,
// whitespace runs collapse to one space.
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
  // Invisible joiners go before tokenizing (U+FEFF would otherwise read as whitespace); line numbers are counted
  // from newlines, so they stay true. A decoded entity that leaves nothing pushes nothing.
  for (const [t] of src.replace(FORMAT_CHARS, '').matchAll(VISIBLE_TOKEN)) {
    if (t.length > 1 && t[0] === '<') push(' ');
    else if (t.length > 1 && t[0] === '&') { const d = decodeEntities(t).replace(FORMAT_CHARS, ''); if (d) push(/^\s+$/.test(d) ? ' ' : d); }
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
// data-claim-waiver leaves: the reason is checked (WAIVER_NO_REASON), then the leaf is blanked. A void element
// (img, input, meta, ...) has no content, so its waiver covers its own attributes: its opening tag is blanked.
// A waiver on any other element that is not a leaf is LEAF_NOT_LEAF and is not blanked, so its numbers are still
// scanned.
function waiverFindings(src, file, lineOf) {
  const out = [], ranges = [];
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(src); m; m = OPEN_TAG.exec(src)) {
    const attrs = m[2] || '';
    if (!WAIVER_ATTR.test(attrs) || attr(attrs, 'data-claim') !== null) continue;
    const isVoid = VOID_ELEMENTS.includes(m[1].toLowerCase());
    const reason = decodeEntities(attr(attrs, 'data-claim-waiver') ?? ''), line = lineOf(m.index);
    const end = isVoid ? m.index + m[0].length : leafEnd(src, m);
    if (noReason(reason)) out.push(finding(file, line, 'WAIVER_NO_REASON', `data-claim-waiver needs a reason the owner can review (got "${fold(reason)}")`));
    if (end === -1) out.push(finding(file, line, 'LEAF_NOT_LEAF', 'data-claim-waiver must be on a leaf element with a closing tag'));
    else ranges.push([m.index, end]);
  }
  return { findings: out, ranges };
}

// scanHtml(text, file) -> findings (UNTAGGED_NUMBER, METRIC_UNTAGGED, WAIVER_NO_REASON, LEAF_NOT_LEAF,
// UNKNOWN_ENTITY, FORMAT_CHARACTER, INPUT_TOO_LARGE), in source order. Pipeline (RESEARCH Pattern 6): comments, <script> and <style> out; waived
// leaves checked and out; data-claim leaves out (checkTagged verifies them); untagged headline values reported;
// visitor-visible attribute values scanned (the attribute pass, WR-03); every tag to a space; entities decoded; NFC;
// then UNIT_NUMBER. Every removal is same-length whitespace with newlines kept, so each finding carries its true
// source line.
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
  out.push(...attributeFindings(src, file, lineOf));
  const { text: visible, lineAt } = visibleText(src);
  for (const m of visible.matchAll(UNIT_NUMBER)) out.push(untagged(file, lineAt(m.index), m[0]));
  residueFindings(visible, file, lineAt, out);
  return out.sort((a, b) => a.line - b.line);
}

// Waivers are line-scoped: a real trailing `// claim-waiver: <reason>` comment exempts its line. Comments are found
// by one forward pass that skips strings, template literals (with nested ${} expressions) and regex literals, so a
// `//` or a waiver-looking text inside a string neither hides the rest of the line nor waives it (REVIEW WR-02).
// Every JS line terminator ends a line: CRLF, a lone CR, U+2028 and U+2029. The two separators come from char codes
// because typed raw either one ends a regex literal and breaks module parsing.
const JS_EOL = new RegExp(`\\r\\n?|[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const JS_TAG = /<[A-Za-z/!][^<>]*>/g;
const JS_WAIVER_BODY = /^\s*claim-waiver(?![\w-])(.*)$/;
// A '/' starts a regex literal after one of these characters or keywords (the usual previous-token heuristic).
// Only the comment ranges the tokenizer returns are blanked, so a misread hides text only through a comment it
// invents. Strings end at a newline that no backslash continues and regexes at their newline, so most misreads stay
// on their line, where a misread '//' can hide the rest of it. A '/*' with no '*/' after it is read as code (valid
// JS never has one, as mdStructure leaves an unclosed '<!--' as text), but a misread '/*'
// that pairs with a later real '*/' hides every line up to that '*/' (residual, REVIEW WR-11). A '/' after the ')'
// that closes an if, while, for or with condition also starts a regex, and a postfix ++ or -- ends an operand, so a
// '/' after it is division.
const JS_REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^');
const JS_REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'instanceof', 'yield', 'await']);
const JS_COND_WORDS = new Set(['if', 'while', 'for', 'with']);
const JS_WORD = /[A-Za-z0-9_$]/;

// jsCommentRanges(src) -> { ranges, lineComments } for LF-only text: [start, end) of every comment, and each line
// comment's start offset and body (the text after the two slashes). Single pass: strings end at their quote or at
// a newline that no backslash continues, an unterminated regex resumes at its newline without searching the skipped
// text for comments, and a '/*' with no '*/' after it is read as code. The '*/' search is bounded by one
// lastIndexOf per call, so the pass stays linear.
function jsCommentRanges(src) {
  const ranges = [], lineComments = [], frames = [], n = src.length;   // frames: brace depth of each open ${ }
  const parens = [];   // per open '(': whether it opens an if, while, for or with condition
  const lastClose = src.lastIndexOf('*/');   // an opener whose body starts after the last '*/' has no close
  let i = 0, prev = '', word = '';
  // Template text from i to its closing backtick (back to code) or a ${ (an expression frame opens).
  const templateText = () => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') i += 2;
      else if (c === '`') { i++; prev = '`'; word = ''; return; }
      else if (c === '$' && src[i + 1] === '{') { i += 2; frames.push(0); prev = '{'; word = ''; return; }
      else i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (JS_WORD.test(c)) {
      const from = i;
      while (i < n && JS_WORD.test(src[i])) i++;
      word = src.slice(from, i); prev = src[i - 1];
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      // A backslash skips the character after it, a newline included (a line continuation).
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j < n && src[j] === c ? j + 1 : Math.min(j, n);
      prev = c; word = '';
      continue;
    }
    if (c === '`') { i++; templateText(); continue; }
    if (c === '}' && frames.length && frames[frames.length - 1] === 0) { frames.pop(); i++; templateText(); continue; }
    if (c === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      ranges.push([i, end]); lineComments.push({ at: i, body: src.slice(i + 2, end) });
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      // Search only when a '*/' exists past the opener; otherwise searching to the end at every opener is quadratic.
      if (i + 2 <= lastClose) {
        const end = src.indexOf('*/', i + 2) + 2;
        ranges.push([i, end]);
        i = end;
      } else { prev = '/'; word = ''; i++; }   // no '*/' after it: code, and the '*' is an ordinary operator
      continue;
    }
    if (c === '(') { parens.push(JS_COND_WORDS.has(word)); prev = '('; word = ''; i++; continue; }
    // A statement starts after a condition's ')', so a '/' there starts a regex; after any other ')' it divides.
    if (c === ')') { prev = parens.pop() === true ? ';' : ')'; word = ''; i++; continue; }
    if ((c === '+' || c === '-') && src[i + 1] === c) {
      // Postfix when an operand precedes it: the operand ends, so a '/' after it is division.
      const operand = (word && !JS_REGEX_WORDS.has(word)) || prev === ')' || prev === ']';
      prev = operand ? ')' : c; word = ''; i += 2;
      continue;
    }
    if (c === '/' && (word ? JS_REGEX_WORDS.has(word) : prev === '' || JS_REGEX_AFTER.has(prev))) {
      let j = i + 1, inClass = false, closed = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\' && src[j + 1] !== '\n') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) while (j < n && JS_WORD.test(src[j])) j++;
      i = Math.min(j, n); prev = ')'; word = '';
      continue;
    }
    if (frames.length && c === '{') frames[frames.length - 1]++;
    else if (frames.length && c === '}') frames[frames.length - 1]--;
    prev = c; word = '';
    i++;
  }
  return { ranges, lineComments };
}

// scanJsLines(text, file) -> findings (UNTAGGED_NUMBER, WAIVER_NO_REASON, UNKNOWN_ENTITY, FORMAT_CHARACTER,
// INPUT_TOO_LARGE) for the user-visible
// string literals of a demo module, in source order: line ends to LF, comments found by jsCommentRanges, waived
// lines skipped (a placeholder reason is WAIVER_NO_REASON), comments blanked, then per line template-markup tags to
// spaces, entities decoded, whitespace collapsed and UNIT_NUMBER.
export function scanJsLines(text, file = '') {
  if (byteLength(text) > MAX_INPUT_BYTES) return [finding(file, 1, 'INPUT_TOO_LARGE', `larger than ${MAX_INPUT_BYTES} bytes`)];
  const src = String(text).normalize('NFC').replace(JS_EOL, '\n');
  // waived: line -> null for a reasoned waiver, or the placeholder reason that makes it WAIVER_NO_REASON.
  const { ranges, lineComments } = jsCommentRanges(src), lineOf = lineIndex(src), waived = new Map();
  for (const { at, body } of lineComments) {
    const w = JS_WAIVER_BODY.exec(body);
    if (!w) continue;
    const colon = /^\s*:/.test(w[1]), reason = w[1].replace(/^\s*:/, '');
    waived.set(lineOf(at), !colon || noReason(reason) ? reason : null);
  }
  const out = [];
  blankRanges(src, ranges).split('\n').forEach((raw, i) => {
    if (waived.has(i + 1)) {
      const reason = waived.get(i + 1);
      if (reason !== null) out.push(finding(file, i + 1, 'WAIVER_NO_REASON', `write // claim-waiver: <reason> with a reason the owner can review (got "${fold(reason)}")`));
      return;
    }
    const code = decodeEntities(raw.replace(JS_TAG, ' ')).replace(FORMAT_CHARS, '').replace(/\s+/g, ' ');
    for (const m of code.matchAll(UNIT_NUMBER)) out.push(finding(file, i + 1, 'UNTAGGED_NUMBER', `"${m[0]}" has a unit but no // claim-waiver: <reason> comment`));
    residueFindings(code, file, () => i + 1, out);
  });
  return out;
}

// ---------- Markdown ----------
// CLAIM-03 / D-05: the upstream READMEs follow the same rule as the pages. Markers are HTML comments, which GFM
// hides, including in table cells (RESEARCH Pattern 6). Text is LF-normalized first, so a CRLF checkout
// (core.autocrlf=true) gives the same findings and line numbers as an LF one.
const lf = (text) => String(text).replace(/\r\n?/g, '\n');
// The value a marker binds to: the first number token after it on its line, with its unit (or "runs", so a
// #n marker can bind "10 runs" exactly as an HTML leaf would show it). Trimmed before use.
const MD_BIND = new RegExp(NUM + String.raw`(?:[\s-]?(?:` + UNIT + String.raw`|runs?|repetitions?|rounds?)` + UNIT_TAIL + ')?');
const MD_FENCE = /^[ \t]*(`{3,}|~{3,})/;
const MD_TAG = /<[A-Za-z/!][^<>]*>/g;

// mdStructure(src) -> { comments: [{ start, end, body, line }], fenced: Set<line> }. One forward pass. A comment
// inside a fenced code block is visible text in GFM, so it is not a comment here (and cannot waive anything).
// A '<!--' with no '-->' after it is left as text: it is scanned, never a silent skip to the end of the file.
function mdStructure(src) {
  const comments = [], fenced = new Set();
  let fence = null, skipTo = 0, noClose = false, line = 0;
  for (let start = 0; ; ) {
    const nl = src.indexOf('\n', start), end = nl === -1 ? src.length : nl, text = src.slice(start, end);
    line += 1;
    const inComment = start < skipTo;
    if (!(inComment && skipTo > end)) {
      if (!inComment && fence) {
        fenced.add(line);
        const t = text.trim();
        if (t.length >= fence.length && [...t].every((ch) => ch === fence[0])) fence = null;
      } else if (!inComment && MD_FENCE.test(text)) {
        fence = MD_FENCE.exec(text)[1];
        fenced.add(line);
      } else {
        for (let from = Math.max(start, skipTo) - start; !noClose; ) {
          const i = text.indexOf('<!--', from);
          if (i === -1) break;
          const j = src.indexOf('-->', start + i + 4);
          if (j === -1) { noClose = true; break; }
          comments.push({ start: start + i, end: j + 3, body: src.slice(start + i + 4, j), line });
          from = j + 3 - start;
          if (j + 3 > end) { skipTo = j + 3; break; }
        }
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return { comments, fenced };
}

// What a comment is: a claim marker, a waiver, a block boundary, or an ordinary (hidden) comment. A waiver's
// reason follows a colon; a waiver without the colon has no reason (WAIVER_NO_REASON), as in demo JS.
const reasonOf = (rest) => ({ colon: /^\s*:/.test(rest), reason: rest.replace(/^\s*:/, '') });
function mdClassify(c) {
  const body = c.body.trim();
  let m = /^claim:([^\s#]*)(?:#(\S*))?$/.exec(body);
  if (m) return Object.assign(c, { kind: 'marker', id: m[1], field: m[2] ?? 'value' });
  if ((m = /^claim-waiver-begin(?![\w-])([\s\S]*)$/.exec(body))) return Object.assign(c, { kind: 'waiver-begin' }, reasonOf(m[1]));
  if (body === 'claim-waiver-end') return Object.assign(c, { kind: 'waiver-end' });
  if ((m = /^claim-waiver(?![\w-])([\s\S]*)$/.exec(body))) return Object.assign(c, { kind: 'waiver' }, reasonOf(m[1]));
  if ((m = /^claims-table:begin(?![\w-])([\s\S]*)$/.exec(body))) return Object.assign(c, { kind: 'table-begin', id: /(?:^|\s)id=(\S+)/.exec(m[1])?.[1] ?? '' });
  if (body === 'claims-table:end') return Object.assign(c, { kind: 'table-end' });
  if (body === 'bench-methodology:begin') return Object.assign(c, { kind: 'method-begin' });
  if (body === 'bench-methodology:end') return Object.assign(c, { kind: 'method-end' });
  return Object.assign(c, { kind: 'comment' });
}
// Pairs each begin with the next end, in comment order. A begin met while a block is open is inside it.
// from/to are comment indices, so "inside a block" is an index range and the whole pass stays linear.
function pairBlocks(comments, beginKind, endKind) {
  const blocks = [], unmatched = [];
  let open = -1;
  comments.forEach((c, i) => {
    if (c.kind === beginKind && open === -1) open = i;
    else if (c.kind === endKind && open === -1) unmatched.push(c);
    else if (c.kind === endKind) { blocks.push({ begin: comments[open], end: c, from: open, to: i }); open = -1; }
  });
  if (open !== -1) unmatched.push(comments[open]);
  return { blocks, unmatched };
}
function mdParse(src) {
  const { comments, fenced } = mdStructure(src);
  comments.forEach(mdClassify);
  return { comments, fenced, waivers: pairBlocks(comments, 'waiver-begin', 'waiver-end'),
    tables: pairBlocks(comments, 'table-begin', 'table-end'), methodology: pairBlocks(comments, 'method-begin', 'method-end') };
}
// lineTable(src) -> { lineOf(offset), start(line), end(line) } over 1-based lines; end is the offset of the '\n'.
// One table per input keeps every per-marker and per-block lookup logarithmic (a 1 MiB single-line input stays linear).
function lineTable(src) {
  const starts = [0];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  return { lineOf, start: (line) => starts[line - 1], end: (line) => (line < starts.length ? starts[line] - 1 : src.length) };
}
// First entry of a list sorted by `at` whose at >= offset, or undefined.
function firstAtOrAfter(list, offset) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].at < offset) lo = mid + 1; else hi = mid; }
  return list[lo];
}
const mdUntagged = (file, line, token) => finding(file, line, 'UNTAGGED_NUMBER',
  `"${token}" has a unit but no <!-- claim:<id> --> marker or <!-- claim-waiver: <reason> --> before it`);

// GFM tables. Cells split at unescaped pipes; a leading and a trailing pipe are optional.
function cellSpans(line) {
  const pipes = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i += 1;
    else if (line[i] === '|') pipes.push(i);
  }
  const first = line.search(/\S/), last = line.trimEnd().length - 1, spans = [];
  let from = 0, to = line.length;
  if (pipes.length && pipes[0] === first) { from = first + 1; pipes.shift(); }
  if (pipes.length && pipes.at(-1) === last && last >= from) { to = last; pipes.pop(); }
  for (const p of pipes) { spans.push([from, p]); from = p + 1; }
  spans.push([from, to]);
  return spans;
}
const hasPipe = (line) => cellSpans(line).length > 1 || /^\s*\|/.test(line);
const isDelimiterRow = (line) => line.includes('|') && cellSpans(line).every(([a, b]) => /^:?-+:?$/.test(line.slice(a, b).trim()));
// A table ends at a blank line or at the start of another block (heading, quote, list item, fence).
const ENDS_TABLE = /^\s*$|^[ \t]*(?:#{1,6}(?:\s|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t]|```|~~~)/;
// A cell is numeric when, after emphasis or code marks and an optional ~, ≈ or sign, it starts with a digit.
const CELL_NUMERIC = /^[*_`]*(?:[~≈]\s?)?[+−-]?\d/;

// Numeric body cells of the GFM tables outside claims-table blocks (RESEARCH Pitfall 9: units in a header do not
// exempt unit-less cells). A cell holding a marker or waiver comment is exempt; the comment does the checking.
// Reported cells are blanked in `lines` so their numbers are not reported a second time as UNTAGGED_NUMBER.
function tableCellFindings(lines, fenced, marks, file) {
  const out = [];
  for (let i = 0; i + 1 < lines.length; ) {
    const header = lines[i], delimiter = lines[i + 1];
    if (fenced.has(i + 1) || fenced.has(i + 2) || !hasPipe(header) || !isDelimiterRow(delimiter)
      || cellSpans(header).length !== cellSpans(delimiter).length) { i += 1; continue; }
    let j = i + 2;
    for (; j < lines.length && !fenced.has(j + 1) && !ENDS_TABLE.test(lines[j]); j++) {
      const own = marks.get(j) ?? [];
      for (const [a, b] of cellSpans(lines[j])) {
        const cell = fold(lines[j].slice(a, b));
        if (own.some((col) => col >= a && col < b) || !CELL_NUMERIC.test(cell)) continue;
        out.push(finding(file, j + 1, 'TABLE_CELL_UNTAGGED', `table cell "${cell}" is numeric but has no <!-- claim:<id> --> marker or <!-- claim-waiver: <reason> -->; generate the table in a claims-table block or mark the cell`));
        lines[j] = lines[j].slice(0, a) + blank(lines[j].slice(a, b)) + lines[j].slice(b);
      }
    }
    i = j;
  }
  return out;
}

// scanMarkdown(text, file) -> { markers, findings }. markers ({ file, id, field, text, line, context }) go to
// checkTagged exactly like HTML leaves; context is the marker's line with comments removed. A marker or inline
// waiver binds to the first number token after it on its line. Block waivers and claims-table blocks
// (checked by checkTables) are not scanned; an unterminated block is a finding and its text is still scanned.
// Findings: MD_MARKER_NO_NUMBER, WAIVER_NO_REASON, WAIVER_UNTERMINATED, TABLE_CELL_UNTAGGED, UNTAGGED_NUMBER,
// UNKNOWN_ENTITY, FORMAT_CHARACTER, INPUT_TOO_LARGE, in line order with true source lines.
export function scanMarkdown(text, file = '') {
  if (byteLength(text) > MAX_INPUT_BYTES) return { markers: [], findings: [finding(file, 1, 'INPUT_TOO_LARGE', `larger than ${MAX_INPUT_BYTES} bytes`)] };
  const src = lf(text).normalize('NFC'), p = mdParse(src), lt = lineTable(src), markers = [], out = [];
  const inside = new Set(), regions = [];
  for (const b of [...p.waivers.blocks, ...p.tables.blocks]) {
    regions.push([b.begin.start, b.end.end]);
    for (let k = b.from + 1; k < b.to; k++) inside.add(k);
  }
  for (const b of p.waivers.blocks) {
    if (!b.begin.colon || noReason(b.begin.reason)) out.push(finding(file, b.begin.line, 'WAIVER_NO_REASON', `write <!-- claim-waiver-begin: <reason> --> with a reason the owner can review (got "${fold(b.begin.reason)}")`));
  }
  for (const c of p.waivers.unmatched) {
    out.push(finding(file, c.line, 'WAIVER_UNTERMINATED', c.kind === 'waiver-begin'
      ? '<!-- claim-waiver-begin --> has no <!-- claim-waiver-end -->, so nothing after it is waived'
      : '<!-- claim-waiver-end --> has no <!-- claim-waiver-begin: <reason> --> before it'));
  }
  const blanked = blankRanges(src, p.comments.map((c) => [c.start, c.end]));
  // The number tokens of a line, found once per line (a token never straddles a blanked comment, so the first
  // token at or after a marker's end is the one an exec from that offset would find).
  const tokenCache = new Map(), contextCache = new Map(), bindAll = new RegExp(MD_BIND.source, 'g');
  const tokensOn = (line) => {
    if (!tokenCache.has(line)) {
      const from = lt.start(line), list = [];
      for (const m of blanked.slice(from, lt.end(line)).matchAll(bindAll)) list.push({ at: from + m.index, token: m[0].trim() });
      tokenCache.set(line, list);
    }
    return tokenCache.get(line);
  };
  const bound = [], marks = new Map();
  p.comments.forEach((c, i) => {
    if (inside.has(i) || (c.kind !== 'marker' && c.kind !== 'waiver')) return;
    const startLine = lt.lineOf(c.start), endLine = lt.lineOf(c.end);
    if (!marks.has(startLine - 1)) marks.set(startLine - 1, []);
    marks.get(startLine - 1).push(c.start - lt.start(startLine));
    const what = c.kind === 'marker' ? `<!-- claim:${c.id} -->` : '<!-- claim-waiver -->';
    if (c.kind === 'waiver' && (!c.colon || noReason(c.reason))) out.push(finding(file, c.line, 'WAIVER_NO_REASON', `write <!-- claim-waiver: <reason> --> with a reason the owner can review (got "${fold(c.reason)}")`));
    const t = firstAtOrAfter(tokensOn(endLine), c.end);
    if (!t) { out.push(finding(file, c.line, 'MD_MARKER_NO_NUMBER', `${what} has no number after it on its line`)); return; }
    bound.push([t.at, t.at + t.token.length]);
    if (c.kind !== 'marker') return;
    const key = `${startLine}:${endLine}`;
    if (!contextCache.has(key)) contextCache.set(key, fold(blanked.slice(lt.start(startLine), lt.end(endLine))));
    markers.push({ file, id: c.id, field: c.field, text: fold(t.token), line: c.line, context: contextCache.get(key), token: true });
  });
  const lines = blankRanges(blanked, [...bound, ...regions]).split('\n');
  out.push(...tableCellFindings(lines, p.fenced, marks, file));
  lines.forEach((raw, i) => {
    if (!/\d/.test(raw)) return;   // no digit, no unit-number (a numeric entity such as &#49; holds digits itself)
    const visible = decodeEntities(raw.replace(MD_TAG, ' ')).replace(FORMAT_CHARS, '').replace(/\s+/g, ' ');
    for (const m of visible.matchAll(UNIT_NUMBER)) out.push(mdUntagged(file, i + 1, m[0]));
    residueFindings(visible, file, () => i + 1, out);
  });
  return { markers, findings: out.sort((a, b) => a.line - b.line) };
}

// ---------- Generated tables ----------
// RESEARCH Pattern 7: a README table between <!-- claims-table:begin id=<id> --> and <!-- claims-table:end --> is
// rendered from bench/claims.json tables[] and must match the render byte for byte (after LF normalization), so
// a hand edit cannot drift. Spec: { id, project, columns: [header], rows: [{ cells: [{ text } | { claim, format }] }] }.
const TABLE_FORMATS = Object.freeze(['value', 'value+spread']);
const escCell = (s) => String(s).replace(/\s*\n\s*/g, ' ').replace(/(?<!\\)\|/g, '\\|');

// A claim cell shows the claim's first display strings, never a recomputed number: value, or "value (spread)".
function tableCell(cell, where, claimsById, bad) {
  const none = { text: '', numeric: false };
  if (isObj(cell) && typeof cell.text === 'string' && cell.claim === undefined) return { text: cell.text, numeric: CELL_NUMERIC.test(fold(cell.text)) };
  if (!isObj(cell) || !isStr(cell.claim)) { bad('TABLE_SPEC', `${where} must be { text } or { claim, format }`); return none; }
  const format = cell.format ?? 'value', claim = lookup(claimsById, cell.claim);
  if (!TABLE_FORMATS.includes(format)) { bad('TABLE_SPEC', `${where}: format "${format}" is not one of ${TABLE_FORMATS.join(', ')}`); return none; }
  if (!claim) { bad('CLAIM_UNKNOWN', `"${cell.claim}" is not in ${CLAIMS_FILE}`); return none; }
  if (claim.status !== 'approved') { bad('CLAIM_NOT_APPROVED', `${claim.id} has status ${claim.status}; only approved claims may be shown`); return none; }
  const value = claim.display?.value?.[0], spread = claim.display?.spread?.[0];
  if (!isStr(value)) { bad('TABLE_SPEC', `${where}: ${claim.id} has no display.value string to show`); return none; }
  if (format === 'value+spread' && !isStr(spread)) { bad('TABLE_SPEC', `${where}: ${claim.id} has no display.spread string to show`); return none; }
  return { text: format === 'value+spread' ? `${value} (${spread})` : value, numeric: true };
}

// renderTable(spec, claimsById) -> { text, findings }. text is the GFM table (header row, a separator with ---:
// for numeric columns, one row per spec row in order, LF line ends, no trailing newline), or null when any
// finding (TABLE_SPEC, TABLE_EMPTY, CLAIM_UNKNOWN, CLAIM_NOT_APPROVED) means it must not be shown.
export function renderTable(spec, claimsById) {
  const out = [], bad = (code, message) => out.push({ code, message });
  if (!isObj(spec)) return { text: null, findings: [{ code: 'TABLE_SPEC', message: 'a table spec must be an object' }] };
  const name = isStr(spec.id) ? spec.id : '(no id)';
  const cols = Array.isArray(spec.columns) && spec.columns.length && spec.columns.every(isStr) ? spec.columns : null;
  if (!cols) bad('TABLE_SPEC', `${name}: columns must be a non-empty list of header strings`);
  if (!Array.isArray(spec.rows)) bad('TABLE_SPEC', `${name}: rows must be a list`);
  else if (!spec.rows.length) bad('TABLE_EMPTY', `${name}: the table has no rows`);
  if (out.length) return { text: null, findings: out };
  const rows = spec.rows.map((row, i) => {
    if (!isObj(row) || !Array.isArray(row.cells) || row.cells.length !== cols.length) {
      bad('TABLE_SPEC', `${name}: rows[${i}] must have ${cols.length} cells`);
      return [];
    }
    return row.cells.map((cell, k) => tableCell(cell, `${name}: rows[${i}].cells[${k}]`, claimsById, bad));
  });
  if (out.length) return { text: null, findings: out };
  const numeric = cols.map((_, k) => rows.every((r) => r[k].numeric)), line = (cells) => `| ${cells.map(escCell).join(' | ')} |`;
  return { text: [line(cols), `|${numeric.map((n) => (n ? '---:' : '---')).join('|')}|`, ...rows.map((r) => line(r.map((c) => c.text)))].join('\n'), findings: [] };
}

const claimsMap = (doc) => {
  const byId = new Map();
  for (const c of Array.isArray(doc?.claims) ? doc.claims : []) if (isObj(c) && typeof c.id === 'string' && !byId.has(c.id)) byId.set(c.id, c);
  return byId;
};
// Every claims-table block in src with its spec and render. The block body is everything between the two comments:
// a newline, the table lines (each indented like the begin comment, so a table may sit in a list item), a newline
// and that indent again before the end comment.
function tableBlocks(src, file, doc, project) {
  const p = mdParse(src), out = [], renders = [], specs = new Map(), byId = claimsMap(doc), lt = lineTable(src);
  for (const t of Array.isArray(doc?.tables) ? doc.tables : []) if (isObj(t) && typeof t.id === 'string' && !specs.has(t.id)) specs.set(t.id, t);
  for (const c of p.tables.unmatched) {
    out.push(finding(file, c.line, 'TABLE_UNTERMINATED', c.kind === 'table-begin'
      ? `<!-- claims-table:begin id=${c.id} --> has no <!-- claims-table:end -->` : '<!-- claims-table:end --> has no <!-- claims-table:begin id=<id> --> before it'));
  }
  for (const b of p.tables.blocks) {
    const spec = specs.get(b.begin.id), at = (code, message) => out.push(finding(file, b.begin.line, code, message));
    if (!spec) { at('TABLE_UNKNOWN', `claims-table "${b.begin.id}" is not in ${CLAIMS_FILE} tables[]`); continue; }
    if (project !== undefined && spec.project !== project) { at('TABLE_UNKNOWN', `claims-table "${spec.id}" belongs to project "${spec.project}", not "${project}"`); continue; }
    const r = renderTable(spec, byId);
    for (const f of r.findings) at(f.code, f.message);
    if (r.text === null) continue;
    // The indent is the run of spaces and tabs before the begin comment, when nothing else precedes it on its line.
    let k = b.begin.start;
    while (k > 0 && (src[k - 1] === ' ' || src[k - 1] === '\t')) k -= 1;
    const indent = k === lt.start(lt.lineOf(b.begin.start)) ? src.slice(k, b.begin.start) : '';
    const body = `\n${r.text.split('\n').map((l) => indent + l).join('\n')}\n${indent}`;
    renders.push({ block: b, spec, text: r.text, body, firstLine: lt.lineOf(b.begin.end) });
  }
  return { findings: out, renders, byId };
}

// checkTables(text, file, doc, { project }) -> { findings, markers }. Check mode: compares every block with its
// render (TABLE_DRIFT at the first differing line; TABLE_UNKNOWN, TABLE_EMPTY, TABLE_UNTERMINATED, TABLE_SPEC,
// CLAIM_UNKNOWN, CLAIM_NOT_APPROVED from the spec). markers are the claim cells of each rendered row (value, and
// spread for value+spread) for checkTagged, which verifies the display strings against the values and evidence.
export function checkTables(text, file = '', doc = {}, { project } = {}) {
  if (byteLength(text) > MAX_INPUT_BYTES) return { findings: [finding(file, 1, 'INPUT_TOO_LARGE', `larger than ${MAX_INPUT_BYTES} bytes`)], markers: [] };
  const src = lf(text).normalize('NFC'), { findings, renders, byId } = tableBlocks(src, file, doc, project), markers = [];
  for (const { block, spec, text: table, body, firstLine } of renders) {
    const have = src.slice(block.begin.end, block.end.start).split('\n'), want = body.normalize('NFC').split('\n');
    let k = 0;
    while (k < have.length && k < want.length && have[k] === want[k]) k += 1;
    if (k < have.length || k < want.length) {
      findings.push(finding(file, firstLine + k, 'TABLE_DRIFT', `claims-table "${spec.id}" differs from its render from ${CLAIMS_FILE} tables[]; run node tools/check-claims.mjs --render-tables ${spec.project}=<README>`));
    }
    const rowText = table.split('\n');
    spec.rows.forEach((row, i) => row.cells.forEach((cell) => {
      if (!isStr(cell?.claim)) return;
      const claim = byId.get(cell.claim), line = firstLine + 3 + i, context = fold(rowText[2 + i]);
      markers.push({ file, id: claim.id, field: 'value', text: fold(claim.display.value[0]), line, context });
      if (cell.format === 'value+spread') markers.push({ file, id: claim.id, field: 'spread', text: fold(claim.display.spread[0]), line, context });
    }));
  }
  return { findings: findings.sort((a, b) => a.line - b.line), markers };
}

// applyTables(text, file, doc, { project }) -> { text, findings, rendered, changed }: the README with every
// claims-table block re-rendered. Only line ends are normalized (no NFC), so bytes outside the blocks are kept,
// and a CRLF file comes back CRLF. Pure: the caller decides whether to write, and must not write when there
// are findings.
export function applyTables(text, file = '', doc = {}, { project } = {}) {
  if (byteLength(text) > MAX_INPUT_BYTES) return { text, findings: [finding(file, 1, 'INPUT_TOO_LARGE', `larger than ${MAX_INPUT_BYTES} bytes`)], rendered: 0, changed: false };
  const crlf = String(text).includes('\r\n'), src = String(text).replace(/\r\n/g, '\n');
  const { findings, renders } = tableBlocks(src, file, doc, project), parts = [];
  let at = 0;
  for (const r of renders) { parts.push(src.slice(at, r.block.begin.end), r.body); at = r.block.end.start; }
  parts.push(src.slice(at));
  const next = crlf ? parts.join('').replace(/\n/g, '\r\n') : parts.join('');
  return { text: next, findings, rendered: renders.length, changed: next !== text };
}

// ---------- Methodology ----------
// BENCH-04: each README states how its numbers were measured, in a block with these five labels, each at the start
// of a line or list item (bold allowed). The labels are the planner's reading of BENCH-04; the owner reviews the text.
export const METHODOLOGY_LABELS = Object.freeze(['Warm-up:', 'Timer:', 'Repetitions:', 'Outliers:', 'Noise control:']);
const LABEL_LINES = METHODOLOGY_LABELS.map((label) => [label,
  new RegExp(String.raw`^[ \t]*(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+)?(?:\*\*|__)?` + label + String.raw`(?:\*\*|__)?(.*)$`, 'm')]);

// checkMethodology(text, file) -> findings (METHODOLOGY_MISSING, METHODOLOGY_FIELD, INPUT_TOO_LARGE). The numbers
// inside the block are scanned by scanMarkdown like any other README text.
export function checkMethodology(text, file = '') {
  if (byteLength(text) > MAX_INPUT_BYTES) return [finding(file, 1, 'INPUT_TOO_LARGE', `larger than ${MAX_INPUT_BYTES} bytes`)];
  const src = lf(text).normalize('NFC'), { methodology } = mdParse(src), lineOf = lineIndex(src), out = [];
  if (!methodology.blocks.length) {
    const open = methodology.unmatched.find((c) => c.kind === 'method-begin');
    return [finding(file, open ? open.line : 1, 'METHODOLOGY_MISSING', open
      ? '<!-- bench-methodology:begin --> has no <!-- bench-methodology:end -->'
      : `no <!-- bench-methodology:begin --> ... <!-- bench-methodology:end --> block (BENCH-04: ${METHODOLOGY_LABELS.join(' ')})`)];
  }
  for (const { begin, end } of methodology.blocks) {
    const body = src.slice(begin.end, end.start);
    for (const [label, re] of LABEL_LINES) {
      const m = re.exec(body);
      if (!m) out.push(finding(file, begin.line, 'METHODOLOGY_FIELD', `the bench-methodology block has no "${label}" line (at the start of a line or list item)`));
      else if (!m[1].trim()) out.push(finding(file, lineOf(begin.end + m.index), 'METHODOLOGY_FIELD', `"${label}" in the bench-methodology block has no text after it`));
    }
  }
  return out.sort((a, b) => a.line - b.line);
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

// ---------- Pins ----------
// CLAIM-06 / D-18: every upstream commit a page pins must be reachable from that repo's default branch.
// Two pin shapes: a GitHub permalink (the repo comes from the URL) and a short SHA in <code>…</code> (the repo
// comes from page_repos[<page basename>]). Comments are blanked first, so a commented-out link is not a pin.
const PERMALINK = /https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:blob|tree|commit)\/([0-9a-f]{7,40})(?![0-9A-Za-z])/g;
const SHORT_PIN = /<code(?:\s[^<>]*)?>([0-9a-f]{7,40})<\/code>/g;
const PIN_SHA = /^[0-9a-f]{7,40}$/;
const pageName = (file) => String(file).replace(/\\/g, '/').split('/').pop().replace(/\.html$/i, '');

// extractPins(html, file, doc) -> { pins: [{ repo, sha, file, line, kind: 'permalink' | 'short' }], findings }.
// A short SHA on a page that page_repos does not map, or a permalink naming a repo (or owner) that repos does
// not list, is PIN_UNKNOWN_REPO: a pin the checker cannot resolve fails rather than being skipped.
export function extractPins(html, file = '', doc = {}) {
  const src = blankComments(String(html)), lineOf = lineIndex(src), pins = [], findings = [];
  const repos = isObj(doc?.repos) ? doc.repos : {}, pageRepos = isObj(doc?.page_repos) ? doc.page_repos : {};
  for (const m of src.matchAll(PERMALINK)) {
    const [, owner, repo, sha] = m, line = lineOf(m.index);
    if (Object.hasOwn(repos, repo) && repos[repo]?.owner === owner) pins.push({ repo, sha, file, line, kind: 'permalink' });
    else findings.push(finding(file, line, 'PIN_UNKNOWN_REPO', `github.com/${owner}/${repo} (pinned at ${sha.slice(0, 7)}) is not a repo in ${CLAIMS_FILE}`));
  }
  const page = pageName(file), repo = Object.hasOwn(pageRepos, page) ? pageRepos[page] : undefined;
  for (const m of src.matchAll(SHORT_PIN)) {
    const sha = m[1], line = lineOf(m.index);
    if (typeof repo === 'string' && Object.hasOwn(repos, repo)) pins.push({ repo, sha, file, line, kind: 'short' });
    else findings.push(finding(file, line, 'PIN_UNKNOWN_REPO', `<code>${sha}</code> is on page "${page}", which page_repos in ${CLAIMS_FILE} does not map to a repo`));
  }
  return { pins, findings };
}

// mapLimit(items, limit, fn) -> results in input order, whatever order the calls finish in.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// A reachability result (from createSources(...).isReachable):
//   { state: 'reachable', ref, status } | { state: 'unreachable', ref, status } | { state: 'unknown', reason }.
// unknown (network error, timeout, rate limit, any other failure) is COULD_NOT_VERIFY: never a pass (T-02-09).
async function reachOf(isReachable, repo, sha) {
  try {
    const r = await isReachable(repo, sha);
    return r && ['reachable', 'unreachable', 'unknown'].includes(r.state) ? r : { state: 'unknown', reason: 'no reachability result' };
  } catch {
    return { state: 'unknown', reason: 'the reachability check failed' };
  }
}

// checkPins(pins, { isReachable }) -> Promise<findings>. Each distinct repo@sha is queried once (at most
// `concurrency` at a time) and its result is reported at every location that pins it, in file and line order.
export async function checkPins(pins, { isReachable, concurrency = 4 } = {}) {
  const keys = [...new Set(pins.map((p) => `${p.repo}@${p.sha}`))].sort();
  const results = new Map(await mapLimit(keys, concurrency, async (key) => {
    const at = key.lastIndexOf('@');
    return [key, await reachOf(isReachable, key.slice(0, at), key.slice(at + 1))];
  }));
  const out = [];
  for (const p of pins) {
    const r = results.get(`${p.repo}@${p.sha}`);
    if (r.state === 'unreachable') out.push(finding(p.file, p.line, 'PIN_UNREACHABLE', `${p.repo}@${p.sha} is not reachable from ${r.ref} (${r.status})`));
    else if (r.state === 'unknown') out.push(finding(p.file, p.line, 'COULD_NOT_VERIFY', `${p.repo}@${p.sha}: reachability not verified (${r.reason})`));
  }
  return sortFindings(out);
}

// ---------- GitHub ----------
// Read-only GitHub calls with an injected fetch. The token goes only into the Authorization header of
// api.github.com requests and never into a message; a reason names the URL path and the HTTP status only (T-02-06).
// A response whose final URL is not on one of the two hosts below is rejected (T-02-08).
const GITHUB_HOSTS = Object.freeze(['api.github.com', 'raw.githubusercontent.com']);
const FETCH_TIMEOUT_MS = 15000;
const COMPARE_STATUSES = Object.freeze(['identical', 'behind', 'ahead', 'diverged']);
const GIT_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]+$/;
const enc = encodeURIComponent;

// Reads a body up to `cap` bytes; a larger body is cancelled and reported, never buffered whole.
async function readCapped(res, cap = MAX_INPUT_BYTES) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return byteLength(text) > cap ? { tooLarge: true } : { text };
  }
  const reader = res.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel().catch(() => { /* already closed */ }); return { tooLarge: true }; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(all) };
}

const rateLimited = (res, text) => (res.status === 403 || res.status === 429)
  && (res.headers?.get?.('x-ratelimit-remaining') === '0' || /rate limit/i.test(text ?? ''));

// githubGet(url, { fetchImpl, token }) -> { ok: true, status, text } | { ok: false, status, reason, tooLarge? }.
async function githubGet(url, { fetchImpl = fetch, token } = {}) {
  const u = new URL(url), where = u.pathname;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'portfolio-claims-check', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token && u.host === 'api.github.com') headers.Authorization = `Bearer ${token}`;
  let res, body;
  try {
    res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    let host = '';
    try { host = new URL(res.url).host; } catch { /* no final URL: rejected just below */ }
    if (!GITHUB_HOSTS.includes(host)) return { ok: false, status: res.status ?? 0, reason: `${where}: the response came from an unexpected host` };
    body = await readCapped(res);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const cause = typeof err?.cause?.code === 'string' && /^[A-Z_]+$/.test(err.cause.code) ? `, ${err.cause.code}` : '';
    return { ok: false, status: 0, reason: `${where}: ${timedOut ? `no response within ${FETCH_TIMEOUT_MS / 1000} s` : `network error${cause}`}` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, reason: `${where}: HTTP ${res.status}${rateLimited(res, body.text) ? ' (rate limited; set GITHUB_TOKEN)' : ''}` };
  }
  if (body.tooLarge) return { ok: false, status: res.status, tooLarge: true, reason: `${where}: larger than ${MAX_INPUT_BYTES} bytes` };
  return { ok: true, status: res.status, text: body.text };
}

async function githubJson(url, opts) {
  const r = await githubGet(url, opts);
  if (!r.ok) return r;
  try {
    return { ok: true, status: r.status, json: JSON.parse(r.text) };
  } catch {
    return { ok: false, status: r.status, reason: `${new URL(url).pathname}: the response is not JSON` };
  }
}

// githubDefaultBranch(owner, repo) -> { ok: true, branch } | { ok: false, status, reason }.
export async function githubDefaultBranch(owner, repo, { fetchImpl = fetch, token } = {}) {
  const r = await githubJson(`https://api.github.com/repos/${enc(owner)}/${enc(repo)}`, { fetchImpl, token });
  if (!r.ok) return r;
  const branch = r.json?.default_branch;
  return typeof branch === 'string' && GIT_REF.test(branch) ? { ok: true, branch }
    : { ok: false, status: r.status, reason: `/repos/${owner}/${repo}: no usable default_branch in the response` };
}

// githubCompare(owner, repo, base, head) -> { ok: true, status: identical | behind | ahead | diverged }
// | { ok: false, status: <HTTP status, 0 for no response>, reason }. GET /repos/{o}/{r}/compare/{base}...{head}.
export async function githubCompare(owner, repo, base, head, { fetchImpl = fetch, token } = {}) {
  if (!GIT_REF.test(String(base)) || !PIN_SHA.test(String(head))) return { ok: false, status: 0, reason: `not a branch and commit pair: ${base}...${head}` };
  const r = await githubJson(`https://api.github.com/repos/${enc(owner)}/${enc(repo)}/compare/${base}...${head}?per_page=1`, { fetchImpl, token });
  if (!r.ok) return r;
  const status = r.json?.status;
  return COMPARE_STATUSES.includes(status) ? { ok: true, status }
    : { ok: false, status: r.status, reason: `/repos/${owner}/${repo}/compare: unexpected status ${JSON.stringify(status)}` };
}

// API reachability (D-18): identical or behind passes; ahead and diverged fail; a 404 or 422 (unknown or
// ambiguous short SHA) fails naming the HTTP status; anything else is unknown. The default branch is read
// from GitHub once per repo and must equal repos.<repo>.default_branch, so the two can't silently disagree.
function githubReachability(repos, { fetchImpl = fetch, token } = {}) {
  const branches = new Map(), results = new Map();
  const branchOf = (repo) => memo(branches, repo, async () => {
    const b = await githubDefaultBranch(repos[repo].owner, repo, { fetchImpl, token });
    if (b.ok && b.branch !== repos[repo].default_branch) {
      return { ok: false, reason: `GitHub's default branch is ${b.branch}, but repos.${repo}.default_branch is ${repos[repo].default_branch}` };
    }
    return b;
  });
  const isReachable = (repo, sha) => memo(results, `${repo}@${sha}`, async () => {
    if (!isObj(repos[repo]) || !PIN_SHA.test(String(sha))) return { state: 'unknown', reason: `not a known repo and commit: ${repo}@${sha}` };
    const b = await branchOf(repo);
    if (!b.ok) return { state: 'unknown', reason: b.reason };
    const c = await githubCompare(repos[repo].owner, repo, b.branch, sha, { fetchImpl, token });
    if (c.ok) return { state: c.status === 'identical' || c.status === 'behind' ? 'reachable' : 'unreachable', ref: b.branch, status: `compare status ${c.status}` };
    if (c.status === 404 || c.status === 422) return { state: 'unreachable', ref: b.branch, status: `HTTP ${c.status}` };
    return { state: 'unknown', reason: c.reason };
  });
  return { branchOf, isReachable };
}
const memo = (map, key, make) => { if (!map.has(key)) map.set(key, make()); return map.get(key); };

// ---------- Sources ----------
// Where upstream READMEs, evidence files and reachability come from (D-19):
//   api            GitHub: README.md at the default-branch HEAD, evidence from raw.githubusercontent.com at
//                  evidence.sha, reachability through the compare endpoint (CI and the default local run).
//   local          sibling clones <dir>/<repo>: README.md from the working tree, evidence through
//                  git show <sha>:<path>, reachability through git merge-base --is-ancestor <sha> <ref>.
//   evidence-root  the plan 02-01 fixture seam: evidence from <dir>/<repo>/<sha>/<path>; a SHA is reachable when
//                  <dir>/<repo>/<sha>/ exists; there is no README source (use --readme-file).
// createSources(mode, opts) -> { mode, readReadme(repo), readEvidence(repo, sha, path), isReachable(repo, sha) }.
// The readers return text or reject with a SourceError whose code is NOT_FOUND, INPUT_TOO_LARGE,
// COULD_NOT_VERIFY or NO_SOURCE. git runs through execFile with an argument array, never through a shell.
class SourceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const SOURCE_CODES = Object.freeze(['INPUT_TOO_LARGE', 'COULD_NOT_VERIFY']);
const REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const GIT_TIMEOUT_MS = 15000;
const firstLine = (s) => String(s ?? '').trim().split(/\r?\n/)[0].slice(0, 200);
const sha7 = (s) => String(s).slice(0, 7);
const tooLarge = (what) => new SourceError('INPUT_TOO_LARGE', `${what} is larger than ${MAX_INPUT_BYTES} bytes`);
const shaAndPath = (sha, rel) => {
  if (!PIN_SHA.test(String(sha))) throw new SourceError('NOT_FOUND', `not a commit SHA: ${sha}`);
  if (!safePath(rel)) throw new SourceError('NOT_FOUND', `not a repo-relative path: ${rel}`);
};

// The default execFile: resolves { code, stdout (bytes), stderr, tooLarge }; never rejects.
function runGit(file, args) {
  return new Promise((resolve) => {
    nodeExecFile(file, args, { encoding: 'buffer', maxBuffer: MAX_INPUT_BYTES + 1, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        stdout: stdout ?? new Uint8Array(0), stderr: String(stderr ?? ''), tooLarge: err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
  });
}

export function createSources(mode, opts = {}) {
  if (mode === 'api') return apiSources(opts);
  if (mode === 'local') return localSources(opts);
  if (mode === 'evidence-root') return rootSources(opts);
  throw new Error(`unknown source mode "${mode}"`);
}

function apiSources({ repos = {}, fetchImpl = fetch, token } = {}) {
  const { branchOf, isReachable } = githubReachability(repos, { fetchImpl, token });
  const files = new Map();
  const segs = (p) => String(p).split('/').map(enc).join('/');
  // raw.githubusercontent.com gets no token: the repos are public, and the token stays with api.github.com.
  const raw = (repo, ref, rel) => memo(files, `${repo}@${ref}:${rel}`, async () => {
    const r = await githubGet(`https://raw.githubusercontent.com/${enc(repos[repo].owner)}/${enc(repo)}/${segs(ref)}/${segs(rel)}`, { fetchImpl });
    if (r.ok) return r.text;
    throw new SourceError(r.tooLarge ? 'INPUT_TOO_LARGE' : r.status === 404 ? 'NOT_FOUND' : 'COULD_NOT_VERIFY', r.reason);
  });
  const known = (repo) => { if (!isObj(repos[repo])) throw new SourceError('COULD_NOT_VERIFY', `${repo} is not a repo in ${CLAIMS_FILE}`); };
  return {
    mode: 'api',
    async readReadme(repo) {
      known(repo);
      const b = await branchOf(repo);
      if (!b.ok) throw new SourceError('COULD_NOT_VERIFY', b.reason);
      return raw(repo, b.branch, 'README.md');
    },
    async readEvidence(repo, sha, rel) {
      known(repo);
      shaAndPath(sha, rel);
      return raw(repo, sha, rel);
    },
    isReachable,
  };
}

function localSources({ dir, ref = 'HEAD', execFileImpl = runGit, readFileImpl = fsReadFile } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('local mode needs the directory that holds the clones');
  if (!GIT_REF.test(String(ref))) throw new Error(`not a usable git ref: ${ref}`);
  const repoDir = (repo) => {
    if (!REPO_NAME.test(String(repo))) throw new SourceError('COULD_NOT_VERIFY', `not a repo name: ${repo}`);
    return path.join(dir, repo);
  };
  const git = async (repo, args) => {
    try {
      return await execFileImpl('git', ['-C', repoDir(repo), ...args]);
    } catch (err) {
      if (err instanceof SourceError) throw err;
      return { code: null, stdout: new Uint8Array(0), stderr: 'git could not be run' };
    }
  };
  const results = new Map();
  return {
    mode: 'local',
    async readReadme(repo) {
      const file = path.join(repoDir(repo), 'README.md');
      let text;
      try {
        text = await readFileImpl(file, 'utf8');
      } catch (err) {
        throw new SourceError(err?.code === 'ENOENT' ? 'NOT_FOUND' : 'COULD_NOT_VERIFY', `cannot read ${file} (${err?.code ?? 'error'})`);
      }
      if (byteLength(text) > MAX_INPUT_BYTES) throw tooLarge(file);
      return text;
    },
    async readEvidence(repo, sha, rel) {
      shaAndPath(sha, rel);
      const r = await git(repo, ['show', `${sha}:${rel}`]);
      if (r.tooLarge) throw tooLarge(`${repo}@${sha7(sha)}:${rel}`);
      if (r.code !== 0) {
        const missing = /does not exist in|exists on disk, but not in/.test(r.stderr);
        throw new SourceError(missing ? 'NOT_FOUND' : 'COULD_NOT_VERIFY', `git show ${sha7(sha)}:${rel} in ${repo} failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
      }
      const text = new TextDecoder().decode(r.stdout);
      if (byteLength(text) > MAX_INPUT_BYTES) throw tooLarge(`${repo}@${sha7(sha)}:${rel}`);
      return text;
    },
    isReachable: (repo, sha) => memo(results, `${repo}@${sha}`, async () => {
      if (!PIN_SHA.test(String(sha))) return { state: 'unknown', reason: `not a commit SHA: ${sha}` };
      let r;
      try { r = await git(repo, ['merge-base', '--is-ancestor', sha, ref]); } catch (err) { return { state: 'unknown', reason: err.message }; }
      if (r.code === 0) return { state: 'reachable', ref, status: 'ancestor' };
      if (r.code === 1) return { state: 'unreachable', ref, status: `git merge-base: not an ancestor of ${ref}` };
      return { state: 'unknown', reason: `git merge-base in ${repo} exited ${r.code ?? 'abnormally'}${r.stderr ? `: ${firstLine(r.stderr)}` : ''}` };
    }),
  };
}

function rootSources({ dir, readFileImpl = fsReadFile, readdirImpl = fsReaddir } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('evidence-root mode needs a directory');
  const base = path.resolve(dir);
  return {
    mode: 'evidence-root',
    async readReadme() {
      throw new SourceError('NO_SOURCE', 'evidence-root mode has no README source; pass --readme-file <project>=<path>');
    },
    async readEvidence(repo, sha, rel) {
      if (!REPO_NAME.test(String(repo))) throw new SourceError('NOT_FOUND', `not a repo name: ${repo}`);
      shaAndPath(sha, rel);
      const file = path.resolve(base, String(repo), String(sha), ...String(rel).split('/'));
      if (!file.startsWith(base + path.sep)) throw new SourceError('NOT_FOUND', 'evidence path escapes the evidence root');
      let text;
      try {
        text = await readFileImpl(file, 'utf8');
      } catch (err) {
        throw new SourceError(err?.code === 'ENOENT' ? 'NOT_FOUND' : 'COULD_NOT_VERIFY', err?.message ?? 'read failed');
      }
      if (byteLength(text) > MAX_INPUT_BYTES) throw tooLarge(rel);
      return text;
    },
    async isReachable(repo, sha) {
      if (!REPO_NAME.test(String(repo)) || !PIN_SHA.test(String(sha))) return { state: 'unknown', reason: `not a repo and commit: ${repo}@${sha}` };
      let entries;
      try {
        entries = await readdirImpl(path.join(base, repo), { withFileTypes: true });
      } catch (err) {
        if (err?.code !== 'ENOENT') return { state: 'unknown', reason: `cannot list the evidence root (${err?.code ?? 'error'})` };
        entries = [];
      }
      const found = entries.some((e) => e.isDirectory() && SHA_RE.test(e.name) && e.name.startsWith(sha));
      return found ? { state: 'reachable', ref: 'the evidence root', status: 'commit directory' }
        : { state: 'unreachable', ref: 'the evidence root', status: 'no commit directory' };
    },
  };
}

// ---------- Evidence ----------
// checkEvidence(doc, sources, { text, file, project }) -> Promise<findings> for every proposed or approved claim
// with evidence (retired ones are no longer shown). evidence.sha and source_sha go through the same reachability as
// page pins, so a squash or rebase that orphans either fails (PIN_UNREACHABLE). A pointer claim also reads
// meta.json next to its summary.json at evidence.sha: meta.source.sha must be source_sha (EVIDENCE_SOURCE_SHA),
// and the stats object must carry the claim's measure and build (EVIDENCE_LABEL). A pattern claim's single
// capture group, read from the file at evidence.sha, must parse to value (EVIDENCE_PATTERN).
const metaPathOf = (p) => `${String(p).replace(/[^/]*$/, '')}meta.json`;

async function readEvidenceJson(readEvidence, ev, rel) {
  let text;
  try {
    text = await readEvidence(ev.repo, ev.sha, rel);
  } catch (err) {
    return { code: SOURCE_CODES.includes(err?.code) ? err.code : 'NOT_FOUND', reason: `cannot read ${ev.repo}@${sha7(ev.sha)}:${rel} (${err?.message})` };
  }
  if (byteLength(text) > MAX_INPUT_BYTES) return { code: 'INPUT_TOO_LARGE', reason: `${rel} is larger than ${MAX_INPUT_BYTES} bytes` };
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { code: 'NOT_JSON', reason: `${rel} at ${sha7(ev.sha)} is not valid JSON` };
  }
}
const failCode = (code, fallback) => (SOURCE_CODES.includes(code) ? code : fallback);

async function pointerEvidence(c, readEvidence, at) {
  const ev = c.evidence, s = await readEvidenceJson(readEvidence, ev, ev.path);
  if (!s.json) return [at(failCode(s.code, 'EVIDENCE_POINTER'), s.reason)];
  const stats = resolvePointer(s.json, ev.pointer);
  if (!isObj(stats)) return [at('EVIDENCE_POINTER', `pointer ${ev.pointer} does not resolve to a stats object in ${ev.path} at ${sha7(ev.sha)}`)];
  const out = [];
  for (const k of ['measure', 'build']) {
    if (stats[k] !== c[k]) out.push(at('EVIDENCE_LABEL', `the evidence stats have ${k} ${stats[k]}, but the claim has ${k} ${c[k]}`));
  }
  const m = await readEvidenceJson(readEvidence, ev, metaPathOf(ev.path));
  if (!m.json) out.push(at(failCode(m.code, 'EVIDENCE_SOURCE_SHA'), `no readable meta.json next to ${ev.path}: ${m.reason}`));
  else if (m.json?.source?.sha !== c.source_sha) {
    out.push(at('EVIDENCE_SOURCE_SHA', `meta.json source.sha ${sha7(m.json?.source?.sha)} is not the claim's source_sha ${sha7(c.source_sha)}`));
  }
  return out;
}

async function patternEvidence(c, readEvidence, at) {
  const ev = c.evidence;
  let text, re;
  try {
    text = await readEvidence(ev.repo, ev.sha, ev.path);
  } catch (err) {
    return [at(failCode(err?.code, 'EVIDENCE_PATTERN'), `cannot read ${ev.repo}@${sha7(ev.sha)}:${ev.path} (${err?.message})`)];
  }
  if (byteLength(text) > MAX_INPUT_BYTES) return [at('INPUT_TOO_LARGE', `${ev.path} is larger than ${MAX_INPUT_BYTES} bytes`)];
  try { re = new RegExp(ev.pattern); } catch { return [at('EVIDENCE_PATTERN', 'evidence.pattern does not compile')]; }
  const m = re.exec(text), got = m?.[1];
  if (typeof got !== 'string') return [at('EVIDENCE_PATTERN', `evidence.pattern has no match in ${ev.path} at ${sha7(ev.sha)}`)];
  const digits = got.replace(/[,_\s]/g, ''), n = Number(digits);
  if (/^[+-]?\d/.test(digits) && n === c.value) return [];
  return [at('EVIDENCE_PATTERN', `evidence.pattern captures "${got.slice(0, 40)}" in ${ev.path}, but value is ${c.value}`)];
}

async function claimEvidence(c, sources, at) {
  const ev = c.evidence, out = [];
  for (const [label, repo, sha] of [['evidence.sha', ev.repo, ev.sha], ['source_sha', c.project, c.source_sha]]) {
    if (!SHA_RE.test(String(sha ?? ''))) continue;   // validateClaims reports a malformed SHA
    const r = await reachOf(sources.isReachable, repo, sha);
    if (r.state === 'unreachable') out.push(at('PIN_UNREACHABLE', `${label} ${sha7(sha)} is not reachable from ${r.ref} (${r.status})`));
    else if (r.state === 'unknown') out.push(at('COULD_NOT_VERIFY', `${label} ${sha7(sha)}: reachability not verified (${r.reason})`));
  }
  if (!SHA_RE.test(String(ev.sha ?? '')) || !safePath(ev.path)) return out;
  if (typeof ev.pointer === 'string') out.push(...await pointerEvidence(c, sources.readEvidence, at));
  else if (typeof ev.pattern === 'string') out.push(...await patternEvidence(c, sources.readEvidence, at));
  return out;
}

export async function checkEvidence(doc, sources, { text, file = CLAIMS_FILE, project, concurrency = 4 } = {}) {
  const claims = Array.isArray(doc?.claims) ? doc.claims : [], lines = locateClaims(text, claims);
  const jobs = claims.map((c, i) => ({ c, line: lines[i] })).filter(({ c }) => isObj(c) && isObj(c.evidence)
    && c.status !== 'retired' && (project === undefined || c.project === project));
  const results = await mapLimit(jobs, concurrency, ({ c, line }) => claimEvidence(c, sources, (code, msg) => finding(file, line, code, `${c.id}: ${msg}`)));
  return sortFindings(results.flat());
}

// ---------- Fill values ----------
// fillValues(doc, readEvidence) -> { doc, changed: [claim index], findings }. For each proposed pointer claim, copies
// value (stats[stat]), n (stats.n) and spread low/high (the stats keys spread.kind names) from its evidence, so a
// claim value is never typed by hand. Approved and retired entries are passed through as the same objects: once
// the owner approves an entry, no tool rewrites it (D-02). The input document is not mutated.
export async function fillValues(doc, readEvidence, { text, file = CLAIMS_FILE } = {}) {
  const claims = Array.isArray(doc?.claims) ? doc.claims : [], lines = locateClaims(text, claims);
  const next = [...claims], changed = [], findings = [], reads = new Map();
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    if (!isObj(c) || c.status !== 'proposed' || !isObj(c.evidence) || typeof c.evidence.pointer !== 'string') continue;
    const at = (code, msg) => findings.push(finding(file, lines[i], code, `${c.id}: ${msg}`)), ev = c.evidence;
    const s = await memo(reads, `${ev.repo}@${ev.sha}:${ev.path}`, () => readEvidenceJson(readEvidence, ev, ev.path));
    if (!s.json) { at(failCode(s.code, 'EVIDENCE_POINTER'), s.reason); continue; }
    const stats = resolvePointer(s.json, ev.pointer), keys = SPREAD_KEYS[c.spread?.kind];
    if (!isObj(stats)) { at('EVIDENCE_POINTER', `pointer ${ev.pointer} does not resolve to a stats object in ${ev.path}`); continue; }
    if (!keys) { at('EVIDENCE_POINTER', `spread.kind must be one of ${Object.keys(SPREAD_KEYS).join(', ')} to fill the spread`); continue; }
    const value = stats[c.stat], n = stats.n, low = stats[keys[0]], high = stats[keys[1]];
    const lacking = [[String(c.stat), isNum(value)], ['n', isPosInt(n)], [keys[0], isNum(low)], [keys[1], isNum(high)]].filter(([, ok]) => !ok);
    if (lacking.length) { at('EVIDENCE_POINTER', `the stats at ${ev.pointer} lack ${lacking.map(([k]) => k).join(', ')}`); continue; }
    if (value === c.value && n === c.n && low === c.spread.low && high === c.spread.high) continue;
    next[i] = { ...c, value, n, spread: { ...c.spread, low, high } };
    changed.push(i);
  }
  return { doc: { ...doc, claims: next }, changed, findings };
}

// Offsets of each element of the top-level "claims" array in a JSON text (already known to parse).
function claimSpans(text) {
  const spans = [], LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  let i = 0;
  const skip = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
  const string = () => { const s = i++; while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1; i++; return text.slice(s, i); };
  const value = (depth, collect) => {
    skip();
    if (text[i] === '"') { string(); return; }
    if (text[i] === '{' || text[i] === '[') {
      const close = text[i] === '{' ? '}' : ']', isObject = close === '}';
      i++; skip();
      if (text[i] === close) { i++; return; }
      for (;;) {
        skip();
        let into = null;
        if (isObject) {
          const key = JSON.parse(string());
          into = depth === 0 && key === 'claims' ? spans : null;
          skip();
          i++;   // ':'
        }
        skip();
        const start = i;
        value(depth + 1, into);
        if (collect) collect.push({ start, end: i });
        skip();
        const sep = text[i++];
        if (sep === close) return;
        if (sep !== ',') throw new Error(`unexpected character at offset ${i - 1}`);
      }
    }
    LITERAL.lastIndex = i;
    const m = LITERAL.exec(text);
    if (!m) throw new Error(`unexpected character at offset ${i}`);
    i += m[0].length;
  };
  value(0, null);
  return spans;
}

// spliceClaims(text, doc, indices) -> the claims file text with only claims[i] (i in indices) re-serialized in place,
// as 2-space JSON at the entry's own indentation and with the file's line ending. Every other byte is kept, so an
// approved entry stays byte-identical. Throws when the result does not parse back to doc.
export function spliceClaims(text, doc, indices) {
  const spans = claimSpans(text), eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = text;
  for (const i of [...indices].sort((a, b) => b - a)) {
    const span = spans[i];
    if (!span) throw new Error(`claims[${i}] was not found in the claims file text`);
    if (!isObj(doc?.claims?.[i])) throw new Error(`claims[${i}] was not found in the filled document`);
    const lead = out.slice(out.lastIndexOf('\n', span.start - 1) + 1, span.start), indent = /^[ \t]*$/.test(lead) ? lead : '';
    out = out.slice(0, span.start) + JSON.stringify(doc.claims[i], null, 2).replace(/\n/g, `${eol}${indent}`) + out.slice(span.end);
  }
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(doc)) throw new Error('the rewritten claims file does not parse back to the filled document');
  return out;
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
