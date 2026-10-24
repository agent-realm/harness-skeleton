// Writes the Gemini CLI fixture stores (each case's `store/` is a `.gemini` folder):
//   node fixtures/gemini-cli/generate.js
//
// - `pass3`: one session assembled from the fixture captures's pass3 records
//   (synthetic, captured 2026-10-21 on a test VM; Gemini CLI 0.65.0,
//   scrubbed: home `/home/user`, model gateway `gateway/…`, long text cut at `…[cut]`), kept below
//   verbatim in CAPTURED, plus filler records marked SYNTHETIC where a turn needs one. The captures
//   came from several lab sessions, so their order here is a plausible one, not a recording.
// - `features`: generated, one record per behaviour the adapter claims, in the CLI's record shapes
//   (spec §3 and the builders of memhouse's normaliser test).
// - `legacy`: generated pre-0.6x `.json` sessions, and a `.json` the CLI migrated to `.jsonl`.
// - `rewind/` is not written here: it is the scrubbed capture of session 56749748 (Gemini CLI
//   0.64.0), the annex's normative rewind case, copied as is.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CTX = 'd04923d38bb0f6017037e74183378ef4';
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (recs) => recs.map((r) => JSON.stringify(r) + '\n').join('');

function writeCase(name, files) {
  const dir = path.join(HERE, name, 'store');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

// ---- pass3 ------------------------------------------------------------------------------------

// Scrubbed pass3 records, verbatim (the fixture captures's pass3 records,
// re-extracted under the normative redaction rule).
const CAPTURED = {
  header: {"sessionId":"bcda44a6-7aee-4ac4-aede-10eb47e79153","projectHash":"df592b4da7a7a585187c543f2213c6a5f89eef6e49ea280eb7e631f118b09cdf","startTime":"2026-10-21T19:56:42.340Z","lastUpdated":"2026-10-21T19:56:42.340Z","kind":"main"},
  context: {"id":"d04923d38bb0f6017037e74183378ef4","timestamp":"2026-10-21T19:56:42.341Z","type":"user","content":[{"text":"<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\nToday's date is Wednesday, October 21, 2026 (formatted according to the user's locale).\nMy operating system is: linux\nThe project's temporary directory is: /home/user/.gemini/tmp/toyshop-1\n- **Workspace Directories:**\n  - /home/user/work/gm3/toyshop\n- **Directory Structure:**\n\nShowing up to 200 items (files + f…[cut]"}]},
  reply: {"id":"23efd3c8-f4e1-4052-8424-0d63358bf9ef","timestamp":"2026-10-21T19:56:44.531Z","type":"gemini","content":"OK","thoughts":[],"tokens":{"input":10313,"output":1,"cached":0,"thoughts":0,"tool":0,"total":10314},"model":"gateway/toy-model-d"},
  toolTurn: {"id":"e543b85d-b03f-4701-8c6a-33589752205b","timestamp":"2026-10-21T20:09:24.232Z","type":"gemini","content":"","thoughts":[],"tokens":{"input":1234,"output":17,"cached":900,"thoughts":0,"tool":0,"total":1251},"model":"mock-model","toolCalls":[{"id":"read_file__read_file_1792613364141_0","name":"read_file","args":{"file_path":"toyshop/cart.py"},"result":[{"functionResponse":{"id":"read_file__read_file_1792613364141_0","name":"read_file","response":{"output":"\"\"\"Shopping cart for the toyshop.\"\"\"\nfrom dataclasses import dataclass, field\n\n\n@dataclass\nclass Item:\n    sku: str\n    price_cents: int\n    qty: int = 1\n\n\n@dataclass\nclass Cart:\n    items: list = field(default_factory=list)\n\n    def add(self, item: Item) -> None:\n        self.items.append(item)\n\n    def total_cents(self) -> int:\n        return sum(i.price_cents * i.qty for i in self.items)\n\n    d…[cut]"}}}],"status":"success","timestamp":"2026-10-21T20:09:24.252Z","resultDisplay":"","description":"toyshop/cart.py","displayName":"ReadFile","renderOutputAsMarkdown":true}]},
  echo: {"id":"13d972b3-827d-4009-9ffe-1e2fb7c71f83","timestamp":"2026-10-21T20:09:24.254Z","type":"user","content":[{"functionResponse":{"id":"read_file__read_file_1792613364141_0","name":"read_file","response":{"output":"\"\"\"Shopping cart for the toyshop.\"\"\"\nfrom dataclasses import dataclass, field\n\n\n@dataclass\nclass Item:\n    sku: str\n    price_cents: int\n    qty: int = 1\n\n\n@dataclass\nclass Cart:\n    items: list = field(default_factory=list)\n\n    def add(self, item: Item) -> None:\n        self.items.append(item)\n\n    def total_cents(self) -> int:\n        return sum(i.price_cents * i.qty for i in self.items)\n\n    d…[cut]"}}}]},
  lastUpdated: {"$set":{"lastUpdated":"2026-10-21T19:56:42.342Z"}},
  scratchpad: {"$set":{"memoryScratchpad":{"version":1,"workflowSummary":"write_file | paths notes-mock.txt","toolSequence":["write_file"],"touchedPaths":["notes-mock.txt"]}}},
  patch: {"$patch":{"updates":[{"id":"55cc788a-54de-4def-a348-3eff79e80783","content":[{"text":"Synthetic reply 9"}]}],"removeIds":["beb7df0b-d0bc-42fa-9c90-24eccf88c683","c77ab2e9-bca4-4c56-b79d-cbb56439eea8","224ba9ff-ab86-49d0-8f58-dcb36cc321cf"]}},
  infos: [{"id":"beb7df0b-d0bc-42fa-9c90-24eccf88c683","timestamp":"2026-10-21T20:17:15.021Z","type":"info","content":"No restorable tool calls found."},{"id":"224ba9ff-ab86-49d0-8f58-dcb36cc321cf","timestamp":"2026-10-21T20:19:46.958Z","type":"info","content":"Request cancelled."},{"id":"a506aa6a-b306-4b91-987d-7615da50e143","timestamp":"2026-10-21T20:20:08.018Z","type":"info","content":"Conversation checkpoint saved with tag: point-one."}],
  checkpoint: {"history":[{"role":"user","parts":[{"text":"<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\nToday's date is Wednesday, October 21, 2026 (formatted according to the user's locale).\nMy operating system is: linux\nThe project's temporary directory is: /home/user/.gemini/tmp/toyshop-1\n- **Workspace Directories:**\n  - /home/user/work/gm3/toyshop\n- **Directory Structure:**\n\nShowing up to 200 items (files + f…[cut]"},{"text":"make notes-mock.txt."}]},{"role":"model","parts":[{"text":"Synthetic reply 9"}]},{"role":"user","parts":[{"text":"add a toy helper."}]}],"authType":"<redacted len=14>"},
  logs: [{"sessionId":"f6bae9cd-9a86-4c39-baa0-d90fd4e62d07","messageId":2,"type":"user","message":"add a toy helper.","timestamp":"2026-10-21T20:19:26.280Z"},{"sessionId":"f6bae9cd-9a86-4c39-baa0-d90fd4e62d07","messageId":3,"type":"user","message":"/resume save point-one","timestamp":"2026-10-21T20:20:07.977Z"},{"sessionId":"f6bae9cd-9a86-4c39-baa0-d90fd4e62d07","messageId":4,"type":"user","message":"/resume list","timestamp":"2026-10-21T20:20:26.178Z"},{"sessionId":"f6bae9cd-9a86-4c39-baa0-d90fd4e62d07","messageId":5,"type":"user","message":"describe the toy","timestamp":"2026-10-21T20:20:34.351Z"}],
};

function pass3() {
  const C = CAPTURED;
  const set = (t) => ({ $set: { lastUpdated: t } });
  const [restorable, cancelled, saved] = C.infos;
  const recs = [
    C.header,
    C.context,
    C.lastUpdated,
    // SYNTHETIC: the prompt the captured reply answers.
    { id: '0b4c7e21-6a5d-4f38-9e12-3c4d5e6f7a80', timestamp: '2026-10-21T19:56:43.900Z', type: 'user', content: [{ text: 'Say ok please.' }] },
    set('2026-10-21T19:56:43.901Z'),
    C.reply,
    set('2026-10-21T19:56:44.532Z'),
    // SYNTHETIC: the prompt of the captured tool turn.
    { id: '1c5d8f32-7b6e-4049-8f23-4d5e6f7a8b91', timestamp: '2026-10-21T20:09:23.000Z', type: 'user', content: [{ text: 'open toyshop/cart.py' }] },
    C.toolTurn,
    C.echo,
    set('2026-10-21T20:09:24.255Z'),
    // SYNTHETIC: the prompt and the draft reply the captured $patch revises (its text is the
    // normaliser test's `Mock reply: draft.`; tokens from the pass3 headless stats).
    { id: '2d6e9043-8c7f-415a-9034-5e6f7a8b9ca2', timestamp: '2026-10-21T20:17:00.000Z', type: 'user', content: [{ text: 'make notes-mock.txt.' }] },
    { id: '55cc788a-54de-4def-a348-3eff79e80783', timestamp: '2026-10-21T20:17:02.000Z', type: 'gemini', content: 'Synthetic reply 43', thoughts: [], tokens: { input: 1234, output: 17, cached: 900, thoughts: 5, tool: 0, total: 1256 }, model: 'mock-model' },
    restorable,
    // SYNTHETIC body for the captured removeIds' second id: the prompt the captured logs.json row
    // (messageId 2) records at this time.
    { id: 'c77ab2e9-bca4-4c56-b79d-cbb56439eea8', timestamp: '2026-10-21T20:19:26.280Z', type: 'user', content: [{ text: 'add a toy helper.' }] },
    cancelled,
    saved,
    C.patch,
    // SYNTHETIC: the next prompt (its text and time are the captured logs.json row messageId 5) and
    // its reply.
    { id: '3e7fa154-9d80-426b-a145-6f7a8b9cadb3', timestamp: '2026-10-21T20:20:34.351Z', type: 'user', content: [{ text: 'describe the toy' }] },
    set('2026-10-21T20:20:34.352Z'),
    { id: '4f80b265-ae91-437c-b256-7a8b9cadbec4', timestamp: '2026-10-21T20:20:36.000Z', type: 'gemini', content: 'Synthetic reply 55d80b. synthetic reply text for the toy sh', thoughts: [], tokens: { input: 1301, output: 14, cached: 0, thoughts: 0, tool: 0, total: 1315 }, model: 'mock-model' },
    set('2026-10-21T20:20:36.001Z'),
    C.scratchpad,
  ];
  const slug = 'tmp/toyshop-1';
  return [
    [`${slug}/chats/session-2026-10-21T19-56-bcda44a6.jsonl`, jsonl(recs)],
    // SYNTHETIC: the slug's workspace path, as the context names it.
    [`${slug}/.project_root`, '/home/user/work/gm3/toyshop\n'],
    // Never opened by the adapter: a /chat save checkpoint (it carries `authType`), the prompt log,
    // the project index and a rewrite backup.
    [`${slug}/checkpoint-point-one.json`, JSON.stringify(C.checkpoint, null, 2) + '\n'],
    [`${slug}/logs.json`, JSON.stringify(C.logs, null, 2) + '\n'],
    ['projects.json', JSON.stringify({ projects: { '/home/user/work/toyshop': 'toyshop', '/home/user/work/gm3/toyshop': 'toyshop-1' } }, null, 2) + '\n'],
    [`${slug}/chats/session-2026-10-21T19-56-bcda44a6.jsonl.unreadable-1792613364141`, 'not a session\n'],
  ];
}

// ---- features ---------------------------------------------------------------------------------

const SID_A = '7f3e9a10-5c2d-4b8e-9f01-2a3b4c5d6e7f';
const SID_B = '5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e';
const SID_D = '6e7f8091-a2b3-4c4d-9e5f-6a7b8c9d0e1f';
const CHILD = 'a7c3e9f0-1b2c-4d3e-8f4a-5b6c7d8e9f01';
const HASH = (c) => c.repeat(64);
let seq = 0;
const mid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const callId = (name, t, i = 0) => `${name}__${name}_${t}_${i}`;

const contextText = (cwd, slug, date) => `<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\nToday's date is ${date} (formatted according to the user's locale).\nMy operating system is: linux\nThe project's temporary directory is: /home/user/.gemini/tmp/${slug}\n- **Workspace Directories:**\n  - ${cwd}\n- **Directory Structure:**\n\nShowing up to 200 items (files + folders).\n\n${cwd}/\n├───cart.py\n└───tests/\n</session_context>`;
const header = (sid, t, over = {}) => ({ sessionId: sid, projectHash: HASH('3'), startTime: iso(t), lastUpdated: iso(t), kind: 'main', ...over });
const ctx = (t, cwd = '/home/user/work/toyshop') => ({ id: CTX, timestamp: iso(t), type: 'user', content: [{ text: contextText(cwd, 'toyshop', 'Tuesday, February 3, 2026') }] });
const set = (t) => ({ $set: { lastUpdated: iso(t) } });
const user = (id, t, content, over = {}) => ({ id, timestamp: iso(t), type: 'user', content: typeof content === 'string' ? [{ text: content }] : content, ...over });
const tokens = (input, output, cached = 0, thoughts = 0, tool = 0) => ({ input, output, cached, thoughts, tool, total: input + output + thoughts });
const gemini = (id, t, content, over = {}) => ({ id, timestamp: iso(t), type: 'gemini', content, thoughts: [], tokens: tokens(1234, 17), model: 'gemini-3.5-flash', ...over });
const fr = (id, name, response) => ({ functionResponse: { id, name, response } });
const call = (id, name, args, t, response, over = {}) => ({
  id, name, args, result: [fr(id, name, response)], status: 'success', timestamp: iso(t),
  resultDisplay: '', description: String(Object.values(args)[0] ?? ''), displayName: name, renderOutputAsMarkdown: true, ...over,
});
const note = (id, t, content, type = 'info') => ({ id, timestamp: iso(t), type, content });

function features() {
  const T = Date.UTC(2026, 1, 3, 10, 0, 0);
  const CART = 'class Cart:\n    def total_cents(self):\n        return sum(i.price_cents for i in self.items)\n';
  const C1 = callId('read_file', T + 2100);
  const C2 = callId('run_shell_command', T + 4000);
  const C3 = callId('write_file', T + 4000, 1);
  const C6 = callId('codebase_investigator', T + 15000);
  const C9 = callId('run_shell_command', T + 19000);
  const [U1, G1, E1, G2, E2, G3, UIMG, ORPH, UMIX, W1, UDISP, UHOOK, UPDF, U5, G6, E6, G9, I9, U7, G7, U8, G8, G10] = Array.from({ length: 23 }, mid);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
  const thought = { subject: 'Reading the cart', description: 'The total ignores qty; check total_cents first.', timestamp: iso(T + 1500) };
  const g1 = gemini(G1, T + 2000, 'I will read the cart first.', { thoughts: [thought], tokens: tokens(1234, 17, 900, 5, 42) });
  const g2 = gemini(G2, T + 3000, '', { tokens: tokens(2468, 34, 1800) });
  const shellError = { error: 'Command exited with code 1: 1 failed' };
  const a = [
    header(SID_A, T),
    ctx(T + 1), set(T + 2),
    user(U1, T + 1000, 'Fix the qty bug in cart.py, then run python3 -m pytest -q.'), set(T + 1001),
    // A reply is written when its stream ends, then rewritten with its calls once they complete
    // (same id, last wins), and each result is echoed as a user record.
    g1, set(T + 2001),
    { ...g1, toolCalls: [call(C1, 'read_file', { file_path: 'toyshop/cart.py' }, T + 2100, { output: CART })] },
    user(E1, T + 2200, [fr(C1, 'read_file', { output: CART })]), set(T + 2201),
    // A tool-only reply: no text; a failing command and a cancelled edit.
    g2,
    { ...g2, toolCalls: [
      call(C2, 'run_shell_command', { command: 'python3 -m pytest -q' }, T + 4000, shellError, { status: 'error' }),
      call(C3, 'write_file', { file_path: 'toyshop/cart.py', content: 'x' }, T + 4100, { output: 'User cancelled the edit.' }, { status: 'cancelled' }),
    ] },
    user(E2, T + 4200, [fr(C2, 'run_shell_command', shellError), fr(C3, 'write_file', { output: 'User cancelled the edit.' })]),
    // Zero token counts are stored as 0 for unknown.
    gemini(G3, T + 6000, 'Fixed: total_cents multiplies by qty.', { tokens: tokens(3000, 12) }),
    set(T + 6001), { $set: { memoryScratchpad: { version: 1, workflowSummary: 'read_file | run_shell_command', toolSequence: ['read_file'], touchedPaths: ['toyshop/cart.py'] } } },
    // The CLI's session summary: the title.
    { $set: { summary: 'Fix the toy cart qty bug' } },
    // An inline image.
    user(UIMG, T + 7000, [{ text: 'Describe @label.png' }, { inlineData: { mimeType: 'image/png', data: png } }]),
    // A result whose call no gemini record holds: a tool message.
    user(ORPH, T + 7100, [fr('lost_call_1', 'read_file', { output: 'tests/test_cart.py' })]),
    // A prompt and such a result in one record: two speakers, two messages.
    user(UMIX, T + 7200, [{ text: 'Here is what the earlier run printed.' }, fr('lost_call_2', 'run_shell_command', { output: '3 passed' })]),
    note(W1, T + 7300, 'Approaching the context limit.', 'warning'),
    // What the UI showed differs from what the model saw (an @file expansion).
    user(UDISP, T + 7400, [{ text: 'Summarise @cart.py' }, { text: '\n--- cart.py ---\ndef total_cents(items): ...' }], { displayContent: [{ text: 'Summarise @cart.py' }] }),
    // Hook output injected as a user record.
    user(UHOOK, T + 7500, '<hook_context>synthetic hook output: tests are in tests/</hook_context>'),
    // A file given by URI.
    user(UPDF, T + 7600, [{ text: 'Read the spec.' }, { fileData: { mimeType: 'application/pdf', fileUri: 'https://example.com/spec.pdf' } }]),
    // A sub-agent call (source-only): the call names the child session by `agentId`.
    user(U5, T + 10000, 'Use a sub-agent to list the test files.'),
    gemini(G6, T + 11000, '', { toolCalls: [call(C6, 'codebase_investigator', { objective: 'list tests' }, T + 15000, { output: 'tests/test_cart.py' }, { agentId: CHILD })] }),
    user(E6, T + 15001, [fr(C6, 'codebase_investigator', { output: 'tests/test_cart.py' })]),
    // A call that never finished, then a cancel notice: written as interrupted.
    gemini(G9, T + 18000, '', { toolCalls: [{ id: C9, name: 'run_shell_command', args: { command: 'sleep 99' }, result: null, status: 'executing', timestamp: iso(T + 19000) }] }),
    note(I9, T + 19500, 'Request cancelled.'),
    // History sync: a reply revised, a tool result revised, the warning retracted.
    { $patch: { updates: [
      { id: G3, content: [{ text: 'Fixed: total_cents multiplies price by qty.' }] },
      { id: G1, toolCalls: [{ id: C1, result: [fr(C1, 'read_file', { output: CART.replace('i.price_cents', 'i.price_cents * i.qty') })] }] },
    ], removeIds: [W1] } },
    // A retry: the rewind retracts the prompt and everything after it.
    user(U7, T + 20000, 'Add a discount field.'),
    gemini(G7, T + 21000, 'Added a discount field.', { tokens: tokens(4000, 20) }),
    { $rewindTo: U7 }, set(T + 22000),
    user(U8, T + 22001, 'Add a discount field, with a test.'),
    gemini(G8, T + 23000, 'Added a discount field and a test.', { tokens: tokens(4100, 25) }),
    set(T + 23001),
    // The next reply's stream has not ended: no text, no call yet (held).
    gemini(G10, T + 24000, '', { tokens: tokens(4200, 3) }),
  ];

  // A second session: a rewind to the very start; the CLI injects the context again under its fixed
  // id, which is current at its new place.
  const TB = Date.UTC(2026, 1, 4, 9, 0, 0);
  const [B1, B2, B3, B4] = Array.from({ length: 4 }, mid);
  const b = [
    header(SID_B, TB), ctx(TB + 1), set(TB + 2),
    user(B1, TB + 1000, 'write notes.txt'),
    gemini(B2, TB + 2000, 'Done: notes.txt written.'),
    { $rewindTo: CTX }, set(TB + 3000),
    ctx(TB + 3001),
    user(B3, TB + 3002, 'Start over: add a discount field.'),
    gemini(B4, TB + 4000, 'Starting over.', { tokens: tokens(1500, 4) }),
  ];

  // The sub-agent's own session, in its main session's directory (source-only shape).
  const TC = T + 11001;
  const [C1u, C2g] = Array.from({ length: 2 }, mid);
  const child = [
    header(CHILD, TC, { kind: 'subagent', directories: ['/home/user/work/toyshop'] }),
    user(C1u, TC + 1, 'Find the test files.'),
    gemini(C2g, TC + 2000, 'tests/test_cart.py', { tokens: tokens(800, 6) }),
  ];

  // A third session: replies whose content the history sync rewrote as API parts. D2 holds a call
  // and thought summaries but no `thought` part, so the summaries are its only reasoning; D4's
  // content carries a `thought` part, which stands for its summary. Fixed ids, so the other cases'
  // ids do not move.
  const TD = Date.UTC(2026, 1, 5, 9, 0, 0);
  const [D1, D2, D3, D4] = [1, 2, 3, 4].map((n) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`);
  const CD = callId('run_shell_command', TD + 2100);
  const pytest = { command: 'python3 -m pytest -q' };
  const d2 = gemini(D2, TD + 2000, 'Running the tests.', {
    thoughts: [{ subject: 'Checking the suite', description: 'Run pytest before touching the cart.', timestamp: iso(TD + 1500) }],
    toolCalls: [call(CD, 'run_shell_command', pytest, TD + 2100, { output: '3 passed' })],
  });
  const d4 = gemini(D4, TD + 4000, 'All green.', {
    thoughts: [{ subject: 'Wrapping up', description: 'The suite passes.', timestamp: iso(TD + 3500) }],
  });
  const d = [
    header(SID_D, TD), ctx(TD + 1), set(TD + 2),
    user(D1, TD + 1000, 'Run the tests.'),
    d2,
    user(D3, TD + 2200, [fr(CD, 'run_shell_command', { output: '3 passed' })]),
    d4, set(TD + 4001),
    { $patch: { updates: [
      { id: D2, content: [{ text: 'Running the tests.' }, { functionCall: { id: CD, name: 'run_shell_command', args: pytest } }] },
      { id: D4, content: [{ text: 'The suite passes.', thought: true }, { text: 'All green.' }] },
    ] } },
  ];

  const slug = 'tmp/toyshop';
  return [
    [`${slug}/chats/session-2026-02-03T10-00-${SID_A.slice(0, 8)}.jsonl`, jsonl(a)],
    [`${slug}/chats/session-2026-02-04T09-00-${SID_B.slice(0, 8)}.jsonl`, jsonl(b)],
    [`${slug}/chats/session-2026-02-05T09-00-${SID_D.slice(0, 8)}.jsonl`, jsonl(d)],
    [`${slug}/chats/${SID_A}/${CHILD}.jsonl`, jsonl(child)],
    [`${slug}/.project_root`, '/home/user/work/toyshop\n'],
  ];
}

// ---- legacy -----------------------------------------------------------------------------------

function legacy() {
  const T = Date.UTC(2025, 8, 1, 10, 0, 0);
  const L1 = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
  const L2 = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60';
  const slug = 'tmp/old-proj';
  // Pre-0.6x: one pretty-printed object per session, sessionId first, no kind, no context record.
  const old = {
    sessionId: L1, projectHash: HASH('5'), startTime: iso(T), lastUpdated: iso(T + 3000),
    messages: [
      user(mid(), T + 1000, 'What does old-proj do?'),
      gemini(mid(), T + 2000, 'It prints a greeting.', { tokens: tokens(900, 8) }),
    ],
  };
  const T2 = Date.UTC(2025, 8, 2, 11, 0, 0);
  const before = [user(mid(), T2 + 1000, 'hello'), gemini(mid(), T2 + 2000, 'hi', { tokens: tokens(700, 1) })];
  const migrated = { sessionId: L2, projectHash: HASH('5'), startTime: iso(T2), lastUpdated: iso(T2 + 2000), messages: before };
  const L2name = `session-2025-09-02T11-00-${L2.slice(0, 8)}`;
  return [
    [`${slug}/chats/session-2025-09-01T10-00-${L1.slice(0, 8)}.json`, JSON.stringify(old, null, 2) + '\n'],
    // The CLI resumed L2: it kept the .json and wrote the .jsonl (same sessionId), which wins.
    [`${slug}/chats/${L2name}.json`, JSON.stringify(migrated, null, 2) + '\n'],
    [`${slug}/chats/${L2name}.jsonl`, jsonl([
      { sessionId: L2, projectHash: HASH('5'), startTime: iso(T2), lastUpdated: iso(T2), kind: 'main' },
      ...before,
      user(mid(), T2 + 60000, 'resumed'),
      set(T2 + 60001),
    ])],
    // Not sessions: a first line that is no header (its sessionId is nested), and a header line
    // still being written.
    [`${slug}/chats/session-2025-09-03T12-00-e3f4a5b6.jsonl`, jsonl([{ $set: { sessionId: 'e3f4a5b6-c7d8-4e9f-8a0b-1c2d3e4f5a6b', kind: 'subagent' } }])],
    [`${slug}/chats/session-2025-09-04T12-00-f4a5b6c7.jsonl`, '{"sessionId": "f4a5b6c7-d8e9-4f0a'],
    [`${slug}/.project_root`, '/home/user/work/old-proj\n'],
  ];
}

writeCase('pass3', pass3());
writeCase('features', features());
writeCase('legacy', legacy());
