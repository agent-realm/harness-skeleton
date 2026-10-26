// Codex: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<stamp>-<session>.jsonl`, an append-only JSONL
// per rollout, moved under `archived_sessions/` when the session is archived. sessions v1 four
// operations over sessions-model v1.1 records.
//
// Ported from memhouse's v3 reader (its Codex module: the turn boundaries,
// the token delta rule, boot-context detection, the output error rule).
// New here: records in the sessions-model shape, one usage record per turn, the compaction
// lifecycle record, one speaker per message, source keys relative to CODEX_HOME.

import fs from 'node:fs';
import path from 'node:path';
import { SessionsError } from '../../errors.js';
import { readStream, streamUnits, unknownSource, plainRel, jsonOf } from '../../sources.js';
import { seal, recordKey } from '../../records.js';
import { sha256 } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'codex';
const STATE_VER = 2;
const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const ROOTS = ['sessions', 'archived_sessions'];
const ARCHIVED = 'archived_sessions/';
const LINE1_MAX = 1024 * 1024;

export function describe() {
  return describeData;
}

// ---- list -------------------------------------------------------------------------------------

// A directory's entries, or none when it is missing or reached through a symlink: list never
// walks through a symlink, and read refuses one (src/sources.js openSource), so the two agree.
function readdir(dir) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return [];
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
}

function walk(harnessPath, rel, out) {
  for (const e of readdir(path.join(harnessPath, rel))) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(harnessPath, r, out);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(r);
  }
}

// Line 1 of a rollout, or null while it is partial (or the file is gone).
function firstLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(LINE1_MAX);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    return nl < 0 ? null : buf.subarray(0, nl).toString('utf8');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// The UUID in the file name, else line 1's `session_meta.payload.id`, else the base name.
function sessionIdOf(harnessPath, rel) {
  const base = path.posix.basename(rel);
  const m = ROLLOUT_ID.exec(base);
  if (m) return m[1];
  let o = null;
  try {
    o = JSON.parse(firstLine(path.join(harnessPath, rel)) ?? '');
  } catch {
    o = null;
  }
  if (o && o.type === 'session_meta' && o.payload && typeof o.payload.id === 'string' && o.payload.id) return o.payload.id;
  return base.slice(0, -'.jsonl'.length);
}

// Every rollout under sessions/ and archived_sessions/, grouped by session id. Several rollouts
// with one id are several `main` sources of one session (sessions §1).
function scan(harnessPath) {
  const sessions = new Map();
  for (const root of ROOTS) {
    const files = [];
    walk(harnessPath, root, files);
    for (const rel of files) {
      const sid = sessionIdOf(harnessPath, rel);
      if (!sessions.has(sid)) sessions.set(sid, []);
      sessions.get(sid).push({ source_key: rel, role: 'main' });
    }
  }
  for (const srcs of sessions.values()) srcs.sort((a, b) => (a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0));
  return sessions;
}

function sourceStat(harnessPath, sourceKey) {
  try {
    const st = fs.statSync(path.join(harnessPath, sourceKey));
    return [sourceKey, st.size, Math.trunc(st.mtimeMs)];
  } catch {
    return [sourceKey, -1, -1];
  }
}

export function list(store) {
  const out = [];
  for (const [sid, srcs] of scan(store.harness_path)) {
    out.push({
      session_id: sid,
      incarnation: '',
      updated_hint: sha256(JSON.stringify(srcs.map((s) => sourceStat(store.harness_path, s.source_key)))).slice(0, 32),
      live: 'unknown',
      sources: srcs.map((s) => ({ source_key: s.source_key, role: s.role, mode: 'stream', position_kind: 'byte_offset' })),
    });
  }
  return out.sort((a, b) => (a.session_id < b.session_id ? -1 : 1));
}

// ---- read -------------------------------------------------------------------------------------

