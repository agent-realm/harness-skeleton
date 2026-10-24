#!/usr/bin/env node
// Writes the OpenCode fixture cases as text: for each database, `store-sql/<db>.schema.sql` and
// `store-sql/<db>.ops.jsonl` (conformance/sql-store.js builds them at test time), plus plain files
// under `store/` (spilled tool outputs). Run: node fixtures/opencode/generate.js
//
// Cases:
// - basic, v2: lab captures (OpenCode 1.19.3, pass 1 and pass 3), environment strings replaced
//   outside this repository, converted to ops once. This script writes only their schema; their
//   ops are committed as they are. In v2, the assistant row a committed revert deleted is rebuilt
//   from its own events (seq 25-28) so the ops can show it being deleted.
// - features, edits, nested, sentinel: generated here, in the shape of the pass 3 captures. All
//   text is synthetic.
//
// The schema is not OpenCode's own DDL: it is rebuilt from the adapter spec (§3; in the fixture
// captures, synthetic, captured on a test VM) and the captured rows' columns,
// with the indexes the reads lean on.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMA = `-- OpenCode 1.19.3 tables, rebuilt from the adapter spec (§3) and the captured rows; not the
-- harness's own DDL. The credential table is never queried by the adapter.
PRAGMA journal_mode=WAL;
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real NOT NULL DEFAULT 0, tokens_input integer NOT NULL DEFAULT 0, tokens_output integer NOT NULL DEFAULT 0, tokens_reasoning integer NOT NULL DEFAULT 0, tokens_cache_read integer NOT NULL DEFAULT 0, tokens_cache_write integer NOT NULL DEFAULT 0, revert text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE INDEX part_message_id_id_idx ON part (message_id, id);
CREATE INDEX part_session_idx ON part (session_id);
CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL);
CREATE UNIQUE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq);
CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq);
CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
CREATE TABLE session_input (id text PRIMARY KEY, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, admitted_seq integer NOT NULL, promoted_seq integer, time_created integer NOT NULL);
CREATE TABLE credential (id text PRIMARY KEY, provider_id text NOT NULL, data text NOT NULL);
`;

// ---- ids and rows in OpenCode's shape --------------------------------------------------------

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** An ascending OpenCode id minted at `ms`: prefix_ + 12 hex (low 48 bits of ms·4096 + c) + 14 base62. */
export function mkId(prefix, ms, c = 1, seed = '') {
  const v = (BigInt(ms) * 4096n + BigInt(c)) & ((1n << 48n) - 1n);
  const h = crypto.createHash('sha256').update(`${prefix}${ms}${c}${seed}`).digest();
  let tail = '';
  for (let i = 0; i < 14; i++) tail += B62[h[i] % 62];
  return `${prefix}_${v.toString(16).padStart(12, '0')}${tail}`;
}

export const T0 = 1792588654538; // 2026-10-21T13:17:34.538Z
const MODEL = { providerID: 'fake', modelID: 'fake-1' };
const PATH = { cwd: '/home/user/work/toyshop', root: '/home/user/work/toyshop' };
const SNAP = '43f163d699fd8db3219884d0ed7ba8fade45eb44';

// One database's statements, in the order OpenCode writes them: a message row on creation, its
// parts, then the message updated in place when the step completes.
class Ops {
  constructor() {
    this.ops = [];
    this.n = 0;
    this.seq = new Map();
  }
  run(sql, params) {
    this.ops.push({ sql, params });
  }
  session(id, t, extra = {}) {
    const row = {
      id, project_id: 'cd60d406137fa6bbc934bbd5e36785c009e49b21', parent_id: null, slug: 'swift-falcon', directory: '/home/user/work/toyshop',
      path: '', title: 'Toy cart work', version: '1.19.3', revert: null, agent: 'build', model: JSON.stringify({ id: 'fake-1', providerID: 'fake' }),
      time_created: t, time_updated: t, time_archived: null, ...extra,
    };
    const cols = Object.keys(row);
    this.run(`INSERT INTO session (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
    this.event(id, 'session.created.1', { sessionID: id, info: { id, title: row.title, directory: row.directory, version: row.version } }, t);
    return id;
  }
  sessionUpdate(id, set, t) {
    const cols = Object.keys(set);
    this.run(`UPDATE session SET ${cols.map((c) => `${c} = ?`).join(', ')}, time_updated = ? WHERE id = ?`, [...cols.map((c) => set[c]), t, id]);
  }
  event(sid, type, data, t) {
    const seq = this.seq.has(sid) ? this.seq.get(sid) + 1 : 0;
    this.seq.set(sid, seq);
    const id = mkId('evt', t, (seq % 4000) + 1, `${sid}${seq}`);
    this.run('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)', [id, sid, seq, type, JSON.stringify(data)]);
    return id;
  }
  // `idT`: when the id was minted, if not at `t` (a fork's copies keep the source's time_created).
  message(sid, t, data, seed, idT = t) {
    const id = mkId('msg', idT, 1, `${sid}${seed}`);
    this.run('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)', [id, sid, t, t + 3, JSON.stringify(data)]);
    return id;
  }
  messageUpdate(id, data, t) {
    this.run('UPDATE message SET data = ?, time_updated = ? WHERE id = ?', [JSON.stringify(data), t, id]);
  }
  part(sid, mid, t, data) {
    this.n += 1;
    const id = mkId('prt', t, (this.n % 4000) + 1, `${mid}${this.n}`);
    this.run('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)', [id, mid, sid, t, t + 2, JSON.stringify(data)]);
    return id;
  }
  // A user message and its parts: [{t, data}].
  user(sid, t, parts, model = MODEL, seed = '') {
    const id = this.message(sid, t, { role: 'user', time: { created: t }, agent: 'build', model }, `u${t}${seed}`);
    const ids = parts.map((p, k) => this.part(sid, id, t + k, p));
    return { id, parts: ids };
  }
  // An assistant message: created streaming, its parts, then completed in place (unless `open`).
  assistant(sid, t, parent, parts, { extra = {}, open = false, tokens = null, seed = '' } = {}) {
    const base = { parentID: parent, role: 'assistant', mode: 'build', agent: 'build', path: PATH, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, modelID: 'fake-1', providerID: 'fake', time: { created: t } };
    const id = this.message(sid, t, base, `a${t}${seed}`);
    const ids = parts.map((p, k) => this.part(sid, id, t + 1 + k * 10, p));
    if (!open) {
      const tok = tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      this.messageUpdate(id, { ...base, tokens: tok, time: { created: t, completed: t + 900 }, finish: 'stop', ...extra }, t + 900);
    }
    return { id, parts: ids };
  }
}

