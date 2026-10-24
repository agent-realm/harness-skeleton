// Read-only SQLite for the adapters whose harness store is a database (Goose, OpenCode, agy,
// Cursor, cursor-agent, Zed, Devin). Ported from memhouse's SQLite reader, whose
// measurements decide the open mode:
// - A WAL-mode store opened read-only CREATES `<db>-wal` and `<db>-shm` when they are absent, and
//   they stay after close (node:sqlite, Node 24.17). Without a `-wal`, the main file is the whole
//   database, so `immutable=1` reads it and creates nothing. With a `-wal`, a plain read-only open
//   is the only correct read: the WAL holds pages the main file lacks.
// - `immutable=1` turns locking off, so it is never used on a rollback-journal store (Zed's
//   threads.db): an immutable read during a save is torn (3,525 malformed reads in 10,625 against
//   a live writer, none with the plain open, which in rollback mode creates no file).
// The header's byte 18 says which: 1 rollback, 2 WAL.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SessionsError } from './errors.js';
import { isRealFile, makeUnit } from './sources.js';
import { jcs } from './jcs.js';

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

// SQLite result codes (primary) that the read errors of sessions v1 §2 name.
const BUSY = new Set([5, 6]); // SQLITE_BUSY, SQLITE_LOCKED
const DAMAGED = new Set([11, 26]); // SQLITE_CORRUPT, SQLITE_NOTADB

// Map a node:sqlite error to the contract's retryable codes; anything else is rethrown as is.
export function sqliteError(e, what) {
  const code = typeof e?.errcode === 'number' ? e.errcode & 0xff : null;
  if (BUSY.has(code)) return new SessionsError('busy', `${what}: ${e.errstr ?? e.message}`, [what]);
  if (DAMAGED.has(code)) return new SessionsError('damaged', `${what}: ${e.errstr ?? e.message}`, [what]);
  return e;
}

function walHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const b = Buffer.alloc(20);
    return fs.readSync(fd, b, 0, 20, 0) === 20 && b.toString('latin1', 0, 15) === 'SQLite format 3' && b[18] === 2;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Open `rel` below `root` read-only, never through a symlink (sources.js isRealFile), creating
// nothing beside it. `sourceKey` names it in errors.
// - A WAL store with no `-wal`: `immutable=1` (the main file is the whole database).
// - A WAL store with a `-wal` and its `-shm`: a plain read-only open, which creates nothing.
// - A WAL store with a `-wal` but no `-shm` (crash leftovers, a store copied without it): refused
//   as the retryable `busy`. A read-only open would create `<db>-shm` beside it, `immutable=1`
//   would ignore the WAL's pages, and a private copy would duplicate the whole file, credential
//   tables included (OpenCode, harness-skeleton §9.1), outside the harness's own folder. The
//   harness's next open recreates the `-shm`, and the read succeeds then.
// - A rollback-journal store: a plain read-only open, which creates nothing.
export function openReadOnly(root, rel, sourceKey = rel) {
  if (!isRealFile(root, rel)) throw new SessionsError('source_unknown', `source ${sourceKey} is not there`, [sourceKey]);
  const file = path.join(root, rel);
  try {
    const wal = walHeader(file);
    const hasWal = fs.existsSync(`${file}-wal`);
    let db;
    if (wal && !hasWal) db = new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    else if (wal && !fs.existsSync(`${file}-shm`)) {
      throw new SessionsError('busy', `${sourceKey}: a WAL with no -shm; reading it would create one beside the store`, [sourceKey]);
    } else db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    return db;
  } catch (e) {
    throw sqliteError(e, sourceKey);
  }
}

// Run `fn(db)` inside one read transaction, so every statement sees one committed state, and map
// lock and corruption errors to `busy` / `damaged`.
export function withRead(db, sourceKey, fn) {
  try {
    db.exec('BEGIN');
    try {
      return fn(db);
    } finally {
      db.exec('COMMIT');
    }
  } catch (e) {
    throw sqliteError(e, sourceKey);
  }
}

// True when the table exists. A missing table is the one schema difference that reads as empty.
export function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
}

// A row as `row-json` (sessions-model §3): its columns as a canonical JSON object, blobs in base64.
export function rowJson(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? Number(v) : v;
  return out;
}

// A column's value as text, whether SQLite stored TEXT or BLOB (node:sqlite gives a Uint8Array,
// whose toString() is a comma-joined byte list, not UTF-8).
export function textOf(v) {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
  return v == null ? null : String(v);
}

// The generic `read` of a delta source (sessions v1 §2, rule 4): the source's current rows,
// diffed against `known`. `rows` is the list of `{unit_key, row}` the adapter selected; `redact`
// (optional) maps a row-json object to `{row, redacted}`.
// - No `from` and no `known`: `reset` with every unit (rule 1).
// - Otherwise the new and changed rows, and `gone` for keys no longer there: `delta`, or
//   `unchanged` when nothing moved.
// The position is a hint only (`{count}`); `known` decides.
export function readDelta(sourceKey, rows, from, known, { redact } = {}) {
  const units = [];
  const current = new Set();
  for (const { unit_key: key, row } of rows) {
    current.add(key);
    const r = redact ? redact(rowJson(row)) : { row: rowJson(row), redacted: false };
    const u = makeUnit(sourceKey, key, Buffer.from(jcs(r.row), 'utf8'), r.redacted);
    u.enc = 'row-json';
    if (!known || known[key] !== u.sha256) units.push(u);
  }
  const position = { count: current.size };
  if (!from && !known) return { continuity: 'reset', units, gone: [], position, held_back: [] };
  const gone = known ? Object.keys(known).filter((k) => !current.has(k)).sort() : [];
  return { continuity: units.length || gone.length ? 'delta' : 'unchanged', units, gone, position, held_back: [] };
}

// A snapshot of several rows read together (`rows-json`, sessions-model §3): one unit holding
// `{<table>: [row-json, …]}`, compared by sha with `from`.
export function readRowsSnapshot(sourceKey, tables, from, { redact } = {}) {
  const body = {};
  for (const [t, rows] of Object.entries(tables)) body[t] = rows.map(rowJson);
  const r = redact ? redact(body) : { row: body, redacted: false };
  const u = makeUnit(sourceKey, sourceKey, Buffer.from(jcs(r.row), 'utf8'), r.redacted);
  u.enc = 'rows-json';
  if (from && from.sha256 === u.sha256) return { continuity: 'unchanged', units: [], gone: [], position: from, held_back: [] };
  return { continuity: from ? 'snapshot' : 'reset', units: [u], gone: [], position: { sha256: u.sha256 }, held_back: [] };
}
