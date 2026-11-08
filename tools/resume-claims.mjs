// tools/resume-claims.mjs: resume-ready bullets from approved claims (bench/resume-templates.md ->
// bench/resume-bullets.md), and a local report of every number in the three project sections of the resume PDF
// against bench/claims.json (CLAIM-04, D-15). Node built-ins only (D-16). Exit 0 = ok, 1 = findings, 2 = usage or I/O.
// Usage: node tools/resume-claims.mjs [--claims <file>] [--templates <file>] [--out <file>] [--report <file>]
//          [--pdf <file> [--pdftotext <path>] | --text <file>]
// The report holds resume text (and the PDF holds contact details), so it is written only to a git-ignored path or
// outside any repository. The tool never writes under static/ and never changes the PDF; the owner edits its source.
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadClaims, validateClaims, parseDisplayNumber, parseDisplayRange, matchesDisplay, matchesRange,
  formatFinding } from './claims-lib.mjs';

const DEFAULTS = Object.freeze({
  claims: 'bench/claims.json',
  templates: 'bench/resume-templates.md',
  out: 'bench/resume-bullets.md',
  pdf: 'static/Brian_Yildirim.pdf',
  report: '.planning/phases/02-reproducible-benchmarking-and-metrics-consistency/02-RESUME-DIFF.md',
});
// The resume section of each benchmarked project, found by its title on an entry heading line ("Title | stack  dates").
const SECTIONS = Object.freeze([
  { project: 'ratelimit-cpp', title: 'Rate Limiter', re: /rate limiter/i },
  { project: 'image-quality-gate', title: 'Image Quality Gate', re: /image quality gate/i },
  { project: 'key-value-storage', title: 'Key-Value Server', re: /key-value/i },
]);
const USAGE = '[resume-claims] usage: node tools/resume-claims.mjs [--claims <file>] [--templates <file>] [--out <file>] [--report <file>] [--pdf <file> [--pdftotext <path>] | --text <file>]';
const MAX_PDF_TEXT = 4 * 1024 * 1024;

// ---------- Report ----------
// The only stdout writer in this tool.
function report(line) {
  process.stdout.write(`${line}\n`);
}

// ---------- Numbers ----------
// A number not glued to a preceding word character, '.', ',', '+', '/', '#' or '-' (so "C++20", "v1.2", "-O3" and the
// tail of a range never start one), with thousands separators, decimals, an optional ~ or ≈, an optional range to a
// second number (- or –), an optional SI suffix that does not start a word, and an optional trailing '+'.
const N = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const NUMBER = new RegExp(String.raw`(?<![\w.,+/#-])(?:[~≈]\s?)?` + N + String.raw`(?:\s?[-–]\s?` + N + String.raw`)?(?:\s?[kMG](?![A-Za-z]))?\+?`, 'g');
// The noun or unit right after a number, and the claims.json unit it compares with. Nouns with no claims unit
// (keys, runs, threads) are kept as their own unit, so they can only ever be "no claim".
const NOUNS = Object.freeze([
  [/^[\s-]?(bytes? per key|bytes?)\b/i, 'bytes'],
  [/^[\s-]?(tests?)\b/i, 'tests'],
  [/^[\s-]?((?:concurrent\s+)?(?:clients?|connections?))\b/i, 'connections'],
  [/^[\s-]?(calls\/s|ops\/s)(?![\w/])/i, 'ops/s'],
  [/^[\s-]?(cmd\/s|commands per second)(?![\w/])/i, 'cmd/s'],
  [/^[\s-]?(ms|milliseconds?)\b/, 'ms'],
  [/^[\s-]?(ns|nanoseconds?)\b/, 'ns'],
  [/^[\s-]?(µs|μs|us|microseconds?)\b/, 'µs'],
  [/^[\s-]?(MiB|MB)\b/, 'MiB'],
  [/^[\s-]?(KiB|KB)\b/, 'KiB'],
  [/^[\s-]?(seconds?)\b/i, 's'],
  [/^\s?(×|x)(?![\w])/, 'ratio'],
  [/^\s?(%)/, '%'],
  [/^[\s-]?(keys?)\b/i, 'keys'],
  [/^[\s-]?(runs?)\b/i, 'runs'],
  [/^[\s-]?(threads?)\b/i, 'threads'],
]);
// "6-28 of 1,000 runs": the noun of a count that is followed by "of <number>" is that number's noun.
const OF_NUMBER = new RegExp(String.raw`^\s+of\s+` + N + String.raw`(?:\s?[kMG](?![A-Za-z]))?`);

function nounAfter(rest) {
  for (const [re, unit] of NOUNS) {
    const m = re.exec(rest);
    if (m) return { noun: m[1], unit };
  }
  return { noun: '', unit: null };
}

