// The value in effect for each [state] item, with its source (design note v0.2 §5.12, §9.2).
// Reading managed policy and the folder's settings is read-only and in scope (§2).
// `overlay` is never a source here: it exists only for a launch the tool makes, and observe
// looks at the folder, not at a launch.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, readText } from '../../files.js';
import { readFolderFile } from '../../folder-config.js';

const SKIP_ENV = 'CLAUDE_CODE_SKIP_PROMPT_HISTORY';
const LAUNCH_FLAGS = 'a launch can still set another value with --settings, which outranks every file but managed policy; only managed policy holds for all launches';
const LAUNCH_LAYERS = 'a launch can still set another value: the working directory\'s .claude/settings.json and .claude/settings.local.json, and --settings, outrank the folder, and the sweep then covers every project in the folder; only managed policy holds for all launches';

// The git root at or above `dir`: the nearest directory holding `.git`. In a worktree `.git` is a
// file naming the main checkout's git directory, and the main checkout is returned, since local
// settings are written at the git root, in the main checkout for worktrees [CC §2]. null when
// there is none.
export function gitRoot(dir, marker = '.git') {
  for (let cur = dir; ; cur = path.dirname(cur)) {
    let st;
    try {
      st = fs.lstatSync(path.join(cur, marker));
    } catch {
      st = null;
    }
    if (st?.isDirectory()) return { root: cur, worktree: false };
    if (st?.isFile()) {
      const text = readText(path.join(cur, marker)).text ?? '';
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      // git 2.48+ can write a relative gitdir (worktree.useRelativePaths): resolve it against the
      // directory holding the .git file before reading the main checkout off it.
      const gitdir = m ? path.resolve(cur, m[1]) : null;
      const main = gitdir && /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitdir);
      return main ? { root: main[1], worktree: true, checkout: cur } : { root: cur, worktree: false };
    }
    if (path.dirname(cur) === cur) return null;
  }
}

// The layers a launch in `cwd` adds above the folder, as the descriptor's `cwd_layers` lists them.
export function cwdLayers(cwd, descriptor, home) {
  const git = gitRoot(cwd, descriptor.git_root_marker);
  return descriptor.cwd_layers.map((l) => {
    const base = l.at === 'git-root' ? git?.root ?? cwd : cwd;
    return { source: l.source, ...readFolderFile(base, l.file, descriptor, readJson, home) };
  });
}

// The folder's settings.json, through the shared safe reader.
export function readFolderSettings(harnessPath, descriptor, home) {
  return readFolderFile(harnessPath, 'settings.json', descriptor, readJson, home);
}

function plistToJson(file) {
  if (!fs.existsSync(file)) return { present: false };
  try {
    const out = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { present: true, value: JSON.parse(out) };
  } catch (e) {
    return { present: true, error: `plutil could not convert it${e.status != null ? ` (exit ${e.status})` : ''}` };
  }
}

// The managed sources present, highest first [CC §2, D-managed]. The file source is
// `managed-settings.json` with `managed-settings.d/*.json` merged over it in name order
// (the order is an assumption: the docs say "merged" without one).
export function managedSources(descriptor, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const m = descriptor.managed;
  const root = 'managedRoot' in opts ? opts.managedRoot : m.roots[platform];
  const plists = ('mdmPlists' in opts ? opts.mdmPlists : m.mdm_plists[platform]) ?? [];
  const readPlist = opts.plistToJson ?? plistToJson;
  const sources = [];
  const errors = [];

  for (const file of plists) {
    const r = readPlist(file);
    if (r.error) errors.push(`${file}: ${r.error}`);
    if (r.value) sources.push({ kind: 'mdm', from: file, settings: r.value });
  }

  if (root) {
    const base = readJson(path.join(root, m.file), { noFollow: false });
    if (base.error) errors.push(`${path.join(root, m.file)}: ${base.error}`);
    let settings = base.value ? { ...base.value } : null;
    const from = base.value ? [path.join(root, m.file)] : [];
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, m.dropins)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      // no drop-in directory
    }
    for (const name of names) {
      const file = path.join(root, m.dropins, name);
      const r = readJson(file, { noFollow: false });
      if (r.error) errors.push(`${file}: ${r.error}`);
      if (r.value) {
        settings = { ...(settings ?? {}), ...r.value };
        from.push(file);
      }
    }
    if (settings) sources.push({ kind: 'file', from: from.join(', '), settings });
  }
  return { sources, errors };
}

