// Writes the VS Code (Local engine) fixture stores, laid out as a user-data folder (`User/...`).
//   node fixtures/vscode/generate.js                      # rewrites `features`
//   node fixtures/vscode/generate.js <scrubbed vscode dir> # also rebuilds `lab`
//
// `features` is synthetic, one op per behaviour the adapter claims, in the shapes of memhouse's
// v4 normaliser test and the fixture captures: a change log
// with renames, an agent turn (tools, opaque reasoning, an inline reference, an MCP tool, a
// warning), a reply written while pending and completed by `kind 1` sets, a sub-agent, a missing
// responseId, attachments, a hidden request, `/compact`, a failed, an abandoned, a cancelled and a
// pending reply, an edit (a `kind 2` with `i`) and a same-id in-place update, the auth sentinel
// set three ways, a malformed line; a legacy `.json` session, one id with both formats, a fork
// (one `kind 0`, bare uuids, reset timestamps) and a mid-file `kind 0`.
//
// `lab` is rebuilt from the scrubbed copies of the lab captures (VS Code 1.142,
// Copilot Chat 0.70.0; home `/home/user`, auth already a marker): the capture's ops log
// split into its two files, without the capture's `_file` / `_line` fields. The capture abbreviates
// a `kind 0`'s `requests` as "[N requests]": session f0da568c's is empty, and fork 65a4e98a's five
// are rebuilt as the capture's agent-turn request (its first request; the capture's "…[N more]"
// marker dropped from `response`) plus four synthetic fork copies, the fifth being the one the
// capture's `kind 2` with `i: 4` cuts. Each workspace.json is synthetic, naming the folder the
// capture's own paths name.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = 'User/workspaceStorage';
const EMPTY = 'User/globalStorage/emptyWindowChatSessions';

// A workspace folder id, as VS Code's is: 32 hex digits derived from the folder URI.
const wsId = (uri) => createHash('sha256').update(uri).digest('hex').slice(0, 32);
const lines = (ops) => ops.map((o) => (typeof o === 'string' ? o : JSON.stringify(o)) + '\n').join('');

function writeCase(name, files) {
  const dir = path.join(HERE, name, 'store');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  // A directory with no chats is not a session.
  fs.mkdirSync(path.join(dir, WS, 'no-chats'), { recursive: true });
  fs.writeFileSync(path.join(dir, WS, 'no-chats', 'state.txt'), 'not a chat\n');
}

// ---- features ---------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 6, 10, 0, 0);
const CWD = '/home/user/work/toy shop';
const CWD_URI = 'file:///home/user/work/toy%20shop';
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;

// The selected model as VS Code writes it; `auth` is the sentinel the adapter must redact.
const selectedModel = (auth) => ({ identifier: 'copilot/auto', metadata: { id: 'auto', vendor: 'copilot', name: 'Auto', family: 'auto', maxInputTokens: 935793, auth, isUserSelectable: true }, modelConfiguration: { tier: 'balance', tierSource: 'default' } });
const session = (sid, requests = [], extra = {}) => ({
  version: 3, creationDate: T0, initialLocation: 'panel', responderUsername: '', sessionId: sid, hasPendingEdits: false,
  requests, pendingRequests: [],
  inputState: { attachments: [], mode: { id: 'agent', kind: 'agent' }, selectedModel: selectedModel({ providerLabel: 'toy-provider', accountLabel: 'toy-account-sentinel-5e1f' }), inputText: '' },
  ...extra,
});
const snapshot = (sid, requests, extra) => ({ kind: 0, v: session(sid, requests, extra) });
const set = (k, v) => ({ kind: 1, k, v });
const splice = (k, v, i) => ({ kind: 2, k, v, ...(i == null ? {} : { i }) });

