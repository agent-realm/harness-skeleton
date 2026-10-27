// OpenCode: one SQLite database (WAL) per harness store. Every store is bound to its database
// FILE, which is its `harness_path`: the default `opencode.db` in the data folder
// (`$XDG_DATA_HOME/opencode`, default `~/.local/share/opencode`), each `opencode-<channel>.db`, and
// an
// `OPENCODE_DB` (sessions-model §1). There is no folder store; the data folder is
// only where a store's spilled `tool-output/` lives. sessions v1 four operations over
// sessions-model v1.1 records.
//
// Ported from memhouse's v4 normaliser (its opencode module: the schema
// tolerance, the per-session change key, the v1 and v2 folds, the held-back rule, the live revert,
// the compaction, edit and rewind evidence, the URL and provider-error rules, the id time
// decoding). New here:
// - records in the sessions-model shape: a `tool` part is `<prt>:call` + `<prt>:result`, a file
//   part an `attachment`, usage its own record, link and lifecycle records with their own keys;
// - the step, patch, snapshot, retry, agent and compaction parts are `notice` parts (sessions-model
//   §2.3: never dropped), where the normaliser left them out;
// - `read` is per source and redacts (URL cutting, provider-error payloads); a spilled output is a
//   side source read by `read`, so derive does no I/O; a row whose JSON does not parse is
//   `damaged`, a lock past the wait `busy`;
// - derive keeps every current unit in its state and refolds the session, so any split of the
//   units gives the same records; the streaming assistant the normaliser cut is returned in `held`,
//   and the messages after it are written (they are complete; `order` is native, so nothing moves).
//
// Sources (sessions §1), in the store's own database file:
// - `table:session`: this session's row, side, snapshot (rows-json);
// - `table:message`: its v1 `message` and `part` rows, main, delta (`message:<id>`, `part:<id>`);
// - `table:session_message`: its v2 rows, main, delta (`session_message:<id>`);
// - `table:session_input`: its v2 prompt deliveries, side, delta (`session_input:<id>`);
// - `table:event`: its removal and revert events, side, stream, unit key = `seq`;
// - `<data folder>/tool-output/tool_<id>`, by absolute path: a spilled output a part names, side,
//   snapshot.
// Never queried: `account`, `account_state`, `control_account`, `credential`, `session_share`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionsError } from '../../errors.js';
import { isRealFile, readSnapshot, snapshotUnits, databaseSource, unknownSource, makeUnit, jsonOf } from '../../sources.js';
import { openReadOnly, withRead, rowJson, textOf, readDelta, readRowsSnapshot } from '../../sqlite.js';
import { seal, recordKey } from '../../records.js';
import { jcs, sha256 } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'opencode';
const STATE_VER = 1;
const DEFAULT_DB = 'opencode.db';
const SPILL = /^tool_[0-9A-Za-z]+$/;
// Ids carry the low 48 bits of ms·4096 + a counter: ms modulo 2^36 (spec §9).
const MS_MOD = 2 ** 36;
const ID_SLACK_MS = 60000;
// The events that change a session's records without a row of it changing: removals (an edit)
// and v2 reverts, as ranges on `type` ('/' follows '.'). One range per query lets
// event_aggregate_type_seq_idx find them; OR-ed together, SQLite reads every event of the session.
const EVENT_RANGES = ['message.removed.', 'message.part.removed.', 'session.next.revert.']
  .map((t) => `(type >= '${t}' AND type < '${t.slice(0, -1)}/')`);
const TABLES = new Set(['session', 'message', 'session_message', 'session_input', 'event']);

// Columns each read selects (what derive uses), and the ones a table must have to be read at all.
// A column an older or newer schema lacks reads as NULL instead of failing the query.
const COLS = {
  session: ['id', 'parent_id', 'directory', 'title', 'version', 'time_created', 'time_archived', 'revert'],
  message: ['id', 'time_created', 'data'],
  part: ['id', 'message_id', 'time_created', 'data'],
  session_message: ['id', 'type', 'seq', 'time_created', 'data'],
  session_input: ['id', 'delivery', 'admitted_seq', 'promoted_seq'],
  event: ['id', 'seq', 'type', 'data'],
};
const NEED = {
  session: ['id'],
  message: ['id', 'session_id', 'data'],
  part: ['id', 'message_id', 'session_id', 'data'],
  session_message: ['id', 'session_id', 'type', 'data'],
  session_input: ['id', 'session_id'],
  event: ['id', 'aggregate_id', 'type', 'seq', 'data'],
};

export function describe() {
  return describeData;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => {
  const x = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(x) ? x : null;
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pad = (n) => String(Math.max(0, Math.trunc(num(n) ?? 0))).padStart(16, '0');
const utf8Len = (s) => Buffer.byteLength(s, 'utf8');
const noHeld = () => ({ session: [], message: [], usage: [], link: [], lifecycle: [] });
const baseName = (p) => String(p ?? '').split(/[\\/]/).pop();

function iso(ms) {
  const x = num(ms);
  return x !== null && x > 0 ? new Date(x).toISOString() : null;
}

// ---- the store -------------------------------------------------------------------------------

// Where a store's database and spill folder are: the store is its own database file, and its
// spill folder is the folder it sits in (the data folder). A folder is refused: an OpenCode store
// is bound to its database file, never to the folder.
function locate(harnessPath) {
  let st;
  try {
    st = fs.lstatSync(harnessPath);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    throw new SessionsError('bad_request', `an OpenCode store is bound to its database file, not a folder: ${harnessPath}`, [harnessPath]);
  }
  if (st.isFile()) {
    const root = path.dirname(harnessPath);
    return { root, rel: path.basename(harnessPath), prefix: '', spillKey: (n) => path.join(root, 'tool-output', n) };
  }
  return null;
}

// The table a source key names in this store's database, or the spill it names, or null.
function parseKey(loc, sk) {
  const t = `${loc.prefix}table:`;
  if (typeof sk === 'string' && sk.startsWith(t) && TABLES.has(sk.slice(t.length))) return { table: sk.slice(t.length) };
  const name = baseName(sk);
  if (SPILL.test(name) && sk === loc.spillKey(name)) return { spill: name };
  return null;
}

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)));
}
function schemaOf(db) {
  const out = {};
  for (const t of Object.keys(NEED)) out[t] = columnsOf(db, t);
  return out;
}
const usable = (sc, t) => NEED[t].every((c) => sc[t].has(c));
const pick = (cols, names, alias = '') => names.map((c) => (cols.has(c) ? `${alias}${c}` : `NULL AS ${c}`)).join(', ');

// A stored JSON object (a row's data, an event's data, session.revert): null when empty; a value
// that does not parse is a damaged read (sessions v1 §2), never read as empty.
function strictJson(v, what, sk) {
  if (v == null) return null;
  const t = textOf(v).trim();
  if (t === '' || t === 'null') return null;
  let d;
  try {
    d = JSON.parse(t);
  } catch {
    d = undefined;
  }
  if (d == null || typeof d !== 'object') throw new SessionsError('damaged', `${sk}: unreadable ${what}`, [sk]);
  return d;
}

