// Devin Local: the Rust CLI (`devin acp`) that Devin Desktop (the Windsurf app) runs over ACP. It
// keeps every session of the harness store in one SQLite database (WAL), `<data>/sessions.db`,
// where
// `harness_path` is the CLI data folder (`~/.local/share/devin/cli`; Devin Desktop's own app folder
// is another harness store). sessions v1 four operations over sessions-model v1.1 records.
//
// The store (the adapter spec, in the fixture captures, synthetic, captured
// 2026-10-20 on a test VM: Windsurf / Devin Desktop 3.10.67; Devin Local 3000.10.67):
// - `sessions`: one row per session; `id` is a two-word slug; `main_chain_id` names the tip of the
//   current conversation; `hidden` marks the summary-agent session a fork spawns;
// - `message_nodes`: a node tree, `(node_id, parent_node_id, chat_message JSON, metadata JSON)`.
//   Every save deletes and re-inserts all of the session's nodes, so `row_id` and the row's
//   `created_at` change on every turn; `node_id` and `chat_message.message_id` are stable;
// - `tool_call_state`: one row per call with its final ACP update;
// - `subagent_heads`: a running sub-agent's chain tip.
//
// Ported from memhouse's v4 normaliser (its devin module: the walk from main_chain_id, the
// compaction hoist, the twin and prefix-copy dedupe, the context / prompt / tool rules, the holds,
// the sub-agent chains, the abandoned-branch search). New here:
// - ONE source, `sessions.db#table:message_nodes`: main, snapshot, a `rows-json` unit of the
//   session's row, nodes, tool states and sub-agent heads, read in one transaction (sessions
//   §1). Per-table deltas would split the pointer from the nodes across reads;
// - only the main line itself tears a read (sessions v1.x (#6), §2 `inconsistent`): a dangling
//   main_chain_id, or a parent link along the line, is the retryable `inconsistent`, found in
//   `read`, never an empty or shorter session. A node the main line only names (a running
//   sub-agent's head in `subagent_heads`, a compacted history's prior nodes, a sub-agent chain a
//   tool result names) that the read does not hold is no torn read: derive leaves out what it would
//   have reached, holds what an earlier derive wrote of it, and a later read that holds the node
//   derives it;
// - records in the sessions-model shape: a tool node is its own `tool` message; usage records; a
//   rewind is implicit (a pointer move), so it gives no lifecycle record: the abandoned subtree's
//   messages stay, with `on_active_branch: false`. Compaction is explicit, from the summary node;
// - the holds (a tail reply whose call has no result, a tail reply its row marks unfinished) are
//   derive `held`.

import { SessionsError } from '../../errors.js';
import { isRealFile, jsonOf } from '../../sources.js';
import { openReadOnly, withRead, hasTable, readRowsSnapshot, textOf } from '../../sqlite.js';
import { seal, recordKey } from '../../records.js';
import { sha256, jcs } from '../../jcs.js';
import { describe as describeData } from './describe.js';

export const HARNESS = 'devin';
const STATE_VER = 1;
export const DB_REL = 'sessions.db';
export const SOURCE = `${DB_REL}#table:message_nodes`;
const INTERRUPTED = /^\s*\[Response interrupted by user\]\s*$/;

export function describe() {
  return describeData;
}

// ---- small helpers ----------------------------------------------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(textOf(v)));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : null);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pad = (n, w) => String(n).padStart(w, '0');

// RFC 3339 with nanoseconds (chat_message.metadata.created_at) to ISO 8601 UTC with milliseconds.
function isoTs(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
// sessions.created_at is epoch seconds.
function secIso(v) {
  const x = num(typeof v === 'string' ? Number(v) : v);
  return x != null && x > 0 ? new Date(x < 1e11 ? x * 1000 : x).toISOString() : null;
}

function textOfContent(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : isObj(b) && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}
function argsOf(a) {
  if (a == null) return {};
  if (typeof a === 'string') {
    try {
      return JSON.parse(a);
    } catch {
      return { raw: a };
    }
  }
  return a;
}

const damaged = (what) => new SessionsError('damaged', `${SOURCE}: ${what}`, [SOURCE]);
const torn = (what, id) => new SessionsError('inconsistent', `${SOURCE}: ${what} points at node ${id}, which this read does not hold (a save in progress)`, [SOURCE]);

// A stored JSON column. Devin writes them with serde, so one that does not parse is a damaged row:
// never a dropped node, which would derive fewer messages.
function jsonCol(v, what, nullable = true) {
  if (v == null) {
    if (nullable) return null;
    throw damaged(`${what} is missing`);
  }
  let o;
  try {
    o = JSON.parse(String(textOf(v)));
  } catch {
    throw damaged(`${what} does not parse`);
  }
  if (o == null && !nullable) throw damaged(`${what} is null`);
  if (o != null && !isObj(o)) throw damaged(`${what} is not an object`);
  return o;
}

// ---- the database ------------------------------------------------------------------------------

// The columns read. Left out: sessions.last_activity_at, metadata (running credit totals, a client
// tab id), cogs_json and shell_last_seen_index, which move without the conversation moving; the
// nodes' row_id and created_at, reset on every save; tool_call_state.tool_call_json (the initial
// ACP
// event, whose rawInput repeats the call's arguments); subagent_heads.updated_at.
const SESSION_COLS = ['id', 'working_directory', 'backend_type', 'model', 'agent_mode', 'created_at', 'title', 'main_chain_id', 'workspace_dirs', 'hidden'];
const NODE_COLS = ['node_id', 'parent_node_id', 'chat_message', 'metadata'];
const STATE_COLS = ['tool_call_id', 'tool_call_update_json'];
const HEAD_COLS = ['agent_id', 'chain_node_id'];
const INT_COLS = new Set(['created_at', 'main_chain_id', 'hidden', 'node_id', 'parent_node_id', 'chain_node_id']);

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)));
}

