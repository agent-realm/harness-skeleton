// Writes the synthetic cursor-agent fixture stores: generated text only.
//   node fixtures/cursor-agent/generate.js
//
// A chat's store.db is text here (conformance/sql-store.js): `store-sql/<rel>.schema.sql` holds the
// DDL cursor-agent 2026.10.19 runs (its sqlite-blob-store, as the scrubbed lab capture's
// schema dump quotes it), and `store-sql/<rel>.ops.jsonl` the statements in
// the order cursor-agent runs them: a turn's blobs first, then the meta row naming the new root.
// Every protobuf blob is built here from a readable field tree by the encoder below (ported from
// memhouse's normaliser test), and every blob id is the sha256 of the
// bytes as encoded, so the content addresses hold.
//
// The blob shapes and field numbers follow the scrubbed lab captures and their descriptors (the
// the fixture captures, synthetic, captured on a test VM), and the cases port the
// reviewed behaviour of memhouse's normaliser test.
// Every id is synthetic: chat, request, user message and tool call ids are made here, of the
// captured length (the request, user message, parent agent and call ids the sessions-model annex
// describes have synthetic prefixes too), and the provider part of a call id (`fc_…`) is synthetic
// throughout.
//
// Cases written here:
//   features  one chat per behaviour the adapter claims: reasoning and text steps, typed and
//   untyped
//             tools with and without the model context, a shell-mode turn, a rejected command,
//             the credential tools (redacted in read), grep and MCP results, by-reference outputs,
//             an image, simulated user messages, a compaction with its summary archive, system
//             reminders; a chat whose last reply still runs (held); a refused first prompt (the
//             empty root); an ACP store.
//   subagent  a parent whose Task names its child, and the child store with its subagentInfo.
//   rewind    a chat rewound (its root moved back) and regrown, and a fork of it before the rewind.
//   orphan    the cursor-orphan conformance case: a transcript under projects/ whose chat store
//             was deleted. Its `store/projects/…` transcript is the scrubbed lab capture
//             (conformance-cursor-orphan), its workspace path set to this fixture's; it is not
//             written here.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The DDL cursor-agent runs on a new store.db (the scrubbed capture's schema dump, its
// first seven lines).
export const SCHEMA = `-- cursor-agent 2026.10.19 store.db, from ../cursor-sdk-local-runtime/dist/run-store/sqlite-blob-store.js (source)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB);   -- id = hex(sha256(data)); written with INSERT OR REPLACE
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);  -- only key "0": hex(utf8(JSON metadata)); INSERT OR REPLACE
`;

// ---- the protobuf encoder ---------------------------------------------------------------------

function varintBuf(n) {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
// fields: [[fieldNo, value]]; a number or boolean is a varint, a string or Buffer is bytes, an
// array a nested message. A null value is left out.
export function pb(fields) {
  const out = [];
  for (const [fn, v] of fields) {
    if (v == null) continue;
    if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
      out.push(varintBuf(fn * 8), varintBuf(v === true ? 1 : v === false ? 0 : v));
      continue;
    }
    const b = Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v, 'utf8') : pb(v);
    out.push(varintBuf(fn * 8 + 2), varintBuf(b.length), b);
  }
  return Buffer.concat(out);
}
export const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
export const ref = (id) => Buffer.from(id, 'hex');

// One chat's store.db as statements. A blob is inserted once, under the sha256 of its bytes.
export class Chat {
  constructor(dir) {
    this.dir = dir;
    this.ops = [];
    this.blobs = new Map();
  }

  put(buf) {
    const id = sha(buf);
    if (!this.blobs.has(id)) {
      this.blobs.set(id, buf);
      this.ops.push({ sql: 'INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)', params: [id, { $b64: buf.toString('base64') }] });
    }
    return id;
  }

  json(o) {
    return this.put(Buffer.from(JSON.stringify(o), 'utf8'));
  }