// The per-session change key, as SQL columns of the list query (what an older schema lacks: NULL).
function keyColumns(sc) {
  const agg = (t, fk, fn, col, as) => (sc[t].has(fk) && sc[t].has(col) ? `(SELECT ${fn}(${col}) FROM ${t} WHERE ${fk} = s.id) AS ${as}` : `NULL AS ${as}`);
  return [
    agg('message', 'session_id', 'count', 'id', 'm_n'), agg('message', 'session_id', 'max', 'time_updated', 'm_tu'),
    agg('part', 'session_id', 'count', 'id', 'p_n'), agg('part', 'session_id', 'max', 'time_updated', 'p_tu'),
    agg('session_message', 'session_id', 'count', 'id', 'v_n'), agg('session_message', 'session_id', 'max', 'seq', 'v_seq'),
    agg('session_message', 'session_id', 'max', 'time_updated', 'v_tu'), agg('session_input', 'session_id', 'count', 'id', 'i_n'),
    usable(sc, 'event')
      ? `max(${EVENT_RANGES.map((r) => `coalesce((SELECT max(seq) FROM event WHERE aggregate_id = s.id AND ${r}), -1)`).join(', ')}) AS ev_seq`
      : 'NULL AS ev_seq',
  ].join(', ');
}

function sessionRows(db, sc, only) {
  const sql = `SELECT s.id, ${pick(sc.session, ['title', 'directory', 'version', 'parent_id', 'time_archived', 'revert'], 's.')}, ${keyColumns(sc)} FROM session s${only !== null ? ' WHERE s.id = ?' : ''} ORDER BY s.id`;
  return only !== null ? db.prepare(sql).all(only) : db.prepare(sql).all();
}

// The spilled outputs each session's parts name: `<sid> -> Set(tool_<id>)`. A path names a spill
// by its file name only, looked up in the store's own `tool-output/`, so a part pointing anywhere
// else (`/etc/passwd`) is never read. A row that does not parse is skipped here; its read says
// `damaged`.
function spillsOf(db, sc, only) {
  const out = new Map();
  const add = (sid, p) => {
    const n = baseName(p);
    if (!SPILL.test(n)) return;
    if (!out.has(sid)) out.set(sid, new Set());
    out.get(sid).add(n);
  };
  const parse = (v) => {
    try {
      const d = JSON.parse(textOf(v));
      return isObj(d) ? d : null;
    } catch {
      return null;
    }
  };
  const one = only !== null ? 'session_id = ? AND ' : '';
  const args = only !== null ? [only] : [];
  if (usable(sc, 'part')) {
    for (const r of db.prepare(`SELECT session_id, data FROM part WHERE ${one}data LIKE '%outputPath%'`).all(...args)) {
      const d = parse(r.data);
      const meta = d && isObj(d.state) && isObj(d.state.metadata) ? d.state.metadata : null;
      if (d && d.type === 'tool' && meta && typeof meta.outputPath === 'string') add(String(r.session_id), meta.outputPath);
    }
  }
  if (usable(sc, 'session_message')) {
    for (const r of db.prepare(`SELECT session_id, data FROM session_message WHERE ${one}data LIKE '%outputPaths%'`).all(...args)) {
      const d = parse(r.data);
      for (const c of d && Array.isArray(d.content) ? d.content : []) {
        const paths = isObj(c) && c.type === 'tool' && isObj(c.state) && Array.isArray(c.state.outputPaths) ? c.state.outputPaths : [];
        const p = paths.find((x) => SPILL.test(baseName(x)));
        if (p) add(String(r.session_id), p);
      }
    }
  }
  return out;
}

// One store's sessions (or one), with their sources, read in one transaction.
function scan(loc, only = null) {
  if (!isRealFile(loc.root, loc.rel)) return [];
  const db = openReadOnly(loc.root, loc.rel, loc.rel);
  let got;
  try {
    got = withRead(db, loc.rel, (d) => {
      const sc = schemaOf(d);
      if (!usable(sc, 'session')) return null; // no session table: not an OpenCode database
      return { sc, rows: sessionRows(d, sc, only), spills: spillsOf(d, sc, only) };
    });
  } finally {
    db.close();
  }
  if (!got) return [];
  const { sc, rows, spills } = got;
  const t = (name) => `${loc.prefix}table:${name}`;
  const rank = { main: 0, agent: 1, side: 2 };
  return rows.map((r) => {
    const sid = String(r.id);
    const sources = [];
    if (usable(sc, 'message')) sources.push({ source_key: t('message'), role: 'main', mode: 'delta', position_kind: 'time_updated+id' });
    if (usable(sc, 'session_message')) sources.push({ source_key: t('session_message'), role: 'main', mode: 'delta', position_kind: 'time_updated+id' });
    sources.push({ source_key: t('session'), role: 'side', mode: 'snapshot', position_kind: 'snapshot' });
    if (usable(sc, 'session_input')) sources.push({ source_key: t('session_input'), role: 'side', mode: 'delta', position_kind: 'pk' });
    if (usable(sc, 'event')) sources.push({ source_key: t('event'), role: 'side', mode: 'stream', position_kind: 'seq' });
    const spillStats = [];
    for (const n of [...(spills.get(sid) ?? [])].sort()) {
      const rel = `tool-output/${n}`;
      if (!isRealFile(loc.root, rel)) continue; // cleaned up: the part keeps the name only
      const st = fs.statSync(path.join(loc.root, rel));
      spillStats.push([n, st.size, Math.trunc(st.mtimeMs)]);
      sources.push({ source_key: loc.spillKey(n), role: 'side', mode: 'snapshot', position_kind: 'snapshot' });
    }
    sources.sort((a, b) => rank[a.role] - rank[b.role] || cmp(a.source_key, b.source_key));
    // The change key: counts and newest update times of the session's rows, its newest removal or
    // revert event, the session-record fields, and its spills. The session's own time_updated is
    // left out: usage updates skip it (spec §8).
    const key = [r.m_n, r.m_tu, r.p_n, r.p_tu, r.v_n, r.v_seq, r.v_tu, r.i_n, r.ev_seq].map((v) => (v == null ? null : Number(v)));
    const head = [r.title, r.directory, r.version, r.parent_id, r.time_archived == null ? null : Number(r.time_archived), r.revert == null ? null : textOf(r.revert)];
    return { session_id: sid, hint: sha256(JSON.stringify([key, head, spillStats])).slice(0, 32), sources };
  });
}

export function list(store) {
  const loc = locate(store.harness_path);
  if (!loc) return [];
  return scan(loc)
    .map((s) => ({ session_id: s.session_id, incarnation: '', updated_hint: s.hint, live: 'unknown', sources: s.sources }))
    .sort((a, b) => cmp(a.session_id, b.session_id));
}

// ---- read -------------------------------------------------------------------------------------

// The redaction marker (sessions-model §4.2): a string's UTF-8 byte length, else the length of the
// value's canonical JSON.
const marker = (v) => `<redacted len=${typeof v === 'string' ? utf8Len(v) : utf8Len(jcs(v))}>`;
const isMarker = (v) => typeof v === 'string' && /^<redacted len=\d+>$/.test(v);

