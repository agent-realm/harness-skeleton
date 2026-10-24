// agy (the Antigravity CLI): `~/.gemini/antigravity-cli/` is the `harness_path` (only HOME moves
// it; spec §1). One session per cascade id. sessions v1 four operations over sessions-model v1.1
// records.
//
// The harness store (spec §2, §3):
// - `conversations/<id>.db`: SQLite in WAL mode, canonical. `steps` holds one protobuf
//   `gemini_coder.Step` per `idx`, upserted while a step runs and hard-deleted on a rewind, which
//   then reuses the idx. `gen_metadata` (one row per model generation) gives the served model;
//   `executor_metadata` (one row per finished execution) says a turn ended; `parent_references`
//   holds the fork link and `trajectory_metadata_blob` the conversation's metadata.
// - `brain/<id>/.system_generated/logs/transcript_full.jsonl`: append-only, no ids. Beside a DB it
//   only gives the rewind events (the DB keeps no trace of them); with no DB it is the session.
// - `conversation_summaries.db`: the index shared with the hub and the IDE (title, parent).
// - `annotations/<id>.pbtxt`: a text proto with the title and the archived / pinned flags.
// - `brain/<id>/.system_generated/steps/<idx>/output.txt`: a tool's whole output, when the step
//   holds a cut copy.
//
// Ported from memhouse's v4 normaliser (its agy module: the step decoding, the
// anchored ids, the call claiming, the turn ends, the transcript fold, the links). New here:
// - records in the sessions-model shape. A tool result is its own `tool` message, keyed by its
//   GENERIC step's content id, no longer folded into the planner's message;
// - usage as its own records, keyed by the response id;
// - the hold as derive `held`, per record: a step still open while its turn runs, and a planner
//   whose calls have no final result yet. memhouse held everything after it, because its log was
//   ordered by append;
// - every file and table is a source, so derive is pure: the spilled output (memhouse's spill
//   reference
//   read output.txt in the fold) is a side snapshot whose length decides `output_ref`, which
//   carries the unit's sha256 and length; the summaries row is read by `read`;
// - read keeps of a gen_metadata row only what derive uses (pb.js GEN_KEEP).

import fs from 'node:fs';
import path from 'node:path';
import { SessionsError } from '../../errors.js';
import { isRealFile, readStream, readSnapshot, streamUnits, snapshotUnits, databaseSource, unknownSource, jsonOf } from '../../sources.js';
import { openReadOnly, withRead, hasTable, readDelta, readRowsSnapshot } from '../../sqlite.js';
import { seal, recordKey } from '../../records.js';
import { sha256 } from '../../jcs.js';
import { decode, safeDecode, project, S, GEN_KEEP, T, ST, OPEN, REF_FORK, SRC, modelName } from './pb.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'agy';
const STATE_VER = 2; // 2: a spilled output's state keeps its unit's sha256 beside its length
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUMMARIES = 'conversation_summaries.db';
export const SUMMARY_KEY = `${SUMMARIES}#table:conversation_summaries`;
// The summaries columns derive reads. `step_count`, `last_modified_time`, `status` and the other
// counters move with every step of every conversation, so they are never read (memhouse).
const SUMMARY_COLS = ['conversation_id', 'title', 'parent_conversation_id', 'agent_name', 'app_data_dir', 'workspace_uris'];
const DELTA_TABLES = ['steps', 'gen_metadata', 'executor_metadata', 'parent_references'];
const TABLES = [...DELTA_TABLES, 'trajectory_metadata_blob'];

const dbRel = (sid) => `conversations/${sid}.db`;
const tableKey = (sid, t) => `${dbRel(sid)}#table:${t}`;
const transcriptRel = (sid) => `brain/${sid}/.system_generated/logs/transcript_full.jsonl`;
const annotationRel = (sid) => `annotations/${sid}.pbtxt`;
const stepsDirRel = (sid) => `brain/${sid}/.system_generated/steps`;
const outputRel = (sid, n) => `${stepsDirRel(sid)}/${n}/output.txt`;
const noHeld = () => ({ session: [], message: [], usage: [], link: [], lifecycle: [] });

export function describe() {
  return describeData;
}

// ---- list -------------------------------------------------------------------------------------

// A directory's entries, or none when it is missing or reached through a symlink: list never walks
// through a symlink, and read refuses one (src/sources.js, src/sqlite.js), so the two agree.
function readdir(dir) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return [];
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
}

// The summaries rows (projected), by conversation id: of every conversation, or of `only`. A
// missing table reads as empty; a lock or a damaged page throws `busy` / `damaged`.
function readSummaries(root, only = null) {
  const out = new Map();
  if (!isRealFile(root, SUMMARIES)) return out;
  const db = openReadOnly(root, SUMMARIES, SUMMARY_KEY);
  try {
    withRead(db, SUMMARY_KEY, (d) => {
      if (!hasTable(d, 'conversation_summaries')) return;
      const cols = SUMMARY_COLS.map((c) => `\`${c}\``).join(', ');
      const rows = only
        ? d.prepare(`SELECT ${cols} FROM conversation_summaries WHERE conversation_id = ?`).all(only)
        : d.prepare(`SELECT ${cols} FROM conversation_summaries ORDER BY conversation_id`).all();
      for (const r of rows) out.set(String(r.conversation_id), r);
    });
  } finally {
    db.close();
  }
  return out;
}

// The files of one session, or null when it has neither a DB nor a transcript. A spilled output is
// a source only beside a DB: the jsonl names no output file.
function filesOf(root, sid) {
  const db = isRealFile(root, dbRel(sid));
  const transcript = isRealFile(root, transcriptRel(sid));
  if (!db && !transcript) return null;
  const outputs = [];
  if (db) {
    for (const e of readdir(path.join(root, stepsDirRel(sid)))) {
      if (e.isDirectory() && /^\d+$/.test(e.name) && isRealFile(root, outputRel(sid, e.name))) outputs.push(outputRel(sid, e.name));
    }
  }
  return { db, transcript, annotation: isRealFile(root, annotationRel(sid)), outputs };
}

