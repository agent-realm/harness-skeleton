// Spec layers and their resolution (design note v0.2 §5.1). A spec is an ordered list of
// layer directories, lowest first, each with a `spec.toml`, then `local.toml`, the
// install-local layer, always last. Resolution merges items by kind, records the layer that
// set each one, and digests the result; plans and receipts bind to that digest.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readBytes, readToml } from './files.js';

export const SPEC_FORMAT = '0.2';
export const LOCAL_LAYER = 'local';

// Top-level tables of a spec file and how each merges (§5.1 table). `install_local` items
// live only in local.toml (§5.1, content classes).
//   scalars: one item per key, `<table>.<key>`; the last layer that sets it wins
//   keyed:   one item per entry, `<table>.<id>`; a later layer replaces the whole item
//   scalar:  the table itself is one item
const KINDS = {
  model: { sub: { roles: 'scalars', catalog: 'keyed' } },
  endpoints: { merge: 'keyed', install_local: true },
  login: { merge: 'scalars', install_local: true },
  state: { merge: 'scalars', install_local: true },
  runtime: { merge: 'scalars' },
  mcp: { merge: 'keyed' },
  hook: { merge: 'keyed' },
  plugin: { merge: 'keyed' },
  env: { merge: 'keyed' },
  statusline: { merge: 'scalar' },
  mode: { merge: 'scalar' },
  isolation: { merge: 'scalar' },
};

// File items (§5.1): a later layer's directory or file wins by name.
const FILE_KINDS = [
  { kind: 'skill', dir: 'skills', entry: (n, st) => st.isDirectory() && n },
  { kind: 'agent', dir: 'agents', entry: (n, st) => st.isFile() && n.endsWith('.md') && n.slice(0, -3) },
  { kind: 'command', dir: 'commands', entry: (n, st) => st.isFile() && n.endsWith('.md') && n.slice(0, -3) },
];

function isTable(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Canonical JSON: object keys sorted, so a digest does not depend on file order.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (isTable(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// The digest of a file item: a regular file's bytes, or a directory's sorted listing of
// relative paths with their digests. A symlink is digested as its target string, never followed.
export function digestPath(abs) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return sha256('link:' + fs.readlinkSync(abs));
  if (st.isFile()) {
    const r = readBytes(abs);
    return r.bytes ? sha256(r.bytes) : sha256(`unreadable:${r.error}`);
  }
  if (!st.isDirectory()) return sha256('special'); // a FIFO, socket or device: never opened
  const parts = [];
  for (const name of fs.readdirSync(abs).sort()) parts.push(`${name}\0${digestPath(path.join(abs, name))}`);
  return sha256('dir:' + parts.join('\n'));
}

// One layer's entries, before merging: [{id, kind, value, install_local}], the tombstones,
// the permission rules, and any problem found while reading it.
export function readLayer(file, { local = false } = {}) {
  const problems = [];
  const r = readToml(file);
  if (r.error || !r.present) {
    problems.push({ code: 'layer_unreadable', severity: 'error', file, message: `${file}: ${r.error ?? 'missing'}` });
    return { name: null, file, entries: [], removals: [], rules: [], problems };
  }
  const doc = r.value;
  const header = isTable(doc.spec) ? doc.spec : null;
  let name = local ? LOCAL_LAYER : null;
  let version = null;
  if (!local) {
    if (!header || typeof header.name !== 'string' || typeof header.version !== 'string' || typeof header.format !== 'string') {
      problems.push({ code: 'spec_header_missing', severity: 'error', file, message: `${file}: [spec] needs name, version and format strings` });
    } else if (header.format !== SPEC_FORMAT) {
      problems.push({ code: 'format_unsupported', severity: 'error', file, message: `${file}: format ${JSON.stringify(header.format)}; this build reads ${SPEC_FORMAT}` });
    }
    name = typeof header?.name === 'string' ? header.name : null;
    version = typeof header?.version === 'string' ? header.version : null;
  }

  const entries = [];
  const add = (id, kind, value, install_local = false) => entries.push({ id, kind, value, install_local });
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'spec') continue;
    if (key === 'remove') continue;
    if (key === 'permissions') continue;
    if (key === 'refs') {
      if (!isTable(value)) {
        problems.push({ code: 'item_malformed', severity: 'error', file, item: 'refs', message: `${file}: [refs] must be a table` });
        continue;
      }
      // A table declares a ref (portable); a string binds one to a reference (install-local).
      for (const [ref, v] of Object.entries(value)) {
        if (isTable(v)) add(`refs.${ref}`, 'refs', v);
        else add(`binding.${ref}`, 'binding', v, true);
      }
      continue;
    }
    const k = KINDS[key];
    if (!k) {
      add(key, 'unknown', value);
      continue;
    }
    if (k.sub) {
      if (!isTable(value)) {
        problems.push({ code: 'item_malformed', severity: 'error', file, item: key, message: `${file}: [${key}] must be a table` });
        continue;
      }
      for (const [sub, subValue] of Object.entries(value)) {
        const how = k.sub[sub];
        if (!how) add(`${key}.${sub}`, 'unknown', subValue);
        else if (!isTable(subValue)) problems.push({ code: 'item_malformed', severity: 'error', file, item: `${key}.${sub}`, message: `${file}: [${key}.${sub}] must be a table` });
        else for (const [id, v] of Object.entries(subValue)) add(`${key}.${sub}.${id}`, `${key}.${sub}`, v);
      }
      continue;
    }
    if (k.merge === 'scalar') {
      add(key, key, value, k.install_local);
    } else if (!isTable(value)) {
      problems.push({ code: 'item_malformed', severity: 'error', file, item: key, message: `${file}: [${key}] must be a table` });
    } else {
      for (const [id, v] of Object.entries(value)) add(`${key}.${id}`, key, v, k.install_local);
    }
  }

  const removals = Array.isArray(doc.remove?.items) ? doc.remove.items.filter((x) => typeof x === 'string') : [];
  if (doc.remove !== undefined && !Array.isArray(doc.remove?.items)) {
    problems.push({ code: 'item_malformed', severity: 'error', file, item: 'remove', message: `${file}: [remove] needs items = [ … ]` });
  }
  const rules = Array.isArray(doc.permissions?.rule) ? doc.permissions.rule : [];
  return { name, version, file, entries, removals, rules, problems };
}