const md = (value) => ({ value, supportThemeIcons: false, supportHtml: false, baseUri: { $mid: 1, path: `${CWD}/`, scheme: 'file' } });
const thinkingOpaque = () => ({ kind: 'thinking', value: [], id: `b3BhcXVl${uuid().replace(/-/g, '')}` });
const thinkingDone = () => ({ kind: 'thinking', value: '', id: '', metadata: { vscodeReasoningDone: true, stopReason: 'other' } });
const tool = (id, toolId, extra = {}) => ({ kind: 'toolInvocationSerialized', invocationMessage: { value: `Running ${toolId}` }, isConfirmed: { type: 1 }, isComplete: true, source: { type: 'internal', label: 'Built-In' }, ...(id ? { toolCallId: id } : {}), toolId, ...extra });
const tsx = (...ls) => ({ $mid: 20, content: [{ $mid: 23, value: { node: { type: 1, ctor: 2, children: [{ type: 1, ctor: 2, children: ls.map((text) => ({ type: 2, priority: 1, text, lineBreakBefore: true })) }] } } }] });
const plain = (value) => ({ $mid: 20, content: [{ $mid: 21, value }] });
const fileUri = (p) => ({ $mid: 1, fsPath: p, external: `file://${p.replace(/ /g, '%20')}`, path: p, scheme: 'file' });

// One request as VS Code writes it: the user's message, the reply parts, and (when done) its
// result.
function request({ t, text, response = [], rounds = [], results = {}, tokens = [0, 0], model = 'mai-code-1.1-flash', done = true, responseId = true, id, extra = {} }) {
  const r = {
    requestId: id ?? `request_${uuid()}`, timestamp: t,
    agent: { extensionId: { value: 'GitHub.copilot-chat', _lower: 'github.copilot-chat' }, extensionVersion: '0.70.0', id: 'github.copilot.editsAgent', name: 'agent' },
    modelId: 'copilot/auto', modelConfiguration: { tier: 'balance', tierSource: 'default' }, hiddenFromTranscript: false,
    ...(responseId ? { responseId: `response_${uuid()}` } : {}), responseTimestamp: t + 1,
    modeInfo: { kind: 'agent', isBuiltin: true, telemetryModeId: 'agent', telemetryModeName: 'agent', permissionLevel: 'default' },
    response, message: { text, parts: [{ range: { start: 0, endExclusive: text.length }, text, kind: 'text' }] }, variableData: { variables: [] },
    ...extra,
  };
  if (done) {
    r.result = {
      timings: { firstProgress: 900, totalElapsed: 4000 },
      metadata: {
        codeBlocks: [], promptTokens: tokens[0], outputTokens: 102, toolCallRounds: rounds, toolCallResults: results,
        resolvedModel: model, modelMessageId: uuid(), responseId: uuid(), sessionId: uuid(), agentId: 'github.copilot.editsAgent',
      },
      details: 'MAI-Code-1.1-Flash • 0.6 credits',
    };
    Object.assign(r, { followups: [], modelState: { value: 1, completedAt: t + 4000 }, completionTokens: tokens[1], promptTokens: tokens[0], copilotCredits: 0.6, elapsedMs: 4000 });
  }
  return r;
}
// The fields a reply gains when it completes: a pending request is written without them.
const DONE_FIELDS = ['result', 'followups', 'modelState', 'completionTokens', 'promptTokens', 'copilotCredits', 'elapsedMs'];
const pending = (r, response = []) => {
  const o = { ...r, response, modelState: { value: 0 } };
  for (const k of DONE_FIELDS.filter((x) => x !== 'modelState')) delete o[k];
  return o;
};