function sourcesOf(sid, files, summary) {
  const out = [];
  const add = (source_key, role, mode, position_kind) => out.push({ source_key, role, mode, position_kind });
  if (files.db) {
    // `idx` is the INTEGER PRIMARY KEY, so the rowid; it is reused after a rewind, and `known`
    // decides what changed (sessions §2 rule 4).
    add(tableKey(sid, 'steps'), 'main', 'delta', 'rowid');
    for (const t of ['gen_metadata', 'executor_metadata', 'parent_references']) add(tableKey(sid, t), 'side', 'delta', 'rowid');
    add(tableKey(sid, 'trajectory_metadata_blob'), 'side', 'snapshot', 'snapshot');
  }
  if (files.transcript) add(transcriptRel(sid), files.db ? 'side' : 'main', 'stream', 'byte_offset');
  if (summary) add(SUMMARY_KEY, 'side', 'snapshot', 'snapshot');
  if (files.annotation) add(annotationRel(sid), 'side', 'snapshot', 'snapshot');
  for (const o of files.outputs) add(o, 'side', 'snapshot', 'snapshot');
  return out.sort((a, b) => (a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0));
}

// Size and mtime of every file the session is read from (a DB with its `-wal`: rows often live
// only there; spec §8), plus this session's projected summaries row. Another conversation's churn
// in the shared summaries DB does not move it.
function hint(root, sources, summary) {
  const stat = (rel) => {
    try {
      const st = fs.statSync(path.join(root, rel));
      return [rel, st.size, Math.trunc(st.mtimeMs)];
    } catch {
      return [rel, -1, -1];
    }
  };
  const files = new Set();
  for (const s of sources) if (s.source_key !== SUMMARY_KEY) files.add(s.source_key.split('#')[0]);
  const parts = [...files].sort().flatMap((rel) => (rel.endsWith('.db') ? [stat(rel), stat(`${rel}-wal`)] : [stat(rel)]));
  return sha256(JSON.stringify([parts, summary])).slice(0, 32);
}

// One session per `conversations/<id>.db`, plus a brain transcript with no DB. Hub and IDE rows of
// the shared summaries DB are no session here: ids come from this folder's files only.
export function list(store) {
  const root = store.harness_path;
  const ids = new Set();
  for (const e of readdir(path.join(root, 'conversations'))) {
    const m = /^(.+)\.db$/.exec(e.name);
    if (e.isFile() && m && UUID.test(m[1])) ids.add(m[1]);
  }
  for (const e of readdir(path.join(root, 'brain'))) if (e.isDirectory() && UUID.test(e.name)) ids.add(e.name);
  const sums = ids.size ? readSummaries(root) : new Map();
  const out = [];
  for (const sid of [...ids].sort()) {
    const files = filesOf(root, sid);
    if (!files) continue;
    const summary = sums.get(sid) ?? null;
    const sources = sourcesOf(sid, files, summary);
    out.push({ session_id: sid, incarnation: '', updated_hint: hint(root, sources, summary), live: 'unknown', sources });
  }
  return out;
}

// ---- read -------------------------------------------------------------------------------------

const damaged = (sk, why) => new SessionsError('damaged', `${sk}: ${why}`, [sk]);

function readTable(root, sid, table, sk, from, known) {
  const db = openReadOnly(root, dbRel(sid), sk);
  try {
    return withRead(db, sk, (d) => {
      const there = hasTable(d, table);
      if (table === 'trajectory_metadata_blob') {
        const rows = there ? d.prepare('SELECT * FROM trajectory_metadata_blob ORDER BY id').all() : [];
        return readRowsSnapshot(sk, { trajectory_metadata_blob: rows }, from);
      }
      const rows = there ? d.prepare(`SELECT * FROM ${table} ORDER BY idx`).all() : [];
      const units = rows.map((r) => {
        if (table !== 'gen_metadata') return { unit_key: `${table}:${r.idx}`, row: r };
        // Only what derive reads: the prompt it re-stores is 25-52 KB a generation (spec §3).
        let data = r.data ?? null;
        if (data !== null) {
          try {
            data = project(data, GEN_KEEP);
          } catch (e) {
            throw damaged(sk, `generation ${r.idx} does not decode (${e.message})`);
          }
        }
        return { unit_key: `${table}:${r.idx}`, row: { idx: r.idx, data } };
      });
      const out = readDelta(sk, units, from, known);
      if (table === 'steps') {
        // A committed step that does not decode is `damaged`, never skipped: a skipped step loses a
        // message and shifts the anchored ids after it (memhouse's Undecodable).
        const byKey = new Map(units.map((u) => [u.unit_key, u.row]));
        for (const u of out.units) {
          const r = byKey.get(u.unit_key);
          try {
            decode(r.step_payload ?? null, S.Step);
            if (r.metadata != null) decode(r.metadata, S.Meta);
          } catch (e) {
            throw damaged(sk, `step ${r.idx} does not decode (${e.message})`);
          }
        }
      }
      return out;
    });
  } finally {
    db.close();
  }
}

export function read(store, session, sourceKey, from = null, known = null) {
  const root = store.harness_path;
  const sid = session.session_id;
  const files = typeof sid === 'string' && UUID.test(sid) ? filesOf(root, sid) : null;
  if (!files) throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
  const unknown = () => new SessionsError('source_unknown', `${sourceKey} is not a source of ${sid}`, [sourceKey]);
  if (sourceKey === SUMMARY_KEY) {
    if (!isRealFile(root, SUMMARIES)) throw unknown();
    // This session's row, or none once it is gone (a snapshot of no rows).
    return readRowsSnapshot(SUMMARY_KEY, { conversation_summaries: [...readSummaries(root, sid).values()] }, from);
  }
  const table = TABLES.find((t) => sourceKey === tableKey(sid, t));
  if (table) {
    if (!files.db) throw unknown();
    return readTable(root, sid, table, sourceKey, from, known);
  }
  if (sourceKey === transcriptRel(sid) && files.transcript) {
    return readStream(path.join(root, sourceKey), sourceKey, from, { root });
  }
  if ((sourceKey === annotationRel(sid) && files.annotation) || files.outputs.includes(sourceKey)) {
    return readSnapshot(path.join(root, sourceKey), sourceKey, from, { root });
  }
  throw unknown();
}

// The units `read` returns from scratch for a source holding `bytes` (src/index.js
// unitsFromBytes), from the source key alone: no session, no position, no file system. The
// transcript is a stream; the annotation and a spilled output are snapshots. A table of the
// conversation DB or of the summaries DB has no file bytes.
export function unitsFromBytes(sourceKey, bytes, { start = 0 } = {}) {
  const k = typeof sourceKey === 'string' ? sourceKey : '';
  let m = /^conversations\/([^/]+)\.db#table:(.+)$/.exec(k);
  if ((m && UUID.test(m[1]) && TABLES.includes(m[2])) || k === SUMMARY_KEY) throw databaseSource(sourceKey);
  m = /^brain\/([^/]+)\/\.system_generated\/logs\/transcript_full\.jsonl$/.exec(k);
  if (m && UUID.test(m[1])) return streamUnits(bytes, sourceKey, { start });
  m = /^annotations\/([^/]+)\.pbtxt$/.exec(k) ?? /^brain\/([^/]+)\/\.system_generated\/steps\/\d+\/output\.txt$/.exec(k);
  if (m && UUID.test(m[1])) return snapshotUnits(bytes, sourceKey, { start });
  throw unknownSource(HARNESS, sourceKey);
}