// A row reduced to the columns read; TEXT-or-BLOB columns as text.
function project(row, cols) {
  const o = {};
  for (const c of cols) {
    if (!(c in row)) continue;
    const v = row[c];
    o[c] = v instanceof Uint8Array && !INT_COLS.has(c) ? textOf(v) : typeof v === 'bigint' ? Number(v) : v;
  }
  return o;
}

// One table's rows of this session, or none when an older store lacks the table (the one schema gap
// that reads as empty).
function slice(d, table, wanted, order, sid) {
  if (!hasTable(d, table)) return [];
  const cols = columnsOf(d, table);
  if (!cols.has('session_id')) return [];
  const want = wanted.filter((c) => cols.has(c));
  return d.prepare(`SELECT ${want.join(', ')} FROM ${table} WHERE session_id = ? ORDER BY ${order}`).all(sid).map((r) => project(r, want));
}

// The session's whole unit body, `{sessions, message_nodes, tool_call_state, subagent_heads}`, each
// table's rows in key order (nodes by node_id: their row_id is re-minted on every save).
function sessionBody(d, sid) {
  if (!hasTable(d, 'sessions')) return null;
  const scols = columnsOf(d, 'sessions');
  const want = SESSION_COLS.filter((c) => scols.has(c));
  const row = d.prepare(`SELECT ${want.join(', ')} FROM sessions WHERE id = ?`).get(sid);
  if (!row) return null;
  return {
    sessions: [project(row, want)],
    message_nodes: slice(d, 'message_nodes', NODE_COLS, 'node_id', sid),
    tool_call_state: slice(d, 'tool_call_state', STATE_COLS, 'tool_call_id', sid),
    subagent_heads: slice(d, 'subagent_heads', HEAD_COLS, 'agent_id', sid),
  };
}

// The list query: every sessions row with its change counts, each a per-session index lookup. The
// node counts use node_id and the stored sizes, never row_id, so a save that re-inserts unchanged
// nodes leaves the hint where it was.
function listSql(d, sessionCols) {
  const sel = sessionCols.map((c) => `s.${c}`).join(', ');
  const per = (table, alias, exprs) => {
    const cols = hasTable(d, table) ? columnsOf(d, table) : new Set();
    if (!cols.has('session_id')) return exprs.map((_, i) => `NULL AS dv_${alias}_${i}`).join(', ');
    return exprs.map((x, i) => `(SELECT ${x} FROM ${table} x WHERE x.session_id = s.id) AS dv_${alias}_${i}`).join(', ');
  };
  const nodeCols = hasTable(d, 'message_nodes') ? columnsOf(d, 'message_nodes') : new Set();
  const len = ['chat_message', 'metadata'].filter((c) => nodeCols.has(c)).map((c) => `total(octet_length(x.${c}))`).join(' + ') || '0';
  return `SELECT ${sel}, ${per('message_nodes', 'n', ['count(*)', 'max(x.node_id)', len])},`
    + ` ${per('tool_call_state', 't', ['count(*)', 'max(x.rowid)', 'total(octet_length(x.tool_call_update_json))'])},`
    + ` ${per('subagent_heads', 'h', ['count(*)', 'max(x.rowid)', 'total(x.chain_node_id)'])} FROM sessions s`;
}

// ---- the tree ----------------------------------------------------------------------------------

