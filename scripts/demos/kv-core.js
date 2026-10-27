// Line-for-line port of KeyValueStore + CommandParser from key-value-storage/server.py.
// Response strings are byte-identical to the Python server's.
const pySplit = (s) => s.split(/\s+/).filter(Boolean); // str.split() with no args (ASCII whitespace; see note)
export class KeyValueStore {
  constructor(file = { text: '' }) { this.file = file; this.store = new Map(); this.load(); }
  load() { // 'key<TAB>value' per line, split on first tab
    for (let line of this.file.text.split('\n')) { line = line.trim(); if (!line) continue; const i = line.indexOf('\t'); if (i >= 0) this.store.set(line.slice(0, i), line.slice(i + 1)); }
  }
  save() { let t = ''; for (const [k, v] of this.store) t += `${k}\t${v}\n`; this.file.text = t; }
  set(key, value) { this.store.set(key, value); this.save(); return `Added key '${key}' with value '${value}'\n`; }
  get(key) { return this.store.has(key) ? this.store.get(key) : `Key '${key}' not found.`; }
  remove(key) { if (this.store.has(key)) { this.store.delete(key); this.save(); return `Removed key '${key}'.\n`; } return `Key '${key}' not found.`; }
  print_store() { if (this.store.size === 0) return 'Store is empty.\n'; let r = ''; for (const [k, v] of this.store) r += `[KEY]: ${k}\t[VALUE]: ${v}\n`; return r; }
}
export class CommandParser {
  constructor(kv) { this.kv = kv; }
  parse_and_execute(command) {
    command = command.trim();
    if (!command) return 'ERROR: Empty command\n';
    const tokens = pySplit(command);
    if (!tokens.length) return 'ERROR: Invalid command\n';
    const cmd = tokens[0].toUpperCase();
    if (cmd === 'SET') { if (tokens.length !== 3) return 'ERROR: SET command requires 2 arguments: key and value\n'; return this.kv.set(tokens[1], tokens[2]); }
    if (cmd === 'GET') { if (tokens.length !== 2) return 'ERROR: GET command requires 1 argument: key\n'; return this.kv.get(tokens[1]); }
    if (cmd === 'REMOVE') { if (tokens.length !== 2) return 'ERROR: REMOVE command requires 1 argument: key\n'; return this.kv.remove(tokens[1]); }
    if (cmd === 'PRINT') return this.kv.print_store();
    return `ERROR: Unknown command '${tokens[0]}'\n`;
  }
}