// ---- derive: helpers --------------------------------------------------------------------------

const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const isoOf = (v) => (typeof v === 'string' && v ? iso(Date.parse(v)) : null);
const pad = (n) => String(n).padStart(12, '0');
const utf8Len = (s) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : null);
const byOrder = (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
// A stored zero is null: proto3 cannot tell zero from unset (sessions-model §2.4).
const nz = (v) => (v == null || !Number.isFinite(Number(v)) || Number(v) === 0 ? null : Number(v));

function argsOf(a) {
  if (a == null || a === '') return {};
  if (typeof a !== 'string') return a;
  try {
    return JSON.parse(a);
  } catch {
    return { raw: a };
  }
}

function uriPath(u) {
  const s = String(u || '');
  if (!s.startsWith('file://')) return s;
  try {
    return decodeURIComponent(new URL(s).pathname);
  } catch {
    return s;
  }
}

function firstJson(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v[0] || '' : '';
  } catch {
    return '';
  }
}

// A file part's ref (memhouse): a file: URI, a plain path or a drive path as is; any other URI cut
// to scheme://host, else one marker, since its path or query may carry a token.
function fileRef(v) {
  const s = String(v || '');
  if (!s || s.startsWith('file:') || /^[a-z]:[\\/]/i.test(s) || !/^[a-z][a-z0-9+.-]*:/i.test(s)) return s || null;
  try {
    const u = new URL(s);
    if (u.host) return `${u.protocol}//${u.host}`;
  } catch {
    // not a URL
  }
  return `<redacted len=${Buffer.byteLength(s, 'utf8')}>`;
}

function mediaPart(m) {
  const bytes = m.inline_data && m.inline_data.length ? Buffer.from(m.inline_data) : null;
  if (bytes) return { kind: 'attachment', media_type: m.mime_type || null, inline: bytes.toString('base64'), bytes_len: bytes.length };
  return { kind: 'attachment', media_type: m.mime_type || null, ref: m.uri ? fileRef(m.uri) : str(m.display_name), bytes_len: null };
}

function imagePart(im) {
  if (im.base64_data) return { kind: 'attachment', media_type: im.mime_type || null, inline: im.base64_data, bytes_len: Buffer.from(im.base64_data, 'base64').length };
  return { kind: 'attachment', media_type: im.mime_type || null, ref: fileRef(im.uri), bytes_len: null };
}

function errorText(e) {
  if (!e) return '';
  return e.short_error || e.user_error_message || e.full_error || e.model_error_message || '';
}

// A tool payload (google.protobuf.Any), decoded when it is one this adapter reads.
function payloadOf(any, name) {
  if (!any || !any.type_url || !any.type_url.endsWith(`.${name}`)) return null;
  return safeDecode(any.value, S[name]);
}

// A run_command's exit code (sessions-model §2.3): the RunCommand payload's own field, never the
// result text. A stored `exit_code_unknown` is null. proto3 writes no 0, so a command that finished
// (DONE, not timed out) with no code stored exited 0; one that did not finish has none.
function exitCodeOf(r, status) {
  const rc = payloadOf(r.payload, 'RunCommand');
  if (!rc || rc.exit_code_unknown) return null;
  if (typeof rc.exit_code === 'number') return rc.exit_code;
  return status === ST.DONE && !rc.timed_out ? 0 : null;
}

// The MCP server a GENERIC result names (source-only shapes: agy 1.4.4 never ran an MCP tool).
function serverOf(r) {
  const c = r.tool_call_step && r.tool_call_step.mcp_server_tool_call;
  if (c && c.server_name) return c.server_name;
  const t = r.tool_result_step && r.tool_result_step.mcp_server_tool_result;
  if (t && t.server_name) return t.server_name;
  const nested = payloadOf(r.payload, 'Step');
  return (nested && nested.mcp_tool && nested.mcp_tool.server_name) || null;
}

// A system message's `source`: `automated` when it starts a turn for the agent (a background task
// or timer done, a message from another agent), else `injected` (a hook, a restart notice).
function systemSource(eventType, sender) {
  if (eventType === 'task_notification' || eventType === 'agent_message') return 'automated';
  if (sender && sender !== 'system') return 'automated';
  return 'injected';
}
const senderOf = (text) => {
  const m = /\[Message\][^\n]*?\bsender=(\S+)/.exec(String(text || ''));
  return m ? m[1] : '';
};

// annotations/<id>.pbtxt, a text proto: {title, archived, pinned}. Octal and C escapes in the
// title.
export function parseAnnotation(text) {
  const src = String(text || '');
  const out = { title: '', archived: /^\s*archived:\s*true\b/m.test(src), pinned: /^\s*pinned:\s*true\b/m.test(src) };
  const m = /^\s*title:\s*"((?:[^"\\]|\\.)*)"/m.exec(src);
  if (!m) return out;
  const s = m[1];
  const bytes = [];
  const MAP = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' };
  for (let i = 0; i < s.length; i++) {
    const ch = String.fromCodePoint(s.codePointAt(i));
    i += ch.length - 1;
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const n = s[++i];
    if (/[0-7]/.test(n)) {
      let o = n;
      while (o.length < 3 && /[0-7]/.test(s[i + 1] || '')) o += s[++i];
      bytes.push(parseInt(o, 8) & 0xff);
    } else if (n === 'x' && /[0-9a-f]/i.test(s[i + 1] || '')) {
      let h = '';
      while (h.length < 2 && /[0-9a-f]/i.test(s[i + 1] || '')) h += s[++i];
      bytes.push(parseInt(h, 16));
    } else for (const b of Buffer.from(MAP[n] ?? n, 'utf8')) bytes.push(b);
  }
  out.title = Buffer.from(bytes).toString('utf8');
  return out;
}

// The transcript's lines in file order, each with its unit key (its byte offset) and step_index.
function transcriptLines(st) {
  return Object.entries(st.transcript)
    .filter(([, o]) => o && typeof o === 'object' && o.step_index !== null && Number.isInteger(Number(o.step_index)))
    .map(([off, o]) => ({ off, o, si: Number(o.step_index), retracted: false }))
    .sort((a, b) => Number(a.off) - Number(b.off));
}

