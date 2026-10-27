// Writes the Devin Local fixture store as text: the schema and the statements that build
// `<data>/sessions.db` (conformance/sql-store.js builds the database at test time; no binary file
// is
// committed).
//   node fixtures/devin/generate.js
//
// `features`: one session per behaviour the adapter claims, ported from memhouse's normaliser
// tests, in the store's shape as the lab captures show it (the fixture captures,
// synthetic, captured on a test VM; scrubbed): the system prefix and the
// chain re-rooted under it with `compact/prior_node_ids`, streaming twins, the cache-keepalive
// sibling, tool states, an image with its caption, a slash skill, an interrupt, a revert and an
// edit,
// a compaction, a sub-agent in the same tree, a hidden summary-agent session, the two holds, and a
// session with no turn yet. The scrubbed samples are not closed trees (they are single rows of
// several sessions, and the sessions dump was taken at another time than the node samples), so no
// lab session is rebuilt from them; their node, metadata and tool-state shapes are copied here, and
// every text is invented (the toy shop repo).
//
// `switch-compaction`: one session, a mode switch then a compaction, with a turn abandoned in the
// switch's old root (see switchCompaction below).
//
// Every id is synthetic and derived from a name below (sha256), so a re-run writes the same bytes:
// message, request and client-message ids are UUIDs, call ids `call_` + 24 hex digits (the shape of
// the captured ones), terminal ids 6 hex digits. No id captured in the lab appears.
//
// The statements replay the harness's write pattern without ever leaving a torn state, so that
// every
// prefix of them is a store a reader may see: nodes are inserted parents first, and main_chain_id
// moves only to a node already stored. A save re-mints every node's row_id and resets every row's
// created_at in one statement (INSERT OR REPLACE ... SELECT), as Devin's delete-and-re-insert does.
// The schema is Devin Local 3000.10.67's (the scrubbed capture's schema dump), statement by
// statement, without `sqlite_sequence`, which SQLite creates itself for an AUTOINCREMENT table.
// subagent_heads stayed empty in the lab; the head row written while a sub-agent runs and deleted
// when it ends is INFERRED from the table's columns.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REL = 'sessions.db';

const SCHEMA = `PRAGMA journal_mode=WAL;
CREATE TABLE refinery_schema_history(
             version int4 PRIMARY KEY,
             name VARCHAR(255),
             applied_on VARCHAR(255),
             checksum VARCHAR(255));
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
CREATE INDEX idx_sessions_activity
  ON sessions(last_activity_at DESC);
CREATE TABLE prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  session_id TEXT NOT NULL
, is_shell INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_prompt_history_timestamp
  ON prompt_history(timestamp DESC);
CREATE INDEX idx_prompt_history_session
  ON prompt_history(session_id);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,           -- node_id within this session's forest
  parent_node_id INTEGER,             -- NULL for root nodes
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, node_id)
);
CREATE INDEX idx_message_nodes_session
  ON message_nodes(session_id);
CREATE TABLE rendered_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  rendered_html TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, sequence_number)
);
CREATE INDEX idx_rendered_commits_session
  ON rendered_commits(session_id, sequence_number);
CREATE TABLE app_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
CREATE TABLE tool_call_state (
    session_id    TEXT    NOT NULL,
    tool_call_id  TEXT    NOT NULL,
    -- Serialised acp::ToolCall JSON (the initial ToolCall event).
    -- Nullable: may be absent for interrupted sessions where the tool result
    -- was saved but resolve_and_commit did not complete.
    tool_call_json     TEXT,
    -- Serialised acp::ToolCallUpdate JSON (the final completion update).
    tool_call_update_json TEXT,
    PRIMARY KEY (session_id, tool_call_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_sessions_hidden ON sessions(hidden);
CREATE TABLE subagent_heads (
    session_id    TEXT    NOT NULL,
    agent_id      TEXT    NOT NULL,
    chain_node_id INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (session_id, agent_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`;

// ---- synthetic ids ------------------------------------------------------------------------------

