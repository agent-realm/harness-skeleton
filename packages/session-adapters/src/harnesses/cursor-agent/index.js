// cursor-agent (the Cursor CLI): `~/.cursor` is the `harness_path` ($CURSOR_CONFIG_DIR, else
// $XDG_CONFIG_HOME/cursor, else ~/.cursor; adapter spec §1). One session per
// chat directory with its `store.db` (sessions-model §1 rule 3: membership is the store, never a
// transcript). sessions v1 four operations over sessions-model v1.1 records.
//
// The harness store (adapter spec §2, §3; annex mapping row):
// - `chats/<md5(cwd)>/<chatId>/store.db`, SQLite in WAL mode: `blobs(id, data)`, immutable rows
//   whose id is the sha256 of the bytes, and `meta`, whose row "0" is hex(utf8(JSON)) naming the
//   current root blob (`latestRootBlobId`), the title and the sub-agent parent.
// - The conversation is the blob tree under that root, a protobuf ConversationStateStructure: #8
//   the turns (ConversationTurnStructure: #1 an agent turn, #2 a shell turn), #1 the model context
//   (JSON model messages), #13 / #11 the compaction summary archives.
// - `chats/<md5(cwd)>/<chatId>/meta.json`, rewritten on every open; only its `cwd` is read.
// - `acp-sessions/<id>/store.db`: the same store class (memhouse lists it; UNVERIFIED with a turn).
//
// Ported from memhouse's v4 normaliser (its cursor-agent module: the tree walk,
// the model-context index, the tool kinds, typed arguments and results, the credential-tool rule,
// the user message's source, the shell turn, the summaries and reminders, the sub-agent links).
// New here:
// - `blobs` is a delta source read as keys (position `kv`): blobs are never updated or deleted, so
//   a rewind (the root moving back) is a snapshot change of `meta`, never a reset. The rewound
//   turns
//   leave `live`; memhouse's inferred rewind record (`findRewinds`) is dropped, because lifecycle
//   records are explicit-only (sessions-model §2.6);
// - redaction in `read` (sessions-model §4): the meta row's `blobEncryptionKey`, a turn's
//   `encrypted_model` and the credential tools' arguments and results. A protobuf blob with such a
//   value is a `pb-json` unit (pb.js); a JSON blob stays `utf8`, its values replaced;
// - a torn tree (the root names a blob that is not stored) is the retryable `inconsistent` in
//   `read`; a derive that meets one (its blobs read before the meta that names them) holds every
//   key it emitted until the next pass;
// - holds as derive `held`: the last turn's reply while a tool has no result or no step exists
//   yet, and a shell command still running;
// - records in the sessions-model shape: a tool step is two parts, `<step>:call` and
//   `<step>:result` (sessions-model §2.3); a compaction is a summary message plus an explicit
//   compaction lifecycle record; sub-agents are links on both sides; no usage is stored.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionsError } from '../../errors.js';
import { isRealFile, readSnapshot, snapshotUnits, databaseSource, unknownSource, makeUnit, jsonOf } from '../../sources.js';
import { openReadOnly, withRead, hasTable, readRowsSnapshot } from '../../sqlite.js';
import { seal, recordKey } from '../../records.js';
import { jcs, sha256 } from '../../jcs.js';
import { Msg, Malformed, tryWire, toPbJson, marker, isMarker } from './pb.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'cursor-agent';
const STATE_VER = 1;
export const EMPTY_ROOT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const noHeld = () => ({ session: [], message: [], usage: [], link: [], lifecycle: [] });

export function describe() {
  return describeData;
}

// ---- tool kinds (agent.v1 ToolCall oneof `tool`, cursor-agent 2026.10.19) ----------------------

const KINDS = {
  1: 'shell', 3: 'delete', 4: 'glob', 5: 'grep', 8: 'read', 9: 'update_todos', 10: 'read_todos', 12: 'edit', 13: 'ls',
  14: 'read_lints', 15: 'mcp', 16: 'sem_search', 17: 'create_plan', 18: 'web_search', 19: 'task', 20: 'list_mcp_resources',
  21: 'read_mcp_resource', 22: 'apply_agent_diff', 23: 'ask_question', 24: 'fetch', 25: 'switch_mode', 28: 'generate_image',
  29: 'record_screen', 30: 'computer_use', 31: 'write_shell_stdin', 32: 'reflect', 33: 'setup_vm_environment', 34: 'truncated',
  35: 'start_grind_execution', 36: 'start_grind_planning', 37: 'web_fetch', 38: 'report_bugfix_results', 39: 'ai_attribution',
  40: 'pr_management', 41: 'mcp_login', 42: 'await', 43: 'blame_by_file_path', 44: 'get_mcp_tools', 45: 'report_bug',
  46: 'set_active_branch', 48: 'communicate_update', 49: 'send_final_summary', 51: 'replace_env', 52: 'edit_pr_labels',
  53: 'record_ci_investigation_findings', 55: 'send_message', 56: 'fetch_cloud_agent_data', 58: 'send_to_user', 61: 'pi_read',
  62: 'pi_bash', 63: 'pi_edit', 64: 'pi_write', 65: 'pi_grep', 66: 'pi_find', 67: 'pi_ls', 68: 'connect_scm',
  69: 'search_conversations', 70: 'create_goal', 71: 'update_goal', 73: 'get_agent_status', 74: 'send_to_agent',
  75: 'read_agent_transcript', 76: 'create_agent', 77: 'stop_agent', 79: 'write_canvas', 80: 'read_canvas', 81: 'generate_video',
  82: 'x_search', 83: 'get_origin_pr_code_tour', 84: 'update_origin_pr_code_tour', 85: 'list_tracked_tasks',
  86: 'create_tracked_tasks', 87: 'update_tracked_tasks', 88: 'delete_tracked_tasks', 89: 'update_tracked_task_statuses',
  90: 'create_project',
};
// ToolCall fields beside the oneof: hook_additional_contexts, tool_call_id, started / completed ms.
const COMMON = new Set([54, 57, 59, 60]);
// The kinds whose arguments may carry credentials (mcp_login, replace_env, connect_scm), and the
// same tools by their model-facing names, in any case (the model context may name a call that way).
const CRED_KINDS = new Set([41, 51, 68]);
const SENSITIVE = new Set(['replace_env', 'mcp_login', 'connect_scm']);
const SENSITIVE_NAMES = /^(ReplaceEnv|McpLogin|McpAuth|ConnectScm|replace_env|mcp_login|mcp_auth|connect_scm)$/i;
// The only argument keys kept for those tools: what names the thing, never a value.
const SENSITIVE_ARG_NAMES = new Set(['name', 'names', 'server', 'server_name', 'serverName', 'provider', 'provider_identifier', 'providerIdentifier', 'scm', 'host']);
const noUserinfo = (v) => v.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, '$1');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCredName = (n) => typeof n === 'string' && SENSITIVE_NAMES.test(n);

// ---- list -------------------------------------------------------------------------------------

// A directory's subdirectories with a plain name, never through a symlink (read refuses one too).
function subdirs(dir) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && SAFE.test(e.name)).map((e) => e.name).sort();
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
}

// Every chat directory with its store.db: `chats/<bucket>/<id>`, then `acp-sessions/<id>`. An id
// found twice keeps its first directory. A transcript under `projects/` is never looked at, so an
// orphan (its chat deleted) is never a session (fixture: orphan).
function chatDirs(root) {
  const out = new Map();
  const add = (sid, dir) => {
    if (!out.has(sid) && isRealFile(root, `${dir}/store.db`)) out.set(sid, dir);
  };
  for (const b of subdirs(path.join(root, 'chats'))) for (const id of subdirs(path.join(root, 'chats', b))) add(id, `chats/${b}/${id}`);
  for (const id of subdirs(path.join(root, 'acp-sessions'))) add(id, `acp-sessions/${id}`);
  return out;
}

