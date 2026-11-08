// tools/check-claims.mjs: checks the numbers shown in the portfolio and the upstream READMEs against
// bench/claims.json and their evidence (CLAIM-01..06), checks that every pinned upstream commit is reachable from
// its default branch (CLAIM-06), and validates benchmark results directories (BENCH-01..03). Node built-ins only
// (D-16). Exit 0 = clean, 1 = findings, 2 = usage or I/O error.
// Usage: node tools/check-claims.mjs [--root <dir>] [--claims <file>] [--only <checks>] [--project <repo>]
//          [--local <dir> [--local-ref <ref>] | --evidence-root <dir>] [--readme-file <project>=<README.md> ...]
//        node tools/check-claims.mjs --fill-values [--claims <file>] [--local <dir> | --evidence-root <dir>]
//        node tools/check-claims.mjs --render-tables <project>=<README.md> [...] [--claims <file>]
//        node tools/check-claims.mjs --validate-results <env, session or results directory>
// Sources (D-19): by default GitHub (READMEs at each default-branch HEAD, evidence at evidence.sha, the compare
// endpoint for reachability; GITHUB_TOKEN is read from the environment and never printed). --local <dir> uses the
// sibling clones instead (working-tree READMEs, git show, git merge-base). --evidence-root is the test fixture seam.
// Check mode never writes a file. --render-tables writes READMEs and --fill-values writes the claims file.
import { parseArgs } from 'node:util';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_INPUT_BYTES, loadClaims, validateClaims, locateClaims, checkComparison, extractTaggedLeaves, checkTagged,
  scanHtml, scanJsLines, scanMarkdown, checkTables, checkMethodology, applyTables, validateResultsDir, sortFindings,
  formatFinding, extractPins, checkPins, createSources, checkEvidence, fillValues, spliceClaims } from './claims-lib.mjs';

// The default run (no --only) runs every check listed here.
const CHECKS = ['claims', 'html', 'js', 'readme', 'tables', 'methodology', 'evidence', 'pins'];
const README_CHECKS = ['readme', 'tables', 'methodology'];
// The upstream READMEs read from a source (GitHub or --local): the three projects Phase 2 benchmarks. Another
// repo's README is checked only when it is given with --readme-file.
const README_REPOS = Object.freeze(['ratelimit-cpp', 'image-quality-gate', 'key-value-storage']);
const USAGE = '[check-claims] usage: node tools/check-claims.mjs [--root <dir>] [--claims <file>] [--only <checks>] [--project <repo>] [--local <dir> [--local-ref <ref>] | --evidence-root <dir>] [--readme-file <project>=<path> ...] | --fill-values [--claims <file>] [--local <dir> | --evidence-root <dir>] | --render-tables <project>=<path> ... [--claims <file>] | --validate-results <dir>';

// ---------- Report ----------
// The only stdout writer in tools/.
function report(line) {
  process.stdout.write(`${line}\n`);
}

// ---------- Inputs ----------
const posix = (p) => p.split(path.sep).join('/');
// How a path given on the command line is shown in findings: relative to the working directory when inside it.
function shownPath(p) {
  const abs = path.resolve(p), rel = path.relative(process.cwd(), abs);
  return posix(rel === '' ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel);
}
// <project>=<path> pairs (--readme-file, --render-tables); the project must be a key of repos in the claims file.
function projectFiles(list, flag) {
  return (list ?? []).map((arg) => {
    const i = arg.indexOf('=');
    if (i < 1 || i === arg.length - 1) throw new UsageError(`${flag} takes <project>=<path> (got "${arg}")`);
    return { project: arg.slice(0, i), file: arg.slice(i + 1), label: shownPath(arg.slice(i + 1)) };
  });
}
class UsageError extends Error {}
const pageName = (rel) => path.basename(rel, '.html');

// index.html and pages/**/*.html; with a project scope, only the partials page_repos maps to that project.
async function htmlFiles(root, scope) {
  const files = [];
  try {
    await readFile(path.join(root, 'index.html'));
    files.push('index.html');
  } catch { /* fixture roots may have no index.html */ }
  try {
    const found = await readdir(path.join(root, 'pages'), { recursive: true });
    for (const f of found) if (f.endsWith('.html')) files.push(posix(path.join('pages', f)));
  } catch { /* fixture roots may have no pages/ */ }
  return files.filter((f) => !scope || (f.startsWith('pages/') && scope.pages.includes(pageName(f)))).sort();
}

