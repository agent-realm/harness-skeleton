// Writes the Cursor IDE fixture stores as text: for each case, the schema and the statements that
// build `<user data>/User/globalStorage/state.vscdb` (conformance/sql-store.js builds the database
// at test time; no binary file is committed).
//   node fixtures/cursor/generate.js
// The schema is Cursor IDE 3.25.9's, verbatim from the lab capture, in WAL mode as the store is.
// - `lab`: rows of a Cursor IDE 3.25.9 capture of synthetic chats on a test VM (the fixture
//   captures), kept in lab/capture.jsonl. Before they entered this repository,
//   outside it: environment strings were replaced (home /home/user); every id from the run
//   (composer,
//   bubble, request, checkpoint, generation, tool call, workspace, content hash) was re-minted with
//   the same shape and length, prefixes included; `toolCallBinary` (a protobuf of the call carrying
//   the capture machine's
//   paths) was dropped; a decode note in `conversationState` was put back to Cursor's empty form
//   `~`; two `params` cells the capture tool cut were completed by hand (the end of a parsed shell
//   command, and an empty `additionalReadwritePaths`).
//   The capture holds composerData rows taken at another moment than its bubbles, so here:
//   - the main chat's header list keeps its user bubble 5a5a0012 (not captured: it reads as held,
//     a listed bubble not stored) and the four tool bubbles captured of that turn, and gains the
//     headers of a captured turn, rebuilt from its bubbles as Cursor writes
//     them; the captured bubble 5a5a002c/s:1 stays unlisted (derive drops it);
//   - the fork's and the Ask-mode chat's lists are emptied (none of their bubbles was captured).
// - `features`: written here, one chat per behaviour the adapter claims, ported from memhouse's
//   normaliser tests: turns with thinking, text and tools (a call id
//   holding `\n`, a shell exiting 1, a cancelled loop), an edit (the user bubble rewritten in
//   place,
//   later bubbles hard-deleted), a fork, sub-agents, the older inline format, an image, opaque
//   reasoning, a rejected tool, paid-plan tokens, an unlisted bubble, a reply still generating, a
//   tool still running, a tool left running in an ended turn, a listed bubble not stored yet, a
//   draft, and the redaction sentinels (the composer's two keys; a free-text sentinel that stays).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REL = 'User/globalStorage/state.vscdb';

const SCHEMA = `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, subagentTypeName TEXT, value TEXT);
CREATE INDEX idx_composerHeaders_0 ON composerHeaders (workspaceId, isSubagent, isArchived, recency);
CREATE INDEX idx_composerHeaders_1 ON composerHeaders (recency, composerId);
`;
const HEADER_COLS = ['composerId', 'workspaceId', 'createdAt', 'lastUpdatedAt', 'isArchived', 'isSubagent', 'recency', 'checkpointAt', 'subagentTypeName', 'value'];

// ---- the statements of one store ----------------------------------------------------------------

class Store {
  constructor() {
    this.ops = [];
  }

  op(sql, params = []) {
    this.ops.push({ sql, params });
  }

