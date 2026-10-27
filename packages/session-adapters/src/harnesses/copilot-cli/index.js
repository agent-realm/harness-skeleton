// GitHub Copilot CLI: `<COPILOT_HOME>/session-state/<sid>/events.jsonl`, an append-only JSONL of
// events per session, plus `workspace.yaml` beside it. VS Code's Copilot engine writes into the
// same
// harness store (`client_name: vscode-agent-host`), so those sessions are harness copilot-cli with
// client vscode (sessions-model §1 rule 3). sessions v1 four operations over sessions-model v1.1
// records.
//
// Ported from memhouse's v4 normaliser (its copilot-cli module: the record selection, the
// tool hold and the turn ends, the notification projection, the fork text). New here: records in
// the sessions-model shape; a tool result is its own `tool` message, keyed by its completion event;
// usage as its own records, including a usage_record with no message and the compaction's own
// tokens; the pending-tool hold as derive `held`, for the waiting message only (memhouse held
// everything after it, because its log was ordered by append); `order` from the byte offset;
// lifecycle records keyed by their event ids; the `session.start` id as the incarnation, which
// `read` checks.

import fs from 'node:fs';
import path from 'node:path';
import { SessionsError } from '../../errors.js';
import { isRealFile, readStream, readSnapshot, streamUnits, snapshotUnits, unknownSource, jsonOf } from '../../sources.js';
import { seal, recordKey } from '../../records.js';
import { sha256 } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'copilot-cli';
const STATE_VER = 1;
const LINE1_MAX = 1024 * 1024;
const UUID_IN_PARENS = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

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

// A regular file, never a symlink to one.
function isFile(p) {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

// A session id is one path component: never empty, `.`, `..`, or holding a separator.
function sidOk(sid) {
  return typeof sid === 'string' && sid !== '' && sid !== '.' && sid !== '..' && !/[\\/\0]/.test(sid);
}

const eventsKey = (sid) => `session-state/${sid}/events.jsonl`;
const workspaceKey = (sid) => `session-state/${sid}/workspace.yaml`;

// The `session.start` event id: the incarnation (sessions-model §1 rule 2).
function startIdOf(o) {
  return o && o.type === 'session.start' && typeof o.id === 'string' && o.id ? o.id : null;
}

// Line 1's `session.start` id, or null while line 1 is partial or is no `session.start`.
function birthOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(LINE1_MAX);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl < 0) return null;
    return startIdOf(JSON.parse(buf.subarray(0, nl).toString('utf8')));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function sourceStat(harnessPath, sourceKey) {
  try {
    const st = fs.statSync(path.join(harnessPath, sourceKey));
    return [sourceKey, st.size, Math.trunc(st.mtimeMs)];
  } catch {
    return [sourceKey, -1, -1];
  }
}

// One session per `session-state/<sid>/` whose events.jsonl starts with a complete
// `session.start`. A directory without one is not born yet, or is no session, and is not listed.
export function list(store) {
  const out = [];
  for (const e of readdir(path.join(store.harness_path, 'session-state'))) {
    const sid = e.name;
    // A real directory only: a symlinked session folder is not walked (its events.jsonl would
    // pass lstat, which checks only the last path component).
    if (!e.isDirectory() || !sidOk(sid) || sid.startsWith('.')) continue;
    const events = path.join(store.harness_path, eventsKey(sid));
    if (!isFile(events)) continue;
    const incarnation = birthOf(events);
    if (!incarnation) continue;
    const sources = [{ source_key: eventsKey(sid), role: 'main', mode: 'stream', position_kind: 'byte_offset' }];
    if (isFile(path.join(store.harness_path, workspaceKey(sid)))) {
      sources.push({ source_key: workspaceKey(sid), role: 'side', mode: 'snapshot', position_kind: 'snapshot' });
    }
    out.push({
      session_id: sid,
      incarnation,
      updated_hint: sha256(JSON.stringify(sources.map((s) => sourceStat(store.harness_path, s.source_key)))).slice(0, 32),
      // `inuse.<pid>.lock` outlives a crashed process and names a pid of this host only; it is not
      // read, so liveness is not claimed.
      live: 'unknown',
      sources,
    });
  }
  return out.sort((a, b) => (a.session_id < b.session_id ? -1 : 1));
}

// ---- read -------------------------------------------------------------------------------------

