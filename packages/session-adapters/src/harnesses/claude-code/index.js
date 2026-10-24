// Claude Code: `<config dir>/projects/<encoded cwd>/<session>.jsonl`, an append-only JSONL per
// session, plus one append-only JSONL per sub-agent under `<session>/subagents/`. sessions v1
// four operations over sessions-model v1.1 records.
//
// Ported from memhouse's v3 reader (its Claude Code module: the block switch, the response
// boundary on `message.id`, usage growth within a response). New here: records in the sessions-model
// shape, usage as its own record, the compaction lifecycle record, keys without `ts`.

import fs from 'node:fs';
import path from 'node:path';
import { SessionsError } from '../../errors.js';
import { readStream, streamUnits, unknownSource, plainRel, jsonOf } from '../../sources.js';
import { seal, recordKey } from '../../records.js';
import { sha256 } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'claude-code';
const STATE_VER = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// A directory entry for one name, or none, without listing the directory.
function statEntry(dir, name) {
  try {
    const st = fs.lstatSync(path.join(dir, name));
    return [{ name, isFile: () => st.isFile(), isDirectory: () => st.isDirectory() }];
  } catch {
    return [];
  }
}

// Every source of every session under `projects/`, grouped by session id, or of one session only
// when `only` names it. A session id that sits under two project folders keeps both main files as
// `main` sources (sessions §1).
function scan(harnessPath, only = null) {
  const sessions = new Map();
  const add = (sid, src) => {
    if (!sessions.has(sid)) sessions.set(sid, []);
    sessions.get(sid).push(src);
  };
  const projects = path.join(harnessPath, 'projects');
  for (const p of readdir(projects)) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(projects, p.name);
    // For one session, look only at its own two names instead of listing the project folder.
    const entries = only ? [`${only}.jsonl`, only].flatMap((name) => statEntry(pdir, name)) : readdir(pdir);
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const sid = e.name.slice(0, -'.jsonl'.length);
        if (UUID.test(sid)) add(sid, { source_key: `projects/${p.name}/${e.name}`, role: 'main', agent_id: '' });
      } else if (e.isDirectory() && UUID.test(e.name)) {
        const sub = path.join(pdir, e.name, 'subagents');
        const agentFiles = (dir, rel) => {
          for (const a of readdir(dir)) {
            const m = /^agent-(.+)\.jsonl$/.exec(a.name);
            if (a.isFile() && m) add(e.name, { source_key: `${rel}/${a.name}`, role: 'agent', agent_id: m[1] });
          }
        };
        const subRel = `projects/${p.name}/${e.name}/subagents`;
        agentFiles(sub, subRel);
        for (const w of readdir(path.join(sub, 'workflows'))) {
          if (w.isDirectory()) agentFiles(path.join(sub, 'workflows', w.name), `${subRel}/workflows/${w.name}`);
        }
      }
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
  const srcs = UUID.test(session.session_id) ? scan(store.harness_path, session.session_id).get(session.session_id) : null;
  if (!srcs) throw new SessionsError('session_unknown', `no session ${session.session_id}`, [session.session_id]);
  if (!srcs.some((s) => s.source_key === sourceKey)) throw new SessionsError('source_unknown', `${sourceKey} is not a source of ${session.session_id}`, [sourceKey]);
  return readStream(path.join(store.harness_path, sourceKey), sourceKey, from, { root: store.harness_path });
}

// The source keys `scan` names: a main file `projects/<p>/<sid>.jsonl`, and a sub-agent's
// `projects/<p>/<sid>/subagents/[workflows/<w>/]agent-<id>.jsonl`. All are streams.
const MAIN_KEY = /^projects\/[^/]+\/([^/]+)\.jsonl$/;
const AGENT_KEY = /^projects\/[^/]+\/([^/]+)\/subagents\/(?:workflows\/[^/]+\/)?agent-[^/]+\.jsonl$/;

// The units `read` returns from scratch for a source holding `bytes` (src/index.js
// unitsFromBytes), from the source key alone: no session, no position, no file system.
export function unitsFromBytes(sourceKey, bytes, { start = 0 } = {}) {
  const m = plainRel(sourceKey) ? MAIN_KEY.exec(sourceKey) ?? AGENT_KEY.exec(sourceKey) : null;
  if (!m || !UUID.test(m[1])) throw unknownSource(HARNESS, sourceKey);
  return streamUnits(bytes, sourceKey, { start });
}

// ---- derive -----------------------------------------------------------------------------------

function agentOf(sourceKey) {
  const m = /\/agent-([^/]+)\.jsonl$/.exec(sourceKey);
  return m ? m[1] : '';
}

function isoTs(v) {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).filter(Boolean).join('\n');
}