// A URL that may carry a token in its path or query (a web attachment, an MCP resource): a URL
// with a host keeps its scheme and host, and the rest becomes the marker (N is the whole value's
// length); one with no host is the marker whole. A `file:` or `data:` URL, a plain path and a
// Windows drive path (`C:\…`, `C:/…`) are content, and kept.
function cutUrl(v) {
  if (typeof v !== 'string' || v === '' || isMarker(v)) return v;
  if (/^(data|file):/i.test(v) || !/^[a-z][a-z0-9+.-]*:/i.test(v) || /^[a-z]:[\\/]/i.test(v)) return v;
  let u = null;
  try {
    u = new URL(v);
  } catch {
    u = null;
  }
  if (u && u.host) {
    const kept = `${u.protocol}//${u.host}`;
    return v === kept || v === `${kept}/` ? v : `${kept}/${marker(v)}`;
  }
  return marker(v);
}

// A provider error keeps its name and message; its response headers, body and request metadata
// (the URL) are replaced. True when anything changed.
function cutError(e) {
  if (!isObj(e) || !isObj(e.data)) return false;
  let changed = false;
  for (const k of ['responseHeaders', 'responseBody', 'metadata']) {
    const v = e.data[k];
    if (v === undefined || v === null || isMarker(v)) continue;
    e.data[k] = marker(v);
    changed = true;
  }
  return changed;
}

function cutField(o, k) {
  if (!isObj(o) || typeof o[k] !== 'string') return false;
  const v = cutUrl(o[k]);
  if (v === o[k]) return false;
  o[k] = v;
  return true;
}

function cutAttachments(state) {
  let changed = false;
  // `url`, and `uri`, which attachment() falls back to when there is no `url`.
  for (const a of isObj(state) && Array.isArray(state.attachments) ? state.attachments : []) {
    changed = cutField(a, 'url') || changed;
    changed = cutField(a, 'uri') || changed;
  }
  return changed;
}

// The redaction of one row's `data` (a v1 message or part, a v2 session_message): the declared
// paths of describe().redaction. `data` that does not parse is `damaged`.
function redactData(kind, sk) {
  return (row) => {
    const d = strictJson(row.data, `${kind}.data for ${row.id}`, sk);
    if (!d) return { row, redacted: false };
    let changed = false;
    if (kind === 'message') {
      changed = cutError(d.error) || changed;
    } else if (kind === 'part') {
      changed = cutError(d.error) || changed; // a retry part
      if (isObj(d.state)) {
        changed = cutError(d.state.error) || changed;
        changed = cutAttachments(d.state) || changed;
      }
      if (d.type === 'file') {
        changed = cutField(d, 'url') || changed;
        if (isObj(d.source)) changed = cutField(d.source, 'uri') || changed;
      }
    } else if (kind === 'session_message') {
      changed = cutError(d.error) || changed;
      for (const f of Array.isArray(d.files) ? d.files : []) {
        changed = cutField(f, 'url') || changed;
        changed = cutField(f, 'uri') || changed;
      }
      for (const c of Array.isArray(d.content) ? d.content : []) {
        if (!isObj(c) || !isObj(c.state)) continue;
        changed = cutError(c.state.error) || changed;
        changed = cutAttachments(c.state) || changed;
      }
    }
    return changed ? { row: { ...row, data: JSON.stringify(d) }, redacted: true } : { row, redacted: false };
  };
}

// readDelta redacts on the row-json. The redaction (and the damaged check) runs on the selected
// row first, and is carried to readDelta's hook as a flag field the hook strips again.
const REDACTED = '\u0000redacted';
function redactedRow(row, redact) {
  const r = redact(row);
  return r.redacted ? { ...r.row, [REDACTED]: true } : r.row;
}
function takeRedacted(rj) {
  if (!(REDACTED in rj)) return { row: rj, redacted: false };
  const { [REDACTED]: _r, ...row } = rj;
  return { row, redacted: true };
}

// The event log as a `seq` stream (sessions §1): the unit key is the seq; the position is the last
// unit's seq and sha, and how many units it closed. The unit at `from.seq` gone or changed, or a
// different count up to it (a deleted session's log, a migration that wiped `event`), is a reset.
function readSeq(sk, rows, from) {
  const units = rows.map((r) => {
    const u = makeUnit(sk, String(r.seq), Buffer.from(jcs(rowJson(r)), 'utf8'));
    u.enc = 'row-json';
    return u;
  });
  const last = units[units.length - 1];
  const position = { seq: last ? Number(last.unit_key) : -1, sha256: last ? last.sha256 : null, count: units.length };
  const reset = { continuity: 'reset', units, gone: [], position, held_back: [] };
  if (!from || typeof from.seq !== 'number') return reset;
  let start = 0;
  if (from.seq >= 0) {
    const i = units.findIndex((u) => Number(u.unit_key) === from.seq);
    if (i < 0 || units[i].sha256 !== from.sha256 || i + 1 !== from.count) return reset;
    start = i + 1;
  } else if (from.count !== 0) {
    return reset;
  }
  const added = units.slice(start);
  return { continuity: added.length ? 'appended' : 'unchanged', units: added, gone: [], position, held_back: [] };
}

function readTable(d, sc, table, sid, sk, from, known) {
  const sel = (t) => pick(sc[t], COLS[t]);
  // A BLOB-stored JSON column as its text, so row-json carries the JSON and not base64.
  const text = (r) => ('data' in r ? { ...r, data: r.data == null ? null : textOf(r.data) } : r);
  if (table === 'session') {
    const row = d.prepare(`SELECT ${sel('session')} FROM session WHERE id = ?`).get(sid);
    strictJson(row.revert, `session.revert for ${sid}`, sk);
    return readRowsSnapshot(sk, { session: [{ ...row, revert: row.revert == null ? null : textOf(row.revert) }] }, from);
  }
  if (table === 'message') {
    const rows = [];
    for (const t of ['message', 'part']) {
      if (!usable(sc, t)) continue;
      const redact = redactData(t, sk);
      for (const r of d.prepare(`SELECT ${sel(t)} FROM ${t} WHERE session_id = ? ORDER BY id`).all(sid)) {
        rows.push({ unit_key: `${t}:${r.id}`, row: redactedRow(text(r), redact) });
      }
    }
    return readDelta(sk, rows, from, known, { redact: takeRedacted });
  }
  if (table === 'session_message') {
    if (!usable(sc, 'session_message')) return readDelta(sk, [], from, known);
    const redact = redactData('session_message', sk);
    const rows = d.prepare(`SELECT ${sel('session_message')} FROM session_message WHERE session_id = ? ORDER BY id`).all(sid)
      .map((r) => ({ unit_key: `session_message:${r.id}`, row: redactedRow(text(r), redact) }));
    return readDelta(sk, rows, from, known, { redact: takeRedacted });
  }
  if (table === 'session_input') {
    if (!usable(sc, 'session_input')) return readDelta(sk, [], from, known);
    const rows = d.prepare(`SELECT ${sel('session_input')} FROM session_input WHERE session_id = ? ORDER BY id`).all(sid)
      .map((r) => ({ unit_key: `session_input:${r.id}`, row: r }));
    return readDelta(sk, rows, from, known);
  }
  // event
  if (!usable(sc, 'event')) return readSeq(sk, [], from);
  const q = EVENT_RANGES.map((r) => `SELECT ${sel('event')} FROM event WHERE aggregate_id = ? AND ${r}`).join(' UNION ALL ');
  const rows = d.prepare(`${q} ORDER BY seq, id`).all(...EVENT_RANGES.map(() => sid)).map(text);
  for (const r of rows) strictJson(r.data, `event.data for ${r.id}`, sk);
  return readSeq(sk, rows, from);
}