// Walk the lines in file order. A line whose step_index is not above the last kept line's retracts
// every kept line from that index on (a rewind; the lines stay in the file), and sets `retracted`
// on them. Returns the rewinds: {at: line position, retracted: [line positions], through: the line
// kept before the cut, or -1}.
export function foldTranscript(lines) {
  const kept = [];
  const rewinds = [];
  lines.forEach((l, k) => {
    const gone = [];
    while (kept.length && lines[kept[kept.length - 1]].si >= l.si) gone.unshift(kept.pop());
    if (gone.length) {
      for (const g of gone) lines[g].retracted = true;
      rewinds.push({ at: k, retracted: gone, through: kept.length ? kept[kept.length - 1] : -1 });
    }
    kept.push(k);
  });
  return rewinds;
}

// A usage record, keyed by the response id where agy stored one, else anchored to the message.
function usageRecord(u, cost, model, msgId) {
  if (!u) return null;
  const rec = {
    input: nz(u.input_tokens), output: nz(u.output_tokens), cache_read: nz(u.cache_read_tokens),
    cache_write: nz(u.cache_write_tokens), reasoning: nz(u.thinking_output_tokens), cost: nz(cost),
  };
  if (!Object.values(rec).some((v) => v !== null)) return null;
  const resp = str(u.response_id);
  return {
    type: 'usage',
    usage_id: resp ?? `message:${msgId}#1`,
    anchor: resp ? { response_id: resp } : { message_id: msgId },
    ...rec,
    input_includes_cache: null, output_includes_reasoning: null,
    granularity: 'per_response',
    model,
  };
}

// ---- derive: the DB -----------------------------------------------------------------------------

function stepOf(row) {
  let st;
  let meta = null;
  try {
    st = decode(row.step_payload ?? null, S.Step);
    if (row.metadata != null) meta = decode(row.metadata, S.Meta);
  } catch (e) {
    // read refuses such a row, so only a unit from an older read can get here.
    throw new SessionsError('damaged', `agy: step ${row.idx} does not decode (${e.message})`, [String(row.idx)]);
  }
  meta = meta || st.metadata || {};
  return { idx: Number(row.idx), type: Number(row.step_type) || st.type || 0, status: Number(row.status) || st.status || 0, meta, st };
}
const infoOf = (s) => s.meta.source_trajectory_step_info || {};
const requestedOf = (s, cm) => modelName((s.meta.requested_model || {}).model || s.meta.generator_model || (s.meta.model_usage || {}).model || (cm || {}).model);
const doneStatus = (s) => (s.status === ST.ERROR ? 'error' : s.status === ST.CANCELED ? 'cancelled' : s.status === ST.INTERRUPTED ? 'interrupted' : 'complete');

