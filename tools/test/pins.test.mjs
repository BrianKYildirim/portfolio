// Tests of the CLAIM-06 pin check (D-18): pin extraction from pages, the GitHub compare and default-branch
// helpers against a mocked fetch (no network), and checkPins' dedupe, ordering and fail-closed rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const TOKEN = 'ghp_mocktoken_must_never_be_printed';

// A mocked fetch. routes: { '<sha>': { status, compare } | { throws } | { delay } ... }. Records every call.
function mockFetch({ compare = {}, branch = 'main', delays = {}, redirect } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const u = new URL(url);
    const respond = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, url: redirect ?? url,
      headers: new Headers(headers), body: null, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    const m = /\/compare\/([^.]+)\.\.\.([0-9a-f]+)$/.exec(u.pathname);
    if (!m) return respond(200, { default_branch: branch });
    const spec = compare[m[2]] ?? { status: 200, compare: 'identical' };
    if (delays[m[2]]) await new Promise((r) => setTimeout(r, delays[m[2]]));
    if (spec.throws) throw spec.throws;
    return respond(spec.status, spec.body ?? { status: spec.compare }, spec.headers);
  };
  return { fetchImpl, calls };
}
const pin = (sha, line, file = 'pages/projects/rate-limiter.html', repo = 'ratelimit-cpp') => ({ repo, sha, file, line, kind: 'short' });
async function run(pins, mock, token) {
  const { isReachable } = fn('createSources')('api', { repos: DOC.repos, fetchImpl: mock.fetchImpl, token });
  return fn('checkPins')(pins, { isReachable });
}
const codes = (fs) => fs.map((f) => [f.code, f.line]);

// ---------- Tracer: extraction ----------
test('extractPins finds permalinks and <code> short SHAs with their repo, line and kind', () => {
  const html = [
    '<p>port at commit <code>62e0c26</code></p>',
    `<a href="https://github.com/BrianKYildirim/ratelimit-cpp/blob/${SHA('a')}/src/x.cpp#L1-L2">x</a>`,
    `<!-- <a href="https://github.com/BrianKYildirim/ratelimit-cpp/blob/${SHA('b')}/README.md">old</a> -->`,
    `<a href="https://github.com/BrianKYildirim/image-quality-gate/tree/${SHA('c')}">tree</a> <code>not-a-sha</code>`,
  ].join('\n');
  const r = fn('extractPins')(html, 'pages/projects/rate-limiter.html', DOC);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.pins.map((p) => [p.repo, p.sha, p.line, p.kind]), [
    ['ratelimit-cpp', SHA('a'), 2, 'permalink'],
    ['image-quality-gate', SHA('c'), 4, 'permalink'],
    ['ratelimit-cpp', '62e0c26', 1, 'short'],
  ]);
});

test('[empty] a page with no pins gives no pins and passes the pin check without a request', async () => {
  const r = fn('extractPins')('<p>No commits here, just 1234 and <code>abc</code>.</p>', 'pages/about.html', DOC);
  assert.deepEqual(r, { pins: [], findings: [] });
  const mock = mockFetch();
  assert.deepEqual(await run(r.pins, mock), []);
  assert.equal(mock.calls.length, 0);
});

test('[empty] a short SHA on an unmapped page, or a permalink to an unknown repo or owner, fails PIN_UNKNOWN_REPO', () => {
  const short = fn('extractPins')('<code>62e0c26</code>', 'pages/about.html', DOC);
  assert.deepEqual(codes(short.findings), [['PIN_UNKNOWN_REPO', 1]]);
  assert.match(short.findings[0].message, /page "about"/);
  const html = `<a href="https://github.com/BrianKYildirim/strivoai/blob/${SHA('d')}/x">a</a>\n`
    + `<a href="https://github.com/someone-else/ratelimit-cpp/blob/${SHA('e')}/x">b</a>`;
  const links = fn('extractPins')(html, 'pages/projects/rate-limiter.html', DOC);
  assert.deepEqual(codes(links.findings), [['PIN_UNKNOWN_REPO', 1], ['PIN_UNKNOWN_REPO', 2]]);
  assert.deepEqual(links.pins, []);
});