const text = (s, extra = {}) => ({ type: 'text', text: s, ...extra });
const reasoning = (s, t) => ({ type: 'reasoning', text: s, time: { start: t, end: t + 5 } });
const stepStart = () => ({ type: 'step-start', snapshot: SNAP });
const tokens = ([input, output, reasoningN = 0, read = 0]) => ({ total: input + output + reasoningN + read, input, output, reasoning: reasoningN, cache: { read, write: 0 } });
const finish = (tok, reason = 'stop') => ({ type: 'step-finish', reason, snapshot: SNAP, tokens: tokens(tok), cost: 0 });
function bash(cmd, out, t, { exit = 0, callID, metadata } = {}) {
  return {
    type: 'tool', tool: 'bash', callID: callID ?? `call_${crypto.createHash('md5').update(cmd + t).digest('hex').slice(0, 10)}`,
    state: { status: 'completed', input: { command: cmd }, output: out, metadata: metadata ?? { output: out, exit, truncated: false }, title: cmd, time: { start: t, end: t + 5 } },
  };
}
// A plain turn: user text, then an assistant with one text part between step parts.
function turn(db, sid, t, ask, answer, tok = [900, 23, 0, 300]) {
  const u = db.user(sid, t, [text(ask)]);
  const a = db.assistant(sid, t + 1000, u.id, [stepStart(), text(answer), finish(tok)], { tokens: tokens(tok) });
  return { u, a };
}

