// tools/check-claims.mjs: checks the numbers shown in the portfolio against bench/claims.json and their
// evidence files (CLAIM-01..06), and validates benchmark results directories (BENCH-01..03). Node built-ins only
// (D-16). Exit 0 = clean, 1 = findings, 2 = usage or I/O error.
// Usage: node tools/check-claims.mjs [--root <dir>] [--claims <file>] [--only claims,html,js] [--evidence-root <dir>]
//        node tools/check-claims.mjs --validate-results <env, session or results directory>
import { parseArgs } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_INPUT_BYTES, loadClaims, validateClaims, locateClaims, checkComparison, extractTaggedLeaves, checkTagged,
  scanHtml, scanJsLines, validateResultsDir, sortFindings, formatFinding } from './claims-lib.mjs';

// The default run (no --only) runs every check listed here.
const CHECKS = ['claims', 'html', 'js'];
const USAGE = '[check-claims] usage: node tools/check-claims.mjs [--root <dir>] [--claims <file>] [--only <checks>] [--evidence-root <dir>] | --validate-results <dir>';

// ---------- Report ----------
// The only stdout writer in tools/.
function report(line) {
  process.stdout.write(`${line}\n`);
}

// ---------- Sources ----------
const posix = (p) => p.split(path.sep).join('/');
async function htmlFiles(root) {
  const files = [];
  try {
    await readFile(path.join(root, 'index.html'));
    files.push('index.html');
  } catch { /* fixture roots may have no index.html */ }
  try {
    const found = await readdir(path.join(root, 'pages'), { recursive: true });
    for (const f of found) if (f.endsWith('.html')) files.push(posix(path.join('pages', f)));
  } catch { /* fixture roots may have no pages/ */ }
  return files.sort();
}

// The demo modules whose user-visible string literals are scanned (scripts/demos/*.js, not recursive).
async function jsFiles(root) {
  try {
    return (await readdir(path.join(root, 'scripts', 'demos'))).filter((f) => f.endsWith('.js')).sort().map((f) => `scripts/demos/${f}`);
  } catch (err) {
    if (err.code === 'ENOENT') return [];   // fixture roots may have no scripts/demos/
    throw err;
  }
}

// Evidence lives at <evidence-root>/<repo>/<sha>/<path>. The resolved path must stay inside the root.
function evidenceReader(evidenceRoot) {
  return async (repo, sha, rel) => {
    if (!evidenceRoot) throw new Error('no evidence source configured (pass --evidence-root)');
    const base = path.resolve(evidenceRoot), file = path.resolve(base, String(repo), String(sha), ...String(rel).split('/'));
    if (!file.startsWith(base + path.sep)) throw new Error('evidence path escapes the evidence root');
    return readFile(file, 'utf8');
  };
}

// ---------- Checks ----------
// The claims file itself: schema, approval and label fields (validateClaims), and the D-14 rule for every comparison.
function checkClaimsFile(doc, text, file, claimsById) {
  const findings = validateClaims(doc, { text, file });
  const claims = Array.isArray(doc.claims) ? doc.claims : [], lines = locateClaims(text, claims);
  const environments = doc.environments !== null && typeof doc.environments === 'object' ? doc.environments : {};
  claims.forEach((c, i) => {
    if (c?.kind === 'comparison') findings.push(...checkComparison(c, claimsById, { environments, file, line: lines[i] }));
  });
  return findings;
}

async function checkHtml(root, claimsById, readEvidence) {
  const findings = [];
  let leafCount = 0;
  for (const rel of await htmlFiles(root)) {
    const text = await readFile(path.join(root, rel), 'utf8');
    if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
      findings.push({ file: rel, line: 1, code: 'INPUT_TOO_LARGE', message: `larger than ${MAX_INPUT_BYTES} bytes` });
      continue;
    }
    const leaves = extractTaggedLeaves(text, rel);
    leafCount += leaves.length;
    findings.push(...await checkTagged(claimsById, leaves, readEvidence));
    // Everything else on the page: an untagged unit-number or headline value fails (CLAIM-02, D-05).
    findings.push(...scanHtml(text, rel));
  }
  return { findings, leafCount };
}