// An agent turn: it reads a file, runs the tests, fails an edit (hidden), asks an MCP server, with
// opaque reasoning, an inline symbol reference, a warning and bookkeeping parts between text runs.
function agentTurn(t) {
  const mcp = { type: 'mcp', label: 'toybox', serverLabel: 'toybox-mcp-server', collectionId: 'mcp.config.usrlocal', definitionId: 'mcp.config.usrlocal.toybox' };
  const cart = `${CWD}/toyshop/cart.py`;
  const response = [
    { kind: 'mcpServersStarting', didStartServerIds: [] },
    { kind: 'autoModeResolution', resolved: { id: 'mai-code-1.1-flash', name: 'MAI-Code-1.1-Flash' } },
    md('I will read the cart first.'),
    thinkingOpaque(),
    thinkingDone(),
    tool('call_A', 'copilot_readFile', { pastTenseMessage: { value: 'Read cart.py' } }),
    md('The total ignores qty in '),
    { kind: 'inlineReference', inlineReference: { name: 'Cart.total_cents()', kind: 12, location: { uri: fileUri(cart) } }, resolveId: uuid() },
    md('; running the tests.'),
    tool('call_B', 'run_in_terminal', { isConfirmed: { type: 4 }, toolSpecificData: { kind: 'terminal', commandLine: { original: 'python3 -m pytest -q', forDisplay: 'python3 -m pytest -q' }, terminalCommandState: { exitCode: 1, duration: 300 }, terminalCommandOutput: { text: '1 failed (terminal view)', lineCount: 1 } } }),
    tool('call_C', 'copilot_multiReplaceString', { presentation: 'hidden', resultError: true }),
    tool('call_M', 'mcp_toybox_search', { source: mcp }),
    { kind: 'warning', content: { value: 'One edit could not be applied.' } },
    { id: uuid(), kind: 'undoStop' },
    { kind: 'codeblockUri', uri: fileUri(cart), isEdit: true },
    { kind: 'textEditGroup', uri: fileUri(cart), edits: [[{ text: 'return sum(i.price * i.qty for i in self.items)', range: {} }]], done: true },
    md('Fixed: the total multiplies by qty.'),
  ];
  const rounds = [
    { response: 'I will read the cart first.', toolCalls: [{ id: 'call_A__vscode-1767693600103', name: 'read_file', arguments: JSON.stringify({ filePath: cart, startLine: 1, endLine: 220 }) }], timestamp: t + 900, phase: 'commentary', modelId: 'mai-code-1.1-flash' },
    { response: '', toolCalls: [{ id: 'call_B__vscode-1767693600104', name: 'run_in_terminal', arguments: JSON.stringify({ command: 'python3 -m pytest -q', explanation: 'Run the tests.' }) }], timestamp: t + 1900, modelId: 'mai-code-1.1-flash' },
    { response: '', toolCalls: [{ id: 'call_C__vscode-1767693600105', name: 'multi_replace_string_in_file', arguments: JSON.stringify({ replacements: [{ filePath: cart, oldString: 'x', newString: 'y' }] }) }], timestamp: t + 2900, modelId: 'mai-code-1.1-flash' },
    { response: '', toolCalls: [{ id: 'call_M__vscode-1767693600106', name: 'mcp_toybox_search', arguments: '{"q":"robot"}' }], timestamp: t + 3400, modelId: 'mai-code-1.1-flash' },
    { response: 'Fixed: the total multiplies by qty.', toolCalls: [], timestamp: t + 3900, phase: 'final_answer', modelId: 'mai-code-1.1-flash' },
  ];
  const results = {
    'call_A__vscode-1767693600103': tsx('class Cart:\n', '    def total_cents(self):\n', '        return sum(i.price for i in self.items)\n'),
    'call_B__vscode-1767693600104': plain('1 failed in 0.01s'),
    'call_C__vscode-1767693600105': plain('ERROR: string not found in cart.py'),
    'call_M__vscode-1767693600106': plain('three robots'),
  };
  return request({ t, text: 'Fix the qty bug in cart.py, then run python3 -m pytest -q.', response, rounds, results, tokens: [20822, 1258] });
}
const answer = (t, text, reply, model = 'gpt-6-luna', extra = {}) => request({ t, text, response: [md(reply)], rounds: [{ response: reply, toolCalls: [], timestamp: t + 900 }], tokens: [21000, 15], model, ...extra });