function locate(root, sid) {
  if (typeof sid !== 'string' || !SAFE.test(sid)) return null;
  for (const b of subdirs(path.join(root, 'chats'))) if (isRealFile(root, `chats/${b}/${sid}/store.db`)) return `chats/${b}/${sid}`;
  return isRealFile(root, `acp-sessions/${sid}/store.db`) ? `acp-sessions/${sid}` : null;
}

const keysOf = (dir) => ({ db: `${dir}/store.db`, blobs: `${dir}/store.db#table:blobs`, meta: `${dir}/store.db#table:meta`, json: `${dir}/meta.json` });

function sourcesOf(root, dir) {
  const k = keysOf(dir);
  const out = [
    // Blobs are never updated or deleted (`INSERT OR REPLACE` of the same bytes), so `known` alone
    // says what is new (sessions §1, `kv`).
    { source_key: k.blobs, role: 'main', mode: 'delta', position_kind: 'kv' },
    { source_key: k.meta, role: 'side', mode: 'snapshot', position_kind: 'snapshot' },
  ];
  if (isRealFile(root, k.json)) out.push({ source_key: k.json, role: 'side', mode: 'snapshot', position_kind: 'snapshot' });
  return out.sort((a, b) => (a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0));
}

// Size and mtime of the store and its `-wal` (rows often live only there). meta.json is left out:
// every open rewrites its `updatedAtMs` (memhouse).
function hint(root, dir) {
  const stat = (rel) => {
    try {
      const st = fs.statSync(path.join(root, rel));
      return [rel, st.size, Math.trunc(st.mtimeMs)];
    } catch {
      return [rel, -1, -1];
    }
  };
  return sha256(JSON.stringify([stat(`${dir}/store.db`), stat(`${dir}/store.db-wal`)])).slice(0, 32);
}

