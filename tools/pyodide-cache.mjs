// Downloads, verifies and caches the Pyodide CDN files listed in scripts/demos/iqg-py/iqg.manifest.json for the Node
// tests (D-20: zero dependencies, cache outside the repo, fail closed). loadIqgNode runs the shipped loader on them.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadIqg } from '../scripts/demos/iqg-pyodide.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const matches = (b, e) => b.length === e.bytes && sha256(b) === e.sha256;

export function defaultCacheDir(manifest) {
  return process.env.IQG_PYODIDE_CACHE || path.join(os.tmpdir(), 'portfolio-pyodide', manifest.pyodide.version);
}

async function cachedOk(file, entry) {
  try { return matches(await readFile(file), entry); } catch { return false; /* not cached yet */ }
}

// Every file is re-verified on every call. A missing or different cached file is downloaded again into a unique
// temporary file and renamed into place, so a parallel test process never reads a half-written file.
export async function ensurePyodideCache(manifest, { dir = defaultCacheDir(manifest), fetchImpl = fetch,
  timeoutMs = 120000 } = {}) {
  await mkdir(dir, { recursive: true });
  for (const [name, entry] of Object.entries(manifest.pyodide.files)) {
    const file = path.join(dir, name);
    if (await cachedOk(file, entry)) continue;
    let b;
    try {
      const r = await fetchImpl(manifest.pyodide.cdn_base + name, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      b = new Uint8Array(await r.arrayBuffer());
    } catch (err) {
      throw new Error(`${name}: download failed (${err.message})`, { cause: err });
    }
    if (!matches(b, entry)) throw new Error(`${name}: bytes or sha256 differ from the manifest`);
    const tmp = path.join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, b);
    try {
      await rename(tmp, file);
    } catch (err) {
      // Windows refuses to replace a file another process has open; that file is fine if it now verifies.
      await rm(tmp, { force: true });
      if (!(await cachedOk(file, entry))) throw new Error(`${name}: could not write the cache file`, { cause: err });
    }
  }
  return dir;
}

const readBytes = async (file) => new Uint8Array(await readFile(file)); // Pyodide rejects Node Buffers (Pitfall 2)

export async function loadIqgNode(manifest, { root = ROOT, dir = defaultCacheDir(manifest), ...options } = {}) {
  await ensurePyodideCache(manifest, { dir });
  return loadIqg({
    manifest,
    pyodideUrl: pathToFileURL(path.join(dir, 'pyodide.mjs')).href,
    indexURL: dir + path.sep,
    readCdn: (name) => readBytes(path.join(dir, name)),
    readVendored: (rel) => readBytes(path.join(root, manifest.sources.dir, ...rel.split('/'))),
    ...options,
  });
}