export function read(store, session, sourceKey, from = null, known = null) {
  const loc = locate(store.harness_path);
  const sid = session.session_id;
  if (!loc || !isRealFile(loc.root, loc.rel)) throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
  const what = parseKey(loc, sourceKey);
  const db = openReadOnly(loc.root, loc.rel, loc.rel);
  let out;
  try {
    out = withRead(db, sourceKey, (d) => {
      const sc = schemaOf(d);
      if (!usable(sc, 'session') || !d.prepare('SELECT 1 AS x FROM session WHERE id = ?').get(sid)) {
        throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
      }
      if (!what) throw new SessionsError('source_unknown', `${sourceKey} is not a source of ${sid}`, [sourceKey]);
      if (what.spill) {
        if (!(spillsOf(d, sc, sid).get(sid) ?? new Set()).has(what.spill)) {
          throw new SessionsError('source_unknown', `${sourceKey} is not a source of ${sid}`, [sourceKey]);
        }
        return null;
      }
      return readTable(d, sc, what.table, sid, sourceKey, from, known);
    });
  } finally {
    db.close();
  }
  if (out) return out;
  // A spill is read after the transaction: below the store's folder, never through a symlink.
  return readSnapshot(path.join(loc.root, 'tool-output', what.spill), sourceKey, from, { root: loc.root });
}

// The units `read` returns from scratch for a source holding `bytes` (src/index.js
// unitsFromBytes), from the source key alone: no session, no position, no file system. A spilled
// output is a snapshot; its key is `locate`'s `spillKey`: the absolute path `<data folder>/
// tool-output/tool_<id>`. A table of the database has no file bytes.
export function unitsFromBytes(sourceKey, bytes, { start = 0 } = {}) {
  if (typeof sourceKey === 'string' && sourceKey.startsWith('table:') && TABLES.has(sourceKey.slice('table:'.length))) throw databaseSource(sourceKey);
  const name = baseName(sourceKey);
  const spill = typeof sourceKey === 'string' && path.isAbsolute(sourceKey) && SPILL.test(name)
    && sourceKey === path.join(path.dirname(path.dirname(sourceKey)), 'tool-output', name);
  if (!spill) throw unknownSource(HARNESS, sourceKey);
  return snapshotUnits(bytes, sourceKey, { start });
}

// ---- derive -----------------------------------------------------------------------------------