  meta(o) {
    this.ops.push({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('0', ?)", params: [Buffer.from(JSON.stringify(o), 'utf8').toString('hex')] });
  }

  // A fork: cursor-agent copies every blob into the new chat's store.
  copyBlobs(other) {
    for (const buf of other.blobs.values()) this.put(buf);
  }

  db() {
    return { [`${this.dir}/store.db`]: [SCHEMA, this.ops] };
  }
}

// ---- the conversation in the captures' shape ----------------------------------------------------

export const CWD = '/home/user/work/toyshop';
export const BUCKET = md5(CWD);
export const T0 = 1792508342390;
export const MODEL = 'cursor-grok-4.5-high';
// Sentinels: none of them may reach a unit or a record (sessions-model §4).
export const SECRET_META = 'SENTINEL-META-KEY-00000000000000000000000000000000000000000000000';
export const SECRET_ENC = 'SENTINEL-ENCRYPTED-MODEL-0000000000';
export const SECRET_SCOPE = 'SENTINEL-SECRET-SCOPE';
export const SECRET_ARG = 'SENTINEL-ENV-VALUE-0123456789';
export const SECRET_OUT = 'SENTINEL-ENV-RESULT-0123456789';
export const SECRET_PW = 'SENTINEL-PW-0123456789';

// Synthetic ids: a uuid with a fixed prefix, and a call
// id in cursor-agent's shape, `call-<uuid>-<n>\nfc_<provider id>`, all 36 + 36 characters long.
export const uid = (prefix, n) => `${prefix}-5a7e-4000-8000-${String(n).padStart(12, '0')}`;
const fc = (n) => `fc_synth${String(n).padStart(2, '0')}-0Synth-${String(n).padStart(8, '0')}-syn_th1_${n % 10}`;
export const call = (n, prefix = '00c41679') => `call-${prefix}-5a7e-4f00-8000-00000000c0de-${n}\n${fc(n)}`;

export const A = uid('c4a1e0de', 1); // features: the main chat
export const H = uid('c4a1e0de', 2); // features: the held chat
export const E = uid('88d522e2', 3); // features: the refused first prompt
export const ACP = uid('7a7a7a7a', 4); // features: an ACP store
export const P = uid('de1be1a9', 5); // subagent: the parent (annex: parentAgentId de1be1a9…)
export const SUB = uid('4924355d', 6); // subagent: the child
export const R = uid('5d0c1f9e', 7); // rewind: the chat
export const F = uid('3148427e', 8); // rewind: its fork
export const L = uid('ac3cf5c2', 9); // orphan: the chat that remains
export const ORPHAN = uid('3148427e', 10); // orphan: the deleted chat's transcript
export const RID = (n) => (n === 1 ? uid('fbef27ef', 101) : uid('c3a28bce', 100 + n)); // request ids
export const UID = (n) => (n === 1 ? uid('45c3fe3c', 201) : uid('8b76b964', 200 + n)); // user message ids
export const EMPTY_ROOT = sha(Buffer.alloc(0));

const chatDir = (id) => `chats/${BUCKET}/${id}`;

export const userMsg = (s, { text, id, snap, t, extra = [] }) => s.put(pb([[1, text], [2, id], [3, []], [4, 1], ...extra, [10, ref(snap)], [17, id], [25, t], [26, t]]));
export const thinking = (s, text, t) => s.put(pb([[3, [[1, text], [2, 170], [3, t], [4, t + 170]]]]));
// The last text step of a model response has no completed_at_ms on real stores (as a lab capture
// showed).
export const say = (s, text, t, done = true) => s.put(pb([[1, [[1, text], [2, t], [3, done ? t + 5 : null]]]]));
export const toolStep = (s, kindNo, callId, args, result, t) => s.put(pb([[2, [[kindNo, [[1, args], [2, result]]], [57, callId], [59, t], [60, result ? t + 500 : null]]]]));
export const shellArgs = (cmd, callId) => [[1, cmd], [2, CWD], [3, 30000], [4, callId], [15, 'Run the tests'], [21, A], [24, SECRET_SCOPE]];
export const shellOk = (cmd, out) => [[1, [[1, cmd], [2, CWD], [3, 0], [5, out]]]];
export const shellFailure = (cmd, out, code) => [[2, [[1, cmd], [2, CWD], [3, code], [5, out]]]];
export function agentTurn(s, { um, steps, rid, uid: u, extra = [] }) {
  return s.put(pb([[1, [[1, ref(um)], ...steps.map((x) => [2, ref(x)]), [3, rid], [4, SECRET_ENC], [5, 13], [9, 'TodoWrite'], [10, u], ...extra]]]));
}
export function root(s, { turns = [], ctx = [], archives = [], extra = [] }) {
  return s.put(pb([
    ...ctx.map((j) => [1, ref(j)]), [5, [[1, 12000], [2, 200000]]], ...turns.map((t) => [8, ref(t)]), [9, `file://${CWD}`], [10, 1],
    [22, 'cli'], [26, T0 - 12], [27, 'UTC'], ...archives.map((a) => [13, ref(a)]), ...extra,
  ]));
}
export const metaOf = (id, rootId, more = {}) => ({
  agentId: id, latestRootBlobId: rootId, name: 'coupon-work', createdAt: T0 - 40000, mode: 'default', isRunEverything: false,
  lastUsedModel: 'default', blobEncryptionKey: SECRET_META, ...more,
});
const metaJson = (more = {}) => `${JSON.stringify({ schemaVersion: 1, createdAtMs: T0 - 40000, hasConversation: true, updatedAtMs: T0 + 900000, cwd: CWD, ...more })}\n`;
const q = (rid, text, more = {}) => ({ role: 'user', content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }], providerOptions: { cursor: { requestId: rid } }, ...more });
const assistantJson = (n, content) => ({ role: 'assistant', id: `msg_synth${String(n).padStart(2, '0')}`, content });
const toolJson = (callId, name, result, hl) => ({
  role: 'tool', id: callId, content: [{ type: 'tool-result', toolCallId: callId, toolName: name, result }],
  ...(hl ? { providerOptions: { cursor: { highLevelToolCallResult: hl } } } : {}),
});

