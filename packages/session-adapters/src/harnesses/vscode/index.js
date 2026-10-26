// VS Code, the Local chat engine: `<user-data>/User/workspaceStorage/<ws>/chatSessions/<sid>.jsonl`
// (and `User/globalStorage/emptyWindowChatSessions/` for a window with no folder), an append-only
// change log per session; a pre-change-log `<sid>.json` is one snapshot; the workspace's
// `workspace.json` names its folder. sessions v1 four operations over sessions-model v1.1 records.
// `harness_path` is the user-data folder (`~/.config/Code`, `~/Library/Application Support/Code`).
// The Copilot engine's sessions live in ~/.copilot/session-state and belong to copilot-cli
// (sessions-model §1 rule 3); this harness covers only `chatSessions` (`engine: local`).
//
// Ported from memhouse's normaliser (its vscode module): the change-log fold
// and its replay, the reply parts, the tool pairing through `toolCallRounds`, the served
// model, the reply hold, the retraction bookkeeping. New here:
// - redaction runs in `read`, per op, on the op's path `k` joined with the path inside `v`;
// - the fold keeps a request's place in the timeline by a sequence number, not object identity,
//   so the derive state is plain JSON;
// - one speaker per message; a `toolInvocationSerialized` part becomes `<i>:call` + `<i>:result`;
// - usage is its own record (per turn), the retraction has a lifecycle record keyed
//   `<source_key>@<unit_key>#1`, a `customTitle` op is a rename record, a summary a compaction one;
// - a held reply is named in derive's `held`.
//
// Spec: the adapter spec (in the fixture captures, synthetic, captured on a
// test VM: VS Code 1.142; read 2026-10-22), sessions-model v1.1 and its annex row "vscode (engine
// local)".

import fs from 'node:fs';
import path from 'node:path';
import { SessionsError } from '../../errors.js';
import { readStream, readSnapshot, streamUnits, snapshotUnits, unknownSource, plainRel, jsonOf, isRealFile } from '../../sources.js';
import { seal, recordKey } from '../../records.js';
import { jcs, sha256 } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'vscode';
const ENGINE = 'local';
const STATE_VER = 1;
const WS = 'User/workspaceStorage';
const EMPTY_WINDOW = 'User/globalStorage/emptyWindowChatSessions';
const CHAT_FILE = /^(.+)\.(jsonl|json)$/;
const WS_SIDE = /^User\/workspaceStorage\/([^/]+)\/workspace\.json$/;
const WS_CHAT = /^User\/workspaceStorage\/([^/]+)\/chatSessions\/[^/]+$/;
// The one declared secret path (sessions-model §4.1): `auth` under a selected model's metadata,
// wherever a `selectedModel` sits.
const SECRET = ['selectedModel', 'metadata', 'auth'];
// The client is the user-data folder's name (memhouse normaliser, `CLIENTS`).
const CLIENTS = { Code: 'vscode', 'Code - Insiders': 'vscode-insiders', 'Code - OSS': 'code-oss', VSCodium: 'vscodium' };
// modelState.value, as VS Code's ResponseModelState: 0 pending, 1 complete, 2 cancelled, 3 failed,
// 4 needs input. Only 1 is observed in the lab fixtures; the rest is from the normaliser,
// UNVERIFIED.
const MS = { PENDING: 0, CANCELLED: 2, FAILED: 3, NEEDS_INPUT: 4 };
// isConfirmed.type, as VS Code's ToolConfirmKind: 0 denied, 5 skipped (UNVERIFIED; 1 and 4
// observed).
const CONFIRM_DENIED = 0;
const CONFIRM_SKIPPED = 5;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function describe() {
  return describeData;
}

// ---- list -------------------------------------------------------------------------------------

// True when `rel` is a real directory below the harness_path, with no symlink at any segment (the
// directory form of src/sources.js `isRealFile`): list never walks through a symlink, and read
// refuses one (openSource), so the two agree.
function isRealDir(harnessPath, rel) {
  let cur = harnessPath;
  for (const seg of rel.split('/')) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
      throw e;
    }
    if (!st.isDirectory()) return false; // a symlink, too
  }
  return true;
}