// The unit body parsed: nodes by node_id, tool states by call id, sub-agent heads. A JSON column
// that does not parse is `damaged`.
function treeOf(body) {
  const row = Array.isArray(body?.sessions) && isObj(body.sessions[0]) ? body.sessions[0] : null;
  const nodes = new Map();
  for (const r of body?.message_nodes ?? []) {
    const id = num(r.node_id);
    if (id == null || !Number.isInteger(id)) throw damaged(`a node id that is not an integer (${r.node_id})`);
    const cm = jsonCol(r.chat_message, `chat_message of node ${id}`, false);
    const nm = jsonCol(r.metadata, `metadata of node ${id}`);
    const md = isObj(cm.metadata) ? cm.metadata : {};
    nodes.set(id, {
      id,
      parent: r.parent_node_id == null ? null : num(r.parent_node_id),
      mid: cm.message_id == null ? '' : String(cm.message_id),
      role: str(cm.role),
      cm,
      md,
      ext: isObj(md.extensions) ? md.extensions : {},
      nm: nm || {},
    });
  }
  const states = new Map();
  for (const s of body?.tool_call_state ?? []) {
    if (s.tool_call_id != null) states.set(str(s.tool_call_id), jsonCol(s.tool_call_update_json, `tool_call_state ${s.tool_call_id}`) || {});
  }
  const heads = (body?.subagent_heads ?? []).filter((h) => h.chain_node_id != null).map((h) => ({ agent_id: str(h.agent_id), node: num(h.chain_node_id) }));
  return { row, nodes, states, heads };
}

const isPrefix = (n) => n.nm.is_system_prefix === true;
const isKeepalive = (n) => (isObj(n.md.telemetry) && n.md.telemetry.source === 'cache_keepalive') || n.ext['barista/prompt_cache_footer'] === true;
const sumFrom = (n) => (n.nm.summarized_from == null ? null : num(n.nm.summarized_from));
const isContent = (n) => n.role !== 'tool' && !isPrefix(n) && !isKeepalive(n);
const isInterrupt = (n) => n.role === 'system' && INTERRUPTED.test(textOfContent(n.cm.content));
const callsOf = (n) => (Array.isArray(n.cm.tool_calls) ? n.cm.tool_calls.filter((c) => isObj(c) && c.id != null) : []);
const callOf = (n) => (n.role === 'tool' && n.cm.tool_call_id != null ? String(n.cm.tool_call_id) : null);

// The chain ending at `id`, root first. A pointer to a node this read does not hold is a torn view
// (`inconsistent`); a chain that loops cannot be a committed tree (`damaged`).
function walk(t, id, what) {
  const out = [];
  const seen = new Set();
  let n = t.nodes.get(id);
  if (!n) throw torn(what, id);
  for (;;) {
    if (seen.has(n.id)) throw damaged(`the node tree loops at node ${n.id}`);
    seen.add(n.id);
    out.push(n);
    if (n.parent == null) break;
    const p = t.nodes.get(n.parent);
    if (!p) throw torn(`${what} (through node ${n.id})`, n.parent);
    n = p;
  }
  return out.reverse();
}

// The emission plan: the current line from main_chain_id, compacted histories hoisted in front
// (the first one before the whole chain, so the line only grows), each sub-agent chain right after
// the message that started it. An item is a node with its agent, whether it may be held, whether
// it is its line's tail (no content follows), the next content entry, and its line's results by
// call id; or a compaction marker. `read` runs it as the closure check. Only the main line itself
// (its head and the parent links along it) must resolve: a pointer there that this read cannot
// follow is `inconsistent`. A node the main line only names (a compacted history's prior nodes, a
// sub-agent chain a tool result names) that the read does not hold whole tears nothing: that piece
// is left out of the plan, and `torn` says so (sessions v1.x (#6), §2 `inconsistent`). A loop is
// still damaged. `{items, torn, tornCompaction}`, or null when the session has no turn yet.
function plan(t) {
  if (!t.row || t.row.main_chain_id == null) return null;
  const items = [];
  const expanded = new Set();
  const subChains = new Set();
  let tornCompaction = false;
  let tornChain = false;
  const lineOf = (chain) => {
    const out = [];
    let hoisted = false;
    for (const n of chain) {
      const x = sumFrom(n);
      if (x != null && !expanded.has(x)) {
        expanded.add(x);
        const history = tryWalk(t, x, `the compacted history of node ${n.id}`);
        if (!history) tornCompaction = true;
        else {
          const piece = [...lineOf(history), { compaction: x, trigger: n }];
          if (!hoisted) {
            out.unshift(...piece);
            hoisted = true;
          } else out.push(...piece);
        }
      }
      out.push({ node: n });
    }
    return out;
  };
  const addLine = (entries, agent, canHold) => {
    const results = new Map();
    for (const e of entries) {
      const c = e.node ? callOf(e.node) : null;
      if (c && !results.has(c)) results.set(c, e.node);
    }
    const follows = new Array(entries.length).fill(false);
    const nextOf = new Array(entries.length).fill(null);
    for (let i = entries.length - 1, seen = false, next = null; i >= 0; i--) {
      follows[i] = seen;
      nextOf[i] = next;
      const e = entries[i];
      if (e.compaction != null || isContent(e.node)) {
        seen = true;
        next = e.node ?? null;
      }
    }
    entries.forEach((e, i) => {
      if (e.compaction != null) {
        items.push({ compaction: e.compaction, trigger: e.trigger, agent });
        return;
      }
      const n = e.node;
      items.push({ node: n, agent, canHold, tail: !follows[i], next: nextOf[i], results });
      // A sub-agent's chain lives in the same tree: the result of the call that ran it names it.
      const subs = n.role === 'assistant' ? callsOf(n).map((c) => results.get(String(c.id))).filter(Boolean) : n.role === 'tool' ? [n] : [];
      for (const r of subs) {
        const head = num(r.ext['subagent/chain_node_id']);
        if (head == null || r.ext['subagent/agent_id'] == null || subChains.has(head)) continue;
        subChains.add(head);
        const chain = tryWalk(t, head, `the sub-agent chain of node ${r.id}`);
        if (!chain) tornChain = true;
        else addLine(lineOf(chain), str(r.ext['subagent/agent_id']), false);
      }
    });
  };
  addLine(lineOf(walk(t, num(t.row.main_chain_id), 'main_chain_id')), '', true);
  // A running sub-agent's head is walked for a loop (damaged), never for closure: one the read does
  // not hold whole tears nothing, and derive leaves its chain out (headHeld, below).
  for (const h of t.heads) headHeld(t, h);
  return { items, torn: tornCompaction || tornChain, tornCompaction };
}