// extractNumbers(text) -> [{ text, noun, unit, index, value, range }]. text is the number as written ("~134",
// "6-28", "1,000", "1M"); noun the words after it ("bytes per key"); unit the claims.json unit it compares with,
// or null; value the parsed number (parseDisplayNumber), range { low, high } for a range, else null.
export function extractNumbers(text) {
  const src = String(text).normalize('NFC').replace(/\s+/g, ' '), out = [];
  for (const m of src.matchAll(NUMBER)) {
    const end = m.index + m[0].length, rest = src.slice(end, end + 60);
    let { noun, unit } = nounAfter(rest);
    const of = unit ? null : OF_NUMBER.exec(rest);
    if (of) ({ noun, unit } = nounAfter(rest.slice(of[0].length)));
    const range = parseDisplayRange(m[0]);
    out.push({ text: m[0].trim(), noun: of && noun ? `${of[0].trim()} ${noun}` : noun, unit, index: m.index,
      value: parseDisplayNumber(m[0])?.number ?? null, range: range ? { low: range.low.number, high: range.high.number } : null });
  }
  return out;
}

// ---------- Difference ----------
const NO_MEASURABLE = /\bno measurable [a-z]+/gi;
const shownValue = (claim) => {
  const v = claim.display?.value?.[0];
  if (typeof v !== 'string') return String(claim.value);
  return v.includes(claim.unit) || claim.kind === 'comparison' ? v : `${v} ${claim.unit}`;
};
const accepts = (claim, n) => (n.range
  ? !!claim.spread && matchesRange(claim.spread.low, claim.spread.high, n.text)
  : matchesDisplay(claim.value, n.text));
const distance = (claim, n) => (typeof claim.value === 'number' && n.value !== null
  ? Math.abs(claim.value - n.value) / Math.max(Math.abs(claim.value), Math.abs(n.value), 1e-12) : Infinity);

// diffResume(sectionText, projectClaims) -> rows [{ context, number, status, claims, claimValue }]. Only approved
// claims count. A number matches every approved claim of the same unit whose display rule accepts it (the value, or
// the spread for a range); it differs when claims of that unit exist but none accepts it (the closest is shown);
// otherwise it has no claim. "no measurable <word>" phrases have no number and are listed as wording to check by hand.
export function diffResume(sectionText, projectClaims) {
  const approved = (projectClaims ?? []).filter((c) => c && c.status === 'approved'), rows = [];
  for (const bullet of bulletsOf(sectionText)) {
    for (const n of extractNumbers(bullet)) {
      const number = n.noun ? `${n.text} ${n.noun}` : n.text;
      const sameUnit = n.unit ? approved.filter((c) => c.unit === n.unit) : [];
      const hits = sameUnit.filter((c) => accepts(c, n));
      if (hits.length) {
        rows.push({ context: bullet, number, status: 'matches', claims: hits.map((c) => c.id), claimValue: shownValue(hits[0]) });
      } else if (sameUnit.length) {
        const near = [...sameUnit].sort((a, b) => distance(a, n) - distance(b, n))[0];
        rows.push({ context: bullet, number, status: 'differs', claims: [near.id], claimValue: shownValue(near) });
      } else {
        rows.push({ context: bullet, number, status: 'no claim', claims: [], claimValue: '' });
      }
    }
    for (const m of bullet.matchAll(NO_MEASURABLE)) rows.push({ context: bullet, number: m[0], status: 'wording', claims: [], claimValue: '' });
  }
  return rows;
}