export function list(store) {
  const root = store.harness_path;
  const out = [];
  for (const [sid, dir] of [...chatDirs(root)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    out.push({ session_id: sid, incarnation: '', updated_hint: hint(root, dir), live: 'unknown', sources: sourcesOf(root, dir) });
  }
  return out;
}

// ---- read: redaction (sessions-model §4; the paths are declared in describe.js) ----------------

function hide(v) {
  if (v == null || isMarker(v)) return v;
  return marker(typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : Buffer.byteLength(jcs(v), 'utf8'));
}

// A credential tool's arguments: the naming keys keep a string (or a list of strings) with any
// `user:pass@` cut from a URL in it; every other value is replaced.
function namingOnly(a) {
  if (!isObj(a)) return hide(a);
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (SENSITIVE_ARG_NAMES.has(k) && typeof v === 'string') out[k] = noUserinfo(v);
    else if (SENSITIVE_ARG_NAMES.has(k) && Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v.map(noUserinfo);
    else out[k] = hide(v);
  }
  return out;
}

// CallDynamicTool wraps the tool it calls: {namespace, toolName, arguments}.
function credArgs(p) {
  if (p.toolName !== 'CallDynamicTool' || !isObj(p.args)) return namingOnly(p.args);
  const out = {};
  for (const [k, v] of Object.entries(p.args)) {
    if (k === 'arguments' || k === 'args') out[k] = namingOnly(v);
    else if ((k === 'namespace' || k === 'toolName') && typeof v === 'string') out[k] = v;
    else out[k] = hide(v);
  }
  return out;
}

const isCredCall = (p) => isObj(p) && p.type === 'tool-call' && typeof p.toolCallId === 'string'
  && (isCredName(p.toolName) || (p.toolName === 'CallDynamicTool' && isObj(p.args) && isCredName(p.args.toolName)));

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

// A ConversationStep.tool_call blob: its kind (the oneof field number), the kind message's bytes
// (null unless length-delimited and decodable, as a tool kind always is) and its tool_call_id.
function stepTool(buf) {
  const top = tryWire(buf);
  if (!top || top.length !== 1 || top[0][0] !== 2 || top[0][1] !== 2) return null;
  const inner = tryWire(top[0][2]);
  if (!inner) return null;
  const kind = inner.find(([n]) => !COMMON.has(n));
  const call = inner.filter(([n, w]) => n === 57 && w === 2).pop();
  if (!kind) return null;
  const body = kind[1] === 2 && tryWire(kind[2]) ? kind[2] : null;
  return { kind: kind[0], body, callId: call ? call[2].toString('utf8') : '' };
}

// The bytes of the last length-delimited field `n` of a field list, or null.
const lenField = (fields, n) => {
  const e = (fields || []).filter(([m, w]) => m === n && w === 2).pop();
  return e ? e[2] : null;
};
// An mcp step's own tool name: McpArgs #5 (tool_name), else #1 (name), as ARGS.mcp reads it.
function mcpToolName(body) {
  const args = lenField(tryWire(body), 1);
  const f = args ? tryWire(args) : null;
  const text = (n) => (lenField(f, n) || Buffer.alloc(0)).toString('utf8');
  return f ? text(5) || text(1) : '';
}
// A credential tool by the step alone: a credential kind, or an mcp call to a credential tool by
// its own name. Its call's model-context copies are redacted too.
const credTool = (s) => CRED_KINDS.has(s.kind) || (s.kind === 15 && !!s.body && isCredName(mcpToolName(s.body)));
// A step whose arguments and result read redacts on the step alone: a credential tool, or a kind
// this adapter does not know (a newer tool: its fields are opaque, so they are treated as secret
// until the table learns them; sessions-model §4). The model context of an unknown kind is kept:
// it names its own fields, and its credential tools are caught by name.
const credStep = (s) => credTool(s) || (!(s.kind in KINDS) && !!s.body);

// Every call id that belongs to a credential tool: by its step's kind, or by the name the model
// context gives it.
function credentialCalls(blobs) {
  const out = new Set();
  for (const b of blobs) {
    if (b.buf[0] === 0x7b) {
      const o = parseJson(b.buf);
      if (o && o.role === 'assistant' && Array.isArray(o.content)) for (const p of o.content) if (isCredCall(p)) out.add(p.toolCallId);
    } else {
      const s = stepTool(b.buf);
      if (s && s.callId && credTool(s)) out.add(s.callId);
    }
  }
  return out;
}

// A JSON model message with a credential tool's call or result, redacted; null when it has none.
function redactJson(o, cred) {
  if (!isObj(o) || !Array.isArray(o.content)) return null;
  let hit = false;
  const content = o.content.map((p) => {
    if (!isObj(p)) return p;
    if (p.type === 'tool-call' && (isCredCall(p) || cred.has(p.toolCallId))) {
      hit = true;
      return { ...p, args: credArgs(p) };
    }
    if (p.type === 'tool-result' && (cred.has(p.toolCallId) || isCredName(p.toolName))) {
      hit = true;
      const q = { ...p };
      for (const k of ['result', 'experimental_content', 'output']) if (k in q) q[k] = hide(q[k]);
      return q;
    }
    return p;
  });
  if (!hit) return null;
  const out = { ...o, content };
  const cur = isObj(o.providerOptions) && isObj(o.providerOptions.cursor) ? o.providerOptions.cursor : null;
  if (o.role === 'tool' && cur && isObj(cur.highLevelToolCallResult)) {
    const hl = Object.fromEntries(Object.entries(cur.highLevelToolCallResult).map(([k, v]) => [k, k === 'isError' ? v : hide(v)]));
    out.providerOptions = { ...o.providerOptions, cursor: { ...cur, highLevelToolCallResult: hl } };
  }
  return out;
}

// What a protobuf blob must have redacted: a turn's encrypted_model (AgentConversationTurnStructure
// #4, under ConversationTurnStructure #1), or a credential tool step's arguments and result
// (ConversationStep #2 ToolCall, the kind message's fields; the result keeps which case is set).
// An mcp step keeps the McpArgs fields that name the call: #1 name, #4 provider, #5 tool, #9
// server.
const TURN_PLAN = { 1: { 4: 'redact' } };
const MCP_ARGS_PLAN = { 1: 'keep', 4: 'keep', 5: 'keep', 9: 'keep', '*': 'redact' };
function planFor(buf, cred) {
  const top = tryWire(buf);
  if (!top || top.length !== 1 || top[0][1] !== 2) return null;
  const inner = tryWire(top[0][2]);
  if (!inner) return null;
  if (top[0][0] === 1) {
    const enc = inner.some(([n, w]) => n === 4 && w === 2);
    // Its user_message is a 32-byte blob reference: no other message's field 1 looks like that.
    const refs = inner.filter(([n]) => n === 1).every(([, w, v]) => w === 2 && v.length === 32);
    return enc && refs ? TURN_PLAN : null;
  }
  if (top[0][0] === 2) {
    const s = stepTool(buf);
    // The step alone decides wherever it can; the model context's name is a further net.
    if (s && (credStep(s) || (s.callId && cred.has(s.callId)))) {
      return { 2: { [s.kind]: { 1: s.kind === 15 ? MCP_ARGS_PLAN : 'redact', 2: { '*': 'redact' }, '*': 'redact' } } };
    }
  }
  return null;
}

function blobUnit(sk, id, buf, cred) {
  if (buf[0] === 0x7b) {
    const o = parseJson(buf);
    const r = o ? redactJson(o, cred) : null;
    if (!r) return makeUnit(sk, id, buf);
    const text = Buffer.from(JSON.stringify(r), 'utf8');
    return { source_key: sk, unit_key: id, enc: 'utf8', bytes: text.length, sha256: sha256(text), redacted: true, body: text.toString('utf8') };
  }
  const plan = planFor(buf, cred);
  if (plan) {
    const text = Buffer.from(jcs(toPbJson(buf, plan)), 'utf8');
    return { source_key: sk, unit_key: id, enc: 'pb-json', bytes: text.length, sha256: sha256(text), redacted: true, body: text.toString('utf8') };
  }
  return { source_key: sk, unit_key: id, enc: 'b64', bytes: buf.length, sha256: sha256(buf), redacted: false, body: buf.toString('base64') };
}

// The meta row's JSON: hex(utf8(JSON)) as cursor-agent writes it, or plain JSON.
function parseMetaValue(v) {
  const t = v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : v == null ? '' : String(v);
  if (!t) return null;
  try {
    const o = JSON.parse(/^(?:[0-9a-fA-F]{2})+$/.test(t) ? Buffer.from(t, 'hex').toString('utf8') : t);
    return isObj(o) ? o : null;
  } catch {
    return null;
  }
}

function redactMeta(body) {
  let redacted = false;
  const meta = body.meta.map((r) => {
    if (!isObj(r.value) || !('blobEncryptionKey' in r.value) || r.value.blobEncryptionKey == null || isMarker(r.value.blobEncryptionKey)) return r;
    redacted = true;
    return { ...r, value: { ...r.value, blobEncryptionKey: hide(r.value.blobEncryptionKey) } };
  });
  return { row: { meta }, redacted };
}

// ---- read -------------------------------------------------------------------------------------

const damaged = (sk, why) => new SessionsError('damaged', `${sk}: ${why}`, [sk]);
const inconsistent = (sk, why) => new SessionsError('inconsistent', `${sk}: ${why}`, [sk]);
const bytesOf = (v) => (v == null ? Buffer.alloc(0) : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.from(String(v), 'utf8'));

// The blobs as units: every current row, diffed against `known` (sessions §2 rule 4).
function readBlobs(root, k, from, known) {
  const db = openReadOnly(root, k.db, k.blobs);
  try {
    return withRead(db, k.blobs, (d) => {
      const rows = hasTable(d, 'blobs') ? d.prepare('SELECT id, data FROM blobs ORDER BY id').all() : [];
      const blobs = rows.map((r) => ({ id: String(r.id), buf: bytesOf(r.data) }));
      const cred = credentialCalls(blobs);
      const units = [];
      const current = new Set();
      for (const b of blobs) {
        current.add(b.id);
        const u = blobUnit(k.blobs, b.id, b.buf, cred);
        if (!known || known[b.id] !== u.sha256) units.push(u);
      }
      const position = { count: current.size };
      if (!from && !known) return { continuity: 'reset', units, gone: [], position, held_back: [] };
      const gone = known ? Object.keys(known).filter((x) => !current.has(x)).sort() : [];
      return { continuity: units.length || gone.length ? 'delta' : 'unchanged', units, gone, position, held_back: [] };
    });
  } finally {
    db.close();
  }
}

const archivesOf = (root) => [...new Set([...root.refs(13), ...(root.has(11) ? [root.ref(11)] : [])])];

// The tree a meta row names must be stored whole in the same transaction: a missing blob is a
// torn view (`inconsistent`), an undecodable root or archive is `damaged`. These are the blobs
// derive cannot do without; a malformed turn or step is folded leniently, as memhouse does.
function checkTree(d, sk, meta) {
  const rootId = String(meta.latestRootBlobId || '').toLowerCase();
  if (!rootId || rootId === EMPTY_ROOT) return;
  if (!hasTable(d, 'blobs')) throw inconsistent(sk, `root ${rootId} is not stored`);
  const stmt = d.prepare('SELECT data FROM blobs WHERE id = ?');
  const need = (id) => {
    const r = stmt.get(id);
    if (!r || r.data == null) throw inconsistent(sk, `blob ${id} is not stored`);
    return bytesOf(r.data);
  };
  const parse = (id) => {
    try {
      return Msg.from(need(id));
    } catch (e) {
      if (e instanceof Malformed) throw damaged(sk, `blob ${id} does not decode`);
      throw e;
    }
  };
  const root = parse(rootId);
  for (const a of archivesOf(root)) {
    const am = parse(a);
    for (const id of [...am.refs(1), ...(am.has(4) ? [am.ref(4)] : [])]) need(id);
  }
  for (const id of root.refs(1)) need(id);
  for (const t of root.refs(8)) {
    let agent = null;
    let shell = null;
    try {
      const tm = Msg.from(need(t));
      agent = tm.has(1) ? tm.msg(1) : null;
      shell = !agent && tm.has(2) ? tm.msg(2) : null;
    } catch (e) {
      if (e instanceof Malformed) continue;
      throw e;
    }
    if (agent) {
      if (agent.has(1)) need(agent.ref(1));
      for (const s of agent.refs(2)) need(s);
    }
    if (shell) for (const n of [1, 2]) if (shell.has(n)) need(shell.ref(n));
  }
}

function readMeta(root, k, from) {
  const db = openReadOnly(root, k.db, k.meta);
  try {
    return withRead(db, k.meta, (d) => {
      const row = hasTable(d, 'meta') ? d.prepare("SELECT key, value FROM meta WHERE key = '0'").get() : undefined;
      const rows = [];
      if (row) {
        const value = parseMetaValue(row.value);
        if (!value) throw damaged(k.meta, 'the meta row does not parse');
        rows.push({ key: '0', value });
      }
      const out = readRowsSnapshot(k.meta, { meta: rows }, from, { redact: redactMeta });
      if (out.units.length && rows.length) checkTree(d, k.meta, rows[0].value);
      return out;
    });
  } finally {
    db.close();
  }
}

// meta.json, read for its cwd only: every open rewrites the rest (`updatedAtMs`).
function cwdOnly(buf) {
  const o = parseJson(buf);
  return { buf: Buffer.from(jcs({ cwd: isObj(o) && typeof o.cwd === 'string' ? o.cwd : null }), 'utf8'), redacted: false };
}

export function read(store, session, sourceKey, from = null, known = null) {
  const root = store.harness_path;
  const sid = session.session_id;
  const dir = locate(root, sid);
  if (!dir) throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
  const k = keysOf(dir);
  if (sourceKey === k.blobs) return readBlobs(root, k, from, known);
  if (sourceKey === k.meta) return readMeta(root, k, from);
  if (sourceKey === k.json && isRealFile(root, k.json)) return readSnapshot(path.join(root, k.json), k.json, from, { root, redact: cwdOnly });
  throw new SessionsError('source_unknown', `${sourceKey} is not a source of ${sid}`, [sourceKey]);
}

// The chat directory a source key sits in, as `chatDirs` names it (`chats/<bucket>/<id>` or
// `acp-sessions/<id>`), and the rest of the key; null when it sits in none.
function dirOf(sourceKey) {
  const m = typeof sourceKey === 'string' ? /^(chats\/([^/]+)\/([^/]+)|acp-sessions\/([^/]+))\/(.+)$/.exec(sourceKey) : null;
  if (!m || ![m[2], m[3], m[4]].filter((x) => x !== undefined).every((x) => SAFE.test(x))) return null;
  return { dir: m[1], rest: m[5] };
}

// The units `read` returns from scratch for a source holding `bytes` (src/index.js
// unitsFromBytes), from the source key alone: no session, no position, no file system. Only
// meta.json is a file, read for its cwd as `read` reads it; store.db's tables have no file bytes.
export function unitsFromBytes(sourceKey, bytes, { start = 0 } = {}) {
  const d = dirOf(sourceKey);
  if (d && (d.rest === 'store.db#table:blobs' || d.rest === 'store.db#table:meta')) throw databaseSource(sourceKey);
  if (d && d.rest === 'meta.json') return snapshotUnits(bytes, sourceKey, { start, redact: cwdOnly });
  throw unknownSource(HARNESS, sourceKey);
}

// ---- derive: helpers --------------------------------------------------------------------------

class MissingBlob extends Error {}
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const pad = (n) => String(n).padStart(6, '0');
const utf8Len = (s) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : null);
const byOrder = (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const joinOut = (...xs) => xs.filter(Boolean).join('\n');
const notice = (partId, text, nativeType) => ({ part_id: partId, kind: 'notice', text, level: null, native_type: nativeType });

function uriPath(u) {
  const s = String(u || '');
  if (!s.startsWith('file:')) return s;
  try {
    return decodeURIComponent(new URL(s).pathname);
  } catch {
    return s;
  }
}

// ---- derive: tool steps -----------------------------------------------------------------------

function pick(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== '' && v !== null && v !== undefined && v !== false && v !== 0) out[k] = v;
  return out;
}
const TODO_STATUS = ['unspecified', 'pending', 'in_progress', 'completed', 'cancelled'];
const todo = (t) => pick({ id: t.str(1), content: t.str(2), status: TODO_STATUS[t.num(3) || 0] || String(t.num(3)) });
// google.protobuf.Value, the MCP args map's value type (UNVERIFIED: no MCP call was observed).
function pbValue(m) {
  if (!m) return null;
  if (m.has(3)) return m.str(3);
  if (m.has(2)) return m.double(2);
  if (m.has(4)) return m.bool(4);
  if (m.has(5)) return pbStruct(m.msg(5));
  if (m.has(6)) return m.msg(6).msgs(1).map(pbValue);
  return null;
}
function pbStruct(s) {
  const o = {};
  for (const e of s.msgs(1)) o[e.str(1)] = pbValue(e.msg(2));
  return o;
}