function sourceKind(sk) {
  const m = /(?:^|#)table:([a-z_]+)$/.exec(sk);
  if (m && TABLES.has(m[1])) return m[1];
  if (SPILL.test(baseName(sk)) && /(?:^|[\\/])tool-output[\\/][^\\/]+$/.test(sk)) return 'spill';
  return null;
}

function dataOf(r) {
  if (!r || r.data == null) return {};
  try {
    const d = JSON.parse(r.data);
    return isObj(d) ? d : {};
  } catch {
    return {};
  }
}

/** The ms an ascending OpenCode id (msg_, prt_, evt_, tool_) was minted at, at or after `ref`. */
export function idTime(id, ref) {
  const m = /^[a-z]+_([0-9a-f]{12})/.exec(String(id));
  if (!m) return null;
  const x = Math.floor(parseInt(m[1], 16) / 4096) % MS_MOD;
  const base = Math.max(0, Number(ref) - ID_SLACK_MS);
  return base + ((((x - (base % MS_MOD)) % MS_MOD) + MS_MOD) % MS_MOD);
}

function errorText(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  const d = isObj(e.data) ? e.data : {};
  const msg = typeof d.message === 'string' ? d.message : typeof e.message === 'string' ? e.message : '';
  const name = str(e.name) || str(e.type);
  return [name, msg].filter(Boolean).join(': ') || 'error';
}

// A message's error (sessions-model §2.3 `error`): the name as `error_kind`, the message, the HTTP
// status. The response headers and body never get here: read replaced them.
function errorPart(e) {
  const d = isObj(e) && isObj(e.data) ? e.data : {};
  const message = typeof e === 'string' ? e : typeof d.message === 'string' ? d.message : isObj(e) && typeof e.message === 'string' ? e.message : '';
  const kind = isObj(e) ? str(e.name) || str(e.type) || 'unknown' : 'unknown';
  return { part_id: 'error', kind: 'error', error_kind: kind, message, http_status: Number.isFinite(d.statusCode) ? d.statusCode : null };
}

const effortOf = (v) => (typeof v === 'string' && v && v !== 'default' ? v : null);

// Usage (sessions-model §2.4): an all-zero record is unknown (an aborted, overflowed or errored
// step), so none; cost 0 is no price table, so null.
function usageOf(t, cost) {
  if (!isObj(t)) return null;
  const c = isObj(t.cache) ? t.cache : {};
  const u = { input: num(t.input) ?? 0, output: num(t.output) ?? 0, cache_read: num(c.read) ?? 0, cache_write: num(c.write) ?? 0, reasoning: num(t.reasoning) ?? 0 };
  if (!u.input && !u.output && !u.cache_read && !u.cache_write && !u.reasoning) return null;
  const k = num(cost);
  return { ...u, cost: k !== null && k > 0 ? k : null };
}
function sumUsage(steps) {
  const acc = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let cost = 0;
  for (const d of steps) {
    const t = isObj(d.tokens) ? d.tokens : {};
    const c = isObj(t.cache) ? t.cache : {};
    acc.input += num(t.input) ?? 0;
    acc.output += num(t.output) ?? 0;
    acc.reasoning += num(t.reasoning) ?? 0;
    acc.cache.read += num(c.read) ?? 0;
    acc.cache.write += num(c.write) ?? 0;
    cost += num(d.cost) ?? 0;
  }
  return usageOf(acc, cost);
}

// A v1 FilePart or a v2 attachment as an `attachment` part: a data: URL inline (its decoded
// bytes), a file: URL by its path, anything else by the reference read left (a cut URL, a path).
function attachment(partId, f) {
  const url = str(f.url) || str(f.uri);
  let media = str(f.mime) || str(f.mediaType) || null;
  const dm = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (dm) {
    if (!media) media = dm[1] || null;
    let bytes = null;
    try {
      bytes = /;base64/i.test(dm[2]) ? Buffer.from(dm[3], 'base64') : Buffer.from(decodeURIComponent(dm[3]), 'utf8');
    } catch {
      bytes = null;
    }
    if (bytes) return { part_id: partId, kind: 'attachment', media_type: media, inline: bytes.toString('base64'), ref: null, bytes_len: bytes.length };
  }
  let ref;
  if (/^file:/i.test(url)) {
    try {
      ref = fileURLToPath(url);
    } catch {
      ref = url.split(/[?#]/)[0];
    }
  } else {
    ref = url || str(f.filename) || str(f.name) || null;
  }
  return { part_id: partId, kind: 'attachment', media_type: media, inline: null, ref, bytes_len: null };
}

// A shell tool's exit code (sessions-model §2.3): the integer bash keeps in its metadata (v1
// `metadata.exit`, v2 `structured.exit`), never read from the output. null on an interrupt, and
// absent from a shell-mode command (spec), so null there too.
const exitOf = (meta) => (Number.isInteger(meta.exit) ? meta.exit : null);

// OpenCode's own text for a refused permission (sessions-model v1.x (#6), §2.3, and the
// sessions-model annex (#6)): a fixed string OpenCode itself writes for that case, matched exactly,
// never as a pattern. OpenCode v1.19.3 (e3c4eb24): PermissionRejectedError's message,
// packages/core/src/v1/permission.ts:7-11, stored as a v1 tool part's `state.error` (a string) by
// packages/opencode/src/session/processor.ts:186-194 through errorMessage (the error's message,
// packages/tui/src/util/error.ts:136-138). A rejection with feedback (PermissionCorrectedError,
// permission.ts:13-19) embeds the user's words, so it is no fixed string and stays `completed`. v2
// (`session_message`) writes no such result: a declined permission halts the loop
// (packages/core/src/session/runner/llm.ts:143-150).
const REJECTED = 'The user rejected permission to use this specific tool call.';

// A tool's call and result (sessions-model §2.3: one native part holding both becomes
// `<id>:call` + `<id>:result`, sharing the call id). `is_error` is the harness store's own flag,
// the part's state status (sessions-model v1.x (#6), §2.3): `error` gives true and `completed`
// false, and a status still pending or running gives null. A `completed` status beside a shell's
// non-zero `exit_code` is unreliable for that result: its `is_error` is null, and the other results
// keep the flag. It describes a call that completed: a refused permission (`denied`) or a call cut
// off (`cancelled`) gives null, and the status carries the fact. Never derived from the exit code
// or the text.
function toolPair(pid, callId, name, args, status, { output, error, truncated, outputRef, exitCode = null }) {
  const done = status === 'completed';
  const failed = status === 'error';
  const err = failed ? errorText(error) : '';
  const out = done ? String(output ?? '') : failed ? (typeof output === 'string' && output ? output : err) : null;
  // A refused permission is `denied`: the stored error is OpenCode's own text, whole (REJECTED). A
  // call still pending or running when its message ended was cut off: cancelled.
  const result = failed && error === REJECTED ? 'denied' : done || failed ? 'completed' : 'cancelled';
  return [
    { part_id: `${pid}:call`, kind: 'tool_call', call_id: callId, name, args, server: null },
    {
      part_id: `${pid}:result`, kind: 'tool_result', call_id: callId,
      is_error: result !== 'completed' ? null : failed ? true : exitCode !== null && exitCode !== 0 ? null : false,
      status: result,
      output: out, output_ref: outputRef, output_len: out === null ? null : utf8Len(out), truncated, exit_code: exitCode,
    },
  ];
}

// The spill a path names, as an output reference: its sha256 and length when the file is stored
// (its side source), else the name only (cleaned up).
function outputRef(p, spills) {
  const n = baseName(p);
  if (!SPILL.test(n)) return null;
  const s = spills.get(n);
  return { ref: n, sha256: s ? s.sha256 : null, bytes: s ? s.bytes : null };
}

function notice(pid, type, text) {
  return { part_id: pid, kind: 'notice', text, level: null, native_type: type };
}

// One v1 part as sessions-model parts, plus the sub-agent a `task` part started.
function v1Part(p, j, ctx) {
  const x = p.d;
  const pid = p.id;
  // A synthetic text or file part was written by the harness into the turn (compaction continue,
  // file reads, mention instructions): `source: 'injected'` on the part (sessions-model §2.3).
  const inj = x.synthetic === true ? { source: 'injected' } : {};
  switch (x.type) {
    case 'text':
      return { parts: [ctx.summary ? { part_id: pid, kind: 'summary', text: String(x.text ?? ''), replaces: ctx.replaces } : { part_id: pid, kind: 'text', text: String(x.text ?? ''), ...inj }] };
    case 'reasoning':
      return { parts: [x.text ? { part_id: pid, kind: 'reasoning', text: String(x.text), signature_len: null } : { part_id: pid, kind: 'reasoning', opaque: true, signature_len: null }] };
    case 'tool': {
      const st = isObj(x.state) ? x.state : {};
      const meta = isObj(st.metadata) ? st.metadata : {};
      const callId = str(x.callID) || `@${ctx.msgId}:${j}`;
      const ref = typeof meta.outputPath === 'string' ? outputRef(meta.outputPath, ctx.spills) : null;
      const parts = toolPair(pid, callId, str(x.tool) || 'unknown', st.input ?? {}, st.status, {
        output: st.output, error: st.error, outputRef: ref, exitCode: exitOf(meta),
        truncated: typeof meta.truncated === 'boolean' ? meta.truncated : ref ? true : null,
      });
      const atts = st.status === 'completed' && Array.isArray(st.attachments) ? st.attachments : [];
      atts.forEach((a, k) => {
        if (isObj(a)) parts.push(attachment(str(a.id) || `${pid}:att:${k}`, a));
      });
      const child = x.tool === 'task' && typeof meta.sessionId === 'string' && meta.sessionId ? { child: meta.sessionId, at: callId } : null;
      return { parts, child };
    }
    case 'file':
      return { parts: [{ ...attachment(pid, x), ...inj }] };
    case 'subtask':
      // The prompt the user's command sends to the sub-agent.
      return { parts: [{ part_id: pid, kind: 'text', text: String(x.prompt ?? ''), ...inj }] };
    case 'patch':
      return { parts: [notice(pid, 'patch', (Array.isArray(x.files) ? x.files : []).map(String).join('\n'))] };
    case 'step-finish':
      return { parts: [notice(pid, 'step-finish', str(x.reason))] };
    case 'retry':
      return { parts: [notice(pid, 'retry', errorText(x.error))] };
    case 'agent':
      return { parts: [notice(pid, 'agent', str(x.name))] };
    case 'step-start':
    case 'snapshot':
    case 'compaction':
      return { parts: [notice(pid, x.type, '')] };
    default: {
      const { type: _t, ...rest } = x;
      return { parts: [notice(pid, str(x.type) || null, JSON.stringify(rest))] };
    }
  }
}

// The revert in force: the session's `revert`, else a v2 revert staged and not yet committed or
// cleared.
function liveRevert(revert, events) {
  if (isObj(revert) && revert.messageID) return revert;
  let staged = null;
  for (const e of events) {
    const t = str(e.type);
    if (/^session\.next\.revert\.staged\./.test(t)) {
      const r = dataOf(e).revert;
      staged = isObj(r) ? r : null;
    } else if (/^session\.next\.revert\.(committed|cleared)\./.test(t)) staged = null;
  }
  return staged && staged.messageID ? staged : null;
}

const baseMessage = () => ({
  parent_id: null, agent_id: '', to_user: null, to_model: null, status: 'complete', state: 'current', on_active_branch: null,
  requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
});

// The last assistant, while it streams (no completion, no error), is held. An assistant with a
// later one after it is a dead run (killed, abandoned): written, interrupted.
function heldIndex(msgs, isAssistant) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!isAssistant(msgs[i])) continue;
    const d = msgs[i].d;
    return !(isObj(d.time) && d.time.completed) && !d.error ? i : -1;
  }
  return -1;
}