// ---------- Compare statuses ----------
test('[adjacency] compare status identical and behind pass', async () => {
  const mock = mockFetch({ compare: { [SHA('1')]: { status: 200, compare: 'identical' }, [SHA('2')]: { status: 200, compare: 'behind' } } });
  assert.deepEqual(await run([pin(SHA('1'), 1), pin(SHA('2'), 2)], mock), []);
});

test('[adjacency] ahead and diverged fail PIN_UNREACHABLE naming the compare status', async () => {
  const mock = mockFetch({ compare: { [SHA('3')]: { status: 200, compare: 'ahead' }, [SHA('4')]: { status: 200, compare: 'diverged' } } });
  const f = await run([pin(SHA('3'), 1), pin(SHA('4'), 2)], mock);
  assert.deepEqual(codes(f), [['PIN_UNREACHABLE', 1], ['PIN_UNREACHABLE', 2]]);
  assert.match(f[0].message, /not reachable from main \(compare status ahead\)/);
  assert.match(f[1].message, /compare status diverged/);
});

test('[adjacency] a 404 (unknown commit) or 422 (ambiguous short SHA) fails PIN_UNREACHABLE naming the HTTP status', async () => {
  const mock = mockFetch({ compare: { abc1234: { status: 404, body: { message: 'Not Found' } }, def5678: { status: 422, body: { message: 'No common ancestor' } } } });
  const f = await run([pin('abc1234', 1), pin('def5678', 2)], mock);
  assert.deepEqual(codes(f), [['PIN_UNREACHABLE', 1], ['PIN_UNREACHABLE', 2]]);
  assert.match(f[0].message, /\(HTTP 404\)/);
  assert.match(f[1].message, /\(HTTP 422\)/);
});

// ---------- Fail closed ----------
test('[concurrency] a thrown fetch, a timeout, a 403 rate limit and a 500 give COULD_NOT_VERIFY, never a pass', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const mock = mockFetch({ compare: {
    [SHA('5')]: { throws: new TypeError(`fetch failed for ${TOKEN}`) },
    [SHA('6')]: { throws: timeout },
    [SHA('7')]: { status: 403, body: { message: 'API rate limit exceeded for 1.2.3.4.' }, headers: { 'x-ratelimit-remaining': '0' } },
    [SHA('8')]: { status: 500, body: 'oops' },
  } });
  const f = await run([pin(SHA('5'), 1), pin(SHA('6'), 2), pin(SHA('7'), 3), pin(SHA('8'), 4)], mock, TOKEN);
  assert.deepEqual(codes(f), [['COULD_NOT_VERIFY', 1], ['COULD_NOT_VERIFY', 2], ['COULD_NOT_VERIFY', 3], ['COULD_NOT_VERIFY', 4]]);
  assert.match(f[0].message, /network error/);
  assert.match(f[1].message, /no response within 15 s/);
  assert.match(f[2].message, /HTTP 403 \(rate limited; set GITHUB_TOKEN\)/);
  assert.match(f[3].message, /HTTP 500/);
  for (const x of f) assert.ok(!x.message.includes(TOKEN) && !x.message.includes('Bearer'), x.message);
});

test('the token goes only into the Authorization header of api.github.com requests, with the required headers', async () => {
  const withToken = mockFetch(), without = mockFetch();
  await run([pin(SHA('1'), 1)], withToken, TOKEN);
  await run([pin(SHA('1'), 1)], without);
  for (const c of withToken.calls) {
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers.Accept, 'application/vnd.github+json');
    assert.equal(c.headers['User-Agent'], 'portfolio-claims-check');
    assert.equal(c.headers['X-GitHub-Api-Version'], '2022-11-28');
  }
  for (const c of without.calls) assert.equal(c.headers.Authorization, undefined);
  assert.deepEqual(withToken.calls.map((c) => new URL(c.url).pathname), [
    '/repos/BrianKYildirim/ratelimit-cpp', `/repos/BrianKYildirim/ratelimit-cpp/compare/main...${SHA('1')}`]);
});