export function read(store, session, sourceKey, from = null, known = null) {
  void known; // stream sources ignore `known` (sessions §2, rule 3)
  // Fast path: a rollout whose file name carries this session's id, under one of the two roots,
  // is read without walking the tree. Anything else takes the full scan below.
  const m = /^(?:sessions|archived_sessions)\/(?:[^/]+\/)*rollout-[^/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(sourceKey);
  if (m && m[1].toLowerCase() === String(session.session_id).toLowerCase() && !sourceKey.split('/').includes('..')) {
    let isFile = false;
    try { isFile = fs.lstatSync(path.join(store.harness_path, sourceKey)).isFile(); } catch { /* not there: full scan decides */ }
    if (isFile) return readStream(path.join(store.harness_path, sourceKey), sourceKey, from, { root: store.harness_path });
  }
  const srcs = scan(store.harness_path).get(session.session_id);
  if (!srcs) throw new SessionsError('session_unknown', `no session ${session.session_id}`, [session.session_id]);
  if (!srcs.some((s) => s.source_key === sourceKey)) throw new SessionsError('source_unknown', `${sourceKey} is not a source of ${session.session_id}`, [sourceKey]);
  return readStream(path.join(store.harness_path, sourceKey), sourceKey, from, { root: store.harness_path });
}

// The source keys `walk` names: a `rollout-*.jsonl` at any depth under one of the two roots. All
// are streams.
const SOURCE_KEY = /^(?:sessions|archived_sessions)\/(?:[^/]+\/)*rollout-[^/]*\.jsonl$/;

// The units `read` returns from scratch for a source holding `bytes` (src/index.js
// unitsFromBytes), from the source key alone: no session, no position, no file system.
export function unitsFromBytes(sourceKey, bytes, { start = 0 } = {}) {
  if (!plainRel(sourceKey) || !SOURCE_KEY.test(sourceKey)) throw unknownSource(HARNESS, sourceKey);
  return streamUnits(bytes, sourceKey, { start });
}

// ---- turn boundaries (memhouse's v3 reader, ported as is) -------------------------------------

const ASSISTANT_ITEMS = new Set(['reasoning', 'function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']);
const TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']);

function isTurnMarker(o) { return o.type === 'turn_context' || (o.type === 'event_msg' && !!o.payload && o.payload.type === 'task_started'); }
function isUserMsg(o) { return o.type === 'response_item' && !!o.payload && o.payload.type === 'message' && o.payload.role === 'user'; }
function isTurnEnd(o) { return o.type === 'event_msg' && !!o.payload && (o.payload.type === 'task_complete' || o.payload.type === 'turn_aborted'); }
function turnIdOf(o) { const p = o.payload; return p && typeof p.turn_id === 'string' && p.turn_id ? p.turn_id : null; }
function isActivity(o) {
  if (o.type === 'response_item' && o.payload) {
    return o.payload.type === 'message' ? o.payload.role === 'assistant' : ASSISTANT_ITEMS.has(o.payload.type);
  }
  return o.type === 'event_msg' && !!o.payload && o.payload.type === 'token_count' && !!o.payload.info;
}
function isBoot(text) {
  const t = String(text || '').trim();
  return t.startsWith('<user_instructions>') || t.startsWith('<environment_context>')
    || t.startsWith('# AGENTS.md instructions') || t.startsWith('<INSTRUCTIONS>');
}

// A turn starts at turn_context / task_started, unless it carries the open turn's own turn_id or
// the open turn has seen nothing yet; or at a user message once the open turn has assistant
// activity and has completed (or never had an id: rollouts without turn_context ids).
function unitStart(o, u) {
  if (isTurnMarker(o)) {
    if (!u.open) return true;
    const id = turnIdOf(o);
    if (id && u.turnId) return id !== u.turnId;
    return !u.fresh;
  }
  if (isUserMsg(o)) {
    if (!u.open) return true;
    if (u.turnId && !u.done) return false; // steering inside a turn that has not completed
    return u.active;
  }
  return false;
}

function track(o, u) {
  if (unitStart(o, u)) { u.open = true; u.fresh = true; u.active = false; u.turnId = null; u.done = false; }
  if (isTurnMarker(o)) { if (!u.turnId) u.turnId = turnIdOf(o); return; }
  if (isTurnEnd(o)) { u.done = true; return; }
  if (isUserMsg(o)) return;
  if (isActivity(o)) { u.active = true; u.fresh = false; return; }
  if (o.type === 'response_item' || o.type === 'compacted') u.fresh = false;
}

// ---- tokens (memhouse's delta rule) -----------------------------------------------------------

const TOK = ['input', 'cached', 'output', 'reasoning', 'total', 'cache_write'];
const REPORTED = ['input', 'cached', 'output', 'reasoning'];

// A token usage object as memhouse reads it (absent or negative = 0), plus which of the reported
// fields Codex actually stored: an absent field derives to null, never to a zero.
function rawUsage(v) {
  if (!v || typeof v !== 'object') return null;
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.trunc(x) : 0);
  const has = (x) => typeof x === 'number' && Number.isFinite(x);
  const cached = v.cached_input_tokens != null ? v.cached_input_tokens : v.cache_read_input_tokens;
  return {
    input: n(v.input_tokens), cached: n(cached), output: n(v.output_tokens), reasoning: n(v.reasoning_output_tokens),
    total: n(v.total_tokens), cache_write: n(v.cache_write_input_tokens),
    has: { input: has(v.input_tokens), cached: has(cached), output: has(v.output_tokens), reasoning: has(v.reasoning_output_tokens) },
  };
}
function sameUsage(a, b) { return !!a && !!b && TOK.every((k) => a[k] === b[k]); }
function subUsage(a, b) {
  const out = { has: { ...a.has } };
  for (const k of TOK) out[k] = Math.max(a[k] - (b ? b[k] : 0), 0);
  return out;
}