  item(key, value) {
    this.op('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [key, typeof value === 'string' ? value : JSON.stringify(value)]);
  }

  header(row) {
    this.op(`INSERT INTO composerHeaders (${HEADER_COLS.join(', ')}) VALUES (${HEADER_COLS.map(() => '?').join(', ')})`,
      HEADER_COLS.map((c) => (c === 'value' ? JSON.stringify(row.value) : row[c] ?? null)));
  }

  // composerData as TEXT, a bubble as BLOB, as memhouse's normaliser test observed Cursor write
  // them.
  // The table's ON CONFLICT REPLACE makes a second insert of a key the store's upsert.
  kv(key, value, { blob = false } = {}) {
    const text = JSON.stringify(value);
    this.op('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)', [key, blob ? { $b64: Buffer.from(text, 'utf8').toString('base64') } : text]);
  }

  del(key) {
    this.op('DELETE FROM cursorDiskKV WHERE key = ?', [key]);
  }
}

function write(name, store) {
  const dir = path.join(HERE, name, 'store-sql', path.dirname(REL));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(HERE, name, 'store-sql', `${REL}.schema.sql`), SCHEMA);
  fs.writeFileSync(path.join(HERE, name, 'store-sql', `${REL}.ops.jsonl`), store.ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

// A header-list entry as Cursor writes it for a bubble (the lab's `fullConversationHeadersOnly`).
function hdr(b) {
  const g = { isRenderable: true };
  if (b.capabilityType === 30) Object.assign(g, { capabilityType: 30, hasThinking: true, thinkingDurationMs: b.thinkingDurationMs ?? 2 });
  else if (b.capabilityType === 15) {
    Object.assign(g, { capabilityType: 15, toolFormerTool: b.toolFormerData.tool, toolFormerStatus: b.toolFormerData.status, toolCallId: b.toolFormerData.toolCallId });
  } else Object.assign(g, { hasText: true });
  g.toolDisplayComputed = true;
  return {
    bubbleId: b.bubbleId, type: b.type, grouping: g, contentHeightHint: 44, createdAt: b.createdAt, startedAtMs: b.startedAtMs,
    ...(b.completedAtMs ? { completedAtMs: b.completedAtMs } : {}),
  };
}

// ---- lab
// ------------------------------------------------------------------------------------------

const LAB_MAIN = '5a5a0009-0009-4000-8000-000000000009';
const LAB_FORK = 'f01e1200-000d-4000-8000-00000000000d';
const LAB_ASK = '5a5a000e-000e-4000-8000-00000000000e';
const LAB_TURN2 = '5a5a0012-0012-4000-8000-000000000012'; // its user bubble was not captured
const LAB_TURN3 = '5a5a0029-0029-4000-8000-000000000029'; // captured whole: prompt, thinking, text, a cancelled loop

function lab() {
  const recs = fs.readFileSync(path.join(HERE, 'lab', 'capture.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const bubbles = recs.filter((r) => r.table === 'cursorDiskKV' && r.key.startsWith('bubbleId:'));
  const data = (cid) => recs.find((r) => r.table === 'cursorDiskKV' && r.key === `composerData:${cid}`).value;
  const captured = new Set(bubbles.map((r) => r.key.slice(`bubbleId:${LAB_MAIN}:`.length)));

  const main = data(LAB_MAIN);
  const kept = main.fullConversationHeadersOnly.filter((h) => h.bubbleId === LAB_TURN2 || captured.has(h.bubbleId));
  const turn3 = bubbles.map((r) => r.value).filter((b) => b.bubbleId === LAB_TURN3 || b.bubbleId.startsWith(`${LAB_TURN3}/`))
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
  main.fullConversationHeadersOnly = [...kept, ...turn3.map(hdr)];
  data(LAB_FORK).fullConversationHeadersOnly = [];
  data(LAB_ASK).fullConversationHeadersOnly = [];

  const s = new Store();
  for (const r of recs.filter((x) => x.table === 'ItemTable')) s.item(r.key, r.value);
  // Each chat's header, then its composerData, then its bubbles: the order Cursor's own writes
  // leave
  // whole (a chat's bubbles never sit without its composerData row).
  const headers = recs.filter((r) => r.table === 'composerHeaders').map((r) => r.row).sort((a, b) => a.createdAt - b.createdAt);
  for (const h of headers) {
    s.header(h);
    const cd = recs.find((r) => r.table === 'cursorDiskKV' && r.key === `composerData:${h.composerId}`);
    if (cd) s.kv(cd.key, cd.value);
    for (const b of bubbles.filter((r) => r.key.startsWith(`bubbleId:${h.composerId}:`))) s.kv(b.key, b.value, { blob: true });
  }
  write('lab', s);
}

// ---- features
// ---------------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 20, 12, 32, 54);
const iso = (t) => new Date(t).toISOString();
const zero = { inputTokens: 0, outputTokens: 0 };
const uuid = (p8, n) => `${p8}-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A composer's id, and a Cursor tool call id (`call-<uuid>-<n>\nfc_<uuid>_<n>`: it holds a
// newline).
const CID = (n) => uuid(`c0c0a0${String(n).padStart(2, '0')}`, n);
const CALL = (n, i = 0) => `call-${uuid(n === 1 ? 'fc053ac5' : `ca11ca${String(n).padStart(2, '0')}`, n)}-${i}\nfc_${uuid(`fc0fc0${String(n).padStart(2, '0')}`, n)}_0`;
const WS = '/home/user/work/toyshop';
const WS_ID = { id: '5a5b0000000000000000000000000001', uri: { $mid: 1, fsPath: WS, external: `file://${WS}`, path: WS, scheme: 'file' } };

const SENTINEL_BLOB = 'sentinel-blob-key-0a1b2c3d4e5f-not-a-secret';
const SENTINEL_SPEC = 'sentinel-spec-key-5f4e3d2c1b0a-not-a-secret';
const SENTINEL_TEXT = 'sentinel-free-text-7c6b5a493827-not-a-secret';
const SENTINEL_LOGIN = 'sentinel-login-row-0f1e2d3c4b5a-not-a-secret';

function userBubble(uid, t, text, extra = {}) {
  return {
    _v: 3, type: 1, bubbleId: uid, requestId: uuid('5e9e5e9e', Number(uid.slice(-12))), tokenCount: { ...zero }, unifiedMode: 2, createdAt: iso(t),
    conversationState: '~', richText: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }),
    text, context: { selectedImages: [], mentions: {} }, agentMode: 1, modelInfo: { modelName: 'grok-4.6' },
    contextWindowStatusAtCreation: { tokensUsed: 15915, tokenLimit: 256000 }, checkpointId: uuid('c4ec4ec4', t % 100000), startedAtMs: t, completedAtMs: t, ...extra,
  };
}
const think = (uid, n, t, text, extra = {}) => ({
  _v: 3, type: 2, bubbleId: `${uid}/s:${n}`, tokenCount: { ...zero }, unifiedMode: 2, createdAt: iso(t), conversationState: '~', text: '',
  capabilityType: 30, startedAtMs: t, thinkingStyle: 1, thinking: { text, signature_len: 0 }, thinkingDurationMs: 2, ...extra,
});
const say = (uid, n, t, text, extra = {}) => ({
  _v: 3, type: 2, bubbleId: `${uid}/s:${n}`, tokenCount: { ...zero }, unifiedMode: 2, createdAt: iso(t), conversationState: '~', codeBlocks: [], text,
  startedAtMs: t, thinkingStyle: 1, ...extra,
});
function tool(uid, call, t, { name, params, rawArgs = '', status = 'completed', result, additionalData = {}, toolNo = 15 }) {
  return {
    _v: 3, type: 2, bubbleId: `${uid}/t:${call}`, tokenCount: { ...zero }, unifiedMode: 2, createdAt: iso(t), conversationState: '~', text: '', capabilityType: 15,
    toolFormerData: {
      tool: toolNo, toolIndex: 0, modelCallId: '', toolCallId: call, status, rawArgs, name, params: JSON.stringify(params),
      ...(result === undefined ? {} : { result: JSON.stringify(result) }), additionalData,
    },
    startedAtMs: t, ...(status === 'completed' || status === 'cancelled' ? { completedAtMs: t + 500 } : {}),
  };
}
function composerData(cid, bubbles, extra = {}) {
  return {
    _v: 18, composerId: cid, richText: '', hasLoaded: true, text: '', fullConversationHeadersOnly: bubbles.map(hdr), conversationMap: {},
    status: 'completed', generatingBubbleIds: [], lastUpdatedAt: T0 + 90000, createdAt: T0 - 1600, name: 'Toy cart qty fix',
    unifiedMode: 'agent', forceMode: 'edit', usageData: {}, contextUsagePercent: 6.4, contextTokensUsed: 16401, contextTokenLimit: 256000,
    modelConfig: { modelName: 'grok-4.6', maxMode: false, selectedModels: [{ modelId: 'grok-4.6', parameters: [{ id: 'effort', value: 'medium' }, { id: 'fast', value: 'false' }] }] },
    subComposerIds: [], subagentComposerIds: [], todos: [], speculativeSummarizationEncryptionKey: SENTINEL_SPEC, conversationState: '~',
    blobEncryptionKey: SENTINEL_BLOB, latestChatGenerationUUID: uuid('9e9e9e9e', Number.parseInt(cid.slice(6, 8), 10)), workspaceIdentifier: WS_ID,
    ...extra,
  };
}
function headerRow(cid, createdAt, extra = {}, value = {}) {
  return {
    composerId: cid, workspaceId: WS_ID.id, createdAt, lastUpdatedAt: createdAt + 90000, isArchived: 0, isSubagent: 0, recency: createdAt + 90000,
    checkpointAt: null, subagentTypeName: '',
    value: {
      type: 'head', composerId: cid, name: 'Toy cart qty fix', lastUpdatedAt: createdAt + 90000, createdAt, unifiedMode: 'agent', forceMode: 'edit',
      hasUnreadMessages: false, contextUsagePercent: 6.4, isDraft: false, workspaceIdentifier: WS_ID, ...value,
    },
    ...extra,
  };
}
function chat(s, cid, bubbles, { at = T0 - 1600, data = {}, head = {}, headValue = {}, extraBubbles = [] } = {}) {
  s.header(headerRow(cid, at, head, { name: data.name ?? 'Toy cart qty fix', unifiedMode: data.unifiedMode ?? 'agent', ...headValue }));
  s.kv(`composerData:${cid}`, composerData(cid, bubbles, { createdAt: at, ...data }));
  for (const b of [...bubbles, ...extraBubbles]) s.kv(`bubbleId:${cid}:${b.bubbleId}`, b, { blob: true });
}

// The three turns of memhouse's base test chat: a question answered after a read; a test run whose
// shell
// exits 1; a 90-second loop the user stops (the shell cancelled, its partial output kept).
const U = (n) => uuid(n === 1 ? '1508332b' : `b0b0b0${String(n).padStart(2, '0')}`, n);
function turns(t = T0) {
  const [U1, U2, U3] = [U(1), U(2), U(3)];
  const t1 = [
    userBubble(U1, t, 'What does total_cents do in cart.py?'),
    think(U1, 0, t + 2000, 'Read cart.py first.'),
    say(U1, 1, t + 2003, 'Reading cart.py.'),
    tool(U1, CALL(1), t + 2020, { name: 'read_file_v2', rawArgs: JSON.stringify({ path: `${WS}/toyshop/cart.py` }), params: { targetFile: `${WS}/toyshop/cart.py`, charsLimit: 1000000 }, result: { totalLinesInFile: 8 }, toolNo: 40 }),
    think(U1, 3, t + 4500, 'It sums price times qty.'),
    say(U1, 4, t + 4501, 'total_cents sums price * qty over the items.', { turnDurationMs: 5847 }),
  ];
  const t2 = [
    userBubble(U2, t + 44000, 'Run the tests.'),
    think(U2, 0, t + 46000, 'Use pytest.'),
    say(U2, 1, t + 46100, 'Running pytest.'),
    tool(U2, CALL(2, 1), t + 46200, {
      name: 'run_terminal_command_v2', params: { command: 'python3 -m pytest -q', cwd: WS, options: { timeout: 30000 } },
      result: { output: '/usr/bin/python3: No module named pytest\n', exitCode: 1, rejected: false, notInterrupted: true }, additionalData: { status: 'error', startedAtMs: t + 46210 },
    }),
    say(U2, 4, t + 52000, 'pytest is not installed.', { turnDurationMs: 8000 }),
  ];
  const t3 = [
    userBubble(U3, t + 120000, 'Run: for i in $(seq 1 90); do echo tick $i; sleep 1; done'),
    think(U3, 0, t + 121800, 'A 90-second loop.'),
    say(U3, 1, t + 123600, 'Running the loop and waiting.'),
    tool(U3, CALL(3, 13), t + 123650, {
      name: 'run_terminal_command_v2', params: { command: 'for i in $(seq 1 90); do echo tick $i; sleep 1; done', options: { timeout: 110000 } },
      status: 'cancelled', result: { output: 'tick 1\ntick 2\ntick 3\n', rejected: false }, additionalData: { status: 'cancelled' },
    }),
  ];
  return { t1, t2, t3 };
}

function features() {
  const s = new Store();
  s.item('composer.composerHeaders.version', '1792500347317-3');
  // A login row, as the real store keeps one in ItemTable: no query of the adapter names it.
  s.item(['cursor', 'Auth/accessToken'].join(''), SENTINEL_LOGIN);
  const { t1, t2, t3 } = turns();

  // 1. Three turns on the free plan.
  chat(s, CID(1), [...t1, ...t2, ...t3]);

  // 2. The same three turns, then an edit of turn 2: its user bubble rewritten in place (same id),
  // its children overwritten with the new answer, every later bubble hard-deleted, the list
  // rewritten.
  const E = turns(T0 + 1000000);
  chat(s, CID(2), [...E.t1, ...E.t2, ...E.t3], { at: T0 + 1000000 - 1600, data: { name: 'Toy cart tests' }, headValue: { name: 'Toy cart tests' } });

  // 3. A fork of chat 1: a new composer `(1) <name>`, the bubbles copied with their ids and times,
  // no
  // parent field; archived afterwards (a flag, no time).
  chat(s, CID(3), [...t1], {
    at: T0 + 400000, data: { name: '(1) Toy cart qty fix' }, head: { isArchived: 1 }, headValue: { name: '(1) Toy cart qty fix', isArchived: true },
  });

  // 4. A chat that started sub-agents (named twice, once as an object), and 5. the one stored.
  const SUB1 = CID(5);
  const SUB2 = CID(13);
  const P1 = U(41);
  chat(s, CID(4), [userBubble(P1, T0 + 500000, 'Explore toyshop/ with a sub-agent.'), say(P1, 0, T0 + 503000, 'The explorer found cart.py and tests/.')], {
    at: T0 + 499000, data: { name: 'Explore toyshop', subagentComposerIds: [SUB1, SUB1, { composerId: SUB2 }] }, headValue: { name: 'Explore toyshop' },
  });
  const C1 = U(51);
  chat(s, SUB1, [userBubble(C1, T0 + 501000, 'List the files in toyshop/.'), say(C1, 0, T0 + 502000, 'cart.py, __init__.py')], {
    at: T0 + 500900, data: { name: 'explore toyshop' }, head: { isSubagent: 1, subagentTypeName: 'explore' }, headValue: { name: 'explore toyshop' },
  });

  // 6. The older format: bubbles inline in composerData.conversation, a standalone assistant
  // bubble.
  const O1 = U(61);
  const old = {
    _v: 3, composerId: CID(6), name: 'Old format', createdAt: T0 + 600000, unifiedMode: 'agent', status: 'completed', workspaceIdentifier: WS_ID,
    conversation: [
      userBubble(O1, T0 + 600100, 'Fix qty.'),
      { type: 2, bubbleId: uuid('a0a0a062', 62), createdAt: iso(T0 + 603000), text: 'Fixed qty.', thinking: { text: 'qty is ignored' }, tokenCount: { inputTokens: 900, outputTokens: 12 } },
    ],
  };
  s.header(headerRow(CID(6), T0 + 600000, {}, { name: 'Old format' }));
  s.kv(`composerData:${CID(6)}`, old);

  // 7. Ask mode: an image and a free-text sentinel in the prompt; opaque reasoning (a signature,
  // no text), a rejected tool, paid-plan tokens on the reply's bubbles; a second prompt kept only
  // as
  // rich text; a bubble the list does not name.
  const X1 = U(71);
  const X2 = U(72);
  const img = { uuid: uuid('1a1a1a1a', 71), path: `${WS}/label.png` };
  const x = [
    userBubble(X1, T0 + 700000, `Describe label.png. My note: ${SENTINEL_TEXT}`, { context: { selectedImages: [img], mentions: {} } }),
    think(X1, 0, T0 + 702000, '', { thinking: { text: '', signature_len: 312 }, tokenCount: { inputTokens: 1200, outputTokens: 30 } }),
    tool(X1, CALL(7), T0 + 702100, { name: 'run_terminal_command_v2', params: { command: 'rm -rf toyshop' }, status: 'rejected', result: { rejected: true } }),
    say(X1, 2, T0 + 703000, 'A price label reading 2.50.', { tokenCount: { inputTokens: 1500, outputTokens: 0 } }),
    userBubble(X2, T0 + 704000, '', { richText: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'And ' }, { type: 'text', text: 'the price?' }] }] }) }),
    say(X2, 0, T0 + 705000, '2.50.'),
  ];
  chat(s, CID(7), x, {
    at: T0 + 699000, data: { name: 'Label question', unifiedMode: 'chat' }, headValue: { name: 'Label question', unifiedMode: 'chat' },
    extraBubbles: [userBubble(uuid('deadbeef', 70), T0 + 700500, 'not in the header list')],
  });

  // 8. Turn 2 still generating: its user bubble and a first segment are written.
  const G = turns(T0 + 800000);
  chat(s, CID(8), [...G.t1, G.t2[0], G.t2[1], { ...G.t2[2], text: 'Runn' }], {
    at: T0 + 798400, data: { name: 'Still generating', status: 'generating', generatingBubbleIds: [U(2)] }, headValue: { name: 'Still generating' },
  });

  // 9. Turn 2's shell still running (status loading, no result): the last turn, so held.
  const R = turns(T0 + 900000);
  const running = (t) => tool(U(2), CALL(2, 1), t + 46200, { name: 'run_terminal_command_v2', params: { command: 'python3 -m pytest -q' }, status: 'loading' });
  chat(s, CID(9), [...R.t1, ...R.t2.slice(0, 3), running(T0 + 900000)], { at: T0 + 898400, data: { name: 'Tool running' }, headValue: { name: 'Tool running' } });

  // 10. The same running shell, and then a later prompt: the turn has ended, so it is interrupted.
  const I = turns(T0 + 1100000);
  chat(s, CID(10), [...I.t1, ...I.t2.slice(0, 3), running(T0 + 1100000), userBubble(U(3), T0 + 1100000 + 300000, 'Never mind.')], {
    at: T0 + 1098400, data: { name: 'Tool interrupted' }, headValue: { name: 'Tool interrupted' },
  });

  // 11. A draft: a header, no composerData, no bubble.
  s.header(headerRow(CID(11), T0 + 1200000, { workspaceId: 'empty-window' }, { name: undefined, isDraft: true, workspaceIdentifier: { id: 'empty-window' } }));

  // 12. A listed bubble not stored yet (turn 1's second thinking segment): the reply is held.
  const W = turns(T0 + 1300000);
  s.header(headerRow(CID(12), T0 + 1298400, {}, { name: 'Torn view' }));
  s.kv(`composerData:${CID(12)}`, composerData(CID(12), W.t1, { createdAt: T0 + 1298400, name: 'Torn view' }));
  for (const b of W.t1.filter((b) => !b.bubbleId.endsWith('/s:3'))) s.kv(`bubbleId:${CID(12)}:${b.bubbleId}`, b, { blob: true });

  // The edit of chat 2 (after the other chats were written).
  const e = E.t2[0].createdAt;
  const T2 = Date.parse(e);
  const edited = [
    userBubble(U(2), T2, 'Run the tests with unittest instead.'),
    think(U(2), 0, T2 + 156000, 'Use unittest.'),
    say(U(2), 1, T2 + 156100, 'Ran unittest: 3 tests OK.', { turnDurationMs: 3000 }),
  ];
  for (const b of edited) s.kv(`bubbleId:${CID(2)}:${b.bubbleId}`, b, { blob: true });
  for (const b of [E.t2[3], E.t2[4], ...E.t3]) s.del(`bubbleId:${CID(2)}:${b.bubbleId}`);
  s.kv(`composerData:${CID(2)}`, composerData(CID(2), [...E.t1, ...edited], { createdAt: T0 + 1000000 - 1600, name: 'Toy cart tests' }));

  write('features', s);
}

lab();
features();
