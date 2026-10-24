// The value in effect for each [state] item on Codex, with its source (design note v0.2 §5.12).
// Codex keeps no age sweep, so retention is not expressible; prompt history is
// `[history] persistence` [CX §4, §16], resolved through Codex 0.160.0's layer order
// (descriptor `layers`, from the loader source).

import fs from 'node:fs';
import path from 'node:path';
import { readToml } from '../../files.js';
import { readFolderFile } from '../../folder-config.js';

const ABOVE_FOLDER_CWD = 'a launch can still set another value with CLI flags (-c) or a -p profile, which outrank the folder [CX §2]; only managed_config.toml holds for every launch';
const ABOVE_FOLDER = 'a launch can still set another value: CLI flags (-c), a trusted project\'s .codex/config.toml (root to cwd) and the profile selected with -p outrank the folder [CX §2]; only managed_config.toml holds for every launch';

function mapPersistence(value, item) {
  const mapped = item.values[value];
  return mapped
    ? { value: mapped, native_value: value }
    : { value: null, native_value: value, valid: false, reason: `history.persistence must be one of ${Object.keys(item.values).join(', ')}` };
}

const historyKey = (doc, key) => (doc?.history && typeof doc.history === 'object' ? doc.history[key] : undefined);
const topKey = (doc, key) => doc?.[key];

// The project layers a launch in `cwd` reads, as the descriptor's `project_layers` says [CX §2].
function projectLayers(cwd, folderDoc, spec) {
  let root = null;
  for (let cur = cwd; ; cur = path.dirname(cur)) {
    if (spec.root_markers.some((m) => fs.existsSync(path.join(cur, m)))) {
      root = cur;
      break;
    }
    if (path.dirname(cur) === cur) break;
  }
  const dirs = [];
  for (let cur = cwd; ; cur = path.dirname(cur)) {
    dirs.push(cur);
    if (cur === (root ?? cwd) || path.dirname(cur) === cur) break;
  }
  const t = spec.trust;
  const table = folderDoc?.[t.table] && typeof folderDoc[t.table] === 'object' ? folderDoc[t.table] : {};
  const trusted = [root ?? cwd, cwd].some((p) => table[p]?.[t.key] === t.value);
  const layers = [];
  for (const dir of dirs) {
    const file = path.join(dir, spec.file);
    const r = readToml(file);
    if (r.present) layers.push({ source: 'project', from: file, doc: r.value, error: r.error });
  }
  return { root: root ?? cwd, trusted, layers };
}

export function stateInEffect(harnessPath, descriptor, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const L = descriptor.layers;
  const items = descriptor.state;
  const errors = [];
  const notes = [];

  const folder = readFolderFile(harnessPath, L.folder, descriptor, readToml, opts.home);
  if (folder.error) {
    errors.push(`${folder.file}: ${folder.error}`);
    notes.push(`${folder.file} could not be read (${folder.error}), so a value set there is unknown`);
  }
  const managedFile = 'managedRoot' in opts ? (opts.managedRoot && path.join(opts.managedRoot, 'managed_config.toml')) : L.managed[platform];
  const systemFile = 'managedRoot' in opts ? (opts.managedRoot && path.join(opts.managedRoot, 'config.toml')) : L.system[platform];
  const read = (file) => {
    if (!file) return { present: false };
    const r = readToml(file, { noFollow: false });
    if (r.error) errors.push(`${file}: ${r.error}`);
    return r;
  };
  const managed = read(managedFile);
  const system = read(systemFile);
  const mdm = L.mdm_domain[platform];

  // The layers this build reads, highest first. A refused folder file stops the walk at the
  // folder: below it, a value would be wrong whenever the folder sets one.
  const project = opts.cwd ? projectLayers(opts.cwd, folder.value, descriptor.project_layers) : null;
  for (const l of project?.layers ?? []) if (l.error) errors.push(`${l.from}: ${l.error}`);
  const layers = [
    { source: 'managed', from: managedFile, doc: managed.value },
    ...(project?.trusted ? project.layers.filter((l) => !l.error) : []),
    { source: 'folder', from: folder.file, doc: folder.value, refused: folder.refused, via_symlink: folder.via_symlink },
    { source: 'system', from: systemFile, doc: system.value },
  ];
  const lookup = (get) => {
    for (const l of layers) {
      if (l.refused) return { refused: l };
      const v = get(l.doc);
      if (v !== undefined) return { layer: l, value: v };
    }
    return null;
  };

  const p = items.prompt_history;
  const found = lookup((doc) => historyKey(doc, 'persistence'));
  let history;
  if (found?.refused) {
    history = { value: null, source: 'folder', from: found.refused.from, via_symlink: true, refused: found.refused.refused };
  } else if (found) {
    const l = found.layer;
    history = { ...mapPersistence(found.value, p), source: l.source, from: l.from, ...(l.via_symlink ? { via_symlink: true } : {}) };
  } else {
    history = { value: p.harness_default, source: 'default' };
  }
  history.native = p.native;
  const maxBytes = lookup((doc) => historyKey(doc, 'max_bytes'));
  if (maxBytes && !maxBytes.refused) history.max_bytes = maxBytes.value;

  const unverified = [...notes];
  if (mdm) {
    unverified.push(`the MDM domain ${mdm} is not consulted: its legacy managed_config.toml would outrank every source here, and its managed preferences sit below the system layer`);
  }
  if (project) unverified.push(descriptor.project_layers.unverified);
  if (project && !project.trusted && project.layers.length) {
    unverified.push(`${project.root} is not a trusted project in the user config, so Codex skips its .codex/config.toml (${project.layers.length} found)`);
  }
  if (history.source !== 'managed') unverified.push(opts.cwd ? ABOVE_FOLDER_CWD : ABOVE_FOLDER);
  if (project) history.cwd = { path: opts.cwd, project_root: project.root, trusted: project.trusted, layers: project.layers.map((l) => ({ source: 'project', file: l.from })) };
  if (history.source === 'system' || history.source === 'default') {
    unverified.push(`${L.not_consulted_below_folder.join(', ')} is not consulted; it sits between the folder and the system layer`);
  }
  history.unverified = unverified;

  // sqlite_home and log_dir move state out of the folder [CX §1], from whichever layer sets them.
  const escapes = [];
  for (const [key, cls, note] of [['sqlite_home', 'sessions', 'SQLite databases (thread state, history, memories, goals, logs)'], ['log_dir', 'logs', 'logs']]) {
    const hit = lookup((doc) => topKey(doc, key));
    if (hit && !hit.refused && typeof hit.value === 'string') {
      escapes.push({ kind: 'outbound-write', path: hit.value, class: cls, ...(cls === 'sessions' ? { mixed: ['history', 'logs'] } : {}),
        note: `${note}, moved by ${key}`, set_by: { source: hit.layer.source, from: hit.layer.from }, source: 'CX §1 [D-env][S-schema]' });
    }
  }

  return {
    items: {
      retention_days: { value: null, source: 'default', expressible: false, reason: items.retention_days.reason },
      sessions: { value: items.sessions.harness_default, source: 'default', launch_only: items.sessions.launch_only },
      prompt_history: history,
    },
    harness_defaults: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.harness_default])),
    escapes,
    errors,
  };
}