function utf8Len(s) {
  return Buffer.byteLength(s, 'utf8');
}

// MCP tools are named `mcp__<server>__<tool>`.
function serverOf(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  return m ? m[1] : null;
}

function emptyState() {
  return {
    state_ver: STATE_VER,
    // A unit's position is kept as [source index, unit key], and its `order` string rebuilt from it
    // (orderOf), so a big session's state does not repeat the source path per record.
    sources: {}, // source_key -> { first_ts, i }
    srcs: [], // source index -> source_key
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
    usage: {}, // usage_id -> [input, output, cache_read, cache_write] of the largest report
    cmp: {}, // message_id -> [source index, unit key, cmp_sha], main-conversation messages only
    order: {}, // record uuid -> [source index, unit key] of the occurrence kept (the lowest order)
    // Session fields, each kept with the sort key of the record it came from, so the result does
    // not depend on the order sources are folded in: [ts|order, value].
    session: { title: null, ai_title: null, cwd: null, last_cwd: null, created_at: null, updated_at: null, harness_version: null },
    through: {}, // source_key -> the last compact boundary's logicalParentUuid, for the summary after it
    first: {}, // source_key -> the source's first message id, for the compaction range
  };
}

// One record per key in its final state (sessions-model §1 rule 5). Messages are immutable once
// emitted: a re-appended record (same uuid) is folded only the first time.
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

  for (const src of input) {
    const sk = src.source_key;
    const agentDefault = agentOf(sk);
    for (const u of src.units ?? []) {
      const o = jsonOf(u);
      if (!o || typeof o !== 'object') continue;
      if (!st.sources[sk]) {
        st.sources[sk] = { first_ts: isoTs(o.timestamp) ?? '', i: st.srcs.length };
        st.srcs.push(sk);
      }
      const pos = [st.sources[sk].i, u.unit_key];
      foldRecord(st, put, o, { sk, unitKey: u.unit_key, order: orderOf(st, pos), pos, agentDefault });
    }
  }

  // The session record: always re-sealed, since updated_at and the fingerprint move.
  const s = Object.fromEntries(Object.entries(st.session).map(([k, v]) => [k, v ? v[1] : null]));
  const cmpShas = Object.values(st.cmp).map(([i, uk, sha]) => [orderOf(st, [i, uk]), sha])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
  put({
    type: 'session',
    engine: null,
    client: 'claude-code',
    harness_version: s.harness_version,
    title: s.title ?? s.ai_title,
    title_set_by: s.title ? 'user' : s.ai_title ? 'auto' : null,
    cwd: s.cwd,
    last_cwd: s.last_cwd,
    created_at: s.created_at,
    updated_at: s.updated_at,
    state: 'active',
    pinned: null,
    mode: null,
    kind: null,
    reuse: 'impossible',
    ts_source: 'event',
    aliases: [],
    fingerprint: { cmp_shas: cmpShas },
  });

  const live = {};
  for (const [type, keys] of Object.entries(st.emitted)) live[type] = Object.keys(keys).sort();
  return {
    changed: [...out.values()],
    live,
    held: {},
    state: st,
    checkpoint: true,
    adapter_ver: describeData.adapter_ver,
    model_version: describeData.model_version,
    state_ver: STATE_VER,
  };
}

// A unit's `order`: the source's first time, its key, and the unit key, so it sorts across sources.
function orderOf(st, [i, unitKey]) {
  const sk = st.srcs[i];
  return `${st.sources[sk].first_ts}|${sk}|${unitKey.padStart(12, '0')}`;
}

// Keep the value from the earliest (`first`) or latest record by (ts, order).
function keep(s, field, value, sortKey, first) {
  const cur = s[field];
  if (!cur || (first ? sortKey < cur[0] : sortKey > cur[0])) s[field] = [sortKey, value];
}

function noteSession(st, o, ts, order) {
  const s = st.session;
  const sk = `${ts ?? ''}|${order}`;
  if (typeof o.version === 'string' && o.version) keep(s, 'harness_version', o.version, sk, false);
  if (typeof o.cwd === 'string' && o.cwd) {
    keep(s, 'cwd', o.cwd, sk, true);
    keep(s, 'last_cwd', o.cwd, sk, false);
  }
  if (ts) {
    keep(s, 'created_at', ts, ts, true);
    keep(s, 'updated_at', ts, ts, false);
  }
}