// The demo modules whose user-visible string literals are scanned (scripts/demos/*.js, not recursive). With a
// project scope, only scripts/demos/<key>*.js for the data-demo keys in that project's partials.
async function jsFiles(root, scope) {
  let names;
  try {
    names = await readdir(path.join(root, 'scripts', 'demos'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];   // fixture roots may have no scripts/demos/
    throw err;
  }
  return names.filter((f) => f.endsWith('.js') && (!scope || scope.demoKeys.some((k) => f.startsWith(k)))).sort().map((f) => `scripts/demos/${f}`);
}

// --project <repo>: the partials page_repos maps to the repo, and the data-demo keys those partials name.
async function projectScope(root, doc, project) {
  const pageRepos = doc.page_repos !== null && typeof doc.page_repos === 'object' ? doc.page_repos : {};
  const pages = Object.keys(pageRepos).filter((p) => pageRepos[p] === project).sort(), demoKeys = [];
  for (const rel of (await htmlFiles(root)).filter((f) => f.startsWith('pages/') && pages.includes(pageName(f)))) {
    for (const m of (await readFile(path.join(root, rel), 'utf8')).matchAll(/\sdata-demo="([A-Za-z0-9_-]+)"/g)) demoKeys.push(m[1]);
  }
  return { pages, demoKeys: [...new Set(demoKeys)].sort() };
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

async function checkHtml(root, scope, claimsById, readEvidence) {
  const findings = [];
  let leafCount = 0;
  for (const rel of await htmlFiles(root, scope)) {
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

// The READMEs to check: each README_REPOS project from the source (not in evidence-root mode), with a
// --readme-file argument replacing that project's README; --project keeps one project.
function readmeTargets(files, repos, sources, opt) {
  const given = new Set(files.map((f) => f.project)), targets = [...files];
  if (sources.mode !== 'evidence-root') {
    for (const repo of README_REPOS) {
      if (!Object.hasOwn(repos, repo) || given.has(repo)) continue;
      const label = sources.mode === 'local' ? shownPath(path.join(opt.local, repo, 'README.md'))
        : `github.com/${repos[repo].owner}/${repo}/blob/${repos[repo].default_branch}/README.md`;
      targets.push({ project: repo, label, fromSource: true });
    }
  }
  return targets.filter((t) => opt.project === undefined || t.project === opt.project);
}

// A README (CLAIM-03, D-05). readme: inline markers, waivers, untagged unit-numbers and numeric table cells;
// tables: claims-table blocks against their render; methodology: the BENCH-04 block. Inline markers and table
// claim cells go through one checkTagged call, like HTML leaves. A README the source cannot give is a finding.
async function checkReadmes(targets, only, doc, claimsById, sources) {
  const findings = [];
  let leafCount = 0;
  for (const r of targets) {
    let text;
    if (r.fromSource) {
      try {
        text = await sources.readReadme(r.project);
      } catch (err) {
        const code = err?.code === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'COULD_NOT_VERIFY';
        findings.push({ file: r.label, line: 1, code, message: `cannot read the README (${err?.message})` });
        continue;
      }
    } else {
      text = await readFile(r.file, 'utf8');
    }
    if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
      findings.push({ file: r.label, line: 1, code: 'INPUT_TOO_LARGE', message: `larger than ${MAX_INPUT_BYTES} bytes` });
      continue;
    }
    const markers = [];
    if (only.includes('readme')) {
      const scan = scanMarkdown(text, r.label);
      findings.push(...scan.findings);
      markers.push(...scan.markers);
    }
    if (only.includes('tables')) {
      const t = checkTables(text, r.label, doc, { project: r.project });
      findings.push(...t.findings);
      markers.push(...t.markers);
    }
    if (only.includes('methodology')) findings.push(...checkMethodology(text, r.label));
    leafCount += markers.length;
    findings.push(...await checkTagged(claimsById, markers, sources.readEvidence));
  }
  return { findings, leafCount };
}

// CLAIM-06: every pinned upstream commit in the pages (permalinks and <code> short SHAs).
async function checkPagePins(root, scope, doc, isReachable) {
  const pins = [], findings = [];
  for (const rel of await htmlFiles(root, scope)) {
    const r = extractPins(await readFile(path.join(root, rel), 'utf8'), rel, doc);
    pins.push(...r.pins);
    findings.push(...r.findings);
  }
  findings.push(...await checkPins(pins, { isReachable }));
  return { findings, pinCount: pins.length };
}

async function checkJs(root, scope) {
  const findings = [];
  for (const rel of await jsFiles(root, scope)) findings.push(...scanJsLines(await readFile(path.join(root, rel), 'utf8'), rel));
  return findings;
}

// ---------- Writes ----------
// A temporary file in the same directory, then a rename, so an interrupted run leaves the original intact (T-02-04).
async function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(path.resolve(file)), `${path.basename(file)}.tmp-${process.pid}`);
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => { /* best effort: the temp file may never have been created */ });
    throw err;
  }
}