export function read(store, session, sourceKey, from = null, known = null) {
  void known; // a stream ignores `known`, and a snapshot compares its sha (sessions §2, rules 3 and 5)
  const sid = session.session_id;
  if (!sidOk(sid)) throw new SessionsError('session_unknown', `no session ${sid}`, [String(sid)]);
  const events = path.join(store.harness_path, eventsKey(sid));
  // Checked segment by segment, so a symlinked session folder is never read, not even line 1.
  if (!isRealFile(store.harness_path, eventsKey(sid))) throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
  const born = birthOf(events);
  if (!born) throw new SessionsError('session_unknown', `session ${sid} has no session.start yet`, [sid]);
  const gone = () => new SessionsError('incarnation_gone', `session ${sid} is now incarnation ${born}`, [sid, String(session.incarnation ?? '')]);
  if (born !== (session.incarnation ?? '')) throw gone();

  if (sourceKey === eventsKey(sid)) {
    const r = readStream(events, sourceKey, from, { root: store.harness_path });
    // The id may have been reused between the check above and this read: line 1 decides.
    const first = r.units.find((u) => u.unit_key === '0');
    if (first && startIdOf(jsonOf(first)) !== born) throw gone();
    return r;
  }
  if (sourceKey === workspaceKey(sid)) return readSnapshot(path.join(store.harness_path, sourceKey), sourceKey, from, { root: store.harness_path });
  throw new SessionsError('source_unknown', `${sourceKey} is not a source of ${sid}`, [sourceKey]);
}

// The units `read` returns from scratch for a source holding `bytes` (src/index.js
// unitsFromBytes), from the source key alone: no session, no position, no file system. With no
// session there is no incarnation to check: line 1's `session.start` id is in the units.
export function unitsFromBytes(sourceKey, bytes, { start = 0 } = {}) {
  const m = typeof sourceKey === 'string' ? /^session-state\/([^/]+)\/(events\.jsonl|workspace\.yaml)$/.exec(sourceKey) : null;
  if (!m || !sidOk(m[1]) || m[1].startsWith('.')) throw unknownSource(HARNESS, sourceKey);
  return m[2] === 'events.jsonl' ? streamUnits(bytes, sourceKey, { start }) : snapshotUnits(bytes, sourceKey, { start });
}

// ---- derive -----------------------------------------------------------------------------------

function isoTs(v) {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function str(v) {
  return typeof v === 'string' && v ? v : null;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function utf8Len(s) {
  return Buffer.byteLength(s, 'utf8');
}

// Tool arguments: an object as stored; a JSON string parsed; any other string kept as it is.
function argsOf(a) {
  if (a === undefined || a === null) return {};
  if (typeof a === 'string') {
    try {
      return JSON.parse(a);
    } catch {
      return a;
    }
  }
  return a;
}

// A completion's output: `result.content` as a string, or its text items joined; else the error's
// message (memhouse resultText).
function resultText(d) {
  const r = d.result;
  if (r && typeof r.content === 'string') return r.content;
  if (r && Array.isArray(r.content)) return r.content.map((c) => (typeof c === 'string' ? c : c && typeof c.text === 'string' ? c.text : '')).join('');
  if (d.error) return typeof d.error === 'string' ? d.error : str(d.error.message) ?? str(d.error.code) ?? 'error';
  return '';
}

// `workspace.yaml` is flat `key: value`; only top-level scalars are read. A double-quoted value is
// unescaped as JSON, a single-quoted one by YAML's doubled quote.
function parseWorkspace(text) {
  const ws = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t\r]*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    } else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1).replace(/''/g, "'");
    }
    ws[m[1]] = v;
  }
  return ws;
}

// `client_name` names the program that wrote the session (annex: vscode-agent-host → vscode).
function clientOf(name) {
  if (!name) return null;
  if (name === 'vscode-agent-host') return 'vscode';
  if (name === 'github/cli') return 'copilot-cli';
  return name;
}

// A turn ends for its agent at its next prompt, an abort or its turn end (memhouse ENDS). A
// shutdown
// ends every agent's turn: the process that ran them has exited.
const ENDS = new Set(['user.message', 'abort', 'assistant.turn_end']);

