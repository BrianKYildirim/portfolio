// Module worker for the key-value demo: loads the pinned key-value-storage engine into Pyodide through kv-pyodide.js and
// answers load, send, restart, reset and new_session requests. Every value it returns comes from Python.
import { KvLoadError, loadKv, sri } from './kv-pyodide.js';

// Replies: { id, progress } while loading, then { id, done: true, ...snapshot } or { id, fail }. The snapshot is what the
// session op returned (epoch, op, events, state, diagnostics, store_txt, stdout, and keep and replies for a send). fail is
// 'integrity' or 'load' (the runtime did not load), 'input' (a send of 0 or more than 1024 bytes, refused before Python)
// or 'fatal' (anything Python or the runtime threw).
export function createWorkerHandler({ load, post, report = () => {} }) {
  let kv = null;
  return async (data) => {
    const { id, op } = data;
    if (op === 'load') {
      try {
        kv = await load(data.manifest, data.manifestUrl, (p) => post({ id, progress: p }));
        post({ id, done: true, ...kv.session.boot() });
      } catch (err) {
        kv = null; report(err);
        post({ id, fail: err instanceof KvLoadError ? err.kind : 'load' });
      }
      return;
    }
    try {
      if (!kv) throw new Error(`${op}: the runtime is not loaded`);
      const { session } = kv;
      if (op === 'send') post({ id, done: true, ...session.send(new Uint8Array(data.bytes)) });
      else if (op === 'restart') post({ id, done: true, ...session.restart() });
      else if (op === 'reset') post({ id, done: true, ...session.reset() });
      else if (op === 'new_session') post({ id, done: true, ...session.newSession() });
      else throw new Error(`unknown op: ${op}`);
    } catch (err) {
      if (op === 'send' && err instanceof RangeError) return post({ id, fail: 'input' }); // refused before Python ran
      report(err);
      post({ id, fail: 'fatal' });
    }
  };
}

// ---------- Browser loader ----------

async function fetchChecked(url, entry, name) {
  if (!entry) throw new KvLoadError('integrity', name); // not in the manifest, so there is nothing to check it against
  const r = await fetch(url, { integrity: sri(entry.sha256) }); // a hash mismatch rejects the fetch
  if (!r.ok) throw new KvLoadError('load', name);
  return new Uint8Array(await r.arrayBuffer());
}

// The lock file comes from the CDN and the vendored sources from this site, each fetched with its manifest hash as
// integrity; loadKv checks the bytes again. The core runtime files load without SRI from the immutable versioned CDN
// path (owner decision P5=A, 04-01-SUMMARY.md); CI re-hashes them on every push and weekly.
function browserLoad(manifest, manifestUrl, onProgress) {
  const base = manifest.pyodide.cdn_base;
  return loadKv({
    manifest, onProgress, pyodideUrl: `${base}pyodide.mjs`, indexURL: base,
    readCdn: (name) => fetchChecked(base + name, manifest.pyodide.files[name], name),
    readVendored: (rel) => fetchChecked(new URL(rel, manifestUrl), manifest.sources.files[rel], rel),
  });
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const handle = createWorkerHandler({
    load: browserLoad,
    post: (m) => self.postMessage(m),
    report: (err) => console.error('[kv-worker]', err),
  });
  self.onmessage = ({ data }) => { handle(data); };
  self.postMessage({ ready: true }); // lets the page detect a worker that never loaded
}