// Typed arguments per kind: the fields the model chose, never the harness's bookkeeping (parsing
// result, sandbox policy, conversation and request ids, ShellArgs secret_scope_id).
const ARGS = {
  shell: (a) => pick({ command: a.str(1), working_directory: a.str(2), description: a.str(15), timeout: a.num(3), is_background: a.bool(11) }),
  read: (a) => pick({ path: a.str(1), offset: a.num(2), limit: a.num(3) }),
  edit: (a) => pick({ path: a.str(1), stream_content: a.str(6) }),
  glob: (a) => pick({ target_directory: a.str(1), glob_pattern: a.str(2) }),
  grep: (a) => pick({ pattern: a.str(1), path: a.str(2), glob: a.str(3), output_mode: a.str(4) }),
  task: (a) => pick({ description: a.str(1), prompt: a.str(2), model: a.str(4) }),
  update_todos: (a) => pick({ todos: a.msgs(1).map(todo), merge: a.bool(2) }),
  mcp: (a) => {
    let args = {};
    try {
      for (const e of a.msgs(2)) args[e.str(1)] = pbValue(e.msg(2));
    } catch {
      args = {};
    }
    return pick({ server: a.str(9) || a.str(4), tool: a.str(5) || a.str(1), args });
  },
};
const ARG_NAMES = new Set([
  'command', 'working_directory', 'description', 'timeout', 'is_background', 'path', 'offset', 'limit', 'stream_content',
  'target_directory', 'glob_pattern', 'pattern', 'glob', 'output_mode', 'prompt', 'model', 'todos', 'merge', 'server', 'tool', 'args',
]);
const allowArgs = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => ARG_NAMES.has(k)));
// The model-facing name where it differs from the kind in PascalCase (observed in the JSON
// context).
const NAMES = { update_todos: 'TodoWrite', read_todos: 'TodoRead', get_mcp_tools: 'GetDynamicTools', ls: 'LS', mcp: 'CallMcpTool' };
const pascal = (k) => k.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

// `is_error` is the harness store's own flag (sessions-model v1.x (#6), §2.3): a result's oneof
// case (a success or a failure), or the model context's `isError`; null where neither is stored. A
// flag that says success beside a shell's non-zero `exit_code` is unreliable for that result: its
// `is_error` is null, and the other results keep the flag. It describes a call that completed: a
// denied or a cancelled result's is null (the model context's `isError` beside it too), and the
// status carries the fact. Never derived from the exit code or the text.
const flagBeside = (isError, exit) => (isError === false && Number.isInteger(exit) && exit !== 0 ? null : isError);
const ok = (output) => ({ output, is_error: false, status: 'completed' });
const err = (output) => ({ output, is_error: true, status: 'completed' });
const denied = (output) => ({ output, is_error: null, status: 'denied' });
// A result whose text is not decoded: only which case is set (success is field 1 in every observed
// oneof).
const statusOnly = (r) => ({ output: null, is_error: !r.has(1), status: 'completed' });

