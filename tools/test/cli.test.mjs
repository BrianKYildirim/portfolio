// End-to-end tests of tools/check-claims.mjs on the basic fixture: claims file, evidence file and a tagged
// page go through the real CLI, report and exit code (0 clean, 1 findings, 2 usage or I/O error).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'check-claims.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'basic');
const PAGE = path.join('pages', 'projects', 'rate-limiter.html');
const SUMMARY = path.join('evidence', 'ratelimit-cpp', '0000000000000000000000000000000000000001', 'bench', 'results',
  '2026-01-01-0000000', 'ubuntu-wsl2', 'summary.json');

function run(root, extra = []) {
  const args = [CLI, '--root', root, '--claims', path.join(root, 'claims.json'), '--evidence-root', path.join(root, 'evidence'), ...extra];
  return new Promise((resolve) => {
    execFile(process.execPath, args, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

// A throwaway copy of the fixture with one file rewritten by `edit(text) -> text`.
async function variant(rel, edit) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'check-claims-'));
  await cp(FIXTURE, dir, { recursive: true });
  const file = path.join(dir, rel);
  await writeFile(file, edit(await readFile(file, 'utf8')));
  return dir;
}

test('the basic fixture passes the html check and exits 0', async () => {
  const r = await run(FIXTURE, ['--only', 'html']);
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /CLAIM_|EVIDENCE_/);
  assert.match(r.stdout, /\[check-claims\] ok .*3 tagged value\(s\)/);
});

test('the basic fixture passes every default check and exits 0', async () => {
  const r = await run(FIXTURE);
  assert.equal(r.code, 0, r.stdout);
});

test('a leaf whose text differs from the claim fails CLAIM_MISMATCH and exits 1', async () => {
  const dir = await variant(PAGE, (t) => t.replace('>153.0M<', '>160.0M<'));
  try {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^\[check-claims\] pages\/projects\/rate-limiter\.html:5 CLAIM_MISMATCH /m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tagged claim that is not approved fails CLAIM_NOT_APPROVED and exits 1', async () => {
  const dir = await variant('claims.json', (t) => t.replace('"status": "approved"', '"status": "proposed"')
    .replace('"approved_by": "fixture-owner"', '"approved_by": null').replace('"approved_on": "2026-01-02"', '"approved_on": null'));
  try {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /CLAIM_NOT_APPROVED rl\.fixture\.hot_denied\.t8 has status proposed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing claims file exits 2 with a one-line reason', async () => {
  const missing = path.join(FIXTURE, 'no-such-claims.json');
  const r = await new Promise((resolve) => execFile(process.execPath, [CLI, '--root', FIXTURE, '--claims', missing],
    (err, stdout) => resolve({ code: err ? err.code : 0, stdout })));
  assert.equal(r.code, 2);
  assert.equal(r.stdout, `[check-claims] cannot read claims file: ${missing}\n`);
});

test('an unparseable claims file exits 2', async () => {
  const dir = await variant('claims.json', (t) => t.slice(0, 40));
  try {
    const r = await run(dir);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /^\[check-claims\] cannot read claims file: /);
    assert.match(r.stdout, /SCHEMA_PARSE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('evidence that disagrees with the claim value fails EVIDENCE_VALUE', async () => {
  const dir = await variant(SUMMARY, (t) => t.replace('"median": 153012345.6', '"median": 153012345.7'));
  try {
    const r = await run(dir, ['--only', 'html']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /EVIDENCE_VALUE rl\.fixture\.hot_denied\.t8: value 153012345\.6 != evidence median 153012345\.7/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown check name is a usage error (exit 2)', async () => {
  const r = await run(FIXTURE, ['--only', 'nope']);
  assert.equal(r.code, 2);
});

test('two runs over the same failing inputs print byte-identical reports', async () => {
  const dir = await variant(PAGE, (t) => t.replace('>153.0M<', '>160.0M<').replace('>10 runs<', '>9 runs<'));
  try {
    const a = await run(dir, ['--only', 'html']), b = await run(dir, ['--only', 'html']);
    assert.equal(a.code, 1);
    assert.equal(a.stdout, b.stdout);
    const lines = a.stdout.trim().split('\n').slice(0, -1).map((l) => Number(/:(\d+) /.exec(l)[1]));
    assert.deepEqual(lines, [...lines].sort((x, y) => x - y));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
