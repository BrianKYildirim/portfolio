// bench-meta/1 and raw-file integrity: tools/check-claims.mjs --validate-results end to end on the reference
// results session (tools/test/fixtures/results/), and validateMeta / validateResultsDir on edited copies of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMeta, validateResultsDir } from '../claims-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'check-claims.mjs');
const SESSION = path.join(HERE, 'fixtures', 'results', '2026-01-01-0000000');
const WIN = path.join(SESSION, 'windows-native');
const WSL = path.join(SESSION, 'ubuntu-wsl2');

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

// A throwaway copy of one env directory, inside a session directory named `session`, with `edit(dir)` applied.
async function envCopy(env, edit = async () => {}, session = '2026-01-01-0000000') {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'check-results-'));
  const dir = path.join(tmp, session, env);
  await cp(path.join(SESSION, env), dir, { recursive: true });
  await edit(dir);
  return { tmp, dir };
}
const editText = (rel, fn) => async (dir) => { const f = path.join(dir, rel); await writeFile(f, fn(await readFile(f, 'utf8'))); };

// ---------- Tracer ----------
test('--validate-results on the windows-native fixture exits 0', async () => {
  const r = await run(['--validate-results', WIN]);
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /RESULTS_/);
  assert.match(r.stdout, /\[check-claims\] ok /);
});

