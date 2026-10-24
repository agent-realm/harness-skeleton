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
      facets: { variables: [descriptor.binding.env_set], escapes: escapesHere(descriptor).map((e) => e.kind) },
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
  ];
}

export function describeHarness(descriptor) {
  return {
    harness: descriptor.harness,
    name: descriptor.name,
    versions: descriptor.versions,
    binding: {
      env_set: [descriptor.binding.env_set],
      env_unset: descriptor.binding.env_unset,
      default_folder: descriptor.binding.default_folder,
      escapes: escapesHere(descriptor),
    },
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
    const bindingVar = descriptor.binding.env_set;
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
  let defaultFolder = expand(descriptor.binding.default_folder, home);
  try {
    defaultFolder = fs.realpathSync.native(defaultFolder);
  } catch {
    // no default folder on this machine
  }
  return escapesHere(descriptor).map((e) => {
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
    });
  }
  return out;
}