// The v1 engine: `message` rows by (time_created, id), parts by id.
function v1Records(rows, ctx, emit) {
  const partsOf = new Map();
  for (const p of rows.parts) {
    const mid = String(p.message_id);
    if (!partsOf.has(mid)) partsOf.set(mid, []);
    partsOf.get(mid).push({ id: String(p.id), d: dataOf(p) });
  }
  for (const l of partsOf.values()) l.sort((a, b) => cmp(a.id, b.id));
  const msgs = rows.messages.map((m) => ({ id: String(m.id), t: num(m.time_created) ?? 0, d: dataOf(m), parts: partsOf.get(String(m.id)) ?? [] }))
    .sort((a, b) => a.t - b.t || cmp(a.id, b.id));
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const isShell = (m) => m.d.role === 'assistant' && !m.d.finish && !m.d.error
    && m.parts.some((p) => p.d.type === 'tool') && !m.parts.some((p) => p.d.type === 'step-start' || p.d.type === 'step-finish');
  const shellParents = new Set(msgs.filter(isShell).map((m) => m.d.parentID));
  const compactionOf = (m) => m.parts.find((p) => p.d.type === 'compaction');
  const held = heldIndex(msgs, (m) => m.d.role === 'assistant');

  // The live revert: v1 hides the revert message and everything after it; a revert at a part hides
  // that message's later parts only.
  const rv = ctx.revert;
  let revertAt = -1;
  let revertPart = null;
  if (rv && rv.messageID) {
    revertAt = msgs.findIndex((m) => m.id === rv.messageID);
    if (revertAt >= 0 && rv.partID && msgs[revertAt].parts.some((p) => p.id === rv.partID)) revertPart = String(rv.partID);
  }

  msgs.forEach((m, i) => {
    const d = m.d;
    const isHeld = i === held;
    const role = d.role === 'assistant' ? 'assistant' : 'user';
    const summary = role === 'assistant' && (d.summary === true || d.mode === 'compaction' || d.agent === 'compaction');
    const trigger = summary && byId.get(d.parentID) ? compactionOf(byId.get(d.parentID)) : null;
    const replaces = trigger && trigger.d.tail_start_id ? { first_kept_id: String(trigger.d.tail_start_id) } : 'unknown';
    const hideFrom = i === revertAt && revertPart ? revertPart : null;
    const parts = [];
    m.parts.forEach((p, j) => {
      const made = v1Part(p, j, { msgId: m.id, summary, replaces, spills: ctx.spills });
      // A part hidden by a revert at a part: `state: 'reverted'` on the part (sessions-model §2.3).
      for (const x of made.parts) parts.push(hideFrom && p.id >= hideFrom ? { ...x, state: 'reverted' } : x);
      if (made.child) emit.link(ctx.originLink(made.child.child, made.child.at), isHeld);
    });
    const rec = {
      ...baseMessage(), message_id: m.id, parent_id: str(d.parentID) || null, order: `1|${pad(m.t)}|${m.id}`,
      state: revertAt >= 0 && (i > revertAt || (i === revertAt && !revertPart)) ? 'reverted' : 'current',
      ts: iso(m.t), role,
    };
    if (role === 'user') {
      const comp = compactionOf(m);
      const content = m.parts.filter((p) => ['text', 'file', 'subtask'].includes(p.d.type));
      // A harness-made turn: an automatic compaction's trigger, or a message made only of synthetic
      // parts (compaction continue, subtask summarise), unless it is a shell command's.
      const automated = (comp && comp.d.auto === true) || (!comp && content.length > 0 && content.every((p) => p.d.synthetic === true) && !shellParents.has(m.id));
      rec.source = automated ? 'automated' : 'user';
      rec.parts = parts;
      emit.message(rec, isHeld);
      if (comp) {
        // Replaced: everything before tail_start_id; with none, everything before the trigger.
        const tail = comp.d.tail_start_id ? msgs.findIndex((x) => x.id === comp.d.tail_start_id) : i;
        const through = tail > 0 ? msgs[tail - 1].id : null;
        emit.lifecycle({
          lifecycle_id: comp.id, op: 'compaction',
          target: through ? { range: { from_id: msgs[0].id, through_id: through } } : { session: true },
          at: m.id, ts: iso(m.t), evidence: 'explicit',
        });
      }
      return;
    }
    const parent = byId.get(d.parentID);
    const req = parent && isObj(parent.d.model) ? parent.d.model : null;
    const shell = isShell(m);
    rec.source = shell ? 'user' : 'model'; // a shell-mode command is the user's (spec §6)
    rec.served_model = str(d.modelID) || (isObj(d.model) ? str(d.model.modelID) : '') || null;
    rec.requested_model = req ? str(req.modelID) || null : null;
    rec.effort = effortOf(d.variant || (req && req.variant));
    rec.response_id = m.id; // the billing unit (sessions-model §2.2)
    if (d.error) {
      rec.status = isObj(d.error) && d.error.name === 'MessageAbortedError' ? 'interrupted' : 'error';
      parts.push(errorPart(d.error));
    } else if (!(isObj(d.time) && d.time.completed)) {
      rec.status = 'interrupted'; // a dead run: a later assistant took over (else it is held)
    } else if (!d.finish && !shell && !m.parts.length) {
      rec.status = 'interrupted'; // overflow: completed with no finish, error or parts (spec §4 #15)
    }
    rec.parts = parts;
    emit.message(rec, isHeld);
    const steps = m.parts.filter((p) => p.d.type === 'step-finish').map((p) => p.d);
    const u = steps.length ? sumUsage(steps) : usageOf(d.tokens, d.cost);
    if (u) {
      // v1 tokens: input = prompt − cache.read, output = completion − reasoning (sessions-model
      // §2.4).
      emit.usage({
        usage_id: `message:${m.id}#1`, anchor: { message_id: m.id }, ...u,
        input_includes_cache: false, output_includes_reasoning: false, granularity: 'per_message', model: rec.served_model,
      }, isHeld);
    }
  });

  // Edits: rows deleted on prompt-while-reverted, as their `message.removed` events say. One record
  // per event (its native id), at the last message written before the event's id time.
  const written = msgs.filter((_, i) => i !== held);
  for (const e of ctx.events) {
    if (!/^message\.(part\.)?removed\./.test(str(e.type))) continue;
    const ed = dataOf(e);
    const mid = str(ed.messageID) || (isObj(ed.part) ? str(ed.part.messageID) : '');
    if (!mid) continue;
    const at = idTime(e.id, ctx.created);
    const prev = at === null ? null : written.filter((m) => m.t < at).pop();
    emit.lifecycle({ lifecycle_id: String(e.id), op: 'edit', target: { message_id: mid }, at: prev ? prev.id : null, ts: iso(at), evidence: 'explicit' });
  }
}