// Typed result text per kind; `blobText` resolves a content blob reference and `blobLen` gives a
// blob's size (both lenient: '' and null for a blob that is not there).
const RESULTS = {
  shell(r) {
    const [c, m] = r.oneof([1, 2, 3, 4, 5, 7]);
    // ShellSuccess / ShellFailure #3 exit_code (int32), stored apart from the output. proto3 leaves
    // a 0 unwritten, so an absent field is 0; a redacted case (a credential step) has none.
    const exit = r.msg(c) ? (m.num(3) ?? 0) : null;
    if (c === 1) return { ...ok(m.str(10) || joinOut(m.str(5), m.str(6))), is_error: flagBeside(false, exit), exit_code: exit };
    if (c === 2) return { output: m.str(9) || joinOut(m.str(5), m.str(6)), is_error: m.bool(11) ? null : true, status: m.bool(11) ? 'cancelled' : 'completed', exit_code: exit };
    if (c === 3) return { output: `timed out after ${m.num(3) || 0} ms`, is_error: null, status: 'cancelled' };
    if (c === 4 || c === 7) return denied(m.str(3));
    if (c === 5) return err(m.str(3));
    return null;
  },
  read(r, blobText, blobLen) {
    const [c, m] = r.oneof([1, 2]);
    if (c === 1) {
      if (m.has(1)) return ok(m.str(1));
      if (m.has(10)) return ok(blobText(m.ref(10)));
      if (m.has(6)) return ok(`<binary ${m.lenOf(6) ?? 0} bytes>`);
      if (m.has(9)) return { ...ok(`<binary blob ${m.ref(9)}>`), output_ref: { ref: `blob:${m.ref(9)}`, sha256: m.ref(9), bytes: blobLen(m.ref(9)) } };
      return ok('');
    }
    return c === 2 ? err(m.str(1)) : null;
  },
  edit(r) {
    const [c, m] = r.oneof([1, 2, 3, 4, 6, 7]);
    if (c === 1) return ok(joinOut(m.str(8), m.str(5)));
    if (c === 2) return err(`file not found: ${m.str(1)}`);
    if (c === 3) return denied(`read permission denied: ${m.str(1)}`);
    if (c === 4) return denied(m.str(2) || `write permission denied: ${m.str(1)}`);
    if (c === 6) return denied(m.str(2));
    if (c === 7) return err(m.str(2));
    return null;
  },
  glob(r) {
    const [c, m] = r.oneof([1, 2]);
    return c === 1 ? ok(m.strs(3).join('\n')) : c === 2 ? err(m.str(1)) : null;
  },
  grep(r) {
    const [c, m] = r.oneof([1, 2]);
    if (c === 2) return err(m.str(1));
    if (c !== 1) return null;
    // GrepSuccess #4 workspace_results map<workspace, GrepUnionResult>, #5 active_editor_result.
    // The
    // content mode (union #3, observed): files {#1 path, #2 matches {#1 line, #2 text}}. The other
    // modes' shapes were never observed, so their text is not decoded.
    const lines = [];
    let seen = false;
    const union = (u) => {
      const ct = u && u.msg(3);
      if (!ct) return;
      seen = true;
      for (const f of ct.msgs(1)) for (const ln of f.msgs(2)) lines.push(`${f.str(1)}:${ln.num(1) ?? ''}:${ln.str(2)}`);
    };
    for (const e of m.msgs(4)) union(e.msg(2));
    union(m.msg(5));
    return seen ? ok(lines.join('\n')) : statusOnly(r);
  },
  task(r) {
    const [c, m] = r.oneof([1, 2]);
    if (c === 1) return ok(m.msgs(1).map((s) => (s.msg(1) ? s.msg(1).str(1) : '')).filter(Boolean).join('\n\n'));
    return c === 2 ? err(m.str(1)) : null;
  },
  update_todos(r) {
    const [c, m] = r.oneof([1, 2]);
    if (c === 1) return ok(m.msgs(1).map((t) => `- [${TODO_STATUS[t.num(3) || 0] || t.num(3)}] ${t.str(2)}`).join('\n'));
    return c === 2 ? err(m.str(1)) : null;
  },
  create_plan(r) {
    const [c, m] = r.oneof([2]);
    return c === 2 ? err(m.str(1)) : ok(r.str(3));
  },
  mcp(r) {
    const [c, m] = r.oneof([1, 2, 3, 4, 5, 6, 7]);
    if (c === 1) {
      // McpSuccess #1 content items; a text item is {#1 {#1 text}} (UNVERIFIED: no MCP call was
      // observed). Any other item is counted, never decoded.
      const texts = [];
      let other = 0;
      for (const item of m.msgs(1)) {
        const t = item.msg(1);
        if (t && t.has(1)) texts.push(t.str(1));
        else other++;
      }
      if (other) texts.push(`[${other} non-text content item${other > 1 ? 's' : ''}]`);
      return { output: texts.join('\n'), is_error: m.bool(2), status: 'completed' };
    }
    if (c === 2) return err(m.str(1));
    if (c === 3 || c === 4) return denied(m.str(1));
    if (c === 5) return err(`tool not found: ${m.str(1)}`);
    if (c === 6) return err(`server not found: ${m.str(1)}`);
    if (c === 7) return ok('approved');
    return null;
  },
};