test('one changed byte in raw/run-01.txt fails RESULTS_HASH and exits 1', async () => {
  const { tmp, dir } = await envCopy('windows-native', editText(path.join('raw', 'run-01.txt'), (t) => t.replace('ops 1000000', 'ops 1000001')));
  try {
    const r = await run(['--validate-results', dir]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /RESULTS_HASH raw\/run-01\.txt: on disk/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a summary median edited without its values fails RESULTS_SUMMARY and exits 1', async () => {
  const { tmp, dir } = await envCopy('windows-native', editText('summary.json', (t) => t.replace('"median": 2.5', '"median": 2.6')));
  try {
    const r = await run(['--validate-results', dir]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /RESULTS_SUMMARY \/fixture_bench\/throughput: median 2\.6 != 2\.5 recomputed/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a results path that does not exist exits 2', async () => {
  const r = await run(['--validate-results', path.join(SESSION, 'no-such-env')]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /^\[check-claims\] no such results directory: /);
});

// ---------- bench-meta/1 rules ----------
const loadMeta = async (env) => JSON.parse(await readFile(path.join(SESSION, env, 'meta.json'), 'utf8'));
const codes = (findings) => findings.map((f) => f.code);
const metaWith = async (env, edit) => { const m = await loadMeta(env); edit(m); return validateMeta(m, env); };
const validateCopy = (dir) => validateResultsDir(dir, { readFile, readdir });

test('both fixture env directories validate, and the session directory recurses into both', async () => {
  assert.deepEqual(validateMeta(await loadMeta('windows-native'), 'windows-native'), []);
  assert.deepEqual(validateMeta(await loadMeta('ubuntu-wsl2'), 'ubuntu-wsl2'), []);
  const one = await run(['--validate-results', WSL]);
  assert.equal(one.code, 0, one.stdout);
  const r = await run(['--validate-results', SESSION]);
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /RESULTS_/);
  assert.match(r.stdout, /checked .*2026-01-01-0000000\/ubuntu-wsl2\n/);
  assert.match(r.stdout, /checked .*2026-01-01-0000000\/windows-native\n/);
  assert.match(r.stdout, /ok \(validate-results: 2 environment directories\)/);
});

test('a results directory above the session also recurses to every env directory', async () => {
  const r = await run(['--validate-results', path.dirname(SESSION)]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /ok \(validate-results: 2 environment directories\)/);
});

test('cpu_model "Intel64 Family 6 Model 140 Stepping 1, GenuineIntel" fails RESULTS_META_FIELD', async () => {
  const f = await metaWith('windows-native', (m) => { m.hardware.cpu_model = 'Intel64 Family 6 Model 140 Stepping 1, GenuineIntel'; });
  assert.ok(f.some((x) => x.code === 'RESULTS_META_FIELD' && x.message.includes('hardware.cpu_model')), JSON.stringify(f));
});

test('cpu_model null fails RESULTS_META_FIELD in both environments', async () => {
  for (const env of ['windows-native', 'ubuntu-wsl2']) {
    assert.ok(codes(await metaWith(env, (m) => { m.hardware.cpu_model = null; })).includes('RESULTS_META_FIELD'), env);
  }
});

test('windows-native with loadavg null passes', async () => {
  assert.deepEqual(await metaWith('windows-native', (m) => { m.load.loadavg_1m_start = null; m.load.loadavg_1m_end = null; }), []);
});

test('ubuntu-wsl2 with loadavg null fails RESULTS_META_FIELD', async () => {
  const f = await metaWith('ubuntu-wsl2', (m) => { m.load.loadavg_1m_start = null; });
  assert.ok(f.some((x) => x.code === 'RESULTS_META_FIELD' && x.message.includes('loadavg_1m_start')), JSON.stringify(f));
});

test('ubuntu-wsl2 with cpu_busy_pct null passes', async () => {
  assert.deepEqual(await metaWith('ubuntu-wsl2', (m) => { m.load.cpu_busy_pct_start = null; m.load.cpu_busy_pct_end = null; }), []);
});

test('windows-native with cpu_busy_pct null fails RESULTS_META_FIELD', async () => {
  assert.ok(codes(await metaWith('windows-native', (m) => { m.load.cpu_busy_pct_end = null; })).includes('RESULTS_META_FIELD'));
});

test('ubuntu-wsl2 with os.wsl null fails RESULTS_META_FIELD', async () => {
  const f = await metaWith('ubuntu-wsl2', (m) => { m.os.wsl = null; });
  assert.ok(f.some((x) => x.code === 'RESULTS_META_FIELD' && x.message.includes('os.wsl')), JSON.stringify(f));
});

test('ubuntu-wsl2 needs os.kernel and an os.wsl object with version and wslconfig', async () => {
  assert.ok(codes(await metaWith('ubuntu-wsl2', (m) => { m.os.kernel = null; })).includes('RESULTS_META_FIELD'));
  assert.ok(codes(await metaWith('ubuntu-wsl2', (m) => { m.os.wsl = {}; })).includes('RESULTS_META_FIELD'));
  assert.ok(codes(await metaWith('ubuntu-wsl2', (m) => { delete m.os.wsl.wslconfig; })).includes('RESULTS_META_FIELD'));
  assert.deepEqual(await metaWith('ubuntu-wsl2', (m) => { m.os.wsl.wslconfig = { memory: '8GB' }; }), []);
});

test('windows-native with an os.wsl object fails RESULTS_META_FIELD', async () => {
  assert.ok(codes(await metaWith('windows-native', (m) => { m.os.wsl = { version: '2.6.1', wslconfig: null }; })).includes('RESULTS_META_FIELD'));
});

test('environment_id ubuntu-wsl2 inside a windows-native directory fails RESULTS_ENV_MISMATCH', async () => {
  const m = await loadMeta('ubuntu-wsl2');
  assert.ok(codes(validateMeta(m, 'windows-native')).includes('RESULTS_ENV_MISMATCH'));
  const { tmp, dir } = await envCopy('windows-native', editText('meta.json', (t) => t.replace('"environment_id": "windows-native"', '"environment_id": "ubuntu-wsl2"')));
  try {
    assert.ok(codes((await validateCopy(dir)).findings).includes('RESULTS_ENV_MISMATCH'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a command entry with an absolute home path fails RESULTS_META_FIELD', async () => {
  for (const p of ['C:\\Users\\yildi\\bench\\rl_bench.exe', '/home/brian/bench/rl_bench', '--out=/home/brian/results', 'C:/Users/yildi/x']) {
    const f = await metaWith('windows-native', (m) => { m.command.push(p); });
    assert.ok(f.some((x) => x.code === 'RESULTS_META_FIELD' && x.message.includes('command')), p);
  }
});

test('a required meta field that is null or empty fails RESULTS_META_FIELD', async () => {
  const edits = [(m) => { m.os.name = null; }, (m) => { m.project = ''; }, (m) => { m.command = []; }, (m) => { m.workload = {}; },
    (m) => { delete m.timer; }, (m) => { m.source.sha = null; }, (m) => { m.power.scheme = ''; }, (m) => { delete m.tag; }];
  for (const e of edits) assert.ok(codes(await metaWith('windows-native', e)).includes('RESULTS_META_FIELD'), e.toString());
});

test('power.ac_line null passes only with a power.note', async () => {
  assert.deepEqual(await metaWith('windows-native', (m) => { m.power.ac_line = null; m.power.note = 'not observable'; }), []);
  assert.ok(codes(await metaWith('windows-native', (m) => { m.power.ac_line = null; })).includes('RESULTS_META_FIELD'));
});

// ---------- Raw files ----------
test('an empty raw_files array fails RESULTS_EMPTY', async () => {
  assert.ok(codes(await metaWith('windows-native', (m) => { m.raw_files = []; })).includes('RESULTS_EMPTY'));
});

test('an empty raw/ directory fails RESULTS_EMPTY', async () => {
  const { tmp, dir } = await envCopy('windows-native', async (d) => { await rm(path.join(d, 'raw'), { recursive: true }); await mkdir(path.join(d, 'raw')); });
  try {
    assert.ok(codes((await validateCopy(dir)).findings).includes('RESULTS_EMPTY'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a listed raw file missing on disk fails RESULTS_HASH', async () => {
  const { tmp, dir } = await envCopy('windows-native', editText('meta.json', (t) => t.replace('"path": "raw/run-01.txt"', '"path": "raw/run-00.txt"')));
  try {
    const { findings } = await validateCopy(dir);
    assert.ok(findings.some((f) => f.code === 'RESULTS_HASH' && f.message.includes('raw/run-00.txt is listed in raw_files but missing on disk')), JSON.stringify(findings));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a one-byte change to a raw file fails RESULTS_HASH', async () => {
  const { tmp, dir } = await envCopy('ubuntu-wsl2', editText(path.join('raw', 'run-01.txt'), (t) => t.replace('p99 120', 'p99 121')));
  try {
    assert.ok(codes((await validateCopy(dir)).findings).includes('RESULTS_HASH'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a raw file not listed in raw_files fails RESULTS_HASH', async () => {
  const { tmp, dir } = await envCopy('windows-native', (d) => writeFile(path.join(d, 'raw', 'extra.txt'), 'x\n'));
  try {
    const { findings } = await validateCopy(dir);
    assert.ok(findings.some((f) => f.code === 'RESULTS_HASH' && f.message.includes('raw/extra.txt')), JSON.stringify(findings));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('raw_files out of path order fails RESULTS_UNSORTED', async () => {
  const entry = (p) => ({ path: p, bytes: 1, sha256: '0'.repeat(64) });
  assert.ok(codes(await metaWith('windows-native', (m) => { m.raw_files = [entry('raw/run-02.txt'), entry('raw/run-01.txt')]; })).includes('RESULTS_UNSORTED'));
  // Byte order: upper case sorts before lower case, so this order is correct.
  assert.ok(!codes(await metaWith('windows-native', (m) => { m.raw_files = [entry('raw/B.txt'), entry('raw/a.txt')]; })).includes('RESULTS_UNSORTED'));
});

// ---------- Directory name ----------
async function dirNameFindings(session, edit = async () => {}) {
  const { tmp, dir } = await envCopy('windows-native', edit, session);
  try {
    return (await validateCopy(dir)).findings;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test('the session directory name must match session_date, source.sha and tag (RESULTS_DIR_NAME)', async () => {
  assert.deepEqual(await dirNameFindings('2026-01-01-0000000'), []);
  for (const bad of ['2026-01-02-0000000', '2026-01-01-0000001', '2026-01-01-0000000-rerun', '20260101-0000000', 'results']) {
    assert.ok(codes(await dirNameFindings(bad)).includes('RESULTS_DIR_NAME'), bad);
  }
});

test('a tagged session directory passes when meta tag matches it', async () => {
  const tagged = editText('meta.json', (t) => t.replace('"tag": null', '"tag": "rerun"'));
  assert.deepEqual(await dirNameFindings('2026-01-01-0000000-rerun', tagged), []);
  assert.ok(codes(await dirNameFindings('2026-01-01-0000000', tagged)).includes('RESULTS_DIR_NAME'));
});

test('every failing env directory in a session is reported (the scan does not stop at the first)', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'check-results-'));
  try {
    const session = path.join(tmp, '2026-01-01-0000000');
    await cp(SESSION, session, { recursive: true });
    for (const env of ['windows-native', 'ubuntu-wsl2']) {
      const f = path.join(session, env, 'raw', 'run-01.txt');
      await writeFile(f, `${await readFile(f, 'utf8')}tampered\n`);
    }
    const r = await run(['--validate-results', session]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /ubuntu-wsl2\/meta\.json:1 RESULTS_HASH/);
    assert.match(r.stdout, /windows-native\/meta\.json:1 RESULTS_HASH/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('an oversized or unparseable meta.json is a finding, never a pass', async () => {
  const big = await dirNameFindings('2026-01-01-0000000', (d) => writeFile(path.join(d, 'meta.json'), ' '.repeat(2 * 1024 * 1024 + 1)));
  assert.ok(codes(big).includes('INPUT_TOO_LARGE'));
  const broken = await dirNameFindings('2026-01-01-0000000', editText('meta.json', (t) => t.slice(0, 30)));
  assert.ok(codes(broken).includes('RESULTS_META_FIELD'));
});