// The v2 engine: `session_message` rows by seq; an assistant's content elements are its parts,
// keyed by their local ids.
function v2Content(c, msgId, k, spills) {
  const cid = str(c.id) || String(k);
  if (c.type === 'text') return { parts: [{ part_id: cid, kind: 'text', text: String(c.text ?? '') }] };
  if (c.type === 'reasoning') {
    return { parts: [c.text ? { part_id: cid, kind: 'reasoning', text: String(c.text), signature_len: null } : { part_id: cid, kind: 'reasoning', opaque: true, signature_len: null }] };
  }
  if (c.type !== 'tool') {
    const { type: _t, ...rest } = c;
    return { parts: [notice(cid, str(c.type) || null, JSON.stringify(rest))] };
  }
  const st = isObj(c.state) ? c.state : {};
  const s = isObj(st.structured) ? st.structured : {};
  const callId = str(c.id) || `@${msgId}:${k}`;
  const text = Array.isArray(st.content) ? st.content.map((x) => (typeof x === 'string' ? x : (isObj(x) && str(x.text)) || '')).join('') : '';
  const out = (Array.isArray(st.outputPaths) ? st.outputPaths : []).find((p) => SPILL.test(baseName(p)));
  const ref = out ? outputRef(out, spills) : null;
  const parts = toolPair(cid, callId, str(c.name) || 'unknown', typeof st.input === 'string' ? { raw: st.input } : st.input ?? {}, st.status, {
    output: text, error: st.error, outputRef: ref, exitCode: exitOf(s),
    truncated: typeof s.truncated === 'boolean' ? s.truncated : ref ? true : null,
  });
  (st.status === 'completed' && Array.isArray(st.attachments) ? st.attachments : []).forEach((a, j) => {
    if (isObj(a)) parts.push(attachment(`${cid}:att:${j}`, a));
  });
  const meta = isObj(st.structured) ? st.structured : isObj(st.metadata) ? st.metadata : {};
  const child = c.name === 'task' && typeof meta.sessionId === 'string' && meta.sessionId ? { child: meta.sessionId, at: callId } : null;
  return { parts, child };
}