const PNG = Buffer.from('\x89PNG\r\n\x1a\n synthetic label for the toyshop cart', 'latin1');
const SPILL_LINES = Array.from({ length: 400 }, (_, i) => `${i + 1}_cart_line_qty_ok`).join('\n') + '\n';
const DATA_HOME = '/home/user/.local/share/opencode';

// ---- features: v1 records, links, shell mode, a fork, a v2 spill ------------------------------

function features() {
  const db = new Ops();
  const files = {};

  // A: tool turns, reasoning, files, a spilled output, errors in tool parts, a dead run, a held
  // reply.
  const A = db.session(mkId('ses', T0, 1, 'A'), T0, { title: 'Toy cart work' });
  const u1 = db.user(A, T0 + 1000, [
    text('Fix the qty bug in cart.py, then run the tests.'),
    { type: 'file', mime: 'text/plain', filename: 'README.md', url: 'file:///home/user/work/toyshop/README.md' },
    { type: 'file', mime: 'image/png', filename: 'label.png', url: `data:image/png;base64,${PNG.toString('base64')}` },
  ], { ...MODEL, variant: 'high' });
  db.assistant(A, T0 + 2000, u1.id, [
    stepStart(), reasoning('The total ignores qty.', T0 + 2010),
    bash('python3 -m pytest -q', '1 failed', T0 + 2020, { exit: 1 }),
    text('Fixed: total multiplies by qty; one test still fails.'),
    { type: 'patch', hash: 'f547bb1ed2a865f573826d0460f83bd3a01ce47d', files: ['/home/user/work/toyshop/cart.py'] },
    finish([900, 23, 17, 300], 'tool-calls'),
  ], { tokens: tokens([900, 23, 17, 300]), extra: { finish: 'tool-calls' } });
  const spillId = mkId('tool', T0 + 3015, 1, 'spill');
  files[`tool-output/${spillId}`] = SPILL_LINES;
  db.assistant(A, T0 + 3000, u1.id, [
    stepStart(),
    bash('seq 1 400 | sed s/$/_cart_line_qty_ok/', `...output truncated...\n\nFull output saved to: ${DATA_HOME}/tool-output/${spillId}\n\n399_cart_line_qty_ok\n400_cart_line_qty_ok\n`, T0 + 3010,
      { metadata: { output: '...', exit: 0, truncated: true, outputPath: `${DATA_HOME}/tool-output/${spillId}` } }),
    bash('cat /etc/passwd', 'x', T0 + 3020, { metadata: { output: 'x', exit: 0, truncated: true, outputPath: '/etc/passwd' } }),
    {
      type: 'tool', tool: 'read', callID: 'call_fake_scn_readimg_1_0',
      state: {
        status: 'completed', input: { filePath: '/home/user/work/toyshop/label.png' }, output: 'Image read successfully',
        metadata: { preview: 'Image read successfully', truncated: false, loaded: [] }, title: 'label.png', time: { start: T0 + 3030, end: T0 + 3040 },
        attachments: [{ type: 'file', mime: 'image/png', url: `data:image/png;base64,${PNG.toString('base64')}`, id: mkId('prt', T0 + 3041, 9, 'att') }],
      },
    },
    { type: 'tool', tool: 'read', callID: 'chatcmpl-tool-FixtureFixt00049', state: { status: 'error', input: { filePath: '/home/user/work/toyshop/carts.py' }, error: 'File not found: /home/user/work/toyshop/carts.py', time: { start: T0 + 3050, end: T0 + 3052 } } },
    { type: 'tool', tool: 'bash', callID: 'chatcmpl-tool-FixtureFixt00050', state: { status: 'error', input: { command: 'python3 stock.py' }, error: 'The user rejected permission to use this specific tool call.', time: { start: T0 + 3060, end: T0 + 3090 } } },
    finish([1000, 40, 0, 400], 'tool-calls'),
  ], { tokens: tokens([1000, 40, 0, 400]), extra: { finish: 'tool-calls' } });
  db.assistant(A, T0 + 4000, u1.id, [stepStart(), text('All tests pass now.'), finish([1100, 12, 0, 500])], { tokens: tokens([1100, 12, 0, 500]) });
  const u2 = db.user(A, T0 + 5000, [text('Also add a discount field.')]);
  // A dead run: never completed, and a later reply took over.
  db.assistant(A, T0 + 6000, u2.id, [stepStart(), text('Adding disc')], { open: true });
  db.assistant(A, T0 + 7000, u2.id, [stepStart(), text('Added a discount field.'), finish([1200, 15, 0, 600])], { tokens: tokens([1200, 15, 0, 600]) });
  const u3 = db.user(A, T0 + 8000, [text('Now add a coupon code.')]);
  // Still streaming: held.
  db.assistant(A, T0 + 9000, u3.id, [stepStart(), text('Adding a cou')], { open: true });

  // P and CH: a subtask command; the parent's task part names the child, the child its parent.
  const P = db.session(mkId('ses', T0 + 20000, 1, 'P'), T0 + 20000, { title: 'Review the cart' });
  const CH = mkId('ses', T0 + 23000, 1, 'CH');
  const call = '01M5FA14606SC8K5NP9K6CTMED';
  const ust = db.user(P, T0 + 21000, [{ type: 'subtask', agent: 'build', description: 'Review the cart in a subtask', command: 'review-sub', model: MODEL, prompt: 'Review cart.py for the qty bug.' }]);
  db.assistant(P, T0 + 21100, ust.id, [{
    type: 'tool', callID: call, tool: 'task',
    state: {
      status: 'completed', input: { prompt: 'Review cart.py for the qty bug.', description: 'Review the cart in a subtask', subagent_type: 'build', command: 'review-sub' },
      title: 'Review the cart in a subtask', metadata: { parentSessionId: P, sessionId: CH, model: MODEL, truncated: false },
      output: `<task id="${CH}" state="completed">\n<task_result>\nqty is fine.\n</task_result>\n</task>`, time: { start: T0 + 21110, end: T0 + 23900 },
    },
  }], { extra: { finish: 'tool-calls' } });
  db.session(CH, T0 + 23000, { parent_id: P, title: 'Review the cart in a subtask (@build subagent)', slug: 'swift-moon' });
  turn(db, CH, T0 + 23100, 'Review cart.py for the qty bug.', 'qty is fine.');
  const usum = db.user(P, T0 + 24000, [text('Summarize the task tool output above and continue with your task.', { synthetic: true })]);
  db.assistant(P, T0 + 24100, usum.id, [stepStart(), text('The sub-agent found qty fine.'), finish([900, 20, 0, 300])], { tokens: tokens([900, 20, 0, 300]) });

  // H: shell mode (a synthetic user message, an assistant with a bash part and no step parts) and
  // an
  // agent mention.
  const H = db.session(mkId('ses', T0 + 30000, 1, 'H'), T0 + 30000, { title: 'Shell and mentions' });
  const us = db.user(H, T0 + 31000, [text('The following tool was executed by the user', { synthetic: true })]);
  db.assistant(H, T0 + 31010, us.id, [bash('echo tui-shell-mode', 'tui-shell-mode\n', T0 + 31012, { callID: '01M5FAEW4AEJ4QVFJMH093YG1S', metadata: { output: 'tui-shell-mode\n' } })], { extra: { finish: undefined } });
  const um = db.user(H, T0 + 32000, [
    text('@cart-reviewer check the totals'),
    { type: 'agent', name: 'cart-reviewer', source: { value: '@cart-reviewer', start: 0, end: 14 } },
    text(' Use the above message and context to generate a prompt and call the task tool with subagent: cart-reviewer', { synthetic: true }),
  ]);
  db.assistant(H, T0 + 32100, um.id, [stepStart(), text('Totals look right.'), finish([900, 20, 0, 300])], { tokens: tokens([900, 20, 0, 300]) });

  // F: a fork of A at its second message (new ids, the source's time_created kept, a `(fork #1)`
  // title), later archived. No pointer to A: no link.
  const F = db.session(mkId('ses', T0 + 60000, 1, 'F'), T0 + 60000, { title: 'Toy cart work (fork #1)', slug: 'brave-lagoon' });
  const fu = db.message(F, T0 + 1000, { role: 'user', time: { created: T0 + 1000 }, agent: 'build', model: { ...MODEL, variant: 'high' } }, 'fork-u', T0 + 60005);
  db.part(F, fu, T0 + 60010, text('Fix the qty bug in cart.py, then run the tests.'));
  db.part(F, fu, T0 + 60011, { type: 'file', mime: 'text/plain', filename: 'README.md', url: 'file:///home/user/work/toyshop/README.md' });
  db.part(F, fu, T0 + 60012, { type: 'file', mime: 'image/png', filename: 'label.png', url: `data:image/png;base64,${PNG.toString('base64')}` });
  db.sessionUpdate(F, { time_archived: T0 + 99000 }, T0 + 99000);

  // V: a v2 session whose tool spilled its output, with a revert staged and not committed.
  const V = db.session(mkId('ses', T0 + 70000, 1, 'V'), T0 + 70000, { title: 'New session - 2026-10-21T13:18:44.538Z', slug: 'quick-harbor' });
  const v2spill = mkId('tool', T0 + 72020, 1, 'v2spill');
  files[`tool-output/${v2spill}`] = 'line 1 of the v2 spill\nline 2 of the v2 spill\n';
  let seq = 0;
  const sm = (type, t, data) => {
    seq += 1;
    const id = mkId('msg', t, 1, `V${seq}`);
    db.run('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, V, type, seq, t, t + 5, JSON.stringify(data)]);
    return id;
  };
  const vu = sm('user', T0 + 71000, { time: { created: T0 + 71000 }, text: 'Print every cart line.' });
  db.run('INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created) VALUES (?, ?, ?, ?, ?, ?, ?)', [vu, V, JSON.stringify({ text: 'Print every cart line.' }), 'queue', 0, 1, T0 + 71000]);
  sm('assistant', T0 + 72000, {
    time: { created: T0 + 72000, completed: T0 + 72500 }, agent: 'build', model: { id: 'fake-1', providerID: 'fake', variant: 'high' },
    content: [
      { type: 'reasoning', id: 'reasoning-0', text: 'Many lines: the output will spill.', time: { created: T0 + 72001, completed: T0 + 72010 } },
      { type: 'tool', id: 'call_fake_scn_bigout_v2', name: 'bash', provider: { executed: false }, state: { status: 'completed', input: { command: 'cat cart_lines.txt' }, content: [{ type: 'text', text: '...output truncated...\nline 2 of the v2 spill\n' }], outputPaths: [`${DATA_HOME}/tool-output/${v2spill}`], structured: { exit: 0, truncated: true } }, time: { created: T0 + 72020, ran: T0 + 72030, completed: T0 + 72100 } },
      { type: 'text', id: 'text-0', text: 'The lines are in the spilled output.' },
    ],
    finish: 'stop', cost: 0, tokens: { input: 900, output: 40, reasoning: 12, cache: { read: 300, write: 0 } },
  });
  const vu2 = sm('user', T0 + 73000, { time: { created: T0 + 73000 }, text: 'Now count them.' });
  sm('assistant', T0 + 74000, { time: { created: T0 + 74000, completed: T0 + 74300 }, agent: 'build', model: { id: 'fake-1', providerID: 'fake' }, content: [{ type: 'text', id: 'text-0', text: '400 lines.' }], finish: 'stop', cost: 0, tokens: { input: 900, output: 5, reasoning: 0, cache: { read: 300, write: 0 } } });
  db.event(V, 'session.next.revert.staged.1', { timestamp: T0 + 75000, sessionID: V, revert: { messageID: vu2, snapshot: SNAP, diff: '', files: [] } }, T0 + 75000);
  return { dbs: { 'opencode.db': db }, files };
}

// ---- edits: compaction (with the overflow path), an edit, a revert at a message and at a part ---

function edits() {
  const db = new Ops();

  // C: auto compaction after an overflow; the summary replaces everything before tail_start_id, and
  // the original prompt is re-inserted.
  const C = db.session(mkId('ses', T0, 1, 'C'), T0, { title: 'Compaction work' });
  const t1 = turn(db, C, T0 + 1000, 'Fix the qty bug.', 'Fixed qty.');
  const u2 = db.user(C, T0 + 5000, [text('Add a coupon code to the cart.')]);
  db.assistant(C, T0 + 6000, u2.id, [], { extra: { finish: undefined } }); // overflow: completed, no finish, no parts
  const uc = db.user(C, T0 + 7000, [{ type: 'compaction', auto: true, overflow: true, tail_start_id: u2.id }]);
  db.assistant(C, T0 + 7100, uc.id, [stepStart(), text('Summary: qty fixed in cart.py; next, a coupon code.'), finish([900, 40, 0, 300])], { tokens: tokens([900, 40, 0, 300]), extra: { mode: 'compaction', agent: 'compaction', summary: true } });
  const ucont = db.user(C, T0 + 8000, [text('Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.', { synthetic: true, metadata: { compaction_continue: true } })]);
  void ucont;
  const u2b = db.user(C, T0 + 8100, [text('Add a coupon code to the cart.')]);
  db.assistant(C, T0 + 9000, u2b.id, [stepStart(), text('Added a coupon code.'), finish([900, 30, 0, 300])], { tokens: tokens([900, 30, 0, 300]) });
  void t1;

  // E: revert to turn 2, then a prompt while reverted: turn 2's rows are deleted and
  // `message.removed` events name them.
  const E = db.session(mkId('ses', T0 + 20000, 1, 'E'), T0 + 20000, { title: 'Edit work' });
  turn(db, E, T0 + 21000, 'Fix the qty bug in cart.py.', 'Fixed: total multiplies by qty.');
  const e2 = turn(db, E, T0 + 25000, 'Also add a discount field.', 'Added discount.', [1000, 20, 0, 400]);
  db.sessionUpdate(E, { revert: JSON.stringify({ messageID: e2.u.id, snapshot: SNAP, diff: '' }) }, T0 + 29000);
  const tE = T0 + 30000;
  for (const mid of [e2.u.id, e2.a.id]) {
    db.run('DELETE FROM part WHERE message_id = ?', [mid]);
    db.run('DELETE FROM message WHERE id = ?', [mid]);
  }
  db.event(E, 'message.removed.1', { sessionID: E, messageID: e2.u.id }, tE);
  db.event(E, 'message.removed.1', { sessionID: E, messageID: e2.a.id }, tE);
  db.sessionUpdate(E, { revert: null }, tE);
  turn(db, E, tE + 50, 'Instead, add a coupon code.', 'Added a coupon code.', [1100, 25, 0, 450]);

  // R: a revert at a part, still in force: that message's later parts and every later message are
  // reverted.
  const R = db.session(mkId('ses', T0 + 40000, 1, 'R'), T0 + 40000, { title: 'Revert at a part' });
  const ru = db.user(R, T0 + 41000, [text('Fix the qty bug in cart.py, then run the tests.')]);
  const ra = db.assistant(R, T0 + 42000, ru.id, [
    stepStart(), reasoning('The total ignores qty.', T0 + 42010),
    bash('python3 -m pytest -q', '3 passed', T0 + 42020),
    text('Fixed and tested.'), finish([900, 23, 17, 300]),
  ], { tokens: tokens([900, 23, 17, 300]) });
  turn(db, R, T0 + 45000, 'Also add a discount field.', 'Added discount.');
  db.sessionUpdate(R, { revert: JSON.stringify({ messageID: ra.id, partID: ra.parts[2], snapshot: SNAP }) }, T0 + 49000);

  // RV: a revert at a message, still in force.
  const RV = db.session(mkId('ses', T0 + 50000, 1, 'RV'), T0 + 50000, { title: 'Revert at a message' });
  turn(db, RV, T0 + 51000, 'Fix the qty bug.', 'Fixed qty.');
  const rv2 = turn(db, RV, T0 + 53000, 'Also add a discount field.', 'Added discount.');
  db.sessionUpdate(RV, { revert: JSON.stringify({ messageID: rv2.u.id, snapshot: SNAP }) }, T0 + 55000);
  return { dbs: { 'opencode.db': db }, files: {} };
}

// ---- nested: a folder store beside two file stores in its data folder --------------------------

function nested() {
  const main = new Ops();
  const N = main.session(mkId('ses', T0, 1, 'N'), T0, { title: 'Default channel work' });
  const nt = turn(main, N, T0 + 1000, 'List the cart files.', 'cart.py and test_cart.py.');
  // The beta channel: its own session with a spilled output, and N imported (the same ids).
  const beta = new Ops();
  const B = beta.session(mkId('ses', T0 + 10000, 1, 'B'), T0 + 10000, { title: 'Beta channel work' });
  const spillId = mkId('tool', T0 + 11020, 1, 'betaspill');
  const bu = beta.user(B, T0 + 11000, [text('Print every cart line.')]);
  beta.assistant(B, T0 + 11010, bu.id, [
    stepStart(),
    bash('seq 1 400 | sed s/$/_cart_line_qty_ok/', '...output truncated...\n\n400_cart_line_qty_ok\n', T0 + 11020,
      { metadata: { output: '...', exit: 0, truncated: true, outputPath: `${DATA_HOME}/tool-output/${spillId}` } }),
    finish([900, 10, 0, 300]),
  ], { tokens: tokens([900, 10, 0, 300]) });
  // The import copies the main store's rows: same session, message and part ids.
  for (const op of main.ops) if (!/^INSERT INTO event/.test(op.sql)) beta.ops.push(op);
  void nt;
  // An OPENCODE_DB file kept in the data folder: a store of its own as well.
  const custom = new Ops();
  const X = custom.session(mkId('ses', T0 + 20000, 1, 'X'), T0 + 20000, { title: 'Custom database work' });
  turn(custom, X, T0 + 21000, 'Custom database prompt.', 'Custom reply.');
  return { dbs: { 'opencode.db': main, 'opencode-beta.db': beta, 'custom-oc.db': custom }, files: { [`tool-output/${spillId}`]: SPILL_LINES } };
}

// ---- sentinel: what read redacts is gone; free text keeps its sentinel (sessions-model §4.6) ---

function sentinel() {
  const db = new Ops();
  const S = db.session(mkId('ses', T0, 1, 'S'), T0, { title: 'Sentinel work' });
  const u1 = db.user(S, T0 + 1000, [
    text('Deploy with the key OCSENTINEL-free-text-1 please.'),
    { type: 'file', mime: 'application/pdf', filename: 'spec.pdf', url: 'https://files.example.com/spec.pdf?token=OCSENTINEL-url-token&x=1' },
    { type: 'file', mime: 'text/plain', url: 'mcp:resource?key=OCSENTINEL-mcp-key' },
    { type: 'file', mime: 'text/plain', url: 'C:\\work\\toyshop\\cart.py' },
    { type: 'file', mime: 'text/markdown', url: 'docs/spec.md' },
    { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///home/user/work/toyshop/notes.txt', source: { type: 'resource', clientName: 'docs', uri: 'https://docs.example.com/r/1?sig=OCSENTINEL-resource-uri', text: { value: '@notes', start: 0, end: 6 } } },
  ]);
  db.assistant(S, T0 + 2000, u1.id, [], {
    extra: {
      finish: undefined,
      error: {
        name: 'APIError',
        data: {
          message: 'fake invalid api credentials', statusCode: 401, isRetryable: false,
          responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'session=OCSENTINEL-header-cookie' },
          responseBody: '{"error": {"message": "fake invalid api credentials", "detail": "OCSENTINEL-body"}}',
          metadata: { url: 'http://127.0.0.1/v1/chat/completions?sig=OCSENTINEL-meta-url' },
        },
      },
    },
  });
  const u2 = db.user(S, T0 + 3000, [text('Read the label image from the docs site.')]);
  db.assistant(S, T0 + 4000, u2.id, [
    stepStart(),
    { type: 'retry', attempt: 1, error: { name: 'APIError', data: { message: 'rate limited', statusCode: 429, isRetryable: true, responseHeaders: { 'retry-after': '1', 'x-request-id': 'OCSENTINEL-retry-header' }, responseBody: 'OCSENTINEL-retry-body' } }, time: { created: T0 + 4005 } },
    {
      type: 'tool', tool: 'webfetch', callID: 'call_fake_scn_fetch_1_0',
      state: {
        status: 'completed', input: { url: 'https://docs.example.com/label.png' }, output: 'Fetched label.png', metadata: { truncated: false }, title: 'label.png', time: { start: T0 + 4010, end: T0 + 4020 },
        attachments: [{ type: 'file', mime: 'image/png', url: 'https://cdn.example.com/label.png?X-Amz-Signature=OCSENTINEL-att-sig', id: mkId('prt', T0 + 4021, 9, 'satt') }],
      },
    },
    text('The label is fetched.'), finish([900, 10, 0, 300]),
  ], { tokens: tokens([900, 10, 0, 300]) });
  db.run('INSERT INTO credential (id, provider_id, data) VALUES (?, ?, ?)', ['cred_fake', 'fake', JSON.stringify({ type: 'api', key: 'OCSENTINEL-credential-key' })]);
  return { dbs: { 'opencode.db': db }, files: {} };
}

// ---- writing -----------------------------------------------------------------------------------

function writeCase(name, { dbs, files }) {
  const dir = path.join(HERE, name);
  fs.rmSync(path.join(dir, 'store-sql'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'store'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'store-sql'), { recursive: true });
  for (const [rel, db] of Object.entries(dbs)) {
    fs.writeFileSync(path.join(dir, 'store-sql', `${rel}.schema.sql`), SCHEMA);
    fs.writeFileSync(path.join(dir, 'store-sql', `${rel}.ops.jsonl`), db.ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
  }
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'store', rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'store', rel), body);
  }
  writeBinding(dir);
}

// Every OpenCode store is bound to its database file (sessions-model §1): the case's goldens and
// growth check read the default opencode.db as the store.
function writeBinding(dir) {
  fs.writeFileSync(path.join(dir, 'binding.json'), JSON.stringify({ harness_path: 'opencode.db' }) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  writeCase('features', features());
  writeCase('edits', edits());
  writeCase('channels', nested());
  writeCase('sentinel', sentinel());
  // The lab cases keep their committed ops; only their schema is written here.
  for (const name of ['basic', 'v2']) {
    fs.writeFileSync(path.join(HERE, name, 'store-sql', 'opencode.db.schema.sql'), SCHEMA);
    writeBinding(path.join(HERE, name));
  }
  console.log('opencode fixtures written');
}