// first-wins by default; `managedSourcesBehavior: "merge"` in any present source composes
// them, the higher source winning per key [CC §2, D-managed].
export function effectiveManaged(sources) {
  if (sources.length === 0) return null;
  const merge = sources.some((s) => s.settings.managedSourcesBehavior === 'merge');
  if (!merge) return { settings: sources[0].settings, from: sources[0].from };
  const settings = {};
  for (const s of [...sources].reverse()) Object.assign(settings, s.settings);
  return { settings, from: sources.map((s) => s.from).join('; ') };
}

function checkRetention(value, item) {
  if (Number.isInteger(value) && value >= item.minimum) return {};
  return { valid: false, reason: `${item.native} must be an integer of at least ${item.minimum}` };
}

export function stateInEffect(harnessPath, descriptor, opts = {}) {
  const items = descriptor.state;
  const { sources, errors } = managedSources(descriptor, opts);
  const managed = effectiveManaged(sources);
  const folder = readFolderSettings(harnessPath, descriptor, opts.home);
  const folderFile = folder.file;
  if (folder.error) errors.push(`${folderFile}: ${folder.error}`);

  const unverified = [];
  if (folder.error) unverified.push(`${folderFile} could not be read (${folder.error}), so a value set there is unknown`);
  if (fs.existsSync(path.join(harnessPath, descriptor.managed.server_cache))) {
    unverified.push(`server-managed settings are cached in ${descriptor.managed.server_cache}, whose format is undocumented; a value there would win over every source below it`);
  }

  // retention_days <- cleanupPeriodDays: managed, then (with a working directory) the local and
  // project layers, then the folder's settings, then the default.
  const r = items.retention_days;
  const above = opts.cwd ? cwdLayers(opts.cwd, descriptor, opts.home) : [];
  for (const l of above) {
    if (l.error) {
      errors.push(`${l.file}: ${l.error}`);
      unverified.push(`${l.file} could not be read (${l.error}), so a value set there is unknown`);
    }
  }
  const cwdHit = above.find((l) => l.refused || (l.value && l.value[r.native] !== undefined));
  let retention;
  if (managed && managed.settings[r.native] !== undefined) {
    const v = managed.settings[r.native];
    retention = { value: v, source: 'managed', from: managed.from, ...checkRetention(v, r) };
  } else if (cwdHit?.refused) {
    retention = { value: null, source: cwdHit.source, from: cwdHit.file, via_symlink: true, refused: cwdHit.refused };
  } else if (cwdHit) {
    const v = cwdHit.value[r.native];
    retention = { value: v, source: cwdHit.source, from: cwdHit.file, ...(cwdHit.via_symlink ? { via_symlink: true } : {}), ...checkRetention(v, r) };
  } else if (folder.refused) {
    retention = { value: null, source: 'folder', from: folderFile, via_symlink: true, refused: folder.refused };
  } else if (folder.value && folder.value[r.native] !== undefined) {
    const v = folder.value[r.native];
    retention = { value: v, source: 'folder', from: folderFile, ...(folder.via_symlink ? { via_symlink: true } : {}), ...checkRetention(v, r) };
  } else {
    retention = { value: r.harness_default, source: 'default' };
  }
  retention.native = r.native;
  // Only managed policy holds for every launch. The project and local settings of the working
  // directory and --settings outrank the folder [CC §2, §4], and the sweep covers every
  // projects/<project>/ in the folder, so one launch can sweep the whole folder at a shorter
  // period. With --cwd the project layers are read; --settings is still unknown.
  if (retention.source !== 'managed') unverified.push(opts.cwd ? LAUNCH_FLAGS : LAUNCH_LAYERS);
  if (opts.cwd) retention.cwd = { path: opts.cwd, layers: above.map((l) => ({ source: l.source, file: l.file, present: l.present === true, ...(l.value && l.value[r.native] !== undefined ? { sets: true } : {}) })) };
  if (unverified.length) retention.unverified = [...unverified];

  const envNote = `an env block in managed or folder settings may set ${SKIP_ENV}; this build does not consult it`;
  const sessions = {
    value: items.sessions.harness_default,
    source: 'default',
    launch_only: items.sessions.launch_only,
    unverified: [envNote],
  };
  const promptHistory = {
    value: items.prompt_history.harness_default,
    source: 'default',
    expressible: false,
    reason: items.prompt_history.reason,
    unverified: [envNote],
  };

  return {
    items: { retention_days: retention, sessions, prompt_history: promptHistory },
    harness_defaults: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.harness_default])),
    errors,
  };
}