// ---- features -----------------------------------------------------------------------------------

function featuresMain() {
  const s = new Chat(chatDir(A));
  const files = { [`${chatDir(A)}/meta.json`]: metaJson({ title: 'coupon-work' }) };
  const R0 = s.put(pb([[9, `file://${CWD}`], [22, 'cli']]));
  s.meta(metaOf(A, R0));

  // Turn 1: reasoning, a reply, a failing shell call whose model context is stored (lab case: the
  // step's tool_call_id call-00c41679…-2\nfc_… is the JSON tool result's toolCallId).
  const C1 = call(2);
  const sys = s.json({ role: 'system', content: 'You are an AI coding assistant, powered by Composer.', providerOptions: { cursor: { systemPromptFingerprint: { content: 'synth01', mode: '1', agentType: 'cli' } } } });
  const info = s.json({ role: 'user', content: `<user_info>\nOS Version: linux\n\nShell: bash\n\nWorkspace Path: ${CWD}\n</user_info>` });
  const head = s.json({ role: 'user', content: '<system_reminder>Follow the workspace rules in AGENTS.md.</system_reminder>' });
  const q1 = s.json(q(RID(1), 'Fix the qty bug in cart.py.'));
  const a1 = s.json(assistantJson(1, [
    { type: 'reasoning', text: '', signature: 'opaque-signature', providerOptions: { cursor: { modelName: MODEL } } },
    { type: 'text', text: 'Running the tests first.' },
    { type: 'tool-call', toolCallId: C1, toolName: 'Shell', args: { command: 'python3 -m pytest -q', working_directory: CWD, description: 'Run the tests' } },
  ]));
  const r1 = s.json(toolJson(C1, 'Shell', 'Exit code: 1\n\nCommand output:\n\n```\n1 failed, 2 passed\n```', { output: { failure: { exitCode: 1 } }, isError: true }));
  const um1 = userMsg(s, { text: 'Fix the qty bug in cart.py.', id: UID(1), snap: R0, t: T0 });
  const th1 = thinking(s, 'The total ignores qty; run the tests first.', T0 + 1000);
  const sa1 = say(s, 'Running the tests first.', T0 + 1200);
  const st1 = toolStep(s, 1, C1, shellArgs('python3 -m pytest -q', C1), shellFailure('python3 -m pytest -q', '1 failed, 2 passed', 1), T0 + 1300);
  const sa1b = say(s, 'One test fails: total ignores qty.', T0 + 2500, false);
  // The turn blob is re-minted as its steps arrive (spec §3).
  const t1a = agentTurn(s, { um: um1, steps: [th1, sa1, st1], rid: RID(1), uid: UID(1) });
  s.meta(metaOf(A, root(s, { turns: [t1a], ctx: [sys, info, head, q1, a1, r1] })));
  const turn1 = agentTurn(s, { um: um1, steps: [th1, sa1, st1, sa1b], rid: RID(1), uid: UID(1) });
  const ctx1 = [sys, info, head, q1, a1, r1];
  const R1 = root(s, { turns: [turn1], ctx: ctx1 });
  s.meta(metaOf(A, R1));

  // Turn 2: a read with no model context for it: the step is decoded (typed args and output).
  const C2 = call(3);
  const um2 = userMsg(s, { text: 'Show me cart.py.', id: UID(2), snap: R1, t: T0 + 60000 });
  const st2 = toolStep(s, 8, C2, [[1, `${CWD}/toyshop/cart.py`]], [[1, [[1, 'class Cart: ...'], [7, `${CWD}/toyshop/cart.py`]]]], T0 + 61000);
  const sa2 = say(s, 'Here it is.', T0 + 62000, false);
  const turn2 = agentTurn(s, { um: um2, steps: [st2, sa2], rid: RID(2), uid: UID(2) });
  const R2 = root(s, { turns: [turn1, turn2], ctx: ctx1 });
  s.meta(metaOf(A, R2));

  // Turn 3: shell mode (`!cmd`): no id; anchored on the previous user id. Exit code 3.
  const cmd = s.put(pb([[1, 'python3 -c "import sys; print(7); sys.exit(3)"']]));
  const out = s.put(pb([[1, '7\n'], [3, 3]]));
  const turn3 = s.put(pb([[2, [[1, ref(cmd)], [2, ref(out)]]]]));
  const R3 = root(s, { turns: [turn1, turn2, turn3], ctx: ctx1 });
  s.meta(metaOf(A, R3));

  // Turn 4: a rejected shell step (no model context), an untyped kind (web_search: name and outcome
  // only), and a shell call whose toolCallId is a plain uuid (lab cases, unpublished), with its model context.
  const CR = call(4);
  const CW = call(5);
  const CU = uid('b6c2e9d4', 301);
  const um4 = userMsg(s, { text: 'Clean the tree, search the docs, list the files.', id: UID(4), snap: R3, t: T0 + 90000 });
  const rej = toolStep(s, 1, CR, shellArgs('git clean -fdx', CR), [[4, [[1, 'git clean -fdx'], [2, CWD], [3, 'Denied: do not run git clean.']]]], T0 + 91000);
  const web = toolStep(s, 18, CW, [[1, 'toyshop cart'], [7, 'SENTINEL-UNTYPED-FIELD']], [[1, [[1, 'result one'], [4, 'SENTINEL-UNTYPED-RESULT']]]], T0 + 92000);
  const lsStep = toolStep(s, 1, CU, shellArgs('ls', CU), shellOk('ls', 'README.md\ntoyshop'), T0 + 92500);
  const a4 = s.json(assistantJson(4, [{ type: 'tool-call', toolCallId: CU, toolName: 'Shell', args: { command: 'ls', working_directory: CWD } }]));
  const r4 = s.json(toolJson(CU, 'Shell', 'README.md\ntoyshop', { output: { success: { exitCode: 0 } }, isError: false }));
  const turn4 = agentTurn(s, { um: um4, steps: [rej, web, lsStep, say(s, 'Skipped the clean.', T0 + 93000, false)], rid: RID(4), uid: UID(4) });
  const q4 = s.json(q(RID(4), 'Clean the tree, search the docs, list the files.'));
  const ctx4 = [...ctx1, q4, a4, r4];
  const R4 = root(s, { turns: [turn1, turn2, turn3, turn4], ctx: ctx4 });
  s.meta(metaOf(A, R4));

  // Turn 5: credential tools. replace_env (#51) and mcp_login (#41) by their step kind; MCPLogin
  // through CallDynamicTool and ConnectSCM by the model context's name only, over untyped kinds.
  const CE = call(21);
  const CL = call(22);
  const CD = call(41);
  const CS = call(42);
  const um5 = userMsg(s, { text: 'Set the key, log in, connect the repo.', id: UID(5), snap: R4, t: T0 + 120000 });
  const env1 = s.put(pb([[2, [[51, [[1, [[1, 'API_KEY'], [2, SECRET_ARG]]], [2, [[1, [[1, `API_KEY=${SECRET_OUT}`]]]]]]], [57, CE], [59, T0 + 121000], [60, T0 + 121100]]]]));
  const login = s.put(pb([[2, [[41, [[1, [[1, 'toybox'], [3, SECRET_ARG]]], [2, [[2, [[1, `token ${SECRET_OUT} rejected`]]]]]]], [57, CL], [59, T0 + 122000], [60, T0 + 122100]]]]));
  const dyn = toolStep(s, 18, CD, [[1, 'x'], [2, SECRET_PW]], [[1, [[1, `ok ${SECRET_OUT}`]]]], T0 + 123000);
  const scm = toolStep(s, 24, CS, [[1, 'y'], [2, SECRET_PW]], [[1, [[1, 'ok']]]], T0 + 124000);
  const a5 = s.json(assistantJson(5, [
    { type: 'tool-call', toolCallId: CE, toolName: 'ReplaceEnv', args: { name: 'API_KEY', value: SECRET_ARG } },
    { type: 'tool-call', toolCallId: CD, toolName: 'CallDynamicTool', args: { namespace: 'cursor', toolName: 'MCPLogin', arguments: { server: `https://toy:${SECRET_PW}@example.com/toybox/login`, host: { nested: SECRET_PW }, names: ['TOYBOX', 'TOYBOX_EU'], token: SECRET_PW } } },
    { type: 'tool-call', toolCallId: CS, toolName: 'ConnectSCM', args: { provider: 'github', name: 7, scm: [`https://u:${SECRET_PW}@example.com/toybox.git`] } },
  ]));
  const r5a = s.json(toolJson(CE, 'ReplaceEnv', `Updated API_KEY=${SECRET_OUT}`, { output: { success: { name: 'API_KEY', value: SECRET_ARG } }, isError: false }));
  const r5b = s.json({ role: 'tool', content: [{ type: 'tool-result', toolCallId: CD, toolName: 'CallDynamicTool', result: `logged in, token ${SECRET_OUT}` }, { type: 'tool-result', toolCallId: CS, toolName: 'ConnectSCM', result: SECRET_OUT }] });
  const turn5 = agentTurn(s, { um: um5, steps: [env1, login, dyn, scm, say(s, 'Done.', T0 + 125000, false)], rid: RID(5), uid: UID(5) });
  const q5 = s.json(q(RID(5), 'Set the key, log in, connect the repo.'));
  const ctx5 = [...ctx4, q5, a5, r5a, r5b];
  const R5 = root(s, { turns: [turn1, turn2, turn3, turn4, turn5], ctx: ctx5 });
  s.meta(metaOf(A, R5));

  // Turn 6: typed grep and MCP results projected field by field; a binary read and a truncated
  // step by reference; an image in the user's model message.
  const CG = call(31);
  const CM = call(32);
  const CB = call(12);
  const CT = call(13);
  const um6 = userMsg(s, { text: 'Find apply_coupon, ask the toy box, show the label, list everything.', id: UID(6), snap: R5, t: T0 + 150000 });
  const union = [[3, [[1, [[1, './toyshop/cart.py'], [2, [[1, 22], [2, '    def apply_coupon(self, code):']]], [2, [[1, 30], [2, '        return COUPONS[code]']]]]]]], [9, 'SENTINEL-UNPROJECTED-FIELD']];
  const grep = toolStep(s, 5, CG, [[1, 'apply_coupon'], [4, 'content']], [[1, [[1, 'apply_coupon'], [4, [[1, CWD], [2, union]]], [7, 'SENTINEL-UNPROJECTED-FIELD']]]], T0 + 151000);
  const mcpArgs = [[1, 'search_toys'], [2, [[1, 'q'], [2, [[3, 'robot']]]]], [3, CM], [4, 'toybox-provider'], [5, 'search_toys'], [9, 'toybox']];
  const mcp = toolStep(s, 15, CM, mcpArgs, [[1, [[1, [[1, [[1, 'three robots']]]]], [1, [[2, [[1, 'SENTINEL-UNPROJECTED-FIELD']]]]]]]], T0 + 152000);
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const binId = s.put(bin);
  const readBin = toolStep(s, 8, CB, [[1, `${CWD}/label.png`]], [[1, [[9, ref(binId)]]]], T0 + 153000);
  const orig = s.put(Buffer.from('the original step, too big to keep inline'));
  const trunc = s.put(pb([[2, [[34, [[1, ref(orig)], [2, [[1, 'ls -R /']]], [3, [[1, [[1, 'a preview']]]]], [4, 48213]]], [57, CT], [59, T0 + 154000], [60, T0 + 154500]]]]));
  const png = Buffer.from('PNG!');
  const q6 = s.json(q(RID(6), 'Find apply_coupon, ask the toy box, show the label, list everything.', {
    content: [{ type: 'text', text: '<user_query>\nFind apply_coupon, ask the toy box, show the label, list everything.\n</user_query>' }, { type: 'image', image: { hex: png.toString('hex') }, mimeType: 'image/png' }],
  }));
  const turn6 = agentTurn(s, { um: um6, steps: [grep, mcp, readBin, trunc, say(s, 'Found it.', T0 + 155000, false)], rid: RID(6), uid: UID(6) });
  const ctx6 = [...ctx5, q6];
  const R6 = root(s, { turns: [turn1, turn2, turn3, turn4, turn5, turn6], ctx: ctx6 });
  s.meta(metaOf(A, R6));

  // Turns 7-9: simulated user messages: plan execution (automated), a commit reminder (injected), a
  // message the user sent to a sub-agent (the user's).
  const sim = (n, reason, text, t) => userMsg(s, { text, id: UID(n), snap: R6, t, extra: [[5, true], [9, reason]] });
  const simTurn = (n, reason, text, t) => agentTurn(s, { um: sim(n, reason, text, t), steps: [say(s, 'Ok.', t + 100, false)], rid: RID(n), uid: UID(n) });
  const turn7 = simTurn(7, 1, 'Implement the plan as specified.', T0 + 300000);
  const turn8 = simTurn(8, 2, 'Remember to commit your changes.', T0 + 310000);
  const turn9 = simTurn(9, 9, 'Also check tests/unit.', T0 + 320000);
  const turns = [turn1, turn2, turn3, turn4, turn5, turn6, turn7, turn8, turn9];
  const R9 = root(s, { turns, ctx: ctx6 });
  s.meta(metaOf(A, R9));

  // Compaction: turn 1's model context moves into a summary archive; the turns are kept. A
  // reminder that the output was cut off follows the last request in the new context.
  const summaryMsg = s.json({ role: 'user', content: '[Previous conversation summary]: the qty bug was found.', providerOptions: { cursor: { isSummary: true } } });
  const archive = s.put(pb([[1, ref(sys)], [1, ref(head)], [1, ref(q1)], [1, ref(a1)], [1, ref(r1)], [2, 'Summary: the qty bug was found; one test fails.'], [3, 0], [4, ref(summaryMsg)]]));
  const cut = s.json({ role: 'user', content: [{ type: 'text', text: '<system_reminder>Your response was cut off because it exceeded the output token limit.</system_reminder>' }] });
  const summary = s.put(pb([[1, 'Summary: the qty bug was found; one test fails.']]));
  const R10 = root(s, { turns, ctx: [sys, info, summaryMsg, q4, a4, r4, q5, a5, r5a, r5b, q6, cut], archives: [archive], extra: [[6, ref(summary)], [37, 3]] });
  s.meta(metaOf(A, R10));
  return { s, files };
}

