// Module worker for the Image Quality Gate demo: loads the pinned image-quality-gate pipeline into Pyodide through
// iqg-pyodide.js and answers load, analyze and reevaluate requests. Every value it returns comes from Python.
import { IqgLoadError, loadIqg } from './iqg-pyodide.js';

// Replies: { id, progress } while loading, then { id, done: true, ... } or { id, fail, ... }. fail is 'integrity' or
// 'load' (the runtime did not load), a code from session.analyze (unsupported_type, too_large, too_many_pixels,
// invalid_image, memory), 'invalid_override' (reevaluate) or 'fatal' (anything Python or the runtime threw).
export function createWorkerHandler({ load, post, report = () => {} }) {
  let iqg = null, manifest = null;
  return async (data) => {
    const { id, op } = data;
    if (op === 'load') {
      try {
        manifest = data.manifest;
        iqg = await load(data.manifest, data.manifestUrl, (p) => post({ id, progress: p }));
        post({ id, done: true, config: iqg.config(), load: iqg.loadTimings });
      } catch (err) {
        iqg = null; report(err);
        post({ id, fail: err instanceof IqgLoadError ? err.kind : 'load' });
      }
      return;
    }
    try {
      if (!iqg) throw new Error(`${op}: the runtime is not loaded`);
      if (op === 'analyze') {
        const r = iqg.analyze(new Uint8Array(data.bytes), data.type, { bins: manifest.parity.bins });
        if (r.status === 200) post({ id, done: true, status: 200, response_json: r.response_json, response_json_indented: r.response_json_indented });
        else post({ id, fail: r.fail, status: r.status, detail: r.detail, cause: r.cause });
      } else if (op === 'reevaluate') {
        const r = iqg.reevaluate(data.scores, data.overrides);
        if (r.invalid) post({ id, fail: 'invalid_override', fields: r.invalid });
        else post({ id, done: true, decision: r.decision, settings: r.settings });
      } else {
        throw new Error(`unknown op: ${op}`);
      }
    } catch (err) {
      report(err);
      post({ id, fail: 'fatal' });
    }
  };
}

// ---------- Browser loader ----------

// Subresource Integrity value for a manifest sha256 (hex): 'sha256-' + base64 of the raw digest bytes.
const sri = (hex) => `sha256-${btoa(String.fromCharCode(...hex.match(/../g).map((h) => parseInt(h, 16))))}`;

async function fetchChecked(url, entry, name) {
  if (!entry) throw new IqgLoadError('integrity', name); // not in the manifest, so there is nothing to check it against
  const r = await fetch(url, { integrity: sri(entry.sha256) }); // a hash mismatch rejects the fetch
  if (!r.ok) throw new IqgLoadError('load', name);
  return new Uint8Array(await r.arrayBuffer());
}

// The lock file comes from the CDN and the wheels and sources from this site, each fetched with its manifest hash as
// integrity; loadIqg checks the bytes again. Pyodide checks every CDN wheel against the verified lock. The core
// runtime files load without SRI from the immutable versioned CDN path (owner decision P5=A, 04-01-SUMMARY.md).
function browserLoad(manifest, manifestUrl, onProgress) {
  const base = manifest.pyodide.cdn_base;
  return loadIqg({
    manifest, onProgress, pyodideUrl: `${base}pyodide.mjs`, indexURL: base,
    readCdn: (name) => fetchChecked(base + name, manifest.pyodide.files[name], name),
    readVendored: (rel) => fetchChecked(new URL(rel, manifestUrl), manifest.wheels[rel] ?? manifest.sources.files[rel], rel),
  });
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const handle = createWorkerHandler({
    load: browserLoad,
    post: (m) => self.postMessage(m),
    report: (err) => console.error('[iqg-worker]', err),
  });
  self.onmessage = ({ data }) => { handle(data); };
  self.postMessage({ ready: true }); // lets the page detect a worker that never loaded
}