// ---- derive -----------------------------------------------------------------------------------

function isoTs(v) {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function utf8Len(s) {
  return Buffer.byteLength(s, 'utf8');
}

function str(v) {
  return typeof v === 'string' && v ? v : null;
}

// A tool output as text: the `output` of a JSON-encoded `{output, metadata}`, a string as stored,
// an object's string `content`, else the value's JSON.
function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') {
    try {
      const j = JSON.parse(output);
      if (j && typeof j === 'object' && typeof j.output === 'string') return j.output;
    } catch { /* plain text */ }
    return output;
  }
  if (typeof output === 'object' && typeof output.content === 'string') return output.content;
  return JSON.stringify(output);
}

// A tool output as stored: the parsed `{output, metadata}` object Codex JSON-encodes into the
// `output` string, an object as it is, else null (plain text).
function outputObject(output) {
  let j = output;
  if (typeof output === 'string') {
    try {
      j = JSON.parse(output);
    } catch {
      return null;
    }
  }
  return j && typeof j === 'object' ? j : null;
}

// The shell's exit code, where Codex keeps it apart from the output text: `metadata.exit_code` of
// the `{output, metadata}` object, an integer. A plain-text output ("Exit code: 0" in newer
// rollouts) is never parsed for one (sessions-model §2.3).
function outputExit(output) {
  const j = outputObject(output);
  const code = j && j.metadata && typeof j.metadata === 'object' ? j.metadata.exit_code : undefined;
  return Number.isInteger(code) ? code : null;
}

// memhouse's error rule (`success: false`, or a non-zero `metadata.exit_code`) for true; a stored
// `success: true` or exit code 0 for false; null where the output carries no flag at all.
function outputError(output) {
  const j = outputObject(output);
  if (!j) return null;
  const code = j.metadata && typeof j.metadata === 'object' ? j.metadata.exit_code : undefined;
  if (j.success === false || (typeof code === 'number' && code !== 0)) return true;
  if (j.success === true || code === 0) return false;
  return null;
}

// `arguments` parsed when it is a JSON string; any other args value as stored.
function argsOf(p) {
  if (p.type === 'function_call') {
    if (typeof p.arguments === 'string') {
      try {
        return JSON.parse(p.arguments);
      } catch {
        return p.arguments;
      }
    }
    return p.arguments === undefined ? {} : p.arguments;
  }
  const v = p.type === 'custom_tool_call' ? p.input : p.action;
  return v === undefined ? {} : v;
}

