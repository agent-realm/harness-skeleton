// Zed (the native agent): `harness_path` is the data folder (`~/.local/share/zed` on Linux). One
// session per row of `threads/threads.db` (SQLite, rollback journal): table `threads(id, summary,
// updated_at, data_type, data, parent_id, folder_paths, folder_paths_order, created_at)`, whose
// `data` is the whole thread as zstd JSON, rewritten on every save. The archive flag lives in each
// channel's workspace DB, `db/<channel>/db.sqlite` (WAL), table `sidebar_threads`. sessions v1 four
// operations over sessions-model v1.1 records.
//
// Ported from memhouse's v4 normaliser (its zed module: the anchored ids, the
// parts, the tool results and their statuses, the hold of an open tool call in the last turn, the
// links, the session fields). New here:
// - two snapshot sources: the thread row, decoded (zstd -> JSON) and redacted in `read`, with the
//   blob's own sha kept as `orig_sha256`; and this thread's sidebar rows, one source per channel;
// - legacy agent-1 threads are filtered in `list` (and `read` refuses them), and a blob that does
//   not decode is `damaged` in `read`: derive never sees either, so it never tombstones a session
//   for want of a readable blob;
// - records in the sessions-model shape: a ToolUse and its result are two parts, `<i>:call` and
//   `<i>:result`, on the Agent message; usage as its own record, one per session from
//   `cumulative_token_usage` (annex §4 finding 6), or, where that is empty, one per turn from
//   `request_token_usage` (sessions-model v1.x (#6), §2.4); the archive and compaction lifecycle
//   records; the hold as derive `held`.
//
// Zed keeps no Agent message id and no timestamp at all: Agent messages are anchored to the
// preceding User `id` (`<user id>+n`, sessions-model §1 rule 4), `order` is the array position and
// every `ts` is null (`ts_source: none`). A checkpoint restore cuts messages[] from the restored
// User message on, and the regrown turn has a new User id, so the regrown Agent messages get new
// keys at the old positions (fixture: restore-lab, a capture).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { SessionsError } from '../../errors.js';
import { isRealFile, makeUnit, jsonOf } from '../../sources.js';
import { openReadOnly, withRead, hasTable, readRowsSnapshot, textOf } from '../../sqlite.js';
import { seal, recordKey } from '../../records.js';
import { sha256, jcs } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'zed';
const STATE_VER = 1;
export const THREADS_REL = 'threads/threads.db';
export const MAIN = `${THREADS_REL}#table:threads`;
export const sidebarRel = (channel) => `db/${channel}/db.sqlite`;
export const sidebarKey = (channel) => `${sidebarRel(channel)}#table:sidebar_threads`;
const SIDEBAR_RE = /^db\/([^/\\#]+)\/db\.sqlite#table:sidebar_threads$/;
// The row's columns, as the table has them (they vary by build, so the table is asked).
const ROW_COLS = ['id', 'summary', 'updated_at', 'data_type', 'parent_id', 'folder_paths', 'folder_paths_order', 'created_at'];
// Zed's own canned tool results (memhouse normaliser, read from Zed's source).
const CANCELLED = new Set(['Tool canceled by user']);
const DENIED = new Set([
  'Permission to run tool denied by user',
  'Permission denied: user sent a follow-up message instead of approving the tool call.',
]);

export function describe() {
  return describeData;
}

// ---- small helpers ----------------------------------------------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? null : String(textOf(v)));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const utf8Len = (s) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : null);
const pad = (i) => String(i).padStart(8, '0');
const iso = (v) => {
  const t = typeof v === 'string' && v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const noHeld = () => ({ session: [], message: [], usage: [], link: [], lifecycle: [] });
const damaged = (sk, why) => new SessionsError('damaged', `${sk}: ${why}`, [sk]);

// The single key of an externally tagged serde enum ({Text: …}), or a unit variant's string.
function variant(v) {
  if (typeof v === 'string') return [v, null];
  if (isObj(v)) {
    const k = Object.keys(v);
    if (k.length === 1) return [k[0], v[k[0]]];
  }
  return [null, null];
}

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)));
}