// Every record of a session with a DB, and the keys held as incomplete.
function fromDb(st, sid, me) {
  const steps = Object.values(st.steps).map(stepOf).sort((a, b) => a.idx - b.idx);
  const recs = [];
  const held = noHeld();

  // Ids: the content id; an anchored id for a step without one, assigned over every step so a held
  // step never shifts it (sessions-model §1 rule 4).
  const ids = new Map();
  {
    let anchor = '';
    let n = 0;
    for (const s of steps) {
      const id = s.meta.model_api_content_id;
      if (id) {
        anchor = id;
        n = 0;
        ids.set(s, id);
      } else ids.set(s, `${anchor}+${++n}`);
    }
  }

  // A turn has ended when a later step belongs to another execution, or an executor_metadata row
  // names its execution (spec §5).
  const execOf = (s) => s.meta.execution_id || '';
  const laterOther = new Array(steps.length).fill(false);
  {
    const seen = new Set();
    for (let i = steps.length - 1; i >= 0; i--) {
      const x = execOf(steps[i]);
      laterOther[i] = seen.size > (seen.has(x) ? 1 : 0);
      if (x) seen.add(x);
    }
  }
  const ended = new Set();
  for (const r of Object.values(st.executor_metadata)) {
    const e = safeDecode(r.data, S.ExecMeta);
    if (e.execution_id) ended.add(e.execution_id);
  }
  const turnEnded = (i) => laterOther[i] || (execOf(steps[i]) !== '' && ended.has(execOf(steps[i])));

  const gens = new Map(Object.values(st.gen_metadata).map((r) => [Number(r.idx), safeDecode(r.data, S.GenMeta)]));
  // The generation that produced this step, when its step_indices say so.
  const genFor = (s) => {
    const info = infoOf(s);
    const g = gens.get(info.metadata_index || 0);
    if (!g) return null;
    const own = [s.idx, info.step_index || 0];
    return (g.step_indices || []).some((x) => own.includes(x)) ? g : null;
  };

  // Each planner call claims the first later GENERIC step with its id: its result.
  const byCall = new Map();
  for (const s of steps) {
    if (s.type !== T.GENERIC) continue;
    const id = (s.meta.tool_call || {}).id;
    if (!id) continue;
    if (!byCall.has(id)) byCall.set(id, []);
    byCall.get(id).push(s);
  }
  const claimed = new Set();
  const results = new Map(); // planner step -> Map(call id -> GENERIC step)
  for (const s of steps) {
    if (s.type !== T.PLANNER_RESPONSE) continue;
    const m = new Map();
    for (const c of (s.st.planner_response || {}).tool_calls || []) {
      if (!c.id) continue;
      const g = (byCall.get(c.id) || []).find((x) => x.idx > s.idx && !claimed.has(x));
      if (g) {
        claimed.add(g);
        m.set(c.id, g);
      }
    }
    results.set(s, m);
  }

  const written = new Set(); // steps whose message is written (not held)
  const seenIds = new Set();
  const seenUsage = new Set();
  const linkKeys = new Set();
  const putLink = (link, isHeld) => {
    const k = recordKey(link);
    if (linkKeys.has(k)) return;
    linkKeys.add(k);
    if (isHeld) held.link.push(k);
    else recs.push(link);
  };

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const id = ids.get(s);
    if (seenIds.has(id)) continue; // one record per key: the lowest idx wins
    seenIds.add(id);
    const open = OPEN.has(s.status);
    const turnOver = turnEnded(i);
    let hold = open && !turnOver;
    const base = {
      type: 'message', message_id: id, parent_id: null, order: pad(s.idx), agent_id: '',
      to_user: null, to_model: null, status: 'complete', state: 'current', on_active_branch: null,
      ts: iso(s.meta.created_at), requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
    };
    let msg;
    let usage = null;
    const lifecycles = [];

    if (s.type === T.PLANNER_RESPONSE) {
      const pr = s.st.planner_response || {};
      const calls = pr.tool_calls || [];
      const res = results.get(s);
      // A call with no result yet, or one still running: the message waits for it until the turn
      // ends.
      const pending = calls.some((c) => {
        const g = c.id ? res.get(c.id) : null;
        return !g || OPEN.has(g.status);
      });
      if (pending && !turnOver) hold = true;
      const parts = [];
      const sigLen = pr.thinking_signature_len || pr.signature_len || null;
      if (pr.thinking) parts.push({ kind: 'reasoning', text: pr.thinking, signature_len: sigLen });
      else if (pr.thinking_redacted || sigLen) parts.push({ kind: 'reasoning', opaque: true, signature_len: sigLen });
      const text = pr.response || pr.modified_response || '';
      if (text) parts.push({ kind: 'text', text });
      let missing = false;
      calls.forEach((c, k) => {
        const g = c.id ? res.get(c.id) : null;
        if (!g) missing = true;
        const r = ((g && g.st.generic) || {}).result || {};
        parts.push({ kind: 'tool_call', call_id: c.id || `@${id}:${k}`, name: c.name || 'unknown', args: argsOf(c.arguments_json), server: g ? serverOf(r) : null });
      });
      const err = errorText(s.st.error);
      if (err) parts.push({ kind: 'error', error_kind: null, message: err, http_status: null });
      const g = genFor(s);
      const cm = (g && g.chat_model) || {};
      const own = s.meta.model_usage;
      const first = g && (g.step_indices || [])[0];
      const fromGen = !own && g && (first === s.idx || first === infoOf(s).step_index);
      // Served: the generation's response_model, else the model enum's name kept verbatim.
      const served = str(cm.response_model) ?? modelName((own || {}).model || s.meta.generator_model || cm.model);
      const u = own || (fromGen ? cm.usage : null);
      usage = usageRecord(u, own ? s.meta.model_cost : cm.model_cost, served, id);
      msg = {
        ...base, role: 'assistant', source: 'model',
        status: open || (s.status === ST.DONE && missing) ? 'interrupted' : doneStatus(s),
        requested_model: requestedOf(s, cm), served_model: served, response_id: usage ? str(u.response_id) : null, parts,
      };
    } else if (s.type === T.GENERIC) {
      const r = (s.st.generic || {}).result || {};
      const tc = s.meta.tool_call || {};
      const callId = tc.id || `@${id}:0`;
      const err = errorText(s.st.error);
      let part;
      let status;
      if (open) {
        // Its turn ended while it still runs: a background task, or a question waiting for an
        // answer. Written as it stands, and revised when it finishes (memhouse).
        status = 'streaming';
        part = { kind: 'tool_result', call_id: callId, is_error: null, status: null, output: str(r.result), output_len: utf8Len(str(r.result)), truncated: null };
      } else {
        const output = r.result || (s.status === ST.ERROR ? err : '') || '';
        status = doneStatus(s);
        part = {
          kind: 'tool_result', call_id: callId, is_error: s.status === ST.ERROR,
          status: s.status === ST.ERROR && /denied/i.test(err) ? 'denied' : s.status === ST.CANCELED || s.status === ST.INTERRUPTED ? 'cancelled' : 'completed',
          output, output_len: utf8Len(output), truncated: null, exit_code: exitCodeOf(r, s.status),
        };
        // A result agy cut: the whole text is this conversation's steps/<n>/output.txt
        // (full_output_uri), a side source. The uri's folder is not trusted, only its step index.
        // The reference carries that unit's sha256 and length, as read emitted it.
        const m = /\/brain\/([^/]+)\/\.system_generated\/steps\/(\d+)\/output\.txt$/.exec(uriPath(r.full_output_uri));
        const rel = m && m[1] === sid ? outputRel(sid, m[2]) : null;
        const spill = rel ? st.outputs[rel] : null;
        if (spill && spill.bytes > utf8Len(output)) {
          part.output_ref = { ref: rel, sha256: spill.sha256, bytes: spill.bytes };
          part.truncated = true;
        }
      }
      const hidden = !!(r.step_render_info && r.step_render_info.hidden);
      msg = {
        ...base, role: 'tool', source: null, ...(hidden ? { to_user: false, to_model: true } : {}), status,
        parts: [part, ...(r.media || []).map(mediaPart)],
      };
      // The origin side of a sub-agent: the invoke_subagent result names each child.
      const inv = payloadOf(r.payload, 'InvokeSubagent');
      for (const c of (inv && inv.results) || []) {
        if (!c.conversation_id || c.conversation_id === sid) continue;
        putLink({
          type: 'link', kind: 'subagent', stated_on: 'origin', child: { harness: HARNESS, session_id: c.conversation_id }, origin: me,
          at: callId, inherits: null, child_stored: true, evidence: 'explicit',
        }, hold);
      }
    } else {
      // Left open after its turn ended: a crash left it so (memhouse).
      const status = open ? 'interrupted' : doneStatus(s);
      if (s.type === T.USER_INPUT) {
        const ui = s.st.user_input || {};
        const text = ui.user_response || ui.query || (ui.items || []).map((x) => x.text || '').join('');
        const parts = [];
        if (text) parts.push({ kind: 'text', text });
        for (const im of ui.images || []) parts.push(imagePart(im));
        for (const m of ui.media || []) parts.push(mediaPart(m));
        const auto = s.meta.source === SRC.SYSTEM || s.meta.source === SRC.SYSTEM_SDK;
        msg = { ...base, role: 'user', source: auto ? 'automated' : 'user', status, parts };
      } else if (s.type === T.SYSTEM_MESSAGE) {
        const sm = s.st.system_message || {};
        const am = sm.agent_message || {};
        const hidden = !!((sm.render_info && sm.render_info.hidden) || am.hide_from_user);
        msg = {
          ...base, role: 'system', source: systemSource(sm.event_type || '', am.sender || senderOf(sm.message)),
          ...(hidden ? { to_user: false, to_model: true } : {}), status,
          parts: [{ kind: 'notice', text: sm.message || am.content || '', level: null, native_type: str(sm.event_type) ?? 'SYSTEM_MESSAGE' }, ...(sm.media || []).map(mediaPart)],
        };
      } else if (s.type === T.EPHEMERAL_MESSAGE) {
        // A hook's ephemeralMessage, persisted despite its name (spec §4).
        const em = s.st.ephemeral_message || {};
        msg = {
          ...base, role: 'system', source: 'injected', status,
          parts: [{ kind: 'notice', text: em.content || '', level: null, native_type: 'EPHEMERAL_MESSAGE' }, ...(em.media || []).map(mediaPart)],
        };
      } else if (s.type === T.CHECKPOINT) {
        const cp = s.st.checkpoint || {};
        const g = genFor(s);
        const cm = (g && g.chat_model) || {};
        const retried = (s.meta.retry_infos || []).filter((x) => x.usage).pop();
        // The generation's usage counts once, on its first step, as for a planner: a generation
        // whose step_indices span a planner and this checkpoint must not bill twice.
        const firstOfGen = g && (g.step_indices || [])[0];
        const genIsMine = g && (firstOfGen === s.idx || firstOfGen === infoOf(s).step_index);
        const u = s.meta.model_usage || (genIsMine ? cm.usage : null) || (retried && retried.usage) || null;
        const served = str(cm.response_model) ?? modelName((u || {}).model || s.meta.generator_model || cm.model);
        const end = cp.included_step_index_end ?? null;
        usage = usageRecord(u, s.meta.model_cost || cm.model_cost, served, id);
        msg = {
          ...base, role: 'system', source: 'system_notice', status,
          requested_model: requestedOf(s, cm), served_model: served, response_id: usage ? str(u.response_id) : null,
          parts: [{ kind: 'summary', text: cp.session_summary || '', replaces: end !== null ? { through_index: end } : 'unknown' }],
        };
        // The replaced range: the messages written from included_step_index_start through
        // included_step_index_end, the checkpoint itself excluded. Nothing is deleted (spec §5).
        const start = cp.included_step_index_start || 0;
        const covered = steps.filter((p) => p.idx < s.idx && p.idx >= start && (end === null || p.idx <= end) && written.has(p)).map((p) => ids.get(p));
        lifecycles.push({
          type: 'lifecycle', lifecycle_id: id, op: 'compaction',
          target: covered.length ? { range: { from_id: covered[0], through_id: covered[covered.length - 1] } } : { session: true },
          at: null, ts: base.ts, evidence: 'explicit',
        });
      } else {
        msg = { ...base, role: 'system', source: 'system_notice', status, parts: [{ kind: 'notice', text: `[agy step type ${s.type}]`, level: null, native_type: String(s.type) }] };
      }
    }

    msg.parts = msg.parts.map((p, n) => ({ part_id: String(n), ...p }));
    if (usage && seenUsage.has(usage.usage_id)) usage = null;
    if (usage) seenUsage.add(usage.usage_id);
    if (hold) {
      held.message.push(id);
      if (usage) held.usage.push(usage.usage_id);
      for (const l of lifecycles) held.lifecycle.push(l.lifecycle_id);
    } else {
      written.add(s);
      recs.push(msg, ...lifecycles);
      if (usage) recs.push(usage);
    }
  }

  // Rewinds: the DB hard-deletes the rows and keeps no trace; the transcript does (a step_index not
  // above a kept line's). The rewound messages leave through the delta's `gone`; `at` is the
  // message
  // the cut kept last, while it is still in the DB.
  if (st.transcript_key) {
    const lines = transcriptLines(st);
    const byIdx = new Map(steps.map((s) => [s.idx, s]));
    for (const r of foldTranscript(lines)) {
      const keptStep = r.through >= 0 ? byIdx.get(lines[r.through].si) : null;
      recs.push({
        type: 'lifecycle', lifecycle_id: `${st.transcript_key}@${lines[r.at].off}#1`, op: 'rewind',
        target: { session: true }, at: keptStep && written.has(keptStep) ? ids.get(keptStep) : null, ts: null, evidence: 'explicit',
      });
    }
  }

  // Links, child side: a fork (parent_references FORK) and a sub-agent (its parent conversation).
  const refsKey = tableKey(sid, 'parent_references');
  for (const [uk, r] of Object.entries(st.parent_references).sort((a, b) => Number(a[1].idx) - Number(b[1].idx))) {
    const ref = safeDecode(r.data, S.TrajRef);
    if (ref.reference_type !== REF_FORK || !ref.conversation_id || ref.conversation_id === sid) continue;
    // A fork copies the origin's rows verbatim: content ids, and the origin's cascade_id (spec §5).
    const copied = steps.filter((s) => infoOf(s).cascade_id === ref.conversation_id);
    const atStep = copied.find((s) => (infoOf(s).step_index || 0) === (ref.step_index || 0));
    const at = atStep ? ids.get(atStep) : '';
    putLink({
      type: 'link', kind: 'fork', stated_on: 'child', child: me, origin: { harness: HARNESS, session_id: ref.conversation_id }, at,
      inherits: {
        through_message_id: copied.length ? ids.get(copied[copied.length - 1]) : null,
        ids_preserved: true, marked: copied.length > 0, usage_copied: copied.some((s) => !!s.meta.model_usage),
      },
      child_stored: true, evidence: 'explicit',
    }, false);
    recs.push({ type: 'lifecycle', lifecycle_id: `${refsKey}@${uk}#1`, op: 'fork', target: { session: true }, at: at || null, ts: null, evidence: 'explicit' });
  }
  const traj = st.traj ? safeDecode(st.traj.data, S.TrajMeta) : {};
  const sum = st.summary || {};
  const parent = traj.parent_conversation_id || sum.parent_conversation_id || '';
  if (parent && parent !== sid) {
    // at: the parent's invoke_subagent call, which the prompt the child received carries.
    let at = '';
    for (const s of steps) {
      if (s.type !== T.SYSTEM_MESSAGE) continue;
      const tool = ((((s.st.system_message || {}).agent_message || {}).source_metadata) || {}).tool;
      if (!tool || tool.conversation_id !== parent || !tool.tool_call || !tool.tool_call.id) continue;
      if (tool.tool_call.name === 'invoke_subagent') {
        at = tool.tool_call.id;
        break;
      }
      if (!at) at = tool.tool_call.id;
    }
    putLink({ type: 'link', kind: 'subagent', stated_on: 'child', child: me, origin: { harness: HARNESS, session_id: parent }, at, inherits: null, child_stored: true, evidence: 'explicit' }, false);
  }

  const ws = (traj.workspaces || [])[0] || {};
  const cwd = uriPath(ws.workspace_folder_absolute_uri || (traj.workspace_uris || [])[0] || firstJson(sum.workspace_uris)) || null;
  return { recs, held, session: { cwd, created_at: iso(traj.created_at) } };
}

