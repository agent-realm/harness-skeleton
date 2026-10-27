// Writes the synthetic Copilot CLI fixture stores: generated text only.
//   node fixtures/copilot-cli/generate.js
//
// The event shapes follow the scrubbed lab captures (Copilot CLI 1.0.100/1.0.101; the fixture
// captures, synthetic, captured on a test VM), and the cases port the
// reviewed behaviour of memhouse's normaliser test.
//
// Cases written here:
//   features                   one record per behaviour the adapter claims: a sub-agent inside the
//                              session, an image attachment, MCP, failing, denied and interrupted
//                              tools, notifications, a capped reply's usage with no message, a
//                              compaction, two forks on the origin side, a fork child, and a tool
//                              still running (held).
//   rewind                     before/ and store/ (after): the file rewritten shorter, through a
//   new
//                              inode in the test, plus the appended `session.info{rewind}`.
//   conformance-copilot-reuse  first/ and store/: one `--session-id` in two lives, each with its
//                              own `session.start` id. The two session.start lines are the scrubbed
//                              lab capture's; the turns follow its store rows.
//
// Cases copied from the scrubbed lab captures, not written here: basic (one session), pass2 (four
// sessions: interrupt, abort, manual and threshold compaction, a custom agent with /cwd, headless)
// and vscode-host (a session VS Code's agent host wrote, its fork, and the fork's head).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const iso = (ms) => new Date(ms).toISOString();
const CWD = '/home/user/work/toyshop';
const MODEL = 'gateway/toy-model';

