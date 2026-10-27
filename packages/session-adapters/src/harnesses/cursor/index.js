// Cursor IDE: `<user data>/User/globalStorage/state.vscdb`, one SQLite database (WAL) shared by every
// chat of every workspace. `harness_path` is the user-data folder (the parent of `User/`). A chat
// (a "composer") is its `composerHeaders` row, its `cursorDiskKV` row `composerData:<cid>` and its
// bubble rows `bubbleId:<cid>:<bubbleId>`. sessions v1 four operations over sessions-model v1.1
// records.
//
// Ported from memhouse's v4 normaliser (its cursor module): the chat list, the
// turn grouping by `fullConversationHeadersOnly`, the child parts (`/s:n` text or thinking,
// `/t:<call>` tool), the user parts (text, rich text, images), usage with `{0,0}` as unknown, model
// and effort, the older inline format. New here:
// - three sources per chat (sessions §2 grammar): the header row (side, snapshot), the
//   composerData row (main, snapshot) and the bubble key range (main, delta, `kv`, unit key = the
//   full KV key);
// - redaction in `read`, on the declared paths (the composer's two encryption keys), and the
//   volatile fields left out of both snapshots, so a view or a gauge tick is not a new unit;
// - the torn read and the streaming holds as derive `held`: a bubble the header list names but the
//   store lacks yet, a reply still generating, a tool still running in the last turn. Only the
//   incomplete message is held (memhouse held every later message too, its log being ordered by
//   append);
// - a chat whose bubbles are stored but whose composerData row is not (the order cannot be known,
//   so nothing can be folded) is the retryable read error `inconsistent`; a committed row that does
//   not parse is `damaged` (sessions v1 §2);
// - records in the sessions-model shape: the user bubble keeps its `bubbleId`, the reply is
//   `<bubbleId>:assistant` with its children as parts (`s:n`, `t:<call>:call` / `t:<call>:result`,
//   sessions-model §2.2, §2.3), usage as its own record, the archive flag as a lifecycle record, the
//   sub-agents a chat names as origin-side links.
//
// Never read: ItemTable (it holds the login rows) and `agentKv:blob:*` (cursor-agent turn blobs).
// The `agent-transcripts` JSONL lies outside `harness_path` and is not read in this version.

import { SessionsError } from '../../errors.js';
import { isRealFile, jsonOf } from '../../sources.js';
import { openReadOnly, withRead, hasTable, readDelta, readRowsSnapshot, textOf } from '../../sqlite.js';
import { seal, recordKey } from '../../records.js';
import { sha256, jcs } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'cursor';
const STATE_VER = 1;
export const DB_REL = 'User/globalStorage/state.vscdb';
// The source keys of one chat.
export const HEADERS = `${DB_REL}#table:composerHeaders`;
export const composerDataSource = (cid) => `${DB_REL}#kv:composerData:${cid}`;
export const bubblesSource = (cid) => `${DB_REL}#kv:bubbleId:${cid}:`;

export function describe() {
  return describeData;
}

// ---- small helpers ----------------------------------------------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const posInt = (v) => {
  const x = Math.trunc(Number(v));
  return Number.isFinite(x) && x > 0 ? x : 0;
};
// A time as epoch ms: a number, or an ISO string.
const ms = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const isoOf = (t) => (t == null ? null : new Date(t).toISOString());
function parseJson(v) {
  if (v == null) return null;
  try {
    return JSON.parse(textOf(v));
  } catch {
    return null;
  }
}

// ---- read-side shaping: volatile fields, redaction --------------------------------------------

const VOLATILE_HEADER_COLS = new Set(['lastUpdatedAt', 'recency', 'checkpointAt']);
const VOLATILE_HEADER_VALUE = ['lastUpdatedAt', 'conversationCheckpointLastUpdatedAt', 'lastReadAtMs', 'contextUsagePercent', 'hasUnreadMessages'];
const VOLATILE_DATA = ['lastUpdatedAt', 'conversationCheckpointLastUpdatedAt', 'lastReadAtMs', 'hasUnreadMessages', 'contextUsagePercent',
  'contextTokensUsed', 'contextTokenLimit', 'promptTokenBreakdown', 'promptContextUsageTree', 'conversationState', 'latestChatGenerationUUID'];
