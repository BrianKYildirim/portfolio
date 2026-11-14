// Loads the real image-quality-gate Python pipeline (vendored at the sha in iqg-py/iqg.manifest.json) into Pyodide,
// from bytes checked against that manifest. Shared by the demo's worker and the Node tests (tools/pyodide-cache.mjs);
// every number the demo shows comes from Python, this file only installs and calls it.

// Where the vendored upstream app/ package is written in Pyodide's file system; it goes first on sys.path.
export const SOURCE_ROOT = '/home/pyodide/iqg';

// Modules upstream app/core/config.py needs from the vendored wheels (pydantic-settings imports dotenv); a wheel's
// import name is not derivable from its file name (python_dotenv -> dotenv), so they are listed here.
const WHEEL_IMPORTS = ['pydantic', 'pydantic_settings', 'dotenv'];

const DECODER = new TextDecoder();

export class IqgLoadError extends Error {
  // kind: 'integrity' (bytes differ from the manifest) or 'load' (a file, package or import failed); what: its name.
  constructor(kind, what, { cause } = {}) {
    super(`${kind === 'integrity' ? 'bytes differ from the manifest' : 'could not load'}: ${what}`, { cause });
    this.name = 'IqgLoadError';
    this.kind = kind;
    this.what = what;
  }
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The full download a visitor's tab may fetch: the Pyodide files, the vendored wheels and the vendored sources.
export function totalBytes(manifest) {
  const sum = (files) => Object.values(files ?? {}).reduce((n, e) => n + e.bytes, 0);
  return sum(manifest.pyodide.files) + sum(manifest.wheels) + sum(manifest.sources.files);
}

// ---------- Loading ----------

// PEP 503 name normalization, the form pyodide-lock.json uses for its package keys.
const normName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

async function verified(bytes, entry, what) {
  if (!(bytes instanceof Uint8Array) || !entry || bytes.length !== entry.bytes || await sha256Hex(bytes) !== entry.sha256) {
    throw new IqgLoadError('integrity', what);
  }
  return bytes;
}

async function read(reader, name) {
  try { return await reader(name); } catch (err) { throw new IqgLoadError('load', name, { cause: err }); }
}

function importAll(pyodide, names) {
  for (const name of names) {
    try { pyodide.pyimport(name).destroy(); } catch (err) { throw new IqgLoadError('load', name, { cause: err }); }
  }
}

// readCdn(name) and readVendored(rel) return a Uint8Array: the worker fetches, Node reads its verified cache and the
// repo. Python only ever receives data as call arguments (toPy, callKwargs), never as source text.
export async function loadIqg({ manifest, pyodideUrl, indexURL, readCdn, readVendored, onProgress = () => {},
  now = () => performance.now() } = {}) {
  const loadTimings = [];
  const step = async (stage, fn) => {
    onProgress({ stage, done: false });
    const t0 = now(), out = await fn(), ms = now() - t0;
    loadTimings.push({ stage, ms });
    onProgress({ stage, done: true, ms });
    return out;
  };

  const { pyodide, lock } = await step('runtime', async () => {
    const lockBytes = await verified(await read(readCdn, 'pyodide-lock.json'), manifest.pyodide.files['pyodide-lock.json'],
      'pyodide-lock.json');
    const lockText = DECODER.decode(lockBytes);
    try {
      const { loadPyodide } = await import(pyodideUrl);
      const py = await loadPyodide({ indexURL, lockFileContents: lockText, packageBaseUrl: indexURL,
        stdout: () => {}, stderr: () => {} });
      return { pyodide: py, lock: JSON.parse(lockText) };
    } catch (err) {
      throw new IqgLoadError('load', 'pyodide.mjs', { cause: err });
    }
  });

  await step('packages', async () => {
    try {
      await pyodide.loadPackage(manifest.packages, { messageCallback: () => {}, errorCallback: () => {} });
    } catch (err) {
      throw new IqgLoadError('load', manifest.packages.join(', '), { cause: err });
    }
    // Import names come from the verified lock (opencv-python -> cv2, pillow -> PIL).
    importAll(pyodide, manifest.packages.flatMap((p) => lock.packages[normName(p)]?.imports ?? [p]));
  });

  await step('sources', async () => {
    for (const [rel, entry] of Object.entries(manifest.wheels)) {
      pyodide.unpackArchive(await verified(await read(readVendored, rel), entry, rel), 'wheel');
    }
    importAll(pyodide, WHEEL_IMPORTS);
    for (const [rel, entry] of Object.entries(manifest.sources.files)) {
      const bytes = await verified(await read(readVendored, rel), entry, rel);
      const file = `${SOURCE_ROOT}/${rel}`;
      pyodide.FS.mkdirTree(file.slice(0, file.lastIndexOf('/')));
      pyodide.FS.writeFile(file, bytes);
    }
    const sys = pyodide.pyimport('sys'), sysPath = sys.path, importlib = pyodide.pyimport('importlib');
    sysPath.insert(0, SOURCE_ROOT);
    importlib.invalidate_caches();
    for (const p of [sysPath, sys, importlib]) p.destroy();
  });

  const pyimport = (name) => pyodide.pyimport(name);
  return { pyodide, pyimport, loadTimings, ...session(pyodide, pyimport) };
}

// ---------- Session ----------

// Upstream's answer for one upload as a fail code: what the worker shows and the parity test compares. It only reads
// the status and the cause class Python returned (app/services/pipeline.py outcome); nothing is decided here.
export function failOf({ status, cause }) {
  if (status === 415) return 'unsupported_type';
  if (status === 413) return 'too_large';
  if (status === 400) return cause === 'ImageTooLarge' ? 'too_many_pixels' : cause === 'MemoryError' ? 'memory' : 'invalid_image';
  return 'fatal';
}

// The native-vs-Pyodide bound for one field (manifest.parity.tolerances): { abs } as is, { rel } scaled by the native
// value, no entry means exact. The parity comparison and the demo's near-threshold note both use this.
export function toleranceFor(field, value, tolerances) {
  const t = tolerances?.[field];
  if (!t) return 0;
  return 'abs' in t ? t.abs : t.rel * Math.abs(value);
}

// Names of the checks Python returned whose margin is within the native-vs-Pyodide bound of their measurement, so the
// native service could decide them the other way. Inclusive: a margin of 0 always qualifies.
export function nearThreshold(checks, tolerances) {
  return checks.filter((c) => Math.abs(c.margin) <= toleranceFor(c.measurement, c.value, tolerances)).map((c) => c.name);
}

const pyJson = (proxy) => { try { return JSON.parse(proxy.model_dump_json()); } finally { proxy.destroy(); } };

// config, analyze and reevaluate call upstream app.services.pipeline and diagnostics with values as arguments.
// Module proxies are imported on first use and live as long as the runtime; every per-call proxy is destroyed after use.
function session(pyodide, pyimport) {
  const mods = {};
  const mod = (name) => (mods[name] ??= pyimport(name));
  const py = () => ({ Settings: (mods.Settings ??= mod('app.core.config').Settings),
    get pipeline() { return mod('app.services.pipeline'); }, get diagnostics() { return mod('app.services.diagnostics'); } });

  function config() {
    const { Settings, diagnostics } = py(), s = Settings();
    try { return pyJson(diagnostics.config(s)); } finally { s.destroy(); }
  }

  function analyze(bytes, contentType, { overrides = {}, bins } = {}) {
    const { Settings, pipeline } = py();
    const s = Settings.callKwargs(overrides), data = pyodide.toPy(bytes);
    let o;
    try {
      o = pipeline.outcome(data, contentType, s, bins ?? null);
    } catch (err) {
      if (err?.type === 'MemoryError') return { fail: 'memory' };
      throw err;
    } finally {
      data.destroy(); s.destroy();
    }
    const r = o.toJs({ dict_converter: Object.fromEntries });
    o.destroy();
    if (r.status === 200) return { status: 200, response_json: r.response_json, response: JSON.parse(r.response_json) };
    const cause = r.cause ?? null; // Python None arrives as undefined
    return { fail: failOf({ status: r.status, cause }), status: r.status, detail: r.detail, cause };
  }

  // upstream Settings decides which values are valid (config.py Field constraints). The rejected fields are the ones
  // Settings rejects on their own; when none does alone, every edited field is reported.
  const accepts = (Settings, name, value) => {
    try { Settings.callKwargs({ [name]: value }).destroy(); return true; } catch (err) {
      if (err?.type !== 'ValidationError') throw err;
      return false;
    }
  };

  function reevaluate({ blur_score, brightness }, overrides = {}) {
    const { Settings, pipeline, diagnostics } = py();
    let s;
    try {
      s = Settings.callKwargs(overrides);
    } catch (err) {
      if (err?.type !== 'ValidationError') throw err;
      const names = Object.keys(overrides), invalid = names.filter((k) => !accepts(Settings, k, overrides[k]));
      return { invalid: invalid.length ? invalid : names };
    }
    try {
      return { decision: pyJson(pipeline.reevaluate(blur_score, brightness, s)), settings: pyJson(diagnostics.effective_settings(s)) };
    } finally {
      s.destroy();
    }
  }

  return { config, analyze, reevaluate };
}
