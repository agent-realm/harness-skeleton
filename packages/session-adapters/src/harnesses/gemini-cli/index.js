// Gemini CLI: `<GEMINI_CLI_HOME|~>/.gemini/` is the `harness_path`. One session per chat file under
// `tmp/<slug>/chats/`: an append-only, event-sourced JSONL whose line 1 is the header {sessionId,
// projectHash, startTime, lastUpdated, kind}, followed by message records {id, timestamp, type,
// content, …} and the fold ops `$set`, `$patch` and `$rewindTo`. sessions v1 four operations over
// sessions-model v1.1 records.
//
// Ported from memhouse's v4 normaliser (its gemini-cli module: the header
// prefix scan, the record fold, the echo map, the part builder, the tail hold). New here: records
// in the
// sessions-model shape (one speaker per message, a call and its result as `<id>:call` /
// `<id>:result`, usage as its own record, link and lifecycle records with their own keys); the fold
// state is serialisable and applied unit by unit, so derive is pure and incremental; a record the
// tail hold withholds is returned in `held`; the cwd fallback is the slug's `.project_root`, read
// as a side snapshot source, never `projects.json`.
//
// Sources (sessions §1), paths relative to `harness_path`:
// - `tmp/<slug>/chats/session-<YYYY-MM-DDTHH-MM>-[<i>-]<sid8>.jsonl`: main, stream, byte_offset;
// - `tmp/<slug>/chats/<main session id>/<agent>.jsonl`: a sub-agent's own session (header kind
//   `subagent`; source-only), main, stream, byte_offset. It states a child-side `subagent` link;
// - `tmp/<slug>/chats/session-*.json`: a pre-0.6x session, one JSON object: main, snapshot. The CLI
//   migrates it to `<name>.jsonl` (same sessionId) on resume, and `list` then names the .jsonl
//   only;
// - `tmp/<slug>/.project_root`: side, snapshot, the cwd fallback.
// Never opened: `checkpoint-<tag>.json` (it carries `authType`, sessions-model §4.1 and §4.7),
// `checkpoints/`, `logs.json`, `tool-outputs/`, `history/`, `projects.json`, `*.unreadable-<ts>`.

import fs from 'node:fs';
import path from 'node:path';
import { SessionsError } from '../../errors.js';
import { throughSymlink, readStream, readSnapshot, streamUnits, snapshotUnits, unknownSource, plainRel, jsonOf } from '../../sources.js';
import { seal, recordKey } from '../../records.js';
import { sha256 } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'gemini-cli';
const STATE_VER = 1;
// The injected `<session_context>` user message carries this id in every session (spec §3; fixture
// pass3, from its first user message).
export const SESSION_CONTEXT_ID = 'd04923d38bb0f6017037e74183378ef4';
const CONTEXT = /^\s*<session_context>/;
const HOOK_CONTEXT = /^\s*<hook_context>/;
const DONE = new Set(['success', 'error', 'cancelled']);
const CHAT = /^session-.+\.(jsonl|json)$/;
const PROJECT_ROOT = '.project_root';
const HEAD_CHUNK = 4096;
const HEAD_MAX = 1 << 20; // a first line longer than this is no header

export function describe() {
  return describeData;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const pad = (n, w = 12) => String(n).padStart(w, '0');
const noHeld = () => ({ session: [], message: [], usage: [], link: [], lifecycle: [] });

// ---- list -------------------------------------------------------------------------------------

// A directory's entries, or none when it is missing or reached through a symlink: list never
// walks through a symlink, and read refuses one (src/sources.js openSource), so the two agree.
function readdir(dir) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

// A file's first bytes: HEAD_CHUNK, or (untilNewline) its first line, null while it has none.
function readPrefix(file, untilNewline) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    let buf = Buffer.alloc(0);
    let size = HEAD_CHUNK;
    for (;;) {
      const chunk = Buffer.alloc(size);
      const n = fs.readSync(fd, chunk, 0, size, buf.length);
      const from = buf.length;
      buf = Buffer.concat([buf, chunk.subarray(0, n)]);
      if (!untilNewline) return buf;
      const nl = buf.indexOf(0x0a, from);
      if (nl >= 0) return buf.subarray(0, nl);
      if (n < size || buf.length >= HEAD_MAX) return null; // line 1 still being written, or no header
      size = Math.min(size * 2, HEAD_MAX - buf.length);
    }
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// The end of the JSON string that opens at `i` (its closing quote), or -1 if it is cut.
function stringEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '"') return j;
  }
  return -1;
}

function unquote(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return '';
  }
}
const WS = new Set([' ', '\t', '\n', '\r']);