// The bullets of a section's body: pdftotext prints the list glyph as U+2022 or, when the font has no Unicode
// mapping for it, U+FFFD. Lines are joined, so a number or noun wrapped onto the next line reads as one.
function bulletsOf(text) {
  return String(text).split(/[•▪●�]/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// sections(pdfText) -> [{ project, title, heading, body }] for the SECTIONS found. A section starts at its entry
// heading line (title plus '|') and ends at the next entry heading or an all-caps section heading. The heading line
// (title, stack, dates) is not scanned: its numbers are dates and language versions, not claims.
export function sections(pdfText) {
  const lines = String(pdfText).replace(/\r\n?/g, '\n').split('\n');
  const isHeading = (l) => l.includes('|') || /^\s*[A-Z][A-Z &]{3,}\s*$/.test(l);
  return SECTIONS.map((s) => {
    const at = lines.findIndex((l) => l.includes('|') && s.re.test(l));
    if (at === -1) return { ...s, heading: null, body: null };
    let end = at + 1;
    while (end < lines.length && !isHeading(lines[end])) end += 1;
    return { ...s, heading: lines[at].replace(/\s+/g, ' ').trim(), body: lines.slice(at + 1, end).join('\n') };
  });
}

const cell = (s) => String(s).replace(/\s+/g, ' ').replace(/\|/g, '\\|');
// renderReport(found, claims, source) -> markdown.
export function renderReport(found, claims, source = DEFAULTS.pdf) {
  const out = [
    '# Resume difference report (local only)',
    '',
    `Generated by \`node tools/resume-claims.mjs\` from the text of \`${source}\` and the approved claims in \`bench/claims.json\`.`,
    '',
    '- This file holds text from the resume. It stays under `.planning/` and is never committed.',
    '- It compares text only. The tool never changes the PDF: edit the resume source yourself, then re-run the tool.',
    '- **matches**: an approved claim of the same unit rounds to the resume figure (every such claim is listed).',
    '- **differs**: approved claims of that unit exist, but none rounds to the resume figure (the closest is shown).',
    '- **no claim**: no approved claim has that unit, so nothing backs the figure.',
    '- **wording**: a statement with no number ("no measurable ..."). Compare it with the case-study Results section by hand.',
    '- The entry heading line (title, stack, dates) is not scanned. A number wrapped across lines is read as one.',
  ];
  for (const s of found) {
    out.push('', `## ${s.title} (${s.project})`, '');
    if (s.body === null) { out.push(`Section not found: no entry heading line mentions "${s.title}".`); continue; }
    const rows = diffResume(s.body, claims.filter((c) => c?.project === s.project));
    if (!rows.length) { out.push('No numbers found in this section.'); continue; }
    out.push('| Resume text | Number | Status | Claim | Claim value |', '|---|---|---|---|---|');
    for (const r of rows) out.push(`| ${cell(r.context)} | ${cell(r.number)} | ${r.status} | ${r.claims.map((id) => `\`${id}\``).join('<br>')} | ${cell(r.claimValue)} |`);
  }
  return `${out.join('\n')}\n`;
}

// ---------- Bullets ----------
const PLACEHOLDER = /\{\{claim:([^}#\s]*)(?:#([^}\s]*))?\}\}/g;
const FIELDS = Object.freeze(['value', 'spread', 'n', 'environment']);
const lookup = (byId, id) => (byId instanceof Map ? byId.get(id) : (byId && Object.hasOwn(byId, id) ? byId[id] : undefined));

export class TemplateError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

// renderBullets(templates, claimsById, { environments }) -> markdown. Every {{claim:<id>}} (first display.value),
// {{claim:<id>#spread}}, {{claim:<id>#n}} and {{claim:<id>#environment}} (display.environment, else the
// environment's label) is replaced by the claim's own display string. HTML comments in the templates are guidance
// and are dropped. Throws TemplateError listing every unknown, non-approved or unrenderable placeholder.
export function renderBullets(templates, claimsById, { environments = {} } = {}) {
  const problems = [], body = String(templates).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->\n?/g, '');
  const text = body.replace(PLACEHOLDER, (all, id, field = 'value') => {
    const claim = lookup(claimsById, id);
    if (!FIELDS.includes(field)) { problems.push(`${all}: unknown field "${field}" (use ${FIELDS.join(', ')})`); return all; }
    if (!claim) { problems.push(`${id}: not in bench/claims.json`); return all; }
    if (claim.status !== 'approved') { problems.push(`${id}: has status ${claim.status}; only approved claims may be used`); return all; }
    const shown = claim.display?.[field]?.[0] ?? (field === 'environment' ? environments[claim.environment]?.label : undefined);
    if (typeof shown !== 'string') { problems.push(`${id}: has no display.${field} string to show`); return all; }
    return shown;
  });
  if (/\{\{/.test(text.replace(PLACEHOLDER, ''))) problems.push('a "{{" is not a {{claim:<id>[#field]}} placeholder');
  if (problems.length) throw new TemplateError([...new Set(problems)]);
  return `<!-- Generated by tools/resume-claims.mjs from bench/resume-templates.md and bench/claims.json (approved claims only). Edit the templates, then re-run the tool. -->\n${text.replace(/^\n+/, '')}`;
}

// Contact details must never reach the generated bullets (T-02-32): an e-mail '@', a 7+ digit run or a phone shape.
export function contactLike(text) {
  return /@/.test(text) || /\d{7,}/.test(text) || /\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/.test(text);
}

// ---------- I/O ----------
class UsageError extends Error {}
const posix = (p) => p.split(path.sep).join('/');
const shown = (p) => {
  const rel = path.relative(process.cwd(), path.resolve(p));
  return posix(rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? path.resolve(p) : rel);
};
const run = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: MAX_PDF_TEXT, windowsHide: true, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
});

// pdftotext runs with an argument array (no shell, T-02-33); its UTF-8 text goes to stdout.
async function pdfText(pdf, pdftotext) {
  try {
    return await run(pdftotext, ['-layout', '-enc', 'UTF-8', pdf, '-']);
  } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `cannot run ${pdftotext} (install xpdf or poppler, or pass --text <file>)` : `${pdftotext} failed on ${shown(pdf)} (${String(err.stderr || err.message).trim()})`);
  }
}

async function existingDir(p) {
  for (let d = path.dirname(path.resolve(p)); ; d = path.dirname(d)) {
    try { if ((await stat(d)).isDirectory()) return d; } catch { /* missing: try the parent */ }
    if (path.dirname(d) === d) return d;
  }
}
// Where the report may go: never under static/, and inside a git work tree only on an ignored path. git
// check-ignore exits 0 (ignored), 1 (not ignored) or 128 (not a repository: outside any repo, allowed).
async function checkReportPath(file) {
  const abs = path.resolve(file);
  try {
    await run('git', ['check-ignore', '-q', abs], { cwd: await existingDir(abs) });
    return null;
  } catch (err) {
    if (err.code === 1) return `--report ${shown(file)} is not git-ignored; the report holds resume text, so write it under .planning/ or outside the repository`;
    if (err.code === 'ENOENT' || err.code === 128) return null;
    throw err;
  }
}
const underStatic = (file) => posix(path.relative(process.cwd(), path.resolve(file))).split('/')[0] === 'static';

async function write(file, text) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, text);
}

async function main() {
  let opt;
  try {
    ({ values: opt } = parseArgs({ options: {
      claims: { type: 'string' }, templates: { type: 'string' }, out: { type: 'string' }, pdf: { type: 'string' },
      text: { type: 'string' }, pdftotext: { type: 'string' }, report: { type: 'string' },
    } }));
    if (opt.text !== undefined && (opt.pdf !== undefined || opt.pdftotext !== undefined)) throw new UsageError('pick one input: --pdf <file> or --text <file>');
  } catch (err) {
    report(`[resume-claims] ${err.message}`);
    report(USAGE);
    return 2;
  }
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined)) };
  for (const [flag, file] of [['--out', o.out], ['--report', o.report]]) {
    if (underStatic(file)) { report(`[resume-claims] ${flag} ${shown(file)} is under static/; this tool never writes there`); return 2; }
  }
  const reportProblem = await checkReportPath(o.report);
  if (reportProblem) { report(`[resume-claims] ${reportProblem}`); return 2; }

  let claimsText, templates;
  try {
    claimsText = await readFile(o.claims, 'utf8');
    templates = await readFile(o.templates, 'utf8');
  } catch (err) {
    report(`[resume-claims] cannot read ${err.path ? shown(err.path) : 'an input'}`);
    return 2;
  }
  const { doc, findings: loadFindings } = loadClaims(claimsText, shown(o.claims));
  const schema = doc ? validateClaims(doc, { text: claimsText, file: shown(o.claims) }) : loadFindings;
  if (!doc || schema.length) {
    for (const f of schema) report(formatFinding(f));
    report(`[resume-claims] ${shown(o.claims)} has ${schema.length} schema finding(s); fix them before generating resume text`);
    return 1;
  }
  const claims = doc.claims, byId = new Map(claims.map((c) => [c.id, c]));

  let bullets;
  try {
    bullets = renderBullets(templates, byId, { environments: doc.environments });
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err;
    for (const p of err.problems) report(`${shown(o.templates)}: ${p}`);
    report(`[resume-claims] ${err.problems.length} template problem(s); nothing written`);
    return 1;
  }
  if (contactLike(bullets)) { report(`[resume-claims] the bullets contain an '@', a 7+ digit run or a phone-like number; nothing written`); return 1; }

  let text, source;
  try {
    if (o.text !== undefined) { text = await readFile(o.text, 'utf8'); source = shown(o.text); }
    else { text = await pdfText(o.pdf, o.pdftotext ?? 'pdftotext'); source = shown(o.pdf); }
  } catch (err) {
    report(`[resume-claims] ${err.code === 'ENOENT' && err.path ? `cannot read ${shown(err.path)}` : err.message}`);
    return 2;
  }
  const found = sections(text), missing = found.filter((s) => s.body === null);
  try {
    await write(o.out, bullets);
    await write(o.report, renderReport(found, claims, source));
  } catch (err) {
    report(`[resume-claims] I/O error: ${err.message}`);
    return 2;
  }
  report(`[resume-claims] wrote ${shown(o.out)}`);
  report(`[resume-claims] wrote ${shown(o.report)} (local only)`);
  for (const s of missing) report(`[resume-claims] section not found in ${source}: ${s.title}`);
  return missing.length ? 1 : 0;
}

// Run only as a CLI: the tests import the pure functions above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main().catch((err) => { report(`[resume-claims] unexpected error: ${err.message}`); return 2; });
}
