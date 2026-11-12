// What every driver does the same way, given its harness descriptor: describe, detect, and the
// frame of observe --state. A driver adds only what its harness does differently.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HsError, bounded } from './protocol.js';
import { managedItems } from './deliver.js';
import { harnessPath } from './harness-path.js';
import { hostId } from './host.js';
import { inventory } from './inventory.js';
import { parseVersion, rangeStatus } from './version.js';
import { makeScratch, scratchEnv, assertScratch } from './scratch-env.js';

// The binding (§8): one variable naming the data folder (CLAUDE_CONFIG_DIR, CODEX_HOME), or several,
// each naming a directory inside it (OpenCode's four XDG roots).
export function bindingVars(descriptor) {
  const s = descriptor.binding.env_set;
  return typeof s === 'string' ? [s] : Object.keys(s);
}

export function bindingEnv(descriptor, folder) {
  const s = descriptor.binding.env_set;
  return typeof s === 'string' ? { [s]: folder } : Object.fromEntries(Object.entries(s).map(([v, sub]) => [v, path.join(folder, sub)]));
}

// What a launch cannot close, by name (§8): the escapes a descriptor marks as known limits.
export function knownLimits(descriptor) {
  return escapesHere(descriptor).filter((e) => e.known_limit).map((e) => ({ path: e.path, kind: e.kind, note: e.note, source: e.source }));
}

export function escapesHere(descriptor, platform = process.platform) {
  return descriptor.binding.escapes.filter((e) => !e.platforms || e.platforms.includes(platform));
}

export function capabilities(descriptor) {
  const dropped = Object.entries(descriptor.state)
    .filter(([, v]) => !v.expressible)
    .map(([k, v]) => `${k}: ${v.reason} [${v.source}]`);
  return [
    {
      capability: 'binding',
      mechanism: 'native',
      fidelity: 'exact',
      readiness: 'untested',
      facets: { variables: bindingVars(descriptor), escapes: escapesHere(descriptor).map((e) => e.kind) },
      dropped: [],
      evidence: null,
    },
    {
      capability: 'state',
      mechanism: 'native',
      fidelity: dropped.length ? 'lossy' : 'exact',
      readiness: 'untested',
      facets: {
        items: Object.fromEntries(Object.entries(descriptor.state).map(([k, v]) => [k, v.expressible ? 'expressible' : 'unsupported'])),
      },
      dropped,
      evidence: null,
    },
    // Plugins (§5.7, §6): per format this adapter maps, its versions, route and the components the
    // harness loads. Only the formats this build delivers are named.
    ...(descriptor.plugins ? [{
      capability: 'plugins',
      mechanism: [...new Set(Object.values(descriptor.plugins).map((r) => r.mechanism))].join(', '),
      fidelity: 'exact',
      readiness: Object.values(descriptor.plugins).every((r) => r.readiness === 'ready') ? 'ready' : 'untested',
      facets: { formats: Object.fromEntries(Object.entries(descriptor.plugins).map(([f, r]) => [f, {
        versions: r.versions, mechanism: r.mechanism, components: r.components, readiness: r.readiness,
        refuses: [
          ...(r.keeps_literal === false ? ['plugin_placeholder_literal: ${…} text the format keeps literal'] : []),
          ...(r.cwd === 'root' ? ['plugin_cwd_unsupported: a stdio server working directory other than the plugin root'] : []),
          ...(r.acts_on_paths?.length ? [`plugin_path_unsupported: ${r.acts_on_paths.join(', ')} in the package`] : []),
          ...(r.refuses_fields ? [`plugin_field_unsupported: ${Object.keys(r.refuses_fields).join(', ')} in ${r.manifest}, while they hold anything`] : []),
          ...(r.refuses_values ?? []).map((v) => `plugin_field_unsupported: ${v.field} naming ${v.label}`),
        ],
        ...(r.namespace ? { harness_specific: [r.namespace.name] } : {}),
      }])),
      // Formats the harness reads that this adapter refuses, with the reason.
      ...(descriptor.plugin_formats_refused ? { refused_formats: Object.fromEntries(Object.entries(descriptor.plugin_formats_refused).map(([f, r]) => [f, r.reason])) } : {}) },
      // What a route cannot keep is refused by validate, never dropped from a package it accepts.
      dropped: [],
      evidence: null,
    }] : []),
  ];
}

export function describeHarness(descriptor) {
  return {
    harness: descriptor.harness,
    name: descriptor.name,
    versions: descriptor.versions,
    binding: {
      env_set: bindingVars(descriptor),
      ...(typeof descriptor.binding.env_set === 'string' ? {} : { folder_layout: descriptor.binding.env_set }),
      env_unset: descriptor.binding.env_unset,
      default_folder: descriptor.binding.default_folder,
      escapes: escapesHere(descriptor),
    },
    known_limits: knownLimits(descriptor),
    // What a launch contacts on the network, where the descriptor says.
    ...(descriptor.launch?.network ? { launch_network: descriptor.launch.network } : {}),
    normalization_allowlist: [],
    path_classes: descriptor.paths.filter((r) => !r.descend),
    capabilities: capabilities(descriptor),
  };
}

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return null;
}