function emptyState() {
  return {
    state_ver: STATE_VER,
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
    birth: null, // the session.start event's timestamp: a fork copies earlier events from its origin
    // Session fields, each kept with the sort key of the event it came from: [key, value].
    session: { harness_version: null, cwd: null, last_cwd: null, created_at: null, updated_at: null, mode: null },
    ws: null, // the last workspace.yaml snapshot: { name, user_named, client_name }
    cmp: {}, // message_id -> [order, cmp_sha], main conversation only
    pending: {}, // message_id -> { rec, open: [call ids] }: an assistant message waiting for its tools
    done: {}, // call id -> true: a completion no waiting message claimed
    servers: {}, // call id -> MCP server name, from tool.execution_start
    api: {}, // apiCallId -> { model, effort }, from session.usage_record
    assets: {}, // assetId -> { mime, len, data }, from session.binary_asset
    usage_n: 0, // usage records without a native id, anchored to the session
  };
}

// One record per key in its final state (sessions-model §1 rule 5). Every record but the session
// record is final when it is put. An assistant message with a tool call is `held` until every call
// has its completion (then `complete`), or its agent's turn ends (then `interrupted`).
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
  const ctx = { st, put, key };

  for (const src of input) {
    const sk = src.source_key;
    const isWorkspace = sk.endsWith('/workspace.yaml');
    for (const u of src.units ?? []) {
      if (isWorkspace) {
        const ws = parseWorkspace(u.enc === 'utf8' ? u.body : '');
        st.ws = { name: str(ws.name), user_named: str(ws.user_named), client_name: str(ws.client_name) };
        continue;
      }
      const o = jsonOf(u);
      if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.type !== 'string') continue;
      if (o.ephemeral === true) continue; // stdout only, never persisted (spec §3)
      foldEvent(ctx, o, sk, u.unit_key);
    }
  }

  // The session record: always re-sealed, since updated_at and the fingerprint move.
  const v = Object.fromEntries(Object.entries(st.session).map(([k, x]) => [k, x ? x[1] : null]));
  const ws = st.ws ?? {};
  const cmpShas = Object.values(st.cmp).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
  put({
    type: 'session',
    engine: null,
    client: clientOf(ws.client_name),
    harness_version: v.harness_version,
    title: ws.name ?? null,
    // `user_named` is true after `-n` or `/rename`; otherwise the name is the first prompt (spec
    // §3).
    title_set_by: ws.name ? (ws.user_named === 'true' ? 'user' : ws.user_named === 'false' ? 'auto' : 'unknown') : null,
    cwd: v.cwd,
    last_cwd: v.last_cwd,
    created_at: v.created_at,
    updated_at: v.updated_at,
    state: 'active',
    pinned: null,
    mode: v.mode,
    kind: null,
    reuse: 'detected',
    ts_source: 'event',
    aliases: [],
    fingerprint: { cmp_shas: cmpShas },
  });

  const live = {};
  for (const [type, ks] of Object.entries(st.emitted)) live[type] = Object.keys(ks).sort();
  return {
    changed: [...out.values()],
    live,
    held: { session: [], message: Object.keys(st.pending).sort(), usage: [], link: [], lifecycle: [] },
    state: st,
    checkpoint: true,
    adapter_ver: describeData.adapter_ver,
    model_version: describeData.model_version,
    state_ver: STATE_VER,
  };
}

// Keep the value from the earliest (`first`) or latest event by its sort key.
function keep(s, field, value, sortKey, first) {
  if (value === null || value === undefined || value === '') return;
  const cur = s[field];
  if (!cur || (first ? sortKey < cur[0] : sortKey > cur[0])) s[field] = [sortKey, value];
}

function emitMessage(ctx, m) {
  const r = ctx.put({ type: 'message', ...m, parts: m.parts.map((p, i) => ({ part_id: String(i), ...p })) });
  if (r.agent_id === '') ctx.st.cmp[r.message_id] = [r.order, r.cmp_sha];
  return r;
}

// An assistant message whose calls are all done, or whose turn ended: emitted, and never held
// again.
// Each call's MCP server is known by now: tool.execution_start comes before its completion.
function release(ctx, id, status) {
  const p = ctx.st.pending[id];
  delete ctx.st.pending[id];
  const parts = p.rec.parts.map((x) => {
    if (x.kind !== 'tool_call') return x;
    const server = ctx.st.servers[x.call_id] ?? null;
    delete ctx.st.servers[x.call_id];
    return { ...x, server };
  });
  emitMessage(ctx, { ...p.rec, status, parts });
}