function featureMain(sid) {
  const t1 = agentTurn(T0 + 1000);
  const t2 = answer(T0 + 9000, 'Explain the fix in one sentence.', 'The total now multiplies price by qty.');
  const t3 = request({
    t: T0 + 20000, text: 'Use a sub-agent to list the test files.', tokens: [9000, 300],
    response: [
      md('Delegating.'),
      tool('call_S', 'runSubagent', { toolSpecificData: { kind: 'subagent', description: 'list tests' } }),
      tool('call_S1', 'copilot_listDirectory', { subAgentInvocationId: 'call_S' }),
      tool('', 'copilot_readFile', { subAgentInvocationId: 'call_S' }),
      md('There are two test files.'),
    ],
    rounds: [{ response: 'Delegating.', toolCalls: [{ id: 'call_S__vscode-1', name: 'runSubagent', arguments: '{"prompt":"list tests"}' }], timestamp: T0 + 20100 }],
    results: { 'call_S__vscode-1': plain('tests/test_cart.py, tests/test_discount.py') },
  });
  const t4 = request({
    t: T0 + 30000, text: 'What is in this screenshot and this file?', response: [md('A cart page, and the cart module.')], tokens: [9100, 12], responseId: false,
    extra: { variableData: { variables: [
      { id: 'img-1', name: 'screenshot.png', kind: 'image', mimeType: 'image/png', value: fileUri('/home/user/Pictures/screenshot.png') },
      { id: 'file-1', name: 'cart.py', kind: 'file', value: fileUri(`${CWD}/toyshop/cart.py`) },
      { id: 'sym-1', name: 'Cart', kind: 'symbol', value: {} },
    ] } },
  });
  const t5 = answer(T0 + 40000, 'Internal follow-up.', 'Done.', 'gpt-6-luna', { extra: { hiddenFromTranscript: true } });
  const t6 = answer(T0 + 50000, '/compact', 'Compacted the conversation.');
  t6.result.metadata.summary = { toolCallRoundId: 'round-1', text: 'The user fixed the qty bug in cart.py; the tests pass.' };
  const t7 = request({ t: T0 + 60000, text: 'Add a discount field.', response: [md('Working on')], done: false });
  Object.assign(t7, { modelState: { value: 3, completedAt: T0 + 61000 }, result: { errorDetails: { message: 'Sorry, the response failed. Please try again.' }, metadata: {} } });
  const t8 = request({ t: T0 + 70000, text: 'And the coupon code?', response: [md('Looking at the')], done: false });
  const t9 = answer(T0 + 80000, 'Now add a discount field.', 'Added a discount field.');
  const t9b = answer(T0 + 90000, 'Now add a percentage discount field.', 'Added a percentage discount field.');
  const t10 = request({
    t: T0 + 100000, text: 'Delete the tests directory.', done: false,
    // No result metadata: the served model comes from the autoModeResolution part.
    response: [{ kind: 'autoModeResolution', resolved: { id: 'mai-code-1.1-flash', name: 'MAI-Code-1.1-Flash' } }, md('I will remove it.'), tool('call_D', 'run_in_terminal', { isConfirmed: { type: 0 }, isComplete: true, toolSpecificData: { kind: 'terminal', commandLine: 'rm -rf tests' } })],
    extra: { isCanceled: true, modelState: { value: 2, completedAt: T0 + 101000 } },
  });
  const t11 = request({ t: T0 + 110000, text: 'Summarise the session.', response: [md('This session')], done: false });
  const t2open = pending(t2, [md('The total')]);

  return [
    snapshot(sid, []),
    set(['responderUsername'], 'GitHub Copilot'),
    set(['inputState', 'selectedModel'], selectedModel('toy-account-sentinel-9a2b')),
    set(['customTitle'], 'cart qty bug'),
    splice(['requests'], [t1]),
    // Written while the reply is pending, then completed op by op.
    splice(['requests'], [t2open]),
    splice(['requests', 1, 'response'], t2.response, 0),
    set(['requests', 1, 'result'], t2.result),
    set(['requests', 1, 'completionTokens'], 15),
    set(['requests', 1, 'promptTokens'], 21000),
    set(['requests', 1, 'modelState'], t2.modelState),
    // UI state and votes: no record changes.
    set(['hasPendingEdits'], true),
    set(['inputState', 'inputText'], 'half-typed'),
    set(['requests', 0, 'vote'], 1),
    splice(['requests'], [t3]),
    splice(['requests'], [t4]),
    splice(['requests'], [t5]),
    splice(['requests'], [t6]),
    splice(['requests'], [t7]),
    splice(['requests'], [t8]),
    splice(['requests'], [t9]),
    // An edit of request 9: a kind 2 with i cuts it; then the same id re-appended updates in place.
    splice(['requests'], [t9b], 8),
    splice(['requests'], [{ ...t9b, completionTokens: 99 }], 8),
    set(['inputState', 'selectedModel', 'metadata', 'auth'], 'toy-account-sentinel-c3d4'),
    set(['customTitle'], 'toyshop renamed'),
    // A complete line that does not parse.
    '{"kind":1,"k":["inputState","inputText"],"v":"torn',
    splice(['requests'], [t10]),
    // The last request's reply is still being written: held.
    splice(['requests'], [t11]),
  ];
}