// Runs `<binary> --version` only under a scratch HOME, XDG roots, TMPDIR and binding variable.
export function detect(descriptor, { bin, root } = {}) {
  const exe = bin ?? findOnPath(descriptor.binary);
  if (!exe) return { present: false, binary: null, version: null, range: 'unknown' };
  const scratch = makeScratch('hs-detect-', root);
  try {
    // A binding of the XDG roots is already scratch; a single binding variable gets its own.
    const bindingVar = typeof descriptor.binding.env_set === 'string' ? descriptor.binding.env_set : undefined;
    const env = scratchEnv(scratch, { bindingVar });
    assertScratch(env, scratch, bindingVar);
    let out;
    try {
      out = execFileSync(exe, descriptor.version_args, { env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new HsError('probe_failed', `${exe} ${descriptor.version_args.join(' ')} failed: ${e.message.split('\n')[0]}`, [exe]);
    }
    const v = parseVersion(out);
    const version = v ? v.join('.') : null;
    return { present: true, binary: exe, version, range: rangeStatus(version, descriptor.versions) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function statEntry(abs, shown) {
  try {
    const st = fs.lstatSync(abs);
    return { path: shown, kind: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file', bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

function expand(p, home) {
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

// The escapes, and for one that applies only beside the default folder, whether it applies
// here and what is there. Stat only: an escape's content is never read.
export function observedEscapes(descriptor, folder, home) {
  let defaultFolder = descriptor.binding.default_folder ? expand(descriptor.binding.default_folder, home) : null;
  try {
    if (defaultFolder) defaultFolder = fs.realpathSync.native(defaultFolder);
  } catch {
    // no default folder on this machine
  }
  return escapesHere(descriptor).map((e) => {
    // An escape that applies wherever its path exists, whatever the folder: reported with what is
    // there, so a caller sees it (a known limit the launch cannot close).
    if (e.when === 'present') {
      const entry = statEntry(expand(e.path.replace(/\/$/, ''), home), e.path);
      return { ...e, applies: entry !== null, present: entry ? [entry] : [] };
    }
    if (e.when !== 'default-folder') return e;
    if (folder !== defaultFolder) return { ...e, applies: false };
    const present = [];
    for (const p of [e.path, ...(e.siblings ?? [])]) {
      const abs = expand(p, home);
      if (!abs.endsWith('*')) {
        const entry = statEntry(abs, p);
        if (entry) present.push(entry);
        continue;
      }
      const prefix = path.basename(abs).slice(0, -1);
      let names = [];
      try {
        names = fs.readdirSync(path.dirname(abs)).filter((n) => n.startsWith(prefix)).sort();
      } catch {
        // not listable
      }
      for (const n of names) {
        const entry = statEntry(path.join(path.dirname(abs), n), path.join(path.dirname(p), n));
        if (entry) present.push(entry);
      }
    }
    return { ...e, applies: true, present };
  });
}

// A working directory for --cwd: absolute, real, a directory.
function realDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new HsError('bad_request', 'cwd must be an absolute path');
  try {
    const real = fs.realpathSync.native(dir);
    if (fs.statSync(real).isDirectory()) return real;
  } catch {
    // fall through
  }
  throw new HsError('bad_request', `cwd ${dir} is not a directory`);
}

// observe (§7.1): the managed items with their drift and the unmanaged entries by address,
// from the ledger; with --state, also the inventory, the escapes and the [state] values in
// effect. A driver that delivers nothing yet answers --state only.
export function observe(descriptor, stateInEffect, { harness_path: given, state, cwd }, opts = {}, driver = {}) {
  if (state !== true && !driver.unmanaged) {
    throw new HsError('not_implemented', `observe without --state needs delivery, which this build does not have for ${descriptor.name}; it answers observe --state`);
  }
  const folder = harnessPath(given);
  const home = opts.home ?? os.homedir();
  const { host, source: hostSource } = hostId(opts.host);
  const out = { store: { host, harness: descriptor.harness, harness_path: folder }, host_source: hostSource };
  if (driver.unmanaged) {
    out.managed = managedItems(folder, descriptor);
    out.unmanaged = bounded(driver.unmanaged(folder, out.managed, home));
  }
  if (cwd !== undefined && state !== true) throw new HsError('bad_request', '--cwd goes with --state: it reads the layers a launch there adds');
  if (state === true) {
    const s = stateInEffect(folder, descriptor, { ...opts.state, home, ...(cwd !== undefined ? { cwd: realDir(cwd) } : {}) });
    Object.assign(out, {
      inventory: inventory(folder, descriptor.paths),
      escapes: [...observedEscapes(descriptor, folder, home), ...(s.escapes ?? [])],
      state: s.items,
      harness_defaults: s.harness_defaults,
      errors: s.errors,
      // A driver's own facts in effect (pi's project trust), where it reports any.
      ...(s.extra ?? {}),
    });
  }
  return out;
}