function readFileItems(dir) {
  const items = [];
  for (const { kind, dir: sub, entry } of FILE_KINDS) {
    const root = path.join(dir, sub);
    let names = [];
    try {
      names = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const abs = path.join(root, n);
      const st = fs.lstatSync(abs);
      const name = entry(n, st);
      if (name) items.push({ id: `${kind}.${name}`, kind, path: abs, sha256: digestPath(abs) });
    }
  }
  return items;
}

// The process an item runs (§5.4), or null: an MCP server's value itself when it names `exec` or
// `shell`; a hook's and the status line's `run`.
function processOf(item) {
  const v = item.value;
  if (!isTable(v)) return null;
  if (item.kind === 'mcp') return typeof v.exec === 'string' || typeof v.shell === 'string' ? v : null;
  if (item.kind === 'hook' || item.kind === 'statusline') return isTable(v.run) ? v.run : null;
  return null;
}

// The files a process names inside its layer (§5.1, §5.4): `exec`, and each `args` entry, that is
// a relative path resolving to an existing file or directory in the layer directory. Bound by
// sha256 in the spec digest, so an edited script changes it. Anything else (a command on PATH, an
// absolute path, a path out of the layer, a `shell` string) is bound by its text only.
function processFiles(proc, layerDir) {
  const out = [];
  const names = [proc.exec, ...(Array.isArray(proc.args) ? proc.args : [])].filter((s) => typeof s === 'string' && s !== '');
  for (const s of names) {
    if (path.isAbsolute(s)) continue;
    const abs = path.resolve(layerDir, s);
    const rel = path.relative(layerDir, abs);
    // `.` names the layer itself (`node .` runs the package at its root): its whole digest binds it.
    if (rel === '') {
      if (!out.some((f) => f.path === '.')) out.push({ path: '.', abs: layerDir, sha256: digestPath(fs.realpathSync.native(layerDir)) });
      continue;
    }
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    // Walk the path one component at a time, never through a link: the first symlink on the way
    // is bound as itself (its target string, as a file item's link is), and nothing past it is read.
    let bound = null;
    let cur = layerDir;
    const segs = rel.split(path.sep);
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i]);
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break;
      }
      if (st.isSymbolicLink() || i === segs.length - 1) {
        if (st.isSymbolicLink() || st.isFile() || st.isDirectory()) bound = { path: segs.slice(0, i + 1).join('/'), abs: cur };
        break;
      }
      if (!st.isDirectory()) break;
    }
    if (!bound || out.some((f) => f.path === bound.path)) continue;
    out.push({ ...bound, sha256: digestPath(bound.abs) });
  }
  return out;
}

function covers(removal, id) {
  return id === removal || id.startsWith(removal + '.');
}

