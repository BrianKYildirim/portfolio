// Tests of the D-06 wasm check: scripts/demos/wasm/<name>.manifest.json against the bytes it lists (artifacts and
// vendored parity fixtures), the reachability of its commit, and the <code data-wasm-pin> pins in the pages. Every
// problem is a finding (fail closed); reachability runs against a mocked fetch or an evidence root, never the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '../claims-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'check-claims.mjs');
const fn = (name) => { assert.equal(typeof lib[name], 'function', `claims-lib.mjs exports ${name}`); return lib[name]; };

const DOC = {
  repos: {
    'ratelimit-cpp': { owner: 'BrianKYildirim', default_branch: 'main', local: '../ratelimit-cpp' },
    'image-quality-gate': { owner: 'BrianKYildirim', default_branch: 'main', local: '../image-quality-gate' },
  },
  page_repos: { 'rate-limiter': 'ratelimit-cpp', 'image-quality-gate': 'image-quality-gate' },
};
const SHA = (c) => c.repeat(40);
const S = SHA('a');
const TOKEN = 'ghp_mocktoken_must_never_be_printed';
const MANIFEST = 'scripts/demos/wasm/x.manifest.json';
const PAGE = 'pages/projects/rate-limiter.html';
const PARITY = 'tools/test/fixtures/x-parity';

