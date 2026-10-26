// Goose: `<data>/sessions/sessions.db`, one SQLite database (WAL) shared by every session of the
// harness store: `sessions` (one row per session), `messages` (one row per message, JSON columns)
// and `usage_ledger` (one row per LLM call). `harness_path` is `<data>`: `$GOOSE_PATH_ROOT/data`,
// else `$XDG_DATA_HOME/goose`, else `~/.local/share/goose` (adapter spec §1). sessions v1 four
// operations over sessions-model v1.1 records.
//
// Ported from memhouse's v4 normaliser (its goose module: the result claim by call id, the
// turn end by a later prompt, the ledger link by tokens and time, the copied-usage rule, id
// anchoring, part building, role / source / status, the compaction summary, the redaction of
// extensions, recipes and resource URIs). New here:
// - four sources per session, each a slice of the one database (`<db>#table:<name>`, sessions
//   §2): the `sessions` row as a snapshot, this session's `messages` and `usage_ledger` rows as
//   delta slices, and the store's first ledger row as a snapshot shared by every session, so that
//   the copied-usage rule needs no I/O in derive;
// - redaction in `read`, on the row-json, by declared paths: extension and recipe values in the
//   sessions row, MCP resource URIs in tool results;
// - records in the sessions-model shape: a tool result is its own `tool` message (the row goose
//   writes with role user), usage as its own records, compaction and archive lifecycle records,
//   subagent link statements on both sides;
// - the pending-call hold as derive `held`, for the waiting message (and its usage) only: memhouse
//   held every later row too, because its log was ordered by append;
// - `order` is the row's position in the harness's own load order, `(created_timestamp, id)`.
//
// The volatile sessions columns (updated_at, the last-call token columns, accumulated_*) are not
// read: they move without the transcript moving (kept after deletes, copied on forks).

import { SessionsError } from '../../errors.js';
import { isRealFile, jsonOf } from '../../sources.js';
import { openReadOnly, withRead, hasTable, readDelta, readRowsSnapshot, textOf } from '../../sqlite.js';
import { seal, recordKey } from '../../records.js';
import { sha256, jcs } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'goose';
const STATE_VER = 1;
export const DB_REL = 'sessions/sessions.db';
// The four sources of a session. The first-ledger source is not this session's rows: it is the
// store's first `usage_ledger` row (by id), which every session of the store shares.
export const SOURCE = Object.freeze({
  session: `${DB_REL}#table:sessions`,
  messages: `${DB_REL}#table:messages`,
  ledger: `${DB_REL}#table:usage_ledger`,
  first: `${DB_REL}#table:usage_ledger@first`,
});
const KIND_OF = Object.fromEntries(Object.entries(SOURCE).map(([k, v]) => [v, k]));

export function describe() {
  return describeData;
}

// ---- small helpers ----------------------------------------------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(textOf(v)));
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return v;
  try {
    return JSON.parse(textOf(v));
  } catch {
    return null;
  }
}

// Text timestamps without a zone are UTC (SQLite CURRENT_TIMESTAMP); archived_at is RFC 3339 with ns.
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
export function utcMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : null;
  const s = String(textOf(v)).trim();
  const m = TS_RE.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0);
  if (m[8] && m[8].toUpperCase() !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    const digits = m[8].replace(/[^0-9]/g, '');
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000;
  }
  return t;
}
const isoOf = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const secIso = (v) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? new Date(x * 1000).toISOString() : null;
};

// ---- redaction (sessions-model §4; the paths are declared in describe.js) -----------------------

function marker(v) {
  const n = typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
  return `<redacted len=${n}>`;
}
const isMarker = (v) => typeof v === 'string' && /^<redacted len=\d+>$/.test(v);
const hide = (v) => (v == null || isMarker(v) ? v : marker(v));
// Every value replaced, the keys kept in their stored order.
function hideValues(x) {
  if (Array.isArray(x)) return x.map(hide);
  if (isObj(x)) return Object.fromEntries(Object.keys(x).map((k) => [k, hide(x[k])]));
  return hide(x);
}
// A URL cut to scheme://host (its path and query can carry a token); anything else redacted.
function hideUrl(v) {
  if (v == null || isMarker(v)) return v;
  try {
    const u = new URL(String(v));
    if (u.host) return `${u.protocol}//${u.host}`;
  } catch {
    /* not a URL */
  }
  return marker(v);
}
// Extension fields kept as stored: names, descriptions, numbers, flags and env var NAMES (env_keys).
const EXT_SAFE = new Set(['type', 'name', 'display_name', 'description', 'timeout', 'bundled', 'cwd', 'env_keys', 'available_tools', 'enabled']);
function redactExtension(e) {
  if (!isObj(e)) return hide(e);
  const o = {};
  for (const k of Object.keys(e)) {
    const x = e[k];
    if (x == null) o[k] = x;
    else if (k === 'envs' || k === 'headers') o[k] = hideValues(x);
    else if (k === 'args') o[k] = Array.isArray(x) ? x.map(hide) : hide(x);
    else if (k === 'uri' || k === 'url') o[k] = hideUrl(x);
    else if (k === 'cmd') o[k] = typeof x === 'string' && !/\s/.test(x) ? x : hide(x);
    else o[k] = EXT_SAFE.has(k) ? x : hide(x);
  }
  return o;
}
// extension_data or recipe_json: every extension list, env and header maps anywhere, and in a
// recipe, sub-recipe `values` and parameter `default`s.
function redactExtensions(v, recipe = false, depth = 0) {
  if (depth > 32) return hide(v);
  if (Array.isArray(v)) return v.map((x) => redactExtensions(x, recipe, depth + 1));
  if (!isObj(v)) return v;
  // An extension config wherever it sits, not only in an `extensions` list: anything carrying a
  // command, its arguments, an env map or headers is redacted as an extension.
  if ('cmd' in v || 'args' in v || 'envs' in v || 'headers' in v) return redactExtension(v);
  const o = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x == null) o[k] = x;
    else if (k === 'extensions' && Array.isArray(x)) o[k] = x.map(redactExtension);
    else if (k === 'envs' || k === 'headers' || (recipe && k === 'values')) o[k] = hideValues(x);
    else if (recipe && k === 'default') o[k] = hide(x);
    else o[k] = redactExtensions(x, recipe, depth + 1);
  }
  return o;
}