// A chat whose last reply still runs: first no step, then a running tool.
function featuresHeld() {
  const s = new Chat(chatDir(H));
  const R0 = s.put(pb([[9, `file://${CWD}`], [22, 'cli']]));
  const um1 = userMsg(s, { text: 'Name the toy shop.', id: uid('8b76b964', 211), snap: R0, t: T0 + 3600000 });
  const t1 = agentTurn(s, { um: um1, steps: [say(s, 'Toyshop.', T0 + 3601000, false)], rid: uid('c3a28bce', 111), uid: uid('8b76b964', 211) });
  const R1 = root(s, { turns: [t1] });
  s.meta(metaOf(H, R1, { name: 'held-run' }));
  const um2 = userMsg(s, { text: 'Run the tests again.', id: uid('8b76b964', 212), snap: R1, t: T0 + 3660000 });
  const rid = uid('c3a28bce', 112);
  s.meta(metaOf(H, root(s, { turns: [t1, agentTurn(s, { um: um2, steps: [], rid, uid: uid('8b76b964', 212) })] }), { name: 'held-run' }));
  const C = call(9);
  const running = toolStep(s, 1, C, shellArgs('python3 -m pytest -q', C), null, T0 + 3661000);
  const t2 = agentTurn(s, { um: um2, steps: [say(s, 'Running.', T0 + 3660500), running], rid, uid: uid('8b76b964', 212) });
  s.meta(metaOf(H, root(s, { turns: [t1, t2] }), { name: 'held-run' }));
  return s;
}