const hex = (name) => createHash('sha256').update(`devin-fixture:${name}`).digest('hex');
export function uuid(name) {
  const h = hex(name);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const callId = (name) => `call_${hex(`call:${name}`).slice(0, 24)}`;
const terminal = (name) => hex(`term:${name}`).slice(0, 6);

// ---- node shapes (the scrubbed samples' fields) -------------------------------------------------

const HOME = '/home/user';
const REPO = `${HOME}/work/toyshop`;
const iso = (ms) => new Date(ms).toISOString().replace('Z', '123456Z'); // RFC 3339, nanoseconds
const sec = (ms) => Math.floor(ms / 1000);

const md = (t, telemetry, extra = {}) => ({
  num_tokens: null, is_user_input: null, request_id: null, metrics: null, finish_reason: null, ...extra, created_at: iso(t), telemetry,
});
const sys = (name, t, content, ext = {}, source = 'system') => ({
  message_id: uuid(name), role: 'system', content, metadata: md(t, { source, operation: 'unknown' }, Object.keys(ext).length ? { extensions: ext } : {}),
});
const sysPrompt = (name, t, content, op = 'normal') => ({ message_id: uuid(name), role: 'system', content, metadata: md(t, { source: 'sysprompt', operation: op }) });
function prompt(name, t, content, { typed, images, automated = false } = {}) {
  const ext = { 'chisel/client-message-id': uuid(`${name}:client`) };
  if (typed !== undefined) ext['chisel/acp-content-blocks'] = [{ type: 'text', text: typed }];
  return {
    message_id: uuid(name), role: 'user', content, ...(images ? { images } : {}),
    metadata: md(t, { source: 'user', operation: 'unknown' }, { is_user_input: automated ? null : true, extensions: ext }),
  };
}
function reply(name, t, content, { calls = [], thinking = 'Look at the cart first.', metrics = [400, 50, 12000], fr, model = 'swe-1-6-slow', inference = true } = {}) {
  const extra = !inference ? {} : {
    num_tokens: metrics ? metrics[1] : null, request_id: uuid(`${name}:request`),
    metrics: metrics ? { ttft_ms: 900, total_time_ms: 3000, input_tokens: metrics[0], output_tokens: metrics[1], cache_read_tokens: metrics[2], cache_creation_tokens: null, tpot_ms: 20, tokens_per_sec: 40 } : null,
    finish_reason: fr !== undefined ? fr : calls.length ? 'tool_calls' : 'stop',
    started_generation_at: iso(t - 800), generation_model: model,
  };
  return {
    message_id: uuid(name), role: 'assistant', content,
    ...(inference ? { tool_calls: calls.map(([id, fn, args], i) => ({ id, name: fn, arguments: args, index: i, kind: 'function' })), thinking: { thinking, signature: '' } } : {}),
    metadata: md(t, { source: 'assistant', operation: inference ? 'inference' : 'unknown' }, extra),
  };
}
const timing = (t, ms) => ({ started_at: iso(t - ms), finished_at: iso(t - 1), duration_ms: ms });
function result(name, t, call, content, ext = {}, op = 'exec') {
  return {
    message_id: uuid(name), role: 'tool', content, tool_call_id: call,
    metadata: md(t, { source: 'tool_result', operation: op }, { extensions: { 'chisel/tool_result_meta': { success: true, kind: op === 'exec' ? 'execute' : 'other' }, 'chisel/tool_call_timing': timing(t, 40), ...ext } }),
  };
}
const shellOut = (name, text, code, cwd = REPO) => ({ 'chisel/terminal_output': { text, cwd, exit: { terminal_id: terminal(name), exit_code: code } } });
const keepalive = (name, t) => ({
  message_id: uuid(name), role: 'user', content: 'continue',
  metadata: md(t, { source: 'cache_keepalive', operation: 'continue_prompt' }, { extensions: { 'barista/prompt_cache_footer': true } }),
});
const systemInfo = (name, t, cwd = REPO) => sys(name, t, `<system_info>\nThe following information is automatically generated context about your current environment.\nCurrent workspace directories:\n  ${cwd} (cwd)\n\nPlatform: linux\nToday's date: Tuesday, 2026-10-20\nYou are running as a coding agent inside Devin Desktop.\n</system_info>`, { 'affogato/cog-context': { key: 'workspace/context' } });
const rules = (name, t) => sys(name, t, `<rules type="always-on">\n<rule name="AGENTS" path="${REPO}/AGENTS.md">\n# Project Notes for toyshop\n- Tests use unittest.\n</rule>\n</rules>`, { 'agent-ext/rules-loaded': { rule_paths: [`${REPO}/AGENTS.md`], available_rule_paths: [], content_bytes: 52, is_always_on: true, preserve_on_compaction: true } }, 'rules');

const TWIN = { summarized_from: null, num_tokens_preceding: 13160, is_system_prefix: null };
const PREFIX = { summarized_from: null, num_tokens_preceding: null, is_system_prefix: true };

// ---- the statements of one store ----------------------------------------------------------------

class Store {
  constructor() {
    this.ops = [{ sql: 'INSERT INTO app_state (key, value) VALUES (?, ?)', params: ['schema_compat_version', '0'] }];
  }

  op(sql, params = []) {
    this.ops.push({ sql, params });
  }
}

// One session's writes. `save` is Devin's per-turn save: every node re-inserted (a new row_id, the
// row created_at reset), then main_chain_id moved.
class Session {
  constructor(store, row) {
    this.s = store;
    this.id = row.id;
    this.next = 0;
    this.cms = new Map();
    this.at = row.created_at;
    const full = {
      backend_type: 'windsurf', model: 'swe-1-6-slow', agent_mode: 'smart', last_activity_at: row.created_at, title: null, main_chain_id: null,
      shell_last_seen_index: 0, workspace_dirs: '[]', hidden: 0,
      cogs_json: JSON.stringify([{ source: { Session: 'User' }, lifetime: { Unique: 'core/accept_edits' }, permissions: [[{ Scope: { Write: { glob: row.working_directory } } }, 'Allow']], model: null }]),
      metadata: '{"total_credit_cost":0,"total_acu_cost":0.0}',
      ...row,
    };
    const cols = Object.keys(full);
    store.op(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => full[c]));
  }

  add(parent, cm, nm = null) {
    const id = this.next++;
    this.cms.set(id, cm);
    this.s.op('INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      [this.id, id, parent, JSON.stringify(cm), this.at, nm ? JSON.stringify(nm) : null]);
    return id;
  }

  // Streaming twins: two sibling nodes with one message_id; the chain goes through the second.
  twin(parent, cm) {
    this.add(parent, cm);
    return this.add(parent, cm, TWIN);
  }

  // The system prefix: the system prompt and the sub-agent profiles, a root of its own.
  prefix(name, t, op = 'normal') {
    const p0 = this.add(null, sysPrompt(`${name}:prompt`, t, 'You are Devin, an interactive command line agent (synthetic system prompt).', op), PREFIX);
    return this.add(p0, sysPrompt(`${name}:profiles`, t, 'Sub-agent profiles: Explore (synthetic).', 'subagent_profiles'), PREFIX);
  }

  // A prefix copy: the chain re-rooted under `parent`, each copy naming its original.
  copy(parent, ids) {
    let p = parent;
    for (const id of ids) p = this.add(p, this.cms.get(id), { summarized_from: null, num_tokens_preceding: null, is_system_prefix: null, extensions: { 'compact/prior_node_ids': [id] } });
    return p;
  }

  save(main, t) {
    this.at = sec(t);
    this.s.op('INSERT OR REPLACE INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) SELECT session_id, node_id, parent_node_id, chat_message, ?, metadata FROM message_nodes WHERE session_id = ? ORDER BY node_id', [this.at, this.id]);
    this.s.op('UPDATE sessions SET main_chain_id = ?, last_activity_at = ?, metadata = ? WHERE id = ?',
      [main, this.at, JSON.stringify({ total_credit_cost: 0, total_acu_cost: this.next / 100 }), this.id]);
  }

  // A call's final ACP update; tool_call_json is the initial event (not read by the adapter).
  state(id, tool, status, meta = {}, input = {}) {
    this.s.op('INSERT OR REPLACE INTO tool_call_state (session_id, tool_call_id, tool_call_json, tool_call_update_json) VALUES (?, ?, ?, ?)', [
      this.id, id,
      JSON.stringify({ toolCallId: id, title: `Ran ${tool}`, kind: tool === 'exec' ? 'execute' : 'other', rawInput: input, _meta: { 'cognition.ai/inferenceToolName': tool } }),
      JSON.stringify({ toolCallId: id, status, _meta: { ...meta, 'cognition.ai/inferenceToolName': tool } }),
    ]);
  }

  head(agent, node, t) {
    this.s.op('INSERT OR REPLACE INTO subagent_heads (session_id, agent_id, chain_node_id, updated_at) VALUES (?, ?, ?, ?)', [this.id, agent, node, sec(t)]);
  }

  unhead(agent) {
    this.s.op('DELETE FROM subagent_heads WHERE session_id = ? AND agent_id = ?', [this.id, agent]);
  }
}

// ---- the features case --------------------------------------------------------------------------

const T = Date.UTC(2026, 9, 20, 10, 0, 0);
const min = (m) => T + m * 60000;

function features() {
  const st = new Store();

  // amber-harbor: a turn (context, the prefix copy the line runs through, two tools of which one
  // exits 1, twins, the keepalive sibling), then a rejected tool, a cancelled tool and a reply.
  {
    const t0 = min(0);
    const s = new Session(st, { id: 'amber-harbor', working_directory: REPO, created_at: sec(t0), title: 'Toyshop qty fix' });
    const n0 = s.add(null, systemInfo('ah:si', t0 + 5));
    const n1 = s.add(n0, rules('ah:rules', t0 + 10));
    const n2 = s.add(n1, prompt('ah:u1', t0 + 40000, 'Fix the qty bug in cart.py.'));
    const n3 = s.add(n2, sys('ah:skills', t0 + 40030, '<available_skills>\n- toy-count: Count Python files in the toyshop repo\n</available_skills>', { 'agent-ext/skills-loaded': { skill_names: ['toy-count'] } }, 'skills'));
    const pre = s.prefix('ah:prefix', t0 - 5);
    const sk = s.copy(pre, [n0, n1, n2, n3]);
    s.save(sk, t0 + 40100);
    const exec1 = callId('ah:exec1');
    const read1 = callId('ah:read1');
    const a1 = s.twin(sk, reply('ah:a1', t0 + 49000, "I'll run the tests and read cart.py.", { calls: [[exec1, 'exec', { command: 'python3 -m unittest' }], [read1, 'read', { file_path: 'toyshop/cart.py' }]], thinking: 'Run the tests first.', metrics: [404, 194, 12896] }));
    s.save(a1, t0 + 49100);
    const r1 = s.add(a1, result('ah:r1', t0 + 49500, exec1, `Output from command in shell ${terminal('ah:exec1')}:\nFAILED (failures=1)\n\nExit code: 1`, shellOut('ah:exec1', 'FAILED (failures=1)\n', 1)));
    s.state(exec1, 'exec', 'completed', { 'cognition.ai/terminal_exit': { exit_code: 1, signal: null } }, { command: 'python3 -m unittest' });
    const r2 = s.add(r1, result('ah:r2', t0 + 49600, read1, 'class Cart:\n    def total(self):\n        return sum(i.price_cents for i in self.items)', {}, 'read'));
    s.state(read1, 'read', 'completed', {}, { file_path: `${REPO}/toyshop/cart.py` });
    const a2 = s.twin(r2, reply('ah:a2', t0 + 52000, 'The total ignored qty; it now multiplies price by qty.', { metrics: [12001, 20, 12800] }));
    s.add(r2, keepalive('ah:keepalive', t0 + 52001));
    s.save(a2, t0 + 52100);
    const u2 = s.add(a2, prompt('ah:u2', min(2), 'Install pytest, then run the slow test.'));
    const rej = callId('ah:rej');
    const a3 = s.twin(u2, reply('ah:a3', min(2) + 1000, '', { calls: [[rej, 'exec', { command: 'pip install pytest' }]] }));
    const x3 = s.add(a3, result('ah:x3', min(2) + 2000, rej, 'Tool execution was rejected: User rejected this tool call', {
      'chisel/tool_failure': { reason: { Rejected: { interactive: false } } },
      'chisel/tool_result_meta': { success: false, failure_reason: { Rejected: { interactive: false } }, kind: 'execute' },
    }));
    s.state(rej, 'exec', 'failed', { 'cognition.ai/rejected': true }, { command: 'pip install pytest' });
    const slow = callId('ah:slow');
    const a4 = s.twin(x3, reply('ah:a4', min(2) + 3000, '', { calls: [[slow, 'exec', { command: 'sleep 120 && echo done' }]] }));
    const x4 = s.add(a4, result('ah:x4', min(2) + 12000, slow, 'Canceled due to user interrupt', {
      'chisel/tool_failure': { reason: 'Canceled' }, 'chisel/tool_result_meta': { success: false, failure_reason: 'Canceled', kind: 'execute' },
    }));
    s.state(slow, 'exec', 'failed', { 'cognition.ai/canceled': true }, { command: 'sleep 120 && echo done' });
    const u3 = s.add(x4, prompt('ah:u3', min(3), 'Stop.'));
    const a5 = s.twin(u3, reply('ah:a5', min(3) + 1000, 'Stopped; nothing was installed.', { metrics: [13050, 9, 12800] }));
    s.save(a5, min(3) + 1100);
  }

  // brisk-meadow: a revert (only main_chain_id moves back) and an edit (a new sibling branch under
  // the same node); the abandoned branch stays in the table.
  {
    const t0 = min(10);
    const s = new Session(st, { id: 'brisk-meadow', working_directory: REPO, created_at: sec(t0), title: 'Notes and a revert' });
    const n0 = s.add(null, systemInfo('bm:si', t0 + 5));
    const u1 = s.add(n0, prompt('bm:u1', t0 + 1000, 'What does Cart.total return?'));
    const a1 = s.twin(u1, reply('bm:a1', t0 + 3000, 'The sum of price_cents times qty over the items.', { metrics: [900, 14, 12000] }));
    s.save(a1, t0 + 3100);
    const u2 = s.add(a1, prompt('bm:u2', t0 + 60000, 'Write NOTES.txt with "checkpoint".'));
    const w = callId('bm:write');
    const a2 = s.twin(u2, reply('bm:a2', t0 + 61000, '', { calls: [[w, 'write', { file_path: 'NOTES.txt', content: 'checkpoint' }]] }));
    const r2 = s.add(a2, result('bm:r2', t0 + 61500, w, `Successfully wrote 10 bytes (1 lines) to ${REPO}/NOTES.txt`, { 'chisel/undo': [{ kind: 'delete_created_file', path: `${REPO}/NOTES.txt`, created_dirs: [] }] }, 'write'));
    s.state(w, 'write', 'completed', {}, { file_path: `${REPO}/NOTES.txt` });
    const a3 = s.twin(r2, reply('bm:a3', t0 + 62000, 'Wrote NOTES.txt.', { metrics: [1500, 6, 12000] }));
    s.save(a3, t0 + 62100);
    // Revert to the first answer: the pointer moves back, the branch stays.
    s.save(a1, t0 + 90000);
    const u3 = s.add(a1, prompt('bm:u3', t0 + 95000, 'Say hello instead.'));
    const a4 = s.twin(u3, reply('bm:a4', t0 + 96000, 'Hello!', { metrics: [950, 3, 12000] }));
    s.save(a4, t0 + 96100);
  }

  // calm-orchard: /compact. A summarizer chain off the line, the compactor's summary of node a2
  // (`summarized_from`), the line re-rooted under a new prefix with the continuation, then a turn.
  {
    const t0 = min(20);
    const s = new Session(st, { id: 'calm-orchard', working_directory: REPO, created_at: sec(t0), title: 'Coupon work' });
    const n0 = s.add(null, systemInfo('co:si', t0 + 5));
    const n1 = s.add(n0, rules('co:rules', t0 + 10));
    const u1 = s.add(n1, prompt('co:u1', t0 + 1000, 'Run the tests.'));
    const run = callId('co:run');
    const a1 = s.twin(u1, reply('co:a1', t0 + 2000, '', { calls: [[run, 'exec', { command: 'python3 -m unittest' }]], metrics: [800, 30, 12000] }));
    const r1 = s.add(a1, result('co:r1', t0 + 2500, run, `Output from command in shell ${terminal('co:run')}:\nOK\n\nExit code: 0`, shellOut('co:run', 'OK\n', 0)));
    s.state(run, 'exec', 'completed', {}, { command: 'python3 -m unittest' });
    const a2 = s.twin(r1, reply('co:a2', t0 + 4000, 'All 3 tests pass.', { metrics: [1300, 8, 12000] }));
    s.save(a2, t0 + 4100);
    const sroot = s.add(null, sysPrompt('co:summarizer', t0 + 70000, 'You are a Summarizer that summarizes an agent\'s execution trace (synthetic).'), PREFIX);
    const su = s.add(sroot, { message_id: uuid('co:su'), role: 'user', content: 'Summarize the trace above.', metadata: md(t0 + 70001, { source: 'user', operation: 'unknown' }) });
    const SUMMARY = '<summary>\n1. Request and Intent: the user asked to run the tests; all 3 pass.\n</summary>';
    s.add(su, reply('co:summary', t0 + 71000, SUMMARY, { thinking: '', metrics: [3022, 1051, null], model: 'compactor' }), { summarized_from: a2, num_tokens_preceding: null, is_system_prefix: null });
    const pre = s.prefix('co:prefix2', t0 + 71100);
    const rr = s.copy(pre, [n0, n1]);
    const cont = s.add(rr, sys('co:cont', t0 + 71200, `You are continuing work from a previous conversation thread. Below is a summary of the previous conversation thread:\nFull conversation history saved at ${HOME}/.local/share/devin/cli/summaries/history_toy.md.\nSummary:\n${SUMMARY}`, {
      'chisel/conversation_history': { messages: [{ role: 'user', message: 'Run the tests.' }, { role: 'assistant', message: 'All 3 tests pass.' }] },
      'devin-rs/summary': { source: 'file_compactor' },
    }), { summarized_from: a2, num_tokens_preceding: null, is_system_prefix: null });
    const u2 = s.add(cont, prompt('co:u2', t0 + 80000, 'Now add a coupon test.'));
    const a3 = s.twin(u2, reply('co:a3', t0 + 81000, 'Added tests/test_coupon.py.', { metrics: [2100, 12, 12000] }));
    s.save(a3, t0 + 81100);
  }

  // dusty-lantern: a sub-agent whose chain lives in the same tree. Its task is a root of its own,
  // re-rooted under the sub-agent's prompt; the parent's result names its agent and chain tip.
  {
    const t0 = min(30);
    const s = new Session(st, { id: 'dusty-lantern', working_directory: REPO, created_at: sec(t0), title: 'Inventory of the repo' });
    const n0 = s.add(null, systemInfo('dl:si', t0 + 5));
    const u1 = s.add(n0, prompt('dl:u1', t0 + 1000, 'List every file in the repo.'));
    const sub = callId('dl:sub');
    const a1 = s.twin(u1, reply('dl:a1', t0 + 2000, 'I will ask an explorer.', { calls: [[sub, 'run_subagent', { profile: 'Explore', task: 'List every file.' }]] }));
    s.save(a1, t0 + 2100);
    const AGENT = hex('agent:dl').slice(0, 8);
    const task0 = s.add(null, prompt('dl:task', t0 + 2200, `Explore the repository at ${REPO} and list every file in it.`));
    const sp = s.add(null, sysPrompt('dl:subprompt', t0 + 2150, 'You are a subagent of Devin. You are running in Explore mode (synthetic).', 'subagent_explore'), PREFIX);
    const task = s.copy(sp, [task0]);
    s.head(AGENT, task, t0 + 2200);
    const ls = callId('dl:ls');
    const sa1 = s.twin(task, reply('dl:sa1', t0 + 2400, '', { calls: [[ls, 'exec', { command: 'ls -R' }]], model: 'Subagent Default', metrics: [600, 12, 0] }));
    s.head(AGENT, sa1, t0 + 2400);
    const sr1 = s.add(sa1, result('dl:sr1', t0 + 2600, ls, `Output from command in shell ${terminal('dl:ls')}:\ncart.py\ntest_cart.py\n\nExit code: 0`, shellOut('dl:ls', 'cart.py\ntest_cart.py\n', 0)));
    s.state(ls, 'exec', 'completed', {}, { command: 'ls -R' });
    const sa2 = s.twin(sr1, reply('dl:sa2', t0 + 2800, 'cart.py and test_cart.py.', { model: 'Subagent Default', metrics: [700, 9, 0] }));
    s.head(AGENT, sa2, t0 + 2800);
    const res = s.add(a1, result('dl:res', t0 + 3000, sub, `Subagent agent_id=${AGENT} completed successfully:\n\ncart.py and test_cart.py.`, {
      'subagent/model': 'Subagent Default', 'subagent/agent_id': AGENT, 'subagent/chain_node_id': sa2, 'subagent/profile_name': 'Explore',
    }, 'run_subagent'));
    s.unhead(AGENT);
    s.state(sub, 'run_subagent', 'completed', {}, { profile: 'Explore' });
    const a2 = s.twin(res, reply('dl:a2', t0 + 4000, 'Two files: cart.py and test_cart.py.', { metrics: [1500, 11, 12000] }));
    s.save(a2, t0 + 4100);
  }

  // eager-falcon: the hidden summary-agent session a fork spawns (hidden=1, cwd /).
  {
    const t0 = min(40);
    const s = new Session(st, { id: 'eager-falcon', working_directory: '/', created_at: sec(t0), title: 'Summary of the forked session', hidden: 1, agent_mode: 'accept-edits' });
    const p = s.add(null, sysPrompt('ef:prompt', t0, 'You are a Summarizer (synthetic).'), PREFIX);
    const u1 = s.add(p, prompt('ef:u1', t0 + 100, 'Summarize the conversation so far for a fork.'));
    const a1 = s.twin(u1, reply('ef:a1', t0 + 2000, '<summary>The user fixed the qty bug in cart.py.</summary>', { thinking: '', metrics: [2500, 40, null] }));
    s.save(a1, t0 + 2100);
  }

  // fern-tundra: an image with its caption (the model saw a placeholder, the user typed the
  // prompt),
  // a slash skill (the stored content is the expanded body), a local command reply, and a reply cut
  // by the user, then the interrupt notice.
  {
    const t0 = min(50);
    const s = new Session(st, { id: 'fern-tundra', working_directory: REPO, created_at: sec(t0), title: 'Label and skill', agent_mode: 'accept-edits' });
    const n0 = s.add(null, systemInfo('ft:si', t0 + 5));
    const png = Buffer.from('PNG-TOY-LABEL-240x120').toString('base64');
    const img = '/tmp/devin-pasted-images/toy-label.png';
    const u1 = s.add(n0, prompt('ft:u1', t0 + 1000, `[Image 1: ${img}]\n\nDescribe this label image in two sentences. Do not use tools.`, {
      typed: 'Describe this label image in two sentences. Do not use tools.',
      images: [{ width: 240, height: 120, base64_data: png, mime_type: 'image/png', source_path: img, caption: 'A red square and a blue circle above the text "SKU-0042".' }],
    }));
    const a1 = s.twin(u1, reply('ft:a1', t0 + 3000, 'The label shows a red square and a blue circle. Below them it reads SKU-0042.', { metrics: [1800, 20, 12000] }));
    const u2 = s.add(a1, prompt('ft:u2', t0 + 60000, '1. Run: find . -name "*.py" -not -path "./.git/*" | wc -l\n2. Report the number in one sentence.', { typed: '/toy-count ' }));
    const a2 = s.twin(u2, reply('ft:a2', t0 + 62000, 'There are 4 Python files in the repository.', { metrics: [2000, 10, 12000] }));
    const u3 = s.add(a2, prompt('ft:u3', t0 + 70000, '/wd2', { typed: '/wd2' }));
    const a3 = s.add(u3, reply('ft:a3', t0 + 70010, 'Unknown command: /wd2. Use /help to see available commands.', { inference: false }));
    const u4 = s.add(a3, prompt('ft:u4', t0 + 80000, 'Explain the cart module in detail.'));
    const a4 = s.twin(u4, reply('ft:a4', t0 + 81000, 'The cart module defines Item and Cart. Cart keeps', { fr: null, metrics: null }));
    const mk = s.add(a4, sys('ft:interrupt', t0 + 83000, '[Response interrupted by user]'));
    s.save(mk, t0 + 83100);
  }

  // gentle-harvest: a reply with two calls, one result stored: the reply is held at the tail.
  {
    const t0 = min(60);
    const s = new Session(st, { id: 'gentle-harvest', working_directory: REPO, created_at: sec(t0), title: 'Running tests' });
    const n0 = s.add(null, systemInfo('gh:si', t0 + 5));
    const u1 = s.add(n0, prompt('gh:u1', t0 + 1000, 'Run the slow tests and read README.md.'));
    const slow = callId('gh:slow');
    const rd = callId('gh:read');
    const a1 = s.twin(u1, reply('gh:a1', t0 + 2000, 'Running both.', { calls: [[slow, 'exec', { command: 'python3 -m unittest tests.test_slow' }], [rd, 'read', { file_path: 'README.md' }]] }));
    const r1 = s.add(a1, result('gh:r1', t0 + 2300, rd, 'A tiny synthetic shop model used to exercise coding agents.', {}, 'read'));
    s.state(rd, 'read', 'completed', {}, { file_path: `${REPO}/README.md` });
    s.save(r1, t0 + 2400);
  }

  // hollow-pine: a tail reply whose row has no finish_reason yet: held.
  {
    const t0 = min(70);
    const s = new Session(st, { id: 'hollow-pine', working_directory: REPO, created_at: sec(t0), title: 'Long answer' });
    const n0 = s.add(null, systemInfo('hp:si', t0 + 5));
    const u1 = s.add(n0, prompt('hp:u1', t0 + 1000, 'Print the numbers 1 to 50, one per line.'));
    const a1 = s.twin(u1, reply('hp:a1', t0 + 2000, '1\n2\n3\n4\n5', { fr: null, metrics: null }));
    s.add(u1, keepalive('hp:keepalive', t0 + 2001));
    s.save(a1, t0 + 2100);
  }

  // idle-quarry: a session saved before its first turn: no main_chain_id, no nodes.
  new Session(st, { id: 'idle-quarry', working_directory: `${HOME}/work/inventory-cli`, created_at: sec(min(80)), title: null, model: '', agent_mode: '' });

  return st;
}

// ---- the switch-compaction case -----------------------------------------------------------------

// keen-ridge: a mode switch, then a compaction. The first turn runs in the original root, and a
// second turn there is abandoned (a revert: main_chain_id moves back, the turn stays in the table).
// The mode-switch shape (as amber-harbor) copies the whole chain under a new prefix, each copy
// naming its original, so the old root keeps the originals and the abandoned turn. A /compact (as
// calm-orchard) then summarizes the switched line and re-roots it again, its prefix copy naming the
// switched line's context node. The compacted history is the switched line, and the old root is
// named only through that history's copies: the shape in which a compacted history that tears
// leaves the old root out with it, the abandoned turn included (test/devin.test.js).
function switchCompaction() {
  const st = new Store();
  const t0 = min(0);
  const s = new Session(st, { id: 'keen-ridge', working_directory: REPO, created_at: sec(t0), title: 'Discount rounding' });
  const n0 = s.add(null, systemInfo('kr:si', t0 + 5));
  const u1 = s.add(n0, prompt('kr:u1', t0 + 1000, 'How does Cart.total round a discount?'));
  const a1 = s.twin(u1, reply('kr:a1', t0 + 3000, 'It sums integer cents, so nothing is rounded yet.', { metrics: [900, 12, 12000] }));
  s.save(a1, t0 + 3100);
  // The abandoned turn: answered, then reverted to the first answer.
  const ou = s.add(a1, prompt('kr:old-u', t0 + 20000, 'Round discounts down to the cent.'));
  const oa = s.twin(ou, reply('kr:old-a', t0 + 21000, 'Discounts would round down to the cent.', { metrics: [950, 10, 12000] }));
  s.save(oa, t0 + 21100);
  s.save(a1, t0 + 30000);
  // The mode switch: the whole chain copied under a new prefix.
  const pre = s.prefix('kr:prefix', t0 + 40000);
  const c0 = s.copy(pre, [n0]);
  const sw = s.copy(c0, [u1, a1]);
  s.save(sw, t0 + 40100);
  const u2 = s.add(sw, prompt('kr:u2', t0 + 60000, 'Round discounts half up instead.'));
  const a2 = s.twin(u2, reply('kr:a2', t0 + 62000, 'Discounts now round half up to the cent.', { metrics: [1400, 11, 12000] }));
  s.save(a2, t0 + 62100);
  // /compact: the summarizer chain, the compactor's summary of a2, the line re-rooted under a new
  // prefix with the continuation, then a turn.
  const sroot = s.add(null, sysPrompt('kr:summarizer', t0 + 90000, 'You are a Summarizer that summarizes an agent\'s execution trace (synthetic).'), PREFIX);
  const su = s.add(sroot, { message_id: uuid('kr:su'), role: 'user', content: 'Summarize the trace above.', metadata: md(t0 + 90001, { source: 'user', operation: 'unknown' }) });
  const SUMMARY = '<summary>\n1. Request and Intent: the user asked how discounts round; they now round half up.\n</summary>';
  s.add(su, reply('kr:summary', t0 + 91000, SUMMARY, { thinking: '', metrics: [2600, 900, null], model: 'compactor' }), { summarized_from: a2, num_tokens_preceding: null, is_system_prefix: null });
  const pre2 = s.prefix('kr:prefix2', t0 + 91100);
  const rr = s.copy(pre2, [c0]);
  const cont = s.add(rr, sys('kr:cont', t0 + 91200, `You are continuing work from a previous conversation thread. Below is a summary of the previous conversation thread:\nFull conversation history saved at ${HOME}/.local/share/devin/cli/summaries/history_toy.md.\nSummary:\n${SUMMARY}`, {
    'chisel/conversation_history': { messages: [{ role: 'user', message: 'Round discounts half up instead.' }, { role: 'assistant', message: 'Discounts now round half up to the cent.' }] },
    'devin-rs/summary': { source: 'file_compactor' },
  }), { summarized_from: a2, num_tokens_preceding: null, is_system_prefix: null });
  const u3 = s.add(cont, prompt('kr:u3', t0 + 100000, 'Add a test for the half-up rounding.'));
  const a3 = s.twin(u3, reply('kr:a3', t0 + 101000, 'Added tests/test_rounding.py.', { metrics: [2000, 9, 12000] }));
  s.save(a3, t0 + 101100);
  return st;
}

function write(name, store) {
  const dir = path.join(HERE, name, 'store-sql');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, REL);
  fs.writeFileSync(`${base}.schema.sql`, SCHEMA);
  fs.writeFileSync(`${base}.ops.jsonl`, store.ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  write('features', features());
  write('switch-compaction', switchCompaction());
}
