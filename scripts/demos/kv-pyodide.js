// Loads the real key-value-storage server.py and observability.py (vendored at the sha in kv-py/kv.manifest.json) into
// Pyodide from bytes checked against that manifest. Shared by the demo's worker and the Node tests; every reply, state
// and event comes from Python, this file only sequences calls in the order of upstream tests/parity/README.md.

// Where the vendored upstream files are written in Pyodide's file system (first on sys.path), and the working
// directory the store file ('store.txt', relative like upstream) lives in.
export const SOURCE_ROOT = '/home/pyodide/kv';
export const WORK_DIR = '/home/pyodide';
export const MAX_COMMAND_BYTES = 1024; // claim-waiver: states server.py's recv(1024) framing (design fact kv.design.recv_bytes)

const STORE = 'store.txt';
const MODULES = ['server', 'observability'];
const DECODER = new TextDecoder();
const STRICT = new TextDecoder('utf-8', { fatal: true });

export class KvLoadError extends Error {
  // kind: 'integrity' (bytes differ from the manifest) or 'load' (a file, runtime or import failed); what: its name.
  constructor(kind, what, { cause } = {}) {
    super(`${kind === 'integrity' ? 'bytes differ from the manifest' : 'could not load'}: ${what}`, { cause });
    this.name = 'KvLoadError';
    this.kind = kind;
    this.what = what;
  }
}

// Subresource Integrity value for a manifest sha256 (hex): 'sha256-' + base64 of the raw digest bytes.
export const sri = (hex) => `sha256-${btoa(String.fromCharCode(...hex.match(/../g).map((h) => parseInt(h, 16))))}`;

async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Loading ----------

async function verified(bytes, entry, what) {
  if (!(bytes instanceof Uint8Array) || !entry || bytes.length !== entry.bytes || await sha256Hex(bytes) !== entry.sha256) {
    throw new KvLoadError('integrity', what);
  }
  return bytes;
}

async function read(reader, name) {
  try { return await reader(name); } catch (err) { throw new KvLoadError('load', name, { cause: err }); }
}

// readCdn(name) and readVendored(rel) return a Uint8Array: the worker fetches, Node reads its verified cache and the
// repo. Python only ever receives data as call arguments (toPy, callKwargs), never as source text. stdLibURL, when
// given, is passed to loadPyodide (a caller that pre-verified python_stdlib.zip hands it over as a blob URL).
export async function loadKv({ manifest, pyodideUrl, indexURL, readCdn, readVendored, onProgress = () => {}, stdLibURL } = {}) {
  const lines = []; // Python's stdout and stderr, one entry per line; each session op takes what it produced
  const collect = (line) => { lines.push(line); };

  onProgress({ stage: 'runtime', done: false });
  const lockBytes = await verified(await read(readCdn, 'pyodide-lock.json'), manifest.pyodide.files['pyodide-lock.json'],
    'pyodide-lock.json');
  let pyodide;
  try {
    const { loadPyodide } = await import(pyodideUrl);
    pyodide = await loadPyodide({ indexURL, lockFileContents: DECODER.decode(lockBytes), packageBaseUrl: indexURL,
      stdout: collect, stderr: collect, ...(stdLibURL ? { stdLibURL } : {}) });
  } catch (err) {
    throw new KvLoadError('load', 'pyodide.mjs', { cause: err });
  }
  onProgress({ stage: 'runtime', done: true });

  onProgress({ stage: 'sources', done: false });
  for (const [rel, entry] of Object.entries(manifest.sources.files)) {
    const bytes = await verified(await read(readVendored, rel), entry, rel);
    const file = `${SOURCE_ROOT}/${rel}`;
    pyodide.FS.mkdirTree(file.slice(0, file.lastIndexOf('/')));
    pyodide.FS.writeFile(file, bytes);
  }
  const mods = {};
  try {
    const sys = pyodide.pyimport('sys'), sysPath = sys.path, importlib = pyodide.pyimport('importlib'), os = pyodide.pyimport('os');
    sysPath.insert(0, SOURCE_ROOT);
    importlib.invalidate_caches();
    os.chdir(WORK_DIR);
    for (const p of [sysPath, sys, importlib, os]) p.destroy();
  } catch (err) {
    throw new KvLoadError('load', 'sys.path', { cause: err });
  }
  for (const name of [...MODULES, 'json', 'builtins']) {
    try { mods[name] = pyodide.pyimport(name); } catch (err) { throw new KvLoadError('load', name, { cause: err }); }
  }
  onProgress({ stage: 'sources', done: true });

  return { pyodide, session: session(pyodide, mods, lines) };
}