function emptyState() {
  return {
    state_ver: STATE_VER,
    // source_key -> the per-rollout fold: turn tracker, model, effort, running total, open turn.
    src: {},
    srcs: [], // source index -> source_key. An `order` is kept as [source index, padded unit key]
    // (posOf, orderOf), so a big session's state does not repeat the rollout name per record.
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
    msg_order: {}, // message_id -> the position of the emitted version (the lowest order wins)
    // usage_id -> { source index -> [anchor id, input, output, cache_read, reasoning, model] }; the
    // source with the lowest (first_ts, basename, source_key) wins.
    usage_by: {},
    cmp: {}, // message_id -> [source index, padded unit key, cmp_sha]
    // Session fields, each kept with the sort key of the record it came from, so the result does
    // not depend on the order sources are folded in: [ts|order, value].
    session: { client: null, harness_version: null, cwd: null, last_cwd: null, created_at: null, updated_at: null },
  };
}

function newSource(sk) {
  return {
    sk,
    base: path.posix.basename(sk),
    first_ts: null,
    u: { open: false, fresh: false, active: false, turnId: null, done: false },
    model: null,
    effort: null,
    prev: null, // the last running total seen (memhouse `a.prev`)
    turn: null,
  };
}

function newTurn() {
  return {
    id: null,
    first_msg: null,
    first_asst: null,
    tok: { input: 0, cached: 0, output: 0, reasoning: 0 },
    has: { input: false, cached: false, output: false, reasoning: false },
    nonzero: false,
    model: null,
    usage_id: null,
  };
}

// One record per key in its final state (sessions-model §1 rule 5). Messages are immutable once
// emitted, except that a repeated id keeps the version with the lowest `order` (a verbatim copy in
// a second rollout of the same session); usage records and the session record are revised.
export function derive(session, input, state) {
  const st = state && state.state_ver === STATE_VER ? structuredClone(state) : emptyState();
  const key = {
    host: session.host, harness: HARNESS, harness_path: session.harness_path,
    session_id: session.session_id, incarnation: session.incarnation ?? '',
  };
  const out = new Map(); // type\0key -> sealed record, for `changed`
  const put = (r) => {
    const sealed = seal({ type: r.type, ...key, ...r });
    const k = recordKey(sealed);
    if (st.emitted[sealed.type][k] !== sealed.content_sha) {
      st.emitted[sealed.type][k] = sealed.content_sha;
      out.set(sealed.type + '\u0000' + k, sealed);
    }
    return sealed;
  };
  const unput = (type, k) => {
    delete st.emitted[type][k];
    out.delete(type + '\u0000' + k);
  };

  for (const src of input) {
    const sk = src.source_key;
    if (!st.src[sk]) {
      st.src[sk] = { ...newSource(sk), i: st.srcs.length };
      st.srcs.push(sk);
    }
    const s = st.src[sk];
    for (const u of src.units ?? []) {
      const o = jsonOf(u);
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      if (s.first_ts === null) s.first_ts = isoTs(o.timestamp) ?? '';
      foldRecord({ st, s, put, unput }, o, u.unit_key);
    }
  }

  // The session record: always re-sealed, since updated_at and the fingerprint move.
  const v = Object.fromEntries(Object.entries(st.session).map(([k, x]) => [k, x ? x[1] : null]));
  const cmpShas = Object.values(st.cmp).map(([i, uk, sha]) => [orderOf(st, [i, uk]), sha])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
  const keys = Object.keys(st.src);
  put({
    type: 'session',
    engine: null,
    client: v.client,
    harness_version: v.harness_version,
    title: null,
    title_set_by: null,
    cwd: v.cwd,
    last_cwd: v.last_cwd,
    created_at: v.created_at,
    updated_at: v.updated_at,
    // Archiving moves the rollout; a session is archived when every one of its rollouts is.
    state: keys.length && keys.every((k) => k.startsWith(ARCHIVED)) ? 'archived' : 'active',
    pinned: null,
    mode: null,
    kind: null,
    reuse: 'impossible',
    ts_source: 'event',
    aliases: [],
    fingerprint: { cmp_shas: cmpShas },
  });

  const live = {};
  for (const [type, ks] of Object.entries(st.emitted)) live[type] = Object.keys(ks).sort();
  return {
    changed: [...out.values()],
    live,
    // A record is final once its line is whole, so nothing is held: `live`'s five lists, empty
    // (sessions v1 §2; docs/adapter-interface.md, "derive output").
    held: { session: [], message: [], usage: [], link: [], lifecycle: [] },
    state: st,
    checkpoint: true,
    adapter_ver: describeData.adapter_ver,
    model_version: describeData.model_version,
    state_ver: STATE_VER,
  };
}