function features() {
  const { s: a, files } = featuresMain();
  const h = featuresHeld();
  // A refused first prompt leaves the empty root and an auto-title (lab cases, unpublished: "SKU List").
  const e = new Chat(chatDir(E));
  e.put(Buffer.alloc(0));
  e.meta({ agentId: E, latestRootBlobId: EMPTY_ROOT, name: 'SKU List', mode: 'default', isRunEverything: false, createdAt: T0 + 7200000, lastUsedModel: 'default', blobEncryptionKey: SECRET_META });
  files[`${chatDir(E)}/meta.json`] = metaJson({ createdAtMs: T0 + 7200000, title: 'SKU List' });
  // An ACP store (memhouse lists acp-sessions/<id>/store.db; UNVERIFIED with a turn).
  const acp = new Chat(`acp-sessions/${ACP}`);
  const R0 = acp.put(pb([[9, `file://${CWD}`], [22, 'cli']]));
  const um = userMsg(acp, { text: 'Say ok.', id: uid('8b76b964', 221), snap: R0, t: T0 + 8000000 });
  const t = agentTurn(acp, { um, steps: [say(acp, 'ok', T0 + 8000500, false)], rid: uid('c3a28bce', 121), uid: uid('8b76b964', 221) });
  acp.meta({ agentId: ACP, latestRootBlobId: root(acp, { turns: [t] }), name: 'Okay Reply', createdAt: T0 + 8000000, lastUsedModel: 'default', blobEncryptionKey: SECRET_META });
  files[`acp-sessions/${ACP}/meta.json`] = `${JSON.stringify({ schemaVersion: 1, cwd: CWD, title: 'Okay Reply' })}\n`;
  // An empty chat: meta.json only, no store.db. No session.
  files[`${chatDir(uid('0f0f0f0f', 11))}/meta.json`] = metaJson({ hasConversation: false });
  return { dbs: { ...a.db(), ...h.db(), ...e.db(), ...acp.db() }, files };
}