test('a response redirected to another host, an oversized body or a default branch that differs from repos gives COULD_NOT_VERIFY', async () => {
  const away = await run([pin(SHA('1'), 1)], mockFetch({ redirect: 'https://example.com/repos/x' }));
  assert.deepEqual(codes(away), [['COULD_NOT_VERIFY', 1]]);
  assert.match(away[0].message, /unexpected host/);
  const big = await run([pin(SHA('2'), 1)], mockFetch({ compare: { [SHA('2')]: { status: 200, body: `{"status":"behind","x":"${'y'.repeat(lib.MAX_INPUT_BYTES)}"}` } } }));
  assert.deepEqual(codes(big), [['COULD_NOT_VERIFY', 1]]);
  assert.match(big[0].message, /larger than/);
  const renamed = await run([pin(SHA('3'), 1)], mockFetch({ branch: 'master' }));
  assert.deepEqual(codes(renamed), [['COULD_NOT_VERIFY', 1]]);
  assert.match(renamed[0].message, /default branch is master, but repos\.ratelimit-cpp\.default_branch is main/);
});

// ---------- Dedupe and ordering ----------
test('[ordering] two locations of one SHA make one compare request and two findings, in file and line order', async () => {
  const mock = mockFetch({ compare: { [SHA('9')]: { status: 200, compare: 'diverged' } } });
  const pins = [pin(SHA('9'), 179, 'pages/projects/image-quality-gate.html', 'image-quality-gate'),
    pin(SHA('9'), 100, 'pages/projects/image-quality-gate.html', 'image-quality-gate')];
  const f = await run(pins, mock);
  assert.deepEqual(codes(f), [['PIN_UNREACHABLE', 100], ['PIN_UNREACHABLE', 179]]);
  assert.equal(mock.calls.filter((c) => c.url.includes('/compare/')).length, 1);
  assert.equal(mock.calls.filter((c) => !c.url.includes('/compare/')).length, 1, 'one default-branch request per repo');
});

test('[concurrency] the report does not depend on the order in which concurrent requests complete', async () => {
  const shas = ['1', '2', '3', '4', '5', '6'].map(SHA);
  const compare = { [shas[0]]: { status: 200, compare: 'diverged' }, [shas[1]]: { status: 404, body: {} },
    [shas[2]]: { status: 200, compare: 'behind' }, [shas[3]]: { status: 500, body: '' },
    [shas[4]]: { status: 200, compare: 'ahead' }, [shas[5]]: { throws: new TypeError('fetch failed') } };
  const pins = shas.flatMap((s, i) => [pin(s, 10 + i), pin(s, 30 - i, 'pages/projects/image-quality-gate.html', 'image-quality-gate')]);
  const reports = [];
  for (const order of [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [2, 5, 0, 3, 1, 4]]) {
    const delays = Object.fromEntries(order.map((k, rank) => [shas[k], 1 + rank * 7]));
    reports.push(JSON.stringify(await run([...pins].reverse(), mockFetch({ compare, delays }))));
  }
  assert.equal(reports[1], reports[0]);
  assert.equal(reports[2], reports[0]);
  assert.equal(JSON.parse(reports[0]).length, 10);
});

// ---------- CLI ----------
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, GITHUB_TOKEN: '' } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
async function withRoot(files, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pins-'));
  try {
    await writeFile(path.join(dir, 'claims.json'), JSON.stringify({ schema_version: 1, ...DOC, environments: {}, tables: [], claims: [] }));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('CLI --only pins: pages without pins pass (exit 0); an unresolvable pin fails PIN_UNKNOWN_REPO (exit 1), both without a request', async () => {
  await withRoot({ 'index.html': '<p>hi</p>', 'pages/about.html': '<p>about</p>' }, async (dir) => {
    const r = await cli(['--root', dir, '--claims', path.join(dir, 'claims.json'), '--only', 'pins']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /\[check-claims\] ok \(checks: pins;/);
  });
  await withRoot({ 'pages/coursework.html': '<p>see <code>62e0c26</code></p>' }, async (dir) => {
    const r = await cli(['--root', dir, '--claims', path.join(dir, 'claims.json'), '--only', 'pins']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^\[check-claims\] pages\/coursework\.html:1 PIN_UNKNOWN_REPO /m);
  });
});