// Keep the value from the earliest (`first`) or latest record by (ts, order).
function keep(s, field, value, sortKey, first) {
  const cur = s[field];
  if (!cur || (first ? sortKey < cur[0] : sortKey > cur[0])) s[field] = [sortKey, value];
}

// ---- usage: one record per turn ---------------------------------------------------------------

// The turn's usage key: its turn id; without one, its first assistant message, else its first
// message. A turn with neither (token counts alone, no id) has no anchor and no record.
function usageAnchor(t) {
  if (!t.nonzero) return null;
  if (t.id) return { id: `response:${t.id}#1`, anchor: { response_id: t.id } };
  const m = t.first_asst ?? t.first_msg;
  return m ? { id: `message:${m}#1`, anchor: { message_id: m } } : null;
}

// A position and its `order`: `<first_ts>|<basename>|<padded unit key>`, with the source named
// by its index in `srcs`. posOf reads a position back from an order string, which any record
// emitted later (a held turn's) still carries.
function orderOf(st, [i, uk]) {
  const s = st.src[st.srcs[i]];
  return `${s.first_ts}|${s.base}|${uk}`;
}
function posOf(st, order) {
  const j = order.lastIndexOf('|');
  const prefix = order.slice(0, j);
  const i = st.srcs.findIndex((sk) => `${st.src[sk].first_ts}|${st.src[sk].base}` === prefix);
  return [i, order.slice(j + 1)];
}

// Write the usage record a usage_id resolves to: of the rollouts that bill it, the one with the
// lowest (first_ts, basename, source_key); none left, and the key leaves `live`.
function settleUsage(ctx, id) {
  const { st } = ctx;
  const c = st.usage_by[id];
  const cand = (i) => { const s = st.src[st.srcs[i]]; return `${s.first_ts}|${s.base}|${s.sk}`; };
  const ks = c ? Object.keys(c).sort((a, b) => (cand(a) < cand(b) ? -1 : cand(a) > cand(b) ? 1 : 0)) : [];
  if (!ks.length) {
    delete st.usage_by[id];
    ctx.unput('usage', id);
    return;
  }
  const [a, input, output, cacheRead, reasoning, model] = c[ks[0]];
  ctx.put({
    type: 'usage',
    usage_id: id,
    anchor: id.startsWith('response:') ? { response_id: a } : { message_id: a },
    input,
    output,
    cache_read: cacheRead,
    cache_write: null,
    reasoning,
    cost: null,
    // OpenAI usage: cached input and reasoning output are parts of input_tokens and output_tokens
    // (sessions-model §2.4).
    input_includes_cache: true, output_includes_reasoning: true,
    granularity: 'per_turn',
    model,
  });
}

function refreshUsage(ctx) {
  const { st, s } = ctx;
  const t = s.turn;
  const next = usageAnchor(t);
  if (t.usage_id && t.usage_id !== (next && next.id)) {
    const c = st.usage_by[t.usage_id];
    if (c) delete c[s.i];
    settleUsage(ctx, t.usage_id);
  }
  t.usage_id = next ? next.id : null;
  if (!next) return;
  if (!st.usage_by[next.id]) st.usage_by[next.id] = {};
  st.usage_by[next.id][s.i] = [
    Object.values(next.anchor)[0],
    t.has.input ? t.tok.input : null,
    t.has.output ? t.tok.output : null,
    t.has.cached ? t.tok.cached : null,
    t.has.reasoning ? t.tok.reasoning : null,
    t.model,
  ];
  settleUsage(ctx, next.id);
}