// The chain ending at a node the main line only names, or null when this read does not hold it
// whole (a save in progress). Only the main line itself tears a read (sessions v1.x (#6), §2
// `inconsistent`). A loop is still damaged.
function tryWalk(t, id, what) {
  try {
    return walk(t, id, what);
  } catch (e) {
    if (e instanceof SessionsError && e.code === 'inconsistent') return null;
    throw e;
  }
}

// Whether the read holds a running sub-agent's chain whole, from its head to its root: a
// subagent_heads row naming a node this read does not hold tears nothing.
const headHeld = (t, h) => tryWalk(t, h.node, `the sub-agent head of ${h.agent_id}`) !== null;

// Whether a running sub-agent's head dangles: one the read does not hold whole.
const headDangles = (t) => t.heads.some((h) => !headHeld(t, h));

// The node ids a copy names as its originals: a mode switch (and a compaction) re-roots the line
// under a new prefix, each copy naming the node it copies (`compact/prior_node_ids`, in the node's
// metadata column; sessions-model annex, Devin).
function priorOf(n) {
  const ids = isObj(n.nm.extensions) ? n.nm.extensions['compact/prior_node_ids'] : null;
  return Array.isArray(ids) ? ids.map(num).filter((x) => x != null) : [];
}

// The trees (by root node id) that keep their normal treatment while something dangles: every tree
// holding a node the plan reached from the main line (`seen`), or a node on a valid sub-agent
// head's chain, and every tree such a node names through `compact/prior_node_ids`, transitively. So
// a mode switch's old root, a valid sub-agent's pre-copy task and the abandoned branches in either
// stay as they are; only the trees a dangling node's chain sits in are left out. A missing parent
// ends a tree. Returns `{roots, rootOf}`.
// A compaction re-roots the line as a mode switch does (prefix copies naming the context nodes),
// so the tree its compacted history sits in is named by those copies. While a compacted history
// tears (`priorLinks` false), a tree named only that way is left out with it, rather than read as
// an abandoned branch: the history's nodes above the gap cannot be told from such a branch.
function keptTrees(t, seen, { priorLinks = true } = {}) {
  const roots = new Map();
  const rootOf = (id) => {
    if (roots.has(id)) return roots.get(id);
    let n = t.nodes.get(id);
    for (let k = 0; n && n.parent != null && t.nodes.has(n.parent) && k <= t.nodes.size; k++) n = t.nodes.get(n.parent);
    const r = n ? n.id : id;
    roots.set(id, r);
    return r;
  };
  const kept = new Set(); // root ids
  const work = [...seen];
  for (const h of t.heads) if (headHeld(t, h)) work.push(...walk(t, h.node, `the sub-agent head of ${h.agent_id}`).map((n) => n.id));
  const done = new Set();
  while (work.length) {
    const id = work.pop();
    if (done.has(id) || !t.nodes.has(id)) continue;
    done.add(id);
    kept.add(rootOf(id));
    if (priorLinks) work.push(...priorOf(t.nodes.get(id)));
  }
  return { roots: kept, rootOf };
}

// ---- list ---------------------------------------------------------------------------------------

// One entry per sessions row, hidden ones included. Slugs can be reused and nothing tells two lives
// apart, so `incarnation` is '' (sessions-model §1 rule 2). `updated_hint` moves with the row's
// read
// columns, the node slice's count, max node_id and stored size, and the tool-state and head slices.
export function list(store) {
  const root = store.harness_path;
  if (!isRealFile(root, DB_REL)) return [];
  const db = openReadOnly(root, DB_REL);
  try {
    return withRead(db, DB_REL, (d) => {
      if (!hasTable(d, 'sessions')) return [];
      const scols = columnsOf(d, 'sessions');
      if (!scols.has('id')) return [];
      const cols = SESSION_COLS.filter((c) => scols.has(c));
      return d.prepare(listSql(d, cols)).all().map((r) => {
        const counts = Object.keys(r).filter((k) => k.startsWith('dv_')).sort().map((k) => num(r[k]));
        return {
          session_id: str(r.id),
          incarnation: '',
          updated_hint: sha256(JSON.stringify([jcs(project(r, cols)), counts])).slice(0, 32),
          live: 'unknown',
          sources: [{ source_key: SOURCE, role: 'main', mode: 'snapshot', position_kind: 'snapshot' }],
        };
      }).sort((a, b) => cmpStr(a.session_id, b.session_id));
    });
  } finally {
    db.close();
  }
}