// A JSON text column on a secret path: walked and re-serialised when a value was replaced, kept
// byte for byte when nothing was; withheld whole when it does not parse (it cannot be walked).
function redactJsonColumn(text, fn) {
  if (text == null) return { value: text, redacted: false };
  let tree;
  try {
    tree = JSON.parse(text);
  } catch {
    return { value: marker(String(text)), redacted: true };
  }
  const json = JSON.stringify(fn(tree));
  return json === JSON.stringify(tree) ? { value: text, redacted: false } : { value: json, redacted: true };
}

const SESSION_JSON = {
  extension_data: (t) => redactExtensions(t, false),
  recipe_json: (t) => redactExtensions(t, true),
  user_recipe_values_json: (t) => (isObj(t) ? hideValues(t) : hide(t)),
};
// The sessions unit `{sessions: [row]}`, redacted on its declared paths.
function redactSessionBody(body) {
  let redacted = false;
  const sessions = body.sessions.map((row) => {
    const out = { ...row };
    for (const [col, fn] of Object.entries(SESSION_JSON)) {
      if (out[col] == null) continue;
      const r = redactJsonColumn(String(out[col]), fn);
      out[col] = r.value;
      redacted ||= r.redacted;
    }
    return out;
  });
  return { row: { ...body, sessions }, redacted };
}

// A reference in a tool result (an MCP resource URI): a file: URI, a plain path and a Windows drive
// path stay; any other URI is cut to scheme://host, or redacted when it has no host.
function safeRef(v) {
  const s = str(v);
  if (!s || /^file:/i.test(s) || /^[A-Za-z]:[\\/]/.test(s) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return s;
  return hideUrl(s);
}

const damaged = (sourceKey, what) => new SessionsError('damaged', `${sourceKey}: ${what} does not parse`, [sourceKey]);

// A messages row: its JSON columns must parse (a committed row that does not is `damaged`, never an
// empty or a visible message), and resource URIs in tool results are cut.
function redactMessageRow(sourceKey) {
  return (row) => {
    let content;
    try {
      content = row.content_json == null ? null : JSON.parse(row.content_json);
    } catch {
      throw damaged(sourceKey, `messages.content_json of row ${row.id}`);
    }
    if (row.metadata_json != null) {
      try {
        JSON.parse(row.metadata_json);
      } catch {
        throw damaged(sourceKey, `messages.metadata_json of row ${row.id}`);
      }
    }
    if (!Array.isArray(content)) return { row, redacted: false };
    let redacted = false;
    const cut = (o, k) => {
      if (!isObj(o) || typeof o[k] !== 'string') return;
      const v = safeRef(o[k]);
      if (v !== o[k]) {
        o[k] = v;
        redacted = true;
      }
    };
    for (const p of content) {
      if (!isObj(p) || p.type !== 'toolResponse' || !isObj(p.toolResult)) continue;
      const v = p.toolResult.value;
      const items = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.content) ? v.content : [];
      for (const c of items) {
        if (!isObj(c)) continue;
        if (c.type === 'resource_link') cut(c, 'uri');
        else if (c.type === 'resource') cut(c.resource, 'uri');
      }
    }
    return redacted ? { row: { ...row, content_json: JSON.stringify(content) }, redacted: true } : { row, redacted: false };
  };
}

// ---- the database ------------------------------------------------------------------------------

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)));
}

// The sessions row's stable columns.
const SESSION_COLS = ['id', 'name', 'description', 'user_set_name', 'session_type', 'working_dir', 'created_at', 'archived_at',
  'provider_name', 'model_config_json', 'goose_mode', 'project_id', 'parent_session_id', 'schedule_id', 'recipe_json',
  'user_recipe_values_json', 'system_prompt_override', 'system_prompt_extras_json', 'container_id', 'extension_data'];