// ---- the blob ---------------------------------------------------------------------------------

// A `threads.data` value: the thread, or why it cannot be read. `legacy` marks an agent-1 thread
// (messages carrying `role`, format 0.1.0 / 0.2.0), which Zed upgrades to 0.3.0 when it next saves
// it. zstd is node:zlib's (Node >= 22.15, the package floor).
export function decodeThread(data, dataType) {
  if (data == null) return { error: 'no data' };
  const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data), 'utf8');
  const type = dataType == null || dataType === '' ? 'zstd' : String(dataType);
  let thread;
  try {
    if (type === 'zstd') thread = JSON.parse(zlib.zstdDecompressSync(buf).toString('utf8'));
    else if (type === 'json') thread = JSON.parse(buf.toString('utf8'));
    else return { buf, error: `data_type ${type}` };
  } catch (e) {
    return { buf, error: e.message };
  }
  if (!isObj(thread) || !Array.isArray(thread.messages)) return { buf, error: 'not a thread' };
  const legacy = thread.messages.some((m) => isObj(m) && 'role' in m)
    || (typeof thread.version === 'string' && /^0\.[0-2](\.|$)/.test(thread.version));
  return { buf, thread, legacy };
}

// ---- redaction (sessions-model §4; the paths are declared in describe.js) -----------------------

function marker(v) {
  return `<redacted len=${typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : Buffer.byteLength(jcs(v), 'utf8')}>`;
}

// The thread with every value on a declared path replaced; null and '' (nothing held) stay.
function redactThread(thread) {
  let redacted = false;
  const hide = (v) => {
    if (v == null || v === '') return v;
    redacted = true;
    return marker(v);
  };
  const out = { ...thread };
  if ('draft_prompt' in out) out.draft_prompt = hide(out.draft_prompt);
  const snap = out.initial_project_snapshot;
  if (isObj(snap) && Array.isArray(snap.worktree_snapshots)) {
    out.initial_project_snapshot = {
      ...snap,
      worktree_snapshots: snap.worktree_snapshots.map((w) => {
        if (!isObj(w) || !isObj(w.git_state)) return w;
        const g = { ...w.git_state };
        for (const k of ['remote_url', 'diff']) if (k in g) g[k] = hide(g[k]);
        return { ...w, git_state: g };
      }),
    };
  }
  return { thread: out, redacted };
}

// ---- the databases ----------------------------------------------------------------------------

// Every threads row (data included: list decodes it to leave legacy threads out), or one. null
// when there is no threads.db.
function readThreads(root, only = null) {
  if (!isRealFile(root, THREADS_REL)) return null;
  const db = openReadOnly(root, THREADS_REL, MAIN);
  try {
    return withRead(db, MAIN, (d) => {
      if (!hasTable(d, 'threads')) return [];
      const cols = columnsOf(d, 'threads');
      if (!cols.has('id')) return [];
      const sel = [...ROW_COLS.filter((c) => cols.has(c)), cols.has('data') ? 'data' : 'NULL AS data'].join(', ');
      return only === null
        ? d.prepare(`SELECT ${sel} FROM threads WHERE id IS NOT NULL ORDER BY id`).all()
        : d.prepare(`SELECT ${sel} FROM threads WHERE id = ?`).all(only);
    });
  } finally {
    db.close();
  }
}