// The string values of `keys` at the TOP level of the JSON object a prefix opens, by a scan that
// tracks strings and depth: a key inside nested content, or inside a string, never matches. It
// works
// on a cut prefix, so `list` never parses a legacy .json whole.
function topLevelStrings(text, keys) {
  const want = new Set(keys);
  const out = {};
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end < 0) break;
      const raw = text.slice(i + 1, end);
      i = end;
      if (depth !== 1 || !expectKey) continue;
      expectKey = false;
      let k = end + 1;
      while (k < text.length && WS.has(text[k])) k++;
      if (text[k] !== ':') continue;
      k++;
      while (k < text.length && WS.has(text[k])) k++;
      const key = unquote(raw);
      if (!want.has(key) || key in out || text[k] !== '"') { i = k - 1; continue; }
      const vend = stringEnd(text, k);
      if (vend < 0) break;
      out[key] = unquote(text.slice(k + 1, vend));
      i = vend;
      if (Object.keys(out).length === want.size) break;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      if (depth === 1) {
        if (c !== '{') break;
        expectKey = true;
      }
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth <= 0) break;
    } else if (c === ',' && depth === 1) expectKey = true;
  }
  return out;
}

// A header: the session's metadata, not a message or an op.
function isHeader(r) {
  return isObj(r) && typeof r.sessionId === 'string' && typeof r.id !== 'string' && !('$set' in r) && !('$patch' in r) && !('$rewindTo' in r);
}