// ---- read ---------------------------------------------------------------------------------------

// The session's one snapshot: its row, nodes, tool states and sub-agent heads, read in one
// transaction, parsed (a JSON column that does not parse is `damaged`) and checked for closure (a
// pointer this read cannot follow is `inconsistent`) before it leaves.
export function read(store, session, sourceKey, from = null, _known = null) {
  if (sourceKey !== SOURCE) throw new SessionsError('source_unknown', `${sourceKey} is not a devin source`, [sourceKey]);
  const root = store.harness_path;
  const sid = String(session.session_id);
  // Devin keeps no birth marker: every session's incarnation is ''.
  if (!isRealFile(root, DB_REL) || (session.incarnation ?? '') !== '') throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
  const db = openReadOnly(root, DB_REL, sourceKey);
  try {
    return withRead(db, sourceKey, (d) => {
      const body = sessionBody(d, sid);
      if (!body) throw new SessionsError('session_unknown', `no session ${sid}`, [sid]);
      plan(treeOf(body));
      return readRowsSnapshot(sourceKey, body, from);
    });
  } finally {
    db.close();
  }
}

// ---- derive -------------------------------------------------------------------------------------

function emptyState() {
  return {
    state_ver: STATE_VER,
    body: null, // the snapshot unit, parsed
    emitted: { session: {}, message: {}, usage: {}, link: {}, lifecycle: {} }, // key -> content_sha
  };
}
const noHeld = () => ({ session: [], message: [], usage: [], link: [], lifecycle: [] });