const entry = (text) => ({ bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
const ARTIFACTS = { 'x.mjs': 'export default 1;\n', 'x.wasm': '\0asm\x01\0\0\0' };
const FIXTURES = { 'golden/t.out': 'allow 1 1 0\n', 'traces/t.jsonl': '{"op":"allow"}\n' };

// A valid mini root: manifest x (two artifacts, two parity fixtures) for ratelimit-cpp at S, pinned by the page.
function manifestOf(over = {}) {
  return { schema: 'wasm-manifest/1', name: 'x', repo: 'ratelimit-cpp', sha: S,
    files: Object.fromEntries(Object.entries(ARTIFACTS).map(([k, v]) => [k, entry(v)])),
    parity: { dir: PARITY, files: Object.fromEntries(Object.entries(FIXTURES).map(([k, v]) => [k, entry(v)])) }, ...over };
}
function miniFiles({ manifest = manifestOf(), page = `<p>at <code data-wasm-pin="x">${S.slice(0, 7)}</code></p>\n` } = {}) {
  const files = { [MANIFEST]: typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 1)}\n` };
  for (const [k, v] of Object.entries(ARTIFACTS)) files[`scripts/demos/wasm/${k}`] = v;
  for (const [k, v] of Object.entries(FIXTURES)) files[`${PARITY}/${k}`] = v;
  if (page !== null) files[PAGE] = page;
  return files;
}

async function withRoot(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wasm-'));
  try {
    await writeFile(path.join(dir, 'claims.json'), JSON.stringify({ schema_version: 1, ...DOC, environments: {}, tables: [], claims: [] }));
    // The evidence root: S is reachable because its commit directory exists.
    await mkdir(path.join(dir, 'ev', 'ratelimit-cpp', S), { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The library call the CLI makes, on a root on disk, with an injected reachability.
async function check(dir, { isReachable, project } = {}) {
  let names = [];
  try { names = await readdir(path.join(dir, 'scripts', 'demos', 'wasm')); } catch { /* no wasm directory */ }
  const manifests = [];
  for (const f of names.filter((n) => n.endsWith('.manifest.json')).sort()) {
    const file = `scripts/demos/wasm/${f}`;
    manifests.push({ name: f.slice(0, -'.manifest.json'.length), file, text: await readFile(path.join(dir, file), 'utf8') });
  }
  const pins = [];
  try { pins.push(...fn('extractWasmPins')(await readFile(path.join(dir, PAGE), 'utf8'), PAGE)); } catch { /* no page */ }
  const reach = isReachable ?? fn('createSources')('evidence-root', { dir: path.join(dir, 'ev') }).isReachable;
  return fn('checkWasmManifests')({ manifests, pins, repos: DOC.repos, root: dir, isReachable: reach, project });
}
const codes = (fs) => fs.map((f) => f.code);
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, GITHUB_TOKEN: '' } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const cliArgs = (dir, ...more) => ['--root', dir, '--claims', path.join(dir, 'claims.json'), '--evidence-root', path.join(dir, 'ev'), ...more];

// ---------- Valid and empty ----------
test('a valid mini root (two artifacts, two parity fixtures, a page pin, a reachable commit) gives no findings', async () => {
  await withRoot(miniFiles(), async (dir) => assert.deepEqual(await check(dir), []));
});

test('a root with neither scripts/demos/wasm nor any data-wasm-pin gives no wasm findings', async () => {
  await withRoot({ 'pages/about.html': '<p>about <code>abc1234</code></p>' }, async (dir) => {
    assert.deepEqual(await check(dir), []);
    const r = await cli(cliArgs(dir, '--only', 'wasm'));
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /ok \(checks: wasm; .*, 0 wasm manifest\(s\)\)/);
  });
});

test('extractWasmPins reads <code data-wasm-pin> with its line, ignores comments and reports the tag', () => {
  const html = ['<p>one</p>', `<!-- <code data-wasm-pin="x">${SHA('b').slice(0, 7)}</code> -->`,
    `<p><code class="c" data-wasm-pin="x"> ${S.slice(0, 7)} </code> and <span data-wasm-pin="y">bbbbbbb</span></p>`].join('\n');
  assert.deepEqual(fn('extractWasmPins')(html, PAGE).map((p) => [p.name, p.sha, p.tag, p.line]),
    [['x', S.slice(0, 7), 'code', 3], ['y', 'bbbbbbb', 'span', 3]]);
});

// ---------- WASM_MANIFEST ----------
test('WASM_MANIFEST: wrong schema, name not the file stem, unknown repo, short sha', async () => {
  for (const over of [{ schema: 'wasm-manifest/2' }, { name: 'y' }, { repo: 'strivoai' }, { sha: S.slice(0, 7) }]) {
    await withRoot(miniFiles({ manifest: manifestOf(over) }), async (dir) => {
      const f = await check(dir);
      assert.ok(codes(f).includes('WASM_MANIFEST'), `${JSON.stringify(over)}: ${JSON.stringify(f)}`);
      assert.ok(f.every((x) => x.file === MANIFEST || x.file.startsWith('scripts/demos/wasm/') || x.file === PAGE), JSON.stringify(f));
    });
  }
});

test('WASM_MANIFEST: a file entry without sha256, a negative byte count, or a file name with "/" or ".."', async () => {
  const files = manifestOf().files;
  for (const bad of [{ 'x.mjs': { bytes: 1 } }, { 'x.mjs': { ...files['x.mjs'], bytes: -1 } },
    { 'sub/x.mjs': files['x.mjs'] }, { '..': files['x.mjs'] }, { '../x.mjs': files['x.mjs'] }]) {
    await withRoot(miniFiles({ manifest: manifestOf({ files: { ...files, ...bad } }) }), async (dir) => {
      assert.ok(codes(await check(dir)).includes('WASM_MANIFEST'), JSON.stringify(bad));
    });
  }
});

test('WASM_MANIFEST: a parity dir or path with "..", a leading "/" or a backslash (path traversal guard)', async () => {
  const pf = manifestOf().parity.files;
  for (const parity of [{ dir: '../outside', files: pf }, { dir: '/etc', files: pf }, { dir: 'tools\\test', files: pf },
    { dir: PARITY, files: { ...pf, '../../../secret': pf['golden/t.out'] } }, { dir: PARITY, files: { ...pf, '/abs': pf['golden/t.out'] } },
    { dir: PARITY, files: { ...pf, 'golden\\t.out': pf['golden/t.out'] } }]) {
    await withRoot(miniFiles({ manifest: manifestOf({ parity }) }), async (dir) => {
      const f = await check(dir);
      assert.ok(codes(f).includes('WASM_MANIFEST'), JSON.stringify(parity));
      for (const x of f) assert.ok(!x.message.includes(dir), `no absolute path in ${x.message}`);
    });
  }
});

test('WASM_MANIFEST: invalid JSON is a finding, and a manifest larger than MAX_INPUT_BYTES is INPUT_TOO_LARGE', async () => {
  await withRoot(miniFiles({ manifest: '{ not json' }), async (dir) => assert.ok(codes(await check(dir)).includes('WASM_MANIFEST')));
  const big = JSON.stringify({ ...manifestOf(), pad: 'y'.repeat(lib.MAX_INPUT_BYTES) });
  assert.deepEqual(codes(fn('parseWasmManifest')(big, MANIFEST, { repos: DOC.repos }).findings), ['INPUT_TOO_LARGE']);
});

// ---------- WASM_HASH ----------
test('WASM_HASH: a listed artifact missing, one byte changed, or a wrong bytes count', async () => {
  const missing = miniFiles();
  delete missing['scripts/demos/wasm/x.wasm'];
  await withRoot(missing, async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['WASM_HASH']);
    assert.match(f[0].message, /scripts\/demos\/wasm\/x\.wasm is listed but missing on disk/);
  });
  await withRoot({ ...miniFiles(), 'scripts/demos/wasm/x.mjs': 'export default 2;\n' }, async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['WASM_HASH']);
    assert.match(f[0].message, /x\.mjs: on disk \d+ bytes sha256 [0-9a-f]{64}, the manifest says \d+ bytes sha256 [0-9a-f]{64}/);
  });
  const m = manifestOf();
  m.files['x.mjs'] = { ...m.files['x.mjs'], bytes: m.files['x.mjs'].bytes + 1 };
  await withRoot(miniFiles({ manifest: m }), async (dir) => assert.deepEqual(codes(await check(dir)), ['WASM_HASH']));
});

test('WASM_HASH: a parity fixture missing or changed', async () => {
  const missing = miniFiles();
  delete missing[`${PARITY}/golden/t.out`];
  await withRoot(missing, async (dir) => assert.deepEqual(codes(await check(dir)), ['WASM_HASH']));
  await withRoot({ ...miniFiles(), [`${PARITY}/traces/t.jsonl`]: '{"op":"allow"} \n' }, async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['WASM_HASH']);
    assert.match(f[0].message, /tools\/test\/fixtures\/x-parity\/traces\/t\.jsonl/);
  });
});

// ---------- WASM_UNLISTED ----------
test('WASM_UNLISTED: an extra file in scripts/demos/wasm, in a subdirectory of it, or in the parity dir', async () => {
  await withRoot({ ...miniFiles(), 'scripts/demos/wasm/extra.wasm': 'x' }, async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['WASM_UNLISTED']);
    assert.match(f[0].message, /scripts\/demos\/wasm\/extra\.wasm/);
  });
  await withRoot({ ...miniFiles(), 'scripts/demos/wasm/old/x.wasm': 'x' }, async (dir) => assert.deepEqual(codes(await check(dir)), ['WASM_UNLISTED']));
  await withRoot({ ...miniFiles(), [`${PARITY}/golden/new.out`]: 'x' }, async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['WASM_UNLISTED']);
    assert.match(f[0].message, /x-parity\/golden\/new\.out/);
  });
});

// ---------- Pins ----------
test('WASM_PIN_MISMATCH: a page pin of another sha, or a pin that is not a <code> short sha', async () => {
  for (const page of [`<code data-wasm-pin="x">${SHA('b').slice(0, 7)}</code>`, '<code data-wasm-pin="x">abc</code>',
    `<span data-wasm-pin="x">${S.slice(0, 7)}</span>`]) {
    await withRoot(miniFiles({ page }), async (dir) => {
      const f = await check(dir);
      assert.deepEqual(codes(f), ['WASM_PIN_MISMATCH'], page);
      assert.equal(f[0].file, PAGE);
    });
  }
});

test('WASM_UNPINNED: a manifest no page pins; WASM_NO_MANIFEST: a pin naming a manifest that does not exist', async () => {
  await withRoot(miniFiles({ page: '<p>no pin</p>' }), async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['WASM_UNPINNED']);
    assert.equal(f[0].file, MANIFEST);
  });
  await withRoot(miniFiles({ page: `<code data-wasm-pin="x">${S.slice(0, 7)}</code> <code data-wasm-pin="nope">${S.slice(0, 7)}</code>` }), async (dir) => {
    const f = await check(dir);
    assert.deepEqual(codes(f), ['WASM_NO_MANIFEST']);
    assert.match(f[0].message, /scripts\/demos\/wasm\/nope\.manifest\.json/);
  });
});

// ---------- Reachability (mocked fetch, no network) ----------
function mockFetch(compare) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const u = new URL(url), respond = (status, body) => ({ ok: status >= 200 && status < 300, status, url,
      headers: new Headers(), body: null, text: async () => JSON.stringify(body) });
    if (!/\/compare\//.test(u.pathname)) return respond(200, { default_branch: 'main' });
    if (compare.throws) throw compare.throws;
    return respond(compare.status, { status: compare.compare });
  };
  return { fetchImpl, calls };
}
const apiReach = (mock) => fn('createSources')('api', { repos: DOC.repos, fetchImpl: mock.fetchImpl, token: TOKEN }).isReachable;

test('api mode: a commit the default branch does not contain gives PIN_UNREACHABLE at the manifest sha line', async () => {
  await withRoot(miniFiles(), async (dir) => {
    const f = await check(dir, { isReachable: apiReach(mockFetch({ status: 200, compare: 'diverged' })) });
    assert.deepEqual(codes(f), ['PIN_UNREACHABLE']);
    assert.equal(f[0].file, MANIFEST);
    assert.equal(f[0].line, 5);
    const ok = await check(dir, { isReachable: apiReach(mockFetch({ status: 200, compare: 'behind' })) });
    assert.deepEqual(ok, []);
  });
});

test('api mode: a network error or a timeout gives COULD_NOT_VERIFY, and the token never appears in the output', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  await withRoot(miniFiles(), async (dir) => {
    for (const throws of [new TypeError(`fetch failed for ${TOKEN}`), timeout]) {
      const mock = mockFetch({ throws });
      const f = await check(dir, { isReachable: apiReach(mock) });
      assert.deepEqual(codes(f), ['COULD_NOT_VERIFY']);
      const out = f.map(lib.formatFinding).join('\n');
      assert.ok(!out.includes(TOKEN) && !out.includes('Bearer'), out);
      assert.ok(mock.calls.every((c) => new URL(c.url).host === 'api.github.com'));
    }
  });
});

test('an isReachable that throws or returns nothing is COULD_NOT_VERIFY, never a pass', async () => {
  await withRoot(miniFiles(), async (dir) => {
    assert.deepEqual(codes(await check(dir, { isReachable: async () => { throw new Error('boom'); } })), ['COULD_NOT_VERIFY']);
    assert.deepEqual(codes(await check(dir, { isReachable: async () => undefined })), ['COULD_NOT_VERIFY']);
  });
});

// ---------- CLI ----------
test('CLI --only wasm: exit 0 with "1 wasm manifest(s)" when clean, exit 1 with findings when a byte changes', async () => {
  await withRoot(miniFiles(), async (dir) => {
    const r = await cli(cliArgs(dir, '--only', 'wasm'));
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] ok \(checks: wasm; 0 claim\(s\), 0 tagged value\(s\), 0 pin\(s\), 1 wasm manifest\(s\)\)$/m);
  });
  await withRoot({ ...miniFiles(), 'scripts/demos/wasm/x.wasm': 'changed' }, async (dir) => {
    const r = await cli(cliArgs(dir, '--only', 'wasm'));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] scripts\/demos\/wasm\/x\.manifest\.json:\d+ WASM_HASH /m);
  });
});

test('CLI --project scope: image-quality-gate skips the ratelimit-cpp manifest; ratelimit-cpp checks it', async () => {
  await withRoot({ ...miniFiles(), 'scripts/demos/wasm/x.wasm': 'changed', 'pages/projects/image-quality-gate.html': '<p>iqg</p>' }, async (dir) => {
    const iqg = await cli(cliArgs(dir, '--only', 'wasm', '--project', 'image-quality-gate'));
    assert.equal(iqg.code, 0, iqg.stdout);
    assert.match(iqg.stdout, /0 wasm manifest\(s\)\)/);
    const rl = await cli(cliArgs(dir, '--only', 'wasm', '--project', 'ratelimit-cpp'));
    assert.equal(rl.code, 1, rl.stdout);
    assert.match(rl.stdout, / WASM_HASH /);
  });
});

test('CLI: a manifest larger than MAX_INPUT_BYTES gives INPUT_TOO_LARGE (exit 1)', async () => {
  const big = `${JSON.stringify({ ...manifestOf(), pad: 'y'.repeat(lib.MAX_INPUT_BYTES) })}\n`;
  await withRoot(miniFiles({ manifest: big }), async (dir) => {
    const r = await cli(cliArgs(dir, '--only', 'wasm'));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] scripts\/demos\/wasm\/x\.manifest\.json:1 INPUT_TOO_LARGE /m);
  });
});