// ---- subagent -----------------------------------------------------------------------------------

export const TOOL = `call-${uid('ce18c09b', 401)}-33\n${fc(33)}`;
function subagent() {
  const p = new Chat(chatDir(P));
  const P0 = p.put(pb([[9, `file://${CWD}`], [22, 'cli']]));
  const pum = userMsg(p, { text: 'Use a subagent to list the tests.', id: uid('8b76b964', 231), snap: P0, t: T0 });
  const task = toolStep(p, 19, TOOL, [[1, 'List test functions'], [2, 'List every test function.'], [4, 'default']], [[1, [[1, [[1, [[1, 'Found 4 tests.']]]]], [2, SUB], [4, 9301]]]], T0 + 10);
  const pt = agentTurn(p, { um: pum, steps: [task, say(p, 'Four tests.', T0 + 20, false)], rid: uid('c3a28bce', 131), uid: uid('8b76b964', 231) });
  // The parent's root names the child twice more: subagent_states (#16) and the runs (#30).
  const state = [[1, SUB], [2, [[2, T0 + 5], [3, T0 + 15], [4, 3]]]];
  const runs = [[1, TOOL], [2, [[1, TOOL], [2, SUB], [3, 1], [4, 3]]]];
  p.meta(metaOf(P, root(p, { turns: [pt], extra: [[16, state], [30, runs]] }), { name: 'list-tests' }));

  const c = new Chat(chatDir(SUB));
  const C0 = c.put(pb([[22, 'cli']]));
  // A sub-agent's user message has no id of its own, and carries the sub-agent reminder (#11).
  const um = c.put(pb([[1, 'List the test functions under tests/.'], [3, []], [4, 1], [10, ref(C0)], [11, 'You are running as a subagent under a parent agent.'], [25, T0 + 6]]));
  const t = agentTurn(c, { um, steps: [say(c, 'test_total_uses_qty', T0 + 100, false)], rid: uid('c3a28bce', 132) });
  c.meta({
    agentId: SUB, latestRootBlobId: root(c, { turns: [t] }), name: 'New Agent', createdAt: T0 + 5, mode: 'default', isRunEverything: false,
    subagentInfo: { parentAgentId: P, rootParentAgentId: P, toolCallId: TOOL, typeName: 'explore' }, blobEncryptionKey: SECRET_META,
  });
  const files = {
    [`${chatDir(P)}/meta.json`]: metaJson({ title: 'list-tests' }),
    [`${chatDir(SUB)}/meta.json`]: `${JSON.stringify({ schemaVersion: 1, createdAtMs: T0 + 5, hasConversation: true, updatedAtMs: T0 + 9000, isSubagent: true })}\n`,
  };
  return { dbs: { ...p.db(), ...c.db() }, files };
}