// A chat file's sessionId. A .jsonl's header is its complete line 1, parsed as the fold parses it;
// a legacy .json is one object whose top-level sessionId the CLI writes first, inside the 4 KB
// prefix.
function sessionIdOf(file, format) {
  const buf = readPrefix(file, format === 'jsonl');
  if (!buf) return null;
  if (format === 'jsonl') {
    let r = null;
    try {
      r = JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
    return isHeader(r) && r.sessionId ? r.sessionId : null;
  }
  return topLevelStrings(buf.toString('utf8'), ['sessionId']).sessionId || null;
}

// The chat files of one slug, into `found` (sessionId -> the winning file). Where two files carry
// one id, a .jsonl beats a .json (the CLI's migration copy), then the larger file, then the lower
// path. `only`, when given, first tries the files whose name can hold that session (a main file
// ends in the id's first 8 characters; a sub-agent file is named for its agent, UNVERIFIED), and
// every file when those hold nothing.
function scanSlug(harnessPath, slug, found, only = null) {
  const chats = path.join(harnessPath, 'tmp', slug, 'chats');
  const names = readdir(chats);
  if (!names.length) return;
  const rootRel = `tmp/${slug}/${PROJECT_ROOT}`;
  const root = isFile(path.join(harnessPath, rootRel)) ? rootRel : null;
  const files = [];
  for (const f of names) {
    const rel = `tmp/${slug}/chats/${f.name}`;
    const m = CHAT.exec(f.name);
    if (m && f.isFile()) files.push({ rel, format: m[1] });
    else if (f.isDirectory()) {
      for (const c of readdir(path.join(chats, f.name))) {
        if (c.isFile() && c.name.endsWith('.jsonl')) files.push({ rel: `${rel}/${c.name}`, format: 'jsonl' });
      }
    }
  }
  const consider = (some) => {
    let hit = false;
    for (const { rel, format } of some) {
      const full = path.join(harnessPath, rel);
      const sid = sessionIdOf(full, format);
      if (!sid || (only && sid !== only)) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      hit = true;
      const e = { session_id: sid, rel, format, size, root };
      const prev = found.get(sid);
      const better = !prev || (format === 'jsonl' && prev.format !== 'jsonl')
        || (format === prev.format && (size > prev.size || (size === prev.size && rel < prev.rel)));
      if (better) found.set(sid, e);
    }
    return hit;
  };
  if (only) {
    const sid8 = only.slice(0, 8);
    const hinted = files.filter(({ rel }) => {
      const base = path.posix.basename(rel);
      return base.endsWith(`-${sid8}.jsonl`) || base.endsWith(`-${sid8}.json`) || base === `${only}.jsonl`;
    });
    if (consider(hinted)) return;
  }
  consider(files);
}

function scan(harnessPath) {
  const found = new Map();
  for (const s of readdir(path.join(harnessPath, 'tmp'))) if (s.isDirectory()) scanSlug(harnessPath, s.name, found);
  return found;
}

function sourcesOf(e) {
  const json = e.format === 'json';
  const out = [{ source_key: e.rel, role: 'main', mode: json ? 'snapshot' : 'stream', position_kind: json ? 'snapshot' : 'byte_offset' }];
  if (e.root) out.push({ source_key: e.root, role: 'side', mode: 'snapshot', position_kind: 'snapshot' });
  return out;
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
  for (const e of scan(store.harness_path).values()) {
    const sources = sourcesOf(e);
    out.push({
      session_id: e.session_id,
      incarnation: '',
      updated_hint: sha256(JSON.stringify(sources.map((s) => sourceStat(store.harness_path, s.source_key)))).slice(0, 32),
      live: 'unknown',
      sources,
    });
  }
  return out.sort((a, b) => (a.session_id < b.session_id ? -1 : 1));
}

// ---- read -------------------------------------------------------------------------------------

// The session's winning file: from the source key's own slug when it names one, else (and to tell
// session_unknown from source_unknown) from the whole harness store.
function entryFor(harnessPath, sessionId, sourceKey) {
  const m = /^tmp\/([^/]+)\//.exec(sourceKey);
  if (m && m[1] !== '..' && m[1] !== '.') {
    const found = new Map();
    scanSlug(harnessPath, m[1], found, sessionId);
    if (found.has(sessionId)) return found.get(sessionId);
  }
  return scan(harnessPath).get(sessionId) ?? null;
}

export function read(store, session, sourceKey, from = null, known = null) {
  void known; // stream and snapshot sources ignore `known` (sessions §2, rules 3 and 5)
  const sid = session.session_id;
  // Nothing is opened, not even a header, through a symlink at any segment below harness_path.
  if (throughSymlink(store.harness_path, sourceKey)) throw new SessionsError('session_unknown', `no session ${sid} at ${sourceKey}`, [String(sid)]);
  const e = typeof sid === 'string' && sid ? entryFor(store.harness_path, sid, sourceKey) : null;
  if (!e) throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
  const src = sourcesOf(e).find((s) => s.source_key === sourceKey);
  if (!src) throw new SessionsError('source_unknown', `${sourceKey} is not a source of ${sid}`, [sourceKey]);
  const file = path.join(store.harness_path, sourceKey);
  if (src.mode === 'stream') return readStream(file, sourceKey, from, { root: store.harness_path });
  const r = readSnapshot(file, sourceKey, from, { root: store.harness_path });
  const held = src.role === 'main' && r.units.length ? tornLegacy(sourceKey, r.units[0]) : null;
  if (held) return { continuity: from ? 'unchanged' : 'reset', units: [], gone: [], position: from, held_back: held };
  return r;
}

// A legacy .json that does not parse is a write in progress (the old CLI rewrote it whole). It is
// held back like a partial line, and the last snapshot read stands (sessions §3): its held_back,
// or null when it parses.
function tornLegacy(sourceKey, u) {
  return jsonOf(u) === null ? [{ unit_key: sourceKey, bytes: u.bytes }] : null;
}

// What a source key names, as `scanSlug` and `sourcesOf` name it: a main chat file (a .jsonl
// stream, or a legacy .json snapshot), a sub-agent's .jsonl one folder down, or the slug's
// `.project_root` side snapshot. Null for anything else.
function kindOf(sourceKey) {
  if (!plainRel(sourceKey)) return null;
  const segs = sourceKey.split('/');
  if (segs[0] !== 'tmp') return null;
  if (segs.length === 3 && segs[2] === PROJECT_ROOT) return 'side';
  if (segs[2] !== 'chats') return null;
  if (segs.length === 4) {
    const m = CHAT.exec(segs[3]);
    return m ? (m[1] === 'json' ? 'legacy' : 'stream') : null;
  }
  return segs.length === 5 && segs[4].endsWith('.jsonl') ? 'stream' : null;
}

// The units `read` returns from scratch for a source holding `bytes` (src/index.js
// unitsFromBytes), from the source key alone: no session, no position, no file system.
export function unitsFromBytes(sourceKey, bytes, { start = 0 } = {}) {
  const kind = kindOf(sourceKey);
  if (!kind) throw unknownSource(HARNESS, sourceKey);
  if (kind === 'stream') return streamUnits(bytes, sourceKey, { start });
  const out = snapshotUnits(bytes, sourceKey, { start });
  const held = kind === 'legacy' ? tornLegacy(sourceKey, out.units[0]) : null;
  return held ? { units: [], held_back: held } : out;
}

// ---- the fold (memhouse's fold, serialisable, applied unit by unit) ---------------------------

// The fold: the header, the session fields the ops set, a timeline of slots, and the current ids in
// the CLI's own fold order. A message slot is {id, rec, state, order}; an op slot is {op, ids,
// before, unit}. `at` maps 'm:' + id to the index of that id's current slot.
function emptyFold() {
  return { header: null, title: null, dirs: null, context: null, slots: [], cur: [], at: {} };
}

function reindex(f) {
  f.at = {};
  f.slots.forEach((s, i) => { if (!s.op && s.state === 'current') f.at['m:' + s.id] = i; });
}

function partArray(c) {
  if (c == null) return [];
  if (typeof c === 'string') return [{ text: c }];
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? { text: p } : p)).filter((p) => p && typeof p === 'object');
  return isObj(c) ? [c] : [];
}
const textOf = (c) => partArray(c).map((p) => (p.thought ? '' : str(p.text))).join('');

// What a revision changes: the content and each tool call's result.
const contentKey = (r) => JSON.stringify([partArray(r.content), Array.isArray(r.toolCalls) ? r.toolCalls.map((t) => (t && t.result) ?? null) : null]);