function features() {
  const ws = wsId(CWD_URI);
  const chats = `${WS}/${ws}/chatSessions`;
  const SID_A = '0a0a0a0a-0000-4000-8000-00000000000a';
  const SID_B = '0b0b0b0b-0000-4000-8000-00000000000b';
  const SID_C = '0c0c0c0c-0000-4000-8000-00000000000c';
  const SID_D = '0d0d0d0d-0000-4000-8000-00000000000d';
  const SID_E = '0e0e0e0e-0000-4000-8000-00000000000e';
  const main = featureMain(SID_A);

  // A pre-change-log chat in an empty window: one JSON document.
  const b = session(SID_B, [answer(T0 + 200000, 'Hello from an empty window.', 'Hello.')], { creationDate: T0 + 199000, customTitle: 'empty window chat' });
  // One id in both formats: the change log is read, the legacy file is not.
  const cOld = session(SID_C, [answer(T0 + 300000, 'An old question.', 'An old answer.')], { creationDate: T0 + 299000 });
  const c1 = answer(T0 + 310000, 'A question in the change log.', 'An answer in the change log.');
  const c2 = answer(T0 + 320000, 'A second question.', 'A second answer.');
  // A fork: one kind 0, bare uuid ids, each request's timestamp reset to the fork time + 1 ms,
  // the reply's responseTimestamp kept from the origin.
  const FT = T0 + 3600000;
  const fork = (r) => ({ ...r, requestId: uuid(), responseId: uuid(), timestamp: FT + 1 });
  const d1 = fork(agentTurn(T0 + 1000));
  const d2 = fork(answer(T0 + 9000, 'Explain the fix in one sentence.', 'The total now multiplies price by qty.'));
  // A mid-file kind 0 resets the fold: what it drops vanishes, it is not retracted.
  const e1 = answer(T0 + 400000, 'First question.', 'First answer.');
  const e2 = answer(T0 + 410000, 'Second question.', 'Second answer.');
  const e3 = answer(T0 + 420000, 'After the reload.', 'Reloaded.');

  writeCase('features', [
    [`${WS}/${ws}/workspace.json`, JSON.stringify({ folder: CWD_URI }) + '\n'],
    [`${chats}/${SID_A}.jsonl`, lines(main)],
    [`${chats}/notes.txt`, 'not a chat\n'],
    [`${EMPTY}/${SID_B}.json`, JSON.stringify(b, null, 1)],
    [`${chats}/${SID_C}.json`, JSON.stringify(cOld)],
    [`${chats}/${SID_C}.jsonl`, lines([snapshot(SID_C, [c1], { creationDate: T0 + 309000 }), splice(['requests'], [c2])])],
    [`${chats}/${SID_D}.jsonl`, lines([snapshot(SID_D, [d1, d2], { creationDate: FT, customTitle: 'Forked: cart qty bug' })])],
    [`${EMPTY}/${SID_E}.jsonl`, lines([
      snapshot(SID_E, [e1], { creationDate: T0 + 399000 }),
      splice(['requests'], [e2]),
      snapshot(SID_E, [e3], { creationDate: T0 + 399000 }),
    ])],
  ]);
}