// ---------- Session ----------

// The step protocol of upstream tests/parity/README.md. Module proxies live as long as the runtime; every per-call
// proxy is destroyed in a finally block. Python serializes every engine value (json.dumps); JavaScript only carries text.
function session(pyodide, { server, observability, json, builtins }, lines) {
  let obs, srv, current, since = 0, epoch = 0, ended = false;
  const compact = pyodide.toPy([',', ':']); // the compact JSONL separators, as a Python list

  // JSON text of a Python object, as json.dumps writes it: one JSONL line for an event, the inspection form otherwise.
  const dumps = json.dumps;
  const line = (value) => dumps.callKwargs(value, { separators: compact });
  const text = (value) => dumps.callKwargs(value, { allow_nan: false });

  // The events emitted since the last drain, each as the line a JSONL consumer would read, in emission order.
  function drain() {
    const ev = obs.recent_events(since, obs.buffer_size);
    try {
      const derived = ev.get('derived'), evicted = derived.get('evicted_since');
      const lost = evicted.get('value');
      for (const p of [evicted, derived]) p.destroy();
      if (lost) throw new Error('events left the ring buffer before they were read');
      since = ev.get('latest_seq');
      const items = ev.get('events'), out = [];
      try {
        for (let i = 0; i < items.length; i++) {
          const item = items.get(i);
          try { out.push(line(item)); } finally { item.destroy(); }
        }
      } finally {
        items.destroy();
      }
      return out;
    } finally {
      ev.destroy();
    }
  }

  function inspectJson(read) {
    const value = read();
    try { return text(value); } finally { value.destroy(); }
  }

  // store.txt as UTF-8 text, or null when the file does not exist.
  function storeText() {
    const file = `${WORK_DIR}/${STORE}`;
    if (!pyodide.FS.analyzePath(file).exists) return null;
    return STRICT.decode(pyodide.FS.readFile(file));
  }

  function release() {
    for (const p of [current, srv, obs]) p?.destroy();
    current = srv = obs = undefined;
  }

  function newSession() {
    const parser = srv.parser;
    try { current?.destroy(); current = server.Session(parser); } finally { parser.destroy(); }
    ended = false;
  }

  function boot() {
    release();
    obs = observability.Observer(); // defaults: values not redacted, max_chars 256
    srv = server.Server.callKwargs({ store_path: STORE, observer: obs }); // built, never started: nothing listens
    newSession(); // no client address and no observer: no connection hooks
    since = 0;
    epoch += 1;
  }

  // One op: do it, then take the snapshot in the protocol's order. Standard output is collected for the whole op.
  function step(op, action) {
    lines.length = 0;
    const fields = action() ?? {};
    const events = drain();
    const state = inspectJson(() => obs.state());
    const inspect_events = drain(); // the lock events state() caused itself
    const diagnostics = inspectJson(() => obs.diagnostics());
    const store_txt = storeText();
    return { epoch, op, ...fields, events, state, inspect_events, diagnostics, store_txt, stdout: lines.splice(0) };
  }

  function send(u8) {
    if (!(u8 instanceof Uint8Array) || u8.length < 1 || u8.length > MAX_COMMAND_BYTES) {
      throw new RangeError(`a command is 1 to ${MAX_COMMAND_BYTES} bytes`);
    }
    if (ended) throw new Error('session ended');
    return step('send', () => {
      const view = pyodide.toPy(u8); // a memoryview: Session.handle needs bytes (it calls .decode)
      let data, sink, append;
      try {
        data = builtins.bytes(view);
        sink = pyodide.toPy([]);
        append = sink.append;
        const keep = Boolean(current.handle(data, append));
        const replies = sink.toJs().map((b) => DECODER.decode(b));
        if (!keep) ended = true;
        return { keep, replies };
      } finally {
        for (const p of [append, sink, data, view]) p?.destroy();
      }
    });
  }

  return {
    boot: () => step('boot', boot),
    send,
    restart: () => step('restart', boot),
    reset: () => step('reset', () => {
      const file = `${WORK_DIR}/${STORE}`;
      if (pyodide.FS.analyzePath(file).exists) pyodide.FS.unlink(file);
      boot();
    }),
    newSession: () => step('new_session', newSession),
  };
}