// --render-tables: rewrites every claims-table block of each README from bench/claims.json tables[]. A README
// with any finding is not written at all.
async function renderReadmes(targets, doc) {
  let failed = false;
  for (const t of targets) {
    const r = applyTables(await readFile(t.file, 'utf8'), t.label, doc, { project: t.project });
    if (r.findings.length) {
      for (const f of sortFindings(r.findings)) report(formatFinding(f));
      report(`[check-claims] ${t.label}: not rewritten (${r.findings.length} finding(s))`);
      failed = true;
    } else if (!r.rendered) {
      report(`[check-claims] ${t.label}: no claims-table blocks`);
    } else {
      if (r.changed) await writeAtomic(t.file, r.text);
      report(`[check-claims] ${t.label}: ${r.changed ? 'rewrote' : 'unchanged,'} ${r.rendered} claims-table block(s)`);
    }
  }
  return failed ? 1 : 0;
}

// --fill-values: copies value, n and spread from evidence into proposed claims (never approved or retired ones,
// D-02). Nothing is written when any proposed claim's evidence cannot be read. Only the filled entries' text
// changes; the claims file is then checked again with validateClaims.
async function fillClaims(claimsPath, text, doc, sources, claimsFile) {
  const r = await fillValues(doc, sources.readEvidence, { text, file: claimsFile });
  if (r.findings.length) {
    for (const f of sortFindings(r.findings)) report(formatFinding(f));
    report(`[check-claims] ${claimsFile}: not rewritten (${r.findings.length} finding(s))`);
    return 1;
  }
  const next = r.changed.length ? spliceClaims(text, r.doc, r.changed) : text;
  if (r.changed.length) await writeAtomic(claimsPath, next);
  report(`[check-claims] ${claimsFile}: filled ${r.changed.length} proposed claim(s)`);
  const after = validateClaims(r.doc, { text: next, file: claimsFile });
  for (const f of sortFindings(after)) report(formatFinding(f));
  if (after.length) report(`[check-claims] ${after.length} finding(s)`);
  return after.length ? 1 : 0;
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
  const { findings, checked } = await validateResultsDir(dir, { readFile, readdir, label: shownPath(dir) });
  for (const f of sortFindings(findings)) report(formatFinding(f));
  for (const c of checked) report(`[check-claims] checked ${c}`);
  report(findings.length
    ? `[check-claims] ${findings.length} finding(s)`
    : `[check-claims] ok (validate-results: ${checked.length} environment director${checked.length === 1 ? 'y' : 'ies'})`);
  return findings.length ? 1 : 0;
}

// ---------- Main ----------
// Flag combinations that make no sense are usage errors (exit 2), never silently ignored.
function usageProblem(opt, only) {
  const has = (k) => opt[k] !== undefined && opt[k] !== false;
  if (has('validate-results')) {
    const extra = ['only', 'claims', 'readme-file', 'render-tables', 'fill-values', 'local', 'local-ref', 'evidence-root', 'project'].filter(has);
    return extra.length ? `--validate-results runs on its own; drop ${extra.map((k) => `--${k}`).join(', ')}` : null;
  }
  const unknown = only.filter((c) => !CHECKS.includes(c));
  if (unknown.length || !only.length) return `unknown check: ${unknown.join(', ') || '(none given)'}; known: ${CHECKS.join(', ')}`;
  if (has('local') && has('evidence-root')) return 'pick one source: --local <dir> or --evidence-root <dir>';
  if (has('local-ref') && !has('local')) return '--local-ref needs --local <dir>';
  if (has('render-tables') && (has('only') || has('readme-file') || has('fill-values'))) {
    return '--render-tables runs on its own; drop --only, --readme-file and --fill-values, then run the check';
  }
  if (has('fill-values') && (has('only') || has('readme-file') || has('project'))) return '--fill-values runs on its own; drop --only, --readme-file and --project';
  return null;
}