// A credential tool's argument value as kept: a string or a list of strings, never a marker.
function namingValue(v) {
  if (typeof v === 'string') return isMarker(v) ? undefined : noUserinfo(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' && !isMarker(x))) return v.map(noUserinfo);
  return undefined;
}

// One tool step: its call and result parts (sessions-model §2.3: one native part holding both
// becomes `<step>:call` and `<step>:result`), the sub-agent it started, and its start time.
function toolParts(tc, j, fallbackCall, J, blobText, blobLen) {
  const callId = tc.has(57) ? tc.str(57) : fallbackCall;
  let c = 0;
  for (const n of tc.keys()) {
    if (!COMMON.has(n)) {
      c = n;
      break;
    }
  }
  const kind = KINDS[c] || `tool_${c}`;
  const sub = (m, n) => {
    try {
      return m && m.has(n) ? m.msg(n) : null;
    } catch {
      return null;
    }
  };
  const K = c ? sub(tc, c) : null;
  // TruncatedToolCall (#34): #1 the original step's blob, #2 args, #3 a result preview, #4 its
  // size.
  const [af, rf] = c === 34 ? [2, 3] : [1, 2];
  const argsMsg = sub(K, af);
  const resMsg = sub(K, rf);
  const hasResult = !!(resMsg && resMsg.size);

  // From the step: a typed projection where the kind has one (allowlisted names), else nothing. An
  // mcp call to a credential tool, by its own name, is a credential tool too.
  const secret = SENSITIVE.has(kind) || (kind === 'mcp' && !!argsMsg && isCredName(argsMsg.str(5) || argsMsg.str(1)));
  let name = NAMES[kind] || pascal(kind);
  let args = {};
  if (argsMsg && !secret && ARGS[kind]) {
    try {
      args = allowArgs(ARGS[kind](argsMsg));
    } catch {
      args = {};
    }
  }
  let res = null;
  let child = '';
  if (hasResult && (secret || !RESULTS[kind])) res = statusOnly(resMsg);
  else if (hasResult) {
    try {
      res = RESULTS[kind](resMsg, blobText, blobLen) || statusOnly(resMsg);
    } catch {
      res = statusOnly(resMsg);
    }
    if (kind === 'task') child = (sub(resMsg, 1) || new Msg()).str(2);
  }

  // From the model context, where the call is in it: what the model sent and was sent back.
  const jc = J.calls.get(callId);
  if (jc) {
    name = str(jc.name) ?? name;
    args = isObj(jc.args) ? jc.args : {};
    if (name === 'CallDynamicTool' && str(args.toolName)) {
      name = args.toolName;
      args = isObj(args.arguments) ? args.arguments : isObj(args.args) ? args.args : {};
    }
  }
  const jr = J.results.get(callId);
  if (jr) {
    res = {
      ...(res || {}),
      output: jr.output,
      is_error: typeof jr.is_error === 'boolean' ? flagBeside(jr.is_error, res && res.exit_code) : res ? res.is_error : null,
      status: res ? res.status : jr.outcome === 'rejected' ? 'denied' : 'completed',
    };
  }

  // A credential-bearing tool: the model context's copy is no safer than the step's. Its args keep
  // only naming keys and its output (and exit code) is never written, whatever the source.
  if (secret || isCredName(name)) {
    args = Object.fromEntries(Object.entries(args || {})
      .filter(([k]) => SENSITIVE_ARG_NAMES.has(k))
      .map(([k, v]) => [k, namingValue(v)])
      .filter(([, v]) => v !== undefined));
    if (res) res = { ...res, output: null, exit_code: null };
  }
  // The MCP server from the step itself: the JSON context names only the tool.
  const server = kind === 'mcp' && argsMsg ? str(argsMsg.str(9)) ?? str(argsMsg.str(4)) : null;
  const call = { part_id: `${j}:call`, kind: 'tool_call', call_id: callId, name, args, server };
  let result = null;
  if (res) {
    const output = typeof res.output === 'string' ? res.output : null;
    // A denied or cancelled call did not complete: no flag, the model context's included.
    const completed = res.status !== 'denied' && res.status !== 'cancelled';
    result = {
      part_id: `${j}:result`, kind: 'tool_result', call_id: callId, is_error: completed && typeof res.is_error === 'boolean' ? res.is_error : null, status: res.status,
      output, output_len: utf8Len(output), truncated: c === 34 ? true : null,
    };
    if (res.output_ref) result.output_ref = res.output_ref;
    // A truncated step keeps a preview; the whole step is another blob (source-only).
    if (c === 34 && K && K.has(1)) result.output_ref = { ref: `blob:${K.ref(1)}`, sha256: K.ref(1), bytes: K.num(4) };
    // The shell step's own exit code (RESULTS.shell); every other kind keeps none.
    result.exit_code = Number.isInteger(res.exit_code) ? res.exit_code : null;
  }
  return { call, result, child, ts: tc.num(59) };
}

// ---- derive: the model context ----------------------------------------------------------------

function jsonResultText(p) {
  if (typeof p.result === 'string') return p.result;
  if (Array.isArray(p.experimental_content)) return p.experimental_content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('');
  if (p.result != null) return JSON.stringify(p.result);
  if (p.output != null) return typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
  return '';
}
function jsonUserText(m) {
  if (typeof m.content === 'string') return m.content;
  return (Array.isArray(m.content) ? m.content : []).map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
}
function imageBytes(img) {
  if (isObj(img) && typeof img.hex === 'string') return Buffer.from(img.hex, 'hex');
  if (typeof img === 'string') {
    const m = /^data:[^;,]*;base64,(.*)$/s.exec(img);
    return Buffer.from(m ? m[1] : img, 'base64');
  }
  return null;
}

// Index the model messages reachable from the root, archived ones first: the served model per
// request, tool calls and results per call id, images per request, the last request of each
// archive and every request it holds, and the `<system_reminder>` messages.
function jsonIndex(lists, json) {
  const ix = { models: new Map(), calls: new Map(), results: new Map(), images: new Map(), lastReq: new Map(), archReqs: new Map(), reminders: new Map() };
  let lastSeen = '';
  for (const { key, ids } of lists) {
    let req = '';
    for (const id of ids) {
      const m = json(id);
      if (!isObj(m)) continue;
      const po = isObj(m.providerOptions) && isObj(m.providerOptions.cursor) ? m.providerOptions.cursor : {};
      const content = Array.isArray(m.content) ? m.content : [];
      if (m.role === 'user') {
        if (!str(po.requestId)) {
          // One message per distinct blob: the head of the context may be carried into an archive
          // and the root alike, so a repeat is not told from a carry-over.
          const text = jsonUserText(m);
          if (/^\s*<system_reminder>/.test(text) && !ix.reminders.has(id)) ix.reminders.set(id, { text, after: lastSeen });
          continue;
        }
        lastSeen = po.requestId;
        req = po.requestId;
        if (key) {
          ix.lastReq.set(key, req);
          if (!ix.archReqs.has(key)) ix.archReqs.set(key, []);
          if (!ix.archReqs.get(key).includes(req)) ix.archReqs.get(key).push(req);
        }
        if (ix.images.has(req)) continue;
        const imgs = [];
        for (const p of content) {
          if (!p || p.type !== 'image') continue;
          const bytes = imageBytes(p.image);
          imgs.push({ media_type: str(p.mimeType) ?? str(p.mediaType), inline: bytes ? bytes.toString('base64') : null, bytes_len: bytes ? bytes.length : null });
        }
        if (imgs.length) ix.images.set(req, imgs);
      } else if (m.role === 'assistant') {
        for (const p of content) {
          if (!isObj(p)) continue;
          const mn = isObj(p.providerOptions) && isObj(p.providerOptions.cursor) ? p.providerOptions.cursor.modelName : null;
          if (req && str(mn) && !ix.models.has(req)) ix.models.set(req, mn);
          if (p.type === 'tool-call' && typeof p.toolCallId === 'string') ix.calls.set(p.toolCallId, { name: p.toolName, args: p.args });
        }
      } else if (m.role === 'tool') {
        const hl = isObj(po.highLevelToolCallResult) ? po.highLevelToolCallResult : null;
        const out = hl && isObj(hl.output) ? Object.keys(hl.output)[0] : '';
        for (const p of content) {
          if (!p || p.type !== 'tool-result' || typeof p.toolCallId !== 'string') continue;
          ix.results.set(p.toolCallId, { output: jsonResultText(p), is_error: hl && typeof hl.isError === 'boolean' ? hl.isError : null, outcome: out });
        }
      }
    }
  }
  return ix;
}

// ---- derive: the session
// --------------------------------------------------------------------------

// The meta row, reduced to the keys derive uses.
function pickMeta(o) {
  if (!isObj(o)) return null;
  const s = (v) => (typeof v === 'string' ? v : '');
  const si = isObj(o.subagentInfo) ? o.subagentInfo : null;
  const created = Number(o.createdAt);
  return {
    latestRootBlobId: s(o.latestRootBlobId).toLowerCase(), name: s(o.name), lastUsedModel: s(o.lastUsedModel),
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
    subagentInfo: si ? { parentAgentId: s(si.parentAgentId), toolCallId: s(si.toolCallId), typeName: s(si.typeName) } : null,
  };
}

// UserMessage #9 simulated_msg_reason (agent.v1 SimulatedMsgReason). A simulated message is the
// harness's, except where the text is the user's own; a commit reminder is injected.
const SIM_USER = new Set([9, 10, 11, 35]); // USER_SENT/INTERRUPTED/QUEUED_TO_SUBAGENT, INTERACTION_RESPONSE
const SIM_INJECTED = new Set([2]); // COMMIT_REMINDER
function userSource(um, inSubagent, sid) {
  if (um && um.bool(5)) {
    const r = um.num(9) || 0;
    if (SIM_USER.has(r)) return 'user';
    return SIM_INJECTED.has(r) ? 'injected' : 'automated';
  }
  const by = um ? um.str(27) : ''; // sent_by_agent_id (source-only)
  if (by && by !== sid) return 'automated';
  return inSubagent ? 'automated' : 'user'; // a sub-agent's prompt is its parent's
}

const bufOf = (u) => (u.enc === 'b64' ? Buffer.from(u.body, 'base64') : Buffer.from(u.body, 'utf8'));

// Every record of the session, and the keys held as incomplete. Throws MissingBlob or Malformed
// when the tree cannot be folded.
function fold(st, key) {
  const sid = key.session_id;
  const me = { harness: HARNESS, session_id: sid, incarnation: key.incarnation };
  const meta = st.meta;
  const raw = (id) => {
    const u = st.blobs[id];
    if (!u) throw new MissingBlob(id);
    return u;
  };
  const pbCache = new Map();
  const pb = (id) => {
    if (!pbCache.has(id)) {
      const u = raw(id);
      let m;
      if (u.enc === 'pb-json') {
        let tree;
        try {
          tree = JSON.parse(u.body);
        } catch {
          throw new Malformed('pb-json');
        }
        m = Msg.fromTree(tree.fields);
      } else m = Msg.from(bufOf(u));
      pbCache.set(id, m);
    }
    return pbCache.get(id);
  };
  const tryPb = (id) => {
    raw(id);
    try {
      return pb(id);
    } catch (e) {
      if (e instanceof Malformed) return null;
      throw e;
    }
  };
  const jsonCache = new Map();
  const json = (id) => {
    if (!jsonCache.has(id)) {
      const u = raw(id);
      let v = null;
      if (u.enc !== 'pb-json') {
        try {
          v = JSON.parse(bufOf(u).toString('utf8'));
        } catch {
          v = null;
        }
      }
      jsonCache.set(id, v);
    }
    return jsonCache.get(id);
  };
  const blobText = (id) => {
    const u = st.blobs[id];
    return !u || u.enc === 'pb-json' ? '' : bufOf(u).toString('utf8');
  };
  const blobLen = (id) => {
    const u = st.blobs[id];
    return !u || u.enc === 'pb-json' ? null : u.bytes;
  };

  const rootId = meta.latestRootBlobId;
  const root = !rootId || rootId === EMPTY_ROOT ? new Msg() : pb(rootId);
  const archives = archivesOf(root);
  const lists = archives.map((a) => {
    const am = pb(a);
    return { key: a, ids: [...am.refs(1), ...(am.has(4) ? [am.ref(4)] : [])] };
  });
  lists.push({ key: '', ids: root.refs(1) });
  const J = jsonIndex(lists, json);

  // Turns, decoded up front: summaries and reminders are placed relative to them.
  const turns = [];
  for (const id of root.refs(8)) {
    const t = tryPb(id);
    if (!t) continue; // a malformed turn is skipped, always the same way
    let agent = null;
    let shell = null;
    try {
      agent = t.has(1) ? t.msg(1) : null;
      shell = !agent && t.has(2) ? t.msg(2) : null;
    } catch (e) {
      if (e instanceof Malformed) continue;
      throw e;
    }
    if (!agent && !shell) continue;
    const umBlob = agent && agent.has(1) ? agent.ref(1) : '';
    turns.push({ agent, shell, rid: agent ? agent.str(3) : '', um: umBlob ? tryPb(umBlob) : null });
  }
  const rids = new Set(turns.map((t) => t.rid).filter(Boolean));
  const summaries = new Map(); // request id ('' = no anchor) -> [archive id]
  for (const a of archives) {
    const r = J.lastReq.get(a) || '';
    const k = rids.has(r) ? r : '';
    if (!summaries.has(k)) summaries.set(k, []);
    summaries.get(k).push(a);
  }
  // Reminders by the request before them: '^' = before the first turn, '' = at the end.
  const reminders = new Map();
  for (const [id, r] of J.reminders) {
    const k = !r.after ? '^' : rids.has(r.after) ? r.after : '';
    if (!reminders.has(k)) reminders.set(k, []);
    reminders.get(k).push({ id, text: r.text });
  }

  const recs = [];
  const held = noHeld();
  const seen = new Set();
  let seq = 0;
  // A message in fold order; a held one takes its place in the order too, so nothing after it
  // moves.
  const put = (m, isHeld) => {
    if (seen.has(m.message_id)) return; // one record per key: the first wins
    seen.add(m.message_id);
    m.order = pad(seq++);
    if (isHeld) held.message.push(m.message_id);
    else recs.push(m);
  };
  const base = (id, role, source) => ({
    type: 'message', message_id: id, parent_id: null, order: null, agent_id: '', role, source,
    to_user: null, to_model: null, status: 'complete', state: 'current', on_active_branch: null, ts: null,
    requested_model: null, served_model: null, effort: null, response_id: null, aliases: [], parts: [],
  });
  const byRequest = new Map(); // request id -> {user, last}: the message ids a compaction covers
  const children = new Map(); // child session id -> {at, held}
  const addChild = (id, at, isHeld) => {
    if (!id || id === sid) return;
    const c = children.get(id);
    if (!c) children.set(id, { at: at || '', held: isHeld });
    else {
      if (!c.at && at) c.at = at;
      if (!isHeld) c.held = false;
    }
  };
  const pushSummaries = (k) => {
    for (const a of summaries.get(k) || []) {
      put({
        ...base(a, 'system', 'system_notice'), to_user: false, to_model: true,
        parts: [{ part_id: '0', kind: 'summary', text: pb(a).str(2), replaces: { archive_ref: a } }],
      }, false);
      // The turns whose requests the archive holds: nothing is deleted, they stay current.
      const covered = (J.archReqs.get(a) || []).map((r) => byRequest.get(r)).filter(Boolean);
      recs.push({
        type: 'lifecycle', lifecycle_id: a, op: 'compaction',
        target: covered.length ? { range: { from_id: covered[0].user, through_id: covered[covered.length - 1].last } } : { session: true },
        at: null, ts: null, evidence: 'explicit',
      });
    }
  };
  const pushReminders = (k) => {
    for (const r of reminders.get(k) || []) {
      put({ ...base(r.id, 'system', 'injected'), to_user: false, to_model: true, parts: [{ part_id: '0', kind: 'text', text: r.text }] }, false);
    }
  };

  let anchor = sid;
  let anchorN = 0;
  for (let i = 0; i < turns.length; i++) {
    const lastTurn = i === turns.length - 1;
    const { agent, shell, rid, um } = turns[i];
    if (i === 0) pushReminders('^');

    if (shell) {
      // A shell-mode turn (`!cmd`) has no id of its own: anchored on the previous native id
      // (sessions-model §1 rule 4), its call on the message (rule 6).
      const mid = `${anchor}+${++anchorN}`;
      const done = shell.has(2);
      const cmdMsg = shell.has(1) ? tryPb(shell.ref(1)) : null;
      const outMsg = done ? tryPb(shell.ref(2)) : null;
      const out = done ? outMsg || new Msg() : null;
      const callId = `@${mid}:0`;
      const parts = [{ part_id: '0:call', kind: 'tool_call', call_id: callId, name: 'Shell', args: { command: cmdMsg ? cmdMsg.str(1) : '' }, server: null }];
      if (out) {
        const output = joinOut(out.str(1), out.str(2));
        // ShellOutput #3 exit_code (int32): proto3 leaves a 0 unwritten, so an absent field is 0;
        // none when the output blob does not decode.
        const exit = outMsg ? (outMsg.num(3) ?? 0) : null;
        // The fields read here (#1 stdout, #2 stderr, #3 exit_code) hold no success or failure flag,
        // so `is_error` is null: never derived from the exit code (sessions-model v1.x (#6), §2.3).
        parts.push({ part_id: '0:result', kind: 'tool_result', call_id: callId, is_error: null, status: 'completed', output, output_len: utf8Len(output), truncated: null, exit_code: exit });
      }
      // Still running while it is the last turn: held; a later turn ends it, interrupted.
      put({ ...base(mid, 'user', 'user'), status: done ? 'complete' : 'interrupted', parts }, !done && lastTurn);
      continue;
    }

    // Agent turn: the user message, then the reply.
    const nativeUser = (um && um.str(2)) || agent.str(10);
    const userId = nativeUser || (rid ? `${rid}:user` : `${anchor}+${++anchorN}`);
    const uparts = [];
    if (um && um.str(1)) uparts.push({ part_id: '0', kind: 'text', text: um.str(1) });
    (J.images.get(rid) || []).forEach((im, k) => uparts.push({ part_id: `att:${k}`, kind: 'attachment', media_type: im.media_type, inline: im.inline, ref: null, bytes_len: im.bytes_len }));
    const source = userSource(um, !!(meta.subagentInfo && meta.subagentInfo.parentAgentId), sid);
    put({ ...base(userId, 'user', source), ts: iso(um && um.num(25)), parts: uparts }, false);
    if (nativeUser || rid) {
      anchor = nativeUser || rid;
      anchorN = 0;
    }

    const assistantId = `${rid || userId}:assistant`;
    const steps = agent.refs(2);
    const parts = [];
    const kids = [];
    let running = false;
    let interrupted = false;
    let ts = null;
    steps.forEach((id, j) => {
      const pid = String(j);
      const s = tryPb(id);
      let am = null;
      let th = null;
      let tc = null;
      let bad = !s;
      if (s) {
        try {
          am = s.has(1) ? s.msg(1) : null;
          th = s.has(3) ? s.msg(3) : null;
          tc = s.has(2) ? s.msg(2) : null;
        } catch {
          bad = true;
        }
      }
      if (bad) {
        parts.push(notice(pid, 'undecodable step', 'undecodable'));
        return;
      }
      if (am || th) {
        const m = am || th;
        // completed_at_ms is no streaming signal: the last text step of every model response has
        // started_at_ms and never completed_at_ms (as a lab capture showed).
        const start = am ? m.num(2) : m.num(3);
        const text = m.str(1);
        parts.push(am ? { part_id: pid, kind: 'text', text } : text ? { part_id: pid, kind: 'reasoning', text, signature_len: null } : { part_id: pid, kind: 'reasoning', opaque: true, signature_len: null });
        if (ts === null && start) ts = start;
        return;
      }
      if (tc) {
        const t = toolParts(tc, j, `@${assistantId}:${j}`, J, blobText, blobLen);
        if (!t.result) {
          if (lastTurn) running = true;
          else interrupted = true;
        }
        if (t.child) kids.push([t.child, t.call.call_id]);
        parts.push(t.call);
        if (t.result) parts.push(t.result);
        if (ts === null && t.ts) ts = t.ts;
        return;
      }
      parts.push(notice(pid, `unknown step kind #${s.keys()[0] ?? '?'}`, 'step'));
    });
    // The reply is not finished while its last tool has no result or no step exists yet.
    const hold = lastTurn && (running || !steps.length);
    put({
      ...base(assistantId, 'assistant', 'model'), ts: iso(ts),
      status: interrupted || !steps.length ? 'interrupted' : 'complete',
      requested_model: str(meta.lastUsedModel), served_model: str(J.models.get(rid)) ?? str(agent.str(7)), parts,
    }, hold);
    for (const [cid, at] of kids) addChild(cid, at, hold);
    if (rid) {
      byRequest.set(rid, { user: userId, last: hold ? userId : assistantId });
      pushSummaries(rid);
      pushReminders(rid);
    }
  }
  if (!turns.length) pushReminders('^');
  pushSummaries('');
  pushReminders('');

  // The parent names its sub-agents: the Task result (above), subagent_states (#16, keyed by the
  // child id) and the runs by parent tool call (#30: #1 the call, #2 the child).
  const entries = (n) => {
    try {
      return root.msgs(n);
    } catch {
      return [];
    }
  };
  for (const e of entries(16)) addChild(e.str(1), '', false);
  for (const e of entries(30)) {
    let run = null;
    try {
      run = e.msg(2);
    } catch {
      run = null;
    }
    if (run) addChild(run.str(2), run.str(1) || e.str(1), false);
  }
  for (const [cid, c] of children) {
    const link = {
      type: 'link', kind: 'subagent', stated_on: 'origin', child: { harness: HARNESS, session_id: cid }, origin: me,
      at: c.at, inherits: null, child_stored: true, evidence: 'explicit',
    };
    if (c.held) held.link.push(recordKey(link));
    else recs.push(link);
  }
  const si = meta.subagentInfo;
  if (si && si.parentAgentId && si.parentAgentId !== sid) {
    recs.push({
      type: 'link', kind: 'subagent', stated_on: 'child', child: me, origin: { harness: HARNESS, session_id: si.parentAgentId },
      at: si.toolCallId || '', inherits: null, child_stored: true, evidence: 'explicit',
    });
  }

  // cwd: the root's workspace URI; else meta.json's, but only while md5(cwd) is still the chat's
  // bucket (meta.json's cwd drifts on resume; memhouse). last_cwd: meta.json's (sessions-model
  // §2.1).
  const mj = st.meta_json;
  const bucket = /^chats\/([^/]+)\//.exec(st.meta_json_key || '');
  let cwd = str(uriPath(root.strs(9)[0] || ''));
  if (!cwd && mj && mj.cwd && bucket && md5(mj.cwd) === bucket[1]) cwd = mj.cwd;
  return {
    recs, held,
    session: {
      title: str(meta.name), cwd, last_cwd: mj ? str(mj.cwd) : null, created_at: iso(meta.createdAt || root.num(26)),
      // `kind` is the native session type, and cursor-agent stores none: a flag or a parent
      // reference is not a kind (sessions-model v1.x (#6), §2.1). A sub-agent is told by its §2.5
      // link from meta.subagentInfo, above.
      client: str(root.str(22)), kind: null,
    },
  };
}

// ---- derive -----------------------------------------------------------------------------------

function emptyState() {
  return {
    state_ver: STATE_VER,
    blobs: {}, // blob id -> {enc, body, bytes}: every current unit of the blobs source
    meta: null, // the meta row, reduced (pickMeta)
    meta_json_key: null,
    meta_json: null, // {cwd}
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
  };
}

function kindOf(sk) {
  if (sk.endsWith('/store.db#table:blobs')) return 'blobs';
  if (sk.endsWith('/store.db#table:meta')) return 'meta';
  if (sk.endsWith('/meta.json')) return 'meta_json';
  return null;
}

const lastOf = (units) => units[units.length - 1];

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
    const units = src.units ?? [];
    const kind = kindOf(src.source_key);
    if (kind === 'blobs') {
      if (src.complete) st.blobs = {};
      for (const u of units) st.blobs[u.unit_key] = { enc: u.enc, body: u.body, bytes: u.bytes };
      for (const k of src.gone ?? []) delete st.blobs[k];
    } else if (kind === 'meta') {
      if (units.length) {
        const v = ((jsonOf(lastOf(units)) || {}).meta || [])[0]?.value;
        st.meta = pickMeta(typeof v === 'string' ? parseMetaValue(v) : v);
      } else if (src.complete) st.meta = null;
    } else if (kind === 'meta_json') {
      st.meta_json_key = src.source_key;
      if (units.length) {
        const o = jsonOf(lastOf(units));
        st.meta_json = { cwd: isObj(o) && typeof o.cwd === 'string' ? o.cwd : null };
      } else if (src.complete) st.meta_json = null;
    }
  }

  const versions = { adapter_ver: describeData.adapter_ver, model_version: describeData.model_version, state_ver: STATE_VER };
  let built = null;
  if (st.meta) {
    try {
      built = fold(st, key);
    } catch (e) {
      if (!(e instanceof MissingBlob) && !(e instanceof Malformed)) throw e;
    }
  }
  if (!built) {
    // No meta row, or a tree with a blob not read yet (its blobs were read before the meta that
    // names them): nothing can be folded. Every key emitted so far is held, so none is rewritten
    // or tombstoned, and the next pass folds the whole tree.
    const held = {};
    for (const type of Object.keys(st.emitted)) held[type] = Object.keys(st.emitted[type]).sort();
    return { changed: [], live: noHeld(), held, state: st, checkpoint: true, ...versions };
  }

  const sealed = built.recs.map((r) => seal({ ...r, ...key, type: r.type }));
  const msgs = sealed.filter((r) => r.type === 'message').sort(byOrder);
  let updated = null;
  for (const m of msgs) if (m.ts && (!updated || m.ts > updated)) updated = m.ts;
  const s = built.session;
  const sessionRec = seal({
    type: 'session', ...key, engine: null, client: s.client, harness_version: null,
    // The title is generated, and `/rename` rewrites it in place; the store does not say which.
    title: s.title, title_set_by: s.title ? 'unknown' : null,
    cwd: s.cwd, last_cwd: s.last_cwd, created_at: s.created_at, updated_at: updated,
    state: 'active', pinned: null, mode: null, kind: s.kind,
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
  return { changed, live: liveOut, held, state: st, checkpoint: true, ...versions };
}