// ---- derive: the transcript alone (no DB) -------------------------------------------------------

// The jsonl has no ids: a message is `@<byte offset of its line>`, allowed because the file is
// append-only (sessions-model §1 rule 4). A rewind appends a lower step_index, which retracts the
// kept lines from that index on: they stay in the file, `state: retracted` (sessions-model §2.6
// (a)). Tools pair by position.
function fromTranscript(st, sid, me) {
  const sk = st.transcript_key;
  const L = transcriptLines(st);
  const rewinds = foldTranscript(L);
  const rewindAt = new Map(rewinds.map((r) => [r.at, r]));
  const idOf = (k) => `@${L[k].off}`;
  const recs = [];
  const held = noHeld();
  const callOf = new Map(); // GENERIC line -> its planner's call id, by position
  const media = (x) => (Array.isArray(x.media) ? x.media : []).map((m) => ({ kind: 'attachment', media_type: (m && m.mime_type) || null, ref: fileRef(m && m.uri), bytes_len: null }));

  for (let i = 0; i < L.length; i++) {
    const rw = rewindAt.get(i);
    if (rw) {
      recs.push({
        type: 'lifecycle', lifecycle_id: `${sk}@${L[i].off}#1`, op: 'rewind',
        target: { range: { from_id: idOf(rw.retracted[0]), through_id: idOf(rw.retracted[rw.retracted.length - 1]) } },
        at: rw.through >= 0 ? idOf(rw.through) : null, ts: null, evidence: 'explicit',
      });
    }
    const { o } = L[i];
    const id = idOf(i);
    const base = {
      type: 'message', message_id: id, parent_id: null, order: pad(L[i].off), agent_id: '',
      to_user: null, to_model: null, status: o.status === 'ERROR' ? 'error' : 'complete', state: L[i].retracted ? 'retracted' : 'current',
      on_active_branch: null, ts: isoOf(o.created_at), requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
    };
    let msg;
    let usage = null;
    let hold = false;
    if (o.type === 'USER_INPUT') {
      const content = String(o.content || '');
      const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content);
      const parts = [{ kind: 'text', text: m ? m[1] : content }];
      // The wrapper's context (the local time, a settings change) is kept as a notice.
      const rest = m ? content.replace(m[0], '').trim() : '';
      if (rest) parts.push({ kind: 'notice', text: rest, level: null, native_type: null });
      parts.push(...media(o));
      const auto = o.source === 'SYSTEM' || o.source === 'SYSTEM_SDK';
      msg = { ...base, role: 'user', source: auto ? 'automated' : 'user', parts };
    } else if (o.type === 'PLANNER_RESPONSE') {
      // Its results: the GENERIC lines after it, by position, up to the next planner or user line
      // or
      // a rewind.
      const res = [];
      let j = i + 1;
      while (j < L.length && !rewindAt.has(j) && L[j].o.type !== 'PLANNER_RESPONSE' && L[j].o.type !== 'USER_INPUT') {
        if (L[j].o.type === 'GENERIC') res.push(j);
        j++;
      }
      const closed = j < L.length || L[i].retracted;
      const calls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
      const pending = calls.some((c, k) => res[k] === undefined || L[res[k]].o.status === 'RUNNING');
      if (pending && !closed) hold = true; // the turn is still open
      const parts = [];
      if (o.thinking) parts.push({ kind: 'reasoning', text: String(o.thinking), signature_len: null });
      if (o.content) parts.push({ kind: 'text', text: String(o.content) });
      let missing = false;
      calls.forEach((c, k) => {
        const callId = `@${id}:${k}`; // sessions-model §1 rule 6: '@' + the call's message id + ':' + index
        if (res[k] !== undefined) callOf.set(res[k], callId);
        else missing = true;
        parts.push({ kind: 'tool_call', call_id: callId, name: String((c && c.name) || 'unknown'), args: c && c.args !== undefined ? c.args : {}, server: null });
      });
      if (o.error) parts.push({ kind: 'error', error_kind: null, message: String(o.error), http_status: null });
      usage = usageRecord({ input_tokens: o.input_tokens, output_tokens: o.output_tokens, cache_read_tokens: o.cache_read_tokens }, null, null, id);
      msg = { ...base, role: 'assistant', source: 'model', status: base.status === 'complete' && missing ? 'interrupted' : base.status, parts };
    } else if (o.type === 'GENERIC') {
      // A RUNNING line is written once and never updated (spec §2): held while it is the tail.
      if (o.status === 'RUNNING' && i === L.length - 1 && !L[i].retracted) hold = true;
      const callId = callOf.get(i) ?? `@${id}:0`;
      const running = o.status === 'RUNNING';
      const isError = o.status === 'ERROR' || !!o.error;
      const output = running ? str(o.content) : String(o.content || o.error || '');
      msg = {
        ...base, role: 'tool', source: null, status: running ? 'streaming' : isError ? 'error' : 'complete',
        parts: [
          {
            kind: 'tool_result', call_id: callId, is_error: running ? null : isError,
            status: running ? null : isError && /denied/i.test(String(o.error || '')) ? 'denied' : 'completed',
            output, output_len: utf8Len(output), truncated: null,
          },
          ...media(o),
        ],
      };
    } else if (o.type === 'CHECKPOINT') {
      msg = { ...base, role: 'system', source: 'system_notice', parts: [{ kind: 'summary', text: String(o.content || ''), replaces: 'unknown' }] };
      const before = recs.filter((r) => r.type === 'message' && r.state === 'current');
      recs.push({
        type: 'lifecycle', lifecycle_id: `${sk}@${L[i].off}#1`, op: 'compaction',
        target: before.length ? { range: { from_id: before[0].message_id, through_id: before[before.length - 1].message_id } } : { session: true },
        at: null, ts: base.ts, evidence: 'explicit',
      });
    } else {
      const source = o.type === 'EPHEMERAL_MESSAGE' ? 'injected' : o.type === 'SYSTEM_MESSAGE' ? systemSource('', senderOf(o.content)) : 'system_notice';
      const text = String(o.content || (o.type ? `[agy ${o.type}]` : ''));
      msg = { ...base, role: 'system', source, parts: [{ kind: 'notice', text, level: null, native_type: str(o.type) }, ...media(o)] };
    }
    msg.parts = msg.parts.map((p, n) => ({ part_id: String(n), ...p }));
    if (hold) {
      held.message.push(id);
      if (usage) held.usage.push(usage.usage_id);
    } else {
      recs.push(msg);
      if (usage) recs.push(usage);
    }
  }
  const sum = st.summary || {};
  if (sum.parent_conversation_id && sum.parent_conversation_id !== sid) {
    recs.push({ type: 'link', kind: 'subagent', stated_on: 'child', child: me, origin: { harness: HARNESS, session_id: sum.parent_conversation_id }, at: '', inherits: null, child_stored: true, evidence: 'explicit' });
  }
  return { recs, held, session: { cwd: uriPath(firstJson(sum.workspace_uris)) || null, created_at: null } };
}

