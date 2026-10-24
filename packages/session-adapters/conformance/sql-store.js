// Database fixtures as text. A case keeps, under `store-sql/`, for each database file `<rel>`:
//   <rel>.schema.sql   the DDL (and any PRAGMA, such as journal_mode=WAL)
//   <rel>.ops.jsonl    one statement per line: {"sql": "...", "params": [...]}; a blob parameter is
//                      written {"$b64": "..."}
// buildStore() turns them into real SQLite files under a store directory, so no binary file enters
// the repository and every row is reviewable. Statements run in file order; an UPDATE or DELETE
// is how a fixture shows a harness editing in place.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MiniEngine } from './engine.js';
import { filesOf, storeOf, tmpStore, project, fullReplay, copyTree } from './runner.js';

function param(v) {
  if (v && typeof v === 'object' && typeof v.$b64 === 'string') return Buffer.from(v.$b64, 'base64');
  return v;
}

// The database files a case defines, with their schema and statements.
export function sqlFilesOf(caseDir) {
  const root = path.join(caseDir, 'store-sql');
  if (!fs.existsSync(root)) return [];
  return filesOf(root)
    .filter((f) => f.endsWith('.schema.sql'))
    .map((f) => {
      const rel = f.slice(0, -'.schema.sql'.length);
      const opsFile = path.join(root, `${rel}.ops.jsonl`);
      const ops = fs.existsSync(opsFile)
        ? fs.readFileSync(opsFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
        : [];
      return { rel, schema: fs.readFileSync(path.join(root, f), 'utf8'), ops };
    });
}

// Write one database from its schema and its first `upto` statements. The file is built aside and
// renamed into place, as a harness's own rewrite would be.
export function buildDb(dst, db, upto = db.ops.length) {
  const file = path.join(dst, db.rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.building`;
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  const conn = new DatabaseSync(tmp);
  try {
    // A throwaway test database: no fsync per statement, one transaction for all of it. Built
    // statement by statement in autocommit, a case took minutes on a VM's disk.
    conn.exec('PRAGMA synchronous = OFF');
    conn.exec(db.schema);
    conn.exec('BEGIN');
    for (const op of db.ops.slice(0, upto)) conn.prepare(op.sql).run(...(op.params ?? []).map(param));
    conn.exec('COMMIT');
  } finally {
    conn.close();
  }
  for (const f of [`${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  fs.renameSync(tmp, file);
}

// The harness_path a case binds: `binding.json` = {"harness_path": "<path inside the store>"} for a
// harness bound to a file (every OpenCode store), else the store folder itself.
export function caseHarnessPath(caseDir, storeDir) {
  const f = path.join(caseDir, 'binding.json');
  if (!fs.existsSync(f)) return storeDir;
  return path.join(storeDir, JSON.parse(fs.readFileSync(f, 'utf8')).harness_path);
}

// A whole case store: the plain files under `store/` (if any), plus every database built whole.
export function prepareStore(caseDir, dst) {
  if (fs.existsSync(path.join(caseDir, 'store'))) copyTree(path.join(caseDir, 'store'), dst);
  for (const db of sqlFilesOf(caseDir)) buildDb(dst, db);
}

// The growth check for database stores: every database is rebuilt with the first fraction of its
// statements, in `steps` passes, and the final incremental view must equal a full replay; a
// further pass must read `unchanged` everywhere. Plain files under `store/` are copied whole first.
export function sqlGrowthCheck(adapter, caseDir, { steps = 12 } = {}) {
  const dir = tmpStore();
  try {
    if (fs.existsSync(path.join(caseDir, 'store'))) copyTree(path.join(caseDir, 'store'), dir);
    const dbs = sqlFilesOf(caseDir);
    const e = new MiniEngine(adapter, storeOf(adapter, caseHarnessPath(caseDir, dir)));
    for (let t = 1; t <= steps; t++) {
      for (const db of dbs) buildDb(dir, db, t === steps ? db.ops.length : Math.floor((db.ops.length * t) / steps));
      e.pass();
    }
    const whole = fullReplay(adapter, caseHarnessPath(caseDir, dir));
    const incremental = project(e.views());
    const full = project(whole.views());
    e.pass();
    const notUnchanged = e.log.filter((l) => l.continuity !== 'unchanged');
    return { equal: JSON.stringify(incremental) === JSON.stringify(full), incremental, full, notUnchanged };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
