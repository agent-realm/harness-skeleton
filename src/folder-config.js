// Reading a data folder's own settings file safely, for every driver (design note v0.2 §9.2).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify } from './inventory.js';

// Credential stores by file name, across the surveyed harnesses (design note §9.1, the
// `credentials` row). A settings link that resolves to one is never opened, wherever it points.
const CREDENTIAL_NAMES = new Set(['.credentials.json', 'auth.json', 'mcp-auth.json']);

function expandHome(p, home) {
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Why a settings link's target must not be opened, or null.
export function linkRefusal(target, harnessPath, descriptor, home) {
  if (CREDENTIAL_NAMES.has(path.basename(target))) return `its target ${target} is a credential store by name`;
  for (const e of descriptor.binding.escapes) {
    if (e.class !== 'credentials' || !e.path.startsWith('~/')) continue;
    const dir = expandHome(e.path.replace(/\/$/, ''), home);
    if (target === dir || inside(target, dir)) return `its target ${target} is inside the credential store ${e.path}`;
  }
  if (inside(target, harnessPath)) {
    let isDir = false;
    try {
      isDir = fs.statSync(target).isDirectory();
    } catch {
      // gone: classed as a file, and the open reports it
    }
    const cls = classify(path.relative(harnessPath, target), descriptor.paths, { isDir });
    if (cls === 'credentials' || cls === 'sessions') return `its target ${target} is a ${cls} path of the data folder`;
  }
  return null;
}

// A settings file of the data folder (Claude Code settings.json, Codex config.toml). A harness
// reads through a symlink, and dotfiles setups point it outside the folder, so a link is
// followed and its target reported in `from`. It is not opened when the target is a
// credential store or a transcript (AGENTS.md rule 4; sessions leave only through
// sessions.*), and it is read only when it is a regular file. `read` parses it.
export function readFolderFile(harnessPath, rel, descriptor, read, home = os.homedir()) {
  const file = path.join(harnessPath, rel);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { present: false, file };
    return { present: true, file, error: `unreadable: ${e.code}` };
  }
  if (!st.isSymbolicLink()) return { file, ...read(file, { noFollow: true }) };
  let target;
  try {
    target = fs.realpathSync.native(file);
  } catch (e) {
    return { present: true, file, via_symlink: true, refused: `${rel} is a symlink that does not resolve (${e.code}); not read` };
  }
  const refusal = linkRefusal(target, harnessPath, descriptor, home);
  if (refusal) return { present: true, file: target, via_symlink: true, refused: `${rel} is a symlink; ${refusal}; not read` };
  return { file: target, via_symlink: true, ...read(target, { noFollow: true }) };
}