// ---- rewind and fork ----------------------------------------------------------------------------

function rewind() {
  const s = new Chat(chatDir(R));
  const R0 = s.put(pb([[9, `file://${CWD}`], [22, 'cli']]));
  s.meta(metaOf(R, R0));
  const um1 = userMsg(s, { text: 'Fix the qty bug in cart.py.', id: uid('8b76b964', 241), snap: R0, t: T0 });
  const t1 = agentTurn(s, { um: um1, steps: [say(s, 'Fixed.', T0 + 1000, false)], rid: uid('c3a28bce', 141), uid: uid('8b76b964', 241) });
  const R1 = root(s, { turns: [t1] });
  s.meta(metaOf(R, R1));
  const um2 = userMsg(s, { text: 'Now add a coupon.', id: uid('8b76b964', 242), snap: R1, t: T0 + 60000 });
  const t2 = agentTurn(s, { um: um2, steps: [say(s, 'Added SAVE10.', T0 + 61000, false)], rid: uid('c3a28bce', 142), uid: uid('8b76b964', 242) });
  const R2 = root(s, { turns: [t1, t2] });
  s.meta(metaOf(R, R2));
  // A fork, before the rewind: every blob copied to a new chat, " (forked)", a later createdAt.
  const f = new Chat(chatDir(F));
  f.copyBlobs(s);
  f.meta(metaOf(F, R2, { name: 'coupon-work (forked)', createdAt: T0 + 70000 }));
  // /rewind to turn 2: the root moves back to turn 2's snapshot (R1); nothing is written but meta.
  s.meta(metaOf(R, R1));
  // A new prompt from the same snapshot regrows the conversation.
  const um3 = userMsg(s, { text: 'Instead, add a test.', id: uid('8b76b964', 243), snap: R1, t: T0 + 120000 });
  const t3 = agentTurn(s, { um: um3, steps: [say(s, 'Added a test.', T0 + 121000, false)], rid: uid('c3a28bce', 143), uid: uid('8b76b964', 243) });
  s.meta(metaOf(R, root(s, { turns: [t1, t3] })));
  return { dbs: { ...s.db(), ...f.db() }, files: { [`${chatDir(R)}/meta.json`]: metaJson(), [`${chatDir(F)}/meta.json`]: metaJson({ createdAtMs: T0 + 70000 }) } };
}

