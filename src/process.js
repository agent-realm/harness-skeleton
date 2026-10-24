// Processes (design note §5.4): what a spec runs, an MCP server, a hook or the status line, as
// `{exec, args, env, env_refs}` or `{shell}`. Shared by the drivers: the checks `validate` makes,
// how a path in the item's layer is given, and the launch risks a process carries (§7.5).

import fs from 'node:fs';
import path from 'node:path';
import { HsError } from './protocol.js';
import { fetchedPackages } from './launchers.js';

export { processProblems } from '@agent-realm/skeleton-spec/process';

// A string the launch hands a harness that expands `${…}` in it (Claude Code in --mcp-config and
// its plugin hooks, Codex in hook commands): refused, since the harness could run another path or
// command than the receipt bound (§5.3). Spec strings are checked by `validate`; this checks what
// the launch builds from them, layer directories and hs's own paths included.
export function refuseInterpolation(id, ...strings) {
  for (const s of strings) {
    if (typeof s === 'string' && s.includes('${')) throw new HsError('interpolation_refused', `${id}: what the launch would hand the harness holds \${…} (${s}), which the harness may expand, so it could run what the receipt did not bind; move the layer or hs to a path without it`, [id]);
  }
}

// A path in the item's layer, given absolutely; anything else is passed as written. Walked one
// component at a time, as the spec digest walks it (§5.4): a path through a symlink would run what
// the link points at, which the digest binds only by the link's target string, so it is refused.
// `.` is the layer's directory.
export function layerPath(s, dir, id) {
  if (typeof s !== 'string' || path.isAbsolute(s)) return s;
  const abs = path.resolve(dir, s);
  const rel = path.relative(dir, abs);
  if (rel === '') {
    refuseInterpolation(id, dir);
    return dir;
  }
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return s;
  let cur = dir;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return s;
    }
    if (st.isSymbolicLink()) {
      throw new HsError('write_refused', `${id}: ${s} goes through a symlink in its layer (${path.relative(dir, cur)}); what it runs would not be bound, so it is refused. Name the target by its absolute path, bound by its text`, [id]);
    }
  }
  refuseInterpolation(id, abs);
  return abs;
}

// The launch risks a process carries (§7.5): `runs-code`, bound by the files it names in its layer
// (the spec digest's `processes`) or else by its text; and `fetches-code` when a package launcher
// starts it, listing every package with its own pinning, never pinned when the parse is ambiguous.
export function processRisks(item, proc, resolved) {
  const bound = resolved.processes.find((p) => p.id === item.id);
  const risks = [{
    item: item.id, layer: item.layer, risk: 'runs-code',
    ...(bound ? { files: bound.files.map((f) => ({ path: f.path, sha256: f.sha256 })) } : { text: proc.shell ?? [proc.exec, ...(proc.args ?? [])].join(' ') }),
  }];
  const fetched = proc.shell === undefined ? fetchedPackages(proc.exec, proc.args ?? []) : null;
  if (fetched) {
    risks.push({
      item: item.id, layer: item.layer, risk: 'fetches-code', packages: fetched.packages,
      pinned: !fetched.ambiguous && fetched.packages.every((p) => p.pinned), ...(fetched.ambiguous ? { ambiguous: true } : {}),
    });
  }
  return risks;
}

// One shell word per argument, single-quoted, for a harness slot that takes a command string.
export function shellQuote(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}
