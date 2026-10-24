// The state inventory (design note v0.2 §9.2): every path in a data folder, by path class,
// from a harness descriptor's rules. It only stats. No file content is read, so a
// `credentials` path is seen by name, size and mtime alone, and symlinks are never followed.

import fs from 'node:fs';
import path from 'node:path';
import { bounded } from './protocol.js';

export const CLASSES = Object.freeze(['config', 'sessions', 'history', 'credentials', 'cache', 'runtime', 'logs', 'skeleton']);

// Paths listed one by one under a rule when it has no more entries than this; above it the
// rule reports totals only, so a folder with ten thousand transcripts stays bounded.
const LISTED_PER_RULE = 20;

function segmentRegex(segment) {
  const escaped = segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export function compileRules(rules) {
  return rules.map((rule) => ({ ...rule, segments: rule.pattern.split('/').map(segmentRegex) }));
}

// The class of one path relative to the data folder, by the same rules and order as the
// walk: a `descend` rule passes to the next segment, a class rule covers its whole subtree.
// Every segment before the last is a directory; `isDir` says whether the last one is, since
// a rule may be for directories only (`projects/*/*`).
export function classify(rel, rules, { isDir: lastIsDir = false } = {}) {
  const compiled = compileRules(rules);
  const segments = rel.split(path.sep);
  for (let n = 1; n <= segments.length; n++) {
    const prefix = segments.slice(0, n);
    const isDir = n < segments.length || lastIsDir;
    const rule = compiled.find((r) => matches(r, prefix, isDir));
    if (!rule) return 'unknown';
    if (rule.descend) {
      if (isDir) continue;
      return 'unknown';
    }
    return rule.class;
  }
  return 'unknown';
}

function matches(rule, segments, isDir) {
  if (rule.segments.length !== segments.length) return false;
  if (rule.kind === 'dir' && !isDir) return false;
  if (rule.kind === 'file' && isDir) return false;
  return rule.segments.every((re, i) => re.test(segments[i]));
}

// Totals for one entry: a file is itself; a directory is its whole subtree, by lstat.
function measure(abs, st) {
  if (!st.isDirectory()) return { bytes: st.size, files: 1, newest: st.mtimeMs };
  const total = { bytes: 0, files: 0, newest: st.mtimeMs };
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // unreadable directory: counted as empty, never an error in an inventory
    }
    for (const name of names) {
      const child = path.join(dir, name);
      let cst;
      try {
        cst = fs.lstatSync(child);
      } catch {
        continue;
      }
      total.newest = Math.max(total.newest, cst.mtimeMs);
      if (cst.isDirectory()) stack.push(child);
      else {
        total.bytes += cst.size;
        total.files += 1;
      }
    }
  }
  return total;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

export function inventory(harnessPath, rules) {
  const compiled = compileRules(rules);
  const rows = new Map(); // rule pattern -> row
  const unknown = [];

  const visit = (rel) => {
    const abs = path.join(harnessPath, rel);
    let names;
    try {
      names = fs.readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = path.join(harnessPath, childRel);
      let st;
      try {
        st = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      const isDir = st.isDirectory();
      const segments = childRel.split('/');
      const rule = compiled.find((r) => matches(r, segments, isDir));
      if (rule?.descend && isDir) {
        visit(childRel);
        continue;
      }
      const m = measure(childAbs, st);
      const entry = {
        path: childRel,
        kind: st.isSymbolicLink() ? 'symlink' : isDir ? 'dir' : 'file',
        bytes: m.bytes,
        files: m.files,
        mtime: iso(m.newest),
      };
      if (!rule || rule.descend) {
        unknown.push(entry);
        continue;
      }
      let row = rows.get(rule.pattern);
      if (!row) {
        row = {
          pattern: rule.pattern,
          class: rule.class,
          ...(rule.mixed ? { mixed: rule.mixed } : {}),
          ...(rule.note ? { note: rule.note } : {}),
          entries: 0, files: 0, bytes: 0, newest: 0, paths: [],
        };
        rows.set(rule.pattern, row);
      }
      row.entries += 1;
      row.files += m.files;
      row.bytes += m.bytes;
      row.newest = Math.max(row.newest, m.newest);
      row.paths.push(entry);
    }
  };
  visit('');

  const classes = Object.fromEntries(CLASSES.map((c) => [c, []]));
  for (const row of rows.values()) {
    const out = { ...row, newest: iso(row.newest) };
    if (row.entries > LISTED_PER_RULE) delete out.paths;
    classes[row.class].push(out);
  }
  return { classes, unknown: bounded(unknown) };
}