// Σ over the turn of each token_count's last_token_usage, else of its running total minus the
// previous one; a running total seen again adds nothing (as memhouse's v3 reader counts it).
function tokens(ctx, p) {
  const { s } = ctx;
  const info = p.info;
  if (!info || typeof info !== 'object') return;
  const total = rawUsage(info.total_token_usage);
  const last = rawUsage(info.last_token_usage);
  if (total && s.prev && sameUsage(total, s.prev)) return;
  let delta = last;
  if (!delta && total) delta = subUsage(total, s.prev);
  if (total) s.prev = total;
  if (!delta) return;
  if (!(delta.input || delta.output || delta.reasoning || delta.cache_write)) return;
  const t = s.turn;
  if (!t) return; // tokens before any turn opens (memhouse counts them as orphans): no record
  for (const k of REPORTED) {
    t.tok[k] += delta[k];
    if (delta.has[k]) t.has[k] = true;
  }
  t.nonzero = true;
  t.model = s.model;
  refreshUsage(ctx);
}

// ---- the fold ---------------------------------------------------------------------------------

function emitMessage(ctx, m) {
  const t = ctx.s.turn;
  if (t) {
    let moved = false;
    if (t.first_msg === null) { t.first_msg = m.message_id; moved = true; }
    if (m.role === 'assistant' && t.first_asst === null) { t.first_asst = m.message_id; moved = true; }
    if (moved && !t.id && t.nonzero) refreshUsage(ctx);
  }
  const prev = ctx.st.msg_order[m.message_id];
  if (prev !== undefined && orderOf(ctx.st, prev) <= m.order) return false;
  const pos = posOf(ctx.st, m.order);
  ctx.st.msg_order[m.message_id] = pos;
  const r = ctx.put({ type: 'message', ...m });
  ctx.st.cmp[m.message_id] = [...pos, r.cmp_sha];
  return true;
}

function noteSession(st, field, value, ts, order, first) {
  if (value === null || value === undefined || value === '') return;
  keep(st.session, field, value, `${ts ?? ''}|${order}`, first);
}