// A record id written again replaces the record (last wins) and keeps its first position; a
// retracted id written again opens a new slot at the end.
function put(f, r, order) {
  if (r.id === SESSION_CONTEXT_ID && f.context === null) f.context = textOf(r.content);
  const i = f.at['m:' + r.id];
  if (i !== undefined) {
    f.slots[i].rec = r;
    return;
  }
  f.at['m:' + r.id] = f.slots.length;
  f.slots.push({ id: r.id, rec: r, state: 'current', order });
  f.cur.push(r.id);
}

function retract(f, id) {
  const i = f.at['m:' + id];
  if (i === undefined) return false;
  f.slots[i].state = 'retracted';
  delete f.at['m:' + id];
  f.cur.splice(f.cur.indexOf(id), 1);
  return true;
}

// One record of the chat file, read at byte offset `unit` (0 for a legacy .json's one object).
function applyRecord(f, r, unit) {
  if (!isObj(r)) return;
  if (typeof r.$rewindTo === 'string') {
    // Inclusive of its target (sessions-model §2.6): X and everything after it. An X the fold does
    // not
    // hold clears every message, as the CLI's rewindTo() does.
    const i = f.cur.indexOf(r.$rewindTo);
    const cut = i < 0 ? f.cur.slice() : f.cur.slice(i);
    const before = i < 0 ? [] : f.cur.slice(0, i);
    for (const id of cut) retract(f, id);
    if (cut.length) f.slots.push({ op: 'rewind', ids: cut, before, unit });
    return;
  }
  if (isObj(r.$patch)) {
    const p = r.$patch;
    const revised = [];
    const removed = [];
    const ups = [...(typeof p.id === 'string' ? [p] : []), ...(Array.isArray(p.updates) ? p.updates : [])];
    for (const u of ups) {
      const i = isObj(u) && typeof u.id === 'string' ? f.at['m:' + u.id] : undefined;
      if (i === undefined) continue;
      const s = f.slots[i];
      const was = contentKey(s.rec);
      const rec = structuredClone(s.rec);
      if ('content' in u && u.content !== undefined) rec.content = u.content;
      if (Array.isArray(u.toolCalls) && rec.type === 'gemini' && Array.isArray(rec.toolCalls)) {
        for (const tp of u.toolCalls) {
          const tc = isObj(tp) ? rec.toolCalls.find((t) => t && t.id === tp.id) : null;
          if (tc && 'result' in tp) tc.result = tp.result;
        }
      }
      s.rec = rec;
      // A no-op revision (a string content re-sent as [{text}]) is not an edit.
      if (contentKey(rec) !== was && !revised.includes(u.id)) revised.push(u.id);
    }
    for (const id of Array.isArray(p.removeIds) ? p.removeIds : []) {
      if (typeof id === 'string' && retract(f, id)) removed.push(id);
    }
    if (Array.isArray(p.orderIds)) {
      // Source-only (never observed): the listed messages move to the end, in that order.
      const ids = p.orderIds.filter((id, k) => typeof id === 'string' && f.at['m:' + id] !== undefined && p.orderIds.indexOf(id) === k);
      if (ids.length) {
        const moved = ids.map((id) => f.slots[f.at['m:' + id]]);
        const set = new Set(moved);
        f.slots = [...f.slots.filter((s) => !set.has(s)), ...moved];
        moved.forEach((s, k) => { s.order = `${pad(unit)}.${pad(k, 6)}`; });
        f.cur = [...f.cur.filter((id) => !ids.includes(id)), ...ids];
        reindex(f);
      }
    }
    if (removed.length || revised.length) f.slots.push({ op: 'edit', ids: [...removed, ...revised], before: [], unit });
    return;
  }
  if (typeof r.id === 'string') {
    put(f, r, pad(unit));
    return;
  }
  if (isObj(r.$set)) {
    const s = r.$set;
    if (Array.isArray(s.messages)) {
      // A legacy snapshot: what it leaves out is gone from the conversation. The one fold op that
      // drops messages outright, not a retraction.
      const msgs = s.messages.filter((m) => isObj(m) && typeof m.id === 'string');
      const keep = new Set(msgs.map((m) => m.id));
      const drop = new Set(f.cur.filter((id) => !keep.has(id)).map((id) => f.slots[f.at['m:' + id]]));
      f.slots = f.slots.filter((x) => !drop.has(x));
      f.cur = f.cur.filter((id) => keep.has(id));
      reindex(f);
      msgs.forEach((m, k) => put(f, m, `${pad(unit)}.${pad(k, 6)}`));
    }
    // `summary` is the title; `lastUpdated` and `memoryScratchpad` are volatile and change no
    // record.
    if (typeof s.summary === 'string') f.title = s.summary;
    if (f.dirs === null && Array.isArray(s.directories)) f.dirs = s.directories;
    return;
  }
  if (isHeader(r)) {
    if (!f.header) f.header = { sessionId: r.sessionId, startTime: r.startTime ?? null, kind: r.kind ?? null };
    if (typeof r.summary === 'string' && r.summary) f.title = r.summary;
    if (f.dirs === null && Array.isArray(r.directories)) f.dirs = r.directories;
    (Array.isArray(r.messages) ? r.messages : []).filter((m) => isObj(m) && typeof m.id === 'string')
      .forEach((m, k) => put(f, m, `${pad(unit)}.${pad(k, 6)}`));
  }
}