// ---- orphan (cursor-orphan) ---------------------------------------------------------------------

export const ORPHAN_TRANSCRIPT = `projects/home-user-work-toyshop/agent-transcripts/${ORPHAN}/${ORPHAN}.jsonl`;
function orphan() {
  const s = new Chat(chatDir(L));
  const R0 = s.put(pb([[9, `file://${CWD}`], [22, 'cli']]));
  const um = userMsg(s, { text: 'What does this project do?', id: uid('8b76b964', 251), snap: R0, t: T0 });
  const t = agentTurn(s, { um, steps: [say(s, 'Synthetic reply 8b5aa2.', T0 + 500, false)], rid: uid('c3a28bce', 151), uid: uid('8b76b964', 251) });
  s.meta(metaOf(L, root(s, { turns: [t] }), { name: 'toyshop-summary' }));
  // The orphan's transcript (store/, kept) and an empty chat directory (meta.json only).
  return { dbs: s.db(), files: { [`${chatDir(L)}/meta.json`]: metaJson(), [`${chatDir(uid('0f0f0f0f', 12))}/meta.json`]: metaJson({ hasConversation: false }) }, keep: [ORPHAN_TRANSCRIPT] };
}

// ---- writing ------------------------------------------------------------------------------------

export const CASES = { features, subagent, rewind, orphan };

function writeCase(name, { dbs, files, keep = [] }) {
  const dir = path.join(HERE, name);
  fs.rmSync(path.join(dir, 'store-sql'), { recursive: true, force: true });
  // `store/` holds the generated files, and any file `keep` names (not written here).
  const kept = new Map(keep.filter((rel) => fs.existsSync(path.join(dir, 'store', rel))).map((rel) => [rel, fs.readFileSync(path.join(dir, 'store', rel))]));
  fs.rmSync(path.join(dir, 'store'), { recursive: true, force: true });
  for (const [rel, [schema, ops]] of Object.entries(dbs)) {
    const base = path.join(dir, 'store-sql', rel);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(`${base}.schema.sql`, schema);
    fs.writeFileSync(`${base}.ops.jsonl`, ops.map((x) => JSON.stringify(x) + '\n').join(''));
  }
  for (const [rel, data] of [...Object.entries(files ?? {}), ...kept]) {
    const file = path.join(dir, 'store', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, build] of Object.entries(CASES)) writeCase(name, build());
  console.log('cursor-agent fixtures written');
}