const SECRET_DATA = ['blobEncryptionKey', 'speculativeSummarizationEncryptionKey'];

function marker(v) {
  const n = typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : Buffer.byteLength(jcs(v), 'utf8');
  return `<redacted len=${n}>`;
}
const isMarker = (v) => typeof v === 'string' && /^<redacted len=\d+>$/.test(v);

const damaged = (sourceKey, what) => new SessionsError('damaged', `${sourceKey}: ${what} is stored but does not parse`, [sourceKey]);

// A stored JSON object, or `damaged`: a committed row that does not parse is never read as absent.
function mustObject(v, sourceKey, what) {
  const o = parseJson(v);
  if (!isObj(o)) throw damaged(sourceKey, what);
  return o;
}

// The header row without its volatile columns and value fields; `value` stays JSON text.
function headerUnit(row, sourceKey) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!VOLATILE_HEADER_COLS.has(k)) out[k] = v instanceof Uint8Array ? textOf(v) : v;
  if (row.value != null) {
    const val = mustObject(row.value, sourceKey, `the composerHeaders value of ${row.composerId}`);
    for (const k of VOLATILE_HEADER_VALUE) delete val[k];
    out.value = JSON.stringify(val);
  }
  return out;
}

// The composerData row without its volatile fields, the two encryption keys replaced by the marker.
function composerDataUnit(row, sourceKey) {
  const cd = mustObject(row.value, sourceKey, String(row.key));
  for (const k of VOLATILE_DATA) delete cd[k];
  if (Array.isArray(cd.fullConversationHeadersOnly)) {
    cd.fullConversationHeadersOnly = cd.fullConversationHeadersOnly.map((h) => {
      if (!isObj(h)) return h;
      const { contentHeightHint: _h, ...rest } = h;
      return rest;
    });
  }
  let redacted = false;
  for (const k of SECRET_DATA) {
    if (cd[k] != null && !isMarker(cd[k])) {
      cd[k] = marker(cd[k]);
      redacted = true;
    }
  }
  return { row: { key: String(row.key), value: JSON.stringify(cd) }, redacted };
}

// ---- the database ------------------------------------------------------------------------------

// A chat's bubble rows: the range [bubbleId:<cid>:, bubbleId:<cid>;) on the unique key index.
const bubbleRange = (cid) => [`bubbleId:${cid}:`, `bubbleId:${cid};`];
// Their count and highest rowid, from the covering key index alone. The store's upsert (ON CONFLICT
// REPLACE) gives a rewritten bubble a new rowid, so a rewrite moves the highest one.
export const BUBBLE_KEY_SQL = 'SELECT count(*) AS n, max(rowid) AS last FROM cursorDiskKV WHERE key >= ? AND key < ?';

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
}

// Whether the store keeps its chat list in `composerHeaders`. Without the table, or with no row in
// it, the `composerData:` keys are the list (an install from before the table; memhouse's rule).
function headerList(db) {
  return hasTable(db, 'composerHeaders') && !!db.prepare('SELECT 1 FROM composerHeaders LIMIT 1').get();
}

// ---- list -------------------------------------------------------------------------------------