function v2Records(rows, ctx, emit) {
  const msgs = rows.session_messages.map((m) => ({ id: String(m.id), type: str(m.type), seq: num(m.seq) ?? 0, t: num(m.time_created), d: dataOf(m) }))
    .sort((a, b) => a.seq - b.seq || cmp(a.id, b.id));
  const held = heldIndex(msgs, (m) => m.type === 'assistant');
  // The live revert: v2 hides what follows the staged message (a commit deletes that, keeps it).
  const rv = ctx.revert;
  const revertAt = rv && rv.messageID ? msgs.findIndex((m) => m.id === rv.messageID) : -1;

  msgs.forEach((m, i) => {
    const d = m.d;
    const isHeld = i === held;
    const ts = iso(m.t) ?? iso(isObj(d.time) ? d.time.created : null);
    const rec = {
      ...baseMessage(), message_id: m.id, order: `2|${pad(m.seq)}|${m.id}`,
      state: revertAt >= 0 && i > revertAt ? 'reverted' : 'current', ts, role: 'user', source: 'user',
    };
    const parts = [];
    if (m.type === 'user') {
      if (d.text != null && d.text !== '') parts.push({ part_id: '0', kind: 'text', text: String(d.text) });
      (Array.isArray(d.files) ? d.files : []).forEach((f, j) => {
        if (isObj(f)) parts.push(attachment(String(j + 1), f));
      });
    } else if (m.type === 'synthetic') {
      rec.source = 'injected';
      parts.push({ part_id: '0', kind: 'text', text: String(d.text ?? '') });
    } else if (m.type === 'system') {
      rec.role = 'system';
      rec.source = 'injected';
      parts.push(notice('0', 'system', String(d.text ?? '')));
    } else if (m.type === 'shell') {
      // A shell command the user ran: an assistant message with the user as source, as in v1.
      rec.role = 'assistant';
      const done = isObj(d.time) && d.time.completed;
      const callId = str(d.callID) || `@${m.id}:0`;
      parts.push(...toolPair(str(d.callID) || 'shell', callId, 'bash', { command: String(d.command ?? '') }, done ? 'completed' : 'running', { output: d.output, error: null, outputRef: null, truncated: null }));
    } else if (m.type === 'compaction') {
      rec.role = 'system';
      rec.source = d.reason === 'auto' ? 'automated' : null;
      parts.push({ part_id: '0', kind: 'summary', text: String(d.summary ?? ''), replaces: 'unknown' });
      emit.lifecycle({
        lifecycle_id: m.id, op: 'compaction',
        target: i > 0 ? { range: { from_id: msgs[0].id, through_id: msgs[i - 1].id } } : { session: true },
        at: m.id, ts, evidence: 'explicit',
      });
    } else if (m.type === 'assistant') {
      rec.role = 'assistant';
      rec.source = 'model';
      const model = isObj(d.model) ? d.model : {};
      rec.served_model = str(model.id) || null;
      rec.effort = effortOf(model.variant);
      rec.response_id = m.id;
      (Array.isArray(d.content) ? d.content : []).forEach((c, k) => {
        if (!isObj(c)) return;
        const made = v2Content(c, m.id, k, ctx.spills);
        parts.push(...made.parts);
        if (made.child) emit.link(ctx.originLink(made.child.child, made.child.at), isHeld);
      });
      if (d.error) {
        rec.status = /abort/i.test(errorText(d.error)) ? 'interrupted' : 'error';
        parts.push(errorPart(d.error));
      } else if (!(isObj(d.time) && d.time.completed)) {
        rec.status = 'interrupted';
      }
      // v2 tokens: nothing establishes what input and output count (annex `?`), so both flags are
      // null.
      const u = usageOf(d.tokens, d.cost);
      if (u) emit.usage({ usage_id: `message:${m.id}#1`, anchor: { message_id: m.id }, ...u, input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_message', model: rec.served_model }, isHeld);
    } else {
      // agent-switched, model-switched and any later type: a notice, never dropped.
      rec.role = 'system';
      rec.source = 'system_notice';
      parts.push(notice('0', m.type || null, JSON.stringify(d)));
    }
    rec.parts = parts;
    emit.message(rec, isHeld);
  });

  // A committed revert deleted the rows after the staged message: a rewind, at that message.
  for (const e of ctx.events) {
    if (!/^session\.next\.revert\.committed\./.test(str(e.type))) continue;
    const ed = dataOf(e);
    emit.lifecycle({ lifecycle_id: String(e.id), op: 'rewind', target: { session: true }, at: str(ed.messageID) || null, ts: iso(ed.timestamp), evidence: 'explicit' });
  }
}

// Every record of the session from the current units, the session record last and without its
// fingerprint, plus the keys held as incomplete.
function build(st, sid) {
  let srow = null;
  const rows = { messages: [], parts: [], session_messages: [] };
  const events = [];
  const spills = new Map();
  for (const sk of Object.keys(st.src).sort()) {
    const kind = sourceKind(sk);
    for (const [k, v] of Object.entries(st.src[sk])) {
      if (!v) continue;
      if (kind === 'session') srow = isObj(v) && Array.isArray(v.session) && isObj(v.session[0]) ? v.session[0] : srow;
      else if (kind === 'message') (k.startsWith('part:') ? rows.parts : rows.messages).push(v);
      else if (kind === 'session_message') rows.session_messages.push(v);
      else if (kind === 'event') events.push(v);
      else if (kind === 'spill') spills.set(baseName(sk), v);
    }
  }
  events.sort((a, b) => (num(a.seq) ?? 0) - (num(b.seq) ?? 0) || cmp(String(a.id), String(b.id)));
  const s = srow ?? {};
  let revert = null;
  try {
    revert = s.revert ? JSON.parse(s.revert) : null;
  } catch {
    revert = null;
  }

  const out = [];
  const held = noHeld();
  const msgs = [];
  const emit = {
    message: (r, isHeld) => (isHeld ? held.message.push(r.message_id) : msgs.push({ type: 'message', ...r })),
    usage: (r, isHeld) => (isHeld ? held.usage.push(r.usage_id) : out.push({ type: 'usage', ...r })),
    link: (r, isHeld) => (isHeld ? held.link.push(recordKey({ type: 'link', ...r })) : out.push({ type: 'link', ...r })),
    lifecycle: (r) => out.push({ type: 'lifecycle', ...r }),
  };
  const ctx = {
    revert: liveRevert(revert, events), events, spills, created: num(s.time_created) ?? 0,
    // The origin side of a sub-agent link: the `task` part that started it, at its call id.
    originLink: (child, at) => ({
      kind: 'subagent', stated_on: 'origin', child: { harness: HARNESS, session_id: child }, origin: { harness: HARNESS, session_id: sid },
      at, inherits: null, child_stored: null, evidence: 'explicit',
    }),
  };
  // Both engines in one session were never observed: v1 first, then v2 (the `order` prefix).
  const hasV2 = rows.session_messages.length > 0;
  if (rows.messages.length || !hasV2) v1Records(rows, ctx, emit);
  if (hasV2) v2Records(rows, ctx, emit);

  // The child side: the session's own `parent_id`, with no point (sessions-model §2.5).
  if (str(s.parent_id)) {
    out.push({
      type: 'link', kind: 'subagent', stated_on: 'child', child: { harness: HARNESS, session_id: sid }, origin: { harness: HARNESS, session_id: String(s.parent_id) },
      at: '', inherits: null, child_stored: true, evidence: 'explicit',
    });
  }

  msgs.sort((a, b) => cmp(a.order, b.order));
  const updated = msgs.reduce((acc, m) => (m.ts && (acc === null || m.ts > acc) ? m.ts : acc), null);
  // A task part repeated across messages states one link.
  const seen = new Set();
  const rest = out.filter((r) => {
    if (r.type !== 'link') return true;
    const k = recordKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const session = {
    type: 'session',
    engine: hasV2 ? 'v2' : 'v1',
    client: 'opencode',
    harness_version: str(s.version) || null, // the version that created the session (spec §3)
    title: str(s.title) || null,
    // A placeholder (`New session - <ISO>`), a generated title and a user's rename are stored
    // alike.
    title_set_by: str(s.title) ? 'unknown' : null,
    cwd: str(s.directory) || null,
    last_cwd: null,
    created_at: iso(s.time_created),
    updated_at: updated,
    state: (num(s.time_archived) ?? 0) > 0 ? 'archived' : 'active',
    pinned: null,
    mode: null,
    kind: null,
    reuse: 'impossible',
    ts_source: 'event',
    aliases: [],
  };
  return { out: [...msgs, ...rest, session], held };
}

function emptyState() {
  return {
    state_ver: STATE_VER,
    src: {}, // source_key -> unit_key -> the unit's row (parsed row-json), or a spill's {sha256, bytes}
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
  };
}

// The state keeps every current unit, and the records are rebuilt from all of them: every split of
// the units across derives gives the same records, and `changed` is exactly what moved.
export function derive(session, input, state) {
  const st = state && state.state_ver === STATE_VER ? structuredClone(state) : emptyState();
  const key = {
    host: session.host, harness: HARNESS, harness_path: session.harness_path,
    session_id: session.session_id, incarnation: session.incarnation ?? '',
  };
  for (const src of input) {
    const sk = src.source_key;
    const kind = sourceKind(sk);
    if (!kind) continue;
    const units = src.units ?? [];
    const value = (u) => (kind === 'spill' ? { sha256: u.sha256, bytes: u.bytes } : jsonOf(u));
    if (kind === 'session' || kind === 'spill') {
      // A snapshot: its one unit is the whole source.
      if (units.length) st.src[sk] = { [units[units.length - 1].unit_key]: value(units[units.length - 1]) };
      else if (src.complete) st.src[sk] = {};
      continue;
    }
    if (src.complete || !st.src[sk]) st.src[sk] = {};
    for (const u of units) st.src[sk][u.unit_key] = value(u);
    for (const k of src.gone ?? []) delete st.src[sk][k];
  }

  const { out: built, held } = build(st, session.session_id);
  const changed = [];
  const live = noHeld();
  const cmpShas = []; // the fingerprint: every written message on the current line, in order
  for (const r of built) {
    const sealed = seal({ type: r.type, ...key, ...(r.type === 'session' ? { ...r, fingerprint: { cmp_shas: cmpShas } } : r) });
    const k = recordKey(sealed);
    live[sealed.type].push(k);
    if (sealed.type === 'message' && sealed.state === 'current') cmpShas.push(sealed.cmp_sha);
    if (st.emitted[sealed.type][k] !== sealed.content_sha) {
      st.emitted[sealed.type][k] = sealed.content_sha;
      changed.push(sealed);
    }
  }
  // A key neither live nor held leaves `emitted`, and the consumer tombstones it. A held key keeps
  // its last emitted sha: it is neither rewritten nor tombstoned (sessions §2).
  for (const type of Object.keys(live)) {
    // A key written from another record (a task link stated twice) is live, not held.
    const liveSet = new Set(live[type]);
    held[type] = [...new Set(held[type])].filter((k) => !liveSet.has(k)).sort();
    const keep = new Set([...live[type], ...held[type]]);
    for (const k of Object.keys(st.emitted[type])) if (!keep.has(k)) delete st.emitted[type][k];
    live[type].sort();
  }
  return {
    changed,
    live,
    held,
    state: st,
    checkpoint: true,
    adapter_ver: describeData.adapter_ver,
    model_version: describeData.model_version,
    state_ver: STATE_VER,
  };
}