const MESSAGE_COLS = ['id', 'message_id', 'role', 'content_json', 'created_timestamp', 'metadata_json'];
const LEDGER_COLS = ['id', 'created_timestamp', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost', 'cost_source', 'is_compaction'];
const TEXT_COLS = new Set(['message_id', 'role', 'content_json', 'metadata_json', 'model', 'cost_source', ...SESSION_COLS.filter((c) => c !== 'user_set_name')]);

// A row reduced to the columns read, TEXT-or-BLOB columns as text.
function project(row, cols) {
  const o = {};
  for (const c of cols) {
    if (!(c in row)) continue;
    o[c] = row[c] instanceof Uint8Array && TEXT_COLS.has(c) ? textOf(row[c]) : row[c];
  }
  return o;
}

function sessionBody(row) {
  return { sessions: [project(row, SESSION_COLS)] };
}

// The store's first ledger row (by id: rows are inserted as calls end), or none when it keeps no
// ledger. Read by rowid, never by scanning the table.
function firstLedgerRows(db) {
  if (!hasTable(db, 'usage_ledger') || !columnsOf(db, 'usage_ledger').has('created_timestamp')) return [];
  return db.prepare('SELECT created_timestamp FROM usage_ledger ORDER BY id LIMIT 1').all();
}

// The list query: every sessions row with its change counts, each a per-session index lookup.
function listSql(db) {
  const per = (table, alias) => {
    const cols = hasTable(db, table) ? columnsOf(db, table) : new Set();
    if (!cols.has('session_id') || !cols.has('id')) return `0 AS mh_${alias}_n, NULL AS mh_${alias}_max, 0 AS mh_${alias}_len`;
    const len = ['metadata_json', 'content_json'].filter((c) => table === 'messages' && cols.has(c)).map((c) => `total(octet_length(x.${c}))`).join(' + ') || '0';
    return `(SELECT count(*) FROM ${table} x WHERE x.session_id = s.id) AS mh_${alias}_n,`
      + ` (SELECT max(x.id) FROM ${table} x WHERE x.session_id = s.id) AS mh_${alias}_max,`
      + ` (SELECT ${len} FROM ${table} x WHERE x.session_id = s.id) AS mh_${alias}_len`;
  };
  return `SELECT s.*, ${per('messages', 'msg')}, ${per('usage_ledger', 'led')} FROM sessions s`;
}

// ---- list -------------------------------------------------------------------------------------

// One entry per sessions row, with `created_at` as stored for its incarnation (reuse undetectable).
// `updated_hint` moves with the row's read columns, the message slice's count, max id and stored
// JSON size (an agentVisible flip in place changes it by one), the ledger slice's count and max id,
// and the store's first ledger row.
export function list(store) {
  const root = store.harness_path;
  // No database here, or one reached through a symlink: no sessions (read refuses it too).
  if (!isRealFile(root, DB_REL)) return [];
  const db = openReadOnly(root, DB_REL);
  try {
    return withRead(db, DB_REL, (d) => {
      if (!hasTable(d, 'sessions') || !columnsOf(d, 'sessions').has('id')) return [];
      const first = firstLedgerRows(d);
      return d.prepare(listSql(d)).all().map((r) => {
        const hint = [
          jcs(redactSessionBody(sessionBody(r)).row), num(r.mh_msg_n), num(r.mh_msg_max), num(r.mh_msg_len),
          num(r.mh_led_n), num(r.mh_led_max), jcs(first),
        ];
        return {
          session_id: str(r.id),
          incarnation: str(r.created_at),
          updated_hint: sha256(JSON.stringify(hint)).slice(0, 32),
          live: 'unknown',
          sources: [
            { source_key: SOURCE.messages, role: 'main', mode: 'delta', position_kind: 'rowid' },
            { source_key: SOURCE.session, role: 'side', mode: 'snapshot', position_kind: 'snapshot' },
            { source_key: SOURCE.ledger, role: 'side', mode: 'delta', position_kind: 'rowid' },
            { source_key: SOURCE.first, role: 'side', mode: 'snapshot', position_kind: 'snapshot' },
          ],
        };
      }).sort((a, b) => cmpStr(a.session_id, b.session_id) || cmpStr(a.incarnation, b.incarnation));
    });
  } finally {
    db.close();
  }
}

// ---- read -------------------------------------------------------------------------------------

// One source of one session, read in one transaction together with the session's own row, so a
// slice is never read for a session that is gone or reborn under the same id.
export function read(store, session, sourceKey, from = null, known = null) {
  const kind = KIND_OF[sourceKey];
  if (!kind) throw new SessionsError('source_unknown', `${sourceKey} is not a goose source`, [sourceKey]);
  const root = store.harness_path;
  const sid = String(session.session_id);
  if (!isRealFile(root, DB_REL)) throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
  const db = openReadOnly(root, DB_REL, sourceKey);
  try {
    return withRead(db, sourceKey, (d) => {
      const row = hasTable(d, 'sessions') ? d.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) : null;
      if (!row) throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
      if (str(row.created_at) !== (session.incarnation ?? '')) {
        throw new SessionsError('incarnation_gone', `session ${sid} is now the one created ${str(row.created_at)}`, [sid]);
      }
      if (kind === 'session') return readRowsSnapshot(sourceKey, sessionBody(row), from, { redact: redactSessionBody });
      if (kind === 'first') return readRowsSnapshot(sourceKey, { usage_ledger: firstLedgerRows(d) }, from);
      const table = kind === 'messages' ? 'messages' : 'usage_ledger';
      const cols = hasTable(d, table) ? columnsOf(d, table) : new Set();
      const want = (kind === 'messages' ? MESSAGE_COLS : LEDGER_COLS).filter((c) => cols.has(c));
      // A missing table (or one without the columns a slice needs) is the one gap read as empty.
      const usable = cols.has('session_id') && cols.has('id') && (kind === 'ledger' || cols.has('content_json'));
      const rows = usable
        ? d.prepare(`SELECT ${want.join(', ')} FROM ${table} WHERE session_id = ? ORDER BY id`).all(row.id)
          .map((r) => ({ unit_key: `${table}:${r.id}`, row: project(r, want) }))
        : [];
      return readDelta(sourceKey, rows, from, known, kind === 'messages' ? { redact: redactMessageRow(sourceKey) } : {});
    });
  } finally {
    db.close();
  }
}