// ---- lab --------------------------------------------------------------------------------------

function lab(scrub) {
  const ops = fs.readFileSync(path.join(scrub, 'ops.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const files = new Map();
  for (const o of ops) {
    const { _file: file, _line: line, ...op } = o;
    if (!files.has(file)) files.set(file, []);
    files.get(file).push([line, op]);
  }
  const byFile = (name) => files.get(name).sort((a, b) => a[0] - b[0]).map(([, op]) => op);

  // Session f0da568c: complete in the capture; its kind 0 holds no request.
  const a = byFile('f0da568c-8ed3-4480-b0b4-787ca035cc3c.jsonl');
  a[0].v.requests = [];

  // Fork 65a4e98a: its first request is the captured agent turn; the other four are synthetic
  // fork copies (bare uuids, the fork time + 1 ms), the fifth the one `kind 2` with `i: 4` cuts.
  const f = byFile('65a4e98a-a792-4f21-8b88-91971aa08c28.jsonl');
  const first = JSON.parse(fs.readFileSync(path.join(scrub, 'request.json'), 'utf8'));
  first.response = first.response.filter((p) => p && typeof p === 'object');
  const forkTs = f[0].v.creationDate + 1;
  const tpl = f[1].v[0];
  const copy = (n, text, reply, at) => {
    const base = `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
    return {
      ...tpl,
      requestId: base, timestamp: forkTs, responseId: `${base.slice(0, -4)}f00${n}`, responseTimestamp: at,
      result: { ...tpl.result, metadata: { ...tpl.result.metadata, renderedUserMessage: [], toolCallRounds: [{ response: reply, toolCalls: [], timestamp: at + 2000, phase: 'final_answer', modelId: 'mai-code-1.1-flash' }], promptTokens: 11000 + n, outputTokens: 5 } },
      modelState: { value: 1, completedAt: at + 2100 }, timeSpentWaiting: at, completionTokens: 5 + n, promptTokens: 11000 + n,
      response: [tpl.response[0], { ...tpl.response[1], value: reply }],
      message: { text, parts: [{ range: { start: 0, endExclusive: text.length }, text, kind: 'text' }] },
    };
  };
  const t = first.responseTimestamp;
  f[0].v.requests = [
    first,
    copy(2, 'Explain the duplicate-SKU fix in one sentence.', 'Synthetic reply 1558fb. syntheti', t + 200000),
    copy(3, 'Run the tests again.', 'Synthetic reply', t + 300000),
    copy(4, 'Reply with the single word RESTOK1.', 'Synthet', t + 400000),
    copy(5, 'Reply with the single word RESTOK.', 'Synthe', t + 500000),
  ];

  const inv = 'file:///home/user/work/inventory-cli';
  const toy = 'file:///home/user/work/vs2/toyshop';
  writeCase('lab', [
    [`${WS}/${wsId(inv)}/workspace.json`, JSON.stringify({ folder: inv }) + '\n'],
    [`${WS}/${wsId(inv)}/chatSessions/f0da568c-8ed3-4480-b0b4-787ca035cc3c.jsonl`, lines(a)],
    [`${WS}/${wsId(toy)}/workspace.json`, JSON.stringify({ folder: toy }) + '\n'],
    [`${WS}/${wsId(toy)}/chatSessions/65a4e98a-a792-4f21-8b88-91971aa08c28.jsonl`, lines(f)],
  ]);
}

features();
if (process.argv[2]) lab(process.argv[2]);