// A `session.info` marker a fork copied from its origin keeps the origin's timestamp, which is
// before this session's own `session.start` (fixture vscode-host: every copied line is older than
// the child's line 1). It is the origin's history, not this session's.
function copied(st, ts) {
  return st.birth !== null && ts !== null && Date.parse(ts) < Date.parse(st.birth);
}

function foldEvent(ctx, o, sk, unitKey) {
  const { st, put, key } = ctx;
  const d = o.data && typeof o.data === 'object' ? o.data : {};
  const ts = isoTs(o.timestamp);
  const order = unitKey.padStart(12, '0');
  const id = str(o.id);
  const agent = str(o.agentId) ?? '';
  const s = st.session;

  if (ts) keep(s, 'updated_at', ts, ts, false);

  // A turn's end releases its agent's waiting messages, as interrupted.
  if (ENDS.has(o.type) || o.type === 'session.shutdown') {
    for (const [mid, p] of Object.entries(st.pending)) {
      if (o.type === 'session.shutdown' || p.rec.agent_id === agent) release(ctx, mid, 'interrupted');
    }
  }

  const base = {
    message_id: id ?? `@${unitKey}`, parent_id: str(o.parentId), order, agent_id: agent,
    to_user: null, to_model: null, status: 'complete', state: 'current', on_active_branch: null, ts,
    requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
  };
  const lifecycleId = id ?? `${sk}@${unitKey}#1`;
  const ctxCwd = (c) => (c && typeof c === 'object' ? str(c.cwd) : null);

  switch (o.type) {
    case 'session.start':
      if (st.birth === null) st.birth = ts;
      keep(s, 'harness_version', str(d.copilotVersion), order, true);
      keep(s, 'created_at', isoTs(d.startTime) ?? ts, order, true);
      keep(s, 'cwd', ctxCwd(d.context), order, true);
      keep(s, 'last_cwd', ctxCwd(d.context), order, false);
      return;
    case 'session.resume':
      keep(s, 'last_cwd', ctxCwd(d.context), order, false);
      return;
    case 'session.context_changed':
      keep(s, 'last_cwd', str(d.cwd), order, false);
      return;
    case 'session.mode_changed':
      keep(s, 'mode', str(d.newMode), order, false);
      return;
    case 'session.binary_asset':
      if (str(d.assetId)) st.assets[d.assetId] = { mime: str(d.mimeType), len: num(d.byteLength), data: str(d.data) };
      return;
    case 'tool.execution_start':
      if (str(d.toolCallId) && str(d.mcpServerName)) st.servers[d.toolCallId] = d.mcpServerName;
      return;

    case 'session.usage_record': {
      // One per model call, written just before its assistant.message, or alone when the reply was
      // cut off (`finishReason: length`; seen in the fixture captures): a usage
      // record either way.
      const u = d.usage && typeof d.usage === 'object' ? d.usage : null;
      if (!u) return;
      const model = str(u.modelDisplayName) ?? str(u.model);
      const api = str(u.apiCallId);
      if (api) st.api[api] = { model, effort: str(u.reasoningEffort) };
      let usageId = api;
      let anchor = { response_id: api };
      if (!api) {
        st.usage_n += 1;
        usageId = `session#${st.usage_n}`;
        anchor = { session: true };
      }
      const cost = num(u.cost);
      put({
        type: 'usage', usage_id: usageId, anchor,
        input: num(u.inputTokens), output: num(u.outputTokens), cache_read: num(u.cacheReadTokens),
        cache_write: num(u.cacheWriteTokens), reasoning: num(u.reasoningTokens),
        // Copilot's own credit unit, 0 under BYOK: a stored zero is null (sessions-model §2.4).
        cost: cost !== null && cost > 0 ? cost : null,
        input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_response', model,
      });
      return;
    }

    case 'user.message': {
      const parts = [];
      if (typeof d.content === 'string' && d.content) parts.push({ kind: 'text', text: d.content });
      for (const a of Array.isArray(d.attachments) ? d.attachments : []) {
        if (!a || typeof a !== 'object') continue;
        // The bytes are in the `session.binary_asset` the attachment names, written just before.
        const asset = str(a.assetId) ? st.assets[a.assetId] ?? null : null;
        const part = { kind: 'attachment', media_type: (asset && asset.mime) ?? str(a.mimeType) };
        if (asset && asset.data) {
          part.inline = asset.data;
          part.bytes_len = Buffer.from(asset.data, 'base64').length;
        } else {
          part.ref = str(a.path) ?? str(a.displayName) ?? str(a.assetId);
          part.bytes_len = (asset && asset.len) ?? num(a.byteLength);
        }
        parts.push(part);
      }
      // A sub-agent's prompt is written by its parent agent (`source: agent-<sid>`).
      const auto = typeof d.source === 'string' && d.source.startsWith('agent-');
      emitMessage(ctx, {
        ...base, role: 'user', source: auto ? 'automated' : 'user',
        aliases: str(d.messageId) ? [{ id: d.messageId, kind: 'messageId' }] : [], parts,
      });
      return;
    }

    case 'assistant.message': {
      const parts = [];
      if (typeof d.reasoningText === 'string' && d.reasoningText) parts.push({ kind: 'reasoning', text: d.reasoningText, signature_len: null });
      // Vendor-encrypted reasoning (VS Code's agent host): opaque, with its length (sessions-model
      // §2.3).
      if (typeof d.encryptedContent === 'string' && d.encryptedContent) parts.push({ kind: 'reasoning', opaque: true, signature_len: d.encryptedContent.length });
      if (typeof d.content === 'string' && d.content) parts.push({ kind: 'text', text: d.content });
      const reqs = (Array.isArray(d.toolRequests) ? d.toolRequests : []).filter((r) => r && typeof r === 'object');
      const msgId = base.message_id;
      reqs.forEach((r, i) => {
        // call_id is native; without one, '@<message_id>:<index>' (sessions-model §1 rule 6).
        parts.push({ kind: 'tool_call', call_id: str(r.toolCallId) ?? `@${msgId}:${i}`, name: String(r.name ?? 'unknown'), args: argsOf(r.arguments), server: null });
      });
      // Served model and effort: the usage_record of the same API call (spec §7).
      const api = str(d.apiCallId);
      const served = api ? st.api[api] ?? null : null;
      if (api) delete st.api[api];
      const rec = {
        ...base, role: 'assistant', source: 'model',
        requested_model: str(d.model), served_model: served ? served.model : null, effort: served ? served.effort : null,
        response_id: api, aliases: str(d.messageId) ? [{ id: d.messageId, kind: 'messageId' }] : [], parts,
      };
      const open = parts.filter((p) => p.kind === 'tool_call').map((p) => p.call_id).filter((c) => {
        if (!st.done[c]) return true;
        delete st.done[c];
        return false;
      });
      st.pending[msgId] = { rec, open };
      if (!open.length) release(ctx, msgId, 'complete');
      return;
    }

    case 'tool.execution_complete': {
      const call = str(d.toolCallId) ?? '';
      const output = resultText(d);
      const exit = d.shellExecution && typeof d.shellExecution === 'object' ? num(d.shellExecution.exitCode) : null;
      const exitCode = Number.isInteger(exit) ? exit : null;
      // `is_error` is the harness store's own flag (sessions-model v1.x proposal (#6), §2.3): the stored
      // `success` copied, false giving true and true giving false; without a flag it is null. A flag
      // that says success beside a shell's non-zero `exit_code` is unreliable for that result, as
      // §2.3 rules for Copilot CLI and Codex alike: that result's `is_error` is null, `exit_code`
      // carries the failure, and the other results keep the flag. Never derived from the exit code
      // or the text. It describes a call that completed: a denied call's is null, and `denied`
      // carries the fact.
      const denied = !!d.error && typeof d.error === 'object' && d.error.code === 'denied';
      const isError = denied ? null : d.success === false ? true : d.success === true ? (exitCode !== null && exitCode !== 0 ? null : false) : null;
      // A tool result is written by the harness running the tool: no `source` value fits it.
      emitMessage(ctx, {
        ...base, role: 'tool', source: null,
        // `shellExecution.exitCode` is stored beside the result text, never parsed out of it.
        parts: [{ kind: 'tool_result', call_id: call, is_error: isError, status: denied ? 'denied' : 'completed', output, output_len: utf8Len(output), truncated: null, exit_code: exitCode }],
      });
      const waiting = Object.keys(st.pending).sort().find((mid) => st.pending[mid].open.includes(call));
      if (!waiting) {
        if (call) st.done[call] = true;
        return;
      }
      const p = st.pending[waiting];
      p.open = p.open.filter((c) => c !== call);
      if (!p.open.length) release(ctx, waiting, 'complete');
      return;
    }

    case 'system.notification': {
      // The text, or a type/status line built from plain strings only: never the native record
      // itself, whose other fields are not conversation (memhouse).
      const kind = d.kind && typeof d.kind === 'object' ? d.kind : {};
      const word = (x) => (typeof x === 'string' && x ? x : '');
      const nativeType = word(typeof d.kind === 'string' ? d.kind : kind.type);
      const text = typeof d.content === 'string' ? d.content : [nativeType, word(kind.status || d.status)].filter(Boolean).join(' ');
      if (!text) return;
      emitMessage(ctx, { ...base, role: 'system', source: 'injected', parts: [{ kind: 'notice', text, level: null, native_type: nativeType || null }] });
      return;
    }

    case 'session.compaction_complete': {
      if (typeof d.summaryContent !== 'string' || !d.summaryContent) return;
      // A count, never an id range; the replaced events stay in the file (spec §5).
      const removed = num(d.messagesRemoved);
      emitMessage(ctx, {
        ...base, role: 'system', source: 'automated',
        parts: [{ kind: 'summary', text: d.summaryContent, replaces: removed !== null ? { count: removed } : 'unknown' }],
      });
      put({ type: 'lifecycle', lifecycle_id: lifecycleId, op: 'compaction', target: { session: true }, at: null, ts, evidence: 'explicit' });
      // The compaction's own model call has no usage_record: usage anchored to the compaction.
      const t = d.compactionTokensUsed && typeof d.compactionTokensUsed === 'object' ? d.compactionTokensUsed : null;
      if (t && id) {
        const cost = num(t.cost);
        put({
          type: 'usage', usage_id: `compaction:${id}#1`, anchor: { compaction: id },
          input: num(t.inputTokens), output: num(t.outputTokens), cache_read: num(t.cacheReadTokens),
          cache_write: num(t.cacheWriteTokens), reasoning: num(t.reasoningTokens),
          cost: cost !== null && cost > 0 ? cost : null,
          input_includes_cache: null, output_includes_reasoning: null, granularity: num(t.requestCount) === 1 ? 'per_response' : 'per_turn',
          model: str(t.modelDisplayName) ?? str(t.model),
        });
      }
      return;
    }

    case 'session.info': {
      if (copied(st, ts)) return;
      if (d.infoType === 'rewind') {
        // The rewound events are gone from the rewritten file: their keys leave through the reset.
        put({ type: 'lifecycle', lifecycle_id: lifecycleId, op: 'rewind', target: { session: true }, at: null, ts, evidence: 'explicit' });
        return;
      }
      if (d.infoType !== 'fork') return;
      // Stated on both sides, naming the other session in text. The origin writes `Forked this
      // session into "<name>" (<child>).`; the child's wording is in no fixture.
      const text = typeof d.message === 'string' ? d.message : '';
      const self = String(key.session_id).toLowerCase();
      const other = [...text.matchAll(UUID_IN_PARENS)].map((m) => m[1]).filter((x) => x.toLowerCase() !== self).pop();
      if (!other) return;
      const me = { harness: HARNESS, session_id: key.session_id, incarnation: key.incarnation };
      const them = { harness: HARNESS, session_id: other };
      const onOrigin = /^Forked this session into\b/.test(text);
      put({
        type: 'link', kind: 'fork',
        child: onOrigin ? them : me, origin: onOrigin ? me : them,
        stated_on: onOrigin ? 'origin' : 'child',
        // The text names no message, so there is no fork point to state.
        at: '',
        // The child copies the origin's events with their ids, usage_records included (spec §5).
        inherits: { through_message_id: null, ids_preserved: true, marked: false, usage_copied: true },
        child_stored: true,
        evidence: 'explicit',
      });
      put({ type: 'lifecycle', lifecycle_id: lifecycleId, op: 'fork', target: { session: true }, at: null, ts, evidence: 'explicit' });
      return;
    }
    default:
      // system.message, model.*, hook.*, permission.*, subagent.*, skill.*, abort,
      // assistant.turn_*, session.shutdown and other bookkeeping make no record (memhouse); their
      // units stay whole in the consumer's archive.
  }
}