// ---- derive -----------------------------------------------------------------------------------

function emptyState() {
  return {
    state_ver: STATE_VER,
    session: null, // the sessions unit, {sessions: [row]}
    first: null, // the first-ledger unit, {usage_ledger: [row]} (empty: the store keeps no ledger)
    messages: {}, // unit_key -> row
    ledger: {}, // unit_key -> row
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
  };
}
const noHeld = () => ({ session: [], message: [], usage: [], link: [], lifecycle: [] });

// The current rows of every source are kept, and the records are built from all of them on every
// derive: every goose rule is a whole-session function (the result claim, the turn end, the ledger
// link, the copied-usage rule). So any split of the units, in any source order, gives the same
// records, and `changed` is exactly what moved.
export function derive(session, input, state) {
  const st = state && state.state_ver === STATE_VER ? structuredClone(state) : emptyState();
  const key = {
    host: session.host, harness: HARNESS, harness_path: session.harness_path,
    session_id: session.session_id, incarnation: session.incarnation ?? '',
  };

  for (const src of input) {
    const kind = KIND_OF[src.source_key];
    const units = src.units ?? [];
    if (kind === 'messages' || kind === 'ledger') {
      if (src.complete) st[kind] = {};
      for (const k of src.gone ?? []) delete st[kind][k];
      for (const u of units) {
        const o = jsonOf(u);
        if (isObj(o)) st[kind][u.unit_key] = o;
        else delete st[kind][u.unit_key];
      }
    } else if (kind === 'session' || kind === 'first') {
      if (units.length) {
        const o = jsonOf(units[units.length - 1]);
        st[kind] = isObj(o) ? o : null;
      } else if (src.complete) st[kind] = null;
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

function prep(r) {
  const content = parseJson(r.content_json);
  const meta = parseJson(r.metadata_json);
  const m = isObj(meta) ? meta : {};
  return {
    rowid: Number(r.id) || 0,
    mid: r.message_id == null || r.message_id === '' ? null : str(r.message_id),
    role: str(r.role),
    cts: Number(r.created_timestamp) || 0,
    ts: secIso(r.created_timestamp),
    parts: Array.isArray(content) ? content : [],
    meta: m,
    // goose's MessageMetadata defaults both flags to true.
    U: m.userVisible !== false,
    A: m.agentVisible !== false,
  };
}
const only = (r, types) => r.parts.length > 0 && r.parts.every((p) => isObj(p) && types.includes(p.type));
const firstText = (r) => {
  const p = r.parts.find((x) => isObj(x) && x.type === 'text');
  return p ? str(p.text) : '';
};

// The compaction summary: role user, hidden from the user, a provider id (or the summary heading).
// Not keyed on agentVisible: a later compaction flips an earlier summary to false in place.
function isSummary(r) {
  if (r.role !== 'user' || r.U || r.meta.turnContext || r.meta.steer || !only(r, ['text'])) return false;
  return (!!r.mid && !/^(msg_|steer_)/.test(r.mid)) || /^# Conversation Summary\b/.test(firstText(r));
}
// A prompt the user typed (or goose sent as the user's turn): it ends whatever turn came before.
function isPrompt(r) {
  return r.role === 'user' && r.U && !r.meta.steer && !r.meta.turnContext && only(r, ['text', 'image']);
}
function deliveredOf(meta) {
  const ops = isObj(meta.operations) ? meta.operations : {};
  const d = isObj(ops.foreground_subagent) ? ops.foreground_subagent.delivered : null;
  return (Array.isArray(d) ? d : d == null ? [] : [d]).map(str).filter(Boolean);
}

function attachment(partId, mime, data) {
  const ok = typeof data === 'string' && data !== '';
  return { part_id: partId, kind: 'attachment', media_type: str(mime) || null, inline: ok ? data : null, bytes_len: ok ? Buffer.from(data, 'base64').length : null };
}

// A toolResponse's result: output text, error flag, exit code, and its binary items as attachments.
function resultOf(resp, partId) {
  const tr = resp && resp.toolResult;
  const files = [];
  if (!isObj(tr)) return { output: '', isError: false, exit: null, files };
  if (tr.status === 'error') {
    const e = tr.error ?? tr.value;
    return { output: typeof e === 'string' ? e : isObj(e) && typeof e.message === 'string' ? e.message : JSON.stringify(e ?? null), isError: true, exit: null, files };
  }
  const v = tr.value;
  const content = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.content) ? v.content : [];
  const text = [];
  content.forEach((c, k) => {
    if (!isObj(c)) return;
    if (c.type === 'text') text.push(str(c.text));
    else if (c.type === 'image' || c.type === 'audio') files.push(attachment(`${partId}:${c.type}:${k}`, c.mimeType, c.data));
    else if (c.type === 'resource_link') text.push(`[resource_link ${str(c.uri)}]`);
    else if (c.type === 'resource') {
      const r = isObj(c.resource) ? c.resource : {};
      if (typeof r.text === 'string') text.push(r.text);
      else if (typeof r.blob === 'string') files.push(attachment(`${partId}:resource:${k}`, r.mimeType, r.blob));
      else text.push(`[resource ${str(r.uri)}]`);
    } else text.push(`[${str(c.type)}]`);
  });
  const sc = isObj(v) && isObj(v.structuredContent) ? v.structuredContent : null;
  const exit = sc && Number.isFinite(sc.exit_code) ? sc.exit_code : null;
  return { output: text.join('\n'), isError: !!(isObj(v) && v.isError === true), exit, files };
}

const DECLINED = /^The user has declined to run this tool/;
const INTERRUPTED = /^Tool call was interrupted before completing/;
function toolStatus(res, permission) {
  if (INTERRUPTED.test(res.output)) return 'cancelled';
  if (permission === 'cancel') return 'cancelled';
  if (permission === 'deny_once' || permission === 'always_deny' || DECLINED.test(res.output)) return 'denied';
  if (res.isError && res.output === '(no output)' && res.exit === null) return 'cancelled'; // Ctrl-C during a shell call
  return 'completed';
}

function actionText(d) {
  if (!isObj(d)) return '[actionRequired]';
  const t = str(d.actionType);
  switch (t) {
    case 'toolConfirmation': return `[toolConfirmation] ${str(d.toolName)} ${JSON.stringify(d.arguments ?? {})}${d.prompt ? `\n${str(d.prompt)}` : ''}`;
    case 'toolConfirmationResponse': return `[toolConfirmationResponse] ${str(d.permission)}`;
    case 'elicitation': return `[elicitation] ${str(d.message)}${d.requested_schema ? `\n${JSON.stringify(d.requested_schema)}` : ''}`;
    case 'elicitationResponse': return `[elicitationResponse] ${str(d.action)} ${JSON.stringify(d.user_data ?? null)}`;
    default: return `[${t || 'actionRequired'}]`;
  }
}

function usageFields(u) {
  return { input: num(u.input), output: num(u.output), cache_read: num(u.cache_read), cache_write: num(u.cache_write), reasoning: null, cost: num(u.cost), input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_response' };
}
const ledgerTokens = (l) => usageFields({ input: l.input_tokens, output: l.output_tokens, cache_read: l.cache_read_tokens, cache_write: l.cache_write_tokens, cost: l.cost });
const metaTokens = (u) => usageFields({ input: u.inputTokens, output: u.outputTokens, cache_read: u.cacheReadTokens, cache_write: u.cacheWriteTokens, cost: u.cost });

// Every record of the session, built from the current rows of all four sources, and the keys held
// as incomplete. Messages come in the harness's load order; the session record is last.
function build(st, key) {
  const out = [];
  const held = noHeld();
  const srow = st.session && Array.isArray(st.session.sessions) ? st.session.sessions[0] : null;
  if (!isObj(srow)) return { out, held };
  const kind = str(srow.session_type);
  const mc = parseJson(srow.model_config_json);
  const rp = isObj(mc) && isObj(mc.request_params) ? mc.request_params : {};
  const effort = rp.thinking_effort == null ? null : str(rp.thinking_effort) || null;
  const self = { harness: HARNESS, session_id: key.session_id, ...(key.incarnation ? { incarnation: key.incarnation } : {}) };

  // The harness's own load order: ORDER BY created_timestamp, id.
  const rows = Object.values(st.messages).map(prep).sort((a, b) => (a.cts - b.cts) || (a.rowid - b.rowid));
  const pk = (i, j) => `${i}:${j}`;

  // Results and confirmations by call id; each call claims the first unclaimed result after it
  // (else the first unclaimed one at all: same-second rows can sort against causality).
  const responses = new Map();
  const permission = new Map();
  rows.forEach((r, i) => r.parts.forEach((p, j) => {
    if (!isObj(p)) return;
    if (p.type === 'toolResponse' && p.id != null) {
      const id = str(p.id);
      if (!responses.has(id)) responses.set(id, []);
      responses.get(id).push({ i, j, part: p });
    } else if (p.type === 'actionRequired' && isObj(p.data) && p.data.actionType === 'toolConfirmationResponse' && p.data.id != null) {
      permission.set(str(p.data.id), str(p.data.permission));
    }
  }));
  const claim = new Map(); // call pk -> {i, j, part}
  const claimedBy = new Map(); // result pk -> call_id
  const callIds = new Map(); // call pk -> call_id
  const seenCall = new Map();
  rows.forEach((r, i) => r.parts.forEach((p, j) => {
    if (!isObj(p) || p.type !== 'toolRequest' || p.id == null) return;
    const native = str(p.id);
    // A native call id repeated in one session (a provider that numbers calls per reply) keeps the
    // pairs apart: the n-th repeat is `<id>+n`, on the call and on the result it claims.
    const n = seenCall.get(native) ?? 0;
    seenCall.set(native, n + 1);
    const callId = n ? `${native}+${n}` : native;
    callIds.set(pk(i, j), callId);
    const cands = responses.get(native) || [];
    const hit = cands.find((c) => c.i > i && !claimedBy.has(pk(c.i, c.j))) || cands.find((c) => !claimedBy.has(pk(c.i, c.j)));
    if (hit) {
      claimedBy.set(pk(hit.i, hit.j), callId);
      claim.set(pk(i, j), hit);
    }
  }));

  // Whether a user prompt follows each row: the turn it belongs to has ended.
  const promptAfter = new Array(rows.length).fill(false);
  for (let i = rows.length - 1, seen = false; i >= 0; i--) {
    promptAfter[i] = seen;
    if (isPrompt(rows[i])) seen = true;
  }

  // Ledger rows -> the assistant row of the same call: equal input / output / cache-read counts,
  // written at the call's end (within elapsedMs of the row's time, the row being the first token).
  const ledger = Object.values(st.ledger).map((l) => ({ ...l, lid: Number(l.id) || 0, lts: Number(l.created_timestamp) || 0 }))
    .sort((a, b) => (a.lts - b.lts) || (a.lid - b.lid));
  const used = new Set();
  const linked = new Map();
  const same = (a, b) => (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));
  const fits = (a, b) => a == null || b == null || Number(a) === Number(b);
  const spanOf = (u) => {
    const el = Number(u.elapsedMs);
    return Number.isFinite(el) && el >= 0 ? Math.ceil(el / 1000) + 2 : 900;
  };
  rows.forEach((r, i) => {
    const u = r.meta.usage;
    if (r.role !== 'assistant' || !isObj(u)) return;
    const span = spanOf(u);
    const hit = ledger.find((l) => !used.has(l.lid) && !Number(l.is_compaction) && same(l.input_tokens, u.inputTokens) && same(l.output_tokens, u.outputTokens)
      && fits(l.cache_read_tokens, u.cacheReadTokens) && l.lts >= r.cts - 1 && l.lts <= r.cts + span);
    if (hit) {
      used.add(hit.lid);
      linked.set(i, hit);
    }
  });
  // The copied-usage rule. A fork or an import copies rows with their metadata.usage, never the
  // ledger. In a store that keeps a ledger, an assistant row with metadata.usage and no ledger row
  // of its own, whose call ended at or after the store's first ledger row, is such a copy: it gets
  // no usage record, so the call is billed once, in the session that made it. A store with no
  // ledger (older goose), and calls that ended before its first ledger row, keep metadata.usage.
  const firstRow = st.first && Array.isArray(st.first.usage_ledger) ? st.first.usage_ledger[0] : null;
  const since = isObj(firstRow) ? num(firstRow.created_timestamp) : null;
  const copied = (r, i) => since !== null && r.role === 'assistant' && isObj(r.meta.usage) && !linked.has(i) && r.cts + spanOf(r.meta.usage) >= since;

  // Message ids: native; anchored on the previous native id where NULL (`<anchor>+n`); a native id
  // repeated in the session is `<id>+n`. Neither form takes an id already given.
  const usedIds = new Set();
  const seenIds = new Map();
  const fresh = (base, n0) => {
    let n = n0;
    while (usedIds.has(`${base}+${n}`)) n += 1;
    return n;
  };
  let anchor = '';
  let anchorN = 0;
  let firstId = null;
  let lastId = null;
  const summaries = []; // [cts, lifecycle_id] of each compaction, in order
  const children = [];

  rows.forEach((r, i) => {
    let id;
    if (r.mid) {
      const n = seenIds.get(r.mid) ?? 0;
      seenIds.set(r.mid, n + 1);
      id = n || usedIds.has(r.mid) ? `${r.mid}+${fresh(r.mid, Math.max(n, 1))}` : r.mid;
      anchor = r.mid;
      anchorN = 0;
    } else {
      const base = anchor || '@start';
      anchorN = fresh(base, anchorN + 1);
      id = `${base}+${anchorN}`;
    }
    usedIds.add(id);

    const reqs = r.parts.map((p, j) => (isObj(p) && p.type === 'toolRequest' ? j : -1)).filter((j) => j >= 0);
    const pending = reqs.some((j) => !claim.has(pk(i, j)));
    // A tool still running, in a turn no later prompt has ended: held, with its usage.
    const isHeld = pending && !promptAfter[i];
    const summary = isSummary(r);
    const order = String(i).padStart(8, '0');

    const mainParts = [];
    const toolParts = [];
    let hasError = false;
    r.parts.forEach((p, j) => {
      if (!isObj(p)) return;
      const pid = String(j);
      switch (p.type) {
        case 'text':
          mainParts.push(summary
            ? { part_id: pid, kind: 'summary', text: str(p.text), replaces: { flags: { agentVisible: false } } }
            : { part_id: pid, kind: 'text', text: str(p.text) });
          break;
        case 'image':
          mainParts.push(attachment(pid, p.mimeType, p.data));
          break;
        case 'thinking': {
          const t = str(p.thinking);
          const sig = typeof p.signature === 'string' && p.signature ? p.signature.length : null;
          if (t) mainParts.push({ part_id: pid, kind: 'reasoning', text: t, signature_len: sig });
          else if (sig) mainParts.push({ part_id: pid, kind: 'reasoning', opaque: true, signature_len: sig });
          break;
        }
        case 'redactedThinking':
          mainParts.push({ part_id: pid, kind: 'reasoning', opaque: true, signature_len: typeof p.data === 'string' ? p.data.length : null });
          break;
        case 'toolRequest': {
          const tc = isObj(p.toolCall) ? p.toolCall : {};
          const v = isObj(tc.value) ? tc.value : {};
          const meta = isObj(p._meta) ? p._meta : {};
          mainParts.push({
            part_id: pid, kind: 'tool_call', call_id: callIds.get(pk(i, j)) ?? `@${id}:${j}`, name: str(v.name) || 'unknown',
            args: isObj(v.arguments) || Array.isArray(v.arguments) ? v.arguments : v.arguments == null ? {} : { raw: v.arguments },
            server: meta.goose_extension ? str(meta.goose_extension) : null,
          });
          // A call the provider sent malformed: goose stores the parse error in place of the call.
          if (tc.status === 'error') {
            hasError = true;
            mainParts.push({ part_id: `${pid}:error`, kind: 'error', error_kind: 'tool_call', message: str(isObj(tc.error) ? tc.error.message : tc.error), http_status: null });
          }
          break;
        }
        case 'toolResponse': {
          const res = resultOf(p, pid);
          const status = toolStatus(res, permission.get(str(p.id)));
          toolParts.push({
            part_id: pid, kind: 'tool_result', call_id: claimedBy.get(pk(i, j)) ?? (p.id != null ? str(p.id) : `@${id}:${j}`),
            // `is_error` is the harness store's own flag, `isError` (sessions-model v1.x (#6), §2.3).
            // A flag that says success beside a shell's non-zero `exit_code` is unreliable for that
            // result: its `is_error` is null, and the other results keep the flag. It describes a
            // call that completed: a declined (`denied`) or an interrupted (`cancelled`) call's is
            // null, whatever `isError` says, and the status carries the fact.
            is_error: status !== 'completed' || (!res.isError && Number.isInteger(res.exit) && res.exit !== 0) ? null : res.isError,
            status, output: res.output,
            output_len: Buffer.byteLength(res.output, 'utf8'), truncated: null,
            // `structuredContent.exit_code`, kept apart from the content text, never parsed out of it.
            exit_code: Number.isInteger(res.exit) ? res.exit : null,
          });
          toolParts.push(...res.files);
          break;
        }
        case 'actionRequired':
          mainParts.push({ part_id: pid, kind: 'notice', text: actionText(p.data), level: null, native_type: isObj(p.data) ? str(p.data.actionType) || null : null });
          break;
        case 'error':
          hasError = true;
          mainParts.push({ part_id: pid, kind: 'error', error_kind: str(p.kind) || null, message: str(p.message), http_status: null });
          break;
        case 'systemNotification':
          mainParts.push({ part_id: pid, kind: 'notice', text: str(p.msg), level: null, native_type: str(p.notificationType) || 'systemNotification' });
          break;
        default:
          mainParts.push({ part_id: pid, kind: 'notice', text: `[${str(p.type)}]${typeof p.text === 'string' ? ` ${p.text}` : ''}`, level: null, native_type: str(p.type) || null });
      }
    });

    const inf = isObj(r.meta.inference) ? r.meta.inference : null;
    const l = linked.get(i) || null;
    const message = (messageId, ord, role, source, status, parts) => ({
      type: 'message', message_id: messageId, parent_id: null, order: ord, agent_id: '', role, source,
      to_user: r.U, to_model: r.A, status, state: 'current', on_active_branch: null, ts: r.ts,
      requested_model: null, served_model: null, effort: null, response_id: null, aliases: [], parts,
    });
    const msgs = [];
    // One speaker per message: goose writes tool results as role-user rows, which are `tool`
    // messages. A row with both kinds keeps its id on the rest; its results are `<id>:tool`.
    const split = mainParts.length > 0 && toolParts.length > 0;
    if (mainParts.length || !toolParts.length) {
      let role = r.role === 'assistant' ? 'assistant' : 'user';
      let source;
      if (summary) {
        role = 'system';
        source = 'automated';
      } else if (r.meta.turnContext) source = 'injected';
      else if (r.meta.steer) source = 'steering';
      else if (role === 'assistant') {
        if (!r.U && !inf && only(r, ['text'])) source = 'injected'; // compaction continuation
        else source = inf ? 'model' : 'system_notice'; // a reply; or goose's own line (an error, a confirmation, "Compaction complete")
      } else if (!r.U && deliveredOf(r.meta).length) source = 'injected'; // sub-agent completion
      else if (!r.U && only(r, ['text'])) source = 'automated'; // goal nudge, compaction replay of the prompt
      else if (isPrompt(r) && (kind === 'sub_agent' || kind === 'scheduled')) source = 'automated';
      else source = 'user';
      let status = 'complete';
      if (hasError) status = 'error';
      else if (pending) status = 'interrupted';
      else if (r.role === 'assistant' && (r.meta.outputTokenLimitReached || (inf && !isObj(r.meta.usage) && !l))) status = 'interrupted';
      const m = message(id, order, role, source, status, mainParts);
      if (role === 'assistant' && inf) {
        m.requested_model = str(inf.requestedModel) || null;
        m.served_model = (l && str(l.model)) || str(inf.resolvedModel) || null;
        m.effort = effort;
        // goose keeps the provider's completion id as the message id; `msg_` ids are its own.
        m.response_id = r.mid && !/^msg_/.test(r.mid) ? r.mid : null;
      }
      msgs.push(m);
    }
    if (toolParts.length) {
      msgs.push(message(split ? `${id}:tool` : id, split ? `${order}.1` : order, 'tool', null, 'complete', toolParts));
    }

    // Usage: the linked ledger row (authoritative), else metadata.usage, unless the row is a copy.
    const usage = [];
    if (r.role === 'assistant' && msgs[0].role === 'assistant') {
      if (l) {
        usage.push({ type: 'usage', usage_id: str(l.id), anchor: { message_id: id }, ...ledgerTokens(l), model: str(l.model) || null });
      } else if (isObj(r.meta.usage) && !copied(r, i)) {
        usage.push({ type: 'usage', usage_id: `message:${id}#1`, anchor: { message_id: id }, ...metaTokens(r.meta.usage), model: inf ? str(inf.resolvedModel) || null : null });
      }
    }

    if (summary) {
      out.push({
        type: 'lifecycle', lifecycle_id: id, op: 'compaction',
        target: firstId && lastId ? { range: { from_id: firstId, through_id: lastId } } : { session: true },
        at: null, ts: r.ts, evidence: 'explicit',
      });
      summaries.push([r.cts, id]);
    }
    if (isHeld) {
      for (const m of msgs) held.message.push(m.message_id);
      for (const u of usage) held.usage.push(u.usage_id);
    } else {
      out.push(...msgs, ...usage);
    }
    if (!firstId) firstId = msgs[0].message_id;
    lastId = msgs[msgs.length - 1].message_id;
    for (const c of deliveredOf(r.meta)) if (!children.includes(c)) children.push(c);
  });

  // Ledger rows no message carries: compaction calls, and calls whose messages are gone (/clear and
  // truncate delete rows, goose keeps the ledger). A compaction call is anchored to the compaction
  // whose summary precedes it.
  for (const l of ledger) {
    if (used.has(l.lid)) continue;
    let anchorOf = { session: true };
    if (Number(l.is_compaction)) {
      const c = summaries.filter(([cts]) => cts <= l.lts).pop();
      if (c) anchorOf = { compaction: c[1] };
    }
    out.push({ type: 'usage', usage_id: str(l.id), anchor: anchorOf, ...ledgerTokens(l), model: str(l.model) || null });
  }

  // Archive: `archived_at` set (RFC 3339 with ns), cleared on unarchive. The record has no native
  // id, so it is keyed on the sessions unit.
  const archivedRaw = srow.archived_at == null || srow.archived_at === '' ? null : srow.archived_at;
  if (archivedRaw !== null) {
    out.push({
      type: 'lifecycle', lifecycle_id: `${SOURCE.session}@${SOURCE.session}#1`, op: 'archive', target: { session: true },
      at: null, ts: isoOf(utcMs(archivedRaw)), evidence: 'explicit',
    });
  }

  // Sub-agents: the child states its parent (`parent_session_id`); the parent states each child it
  // was delivered from (`operations.foreground_subagent.delivered`). Neither names the call.
  const parent = str(srow.parent_session_id);
  if (parent) {
    out.push({ type: 'link', kind: 'subagent', stated_on: 'child', child: self, origin: { harness: HARNESS, session_id: parent }, at: '', inherits: null, child_stored: true, evidence: 'explicit' });
  }
  for (const c of children) {
    out.push({ type: 'link', kind: 'subagent', stated_on: 'origin', child: { harness: HARNESS, session_id: c }, origin: self, at: '', inherits: null, child_stored: null, evidence: 'explicit' });
  }

  const name = str(srow.name);
  const setBy = srow.user_set_name == null ? 'unknown' : Number(srow.user_set_name) ? 'user' : 'auto';
  out.push({
    type: 'session',
    engine: null,
    client: 'goose',
    harness_version: null,
    title: name || null,
    title_set_by: name ? setBy : null,
    cwd: str(srow.working_dir) || null,
    last_cwd: null,
    created_at: isoOf(utcMs(srow.created_at)),
    // `updated_at` is volatile (it moves without the transcript moving) and is not read.
    updated_at: null,
    state: archivedRaw !== null ? 'archived' : 'active',
    pinned: null,
    mode: str(srow.goose_mode) || null,
    kind: kind || null,
    reuse: 'undetectable',
    ts_source: 'seconds',
    aliases: [],
  });
  return { out, held };
}