async function checkJs(root) {
  const findings = [];
  for (const rel of await jsFiles(root)) findings.push(...scanJsLines(await readFile(path.join(root, rel), 'utf8'), rel));
  return findings;
}

// ---------- Results ----------
// --validate-results <dir>: bench-meta/1, bench-summary/1 and raw sha256 for a results directory.
async function validateResults(given) {
  const dir = path.resolve(given);
  let st;
  try {
    st = await stat(dir);
  } catch {
    report(`[check-claims] no such results directory: ${given}`);
    return 2;
  }
  if (!st.isDirectory()) {
    report(`[check-claims] not a directory: ${given}`);
    return 2;
  }
  const rel = path.relative(process.cwd(), dir);
  const label = posix(rel === '' ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? dir : rel);
  const { findings, checked } = await validateResultsDir(dir, { readFile, readdir, label });
  for (const f of sortFindings(findings)) report(formatFinding(f));
  for (const c of checked) report(`[check-claims] checked ${c}`);
  report(findings.length
    ? `[check-claims] ${findings.length} finding(s)`
    : `[check-claims] ok (validate-results: ${checked.length} environment director${checked.length === 1 ? 'y' : 'ies'})`);
  return findings.length ? 1 : 0;
}

// ---------- Main ----------
async function main() {
  let opt;
  try {
    ({ values: opt } = parseArgs({ options: {
      root: { type: 'string' }, claims: { type: 'string' }, only: { type: 'string' }, 'evidence-root': { type: 'string' },
      'validate-results': { type: 'string' },
    } }));
  } catch (err) {
    report(`[check-claims] ${err.message}`);
    report(USAGE);
    return 2;
  }
  if (opt['validate-results'] !== undefined) {
    if (opt.only !== undefined || opt.claims !== undefined) {
      report('[check-claims] --validate-results runs on its own; drop --only and --claims');
      return 2;
    }
    return validateResults(opt['validate-results']);
  }
  const root = path.resolve(opt.root ?? process.cwd());
  const claimsPath = opt.claims ?? path.join(root, 'bench', 'claims.json');
  const only = opt.only === undefined ? CHECKS : opt.only.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = only.filter((c) => !CHECKS.includes(c));
  if (unknown.length || !only.length) {
    report(`[check-claims] unknown check: ${unknown.join(', ') || '(none given)'}; known: ${CHECKS.join(', ')}`);
    return 2;
  }

  let text;
  try {
    text = await readFile(claimsPath, 'utf8');
  } catch {
    report(`[check-claims] cannot read claims file: ${claimsPath}`);
    return 2;
  }
  const claimsFile = posix(path.relative(root, path.resolve(claimsPath))) || 'claims.json';
  const { doc, findings: loadFindings } = loadClaims(text, claimsFile);
  if (!doc) {
    report(`[check-claims] cannot read claims file: ${claimsPath}`);
    for (const f of loadFindings) report(formatFinding(f));
    return 2;
  }

  const claims = Array.isArray(doc.claims) ? doc.claims : [];
  const claimsById = new Map();
  for (const c of claims) if (c && typeof c.id === 'string' && !claimsById.has(c.id)) claimsById.set(c.id, c);
  const findings = [];
  let leafCount = 0;
  if (only.includes('claims')) findings.push(...checkClaimsFile(doc, text, claimsFile, claimsById));
  try {
    if (only.includes('html')) {
      const r = await checkHtml(root, claimsById, evidenceReader(opt['evidence-root']));
      findings.push(...r.findings);
      leafCount += r.leafCount;
    }
    if (only.includes('js')) findings.push(...await checkJs(root));
  } catch (err) {
    report(`[check-claims] I/O error: ${err.message}`);
    return 2;
  }

  for (const f of sortFindings(findings)) report(formatFinding(f));
  report(findings.length
    ? `[check-claims] ${findings.length} finding(s)`
    : `[check-claims] ok (checks: ${only.join(', ')}; ${claims.length} claim(s), ${leafCount} tagged value(s))`);
  return findings.length ? 1 : 0;
}

// An unexpected failure is an I/O-class error (exit 2), never a silent pass or a stack trace on stdout.
process.exitCode = await main().catch((err) => { report(`[check-claims] unexpected error: ${err.message}`); return 2; });