// ---- records from the fold --------------------------------------------------------------------

function isoTs(v) {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function utf8Len(s) {
  return Buffer.byteLength(s, 'utf8');
}

// The first workspace directory the injected session context names.
function contextCwd(text) {
  const m = /\*\*Workspace Directories:\*\*\s*\n\s*-\s+([^\n]+)/.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

// A tool result's text, as the model saw it.
function resultText(result) {
  const out = [];
  for (const p of partArray(result)) {
    if (isObj(p.functionResponse)) {
      const r = p.functionResponse.response;
      if (r == null) continue;
      if (typeof r === 'string') out.push(r);
      else if (typeof r.output === 'string') out.push(r.output);
      else if (r.error != null) out.push(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
      else out.push(JSON.stringify(r));
    } else if (typeof p.text === 'string') out.push(p.text);
  }
  return out.join('\n');
}
const resultIsError = (result) => partArray(result).some((p) => isObj(p.functionResponse) && isObj(p.functionResponse.response) && p.functionResponse.response.error != null);

function attachmentPart(p, partId) {
  if (isObj(p.inlineData)) {
    const data = typeof p.inlineData.data === 'string' ? p.inlineData.data : '';
    return { part_id: partId, kind: 'attachment', media_type: str(p.inlineData.mimeType) || null, inline: data, bytes_len: Buffer.from(data, 'base64').length };
  }
  if (isObj(p.fileData)) return { part_id: partId, kind: 'attachment', media_type: str(p.fileData.mimeType) || null, ref: str(p.fileData.fileUri), bytes_len: null };
  return null;
}

// A content part the model has no kind for: a notice named for its native field, never dropped.
function noticePart(p, partId) {
  const native = Object.keys(p).find((k) => k !== 'thought' && k !== 'thoughtSignature') ?? null;
  return { part_id: partId, kind: 'notice', text: JSON.stringify(p), level: null, native_type: native };
}

// A tool call and, once it has finished, its result: two parts, `<id>:call` and `<id>:result`
// (sessions-model §2.3: toolCalls[i] holds both). The result is the call's own, else the echo the
// CLI wrote as a user record.
function toolParts(id, name, args, tc, echo) {
  const has = tc && tc.result != null && partArray(tc.result).length > 0;
  const result = has ? tc.result : (echo ? [echo] : null);
  const st = tc ? str(tc.status) : '';
  const finished = DONE.has(st) || result != null;
  const parts = [{ part_id: `${id}:call`, kind: 'tool_call', call_id: id, name, args: args === undefined || args === null ? {} : args, server: null }];
  if (finished) {
    const output = result != null ? resultText(result) : null;
    parts.push({
      part_id: `${id}:result`, kind: 'tool_result', call_id: id,
      is_error: st === 'error' || (result != null && resultIsError(result)),
      status: st === 'cancelled' ? 'cancelled' : 'completed',
      output, output_len: output === null ? null : utf8Len(output), truncated: null,
    });
  }
  return { parts, finished, agent: tc && typeof tc.agentId === 'string' && tc.agentId ? tc.agentId : '' };
}

// A gemini record's parts, whether a call is still running, and the sub-agents its calls started.
function geminiParts(r, echoes) {
  const parts = [];
  let pending = false;
  const agents = [];
  const content = partArray(r.content);
  const calls = Array.isArray(r.toolCalls) ? r.toolCalls.filter(isObj) : [];
  const byId = new Map(calls.filter((t) => typeof t.id === 'string').map((t) => [t.id, t]));
  const done = new Set();
  const addTool = (id, name, args, tc) => {
    const t = toolParts(id, name, args, tc, echoes.get(id));
    parts.push(...t.parts);
    if (!t.finished) pending = true;
    if (t.agent) agents.push({ agent: t.agent, call_id: id });
    done.add(id);
  };
  // The thought summaries, then text, then calls. The CLI's replay (convertSessionToClientHistory)
  // drops the summaries once content holds API parts (a $patch wrote the API history back), but
  // capture keeps what was stored: they go only when content carries the thoughts itself (a
  // `thought` part), so reasoning is never counted twice.
  if (!content.some((p) => p.thought)) {
    (Array.isArray(r.thoughts) ? r.thoughts : []).forEach((t, i) => {
      if (!isObj(t)) return;
      const text = str(t.subject) ? `**${t.subject}** ${str(t.description)}` : str(t.description);
      if (text) parts.push({ part_id: `th:${i}`, kind: 'reasoning', text, signature_len: null });
    });
  }
  content.forEach((p, j) => {
    if (isObj(p.functionCall)) {
      const fc = p.functionCall;
      const id = typeof fc.id === 'string' && fc.id ? fc.id : `@${r.id}:${j}`;
      if (!done.has(id)) addTool(id, str(fc.name) || str(byId.get(id) && byId.get(id).name), fc.args, byId.get(id));
      return;
    }
    if (isObj(p.functionResponse)) return;
    const a = attachmentPart(p, String(j));
    if (a) {
      parts.push(a);
    } else if (typeof p.text === 'string') {
      if (!p.text) return;
      parts.push(p.thought
        ? { part_id: String(j), kind: 'reasoning', text: p.text, signature_len: typeof p.thoughtSignature === 'string' ? p.thoughtSignature.length : null }
        : { part_id: String(j), kind: 'text', text: p.text });
    } else {
      parts.push(noticePart(p, String(j)));
    }
  });
  calls.forEach((tc, k) => {
    const id = typeof tc.id === 'string' && tc.id ? tc.id : `@${r.id}:${content.length + k}`;
    if (!done.has(id)) addTool(id, str(tc.name), tc.args, tc);
  });
  return { parts, pending, agents };
}

// A stored zero is null: the CLI writes `?? 0` for every token count.
function num(v) {
  const x = Number(v);
  return v !== null && Number.isFinite(x) && x > 0 ? Math.trunc(x) : null;
}

// Every record of the session from its fold, the session record last and without its fingerprint,
// plus the keys held as incomplete. `mainKey` is the main source's key; `root` the `.project_root`.
function build(f, mainKey, root) {
  const out = [];
  const held = noHeld();
  if (!f.header) return { out, held };
  const msgSlots = f.slots.filter((s) => !s.op);

  // Calls the gemini records hold (a functionResponse for one of them is an echo), and each gemini
  // record's echoed responses: the user records after it, up to the next gemini record.
  const callIds = new Set();
  const echoes = new Map(); // slot -> Map(call id -> functionResponse part)
  let last = null;
  for (const s of msgSlots) {
    const r = s.rec;
    if (r.type === 'gemini') {
      last = new Map();
      echoes.set(s, last);
      for (const tc of Array.isArray(r.toolCalls) ? r.toolCalls : []) if (isObj(tc) && typeof tc.id === 'string') callIds.add(tc.id);
      for (const p of partArray(r.content)) if (isObj(p.functionCall) && typeof p.functionCall.id === 'string') callIds.add(p.functionCall.id);
    } else if (r.type === 'user' && last) {
      for (const p of partArray(r.content)) {
        if (isObj(p.functionResponse) && typeof p.functionResponse.id === 'string' && !last.has(p.functionResponse.id)) last.set(p.functionResponse.id, p);
      }
    }
  }

  // Only the last slot of an id is written, so a retracted copy never shadows the id written again.
  const lastSlot = new Map();
  for (const s of msgSlots) lastSlot.set(s.id, s);
  const live = msgSlots.filter((s) => lastSlot.get(s.id) === s);
  const liveCur = live.filter((s) => s.state === 'current');
  const tail = liveCur.length ? liveCur[liveCur.length - 1] : null;

  const written = new Set(); // ids that give a message record, held or not
  let updated = null; // the latest `ts` of a written message; a held one counts once it is written
  const message = (m, isHeld = false) => {
    if (isHeld) {
      held.message.push(m.message_id);
      return;
    }
    out.push({ type: 'message', ...m });
    if (m.ts && (updated === null || m.ts > updated)) updated = m.ts;
  };
  for (const s of live) {
    const r = s.rec;
    const ts = isoTs(r.timestamp);
    const base = {
      message_id: s.id, parent_id: null, order: s.order, agent_id: '',
      to_user: null, to_model: null, status: 'complete', state: s.state, on_active_branch: null, ts,
      requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
    };

    if (r.type === 'gemini') {
      const { parts, pending, agents } = geminiParts(r, echoes.get(s) ?? new Map());
      // The CLI writes a reply when its stream ends and adds its calls when they complete: a tail
      // record with no text and no call yet, or with a call still running, is not complete. Once
      // anything follows, it is written, `interrupted` if a call never finished.
      const waiting = !textOf(r.content).trim() && !parts.some((p) => p.kind === 'tool_call');
      const isHeld = s.state === 'current' && s === tail && (pending || waiting);
      written.add(s.id);
      message({ ...base, role: 'assistant', source: 'model', status: pending ? 'interrupted' : 'complete', requested_model: str(r.model) || null, parts }, isHeld);
      const t = isObj(r.tokens) ? r.tokens : null;
      if (t) {
        const u = { input: num(t.input), output: num(t.output), cache_read: num(t.cached), reasoning: num(t.thoughts), tool_prompt: num(t.tool) };
        if (Object.values(u).some((v) => v !== null)) {
          if (isHeld) held.usage.push(s.id);
          else {
            // Gemini usageMetadata: cached tokens inside the prompt, thoughts beside the
            // candidates,
            // tool-use prompt tokens (`tokens.tool`) beside both, as `tool_prompt` (sessions-model
            // §2.4).
            out.push({
              type: 'usage', usage_id: s.id, anchor: { message_id: s.id },
              input: u.input, output: u.output, cache_read: u.cache_read, cache_write: null, reasoning: u.reasoning, tool_prompt: u.tool_prompt, cost: null,
              input_includes_cache: true, output_includes_reasoning: false, granularity: 'per_response', model: str(r.model) || null,
            });
          }
        }
      }
      // The origin side of a sub-agent link: the call that started it (source-only).
      const seen = new Set();
      for (const a of agents) {
        if (seen.has(a.agent)) continue;
        seen.add(a.agent);
        const link = {
          type: 'link', kind: 'subagent', stated_on: 'origin',
          child: { harness: HARNESS, session_id: a.agent }, origin: { harness: HARNESS, session_id: f.header.sessionId },
          at: a.call_id, inherits: null, child_stored: null, evidence: 'explicit',
        };
        if (isHeld) held.link.push(recordKey(link));
        else out.push(link);
      }
      continue;
    }

    if (r.type === 'user') {
      const userParts = [];
      const resultParts = [];
      let firstUser = -1;
      let firstTool = -1;
      partArray(r.content).forEach((p, j) => {
        if (isObj(p.functionResponse)) {
          const fr = p.functionResponse;
          if (typeof fr.id === 'string' && callIds.has(fr.id)) return; // the echo of a call a gemini record holds
          const output = resultText([p]);
          if (firstTool < 0) firstTool = j;
          resultParts.push({
            part_id: String(j), kind: 'tool_result', call_id: typeof fr.id === 'string' && fr.id ? fr.id : `@${s.id}:${j}`,
            is_error: resultIsError([p]), status: 'completed', output, output_len: utf8Len(output), truncated: null,
          });
          return;
        }
        let part = attachmentPart(p, String(j));
        if (!part && typeof p.text === 'string') part = p.text ? { part_id: String(j), kind: 'text', text: p.text } : null;
        else if (!part) part = noticePart(p, String(j));
        if (!part) return;
        if (firstUser < 0) firstUser = j;
        userParts.push(part);
      });
      const text = textOf(r.content);
      const source = s.id === SESSION_CONTEXT_ID || CONTEXT.test(text)
        ? { source: 'injected', to_user: false, to_model: true }
        : HOOK_CONTEXT.test(text) ? { source: 'hook', to_user: false, to_model: true } : { source: 'user' };
      // One speaker per message (sessions-model §2.2): a result whose call no gemini record holds
      // is a `tool` message. A record holding both keeps its id on the first speaker; the second is
      // anchored `<id>+1`.
      const msgs = [];
      if (userParts.length) msgs.push([firstUser, { role: 'user', ...source, parts: userParts }]);
      // A tool result is written by the harness running the tool: no `source` value fits it.
      if (resultParts.length) msgs.push([firstTool, { role: 'tool', source: null, parts: resultParts }]);
      msgs.sort((a, b) => a[0] - b[0]);
      if (msgs.length) written.add(s.id);
      msgs.forEach(([, m], n) => message({ ...base, ...m, message_id: n === 0 ? s.id : `${s.id}+${n}` }));
      continue;
    }

    written.add(s.id);
    const text = typeof r.content === 'string' ? r.content : (textOf(r.content) || JSON.stringify(r.content ?? null));
    if (r.type === 'error') {
      // The record names no kind of its own (spec §11: only the content text was seen).
      message({ ...base, role: 'system', source: 'system_notice', status: 'error', parts: [{ part_id: '0', kind: 'error', error_kind: null, message: text, http_status: null }] });
    } else {
      // info, warning, and any other type: a notice, never dropped.
      const level = r.type === 'info' || r.type === 'warning' ? r.type : null;
      message({ ...base, role: 'system', source: 'system_notice', parts: [{ part_id: '0', kind: 'notice', text, level, native_type: str(r.type) || null }] });
    }
  }

  // Lifecycle records for the explicit retractions (sessions-model §2.6 (a)): a `$rewindTo` gives
  // one rewind record over the range it retracted, at the last message it kept; a `$patch` gives
  // one
  // edit record per message it retracted or revised (a target names one message). `lifecycle_id` is
  // `<source_key>@<unit_key>#n`: the ops carry no id.
  for (const s of f.slots) {
    if (!s.op) continue;
    const ids = s.ids.filter((id) => written.has(id));
    if (!ids.length) continue;
    const lid = (n) => `${mainKey}@${s.unit}#${n}`;
    if (s.op === 'rewind') {
      const kept = s.before.filter((id) => written.has(id));
      out.push({
        type: 'lifecycle', lifecycle_id: lid(1), op: 'rewind',
        target: { range: { from_id: ids[0], through_id: ids[ids.length - 1] } },
        at: kept.length ? kept[kept.length - 1] : null, ts: null, evidence: 'explicit',
      });
    } else {
      ids.forEach((id, k) => out.push({ type: 'lifecycle', lifecycle_id: lid(k + 1), op: 'edit', target: { message_id: id }, at: null, ts: null, evidence: 'explicit' }));
    }
  }

  // The child side of a sub-agent link: the file sits in its main session's directory, named for
  // the main session's (sanitised) id.
  const m = /^tmp\/[^/]+\/chats\/([^/]+)\/[^/]+\.jsonl$/.exec(mainKey);
  if (m && m[1] !== f.header.sessionId) {
    out.push({
      type: 'link', kind: 'subagent', stated_on: 'child',
      child: { harness: HARNESS, session_id: f.header.sessionId }, origin: { harness: HARNESS, session_id: m[1] },
      at: '', inherits: null, child_stored: true, evidence: 'explicit',
    });
  }

  out.push({
    type: 'session',
    engine: null,
    client: 'gemini-cli',
    harness_version: null, // the harness store records no version (spec §1)
    // `$set.summary`, generated by the CLI's session summary.
    title: f.title || null,
    title_set_by: f.title ? 'auto' : null,
    // The session's own records first (a slug can be reused by another workspace), then the slug's
    // `.project_root`; never `projects.json`.
    cwd: contextCwd(f.context) || (Array.isArray(f.dirs) && str(f.dirs[0])) || (root ?? '').trim() || null,
    last_cwd: null,
    created_at: isoTs(f.header.startTime),
    updated_at: updated,
    state: 'active',
    pinned: null,
    mode: null,
    kind: str(f.header.kind) || null,
    reuse: 'impossible',
    ts_source: 'event',
    aliases: [],
  });
  return { out, held };
}

// ---- derive -----------------------------------------------------------------------------------

function sourceKind(sk) {
  if (sk === PROJECT_ROOT || sk.endsWith(`/${PROJECT_ROOT}`)) return 'root';
  return sk.endsWith('.json') ? 'json' : 'jsonl';
}

function emptyState() {
  return {
    state_ver: STATE_VER,
    main: {}, // source_key -> fold
    root: null, // the `.project_root` text, or null
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
  };
}

// The fold is applied unit by unit, so every split of the units gives the same fold. The records
// are
// then built from the whole fold, so `changed` is exactly what moved and `live` is complete.
export function derive(session, input, state) {
  const st = state && state.state_ver === STATE_VER ? structuredClone(state) : emptyState();
  const key = {
    host: session.host, harness: HARNESS, harness_path: session.harness_path,
    session_id: session.session_id, incarnation: session.incarnation ?? '',
  };

  for (const src of input) {
    const sk = src.source_key;
    const units = [...(src.units ?? [])];
    const kind = sourceKind(sk);
    if (kind === 'root') {
      // A snapshot: its one unit is the whole file.
      if (units.length) st.root = units[units.length - 1].enc === 'utf8' ? units[units.length - 1].body : null;
      else if (src.complete) st.root = null;
      continue;
    }
    if (kind === 'json') {
      if (!units.length && !src.complete) continue;
      const f = emptyFold();
      const o = units.length ? jsonOf(units[units.length - 1]) : null;
      if (o) applyRecord(f, o, 0);
      st.main[sk] = f;
      continue;
    }
    if (src.complete || !st.main[sk]) st.main[sk] = emptyFold();
    units.sort((a, b) => Number(a.unit_key) - Number(b.unit_key));
    for (const u of units) applyRecord(st.main[sk], jsonOf(u), Number(u.unit_key));
  }

  // One main source per session: `list` names the winner only. Should several arrive, the same rule
  // picks one: a .jsonl before a .json, then the lower source key.
  const rank = (k) => (sourceKind(k) === 'jsonl' ? 0 : 1);
  const mains = Object.keys(st.main).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const { out: built, held } = mains.length ? build(st.main[mains[0]], mains[0], st.root) : { out: [], held: noHeld() };

  const changed = [];
  const live = { session: [], message: [], usage: [], link: [], lifecycle: [] };
  const cmp = []; // the fingerprint: cmp_sha of every message on the current line, in order
  for (const r of built) {
    const sealed = seal({ type: r.type, ...key, ...(r.type === 'session' ? { ...r, fingerprint: { cmp_shas: cmp } } : r) });
    const k = recordKey(sealed);
    live[sealed.type].push(k);
    if (sealed.type === 'message' && sealed.state === 'current') cmp.push(sealed.cmp_sha);
    if (st.emitted[sealed.type][k] !== sealed.content_sha) {
      st.emitted[sealed.type][k] = sealed.content_sha;
      changed.push(sealed);
    }
  }

  // A key neither live nor held leaves `emitted`, and the consumer tombstones it. A held key keeps
  // its last emitted sha: it is neither rewritten nor tombstoned (sessions §2).
  for (const type of Object.keys(live)) {
    const keep = new Set([...live[type], ...held[type]]);
    for (const k of Object.keys(st.emitted[type])) if (!keep.has(k)) delete st.emitted[type][k];
    live[type].sort();
    held[type].sort();
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