// One entry per chat. `updated_hint` moves with the header row (`recency`, which moves for every
// chat, and `checkpointAt` left out), the composerData row's rowid and size (an upsert gives it a
// new rowid), and the bubble range's count and highest rowid.
export function list(store) {
  const root = store.harness_path;
  // No database here, or one reached through a symlink: no sessions (read refuses it too).
  if (!isRealFile(root, DB_REL)) return [];
  const db = openReadOnly(root, DB_REL);
  try {
    return withRead(db, DB_REL, (d) => {
      const kv = hasTable(d, 'cursorDiskKV');
      const bubbles = kv ? d.prepare(BUBBLE_KEY_SQL) : null;
      const data = kv ? d.prepare('SELECT rowid AS r, octet_length(value) AS n FROM cursorDiskKV WHERE key = ?') : null;
      const changeOf = (cid) => {
        const b = bubbles ? bubbles.get(...bubbleRange(cid)) : null;
        const c = data ? data.get(`composerData:${cid}`) : null;
        return [c ? Number(c.r) : null, c ? Number(c.n) : null, b ? Number(b.n) : 0, b && b.last != null ? Number(b.last) : null];
      };
      const entries = [];
      if (headerList(d)) {
        const cols = columnsOf(d, 'composerHeaders').filter((c) => c !== 'recency' && c !== 'checkpointAt');
        if (!cols.includes('composerId')) return [];
        for (const r of d.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM composerHeaders`).all()) {
          const cid = str(r.composerId);
          if (!cid) continue;
          const head = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? textOf(v) : v]));
          entries.push({ cid, hint: [jcs(head), ...changeOf(cid)] });
        }
      } else if (kv) {
        // Range on the key column; the unique key index covers key and rowid, so no value is read.
        for (const { key } of d.prepare("SELECT key FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'").all()) {
          const cid = String(key).slice('composerData:'.length);
          if (cid) entries.push({ cid, hint: [null, ...changeOf(cid)] });
        }
      }
      return entries.map(({ cid, hint }) => ({
        session_id: cid,
        incarnation: '',
        updated_hint: sha256(JSON.stringify(hint)).slice(0, 32),
        live: 'unknown',
        sources: [
          { source_key: bubblesSource(cid), role: 'main', mode: 'delta', position_kind: 'kv' },
          { source_key: composerDataSource(cid), role: 'main', mode: 'snapshot', position_kind: 'snapshot' },
          { source_key: HEADERS, role: 'side', mode: 'snapshot', position_kind: 'snapshot' },
        ],
      })).sort((a, b) => cmpStr(a.session_id, b.session_id));
    });
  } finally {
    db.close();
  }
}

// ---- read -------------------------------------------------------------------------------------

function kindOf(sourceKey, cid) {
  if (sourceKey === HEADERS) return 'header';
  if (sourceKey === composerDataSource(cid)) return 'data';
  if (sourceKey === bubblesSource(cid)) return 'bubbles';
  return null;
}

// One source of one chat, read in one transaction together with the chat's membership (its header
// row; on a store without the chat list, its composerData row), so a slice is never read for a chat
// that is gone.
export function read(store, session, sourceKey, from = null, known = null) {
  const cid = String(session.session_id);
  const kind = kindOf(sourceKey, cid);
  if (!kind) throw new SessionsError('source_unknown', `${sourceKey} is not a source of cursor chat ${cid}`, [sourceKey]);
  const root = store.harness_path;
  if (!isRealFile(root, DB_REL)) throw new SessionsError('session_unknown', `no session ${cid}`, [cid]);
  const db = openReadOnly(root, DB_REL, sourceKey);
  try {
    return withRead(db, sourceKey, (d) => {
      const kv = hasTable(d, 'cursorDiskKV');
      const listed = headerList(d);
      const header = listed ? d.prepare('SELECT * FROM composerHeaders WHERE composerId = ?').get(cid) : null;
      const dataRow = kv ? d.prepare('SELECT key, value FROM cursorDiskKV WHERE key = ?').get(`composerData:${cid}`) : null;
      // Without composerHeaders (an older Cursor), the composerData row is the chat's only proof of
      // existence, as in `list`: bubbles left without one cannot be told from a deleted chat's
      // orphans, so they read as no session, never as a torn view that would be retried forever.
      if (listed ? !header : !dataRow) throw new SessionsError('session_unknown', `no session ${cid}`, [cid]);

      if (kind === 'header') {
        return readRowsSnapshot(sourceKey, { composerHeaders: header ? [headerUnit(header, sourceKey)] : [] }, from);
      }
      if (kind === 'data') {
        if (!dataRow) {
          // A chat with bubbles and no composerData row: their order is unknown and nothing can be
          // folded, a view the harness never leaves whole (a write between rows). A chat with
          // neither is an empty one (a draft): an empty unit.
          const b = kv ? d.prepare(BUBBLE_KEY_SQL).get(...bubbleRange(cid)) : null;
          if (b && Number(b.n) > 0) throw new SessionsError('inconsistent', `cursor chat ${cid} has bubbles but no composerData row`, [sourceKey]);
          return readRowsSnapshot(sourceKey, { cursorDiskKV: [] }, from);
        }
        const u = composerDataUnit(dataRow, sourceKey);
        return readRowsSnapshot(sourceKey, { cursorDiskKV: [u.row] }, from, { redact: (body) => ({ row: body, redacted: u.redacted }) });
      }
      // The bubble range: every bubble of the chat, listed or not (derive drops the unlisted ones).
      const rows = kv
        ? d.prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key').all(...bubbleRange(cid)).map((r) => {
          const k = String(r.key);
          const value = textOf(r.value);
          mustObject(value, sourceKey, k);
          return { unit_key: k, row: { key: k, value } };
        })
        : [];
      return readDelta(sourceKey, rows, from, known);
    });
  } finally {
    db.close();
  }
}

// ---- derive -----------------------------------------------------------------------------------

function emptyState() {
  return {
    state_ver: STATE_VER,
    header: null, // the header row, `value` parsed; null when none
    data: null, // the composerData value, parsed; null when none
    bubbles: {}, // KV key -> the bubble value, parsed
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
  };
}
const noHeld = () => ({ session: [], message: [], usage: [], link: [], lifecycle: [] });

// The row of a snapshot unit (`{composerHeaders: [row]}` or `{cursorDiskKV: [row]}`), or null.
function snapshotRow(u) {
  const o = u ? jsonOf(u) : null;
  const rows = isObj(o) ? o.composerHeaders ?? o.cursorDiskKV : null;
  return Array.isArray(rows) && isObj(rows[0]) ? rows[0] : null;
}

// The current units of every source are kept, and the records are built from all of them on every
// derive: completeness is decided across sources (the header list against the bubbles), so any
// split of the units, in any source order, gives the same records.
export function derive(session, input, state) {
  const st = state && state.state_ver === STATE_VER ? structuredClone(state) : emptyState();
  const cid = String(session.session_id);
  const key = {
    host: session.host, harness: HARNESS, harness_path: session.harness_path,
    session_id: session.session_id, incarnation: session.incarnation ?? '',
  };

  for (const src of input) {
    const kind = kindOf(src.source_key, cid);
    const units = src.units ?? [];
    if (kind === 'bubbles') {
      if (src.complete) st.bubbles = {};
      for (const k of src.gone ?? []) delete st.bubbles[k];
      for (const u of units) {
        const o = jsonOf(u);
        const v = isObj(o) ? parseJson(o.value) : null;
        if (isObj(v)) st.bubbles[u.unit_key] = v;
        else delete st.bubbles[u.unit_key];
      }
    } else if (kind === 'header' || kind === 'data') {
      if (!units.length && !src.complete) continue;
      const row = snapshotRow(units[units.length - 1]);
      const value = row ? parseJson(row.value) : null;
      if (kind === 'header') st.header = row ? { ...row, value: isObj(value) ? value : {} } : null;
      else st.data = isObj(value) ? value : null;
    }
  }

  const { out, held } = build(st, key);

  const changed = [];
  const live = noHeld();
  const cmp = []; // the fingerprint: cmp_sha of every message on the current line, in order
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

// ---- the fold ---------------------------------------------------------------------------------

const TERMINAL = new Set(['completed', 'cancelled', 'error', 'rejected', 'aborted']);
const THINKING = 30;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

function wsPath(w) {
  const u = isObj(w) ? w.uri : null;
  return isObj(u) ? str(u.fsPath || u.path) : '';
}

// ProseMirror JSON -> its text nodes, for a user bubble whose plain `text` is empty.
function richTextOf(rt) {
  const doc = typeof rt === 'string' ? parseJson(rt) : rt;
  if (!isObj(doc)) return '';
  const out = [];
  (function walk(n, depth) {
    if (!isObj(n) || depth > 64) return;
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.content)) {
      n.content.forEach((c) => walk(c, depth + 1));
      if (n.type === 'paragraph') out.push('\n');
    }
  })(doc, 0);
  return out.join('').replace(/\n+$/, '');
}

// The header list: `fullConversationHeadersOnly` (it names every bubble and every child bubble), or
// the older inline `conversation`.
function headersOf(cd) {
  if (Array.isArray(cd.fullConversationHeadersOnly)) return cd.fullConversationHeadersOnly.filter((h) => isObj(h) && h.bubbleId);
  if (Array.isArray(cd.conversation)) return cd.conversation.filter((b) => isObj(b) && b.bubbleId).map((b) => ({ bubbleId: b.bubbleId, type: b.type }));
  return [];
}

function argsOf(tfd) {
  const raw = parseJson(tfd.rawArgs);
  if (isObj(raw) && Object.keys(raw).length) return raw;
  const p = typeof tfd.params === 'string' ? parseJson(tfd.params) : tfd.params;
  if (p && typeof p === 'object') return p;
  return typeof tfd.params === 'string' && tfd.params ? { raw: tfd.params } : {};
}

// A `/t:<call>` bubble: one native part holding call and result, so two parts sharing the call id
// (sessions-model §2.3); the result only once the tool has ended.
function toolParts(tfd, partId) {
  const st = str(tfd.status);
  const done = TERMINAL.has(st);
  const res = typeof tfd.result === 'string' ? parseJson(tfd.result) : tfd.result;
  const callId = str(tfd.toolCallId) || partId.replace(/^t:/, '');
  const parts = [{
    part_id: `${partId}:call`, kind: 'tool_call', call_id: callId,
    name: str(tfd.name) || (tfd.tool != null ? `tool-${tfd.tool}` : 'unknown'), args: argsOf(tfd), server: null,
  }];
  if (done) {
    let output;
    if (isObj(res) && typeof res.output === 'string') output = res.output;
    else if (typeof tfd.result === 'string') output = tfd.result;
    else if (tfd.result != null) output = JSON.stringify(tfd.result);
    else output = '';
    const exit = isObj(res) && Number.isFinite(res.exitCode) ? res.exitCode : null;
    const denied = st === 'rejected' || (isObj(res) && res.rejected === true);
    const status = denied ? 'denied' : st === 'cancelled' || st === 'aborted' ? 'cancelled' : 'completed';
    // `is_error` is the harness store's own flag (sessions-model v1.x proposal (#6), §2.3): an `error`
    // status, the tool's or `additionalData`'s, gives true, and `completed` false. A `completed`
    // beside a shell's non-zero `exit_code` is unreliable for that result: its `is_error` is null,
    // and the other results keep the flag. It describes a call that completed: a denial
    // (`denied`), a cancel or an abort (`cancelled`) gives null, and the status carries the fact.
    // Never derived from the exit code or the text.
    const failed = st === 'error' || (isObj(tfd.additionalData) && tfd.additionalData.status === 'error');
    const isError = status !== 'completed' ? null : failed ? true : st === 'completed' && exit !== null && exit !== 0 ? null : false;
    parts.push({
      part_id: `${partId}:result`, kind: 'tool_result', call_id: callId, is_error: isError,
      status,
      output, output_len: Buffer.byteLength(output, 'utf8'), truncated: null,
      // The shell's `result.exitCode`, stored beside `result.output`, never parsed out of it.
      exit_code: Number.isInteger(exit) ? exit : null,
    });
  }
  return { parts, running: !done };
}

function reasoningPart(partId, th) {
  const text = typeof th.text === 'string' ? th.text : '';
  const sig = posInt(th.signature_len) || (typeof th.signature === 'string' && th.signature ? th.signature.length : 0) || null;
  if (text) return { part_id: partId, kind: 'reasoning', text, signature_len: sig };
  if (sig) return { part_id: partId, kind: 'reasoning', opaque: true, signature_len: sig };
  return null;
}

// A child bubble (`s:n` or `t:<call>`) -> its parts.
function childParts(b, hdr, suffix) {
  const tfd = b.toolFormerData;
  if (isObj(tfd) && (suffix.startsWith('t:') || tfd.toolCallId)) return toolParts(tfd, suffix);
  const cap = b.capabilityType ?? (isObj(hdr.grouping) ? hdr.grouping.capabilityType : undefined);
  if (Number(cap) === THINKING || (isObj(b.thinking) && !b.text)) {
    const p = reasoningPart(suffix, isObj(b.thinking) ? b.thinking : {});
    return { parts: p ? [p] : [], running: false };
  }
  if (typeof b.text === 'string' && b.text) return { parts: [{ part_id: suffix, kind: 'text', text: b.text }], running: false };
  return { parts: [], running: false }; // an empty segment carries nothing
}

// An older-format standalone assistant bubble -> its parts (thinking, text, tool).
function flatParts(b) {
  const parts = [];
  let running = false;
  if (isObj(b.thinking)) {
    const p = reasoningPart('thinking', b.thinking);
    if (p) parts.push(p);
  }
  if (typeof b.text === 'string' && b.text) parts.push({ part_id: 'text', kind: 'text', text: b.text });
  const tfd = b.toolFormerData;
  if (isObj(tfd) && (tfd.toolCallId || tfd.name)) {
    const t = toolParts(tfd, `t:${str(tfd.toolCallId) || '0'}`);
    parts.push(...t.parts);
    running = t.running;
  }
  return { parts, running };
}

function userParts(b) {
  const parts = [];
  const text = typeof b.text === 'string' && b.text ? b.text : richTextOf(b.richText);
  if (text) parts.push({ part_id: '0', kind: 'text', text });
  const imgs = isObj(b.context) && Array.isArray(b.context.selectedImages) ? b.context.selectedImages : [];
  imgs.forEach((im, j) => {
    if (!isObj(im)) return;
    const ref = str(im.path || im.uuid);
    const ext = (/\.([a-z0-9]+)$/i.exec(ref) || [])[1];
    // Cursor copies the image into workspaceStorage; the bubble keeps a path, never the bytes.
    parts.push({ part_id: `img:${str(im.uuid) || j}`, kind: 'attachment', media_type: IMAGE_TYPES[str(ext).toLowerCase()] ?? null, inline: null, ref: ref || null, bytes_len: null });
  });
  return parts;
}

// tokenCount summed over the reply's bubbles, else the user bubble's (never both, so never billed
// twice). `{0,0}` is unknown (the free plan stores it everywhere), so no record; a lone zero is null.
function usageOf(children, user) {
  const sum = (bs) => bs.reduce((a, b) => {
    const t = isObj(b) && isObj(b.tokenCount) ? b.tokenCount : {};
    return [a[0] + posInt(t.inputTokens), a[1] + posInt(t.outputTokens)];
  }, [0, 0]);
  let [i, o] = sum(children);
  if (!i && !o) [i, o] = sum([user]);
  if (!i && !o) return null;
  return { input: i || null, output: o || null, cache_read: null, cache_write: null, reasoning: null, cost: null, input_includes_cache: null, output_includes_reasoning: null };
}

// Effort is composer-level (`modelConfig.selectedModels[].parameters`), so a mid-chat model change
// relabels earlier turns.
function effortOf(mc, model) {
  const sel = isObj(mc) && Array.isArray(mc.selectedModels) ? mc.selectedModels.filter(isObj) : [];
  const m = sel.find((s) => s.modelId === model) || (sel.length === 1 ? sel[0] : null);
  const p = m && Array.isArray(m.parameters) ? m.parameters.find((x) => isObj(x) && x.id === 'effort') : null;
  return p && p.value != null ? String(p.value) : null;
}

function build(st, key) {
  const out = [];
  const held = noHeld();
  const cid = String(key.session_id);
  const self = { harness: HARNESS, session_id: cid };
  const hrow = st.header;
  const hv = hrow && isObj(hrow.value) ? hrow.value : {};
  const c = isObj(st.data) ? st.data : {};
  const prefix = `bubbleId:${cid}:`;
  const inline = new Map((Array.isArray(c.conversation) ? c.conversation : []).filter((b) => isObj(b) && b.bubbleId).map((b) => [String(b.bubbleId), b]));
  const bubble = (bid) => st.bubbles[prefix + bid] ?? inline.get(bid) ?? null;

  // Turns: a top-level bubble with the children that follow it in the header list. A bubble the
  // list does not name is not part of the chat (a leftover of an edit, a write ahead of the list).
  const turns = [];
  const byId = new Map();
  headersOf(c).forEach((h, idx) => {
    const bid = String(h.bubbleId);
    const slash = bid.indexOf('/');
    if (slash < 0) {
      if (byId.has(bid) && byId.get(bid).hdr) return; // listed twice: the first place wins
      if (byId.has(bid)) {
        byId.get(bid).hdr = h;
        return;
      }
      const t = { id: bid, idx, hdr: h, children: [] };
      turns.push(t);
      byId.set(bid, t);
      return;
    }
    const uid = bid.slice(0, slash);
    let t = byId.get(uid);
    if (!t) {
      // A child whose user bubble the list does not name (yet).
      t = { id: uid, idx, hdr: null, children: [] };
      turns.push(t);
      byId.set(uid, t);
    }
    if (!t.children.some((ch) => ch.bid === bid)) t.children.push({ bid, suffix: bid.slice(slash + 1), idx, hdr: h });
  });

  const generating = new Set((Array.isArray(c.generatingBubbleIds) ? c.generatingBubbleIds : []).map(String));
  let lastUser = -1;
  turns.forEach((t, i) => {
    if (t.hdr && Number(t.hdr.type) === 1) lastUser = i;
  });
  const model0 = isObj(c.modelConfig) ? str(c.modelConfig.modelName) : '';
  const order = (idx) => String(idx).padStart(8, '0');
  const message = (id, idx, role, source, status, ts, parts, extra = {}) => ({
    type: 'message', message_id: id, parent_id: null, order: order(idx), agent_id: '', role, source,
    to_user: null, to_model: null, status, state: 'current', on_active_branch: null, ts,
    requested_model: null, served_model: null, effort: null, response_id: null, aliases: [], parts, ...extra,
  });
  const usageRec = (mid, u, model) => ({ type: 'usage', usage_id: `message:${mid}#1`, anchor: { message_id: mid }, ...u, granularity: 'per_message', model: model || null });
  const hold = (mid) => {
    held.message.push(mid);
    held.usage.push(`message:${mid}#1`);
  };

  turns.forEach((t, ti) => {
    const ended = ti < lastUser; // a later user bubble exists: this turn is over
    const isLast = !ended;
    const ub = t.hdr ? bubble(t.id) : null;
    const type = Number((ub && ub.type) ?? (t.hdr && t.hdr.type));

    if (t.hdr && type === 2) {
      // Older format: an assistant bubble with its own id.
      if (!ub) return hold(t.id);
      const { parts, running } = flatParts(ub);
      const streaming = isLast && (c.status === 'generating' || generating.has(t.id));
      if ((running && !ended) || streaming) return hold(t.id);
      const model = str(ub.modelId || ub.model || model0);
      out.push(message(t.id, t.idx, 'assistant', 'model', running ? 'interrupted' : 'complete', isoOf(ms(ub.createdAt)), parts,
        { served_model: model || null, effort: effortOf(c.modelConfig, model) }));
      const u = usageOf([ub], null);
      if (u) out.push(usageRec(t.id, u, model));
      return undefined;
    }

    if (t.hdr) {
      if (!ub) held.message.push(t.id); // listed, not stored yet
      else out.push(message(t.id, t.idx, 'user', 'user', 'complete', isoOf(ms(ub.createdAt) ?? ms(t.hdr.startedAtMs) ?? ms(ub.startedAtMs)), userParts(ub)));
    }
    if (!t.children.length) return undefined;

    // The reply: the user bubble's children, in header order, as one assistant message.
    const mid = `${t.id}:assistant`;
    const childBubbles = t.children.map((ch) => bubble(ch.bid));
    const streaming = isLast && (c.status === 'generating' || generating.has(t.id) || t.children.some((ch) => generating.has(ch.bid)));
    const parts = [];
    let running = false;
    let first = null;
    t.children.forEach((ch, j) => {
      const b = childBubbles[j];
      if (!b) return;
      const p = childParts(b, ch.hdr, ch.suffix);
      if (p.parts.length && first === null) first = ms(b.createdAt) ?? ms(b.startedAtMs) ?? ms(ch.hdr.startedAtMs);
      parts.push(...p.parts);
      if (p.running) running = true;
    });
    // Held: a child listed and not stored yet (a torn view across rows), a reply still generating,
    // a tool still running in a turn no later prompt has ended.
    if (childBubbles.some((b) => !b) || streaming || (running && isLast)) return hold(mid);
    if (!parts.length) return undefined;
    const last = parts[parts.length - 1];
    const model = str((ub && isObj(ub.modelInfo) && ub.modelInfo.modelName) || model0);
    out.push(message(mid, t.children[0].idx, 'assistant', 'model',
      running ? 'interrupted' : last.kind === 'tool_result' && last.status === 'cancelled' ? 'cancelled' : 'complete',
      isoOf(first), parts, { parent_id: t.hdr ? t.id : null, served_model: model || null, effort: effortOf(c.modelConfig, model) }));
    const u = usageOf(childBubbles, ub);
    if (u) out.push(usageRec(mid, u, model));
    return undefined;
  });

  // Archive: `isArchived` set in place, no time stored. The record has no native id, so it is keyed
  // on the header unit; clearing the flag drops it (unarchive is implicit).
  const archived = (hrow && Number(hrow.isArchived) === 1) || hv.isArchived === true;
  if (archived) {
    out.push({ type: 'lifecycle', lifecycle_id: `${HEADERS}@${HEADERS}#1`, op: 'archive', target: { session: true }, at: null, ts: null, evidence: 'explicit' });
  }

  // Sub-agents: the chat names the composers it started (origin side). No call is named, and a
  // child composer names no parent.
  const children = [];
  for (const x of Array.isArray(c.subagentComposerIds) ? c.subagentComposerIds : []) {
    const id = typeof x === 'string' ? x : isObj(x) ? str(x.composerId) : '';
    if (id && !children.includes(id)) children.push(id);
  }
  for (const ch of children) {
    out.push({ type: 'link', kind: 'subagent', stated_on: 'origin', child: { harness: HARNESS, session_id: ch }, origin: self, at: '', inherits: null, child_stored: null, evidence: 'explicit' });
  }

  const title = str(c.name ?? hv.name);
  const created = (hrow ? ms(hrow.createdAt) : null) ?? ms(c.createdAt) ?? ms(hv.createdAt);
  out.push({
    type: 'session',
    engine: null,
    client: 'cursor',
    harness_version: null,
    title: title || null,
    title_set_by: title ? 'unknown' : null,
    cwd: wsPath(hv.workspaceIdentifier) || wsPath(c.workspaceIdentifier) || null,
    last_cwd: null,
    created_at: isoOf(created),
    // `lastUpdatedAt` is volatile (a rename does not bump it) and is not read.
    updated_at: null,
    state: archived ? 'archived' : 'active',
    pinned: null,
    mode: str(c.unifiedMode || hv.unifiedMode) || null,
    // `kind` is the native session type, and a flag is not a kind: the header's `isSubagent`
    // leaves it null. The sub-agent fact is the parent's `subagent` link naming this chat (above;
    // a child names no parent). sessions-model v1.x proposal (#6), §2.1.
    kind: null,
    reuse: 'impossible',
    ts_source: 'event',
    aliases: [],
  });
  return { out, held };
}