// ---- derive -----------------------------------------------------------------------------------

function emptyState() {
  return {
    state_ver: STATE_VER,
    db: false, // the session has a conversation DB: its tables are sources
    steps: {}, // unit_key -> row-json, per delta table
    gen_metadata: {},
    executor_metadata: {},
    parent_references: {},
    traj: null, // the trajectory_metadata_blob row
    summary: null, // the projected summaries row
    annotation: null, // the .pbtxt text
    transcript_key: null,
    transcript: {}, // byte offset -> the parsed line (null when it does not parse)
    outputs: {}, // spilled output source_key -> {sha256, bytes} of its unit
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
  };
}

function kindOf(sk) {
  if (sk === SUMMARY_KEY) return 'summary';
  const t = /#table:([a-z_]+)$/.exec(sk);
  if (t) return TABLES.includes(t[1]) ? t[1] : null;
  if (sk.endsWith('/transcript_full.jsonl')) return 'transcript';
  if (sk.endsWith('.pbtxt')) return 'annotation';
  if (/\/steps\/\d+\/output\.txt$/.test(sk)) return 'output';
  return null;
}

const last = (units) => units[units.length - 1];

// The units are folded into a serialisable view of every source's current units; the records are
// then built from the whole view, so every split of the units gives the same records, `changed` is
// exactly what moved and `live` is complete.
export function derive(session, input, state) {
  const st = state && state.state_ver === STATE_VER ? structuredClone(state) : emptyState();
  const key = {
    host: session.host, harness: HARNESS, harness_path: session.harness_path,
    session_id: session.session_id, incarnation: session.incarnation ?? '',
  };
  for (const src of input) {
    const sk = src.source_key;
    const units = src.units ?? [];
    const kind = kindOf(sk);
    if (DELTA_TABLES.includes(kind)) {
      st.db = true;
      if (src.complete) st[kind] = {};
      for (const u of units) {
        const o = jsonOf(u);
        if (o && typeof o === 'object' && !Array.isArray(o)) st[kind][u.unit_key] = o;
        else delete st[kind][u.unit_key];
      }
      for (const k of src.gone ?? []) delete st[kind][k];
    } else if (kind === 'trajectory_metadata_blob') {
      st.db = true;
      if (units.length) {
        const rows = (jsonOf(last(units)) || {}).trajectory_metadata_blob || [];
        st.traj = rows.find((r) => r && r.id === 'main') ?? rows[0] ?? null;
      } else if (src.complete) st.traj = null;
    } else if (kind === 'summary') {
      if (units.length) st.summary = ((jsonOf(last(units)) || {}).conversation_summaries || [])[0] ?? null;
      else if (src.complete) st.summary = null;
    } else if (kind === 'annotation') {
      if (units.length) st.annotation = last(units).enc === 'utf8' ? last(units).body : null;
      else if (src.complete) st.annotation = null;
    } else if (kind === 'output') {
      // Its length decides whether a step's text was cut; its sha256 and length go in output_ref.
      if (units.length) st.outputs[sk] = { sha256: last(units).sha256, bytes: last(units).bytes };
      else if (src.complete) delete st.outputs[sk];
    } else if (kind === 'transcript') {
      st.transcript_key = sk;
      if (src.complete) st.transcript = {};
      for (const u of units) st.transcript[u.unit_key] = jsonOf(u);
    }
  }

  const sid = key.session_id;
  const me = { harness: HARNESS, session_id: sid, incarnation: key.incarnation };
  const built = st.db ? fromDb(st, sid, me)
    : st.transcript_key ? fromTranscript(st, sid, me)
      : { recs: [], held: noHeld(), session: { cwd: null, created_at: null } };

  // The records, sealed. The session record's fingerprint and updated_at come from the written
  // messages on the current line, in order.
  const sealed = built.recs.map((r) => seal({ ...r, ...key, type: r.type }));
  const msgs = sealed.filter((r) => r.type === 'message').sort(byOrder);
  let updated = null;
  for (const m of msgs) if (m.ts && (!updated || m.ts > updated)) updated = m.ts;
  const ann = parseAnnotation(st.annotation);
  const sum = st.summary || {};
  const title = str(sum.title) ?? str(ann.title);
  const sessionRec = seal({
    type: 'session', ...key, engine: null, client: 'agy', harness_version: null,
    // The summaries title is generated, and a rename rewrites the annotation (spec §2, §6); which
    // of them a rename also rewrites is not known, so neither is called the user's.
    title, title_set_by: title ? 'unknown' : null,
    cwd: built.session.cwd, last_cwd: null, created_at: built.session.created_at, updated_at: updated,
    state: ann.archived ? 'archived' : 'active', pinned: ann.pinned ? true : null, mode: null, kind: null,
    reuse: 'impossible', ts_source: 'event', aliases: [],
    fingerprint: { cmp_shas: msgs.filter((m) => m.state === 'current').map((m) => m.cmp_sha) },
  });

  const held = built.held;
  const changed = [];
  const live = { session: new Set(), message: new Set(), usage: new Set(), link: new Set(), lifecycle: new Set() };
  for (const r of [sessionRec, ...sealed]) {
    const k = recordKey(r);
    if (live[r.type].has(k)) continue;
    live[r.type].add(k);
    if (st.emitted[r.type][k] !== r.content_sha) {
      st.emitted[r.type][k] = r.content_sha;
      changed.push(r);
    }
  }

  // A key neither live nor held leaves `emitted`, and the consumer tombstones it. A held key keeps
  // its last emitted sha: it is neither rewritten nor tombstoned (sessions §2).
  const liveOut = {};
  for (const type of Object.keys(live)) {
    held[type] = [...new Set(held[type])].filter((k) => !live[type].has(k)).sort();
    for (const k of Object.keys(st.emitted[type])) if (!live[type].has(k) && !held[type].includes(k)) delete st.emitted[type][k];
    liveOut[type] = [...live[type]].sort();
  }
  return {
    changed,
    live: liveOut,
    held,
    state: st,
    checkpoint: true,
    adapter_ver: describeData.adapter_ver,
    model_version: describeData.model_version,
    state_ver: STATE_VER,
  };
}