// A writer for one events.jsonl: every event chains `parentId` to the one before it, as Copilot
// does.
function stream(prefix) {
  let n = 0;
  let prev = null;
  const lines = [];
  const objs = [];
  const add = (type, t, data, { agentId, id } = {}) => {
    n += 1;
    const o = { type, data, ...(agentId ? { agentId } : {}), id: id ?? `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: iso(t), parentId: prev };
    prev = o.id;
    lines.push(JSON.stringify(o));
    objs.push(o);
    return o;
  };
  // An event copied verbatim from another file (a fork's copy, a rewind's kept events).
  const copy = (o) => {
    prev = o.id;
    lines.push(JSON.stringify(o));
  };
  return { add, copy, lines, objs, text: () => lines.map((l) => l + '\n').join('') };
}

const start = (sid, t, extra = {}) => ({
  sessionId: sid, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.101', startTime: iso(t), selectedModel: MODEL,
  contextTier: null, context: { cwd: CWD, gitRoot: CWD, branch: 'main', headCommit: '0000000000000000000000000000000000000001' },
  alreadyInUse: false, remoteSteerable: false, ...extra,
});
let msgN = 0;
const user = (content, extra = {}) => ({ content, transformedContent: `<current_datetime>synthetic</current_datetime>\n\n${content}`, messageId: `00000000-0000-4000-9000-${String(++msgN).padStart(12, '0')}`, supportedNativeDocumentMimeTypes: [], delivery: 'idle', interactionId: 'i-1', turnId: '0', ...extra });
const usage = (api, [input, output, cacheRead = 0, reasoning = 0], extra = {}) => ({ usage: {
  model: MODEL, modelDisplayName: MODEL, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0,
  reasoningTokens: reasoning, cost: 0, duration: 1000, initiator: 'user', interactionType: 'conversation-agent', isByok: true,
  apiCallId: api, apiEndpoint: '/chat/completions', aiCreditsStatus: 'unavailable', cacheDetailsReported: true, finishReason: 'stop', ...extra,
} });
const reply = (api, content, { reqs = [], reasoning, parentToolCallId } = {}) => ({
  messageId: `00000000-0000-4000-a000-${String(++msgN).padStart(12, '0')}`, originatingMessageId: 'm-1', model: MODEL, content,
  toolRequests: reqs.map(([toolCallId, name, args]) => ({ toolCallId, name, arguments: args, type: 'function' })),
  interactionId: 'i-1', turnId: '0', ...(reasoning ? { reasoningText: reasoning } : {}), rte: false, apiCallId: api,
  ...(parentToolCallId ? { parentToolCallId } : {}),
});
const done = (toolCallId, content, { ok = true, exit, error } = {}) => ({
  toolCallId, model: MODEL, interactionId: 'i-1', turnId: '0', rte: false,
  ...(exit !== undefined ? { shellExecution: { exitCode: exit } } : {}),
  success: ok, ...(ok ? { result: { content } } : { error }),
});
const turnStart = { turnId: '0', interactionId: 'i-1' };
const turnEnd = { turnId: '0' };

// ---- features ----------------------------------------------------------------------------------

const A = 'a0a0a0a0-0000-4000-8000-000000000001'; // the origin
const C1 = 'c1c1c1c1-0000-4000-8000-000000000002'; // its first fork: named only, not stored
const C2 = 'c2c2c2c2-0000-4000-8000-000000000003'; // its second fork, stored
const H = 'b0b0b0b0-0000-4000-8000-000000000004'; // a tool still running
const AG = '5ab0a6e0-0000-4000-8000-0000000000a6'; // a sub-agent inside A
const T0 = Date.UTC(2026, 9, 21, 13, 0, 0);
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function origin() {
  const s = stream('a0000000');
  let t = T0;
  const at = (dt = 1000) => (t += dt);
  s.add('session.start', at(0), start(A, T0));
  s.add('session.model_change', at(), { source: 'startup', contextTier: null, newModel: MODEL, previousModel: MODEL, reasoningEffort: null });
  s.add('session.info', at(), { infoType: 'folder_trust', message: `Folder ${CWD} has been added to trusted folders.` });

  // A prompt; the reply delegates to a sub-agent through `task`, which runs inside this file.
  s.add('user.message', at(), user('List the files and summarise toyshop/cart.py.'));
  s.add('system.message', at(), { role: 'system', content: 'You are a synthetic assistant for the toyshop repo.' });
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-feat-1', [1200, 30, 0, 5]));
  const task = 'chatcmpl-tool-feat-task';
  s.add('assistant.message', at(), reply('api-feat-1', '', { reasoning: 'Delegate the listing to a sub-agent.', reqs: [[task, 'task', { name: 'explore-repo', agent_type: 'explore', prompt: 'List the files and summarise cart.py.' }]] }));
  s.add('tool.execution_start', at(), { toolCallId: task, toolName: 'task', arguments: { name: 'explore-repo' }, turnId: '0', model: MODEL });
  s.add('subagent.started', at(), { toolCallId: task, agentName: 'explore', agentDisplayName: 'Explore' });
  const sub = { agentId: AG };
  s.add('user.message', at(), user('List the files and summarise cart.py.', { source: `agent-${A}` }), sub);
  s.add('assistant.turn_start', at(), { ...turnStart, parentToolCallId: task }, sub);
  s.add('session.usage_record', at(), usage('api-feat-2', [400, 20, 0, 3], { initiator: 'sub-agent', parentToolCallId: task, reasoningEffort: 'low' }), sub);
  s.add('assistant.message', at(), reply('api-feat-2', '', { parentToolCallId: task, reqs: [['chatcmpl-tool-feat-ls', 'bash', { command: 'ls toyshop', description: 'List files' }], ['chatcmpl-tool-feat-view', 'view', { path: `${CWD}/toyshop/cart.py` }]] }), sub);
  s.add('tool.execution_start', at(), { toolCallId: 'chatcmpl-tool-feat-ls', toolName: 'bash', arguments: { command: 'ls toyshop' }, parentToolCallId: task }, sub);
  s.add('tool.execution_complete', at(), done('chatcmpl-tool-feat-ls', 'cart.py\n__init__.py\n<shellId: 0 completed with exit code 0>', { exit: 0 }), sub);
  s.add('tool.execution_start', at(), { toolCallId: 'chatcmpl-tool-feat-view', toolName: 'view', arguments: { path: `${CWD}/toyshop/cart.py` }, parentToolCallId: task }, sub);
  s.add('tool.execution_complete', at(), done('chatcmpl-tool-feat-view', '1. class Cart:\n2.     items: list'), sub);
  s.add('assistant.turn_end', at(), turnEnd, sub);
  s.add('session.usage_record', at(), usage('api-feat-3', [520, 12], { initiator: 'sub-agent', parentToolCallId: task }), sub);
  s.add('assistant.message', at(), reply('api-feat-3', 'cart.py and __init__.py; Cart holds a list of items.', { parentToolCallId: task }), sub);
  s.add('assistant.turn_end', at(), turnEnd, sub);
  s.add('subagent.completed', at(), { toolCallId: task, agentName: 'explore' });
  s.add('tool.execution_complete', at(), done(task, 'cart.py and __init__.py; Cart holds a list of items.'));
  s.add('assistant.turn_end', at(), turnEnd);
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-feat-4', [1300, 18], { initiator: 'agent' }));
  s.add('assistant.message', at(), reply('api-feat-4', 'Two files; Cart holds a list of items.'));
  s.add('assistant.turn_end', at(), turnEnd);

  // An image: its bytes in a binary_asset, then the prompt that attaches it.
  const assetId = `sha256:${crypto.createHash('sha256').update(PNG).digest('hex')}`;
  s.add('session.binary_asset', at(), { assetId, type: 'image', mimeType: 'image/png', byteLength: PNG.length, data: PNG.toString('base64') });
  s.add('user.message', at(), user('What does this label say? @label.png', { attachments: [{ type: 'file', path: `${CWD}/label.png`, displayName: '@label.png', mentionIndex: 25, assetId, mimeType: 'image/png', byteLength: PNG.length }] }));
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-feat-5', [1400, 9, 1000, 7]));
  s.add('assistant.message', at(), reply('api-feat-5', 'A blank one-pixel label.', { reasoning: 'The image is one pixel.' }));
  s.add('assistant.turn_end', at(), turnEnd);

  // Tools: a shell that exits 1, an MCP tool, a denied call, a failing call, and an interrupted
  // one.
  s.add('user.message', at(), user('Run the tests, then look up TOY-1 in the stock server.'));
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-feat-6', [1500, 15], { finishReason: 'tool_calls' }));
  s.add('assistant.message', at(), reply('api-feat-6', '', { reqs: [['chatcmpl-tool-feat-test', 'bash', { command: 'python3 -m pytest -q' }]] }));
  s.add('tool.execution_start', at(), { toolCallId: 'chatcmpl-tool-feat-test', toolName: 'bash', arguments: { command: 'python3 -m pytest -q' } });
  s.add('permission.requested', at(), { requestId: 'p-1', permissionRequest: { kind: 'shell', toolCallId: 'chatcmpl-tool-feat-test', fullCommandText: 'python3 -m pytest -q' } });
  s.add('permission.completed', at(), { requestId: 'p-1', result: { kind: 'approved' } });
  s.add('tool.execution_complete', at(), done('chatcmpl-tool-feat-test', '1 failed\n<shellId: 1 completed with exit code 1>', { exit: 1 }));
  s.add('assistant.turn_end', at(), turnEnd);
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-feat-7', [1600, 11], { initiator: 'agent', finishReason: 'tool_calls' }));
  s.add('assistant.message', at(), reply('api-feat-7', '', { reqs: [['chatcmpl-tool-feat-mcp', 'skustock-sku_stock', { sku: 'TOY-1' }]] }));
  s.add('tool.execution_start', at(), { toolCallId: 'chatcmpl-tool-feat-mcp', toolName: 'skustock-sku_stock', arguments: { sku: 'TOY-1' }, mcpServerName: 'skustock', mcpToolName: 'sku_stock', mcpTransport: 'stdio' });
  s.add('tool.execution_complete', at(), done('chatcmpl-tool-feat-mcp', 'TOY-1: 3 in stock'));
  s.add('assistant.turn_end', at(), turnEnd);
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-feat-8', [1700, 13], { initiator: 'agent', finishReason: 'tool_calls' }));
  s.add('assistant.message', at(), reply('api-feat-8', '', { reqs: [['chatcmpl-tool-feat-pip', 'bash', '{"command":"pip install pytest"}']] }));
  s.add('tool.execution_start', at(), { toolCallId: 'chatcmpl-tool-feat-pip', toolName: 'bash', arguments: { command: 'pip install pytest' } });
  s.add('permission.completed', at(), { requestId: 'p-2', result: { kind: 'denied-interactively-by-user', feedback: 'Do not install packages.' } });
  s.add('tool.execution_complete', at(), done('chatcmpl-tool-feat-pip', null, { ok: false, error: { message: 'The user rejected this tool call. User feedback: Do not install packages.', code: 'denied' } }));
  s.add('assistant.turn_end', at(), turnEnd);
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-feat-9', [1800, 14], { initiator: 'agent', finishReason: 'tool_calls' }));
  s.add('assistant.message', at(), reply('api-feat-9', '', { reqs: [['chatcmpl-tool-feat-ask', 'ask_user', { question: 'Which SKU?', requestedSchema: 'sku' }]] }));
  s.add('tool.execution_complete', at(), done('chatcmpl-tool-feat-ask', null, { ok: false, error: { message: '"requestedSchema": Expected object, received string', code: 'failure' } }));
  s.add('assistant.turn_end', at(), turnEnd);
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-feat-10', [1900, 16], { initiator: 'agent', finishReason: 'tool_calls' }));
  s.add('assistant.message', at(), reply('api-feat-10', 'Running both checks.', { reqs: [['chatcmpl-tool-feat-a', 'bash', { command: 'echo a' }], ['chatcmpl-tool-feat-b', 'bash', { command: 'sleep 600' }]] }));
  s.add('tool.execution_start', at(), { toolCallId: 'chatcmpl-tool-feat-a', toolName: 'bash', arguments: { command: 'echo a' } });
  s.add('tool.execution_complete', at(), done('chatcmpl-tool-feat-a', 'a\n<shellId: 2 completed with exit code 0>', { exit: 0 }));
  s.add('tool.execution_start', at(), { toolCallId: 'chatcmpl-tool-feat-b', toolName: 'bash', arguments: { command: 'sleep 600' } });
  // Esc: the second call never completes, and the abort ends the turn.
  s.add('abort', at(), { reason: 'user_abort' });

  // Notifications: with text; with only a type and status; with neither (no record).
  s.add('system.notification', at(), { content: '<system_notification>\nShell command "sleep 25" (shellId: bg-1) has completed successfully.\n</system_notification>', kind: { type: 'shell_completed', shellId: 'bg-1', exitCode: 0 } });
  s.add('system.notification', at(), { kind: { type: 'shell_completed', status: 'ok', shellId: 'bg-2', output: 'a raw field that is no conversation' } });
  s.add('system.notification', at(), { kind: { detail: 'neither text nor a type' } });

  // A reply cut off by the output cap: a usage record and no assistant.message (fixture captures).
  s.add('user.message', at(), user('Write a very long essay about carts.'));
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-feat-11', [2000, 16384], { finishReason: 'length' }));
  s.add('abort', at(), { reason: 'user_initiated' });

  // A manual compaction, then a mode change and a /cwd.
  s.add('session.compaction_start', at(), { compactionAttemptId: 'cmp-1', trigger: 'manual' });
  s.add('session.compaction_complete', at(), {
    success: true, outcome: 'applied', compactionAttemptId: 'cmp-1', preCompactionMessagesLength: 13, messagesRemoved: 12,
    tokenAccountingBasis: 'local_full_context_estimate', summaryContent: '<overview>\nThe user explored the toyshop repo and ran its tests.\n</overview>',
    compactionTokensUsed: { requestCount: 1, modelDisplayName: MODEL, inputTokens: 2100, outputTokens: 120, cacheReadTokens: 1800, cacheWriteTokens: 0, aiCreditsStatus: 'unavailable', duration: 900, model: MODEL },
    trigger: 'manual', checkpointNumber: 1, checkpointPath: `/home/user/.copilot/session-state/${A}/checkpoints/001-toyshop.md`,
  });
  s.add('session.mode_changed', at(), { previousMode: 'interactive', newMode: 'plan' });
  s.add('session.context_changed', at(), { cwd: `${CWD}/toyshop`, pendingGitContext: true });

  // Two forks: each origin-side marker names its child.
  s.add('session.info', at(), { infoType: 'fork', message: `Forked this session into "toyshop features (fork)" (${C1}).` });
  const before2 = s.objs.length;
  s.add('session.info', at(), { infoType: 'fork', message: `Forked this session into "toyshop features (fork 2)" (${C2}).` });
  const fork2At = t;
  s.add('session.shutdown', at(), { shutdownType: 'routine' });
  s.add('session.resume', at(), { resumeTime: iso(t), eventCount: s.objs.length, context: { cwd: `${CWD}/toyshop`, gitRoot: CWD, branch: 'main' } });
  return { s, copiedUpTo: before2, fork2At };
}

// The second fork: a new session.start (new sessionId and time, the origin's event id), then the
// origin's events with their ids and times (the first fork's marker among them), then its own
// marker and a new turn.
function child(o) {
  const s = stream('c2000000');
  const birth = o.fork2At - 20;
  const head = o.s.objs[0];
  s.add('session.start', birth, start(C2, birth), { id: head.id });
  for (const e of o.s.objs.slice(1, o.copiedUpTo)) s.copy(e);
  let t = o.fork2At + 10;
  // The child's own wording is in no capture; this one names the origin like the origin's names it.
  s.add('session.info', t, { infoType: 'fork', message: `Forked from "toyshop features" (${A}).` });
  s.add('user.message', (t += 1000), user('Now only count the files.'));
  s.add('assistant.turn_start', (t += 1000), turnStart);
  s.add('session.usage_record', (t += 1000), usage('api-fork-1', [2200, 6]));
  s.add('assistant.message', (t += 1000), reply('api-fork-1', 'Two files.'));
  s.add('assistant.turn_end', (t += 1000), turnEnd);
  return s;
}

// A tool still running at the end of the file, while a sub-agent kept writing: only the waiting
// message is held.
function held() {
  const s = stream('b0000000');
  let t = T0 + 3600 * 1000;
  const sub = { agentId: '5ab0a6e0-0000-4000-8000-0000000000b6' };
  s.add('session.start', t, start(H, t));
  s.add('user.message', (t += 1000), user('Explore the repo with a sub-agent.'));
  s.add('assistant.turn_start', (t += 1000), turnStart);
  s.add('session.usage_record', (t += 1000), usage('api-held-1', [900, 10]));
  s.add('assistant.message', (t += 1000), reply('api-held-1', '', { reqs: [['chatcmpl-tool-Fixt00016', 'task', { name: 'explore' }]] }));
  s.add('tool.execution_start', (t += 1000), { toolCallId: 'chatcmpl-tool-Fixt00016', toolName: 'task', arguments: { name: 'explore' } });
  s.add('user.message', (t += 1000), user('Explore the repo.', { source: `agent-${H}` }), sub);
  s.add('session.usage_record', (t += 1000), usage('api-held-2', [300, 8], { initiator: 'sub-agent', parentToolCallId: 'chatcmpl-tool-Fixt00016' }), sub);
  s.add('assistant.message', (t += 1000), reply('api-held-2', 'It holds cart.py.', { parentToolCallId: 'chatcmpl-tool-Fixt00016' }), sub);
  s.add('assistant.turn_end', (t += 1000), turnEnd, sub);
  return s;
}

const yaml = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
const ws = (id, name, userNamed, created) => yaml({ id, cwd: CWD, git_root: CWD, branch: 'main', client_name: 'github/cli', name, user_named: userNamed, summary_count: 0, fork_count: 0, created_at: iso(created), updated_at: iso(created) });

function writeTree(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

const o = origin();
const c2 = child(o);
const h = held();
writeTree(path.join(HERE, 'features', 'store'), [
  [`session-state/${A}/events.jsonl`, o.s.text()],
  [`session-state/${A}/workspace.yaml`, ws(A, 'toyshop features', 'true', T0)],
  [`session-state/${C2}/events.jsonl`, c2.text()],
  [`session-state/${C2}/workspace.yaml`, ws(C2, '"toyshop features (fork 2)"', 'false', o.fork2At)],
  [`session-state/${H}/events.jsonl`, h.text()],
]);

// ---- rewind ------------------------------------------------------------------------------------

const R = 'd0d0d0d0-0000-4000-8000-000000000005';
function rewound() {
  const s = stream('d0000000');
  let t = T0 + 7200 * 1000;
  const at = () => (t += 1000);
  s.add('session.start', t, start(R, t));
  s.add('user.message', at(), user('What is in toyshop/cart.py?'));
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-rw-1', [800, 12]));
  s.add('assistant.message', at(), reply('api-rw-1', 'A Cart class.'));
  s.add('assistant.turn_end', at(), turnEnd);
  const kept = s.objs.length;
  s.add('hook.start', at(), { hookInvocationId: 'h-1', hookType: 'userPromptSubmitted', input: { sessionId: R, prompt: 'Add a remove() method.' } });
  s.add('hook.end', at(), { hookInvocationId: 'h-1', hookType: 'userPromptSubmitted', success: true });
  s.add('user.message', at(), user('Add a remove() method.'));
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-rw-2', [900, 20], { finishReason: 'tool_calls' }));
  s.add('assistant.message', at(), reply('api-rw-2', '', { reqs: [['chatcmpl-tool-Fi00017', 'edit', { path: `${CWD}/toyshop/cart.py`, old_str: 'pass', new_str: 'self.items.remove(item)' }]] }));
  s.add('tool.execution_start', at(), { toolCallId: 'chatcmpl-tool-Fi00017', toolName: 'edit', arguments: { path: `${CWD}/toyshop/cart.py` } });
  s.add('tool.execution_complete', at(), done('chatcmpl-tool-Fi00017', 'File edited.'));
  s.add('assistant.turn_end', at(), turnEnd);
  s.add('assistant.turn_start', at(), turnStart);
  s.add('session.usage_record', at(), usage('api-rw-3', [1000, 9], { initiator: 'agent' }));
  s.add('assistant.message', at(), reply('api-rw-3', 'Added remove().'));
  s.add('assistant.turn_end', at(), turnEnd);
  s.add('session.shutdown', at(), { shutdownType: 'routine' });
  const before = s.text();
  // /rewind: the file is rewritten with the kept events, the rewound prompt's hook events stay, and
  // a resume plus the marker are appended (spec §6).
  const after = stream('d1000000');
  for (const e of s.objs.slice(0, kept + 2)) after.copy(e);
  after.add('session.resume', at(), { resumeTime: iso(t), eventCount: kept + 2, context: { cwd: CWD, gitRoot: CWD, branch: 'main' } });
  after.add('session.info', at(), { infoType: 'rewind', message: 'Rewound conversation and restored 1 file(s).' });
  return { before, after: after.text() };
}
const rw = rewound();
const rwWs = ws(R, 'What is in toyshop/cart.py?', 'false', T0 + 7200 * 1000);
writeTree(path.join(HERE, 'rewind', 'before'), [[`session-state/${R}/events.jsonl`, rw.before], [`session-state/${R}/workspace.yaml`, rwWs]]);
writeTree(path.join(HERE, 'rewind', 'store'), [[`session-state/${R}/events.jsonl`, rw.after], [`session-state/${R}/workspace.yaml`, rwWs]]);

// ---- conformance-copilot-reuse -----------------------------------------------------------------

// The scrubbed capture's two session.start lines: one id, two lives a minute apart.
const REUSE = 'ffe00cf7-7ac7-475d-afc2-ff0b68b29fa9';
const reuseStart = (id, startTime, timestamp) => JSON.stringify({ type: 'session.start', data: { sessionId: REUSE, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.101', startTime, selectedModel: 'gateway/toy-model-b', contextTier: null, context: { cwd: '/home/user/work/cp3/toyshop', gitRoot: '/home/user/work/cp3/toyshop', branch: 'main', headCommit: 'cd60d406137fa6bbc934bbd5e36785c009e49b21' }, alreadyInUse: false, remoteSteerable: false }, id, timestamp, parentId: null });
function life(prefix, startLine, t0, word) {
  const s = stream(prefix);
  s.copy(JSON.parse(startLine));
  let t = t0;
  s.add('user.message', (t += 1000), user(`Reply with exactly: ${word} life`));
  s.add('assistant.turn_start', (t += 100), turnStart);
  s.add('session.usage_record', (t += 1000), usage(`api-${word}`, [500, 3]));
  s.add('assistant.message', (t += 100), reply(`api-${word}`, `${word} life`));
  s.add('assistant.turn_end', (t += 100), turnEnd);
  s.add('session.shutdown', (t += 1000), { shutdownType: 'routine' });
  return s.text();
}
writeTree(path.join(HERE, 'conformance-copilot-reuse', 'first'), [[`session-state/${REUSE}/events.jsonl`,
  life('e1000000', reuseStart('068bddb5-a920-46c5-a6e8-f950d2fa9084', '2026-10-21T22:41:34.610Z', '2026-10-21T22:41:34.751Z'), Date.parse('2026-10-21T22:41:35.000Z'), 'first')]]);
writeTree(path.join(HERE, 'conformance-copilot-reuse', 'store'), [[`session-state/${REUSE}/events.jsonl`,
  life('e2000000', reuseStart('80797e76-f7a4-4f25-b73e-272e54d1e5b7', '2026-10-21T22:42:38.450Z', '2026-10-21T22:42:38.582Z'), Date.parse('2026-10-21T22:42:39.000Z'), 'second')]]);
