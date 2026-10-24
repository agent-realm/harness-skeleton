// Persisting a process under materialize: bind by copy (design note v0.2 §7.5, 2026-10-23). A
// persisted status line, MCP server or hook runs at every start, with no launch receipt, so what it
// runs must be bound by the plan's. The files it names in its layer are one unit: the top-level
// directory of its layer that holds every one of them. The plan copies that directory into a tree
// it owns, `<root>/<item>/` (owner-only, digest-bound in the ledger like a skill), and the
// persisted command names the copies. Only that tree is bound: what it loads at run time from
// elsewhere (an interpreter, its imports, a config it reads) is not, so persisting a unit needs the
// spec's `self_contained = true`, the author's word that the unit holds all of it. A process that
// names no layer path is persisted by its text, which the receipt binds; a file it names by an
// absolute path is not.

import fs from 'node:fs';
import path from 'node:path';
import { HsError } from './protocol.js';
import { layerPath, refuseInterpolation, shellQuote } from './process.js';

export const BOUND_NOTE = (tree) => `binds ${tree}, a copy of the process's directory in its layer; only that tree is bound: what it loads at run time from elsewhere (an interpreter, its imports, a config it reads) is not`;
export const TEXT_NOTE = 'binds the command text only';
export const OUTSIDE_NOTE = (p) => `the file at ${p} is not bound; only the command text is`;

// What a plan persists for one process: the command, and the tree to copy (or null).
// `dir` is the item's layer directory, `folder` the data folder, `root` the tree root (hs-run).
export function persistedProcess(item, run, dir, folder, root) {
  if (run.shell !== undefined) {
    refuseInterpolation(item.id, run.shell);
    return { command: run.shell, argv: ['/bin/sh', '-c', run.shell], tree: null, notes: [TEXT_NOTE, 'a shell string: any path in it is bound by its text only'] };
  }
  const parts = [run.exec, ...(run.args ?? [])];
  const resolved = parts.map((p) => layerPath(p, dir, item.id));
  // layerPath gives a path in the layer absolutely, and anything else back as written.
  const inLayer = resolved.map((abs, i) => (abs !== parts[i] ? abs : null));
  const rels = inLayer.filter((x) => x !== null).map((abs) => path.relative(dir, abs));
  if (!rels.length) {
    const outside = parts.filter((p) => typeof p === 'string' && path.isAbsolute(p));
    const command = shellQuote(parts);
    refuseInterpolation(item.id, command);
    return { command, argv: parts, tree: null, notes: [TEXT_NOTE, ...outside.map(OUTSIDE_NOTE)] };
  }
  const tops = [...new Set(rels.map((r) => r.split(path.sep)[0]))];
  if (tops.length > 1 || tops[0] === '' || tops[0] === '.') {
    throw new HsError('item_unsupported', `${item.id}: a persisted process binds one directory of its layer, and this one names files in ${tops.join(', ')}; put what it runs in one directory`, [item.id]);
  }
  const unit = path.join(dir, tops[0]);
  if (!fs.lstatSync(unit).isDirectory()) {
    throw new HsError('item_unsupported', `${item.id}: a persisted process binds a directory of its layer, and ${tops[0]} is a file at the layer's root; put it in a directory`, [item.id]);
  }
  if (run.self_contained !== true) {
    throw new HsError('item_unsupported', `${item.id}: persisting it binds only ${tops[0]}/, copied into the folder; what it loads at run time from elsewhere would not be bound. Set self_contained = true on the process if ${tops[0]}/ holds everything it loads, or deliver it at launch`, [item.id]);
  }
  const name = item.id;
  const tree = `${root}/${name}`;
  const copy = path.join(folder, root, name);
  const argv = resolved.map((abs, i) => (inLayer[i] === null ? parts[i] : path.join(copy, path.relative(unit, abs))));
  const command = shellQuote(argv);
  refuseInterpolation(item.id, command);
  for (const a of argv) refuseInterpolation(item.id, a);
  return { command, argv, tree: { address: tree, source: unit }, notes: [BOUND_NOTE(tree)] };
}