// A directory's entries, or none when it is missing or reached through a symlink. An entry that is
// a symlink is neither a file nor a directory here (a Dirent describes the link itself), so a
// linked chat file or workspace folder is never walked.
function readdir(harnessPath, rel) {
  if (!isRealDir(harnessPath, rel)) return [];
  try {
    return fs.readdirSync(path.join(harnessPath, rel), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
}

// A session id is a chat file's stem; it never names another directory.
function validSid(sid) {
  return typeof sid === 'string' && sid !== '' && sid !== '.' && sid !== '..' && !/[/\\]/.test(sid);
}

// The chat folders of a user-data folder: one per workspace, with its workspace.json, and the
// empty-window folder, which has none.
function chatDirs(harnessPath) {
  const dirs = [];
  for (const w of readdir(harnessPath, WS)) {
    if (w.isDirectory()) dirs.push({ rel: `${WS}/${w.name}/chatSessions`, side: `${WS}/${w.name}/workspace.json` });
  }
  dirs.push({ rel: EMPTY_WINDOW, side: null });
  return dirs;
}

// Every source of every session, or of one session only when `only` names it. One id with a
// `.jsonl` and a `.json`, or in two workspaces, is one session with several `main` sources; derive
// picks the one it reads (sessions §1). Each main source in a workspace brings that workspace's
// workspace.json as a `side` source.
function scan(harnessPath, only = null) {
  const sessions = new Map();
  for (const d of chatDirs(harnessPath)) {
    const names = only ? [`${only}.jsonl`, `${only}.json`].filter((n) => isRealFile(harnessPath, `${d.rel}/${n}`)) : readdir(harnessPath, d.rel).filter((e) => e.isFile()).map((e) => e.name);
    for (const name of names) {
      const m = CHAT_FILE.exec(name);
      if (!m || !validSid(m[1])) continue;
      const sid = m[1];
      if (!sessions.has(sid)) sessions.set(sid, new Map());
      const srcs = sessions.get(sid);
      const stream = m[2] === 'jsonl';
      srcs.set(`${d.rel}/${name}`, { source_key: `${d.rel}/${name}`, role: 'main', mode: stream ? 'stream' : 'snapshot', position_kind: stream ? 'byte_offset' : 'snapshot' });
      if (d.side && !srcs.has(d.side) && isRealFile(harnessPath, d.side)) {
        srcs.set(d.side, { source_key: d.side, role: 'side', mode: 'snapshot', position_kind: 'snapshot' });
      }
    }
  }
  const out = new Map();
  const rank = (s) => (s.role === 'main' ? 0 : 1);
  for (const [sid, srcs] of sessions) {
    out.set(sid, [...srcs.values()].sort((a, b) => rank(a) - rank(b) || (a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0)));
  }
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
  for (const [sid, srcs] of scan(store.harness_path)) {
    out.push({
      session_id: sid,
      incarnation: '',
      updated_hint: sha256(JSON.stringify(srcs.map((s) => sourceStat(store.harness_path, s.source_key)))).slice(0, 32),
      // Writes lag the UI by up to ~2 minutes, and nothing marks a session open (fixture captures).
      live: 'unknown',
      sources: srcs,
    });
  }
  return out.sort((a, b) => (a.session_id < b.session_id ? -1 : 1));
}

// ---- redaction (sessions-model §4) ------------------------------------------------------------

const isMarker = (v) => typeof v === 'string' && /^<redacted len=\d+>$/.test(v);

function marker(v) {
  const n = typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : Buffer.byteLength(jcs(v), 'utf8');
  return `<redacted len=${n}>`;
}

// True when the path reaches the secret path: it ends there, or passes through it to a field below
// it (`…selectedModel.metadata.auth.token`). Everything under the secret path is secret.
function endsAtSecret(p) {
  for (let i = 0; i + SECRET.length <= p.length; i++) {
    if (SECRET.every((s, j) => p[i + j] === s)) return true;
  }
  return false;
}

// Replace every value at or below the secret path. `at` is the path of `v` in the
// session state. Returns [value, changed]; a value that is already a marker is left alone.
function redactAt(v, at) {
  if (endsAtSecret(at)) return v == null || isMarker(v) ? [v, false] : [marker(v), true];
  if (!v || typeof v !== 'object') return [v, false];
  let hit = false;
  for (const k of Object.keys(v)) {
    const [x, h] = redactAt(v[k], [...at, Array.isArray(v) ? Number(k) : k]);
    if (h) {
      v[k] = x;
      hit = true;
    }
  }
  return [v, hit];
}

// One change-log op: `kind 0` holds the whole state; `kind 1` sets `v` at `k`; `kind 2` splices the
// elements of `v` into the array at `k`. Any other line is walked from the root.
function redactOp(o) {
  let hit = false;
  const k = Array.isArray(o.k) ? o.k : null;
  if (o.kind === 0) [o.v, hit] = redactAt(o.v, []);
  else if (o.kind === 1 && k) [o.v, hit] = redactAt(o.v, k);
  else if (o.kind === 2 && k && Array.isArray(o.v)) {
    // An element's index is not known before the fold; the secret path has no index segment.
    o.v.forEach((x, j) => {
      const [y, h] = redactAt(x, [...k, j]);
      if (h) {
        o.v[j] = y;
        hit = true;
      }
    });
  } else if (o.kind === 2 && k) [o.v, hit] = redactAt(o.v, k);
  else [, hit] = redactAt(o, []);
  return hit;
}

// A line that does not parse cannot be redacted by path, so it is emitted as one marker: derive
// skips it, as the normaliser skipped a malformed line.
const opaque = (buf) => ({ buf: Buffer.from(JSON.stringify(`<redacted len=${buf.length}>`), 'utf8'), redacted: true });

function redactLine(buf) {
  let o;
  try {
    o = JSON.parse(buf.toString('utf8'));
  } catch {
    return opaque(buf);
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { buf, redacted: false };
  return redactOp(o) ? { buf: Buffer.from(JSON.stringify(o), 'utf8'), redacted: true } : { buf, redacted: false };
}

// A snapshot document: null when it does not parse (a torn write; held back by `read`).
function redactDoc(buf) {
  let o;
  try {
    o = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  const [, hit] = redactAt(o, []);
  return hit ? { buf: Buffer.from(JSON.stringify(o), 'utf8'), redacted: true } : { buf, redacted: false };
}

// ---- read -------------------------------------------------------------------------------------

// A JSON snapshot that does not parse is a write in progress: it is held back whole (sessions §3),
// so an earlier position stands, and a first read returns no unit. `docRedactor()` is the redact
// hook that notes it: `torn` is then the held-back byte count.
function docRedactor() {
  const d = { torn: 0 };
  d.redact = (buf) => {
    const out = redactDoc(buf);
    if (out) return out;
    d.torn = buf.length || 1;
    return { buf, redacted: false };
  };
  return d;
}
const tornHeld = (sourceKey, torn) => [{ unit_key: sourceKey, bytes: torn }];

function readJsonSnapshot(file, sourceKey, from, root) {
  const d = docRedactor();
  const r = readSnapshot(file, sourceKey, from, { root, redact: d.redact });
  if (!d.torn) return r;
  return { continuity: from ? 'unchanged' : 'reset', units: [], gone: [], position: from ?? null, held_back: tornHeld(sourceKey, d.torn) };
}

export function read(store, session, sourceKey, from = null, known = null) {
  void known; // stream and snapshot sources ignore `known` (sessions §2, rules 3 and 5)
  const sid = session.session_id;
  const srcs = validSid(sid) ? scan(store.harness_path, sid).get(sid) : null;
  if (!srcs) throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
  const src = srcs.find((s) => s.source_key === sourceKey);
  if (!src) throw new SessionsError('source_unknown', `${sourceKey} is not a source of ${sid}`, [sourceKey]);
  const file = path.join(store.harness_path, sourceKey);
  if (src.mode === 'stream') return readStream(file, sourceKey, from, { redact: redactLine, root: store.harness_path });
  return readJsonSnapshot(file, sourceKey, from, store.harness_path);
}

// What a source key names, as `scan` names it: a chat file in a workspace's `chatSessions/` or in
// the empty-window folder (a .jsonl change log is a stream, a .json a snapshot), or a workspace's
// `workspace.json` side snapshot. Null for anything else.
function kindOf(sourceKey) {
  if (!plainRel(sourceKey)) return null;
  if (WS_SIDE.test(sourceKey)) return 'snapshot';
  const dir = sourceKey.slice(0, sourceKey.lastIndexOf('/'));
  if (!WS_CHAT.test(sourceKey) && dir !== EMPTY_WINDOW) return null;
  const m = CHAT_FILE.exec(sourceKey.slice(dir.length + 1));
  if (!m || !validSid(m[1])) return null;
  return m[2] === 'jsonl' ? 'stream' : 'snapshot';
}

// The units `read` returns from scratch for a source holding `bytes` (src/index.js
// unitsFromBytes), from the source key alone: no session, no position, no file system. Both
// redactions are `read`'s: per op for a change log, per document for a snapshot, whose torn write
// is held back.
export function unitsFromBytes(sourceKey, bytes, { start = 0 } = {}) {
  const kind = kindOf(sourceKey);
  if (!kind) throw unknownSource(HARNESS, sourceKey);
  if (kind === 'stream') return streamUnits(bytes, sourceKey, { start, redact: redactLine });
  const d = docRedactor();
  const out = snapshotUnits(bytes, sourceKey, { start, redact: d.redact });
  return d.torn ? { units: [], held_back: tornHeld(sourceKey, d.torn) } : out;
}

// ---- the change-log fold (memhouse's normaliser, re-keyed) -------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.trunc(x) : null;
};
const reqId = (r) => (isObj(r) && r.requestId ? String(r.requestId) : '');
const reqsOf = (doc) => (isObj(doc) && Array.isArray(doc.requests) ? doc.requests : null);

function validPath(p) {
  return Array.isArray(p) && p.length > 0 && p.every((s) => (typeof s === 'string' && !UNSAFE_KEYS.has(s)) || (Number.isInteger(s) && s >= 0));
}

// Set t[key], padding an array with nulls first, so the state never holds a hole (JSON has none).
function place(t, key, value) {
  if (Array.isArray(t) && Number.isInteger(key)) while (t.length < key) t.push(null);
  t[key] = value === undefined ? null : value;
}

// Apply one `kind 1/2/3` op at its path (as the normaliser applies it).
function applyPath(doc, o) {
  const p = o.k;
  let t = doc;
  for (let j = 0; j < p.length - 1; j++) {
    if (t[p[j]] == null || typeof t[p[j]] !== 'object') {
      if (o.kind === 3) return;
      place(t, p[j], typeof p[j + 1] === 'number' ? [] : {});
    }
    t = t[p[j]];
  }
  const last = p[p.length - 1];
  if (o.kind === 1) place(t, last, o.v);
  else if (o.kind === 2) {
    if (!Array.isArray(t[last])) place(t, last, []);
    const a = t[last];
    if (Number.isInteger(o.i) && o.i >= 0 && o.i < a.length) a.length = o.i;
    if (Array.isArray(o.v)) for (const x of o.v) a.push(x);
  } else if (o.kind === 3) {
    if (Array.isArray(t) && Number.isInteger(last)) {
      if (last < t.length) t.splice(last, 1);
    } else delete t[last];
  }
}

// The fold of one change-log source. `doc` is the session state; `seqs[i]` is the sequence number
// of `doc.requests[i]`; `timeline` lists every request in the order it entered (`{seq}`) and every
// truncating splice (`{cut, at, through, unit}`); `retired` holds the cut requests by seq;
// `renames` the unit keys of `customTitle` ops. A `kind 0` resets all of it.
function newLog() {
  return { kind: 'log', doc: null, seqs: [], next: 0, timeline: [], retired: {}, renames: [] };
}

function enter(L) {
  const s = L.next++;
  L.timeline.push({ seq: s });
  return s;
}

function dropSeqs(L, gone) {
  if (gone.size) L.timeline = L.timeline.filter((e) => e.cut || !gone.has(e.seq));
}

// After an op that may have grown or shrunk `requests` by path: new slots enter the timeline, and
// vanished ones leave it.
function resync(L) {
  const a = reqsOf(L.doc);
  const n = a ? a.length : 0;
  if (n > L.seqs.length) while (L.seqs.length < n) L.seqs.push(enter(L));
  else if (n < L.seqs.length) dropSeqs(L, new Set(L.seqs.splice(n)));
}

// `kind 2` at ['requests']: without `i`, an append. With `i`, a truncating splice: each cut request
// whose id the same splice re-appends is updated in place (it keeps its seq); the rest are retired,
// and the cut is recorded (memhouse normaliser `replay`).
function spliceRequests(L, o, unitKey) {
  if (!Array.isArray(L.doc.requests)) L.doc.requests = [];
  const a = L.doc.requests;
  const added = Array.isArray(o.v) ? o.v : [];
  const inherited = new Map();
  if (Number.isInteger(o.i) && o.i >= 0 && o.i < a.length) {
    const cut = [];
    for (let j = o.i; j < a.length; j++) {
      const id = reqId(a[j]);
      const m = id ? added.findIndex((x, n) => !inherited.has(n) && reqId(x) === id) : -1;
      if (m >= 0) inherited.set(m, L.seqs[j]);
      else {
        cut.push(L.seqs[j]);
        L.retired[L.seqs[j]] = a[j];
      }
    }
    if (cut.length) {
      const first = added.find(isObj);
      L.timeline.push({ cut, at: first ? num(first.timestamp) : null, through: o.i > 0 ? L.seqs[o.i - 1] : null, unit: unitKey });
    }
    a.length = o.i;
    L.seqs.length = o.i;
  }
  added.forEach((x, n) => {
    a.push(x);
    L.seqs.push(inherited.has(n) ? inherited.get(n) : enter(L));
  });
}

// `kind 1` or `kind 3` at ['requests'] (never observed): the array replaced whole. A request whose
// id is still there keeps its place; what left vanishes; what is new is appended.
function replaceRequests(L, o) {
  const before = reqsOf(L.doc) ?? [];
  const pool = new Map();
  before.forEach((r, j) => {
    const id = reqId(r);
    if (id && !pool.has(id)) pool.set(id, L.seqs[j]);
  });
  const old = new Set(L.seqs);
  applyPath(L.doc, o);
  const now = reqsOf(L.doc) ?? [];
  L.seqs = now.map((r) => {
    const id = reqId(r);
    if (id && pool.has(id)) {
      const s = pool.get(id);
      pool.delete(id);
      old.delete(s);
      return s;
    }
    return enter(L);
  });
  dropSeqs(L, old);
}

function foldOp(L, o, unitKey) {
  if (!isObj(o)) return;
  if (o.kind === 0) {
    // Each kind 0 resets everything before it (fixture captures): what it drops vanishes.
    L.doc = isObj(o.v) ? o.v : null;
    L.timeline = [];
    L.retired = {};
    L.renames = [];
    L.seqs = (reqsOf(L.doc) ?? []).map(() => enter(L));
    return;
  }
  if (!isObj(L.doc) || ![1, 2, 3].includes(o.kind) || !validPath(o.k)) return;
  const p = o.k;
  if (p[0] === 'requests') {
    if (p.length === 1) {
      if (o.kind === 2) spliceRequests(L, o, unitKey);
      else replaceRequests(L, o);
      return;
    }
    if (p.length === 2 && o.kind === 3 && Number.isInteger(p[1])) {
      // A delete of one request (never observed): it vanishes.
      const a = reqsOf(L.doc);
      if (a && p[1] < a.length) {
        a.splice(p[1], 1);
        dropSeqs(L, new Set(L.seqs.splice(p[1], 1)));
      }
      return;
    }
    // A set inside a request, or of a whole request by index: it keeps its place.
    applyPath(L.doc, o);
    resync(L);
    return;
  }
  applyPath(L.doc, o);
  if (o.kind === 1 && p.length === 1 && p[0] === 'customTitle' && typeof o.v === 'string') L.renames.push(unitKey);
}

// ---- records ----------------------------------------------------------------------------------

function isoMs(v) {
  const n = num(v);
  if (n === null) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function utf8Len(s) {
  return Buffer.byteLength(s, 'utf8');
}

// A tool's arguments: a JSON string parsed, a string that does not parse as stored, else the value.
function argsOf(a) {
  if (a == null) return null;
  if (typeof a === 'string') {
    try {
      return JSON.parse(a);
    } catch {
      return a;
    }
  }
  return a;
}

function uriPath(u) {
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (typeof u !== 'object') return '';
  return str(u.fsPath) || str(u.path) || str(u.external) || (u.uri ? uriPath(u.uri) : '');
}

// A `file:` URI as a path, the same on every host: percent-decoded; a drive path (`/c:/…`) in
// Windows form. Any other URI is kept as it is (a remote folder, a `.code-workspace` elsewhere).
function filePath(uri) {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
  if (!m) return uri;
  let p = m[2] ?? '/';
  try {
    p = decodeURIComponent(p);
  } catch { /* kept encoded */ }
  if (/^\/[A-Za-z]:/.test(p)) return p.slice(1).replace(/\//g, '\\');
  return m[1] && m[1] !== 'localhost' ? `//${m[1]}${p}` : p;
}

// workspace.json: `folder`, else `workspace` (a multi-root `.code-workspace` file).
function folderOf(o) {
  if (!isObj(o)) return null;
  const uri = typeof o.folder === 'string' ? o.folder : typeof o.workspace === 'string' ? o.workspace : '';
  if (!uri) return null;
  return uri.startsWith('file:') ? filePath(uri) : uri;
}

// A prompt-tsx node tree as text: its text leaves in order, honouring lineBreakBefore.
function tsxText(node) {
  let out = '';
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.text === 'string') {
      if (n.lineBreakBefore && out && !out.endsWith('\n')) out += '\n';
      out += n.text;
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(node);
  return out;
}

// The text of one toolCallResults entry, as the model saw it.
function toolResultText(r) {
  if (r == null) return null;
  if (typeof r === 'string') return r;
  const content = Array.isArray(r.content) ? r.content : [];
  return content.map((c) => {
    if (!c || typeof c !== 'object') return typeof c === 'string' ? c : '';
    if (typeof c.value === 'string') return c.value;
    if (c.value && typeof c.value === 'object' && c.value.node) return tsxText(c.value.node);
    return typeof c.text === 'string' ? c.text : '';
  }).join('');
}

// The model's own tool calls, by the call id VS Code shows (the round id without `__vscode-<n>`).
function roundCalls(meta) {
  const map = new Map();
  const results = isObj(meta.toolCallResults) ? meta.toolCallResults : {};
  for (const rd of Array.isArray(meta.toolCallRounds) ? meta.toolCallRounds : []) {
    for (const tc of rd && Array.isArray(rd.toolCalls) ? rd.toolCalls : []) {
      const full = String((tc && tc.id) || '');
      if (!full) continue;
      const base = full.split('__vscode-')[0];
      if (!map.has(base)) map.set(base, { name: str(tc.name), arguments: tc.arguments, result: Object.prototype.hasOwnProperty.call(results, full) ? results[full] : null });
    }
  }
  return map;
}

// The served model: Auto's resolution, never the `copilot/auto` placeholder.
function servedModel(r, resp, meta) {
  if (str(meta.resolvedModel)) return meta.resolvedModel;
  for (const p of resp) if (p && p.kind === 'autoModeResolution' && p.resolved && str(p.resolved.id)) return p.resolved.id;
  const rounds = Array.isArray(meta.toolCallRounds) ? meta.toolCallRounds : [];
  for (let i = rounds.length - 1; i >= 0; i--) if (rounds[i] && str(rounds[i].modelId)) return rounds[i].modelId;
  const id = str(r.modelId);
  return id && !/(^|\/)auto$/.test(id) ? id : '';
}

// How the reply ended, or null while it is still being written: the last request with no result
// and no final state is held. A reply that a later request follows has ended even without a result.
function replyStatus(r, isLast) {
  const ms = isObj(r.modelState) ? r.modelState.value : undefined;
  if (r.isCanceled === true || ms === MS.CANCELLED) return 'cancelled';
  if (ms === MS.FAILED) return 'error';
  const running = ms === MS.PENDING || ms === MS.NEEDS_INPUT || (ms == null && !r.result);
  if (running && isLast) return null;
  if (r.result && r.result.errorDetails) return 'error';
  if (running) return r.result ? 'complete' : 'interrupted';
  return 'complete';
}

// One `toolInvocationSerialized` holds the call and its result: two parts sharing the call id
// (sessions-model §2.3).
function toolParts(p, i, callId, call) {
  const tsd = isObj(p.toolSpecificData) ? p.toolSpecificData : {};
  let args = call ? argsOf(call.arguments) : null;
  if (args == null && tsd.kind === 'terminal' && tsd.commandLine) {
    const cl = tsd.commandLine;
    args = { command: typeof cl === 'string' ? cl : str(cl.original) || str(cl.toolEdited) || str(cl.forDisplay) };
  }
  // The result the model saw wins over the terminal view.
  let output = call && call.result != null ? toolResultText(call.result) : null;
  if (output == null && tsd.kind === 'terminal' && isObj(tsd.terminalCommandOutput) && typeof tsd.terminalCommandOutput.text === 'string') output = tsd.terminalCommandOutput.text;
  if (output == null && typeof p.resultError === 'string' && p.resultError) output = p.resultError;
  const confirm = isObj(p.isConfirmed) ? p.isConfirmed.type : undefined;
  const denied = confirm === CONFIRM_DENIED;
  const skipped = confirm === CONFIRM_SKIPPED;
  const failed = denied || p.resultError === true || (typeof p.resultError === 'string' && p.resultError !== '');
  const done = p.isComplete === true || output != null;
  // A terminal tool's exit code (sessions-model §2.3): `terminalCommandState.exitCode`, kept apart
  // from the output; never read from the text.
  const tcs = tsd.kind === 'terminal' && isObj(tsd.terminalCommandState) ? tsd.terminalCommandState : {};
  const exit = Number.isInteger(tcs.exitCode) ? tcs.exitCode : null;
  // A call that never completed in a reply that ended was cut off: cancelled.
  const status = denied ? 'denied' : skipped ? 'cancelled' : done || failed ? 'completed' : 'cancelled';
  // `is_error` is the harness store's own flag (sessions-model v1.x (#6), §2.3): a `resultError`
  // gives true, a done invocation false, one still running null. A done invocation beside a
  // terminal's non-zero `exit_code` is unreliable for that result: its `is_error` is null, and the
  // other results keep the flag. It describes a call that completed: a denial (`denied`), a skip or
  // a cut-off call (`cancelled`) gives null, and the status carries the fact. Never derived from the
  // exit code or the text.
  const isError = status !== 'completed' ? null : failed ? true : done ? (exit !== null && exit !== 0 ? null : false) : null;
  const src = isObj(p.source) ? p.source : {};
  // An MCP tool's server is its ToolDataSource label, else the name the server reports.
  const server = src.type === 'mcp' ? str(src.label) || str(src.serverLabel) || null : null;
  return [
    { part_id: `${i}:call`, kind: 'tool_call', call_id: callId, name: (call && call.name) || str(p.toolId) || 'unknown', args: args ?? {}, server },
    {
      part_id: `${i}:result`, kind: 'tool_result', call_id: callId,
      is_error: isError,
      status,
      output, output_len: output == null ? null : utf8Len(output), truncated: null,
      exit_code: exit,
    },
  ];
}

function inlineLabel(p) {
  const ir = isObj(p.inlineReference) ? p.inlineReference : {};
  const name = str(p.name) || str(ir.name);
  if (name) return `\`${name}\``;
  const ref = uriPath(ir.uri || ir.location || ir);
  return ref ? path.posix.basename(ref) : '';
}

function thinkingText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : str(x && x.value))).join('');
  return '';
}

// The sub-agents of a reply, in the order their first call appears.
function subAgentsOf(resp) {
  const out = [];
  for (const p of resp) {
    const sub = p && typeof p === 'object' ? str(p.subAgentInvocationId) : '';
    if (sub && !out.includes(sub)) out.push(sub);
  }
  return out;
}

// The reply's parts in native order; a sub-agent's own calls go to its message. Text runs merge
// across markdown and inline references; bookkeeping parts neither make a part nor split a run.
function replyParts(resp, aid, calls, subOrder) {
  const main = [];
  const subs = subOrder.map(() => []);
  let run = null;
  const close = () => { run = null; };
  const addText = (i, s) => {
    if (!s) return;
    if (!run) {
      run = { part_id: String(i), kind: 'text', text: '' };
      main.push(run);
    }
    run.text += s;
  };
  for (let i = 0; i < resp.length; i++) {
    const p = resp[i];
    if (!p || typeof p !== 'object') continue;
    const kind = p.kind;
    if (kind == null || kind === 'markdownContent') { addText(i, str(p.value) || str(p.content && p.content.value)); continue; }
    if (kind === 'markdownVuln') { addText(i, str(p.content && p.content.value) || str(p.value)); continue; }
    if (kind === 'inlineReference') { addText(i, inlineLabel(p)); continue; }
    if (kind === 'thinking') {
      const text = thinkingText(p.value);
      if (!text && !p.id) continue; // the reasoning-done marker, not a block
      close();
      main.push(text
        ? { part_id: String(i), kind: 'reasoning', text, signature_len: null }
        : { part_id: String(i), kind: 'reasoning', opaque: true, signature_len: typeof p.id === 'string' ? p.id.length : null });
      continue;
    }
    if (kind === 'toolInvocationSerialized' || kind === 'toolInvocation') {
      close();
      const id = str(p.toolCallId);
      const sub = str(p.subAgentInvocationId);
      const n = sub ? subOrder.indexOf(sub) : -1;
      // Without a native id, the call id is anchored on the message that holds the call.
      const callId = id || `@${n >= 0 ? `${aid}+${n + 1}` : aid}:${i}`;
      (n >= 0 ? subs[n] : main).push(...toolParts(p, i, callId, id ? calls.get(id) : null));
      continue;
    }
    if (kind === 'warning') {
      const text = str(p.content && p.content.value) || str(p.value);
      if (text) {
        close();
        main.push({ part_id: String(i), kind: 'notice', text, level: 'warning', native_type: 'warning' });
      }
      continue;
    }
    // Bookkeeping and UI state (mcpServersStarting, autoModeResolution, undoStop, codeblockUri,
    // textEditGroup, progressMessage, confirmation, …): not kept, declared in `read: lossy`.
  }
  return { main: main.filter((x) => x.kind !== 'text' || x.text.trim()), subs };
}

function userParts(r) {
  const parts = [];
  const msg = isObj(r.message) ? r.message : {};
  const text = typeof msg.text === 'string' ? msg.text
    : Array.isArray(msg.parts) ? msg.parts.map((x) => str(x && x.text)).join('') : typeof r.message === 'string' ? r.message : '';
  if (text) parts.push({ part_id: '0', kind: 'text', text });
  const vars = isObj(r.variableData) && Array.isArray(r.variableData.variables) ? r.variableData.variables : [];
  vars.forEach((v, j) => {
    if (!isObj(v)) return;
    const image = v.kind === 'image' || v.isImage === true;
    const file = v.kind === 'file' || v.kind === 'directory' || v.isFile === true || v.isDirectory === true;
    if (!image && !file) return;
    const ref = uriPath(v.value) || uriPath(Array.isArray(v.references) && v.references[0] && v.references[0].reference) || str(v.name);
    // The store keeps a path and an asset id, never the bytes.
    parts.push({ part_id: `var:${j}`, kind: 'attachment', media_type: str(v.mimeType) || null, ref: ref || null, bytes_len: null });
  });
  return parts;
}

// One request's records: the user message, then (once it has ended) the reply, its sub-agents'
// messages, its usage and its compaction record. While the reply is being written, its keys are
// held.
function requestRecords(r, { isLast, retracted, pos }) {
  const uid = String(r.requestId);
  const state = retracted ? 'retracted' : 'current';
  const hidden = r.hiddenFromTranscript === true;
  const ord = (n) => `${String(pos).padStart(8, '0')}:${String(n).padStart(4, '0')}`;
  const base = {
    agent_id: '', to_user: null, to_model: null, state, on_active_branch: null,
    requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
  };
  const messages = [{
    ...base, message_id: uid, parent_id: null, order: ord(0), role: 'user',
    // hiddenFromTranscript: sent to the model, not shown; what sent it is not recorded.
    source: hidden ? null : 'user', ...(hidden ? { to_user: false, to_model: true } : {}),
    status: 'complete', ts: isoMs(r.timestamp), parts: userParts(r),
  }];
  const respId = r.responseId ? String(r.responseId) : null;
  const aid = respId ?? `${uid}:response`;
  const usageId = respId ? `response:${respId}#1` : `message:${aid}#1`;
  const resp = Array.isArray(r.response) ? r.response : isObj(r.response) ? Object.values(r.response) : [];
  const subOrder = subAgentsOf(resp);
  const status = replyStatus(r, isLast);
  if (!status) {
    return { messages, usage: null, lifecycle: [], held: { message: [aid, ...subOrder.map((_, n) => `${aid}+${n + 1}`)], usage: [usageId], lifecycle: [aid] } };
  }

  const meta = isObj(r.result) && isObj(r.result.metadata) ? r.result.metadata : {};
  const served = servedModel(r, resp, meta) || null;
  const { main, subs } = replyParts(resp, aid, roundCalls(meta), subOrder);
  const err = r.result && r.result.errorDetails;
  if (err && str(err.message)) main.push({ part_id: 'error', kind: 'error', error_kind: str(err.code) || 'unknown', message: err.message, http_status: null });
  const summary = typeof meta.summary === 'string' ? meta.summary : str(meta.summary && meta.summary.text);
  if (summary) main.push({ part_id: 'summary', kind: 'summary', text: summary, replaces: 'unknown' });
  const ts = isoMs(r.responseTimestamp) ?? isoMs(r.timestamp);
  const asst = {
    ...base, ...(hidden ? { to_user: false } : {}), role: 'assistant', source: 'model', status, ts,
    requested_model: str(r.modelId) || null, served_model: served, response_id: respId,
  };
  messages.push({ ...asst, message_id: aid, parent_id: uid, order: ord(1), parts: main });
  // A sub-agent's calls carry subAgentInvocationId: its own speaker, anchored on the reply's id.
  subs.forEach((parts, n) => messages.push({ ...asst, message_id: `${aid}+${n + 1}`, parent_id: aid, agent_id: subOrder[n], order: ord(n + 2), parts }));

  // Usage per request: promptTokens / completionTokens (not result.metadata.outputTokens); a
  // stored zero is null; copilotCredits are not money and have no field.
  const input = num(r.promptTokens) ?? num(meta.promptTokens);
  const output = num(r.completionTokens);
  const usage = input !== null || output !== null ? {
    type: 'usage', usage_id: usageId, anchor: respId ? { response_id: respId } : { message_id: aid },
    input, output, cache_read: null, cache_write: null, reasoning: null, cost: null,
    input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_turn', model: served,
  } : null;
  // `/compact`: a request whose metadata holds the summary; the earlier turns stay (fixture
  // captures).
  const lifecycle = summary ? [{ type: 'lifecycle', lifecycle_id: aid, op: 'compaction', target: { session: true }, at: null, ts, evidence: 'explicit' }] : [];
  return { messages, usage, lifecycle, held: null };
}

// The folded view of the main source derive reads.
function viewOf(sk, s) {
  if (s.kind === 'log') return { sk, doc: s.doc, seqs: s.seqs, timeline: s.timeline, retired: s.retired, renames: s.renames };
  const reqs = reqsOf(s.doc) ?? [];
  return { sk, doc: s.doc, seqs: reqs.map((_, i) => i), timeline: reqs.map((_, i) => ({ seq: i })), retired: {}, renames: [] };
}

function lastActivity(doc) {
  let t = num(doc.creationDate) ?? 0;
  for (const r of reqsOf(doc) ?? []) t = Math.max(t, isObj(r) ? num(r.timestamp) ?? 0 : 0);
  return t;
}

// Of several main sources for one id, the change log wins over a legacy snapshot, then the one
// with the latest activity, then the lowest source_key.
function pickMain(src) {
  const c = Object.entries(src).filter(([, s]) => (s.kind === 'log' || s.kind === 'snap') && isObj(s.doc));
  c.sort(([ka, a], [kb, b]) => (a.kind === b.kind ? 0 : a.kind === 'log' ? -1 : 1)
    || lastActivity(b.doc) - lastActivity(a.doc) || (ka < kb ? -1 : ka > kb ? 1 : 0));
  return c.length ? viewOf(c[0][0], c[0][1]) : null;
}

// Every record of the session from the folded view, and the keys held while a reply is written.
function recordsOf(view) {
  const recs = [];
  const held = { session: [], message: [], usage: [], link: [], lifecycle: [] };
  if (!view) return { recs, held, versions: [], modes: [] };
  const reqs = reqsOf(view.doc) ?? [];
  const index = new Map(view.seqs.map((s, i) => [s, i]));
  const lastSeq = view.seqs[view.seqs.length - 1];
  const currentIds = new Set();
  for (const r of reqs) {
    const id = reqId(r);
    if (id) {
      currentIds.add(id);
      currentIds.add(r.responseId ? String(r.responseId) : `${id}:response`);
    }
  }
  const idsOf = new Map(); // seq -> the message ids written for it
  const seen = new Set();
  const usageSeen = new Set();
  const versions = []; // [order, extensionVersion] of current requests
  const modes = []; // [order, modeInfo.kind] of current requests
  let pos = 0;
  for (const e of view.timeline) {
    if (e.cut) {
      // A kind 2 with i: the requests it cut stay above, retracted; this records the act.
      const ids = e.cut.flatMap((s) => idsOf.get(s) ?? []);
      if (!ids.length) continue;
      const kept = e.through !== null ? idsOf.get(e.through) : null;
      recs.push({
        type: 'lifecycle', lifecycle_id: `${view.sk}@${e.unit}#1`, op: 'rewind',
        target: { range: { from_id: ids[0], through_id: ids[ids.length - 1] } },
        at: kept && kept.length ? kept[kept.length - 1] : null, ts: isoMs(e.at), evidence: 'explicit',
      });
      continue;
    }
    const live = index.has(e.seq);
    const r = live ? reqs[index.get(e.seq)] : view.retired[e.seq];
    const id = reqId(r);
    if (!id) continue; // no native id: nothing to key it by
    const retracted = !live;
    // Keys stay unique: a retracted copy never shadows a current message with the same id.
    if (seen.has(id) || (retracted && currentIds.has(id))) continue;
    seen.add(id);
    const out = requestRecords(r, { isLast: live && e.seq === lastSeq, retracted, pos: pos++ });
    idsOf.set(e.seq, out.messages.map((m) => m.message_id));
    for (const m of out.messages) recs.push({ type: 'message', ...m });
    if (out.usage && !usageSeen.has(out.usage.usage_id)) {
      usageSeen.add(out.usage.usage_id);
      recs.push(out.usage);
    }
    recs.push(...out.lifecycle);
    if (out.held) for (const [t, ks] of Object.entries(out.held)) held[t].push(...ks);
    if (live) {
      const at = out.messages[0].order;
      if (isObj(r.agent) && str(r.agent.extensionVersion)) versions.push([at, r.agent.extensionVersion]);
      if (isObj(r.modeInfo) && str(r.modeInfo.kind)) modes.push([at, r.modeInfo.kind]);
    }
  }
  // A `customTitle` op: a rename the store records (the title itself is the fold's last value).
  for (const u of view.renames) {
    recs.push({ type: 'lifecycle', lifecycle_id: `${view.sk}@${u}#1`, op: 'rename', target: { session: true }, at: null, ts: null, evidence: 'explicit' });
  }
  return { recs, held, versions, modes };
}

// Keep the value from the earliest (`first`) or latest record by its sort key.
function keep(s, field, value, sortKey, first) {
  const cur = s[field];
  if (!cur || (first ? sortKey < cur[0] : sortKey > cur[0])) s[field] = [sortKey, value];
}

function clientOf(harnessPath) {
  const base = String(harnessPath ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  return CLIENTS[base] ?? 'vscode';
}

function sourceKind(sk) {
  if (WS_SIDE.test(sk)) return 'ws';
  if (sk.endsWith('.jsonl')) return 'log';
  if (sk.endsWith('.json')) return 'snap';
  return null;
}

function emptyState() {
  return {
    state_ver: STATE_VER,
    // source_key -> the fold of a change log (`log`), a legacy snapshot (`snap`) or a
    // workspace.json (`ws`)
    src: {},
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
  };
}

// The records are a function of the folded sources alone: each derive folds the new units, then
// recomputes every record and emits those whose content_sha moved (sessions-model §1 rule 5).
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
    if (src.complete || !st.src[sk] || st.src[sk].kind !== kind) st.src[sk] = kind === 'log' ? newLog() : kind === 'snap' ? { kind, doc: null } : { kind, cwd: null };
    const s = st.src[sk];
    const units = kind === 'log' ? [...(src.units ?? [])].sort((a, b) => Number(a.unit_key) - Number(b.unit_key)) : (src.units ?? []);
    for (const u of units) {
      const o = jsonOf(u);
      if (kind === 'log') foldOp(s, o, u.unit_key);
      else if (kind === 'snap') s.doc = isObj(o) ? o : null; // a snapshot unit is the whole document
      else s.cwd = folderOf(o);
    }
  }

  const view = pickMain(st.src);
  const { recs, held, versions, modes } = recordsOf(view);
  const sealed = recs.map((r) => seal({ type: r.type, ...key, ...r }));

  // The session record.
  const doc = view ? view.doc : null;
  const f = {};
  for (const m of sealed) if (m.type === 'message' && m.ts) keep(f, 'updated_at', m.ts, m.ts, false);
  for (const [at, v] of versions) keep(f, 'harness_version', v, at, false);
  for (const [at, v] of modes) keep(f, 'mode', v, at, false);
  const createdAt = doc ? isoMs(doc.creationDate) : null;
  if (createdAt) keep(f, 'updated_at', createdAt, createdAt, false);
  const ws = view ? WS_CHAT.exec(view.sk) : null;
  const side = ws ? st.src[`${WS}/${ws[1]}/workspace.json`] : null;
  const title = doc && str(doc.customTitle) ? doc.customTitle : null;
  const current = sealed.filter((m) => m.type === 'message' && m.state === 'current').sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  sealed.push(seal({
    type: 'session',
    ...key,
    engine: ENGINE,
    client: clientOf(session.harness_path),
    // The Copilot Chat extension's version on the last current request: the chat file names no
    // VS Code version (fixture captures: VS Code 1.142, built-in Copilot Chat 0.70.0).
    harness_version: f.harness_version ? f.harness_version[1] : null,
    title,
    // `customTitle` is written by a rename; whether a generated title is written there too is not
    // established.
    title_set_by: title ? 'unknown' : null,
    cwd: side && side.cwd ? side.cwd : null,
    last_cwd: null,
    created_at: createdAt,
    updated_at: f.updated_at ? f.updated_at[1] : null,
    state: 'active',
    pinned: null,
    mode: f.mode ? f.mode[1] : null,
    kind: null,
    reuse: 'impossible',
    ts_source: 'event',
    aliases: [],
    fingerprint: { cmp_shas: current.map((m) => m.cmp_sha) },
  }));

  // Emit what moved; forget what is gone (the consumer tombstones it); keep what is held.
  const changed = [];
  const live = { session: [], message: [], usage: [], link: [], lifecycle: [] };
  const produced = new Set();
  for (const r of sealed) {
    const k = recordKey(r);
    const tk = r.type + '\u0000' + k;
    if (produced.has(tk)) continue;
    produced.add(tk);
    live[r.type].push(k);
    if (st.emitted[r.type][k] !== r.content_sha) {
      st.emitted[r.type][k] = r.content_sha;
      changed.push(r);
    }
  }
  // Held: the pending reply's messages and its usage; its compaction record only when one was
  // written before (a reply re-appended pending under its id), since a pending request does not
  // show whether it will hold a summary.
  const heldOut = {};
  for (const [t, ks] of Object.entries(held)) {
    heldOut[t] = [...new Set(ks)].filter((k) => !produced.has(t + '\u0000' + k) && (t !== 'lifecycle' || st.emitted.lifecycle[k] !== undefined)).sort();
  }
  for (const [t, ks] of Object.entries(st.emitted)) {
    const keepKeys = new Set([...live[t], ...heldOut[t]]);
    for (const k of Object.keys(ks)) if (!keepKeys.has(k)) delete ks[k];
  }
  for (const t of Object.keys(live)) live[t].sort();
  return {
    changed,
    live,
    held: heldOut,
    state: st,
    checkpoint: true,
    adapter_ver: describeData.adapter_ver,
    model_version: describeData.model_version,
    state_ver: STATE_VER,
  };
}