// The channels that have a workspace DB: `db/<channel>/db.sqlite`, a real file (never through a
// symlink: sources.js isRealFile), in name order.
function channelsOf(root) {
  let entries;
  try {
    if (fs.lstatSync(path.join(root, 'db')).isSymbolicLink()) return [];
    entries = fs.readdirSync(path.join(root, 'db'), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
  return entries.filter((e) => e.isDirectory() && !/[#\\]/.test(e.name) && isRealFile(root, sidebarRel(e.name)))
    .map((e) => e.name).sort(cmpStr);
}

// One channel's sidebar rows, projected to what derive reads (`session_id`, `archived`): of every
// thread, or of `only`. A channel DB without the table (or its columns) has none; a lock or a
// damaged page throws `busy` / `damaged`, never an absent flag.
function sidebarRows(root, channel, only = null) {
  const sk = sidebarKey(channel);
  const db = openReadOnly(root, sidebarRel(channel), sk);
  try {
    return withRead(db, sk, (d) => {
      if (!hasTable(d, 'sidebar_threads')) return [];
      const cols = columnsOf(d, 'sidebar_threads');
      if (!cols.has('session_id') || !cols.has('archived')) return [];
      const by = cols.has('thread_id') ? 'thread_id' : 'rowid';
      return only === null
        ? d.prepare(`SELECT session_id, archived FROM sidebar_threads WHERE session_id IS NOT NULL ORDER BY ${by}`).all()
        : d.prepare(`SELECT session_id, archived FROM sidebar_threads WHERE session_id = ? ORDER BY ${by}`).all(only);
    });
  } finally {
    db.close();
  }
}

// ---- list -------------------------------------------------------------------------------------

// One session per threads row whose blob is not a legacy agent-1 thread. A blob that does not decode
// is listed: read reports it `damaged`, and the session keeps its last derived state. `updated_hint`
// moves with the row's columns, the blob's sha, and this thread's sidebar rows in every channel.
export function list(store) {
  const root = store.harness_path;
  const rows = readThreads(root);
  if (!rows || !rows.length) return [];
  const side = new Map(); // session_id -> Map(channel -> [archived])
  for (const ch of channelsOf(root)) {
    for (const r of sidebarRows(root, ch)) {
      const sid = str(r.session_id);
      if (!side.has(sid)) side.set(sid, new Map());
      const m = side.get(sid);
      if (!m.has(ch)) m.set(ch, []);
      m.get(ch).push(Number(r.archived) || 0);
    }
  }
  const out = [];
  for (const r of rows) {
    const sid = str(r.id);
    if (!sid) continue;
    const dec = decodeThread(r.data, str(r.data_type));
    if (dec.legacy) continue;
    const channels = side.has(sid) ? [...side.get(sid)].sort((a, b) => cmpStr(a[0], b[0])) : [];
    const hint = [ROW_COLS.map((c) => (c in r ? str(r[c]) : null)), dec.buf ? sha256(dec.buf) : null, channels];
    out.push({
      session_id: sid,
      incarnation: '',
      updated_hint: sha256(JSON.stringify(hint)).slice(0, 32),
      live: 'unknown',
      sources: [
        { source_key: MAIN, role: 'main', mode: 'snapshot', position_kind: 'snapshot' },
        ...channels.map(([ch]) => ({ source_key: sidebarKey(ch), role: 'side', mode: 'snapshot', position_kind: 'snapshot' })),
      ],
    });
  }
  return out.sort((a, b) => cmpStr(a.session_id, b.session_id));
}

// ---- read -------------------------------------------------------------------------------------

const noSession = (sid, why = '') => new SessionsError('session_unknown', `no session ${sid}${why}`, [sid]);

// The thread row as one unit: its columns, `data` decoded and redacted, and `orig_sha256`.
function readThread(root, sid, from) {
  const rows = readThreads(root, sid);
  if (!rows || !rows.length) throw noSession(sid);
  const r = rows[0];
  const dec = decodeThread(r.data, str(r.data_type));
  if (dec.legacy) throw noSession(sid, ': a legacy agent-1 thread, read once Zed saves it as 0.3.0');
  if (dec.error) throw damaged(MAIN, `the data of thread ${sid} does not decode (${dec.error})`);
  const red = redactThread(dec.thread);
  const body = {};
  for (const c of ROW_COLS) if (c in r) body[c] = str(r[c]);
  body.data = red.thread;
  body.orig_sha256 = sha256(dec.buf);
  const u = makeUnit(MAIN, MAIN, Buffer.from(jcs(body), 'utf8'), red.redacted);
  u.enc = 'row-json';
  if (from && from.sha256 === u.sha256) return { continuity: 'unchanged', units: [], gone: [], position: from, held_back: [] };
  return { continuity: from ? 'snapshot' : 'reset', units: [u], gone: [], position: { sha256: u.sha256 }, held_back: [] };
}

export function read(store, session, sourceKey, from = null, known = null) {
  const root = store.harness_path;
  const sid = String(session.session_id);
  const m = SIDEBAR_RE.exec(String(sourceKey));
  if (sourceKey !== MAIN && !m) throw new SessionsError('source_unknown', `${sourceKey} is not a zed source`, [sourceKey]);
  if (sourceKey === MAIN) return readThread(root, sid, from);
  // A sidebar source: the thread must still be there; then this channel's rows for it (none once
  // they are gone: a snapshot of no rows).
  const rows = readThreads(root, sid);
  if (!rows || !rows.length) throw noSession(sid);
  if (!isRealFile(root, sidebarRel(m[1]))) throw new SessionsError('source_unknown', `${sourceKey} is not there`, [sourceKey]);
  return readRowsSnapshot(sourceKey, { sidebar_threads: sidebarRows(root, m[1], sid) }, from);
}

// ---- derive -----------------------------------------------------------------------------------

function emptyState() {
  return {
    state_ver: STATE_VER,
    thread: null, // the threads unit: the row, `data` decoded
    sidebar: {}, // source_key -> {sidebar_threads: [rows]}
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
  };
}

// Both sources are snapshots: the state keeps the current unit of each, and every derive builds
// the records from all of them. Any split of the units, in any source order, gives the same records.
export function derive(session, input, state) {
  const st = state && state.state_ver === STATE_VER ? structuredClone(state) : emptyState();
  const key = {
    host: session.host, harness: HARNESS, harness_path: session.harness_path,
    session_id: session.session_id, incarnation: session.incarnation ?? '',
  };
  for (const src of input) {
    const units = src.units ?? [];
    const sidebar = SIDEBAR_RE.test(src.source_key);
    if (src.source_key !== MAIN && !sidebar) continue;
    let value;
    if (units.length) {
      const o = jsonOf(units[units.length - 1]);
      value = isObj(o) ? o : null;
    } else if (src.complete) value = null;
    else continue;
    if (sidebar) {
      if (value) st.sidebar[src.source_key] = value;
      else delete st.sidebar[src.source_key];
    } else st.thread = value;
  }

  const { out, held } = build(st, key);

  const changed = [];
  const live = noHeld();
  const cmp = [];
  const put = (r) => {
    const sealed = seal({ type: r.type, ...key, ...r });
    const k = recordKey(sealed);
    live[sealed.type].push(k);
    if (st.emitted[sealed.type][k] !== sealed.content_sha) {
      st.emitted[sealed.type][k] = sealed.content_sha;
      changed.push(sealed);
    }
    return sealed;
  };
  let sessionRec = null;
  for (const r of out) {
    if (r.type === 'session') {
      sessionRec = r;
      continue;
    }
    const sealed = put(r);
    if (sealed.type === 'message') cmp.push(sealed.cmp_sha);
  }
  if (sessionRec) put({ ...sessionRec, fingerprint: { cmp_shas: cmp } });

  // A key neither live nor held leaves `emitted`, and the consumer tombstones it. A held key keeps
  // its last emitted sha: it is neither rewritten nor tombstoned (sessions §2).
  for (const type of Object.keys(live)) {
    const keep = new Set([...live[type], ...held[type]]);
    for (const k of Object.keys(st.emitted[type])) if (!keep.has(k)) delete st.emitted[type][k];
    live[type].sort();
    held[type] = [...new Set(held[type])].sort();
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

// ---- the fold: parts ----------------------------------------------------------------------------

// LanguageModelToolUseInput: {type: json|text, value}, or (older) the bare JSON, else raw_input.
function argsOf(tu) {
  const inp = tu.input;
  if (isObj(inp) && Object.keys(inp).length === 2 && typeof inp.type === 'string' && 'value' in inp) {
    if (inp.type === 'json') return inp.value ?? {};
    if (inp.type === 'text') return { raw: String(inp.value ?? '') };
  }
  if (inp != null) return inp;
  if (typeof tu.raw_input === 'string' && tu.raw_input) {
    try {
      return JSON.parse(tu.raw_input);
    } catch {
      return { raw: tu.raw_input };
    }
  }
  return {};
}

// LanguageModelToolResultContent, one or a list: Text | Image, in any of serde's accepted shapes.
function resultText(content) {
  const one = (c) => {
    if (typeof c === 'string') return c;
    if (!isObj(c)) return '';
    const key = (n) => Object.keys(c).find((k) => k.toLowerCase() === n);
    const t = key('text');
    if (t && typeof c[t] === 'string' && (Object.keys(c).length === 1 || String(c[key('type')] || '').toLowerCase() === 'text')) return c[t];
    if (key('image')) return '[image]';
    return '';
  };
  return Array.isArray(content) ? content.map(one).join('') : one(content);
}

// A content item the model has no kind for: kept as a notice (sessions-model §2.3, never dropped).
const notice = (pid, k, v) => ({ part_id: pid, kind: 'notice', text: jcs(v ?? null), level: null, native_type: k });

function userParts(content) {
  const parts = [];
  (Array.isArray(content) ? content : []).forEach((c, i) => {
    const pid = String(i);
    const [k, v] = variant(c);
    if (k === 'Text' && typeof v === 'string') parts.push({ part_id: pid, kind: 'text', text: v });
    else if (k === 'Mention' && isObj(v)) {
      // The mentioned context as the model got it, not typed by the user: a part-level `source`
      // (sessions-model §2.3). The mention's URI is not kept.
      parts.push({ part_id: pid, kind: 'text', text: String(v.content ?? ''), source: 'injected' });
    } else if (k === 'Image' && isObj(v)) {
      // LanguageModelImage: `source` is base64 PNG (memhouse normaliser, from Zed's source).
      const ok = typeof v.source === 'string' && v.source !== '';
      parts.push({ part_id: pid, kind: 'attachment', media_type: 'image/png', inline: ok ? v.source : null, ref: null, bytes_len: ok ? Buffer.from(v.source, 'base64').length : null });
    } else parts.push(notice(pid, k, c));
  });
  return parts;
}

// `reasoning_details` (provider-shaped JSON): readable text where an entry has some, else opaque.
function reasoningDetailsPart(rd) {
  if (rd == null) return null;
  const texts = [];
  for (const e of Array.isArray(rd) ? rd : [rd]) {
    if (typeof e === 'string') texts.push(e);
    else if (isObj(e) && typeof e.text === 'string' && e.text) texts.push(e.text);
    else if (isObj(e) && typeof e.summary === 'string' && e.summary) texts.push(e.summary);
  }
  return texts.length
    ? { part_id: 'reasoning_details', kind: 'reasoning', text: texts.join('\n'), signature_len: null }
    : { part_id: 'reasoning_details', kind: 'reasoning', opaque: true, signature_len: null };
}

// An Agent message's parts. A ToolUse and its result (`tool_results[<ToolUse.id>]`) are two parts,
// `<i>:call` and `<i>:result`, sharing the call id (sessions-model §2.3). `open`: a call with no
// result, or whose input is still streaming; `unanswered`: a call with no result; `spawns`:
// [call_id, child thread id] of each spawn_agent result naming its thread.
function agentParts(msg, messageId) {
  const parts = [];
  let open = false;
  let unanswered = false;
  let thinking = false;
  const spawns = [];
  const results = isObj(msg.tool_results) ? msg.tool_results : {};
  (Array.isArray(msg.content) ? msg.content : []).forEach((c, i) => {
    const pid = String(i);
    const [k, v] = variant(c);
    if (k === 'Text' && typeof v === 'string') parts.push({ part_id: pid, kind: 'text', text: v });
    else if (k === 'Thinking' && isObj(v)) {
      thinking = true;
      const text = typeof v.text === 'string' ? v.text : '';
      const sig = typeof v.signature === 'string' && v.signature ? v.signature.length : null;
      if (text) parts.push({ part_id: pid, kind: 'reasoning', text, signature_len: sig });
      else if (sig) parts.push({ part_id: pid, kind: 'reasoning', opaque: true, signature_len: sig });
    } else if (k === 'RedactedThinking') {
      thinking = true;
      parts.push({ part_id: pid, kind: 'reasoning', opaque: true, signature_len: typeof v === 'string' ? v.length : null });
    } else if (k === 'ToolUse' && isObj(v)) {
      const native = v.id == null || v.id === '' ? null : String(v.id);
      // sessions-model §1 rule 6: no native id, `@<message_id>:<index>`.
      const callId = native ?? `@${messageId}:${i}`;
      const name = v.name ? String(v.name) : 'unknown';
      parts.push({ part_id: `${pid}:call`, kind: 'tool_call', call_id: callId, name, args: argsOf(v), server: null });
      const r = native !== null && Object.prototype.hasOwnProperty.call(results, native) ? results[native] : null;
      if (!isObj(r)) {
        open = true;
        unanswered = true;
        return;
      }
      if (v.is_input_complete === false) open = true;
      const output = resultText(r.content);
      const status = CANCELLED.has(output) ? 'cancelled' : DENIED.has(output) ? 'denied' : 'completed';
      parts.push({
        part_id: `${pid}:result`, kind: 'tool_result', call_id: callId,
        // Unreliable as stored (a failing command has false, annex §2): kept only when true. It
        // describes a call that completed (sessions-model v1.x (#6), §2.3): Zed's canned cancel and
        // denial results (`cancelled`, `denied`) give null, though Zed stores true, and the status
        // carries the fact.
        is_error: status === 'completed' && r.is_error === true ? true : null,
        status,
        output, output_len: utf8Len(output), truncated: null,
      });
      if (name === 'spawn_agent') {
        let child = isObj(r.output) && typeof r.output.session_id === 'string' ? r.output.session_id : null;
        if (!child) {
          try {
            const j = JSON.parse(output);
            child = isObj(j) && typeof j.session_id === 'string' ? j.session_id : null;
          } catch {
            child = null;
          }
        }
        if (child) spawns.push([callId, child]);
      }
    } else parts.push(notice(pid, k, c));
  });
  if (!thinking) {
    const rd = reasoningDetailsPart(msg.reasoning_details);
    if (rd) parts.unshift(rd);
  }
  return { parts, open, unanswered, spawns };
}

// A TokenUsage object: Zed omits zero counters, so an absent counter is null; all absent is no usage.
function usageFields(u) {
  if (!isObj(u)) return null;
  const count = (v) => {
    const x = Number(v);
    return v != null && Number.isFinite(x) && x >= 0 ? Math.trunc(x) : null;
  };
  const x = { input: count(u.input_tokens), output: count(u.output_tokens), cache_read: count(u.cache_read_input_tokens), cache_write: count(u.cache_creation_input_tokens) };
  if (Object.values(x).every((v) => v === null)) return null;
  return { ...x, reasoning: null, cost: null };
}

// folder_paths: lexicographic, `\n`-separated; folder_paths_order: each path's original position.
function firstFolder(row, thread) {
  const paths = row.folder_paths ? String(row.folder_paths).split('\n').filter(Boolean) : [];
  if (paths.length) {
    const order = String(row.folder_paths_order || '').split(',').map((s) => Number.parseInt(s, 10));
    const j = order.length === paths.length ? order.indexOf(0) : -1;
    return paths[j >= 0 ? j : 0];
  }
  const ws = isObj(thread.initial_project_snapshot) ? thread.initial_project_snapshot.worktree_snapshots : null;
  return Array.isArray(ws) && isObj(ws[0]) && typeof ws[0].worktree_path === 'string' ? ws[0].worktree_path : null;
}

// ---- the fold: records --------------------------------------------------------------------------

// Every record of the thread, and the keys held as incomplete. Messages in array order; the
// session record last.
function build(st, key) {
  const out = [];
  const held = noHeld();
  const row = st.thread;
  if (!isObj(row)) return { out, held };
  const t = isObj(row.data) ? row.data : { messages: [] };
  const msgs = Array.isArray(t.messages) ? t.messages : [];
  const sid = key.session_id;
  const self = { harness: HARNESS, session_id: sid };
  const model = isObj(t.model) && t.model.model != null && t.model.model !== '' ? String(t.model.model) : null;
  const effort = t.thinking_effort == null || t.thinking_effort === '' ? null : String(t.thinking_effort);

  // The last User message: a later one closes every turn before it.
  let lastUser = -1;
  msgs.forEach((m, i) => {
    if (variant(m)[0] === 'User') lastUser = i;
  });

  const message = (id, i, fields) => ({
    type: 'message', message_id: id, parent_id: null, order: pad(i), agent_id: '', to_user: true, to_model: true,
    status: 'complete', state: 'current', on_active_branch: null, ts: null, requested_model: null, served_model: null,
    effort: null, response_id: null, aliases: [], ...fields,
  });

  let anchor = sid; // before any User message, the thread id anchors (memhouse)
  let n = 0;
  let firstId = null;
  let prevId = null;
  let holding = false; // the last turn is still running: this message and every later one are held
  let heldTurn = null; // the User id that anchors the held turn
  let lc = 0;
  const spawned = new Map(); // child thread id -> call id
  for (let i = 0; i < msgs.length; i++) {
    const [k, v] = variant(msgs[i]);
    if (k === 'User' && isObj(v) && v.id != null && v.id !== '') {
      anchor = String(v.id);
      n = 0;
      out.push(message(anchor, i, { role: 'user', source: 'user', parts: userParts(v.content) }));
      firstId ??= anchor;
      prevId = anchor;
      continue;
    }
    const id = `${anchor}+${++n}`;
    let rec;
    let lifecycle = null;
    if (k === 'User' && isObj(v)) {
      // A User message without its id (an older build): anchored like the others.
      rec = message(id, i, { role: 'user', source: 'user', parts: userParts(v.content) });
    } else if (k === 'Agent' && isObj(v)) {
      const a = agentParts(v, id);
      // An open call in the last turn: Zed is still running it (memhouse held back the rest too).
      if (a.open && i > lastUser && !holding) {
        holding = true;
        heldTurn = anchor;
      }
      rec = message(id, i, {
        role: 'assistant', source: 'model', status: a.unanswered ? 'interrupted' : 'complete',
        requested_model: model, effort, parts: a.parts,
      });
      if (!holding) for (const [callId, child] of a.spawns) if (child !== sid && !spawned.has(child)) spawned.set(child, callId);
    } else if (k === 'Resume') {
      // The "continue" Zed sends as a user turn (source-read, memhouse).
      rec = message(id, i, { role: 'user', source: 'automated', to_user: null, parts: [{ part_id: '0', kind: 'notice', text: 'Resume', level: null, native_type: 'Resume' }] });
    } else if (k === 'Compaction') {
      // Compaction{Summary: text} | {ProviderNative: …} (source-read, memhouse; UNVERIFIED).
      const [ck, cv] = variant(v);
      rec = message(id, i, {
        role: 'system', source: 'automated', to_user: null,
        parts: [{ part_id: '0', kind: 'summary', text: ck === 'Summary' && typeof cv === 'string' ? cv : null, replaces: prevId ? { through_id: prevId } : 'unknown' }],
      });
      lifecycle = {
        type: 'lifecycle', lifecycle_id: `${MAIN}@${MAIN}#${++lc}`, op: 'compaction',
        target: firstId && prevId ? { range: { from_id: firstId, through_id: prevId } } : { session: true },
        at: id, ts: null, evidence: 'explicit',
      };
    } else {
      // A message kind this adapter does not know: kept, as a notice, and counted.
      rec = message(id, i, { role: 'system', source: 'system_notice', to_user: null, to_model: null, parts: [notice('0', k, msgs[i])] });
    }
    if (holding) {
      held.message.push(id);
      if (lifecycle) held.lifecycle.push(lifecycle.lifecycle_id);
    } else {
      out.push(rec);
      if (lifecycle) out.push(lifecycle);
    }
    firstId ??= id;
    prevId = id;
  }

  // Usage: one record, the thread's total `cumulative_token_usage`, per session and never spread
  // (annex §4 finding 6: "per_session only: … zed cumulative"). `request_token_usage[<user id>]`
  // holds only a turn's last request, overwritten by each request of the turn, and is part of
  // that total (annex §2: "The per-turn value is not a turn total"); a record of its own beside
  // the total would count those tokens twice. It stays in the raw unit.
  // Where the cumulative is empty, the entries are all the usage the thread keeps: one record per
  // entry, anchored to the User message it is keyed by, per_turn, both flags null; never a zero
  // record, and not "no usage" (sessions-model v1.x (#6), §2.4 "No overlap"). Fixtures: features
  // (the held thread), restore. The running turn's entry is held with its reply (sessions §2). An
  // entry keyed by a User message the thread no longer holds (after a checkpoint restore) is still
  // emitted, anchored to that id: it is spend, and its key stays across the restore (tested on a
  // synthetic save; restore-lab's restore cleared every entry).
  const total = usageFields(t.cumulative_token_usage);
  if (total) out.push({ type: 'usage', usage_id: 'session#1', anchor: { session: true }, ...total, input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_session', model: null });
  else if (isObj(t.request_token_usage)) {
    for (const uid of Object.keys(t.request_token_usage).sort(cmpStr)) {
      const turn = usageFields(t.request_token_usage[uid]);
      if (!uid || !turn) continue;
      const usageId = `message:${uid}#1`;
      if (holding && uid === heldTurn) held.usage.push(usageId);
      else out.push({ type: 'usage', usage_id: usageId, anchor: { message_id: uid }, ...turn, input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_turn', model: null });
    }
  }

  // Archive: a flag in each channel's sidebar, no time. One record per channel unit that says so.
  let archived = false;
  for (const sk of Object.keys(st.sidebar).sort(cmpStr)) {
    const rows = Array.isArray(st.sidebar[sk].sidebar_threads) ? st.sidebar[sk].sidebar_threads : [];
    if (!rows.some((r) => isObj(r) && Number(r.archived) === 1)) continue;
    archived = true;
    out.push({ type: 'lifecycle', lifecycle_id: `${sk}@${sk}#1`, op: 'archive', target: { session: true }, at: null, ts: null, evidence: 'explicit' });
  }

  // Sub-agents: the child states its parent (subagent_context, else the row's parent_id); the
  // parent states each child a spawn_agent result names, at that call.
  const sub = isObj(t.subagent_context) ? t.subagent_context : null;
  const origin = (sub && sub.parent_thread_id ? String(sub.parent_thread_id) : '') || str(row.parent_id) || '';
  if (origin && origin !== sid) {
    out.push({ type: 'link', kind: 'subagent', stated_on: 'child', child: self, origin: { harness: HARNESS, session_id: origin }, at: '', inherits: null, child_stored: true, evidence: 'explicit' });
  }
  for (const [child, callId] of spawned) {
    out.push({ type: 'link', kind: 'subagent', stated_on: 'origin', child: { harness: HARNESS, session_id: child }, origin: self, at: callId, inherits: null, child_stored: null, evidence: 'explicit' });
  }

  const title = str(row.summary) || (typeof t.title === 'string' && t.title ? t.title : null);
  out.push({
    type: 'session',
    engine: null,
    client: 'zed',
    // The thread's `version` is its format version (0.3.0), not Zed's.
    harness_version: null,
    title,
    title_set_by: title ? 'unknown' : null,
    cwd: firstFolder(row, t),
    last_cwd: null,
    created_at: iso(str(row.created_at)),
    // The row's and the thread's `updated_at` move with every save and are not read.
    updated_at: null,
    state: archived ? 'archived' : 'active',
    pinned: null,
    mode: t.profile ? String(t.profile) : null,
    // `kind` is the native session type, and a parent reference is not a kind: subagent_context and
    // the row's parent_id leave it null. The sub-agent fact is the child-side `subagent` link above.
    // sessions-model v1.x (#6), §2.1.
    kind: null,
    reuse: 'impossible',
    ts_source: 'none',
    aliases: [],
  });
  return { out, held };
}