// The records are a function of the one snapshot: every derive rebuilds them all, and `changed` is
// what moved since the state's last derive.
export function derive(session, input, state) {
  const st = state && state.state_ver === STATE_VER ? structuredClone(state) : emptyState();
  const key = {
    host: session.host, harness: HARNESS, harness_path: session.harness_path,
    session_id: session.session_id, incarnation: session.incarnation ?? '',
  };
  for (const src of input) {
    if (src.source_key !== SOURCE) continue;
    const units = src.units ?? [];
    if (units.length) {
      const o = jsonOf(units[units.length - 1]);
      st.body = isObj(o) ? o : null;
    } else if (src.complete) st.body = null;
  }

  const { out, held, partial } = build(st.body);

  const changed = [];
  const live = noHeld();
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
  // The fingerprint: the cmp_sha of every message on the current line, in order.
  const line = [];
  let sessionRec = null;
  for (const r of out) {
    if (r.type === 'session') {
      sessionRec = r;
      continue;
    }
    const sealed = put(r);
    if (sealed.type === 'message' && sealed.on_active_branch) line.push([sealed.order, sealed.cmp_sha]);
  }
  line.sort((a, b) => cmpStr(a[0], b[0]));
  if (sessionRec) put({ ...sessionRec, fingerprint: { cmp_shas: line.map((x) => x[1]) } });

  // While a node the main line names dangles, derive leaves out what it would have reached, and a
  // later read that holds the node derives it (sessions v1.x (#6), §2 `inconsistent`). So a key
  // written before and left out now is held, not tombstoned: its last written version stands, and
  // the next read that holds the node releases it (live again) or drops it (sessions §2, `held`).
  if (partial) {
    for (const type of Object.keys(live)) {
      const now = new Set([...live[type], ...held[type]]);
      for (const k of Object.keys(st.emitted[type])) if (!now.has(k)) held[type].push(k);
    }
  }
  // A key neither live nor held leaves `emitted`, and the consumer tombstones it; a held key keeps
  // its last emitted sha (sessions §2).
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

// ---- parts --------------------------------------------------------------------------------------

function reasoningPart(th) {
  if (typeof th === 'string') return th ? { kind: 'reasoning', text: th, signature_len: null } : null;
  if (!isObj(th)) return null;
  const sig = typeof th.signature === 'string' && th.signature ? Buffer.byteLength(th.signature, 'utf8') : null;
  if (typeof th.thinking === 'string' && th.thinking) return { kind: 'reasoning', text: th.thinking, signature_len: sig };
  if (sig) return { kind: 'reasoning', opaque: true, signature_len: sig };
  return null;
}

// An image: its inline bytes (base64, as stored), else its source path. The model-written caption
// Devin stores beside it has no field of its own: it is a notice, never dropped (sessions-model
// §2.3).
function imageParts(images) {
  const parts = [];
  for (const im of Array.isArray(images) ? images : []) {
    if (!isObj(im)) continue;
    const b64 = typeof im.base64_data === 'string' && im.base64_data ? im.base64_data : null;
    parts.push({
      kind: 'attachment', media_type: str(im.mime_type) || null, inline: b64, ref: b64 ? null : str(im.source_path) || null,
      bytes_len: b64 ? Buffer.from(b64, 'base64').length : null,
    });
    if (typeof im.caption === 'string' && im.caption) parts.push({ kind: 'notice', text: im.caption, level: null, native_type: 'image.caption' });
  }
  return parts;
}

// What the user typed, where the store keeps it apart from the content the model saw (a slash
// skill's expanded body, an image placeholder before the prompt).
function typedText(n) {
  const blocks = n.ext['chisel/acp-content-blocks'];
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

// A tool node's outcome: rejected is denied, canceled is cancelled, a failure is an error; a
// non-zero exit stays completed (fixture captures).
function outcome(res, st) {
  const x = res.ext;
  const meta = isObj(x['chisel/tool_result_meta']) ? x['chisel/tool_result_meta'] : {};
  const failure = (isObj(x['chisel/tool_failure']) ? x['chisel/tool_failure'].reason : undefined) ?? meta.failure_reason ?? null;
  const has = (k) => failure === k || (isObj(failure) && Object.prototype.hasOwnProperty.call(failure, k));
  const u = st || {};
  const um = isObj(u._meta) ? u._meta : {};
  const rejected = um['cognition.ai/rejected'] === true || has('Rejected');
  const canceled = um['cognition.ai/canceled'] === true || has('Canceled');
  const failed = meta.success === false || u.status === 'failed';
  return { is_error: !!(failed || rejected || canceled), status: rejected ? 'denied' : canceled ? 'cancelled' : 'completed' };
}

// A shell tool's exit code: the tool node's `chisel/terminal_output.exit.exit_code` (the lab
// samples: 0 and 3), kept apart from the content text, never parsed out of it. The lab's
// tool_call_state updates carry none.
function exitOf(res) {
  const term = res.ext['chisel/terminal_output'];
  const code = isObj(term) && isObj(term.exit) ? term.exit.exit_code : null;
  return Number.isInteger(code) ? code : null;
}

function usageOf(n) {
  const m = n.md.metrics;
  if (!isObj(m)) return null;
  const u = { input: num(m.input_tokens), output: num(m.output_tokens), cache_read: num(m.cache_read_tokens), cache_write: num(m.cache_creation_tokens) };
  if (u.input == null && u.output == null && u.cache_read == null && u.cache_write == null) return null;
  return {
    type: 'usage', usage_id: `message:${n.mid}#1`, anchor: { message_id: n.mid }, ...u, reasoning: null, cost: null,
    input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_response', model: str(n.md.generation_model) || null,
  };
}

const numbered = (parts) => parts.map((p, i) => ({ part_id: String(i), ...p }));

// ---- the fold ----------------------------------------------------------------------------------

// Every record of the session from its snapshot, and the keys held as incomplete.
function build(body) {
  const out = [];
  const held = noHeld();
  if (!body) return { out, held, partial: false };
  const t = treeOf(body);
  const row = t.row;
  if (!row) return { out, held, partial: false };
  const hidden = Number(row.hidden) === 1;

  const processed = new Map(); // message_id -> order, of every message emitted or held
  const seenNodes = new Set();
  let counter = 0;
  let lifecycleN = 0;
  const nextOrder = () => pad(counter++, 8);

  // `parent_id` is the native pointer: the parent node's message id (a prefix node's id when the
  // parent is the system prefix, which is not a message).
  const message = (n, { order, agent, onActive, role, source, status, parts, injected = false }) => ({
    type: 'message', message_id: n.mid,
    parent_id: n.parent == null ? null : t.nodes.get(n.parent)?.mid || null,
    order, agent_id: agent, role, source,
    to_user: injected ? false : null, to_model: injected ? true : null,
    status, state: 'current', on_active_branch: onActive, ts: isoTs(n.md.created_at),
    requested_model: null, served_model: role === 'assistant' ? str(n.md.generation_model) || null : null, effort: null,
    response_id: role === 'assistant' && n.md.request_id != null ? str(n.md.request_id) : null,
    aliases: [], parts: numbered(parts),
  });

  const toolMessage = (n, ctx) => {
    const c = callOf(n) ?? '';
    const o = outcome(n, t.states.get(c));
    const output = textOfContent(n.cm.content);
    return message(n, {
      ...ctx, role: 'tool', source: null, status: 'complete',
      parts: [{ kind: 'tool_result', call_id: c, is_error: o.is_error, status: o.status, output, output_len: Buffer.byteLength(output, 'utf8'), truncated: null, exit_code: exitOf(n) }],
    });
  };
  const userMessage = (n, ctx) => {
    const parts = [];
    const text = textOfContent(n.cm.content);
    const typed = typedText(n);
    if (text) parts.push({ kind: 'text', text });
    if (typed && typed !== text) parts.push({ kind: 'notice', text: typed, level: null, native_type: 'chisel/acp-content-blocks' });
    parts.push(...imageParts(n.cm.images));
    // A hidden session's prompts, a sub-agent's task and anything not typed are the harness's own.
    const automated = hidden || ctx.agent !== '' || n.md.is_user_input !== true;
    return message(n, { ...ctx, role: 'user', source: automated ? 'automated' : 'user', status: 'complete', parts });
  };
  const systemMessage = (n, ctx) => {
    const text = textOfContent(n.cm.content);
    if (isInterrupt(n)) {
      return message(n, { ...ctx, role: 'system', source: 'system_notice', status: 'complete', parts: [{ kind: 'notice', text: text.trim(), level: null, native_type: 'interrupt' }] });
    }
    // Injected context: system_info, rules, skills, editor context, mode transitions, the
    // compaction continuation.
    return message(n, { ...ctx, role: 'system', source: 'injected', status: 'complete', injected: true, parts: text ? [{ kind: 'text', text }] : [] });
  };
  // A reply: interrupted when the next entry is the interrupt notice, a call never got its result,
  // or a result was cancelled.
  const assistantMessage = (n, ctx, next, results) => {
    const calls = callsOf(n);
    const interrupted = (next && isInterrupt(next)) || calls.some((c) => {
      const r = results.get(String(c.id));
      return !r || outcome(r, t.states.get(String(c.id))).status === 'cancelled';
    });
    const parts = [];
    const r = reasoningPart(n.cm.thinking);
    if (r) parts.push(r);
    const text = textOfContent(n.cm.content);
    if (text) parts.push({ kind: 'text', text });
    parts.push(...imageParts(n.cm.images));
    for (const c of calls) parts.push({ kind: 'tool_call', call_id: String(c.id), name: str(c.name), args: argsOf(c.arguments), server: null });
    return message(n, { ...ctx, role: 'assistant', source: 'model', status: interrupted ? 'interrupted' : 'complete', parts });
  };

  const emit = (recs, isHeld) => {
    for (const r of recs) {
      if (!r) continue;
      if (isHeld) held[r.type].push(r.type === 'usage' ? r.usage_id : r.message_id);
      else out.push(r);
    }
  };

  // A compaction: its lifecycle record, then the compactor's reply (an assistant node with
  // `summarized_from` X, kept off the line) as a summary replacing through X's message. Without a
  // reply, the continuation node that names X carries the summary.
  const compaction = (it) => {
    let through = null;
    for (let n = t.nodes.get(it.compaction), k = 0; n && k <= t.nodes.size; n = n.parent == null ? null : t.nodes.get(n.parent), k++) {
      if (processed.has(n.mid)) {
        through = n.mid;
        break;
      }
    }
    const from = walk(t, it.compaction, 'a compacted history').find((n) => processed.has(n.mid))?.mid ?? null;
    const sums = [];
    for (const n of [...t.nodes.values()].sort((a, b) => a.id - b.id)) {
      if (n.role !== 'assistant' || sumFrom(n) !== it.compaction || !n.mid || processed.has(n.mid) || sums.some((s) => s.mid === n.mid)) continue;
      sums.push(n);
    }
    const carrier = sums.length ? null : it.trigger.role === 'system' && !processed.has(it.trigger.mid) ? it.trigger : null;
    const first = sums[0] || carrier;
    lifecycleN += 1;
    out.push({
      type: 'lifecycle', lifecycle_id: first ? first.mid : `${SOURCE}@${SOURCE}#${lifecycleN}`, op: 'compaction',
      target: from && through ? { range: { from_id: from, through_id: through } } : { session: true },
      at: null, ts: isoTs((first || it.trigger).md.created_at), evidence: 'explicit',
    });
    for (const n of first ? [...sums, ...(carrier ? [carrier] : [])] : []) {
      seenNodes.add(n.id);
      const order = nextOrder();
      processed.set(n.mid, order);
      const parts = [];
      const r = reasoningPart(n.cm.thinking);
      if (r) parts.push(r);
      parts.push({ kind: 'summary', text: textOfContent(n.cm.content), replaces: through ? { through_id: through } : 'unknown' });
      const asst = n.role === 'assistant';
      emit([
        message(n, { order, agent: it.agent, onActive: true, role: asst ? 'assistant' : 'system', source: asst ? 'model' : 'injected', status: 'complete', injected: !asst, parts }),
        asst ? usageOf(n) : null,
      ], false);
    }
  };

  const p = plan(t);
  const items = p ? p.items : null;
  // Something the main line names dangles: a running sub-agent's head, a compacted history or a
  // sub-agent chain a tool result names. What it would have reached is left out (below), and what
  // an earlier derive wrote of it is held (derive).
  const partial = headDangles(t) || !!p?.torn;
  for (const it of items ?? []) {
    if (it.compaction != null) {
      compaction(it);
      continue;
    }
    const n = it.node;
    seenNodes.add(n.id);
    if (!n.mid || isPrefix(n) || isKeepalive(n) || processed.has(n.mid)) continue;
    const order = nextOrder();
    processed.set(n.mid, order);
    const ctx = { order, agent: it.agent, onActive: true };
    if (n.role === 'tool') emit([toolMessage(n, ctx)], false);
    else if (n.role === 'assistant') {
      const missing = callsOf(n).some((c) => !it.results.has(String(c.id)));
      const inference = (isObj(n.md.telemetry) && n.md.telemetry.operation === 'inference') || !!n.md.request_id;
      // A tail reply whose call has no result yet, or that its row marks unfinished (no
      // finish_reason), is held with its usage until a later node releases it.
      const isHeld = it.canHold && it.tail && (missing || (inference && n.md.finish_reason == null));
      emit([assistantMessage(n, ctx, it.next, it.results), usageOf(n)], isHeld);
    } else if (n.role === 'user') emit([userMessage(n, ctx)], false);
    else emit([systemMessage(n, ctx)], false);
  }

  // Abandoned branches: a revert moves main_chain_id back, and an edit is a revert plus a new
  // sibling branch; the abandoned nodes stay in the table. Candidates are off the line, not in a
  // sub-agent or compactor chain, not the prefix or a keepalive, with a message id the line does
  // not
  // carry (streaming twins and prefix copies share the line's ids). Each is a message with
  // `on_active_branch: false`, ordered after the line message its subtree hangs off, by node_id.
  if (items) {
    const aux = new Set();
    const markUp = (id) => {
      for (let n = t.nodes.get(id), k = 0; n && !aux.has(n.id) && k <= t.nodes.size; n = n.parent == null ? null : t.nodes.get(n.parent), k++) aux.add(n.id);
    };
    for (const n of t.nodes.values()) {
      if (n.role === 'assistant' && sumFrom(n) != null) markUp(n.id);
      if (n.ext['subagent/chain_node_id'] != null) markUp(num(n.ext['subagent/chain_node_id']));
    }
    for (const h of t.heads) markUp(h.node);
    // A node the main line names that the read does not hold whole: its chain cannot be walked, so
    // its nodes cannot be named, and its held nodes would read as an abandoned branch. derive leaves
    // out what it would have reached (sessions v1.x (#6), §2 `inconsistent`): while something
    // dangles, a node is left out when no valid head reaches its tree and no tree holding a
    // main-line node contains it.
    const kept = partial ? keptTrees(t, seenNodes, { priorLinks: !p.tornCompaction }) : null;
    const known = new Set([...seenNodes].map((id) => t.nodes.get(id).mid));
    const cand = new Map();
    for (const n of [...t.nodes.values()].sort((a, b) => a.id - b.id)) {
      if (seenNodes.has(n.id) || aux.has(n.id) || isPrefix(n) || isKeepalive(n) || !n.mid || known.has(n.mid)) continue;
      if (kept && !kept.roots.has(kept.rootOf(n.id))) continue;
      cand.set(n.id, n);
    }
    const results = new Map();
    for (const n of cand.values()) {
      const c = callOf(n);
      if (c && !results.has(c)) results.set(c, n);
    }
    const baseOrder = (id) => {
      for (let n = id == null ? null : t.nodes.get(id), k = 0; n && k <= t.nodes.size; n = n.parent == null ? null : t.nodes.get(n.parent), k++) {
        if (processed.has(n.mid)) return processed.get(n.mid);
      }
      return '';
    };
    const done = new Set();
    for (const n of cand.values()) {
      if (done.has(n.mid)) continue;
      done.add(n.mid);
      let top = n;
      for (let k = 0; top.parent != null && cand.has(top.parent) && k <= t.nodes.size; k++) top = cand.get(top.parent);
      const ctx = { order: `${baseOrder(top.parent)}.${pad(n.id, 10)}`, agent: '', onActive: false };
      if (n.role === 'tool') emit([toolMessage(n, ctx)], false);
      else if (n.role === 'assistant') emit([assistantMessage(n, ctx, null, results), usageOf(n)], false);
      else if (n.role === 'user') emit([userMessage(n, ctx)], false);
      else emit([systemMessage(n, ctx)], false);
    }
  }

  const title = str(row.title);
  out.push({
    type: 'session',
    engine: null,
    client: 'devin',
    harness_version: null,
    title: title || null,
    // A titler model names a session and later retitles it; /rename writes the same column.
    title_set_by: title ? 'unknown' : null,
    cwd: str(row.working_directory) || null,
    last_cwd: null,
    created_at: secIso(row.created_at),
    // last_activity_at moves on every save and is not read.
    updated_at: null,
    // Archive lives in Devin Desktop's globalStorage, another harness store; a delete removes the
    // row.
    state: 'active',
    pinned: null,
    mode: str(row.agent_mode) || null,
    kind: hidden ? 'hidden' : null,
    reuse: 'undetectable',
    ts_source: 'reset_on_save',
    aliases: [],
  });
  return { out, held, partial };
}