function foldRecord(st, put, o, { sk, unitKey, order, pos, agentDefault }) {
  const ts = isoTs(o.timestamp);
  const agentId = agentDefault || (o.isSidechain && typeof o.agentId === 'string' ? o.agentId : '');
  const parent = typeof o.parentUuid === 'string' && o.parentUuid ? o.parentUuid : null;
  const uuid = typeof o.uuid === 'string' && o.uuid ? o.uuid : null;

  // Session metadata records: titles. The user's own title wins over the generated one.
  if (o.type === 'custom-title' && typeof o.customTitle === 'string') {
    keep(st.session, 'title', o.customTitle, `|${order}`, false);
    put({ type: 'lifecycle', lifecycle_id: `${sk}@${unitKey}#1`, op: 'rename', target: { session: true }, at: null, ts, evidence: 'explicit' });
    return;
  }
  if (o.type === 'ai-title' && typeof o.aiTitle === 'string') { keep(st.session, 'ai_title', o.aiTitle, `|${order}`, false); return; }

  // One record per uuid. Claude Code re-appends records verbatim, and one uuid can sit in two main
  // sources. The occurrence with the lowest `order` is kept, whichever arrives first, so the result
  // does not depend on the order sources are read or how they are split across derives.
  const msgId = uuid ?? `@${unitKey}`;
  if (o.type === 'summary' || o.type === 'system' || o.type === 'user' || o.type === 'assistant') {
    const kept = st.order[msgId];
    if (kept !== undefined && orderOf(st, kept) <= order) return;
    st.order[msgId] = pos;
  } else {
    return; // bookkeeping records (file-history-snapshot, progress, …) make no record
  }
  noteSession(st, o, ts, order);

  const base = {
    message_id: msgId, parent_id: parent, order, agent_id: agentId,
    to_user: null, to_model: null, status: 'complete', state: 'current', on_active_branch: null, ts,
    requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
  };
  const emitMessage = (m) => {
    const r = put({ type: 'message', ...m });
    if (r.agent_id === '') st.cmp[r.message_id] = [...pos, r.cmp_sha];
    else delete st.cmp[r.message_id];
    if (st.first[sk] === undefined) st.first[sk] = r.message_id;
    return r;
  };

  // A pre-compaction summary record (old format): no uuid, no timestamp; offset id.
  if (o.type === 'summary') {
    emitMessage({ ...base, role: 'system', source: 'system_notice', parts: [{ part_id: '0', kind: 'summary', text: typeof o.summary === 'string' ? o.summary : '', replaces: 'unknown' }] });
    return;
  }

  if (o.type === 'system') {
    const inMsg = o.message && typeof o.message.content === 'string';
    const text = inMsg ? o.message.content : typeof o.content === 'string' ? o.content : '';
    const subtype = typeof o.subtype === 'string' ? o.subtype : null;
    if (!text && !subtype) return;
    const part = inMsg
      ? { part_id: '0', kind: 'text', text }
      : { part_id: '0', kind: 'notice', text, level: typeof o.level === 'string' ? o.level : null, native_type: subtype };
    emitMessage({ ...base, role: 'system', source: 'system_notice', parts: [part] });
    if (subtype === 'compact_boundary') {
      const through = typeof o.logicalParentUuid === 'string' && o.logicalParentUuid ? o.logicalParentUuid : null;
      st.through[sk] = through;
      put({
        type: 'lifecycle',
        lifecycle_id: msgId,
        op: 'compaction',
        target: through && st.first[sk] ? { range: { from_id: st.first[sk], through_id: through } } : { session: true },
        at: null,
        ts,
        evidence: 'explicit',
      });
    }
    return;
  }

  if (o.type === 'user' && o.message) {
    const content = o.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const userParts = [];
    const toolParts = [];
    blocks.forEach((b, i) => {
      if (!b || typeof b !== 'object') return;
      if (b.type === 'text') {
        userParts.push(o.isCompactSummary
          ? { part_id: String(i), kind: 'summary', text: b.text ?? '', replaces: st.through[sk] ? { through_id: st.through[sk] } : 'unknown' }
          : { part_id: String(i), kind: 'text', text: b.text ?? '' });
      } else if (b.type === 'image' && b.source && b.source.type === 'base64' && typeof b.source.data === 'string') {
        userParts.push({ part_id: String(i), kind: 'attachment', media_type: b.source.media_type ?? null, inline: b.source.data, bytes_len: Buffer.from(b.source.data, 'base64').length });
      } else if (b.type === 'tool_result') {
        const output = blockText(b.content);
        toolParts.push({
          part_id: String(i), kind: 'tool_result', call_id: String(b.tool_use_id ?? ''),
          is_error: typeof b.is_error === 'boolean' ? b.is_error : null, status: 'completed',
          output, output_len: utf8Len(output), truncated: null,
        });
      }
    });
    // One speaker per message (sessions-model §2.2): tool results are a `tool` message. A record
    // holding both keeps its uuid on the first speaker; the second is anchored `<uuid>+1`.
    const userFirst = blocks.findIndex((b) => b && b.type !== 'tool_result') < blocks.findIndex((b) => b && b.type === 'tool_result')
      || !blocks.some((b) => b && b.type === 'tool_result');
    const source = o.isCompactSummary ? 'automated' : o.isMeta ? 'injected' : 'user';
    const vis = o.isMeta ? { to_user: false, to_model: true } : {};
    const msgs = [];
    if (userParts.length) msgs.push({ role: 'user', source, ...vis, parts: userParts });
    // A tool result is written by the harness running the tool: no `source` value fits it.
    if (toolParts.length) msgs.push({ role: 'tool', source: null, parts: toolParts });
    if (!userFirst) msgs.reverse();
    msgs.forEach((m, n) => emitMessage({ ...base, ...m, message_id: n === 0 ? msgId : `${msgId}+${n}` }));
    return;
  }

  if (o.type === 'assistant' && o.message) {
    const msg = o.message;
    const respId = typeof msg.id === 'string' && msg.id ? msg.id : null;
    const model = typeof msg.model === 'string' ? msg.model : null;
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
    const parts = [];
    blocks.forEach((b, i) => {
      if (!b || typeof b !== 'object') return;
      const pid = String(i);
      if (b.type === 'text') parts.push({ part_id: pid, kind: 'text', text: b.text ?? '' });
      else if (b.type === 'thinking') parts.push({ part_id: pid, kind: 'reasoning', text: b.thinking ?? '', signature_len: typeof b.signature === 'string' ? b.signature.length : null });
      else if (b.type === 'redacted_thinking') parts.push({ part_id: pid, kind: 'reasoning', opaque: true, signature_len: typeof b.data === 'string' ? b.data.length : null });
      else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        const name = String(b.name ?? 'unknown');
        parts.push({ part_id: pid, kind: 'tool_call', call_id: typeof b.id === 'string' && b.id ? b.id : `@${msgId}:${i}`, name, args: b.input === undefined ? {} : b.input, server: serverOf(name) });
      } else if (b.type === 'tool_result' || (typeof b.type === 'string' && b.type.endsWith('_tool_result'))) {
        // A server tool's result (`web_search_tool_result`), or a plain `tool_result` a gateway that
        // ran the tool itself writes into the response: either way the model side's own output.
        const output = blockText(b.content);
        parts.push({ part_id: pid, kind: 'tool_result', call_id: String(b.tool_use_id ?? ''), is_error: typeof b.is_error === 'boolean' ? b.is_error : null, status: 'completed', output, output_len: utf8Len(output), truncated: null });
      }
    });
    // A provider error Claude Code stores as an assistant record: one error part, no text part.
    const isError = o.isApiErrorMessage === true;
    if (isError) parts.splice(0, parts.length, { part_id: '0', kind: 'error', error_kind: 'api', message: blockText(msg.content), http_status: null });
    emitMessage({ ...base, role: 'assistant', source: 'model', status: isError ? 'error' : 'complete', served_model: model, response_id: respId, parts });

    // Usage: one record per API response (`message.id`), revised while later records of the
    // response report more (memhouse 0.18 doubled totals by counting each record).
    const u = msg.usage;
    // An API error record carries no API call: its zero usage is not a usage record.
    if (respId && u && typeof u === 'object' && !isError) {
      const n = (v) => (Number.isFinite(Number(v)) && v !== null ? Math.trunc(Number(v)) : null);
      const next = { input: n(u.input_tokens), output: n(u.output_tokens), cache_read: n(u.cache_read_input_tokens), cache_write: n(u.cache_creation_input_tokens) };
      const total = (x) => (x.input ?? 0) + (x.output ?? 0) + (x.cache_read ?? 0) + (x.cache_write ?? 0);
      const usageId = `response:${respId}#1`;
      const p = st.usage[usageId];
      const prev = p && { input: p[0], output: p[1], cache_read: p[2], cache_write: p[3] };
      // The largest report wins; a tie is broken on the values themselves, never on arrival.
      const wins = !prev || total(next) > total(prev)
        || (total(next) === total(prev) && JSON.stringify(next) > JSON.stringify({ input: prev.input, output: prev.output, cache_read: prev.cache_read, cache_write: prev.cache_write }));
      if (wins) {
        // The Anthropic usage as stored: cache reads and writes beside input_tokens, thinking inside
        // output_tokens (sessions-model §2.4).
        const rec = {
          type: 'usage', usage_id: usageId, anchor: { response_id: respId },
          ...next, reasoning: null, cost: null, input_includes_cache: false, output_includes_reasoning: true, granularity: 'per_response', model,
        };
        st.usage[usageId] = [next.input, next.output, next.cache_read, next.cache_write];
        put(rec);
      }
    }
  }
}