// Resolve layer directories (lowest first) and an optional local.toml into one spec.
export function resolve(layerDirs, localFile = null) {
  const layers = [];
  const problems = [];
  const items = new Map();
  const files = new Map();
  const rules = [];
  const agentsMd = [];
  const removed = [];
  const replaced = [];

  const sources = layerDirs.map((dir) => ({ dir, file: path.join(dir, 'spec.toml'), local: false }));
  if (localFile) sources.push({ dir: path.dirname(localFile), file: localFile, local: true });

  const seen = new Set();
  for (const src of sources) {
    const layer = readLayer(src.file, { local: src.local });
    problems.push(...layer.problems);
    const name = layer.name ?? src.file;
    if (seen.has(name)) problems.push({ code: 'layer_name_duplicate', severity: 'error', file: src.file, message: `two layers are named ${JSON.stringify(name)}` });
    seen.add(name);
    layers.push({ name, version: layer.version ?? null, path: src.local ? src.file : src.dir, local: src.local });

    // Tombstones delete from lower layers before this layer adds its own items.
    for (const removal of layer.removals) {
      for (const map of [items, files]) {
        for (const id of [...map.keys()]) {
          if (covers(removal, id)) {
            removed.push({ id, by: name, from: map.get(id).layer });
            map.delete(id);
          }
        }
      }
    }
    // Checked per layer, before a later layer or a tombstone can hide the entry.
    for (const e of layer.entries) {
      if (e.install_local && !src.local) {
        problems.push({ code: 'install_local_misplaced', severity: 'error', item: e.id, layer: name,
          message: `${e.id} is install-local (endpoints, login, state, ref bindings) and is set in layer ${name}; it belongs in local.toml` });
      }
      if (e.kind === 'unknown') {
        problems.push({ code: 'unknown_kind', severity: 'warning', item: e.id, layer: name, message: `${e.id} is not a kind this format defines; it is kept, not delivered` });
      }
    }
    for (const e of layer.entries) {
      const previous = items.get(e.id);
      if (previous) replaced.push({ id: e.id, by: name, from: previous.layer });
      items.set(e.id, { ...e, layer: name, local: src.local });
    }
    for (const rule of layer.rules) rules.push({ rule, layer: name });

    if (!src.local) {
      for (const f of readFileItems(src.dir)) {
        const previous = files.get(f.id);
        if (previous) replaced.push({ id: f.id, by: name, from: previous.layer });
        files.set(f.id, { ...f, layer: name });
      }
      const agents = readBytes(path.join(src.dir, 'AGENTS.md'));
      if (agents.error) problems.push({ code: 'layer_unreadable', severity: 'error', file: path.join(src.dir, 'AGENTS.md'), message: `${src.dir}/AGENTS.md: ${agents.error}` });
      if (agents.bytes) agentsMd.push({ layer: name, path: path.join(src.dir, 'AGENTS.md'), text: agents.bytes.toString('utf8'), sha256: sha256(agents.bytes) });
    }
  }

  // By UTF-16 code unit, never localeCompare: the digest must not depend on the machine's locale.
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sortedItems = [...items.values()].sort(byId);
  const sortedFiles = [...files.values()].sort(byId);
  // The files each process item runs from its layer (§5.4), in the order it names them.
  const layerDir = new Map(layers.map((l) => [l.name, l.local ? path.dirname(l.path) : l.path]));
  const processes = [];
  for (const item of sortedItems) {
    const proc = processOf(item);
    if (!proc) continue;
    let bound;
    try {
      bound = processFiles(proc, layerDir.get(item.layer));
    } catch (e) {
      problems.push({ code: 'layer_unreadable', severity: 'error', item: item.id, layer: item.layer, message: `${item.id}: a file it runs cannot be read (${e.code ?? e.message})` });
      continue;
    }
    if (bound.length) processes.push({ id: item.id, layer: item.layer, files: bound });
  }
  const digest = 'sha256:' + sha256(canonical({
    format: SPEC_FORMAT,
    layers: layers.map((l) => ({ name: l.name, version: l.version })),
    items: sortedItems.map((i) => ({ id: i.id, layer: i.layer, value: i.value })),
    permissions: rules,
    agents_md: agentsMd.map((a) => ({ layer: a.layer, sha256: a.sha256 })),
    files: sortedFiles.map((f) => ({ id: f.id, layer: f.layer, sha256: f.sha256 })),
    // Only when a process names a file: a spec without one keeps the digest it had before 6a.3.
    ...(processes.length ? { processes: processes.map((p) => ({ id: p.id, layer: p.layer, files: p.files.map((f) => ({ path: f.path, sha256: f.sha256 })) })) } : {}),
  }));

  return { layers, items: sortedItems, files: sortedFiles, processes, permissions: rules, agents_md: agentsMd, removed, replaced, problems, digest };
}