function foldRecord(ctx, o, unitKey) {
  const { st, s } = ctx;
  const order = `${s.first_ts}|${s.base}|${unitKey.padStart(12, '0')}`;
  const ts = isoTs(o.timestamp);
  const p = o.payload && typeof o.payload === 'object' ? o.payload : {};

  // The turn this record belongs to: a pure function of the rollout's records so far.
  const started = unitStart(o, s.u);
  if (started) s.turn = newTurn();
  track(o, s.u);
  if (s.turn && s.turn.id !== s.u.turnId) {
    s.turn.id = s.u.turnId;
    refreshUsage(ctx);
  }

  if (ts) {
    keep(st.session, 'created_at', ts, ts, true);
    keep(st.session, 'updated_at', ts, ts, false);
  }

  if (o.type === 'session_meta') {
    noteSession(st, 'client', str(p.originator), ts, order, false);
    noteSession(st, 'harness_version', str(p.cli_version), ts, order, false);
    noteSession(st, 'cwd', str(p.cwd), ts, order, true);
    noteSession(st, 'last_cwd', str(p.cwd), ts, order, false);
    return;
  }
  if (o.type === 'turn_context') {
    noteSession(st, 'cwd', str(p.cwd), ts, order, true);
    noteSession(st, 'last_cwd', str(p.cwd), ts, order, false);
    if (str(p.model)) s.model = p.model;
    const effort = typeof p.effort === 'string' ? p.effort : typeof p.reasoning_effort === 'string' ? p.reasoning_effort : null;
    if (effort !== null) s.effort = effort || null;
    return;
  }
  if (o.type === 'event_msg') {
    // task_started is a turn marker (above); token_count is the turn's usage. Every other event,
    // including the user_message / agent_message duplicates and turn_aborted, makes no record.
    if (p.type === 'token_count') tokens(ctx, p);
    return;
  }

  const base = {
    parent_id: null, order, agent_id: '',
    to_user: null, to_model: null, status: 'complete', state: 'current', on_active_branch: null, ts,
    requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
  };
  const asst = { role: 'assistant', source: 'model', served_model: s.model, effort: s.effort, response_id: s.u.turnId };
  const injected = { source: 'injected', to_user: false, to_model: true };

  // A compaction: the summary as a system message, and the lifecycle record that names it.
  if (o.type === 'compacted') {
    const mid = `${s.base}@${unitKey}`;
    const text = typeof p.message === 'string' ? p.message : '';
    if (emitMessage(ctx, { ...base, message_id: mid, role: 'system', source: 'automated', parts: [{ part_id: '0', kind: 'summary', text, replaces: 'unknown' }] })) {
      ctx.put({ type: 'lifecycle', lifecycle_id: mid, op: 'compaction', target: { session: true }, at: null, ts, evidence: 'explicit' });
    }
    return;
  }
  if (o.type !== 'response_item') return;

  // message_id: the item's native id, else the line's offset qualified by its rollout, since a
  // session can have several main sources (sessions-model §1 rule 10). The qualifier is the
  // rollout's file name, which survives archiving's move to archived_sessions/ where the
  // source_key does not: `<rollout file name>@<offset>`. The name carries the rollout's creation
  // time and the session's uuid, so it is unique among a session's main sources; the same name
  // in two folders is one rollout (a copy left behind), whose records collapse onto one set.
  const mid = str(p.id) ?? `${s.base}@${unitKey}`;
  base.message_id = mid;

  if (p.type === 'message') {
    const items = Array.isArray(p.content) ? p.content : typeof p.content === 'string' ? [{ type: 'text', text: p.content }] : [];
    const parts = [];
    items.forEach((it, i) => {
      if (!it || typeof it !== 'object') return;
      if (typeof it.text === 'string') {
        parts.push({ part_id: String(i), kind: 'text', text: it.text });
      } else if (it.type === 'input_image' && typeof it.image_url === 'string') {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(it.image_url);
        if (m) parts.push({ part_id: String(i), kind: 'attachment', media_type: m[1], inline: m[2], bytes_len: Buffer.from(m[2], 'base64').length });
      }
    });
    if (!parts.length) return;
    if (p.role === 'user') {
      const texts = parts.filter((x) => x.kind === 'text' && x.text.trim());
      const boot = texts.length > 0 && texts.every((x) => isBoot(x.text));
      // A prompt typed while the turn is already working is steering (it did not open a turn).
      const source = boot ? injected : { source: !started && s.u.active ? 'steering' : 'user' };
      emitMessage(ctx, { ...base, role: 'user', ...source, parts });
    } else if (p.role === 'assistant') {
      emitMessage(ctx, { ...base, ...asst, parts });
    } else {
      // developer (and any other non-conversation role): instructions the harness injects.
      emitMessage(ctx, { ...base, role: 'system', ...injected, parts });
    }
    return;
  }

  if (p.type === 'reasoning') {
    let texts = (Array.isArray(p.summary) ? p.summary : []).filter((x) => x && typeof x.text === 'string');
    if (!texts.length) texts = (Array.isArray(p.content) ? p.content : []).filter((x) => x && typeof x.text === 'string');
    const parts = texts.map((x, i) => ({ part_id: String(i), kind: 'reasoning', text: x.text, signature_len: null }));
    if (typeof p.encrypted_content === 'string' && p.encrypted_content) {
      parts.push({ part_id: String(parts.length), kind: 'reasoning', opaque: true, signature_len: p.encrypted_content.length });
    }
    if (!parts.length) parts.push({ part_id: '0', kind: 'reasoning', text: '', signature_len: null });
    emitMessage(ctx, { ...base, ...asst, parts });
    return;
  }

  if (TOOL_CALLS.has(p.type)) {
    const name = p.type === 'local_shell_call' ? 'local_shell' : p.type === 'web_search_call' ? 'web_search' : String(p.name || 'tool');
    // call_id is native; without one, '@<message_id>:<index>' (sessions-model §1 rule 6).
    const callId = str(p.call_id) ?? `@${mid}:0`;
    emitMessage(ctx, { ...base, ...asst, parts: [{ part_id: '0', kind: 'tool_call', call_id: callId, name, args: argsOf(p), server: null }] });
    return;
  }

  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const output = outputText(p.output);
    emitMessage(ctx, {
      ...base,
      role: 'tool',
      // A tool result is written by the harness running the tool: no `source` value fits it.
      source: null,
      parts: [{
        part_id: '0', kind: 'tool_result', call_id: String(p.call_id ?? ''),
        is_error: outputError(p.output), status: 'completed', output, output_len: utf8Len(output), truncated: null,
        exit_code: outputExit(p.output),
      }],
    });
  }
}