async function main() {
  let opt;
  try {
    ({ values: opt } = parseArgs({ options: {
      root: { type: 'string' }, claims: { type: 'string' }, only: { type: 'string' }, 'evidence-root': { type: 'string' },
      'validate-results': { type: 'string' }, 'readme-file': { type: 'string', multiple: true },
      'render-tables': { type: 'string', multiple: true }, local: { type: 'string' }, 'local-ref': { type: 'string' },
      project: { type: 'string' }, 'fill-values': { type: 'boolean' },
    } }));
  } catch (err) {
    report(`[check-claims] ${err.message}`);
    report(USAGE);
    return 2;
  }
  const only = opt.only === undefined ? CHECKS : opt.only.split(',').map((s) => s.trim()).filter(Boolean);
  const problem = usageProblem(opt, only);
  if (problem) {
    report(`[check-claims] ${problem}`);
    return 2;
  }
  if (opt['validate-results'] !== undefined) return validateResults(opt['validate-results']);
  const rendering = opt['render-tables'] !== undefined;
  const root = path.resolve(opt.root ?? process.cwd());
  const claimsPath = opt.claims ?? path.join(root, 'bench', 'claims.json');
  const fileFlag = rendering ? '--render-tables' : '--readme-file';
  let files;
  try {
    files = projectFiles(opt[fileFlag.slice(2)], fileFlag);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    report(`[check-claims] ${err.message}`);
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
  const repos = doc.repos !== null && typeof doc.repos === 'object' && !Array.isArray(doc.repos) ? doc.repos : {};
  const stray = files.find((r) => !Object.hasOwn(repos, r.project));
  if (stray) {
    report(`[check-claims] ${fileFlag} project "${stray.project}" is not a key of repos in ${claimsFile}`);
    return 2;
  }
  if (opt.project !== undefined && !Object.hasOwn(repos, opt.project)) {
    report(`[check-claims] --project "${opt.project}" is not a key of repos in ${claimsFile}`);
    return 2;
  }
  if (rendering) {
    try {
      return await renderReadmes(files, doc);
    } catch (err) {
      report(`[check-claims] I/O error: ${err.message}`);
      return 2;
    }
  }

  let sources;
  try {
    sources = opt.local !== undefined ? createSources('local', { dir: path.resolve(opt.local), ref: opt['local-ref'] ?? 'HEAD' })
      : opt['evidence-root'] !== undefined ? createSources('evidence-root', { dir: opt['evidence-root'] })
        // The token is read from the environment only and is never printed (T-02-06).
        : createSources('api', { repos, token: process.env.GITHUB_TOKEN || undefined });
  } catch (err) {
    report(`[check-claims] ${err.message}`);
    return 2;
  }
  if (opt['fill-values']) {
    try {
      return await fillClaims(claimsPath, text, doc, sources, claimsFile);
    } catch (err) {
      report(`[check-claims] I/O error: ${err.message}`);
      return 2;
    }
  }

  const readmes = only.some((c) => README_CHECKS.includes(c)) ? readmeTargets(files, repos, sources, opt) : [];
  // Naming a README check with no README to run it on would be a vacuous pass.
  if (opt.only !== undefined && only.some((c) => README_CHECKS.includes(c)) && !readmes.length) {
    report(`[check-claims] --only ${only.filter((c) => README_CHECKS.includes(c)).join(',')} needs --readme-file <project>=<path>`
      + (sources.mode === 'evidence-root' ? ' (--evidence-root has no README source)' : ` (no README for --project ${opt.project})`));
    return 2;
  }
  const claims = Array.isArray(doc.claims) ? doc.claims : [];
  const claimsById = new Map();
  for (const c of claims) if (c && typeof c.id === 'string' && !claimsById.has(c.id)) claimsById.set(c.id, c);
  const findings = [];
  let leafCount = 0, pinCount = 0;
  if (only.includes('claims')) findings.push(...checkClaimsFile(doc, text, claimsFile, claimsById));
  try {
    const scope = opt.project === undefined ? null : await projectScope(root, doc, opt.project);
    if (only.includes('html')) {
      const r = await checkHtml(root, scope, claimsById, sources.readEvidence);
      findings.push(...r.findings);
      leafCount += r.leafCount;
    }
    if (only.includes('js')) findings.push(...await checkJs(root, scope));
    if (readmes.length) {
      const r = await checkReadmes(readmes, only, doc, claimsById, sources);
      findings.push(...r.findings);
      leafCount += r.leafCount;
    }
    if (only.includes('evidence')) findings.push(...await checkEvidence(doc, sources, { text, file: claimsFile, project: opt.project }));
    if (only.includes('pins')) {
      const r = await checkPagePins(root, scope, doc, sources.isReachable);
      findings.push(...r.findings);
      pinCount = r.pinCount;
    }
  } catch (err) {
    report(`[check-claims] I/O error: ${err.message}`);
    return 2;
  }

  for (const f of sortFindings(findings)) report(formatFinding(f));
  report(findings.length
    ? `[check-claims] ${findings.length} finding(s)`
    : `[check-claims] ok (checks: ${only.join(', ')}; ${claims.length} claim(s), ${leafCount} tagged value(s), ${pinCount} pin(s))`);
  return findings.length ? 1 : 0;
}

// An unexpected failure is an I/O-class error (exit 2), never a silent pass or a stack trace on stdout.
process.exitCode = await main().catch((err) => { report(`[check-claims] unexpected error: ${err.message}`); return 2; });
