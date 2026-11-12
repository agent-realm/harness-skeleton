// Milestone 8.2: hooks on pi through the launch extension (design note §5.6, §7.5). The extension hs
// generates runs hs's hook shim for each spec hook on the pi event its spec event rides on:
// PreToolUse on tool_call and UserPromptSubmit on input, which can refuse and fail closed;
// Stop on agent_before_settle, whose block asks for one more run; PostToolUse, SessionStart and
// SessionEnd, which notify. No test starts a real harness: the extension is loaded with a stand-in
// for pi that records its handlers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { extensionSource } from '../src/drivers/pi/extension.js';
import { layer, tmpdir, write } from './fixtures.js';
import { linuxHost, ok } from './sandbox.js';

const SHIM = fileURLToPath(new URL('../src/shim/pi.js', import.meta.url));

function box() {
  const root = tmpdir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folder = path.join(root, 'pi-folder');
  fs.mkdirSync(folder);
  const bin = write(root, 'bin/pi', '#!/bin/sh\necho "1.5.2"\n');
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home, tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'pi', harness_path: folder, bin, ...args } }, opts);
  return { root, folder, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });

// One hook process for every role: it records the envelope it got, then decides by its role.
const HOOK = `import fs from 'node:fs';
const e = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(process.env.HOOK_OUT, JSON.stringify(e) + '\\n');
const role = process.env.HOOK_ROLE;
const text = JSON.stringify(e.hs);
if (role === 'guard' && text.includes('DENYME')) { process.stderr.write('denied by the team guard'); process.exit(2); }
if (role === 'prompt' && text.includes('BLOCKME')) { process.stderr.write('prompt refused by the team'); process.exit(2); }
if (role === 'stop' && !fs.existsSync(process.env.HOOK_STATE)) { fs.writeFileSync(process.env.HOOK_STATE, 'x'); process.stderr.write('keep going: run the tests'); process.exit(2); }
process.exit(0);
`;
const hookToml = (out, state) => {
  const run = (role) => `run = { exec = ${JSON.stringify(process.execPath)}, args = ["hook.mjs"], env = { HOOK_OUT = ${JSON.stringify(out)}, HOOK_ROLE = "${role}", HOOK_STATE = ${JSON.stringify(state)} } }`;
  return [
    '[hook.guard]', 'event = "PreToolUse"', 'match = { tool = ["shell"] }', run('guard'), 'timeout = 5', '',
    '[hook.log]', 'event = "PostToolUse"', run('log'), '',
    '[hook.prompt]', 'event = "UserPromptSubmit"', run('prompt'), '',
    '[hook.start]', 'event = "SessionStart"', 'match = { source = ["startup"] }', run('log'), '',
    '[hook.end]', 'event = "SessionEnd"', run('log'), '',
    '[hook.stop]', 'event = "Stop"', run('stop'), '',
  ].join('\n');
};

// pi, as far as the launch extension uses it: what it registers and the handlers it adds.
let loaded = 0;
async function load(source, dir) {
  const d = path.join(dir, `launch-${loaded++}`);
  fs.mkdirSync(d);
  const f = path.join(d, 'hs-launch.mjs');
  fs.writeFileSync(f, source);
  const factory = (await import(pathToFileURL(f).href)).default;
  const handlers = {};
  factory({ registerProvider() {}, registerMcpServer() {}, on: (event, fn) => { handlers[event] = fn; } });
  return { handlers, marker: path.join(d, 'hs-hooks.loaded') };
}
const ctx = (cwd) => ({ cwd, hasUI: false, sessionManager: { getSessionId: () => 'ses-test' } });
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('launch-spec: each hook rides its pi event through the launch extension, under a receipt; readiness names the marker', () => {
  const s = box();
  try {
    const team = layer(s.root, 'team', hookToml(path.join(s.root, 'out.jsonl'), path.join(s.root, 'state')), { 'hook.mjs': HOOK });
    const refused = s.call('launch-spec', { layers: [team], headless: true });
    assert.equal(refused.error.code, 'receipt_required');
    assert.deepEqual(refused.error.items[0].risks.map((r) => [r.item, r.blocks]), [['hook.end', false], ['hook.guard', true], ['hook.log', false], ['hook.prompt', true], ['hook.start', false], ['hook.stop', true]]);
    const spec = ok(s.call('launch-spec', { layers: [team], headless: true, receipt: allow(refused) }));
    const ext = spec.files.find((f) => f.role === 'extension').path;
    assert.deepEqual(spec.argv.slice(1), ['--mode', 'json', '-e', ext]);
    const via = Object.fromEntries(spec.launch_items.map((i) => [i.item, i.via]));
    assert.match(via['hook.guard'], /on pi's tool_call \(\^\(bash\)\$\), through hs's hook shim$/);
    assert.match(via['hook.prompt'], /on pi's input, through hs's hook shim$/);
    assert.match(via['hook.stop'], /on pi's agent_before_settle, through hs's hook shim$/);
    assert.match(via['hook.start'], /on pi's session_start \(\^\(startup\)\$\).*cannot block on pi/);
    assert.deepEqual(spec.readiness.map((r) => [r.what, r.path]), [['hooks', path.join(spec.temp_dir, 'hs-hooks.loaded')]]);
    assert.ok(spec.notes.some((n) => /fails closed/.test(n)) && spec.notes.some((n) => /stops pi/.test(n)) && spec.notes.some((n) => /one more run/.test(n)));
    const src = fs.readFileSync(ext, 'utf8');
    assert.ok(src.includes(JSON.stringify(SHIM)), 'it runs hs\'s shim for pi');
    const plan = ok(s.call('plan', { layers: [team], owner: 'builder', mode: 'overlay' }));
    assert.ok(plan.launch_only.some((x) => x.item === 'hook.stop' && /agent_before_settle/.test(x.via)));
  } finally {
    s.done();
  }
});

test('refused or skipped by name: events pi has no route for, may_allow, the fetch class', () => {
  const s = box();
  try {
    const cases = [
      [['[hook.p]', 'event = "PermissionRequest"', 'run = { exec = "true" }'], 'item_unsupported', /hook\.p: PermissionRequest: pi has no permission prompts/],
      [['[hook.c]', 'event = "PreCompact"', 'run = { exec = "true" }'], 'item_unsupported', /hook\.c: PreCompact: .*not measured/],
      [['[hook.a]', 'event = "PreToolUse"', 'may_allow = true', 'run = { exec = "true" }'], 'item_unsupported', /hook\.a: may_allow: pi has no permission prompt/],
      [['[hook.f]', 'event = "PreToolUse"', 'match = { tool = ["fetch"] }', 'run = { exec = "true" }'], 'item_unsupported', /hook\.f: tool class fetch: pi has no built-in fetch tool/],
    ];
    for (const [i, [toml, code, re]] of cases.entries()) {
      const r = s.call('launch-spec', { layers: [layer(s.root, `r${i}`, toml.join('\n') + '\n')], headless: true });
      assert.equal(r.error?.code, code, toml[0]);
      assert.match(r.error.message, re);
    }
    const skip = layer(s.root, 'sk', '[hook.s]\nevent = "SubagentStart"\nrequire = "if-supported"\nrun = { exec = "true" }\n');
    assert.match(ok(s.call('launch-spec', { layers: [skip], headless: true })).skipped.find((x) => x.item === 'hook.s').reason, /SubagentStart: pi has no subagents/);
  } finally {
    s.done();
  }
});

test('the extension: guard, prompt gate, Stop continuation and notifications, with the envelope in hs\'s shape; the marker once registered', async () => {
  const s = box();
  try {
    const out = path.join(s.root, 'out.jsonl');
    const team = layer(s.root, 'team', hookToml(out, path.join(s.root, 'state')), { 'hook.mjs': HOOK });
    const refused = s.call('launch-spec', { layers: [team], headless: true });
    const spec = ok(s.call('launch-spec', { layers: [team], headless: true, receipt: allow(refused) }));
    const { handlers: h, marker } = await load(fs.readFileSync(spec.files.find((f) => f.role === 'extension').path, 'utf8'), s.root);
    assert.deepEqual(Object.keys(h).sort(), ['agent_before_settle', 'input', 'session_shutdown', 'session_start', 'tool_call', 'tool_result']);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(marker, 'utf8'))).sort(), ['at', 'extension', 'hooks', 'pid']);
    const work = path.join(s.root, 'work');
    // PreToolUse: continue, block with the reason, a tool the guard does not name, a nameless call.
    assert.equal(await h.tool_call({ toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } }, ctx(work)), undefined);
    assert.deepEqual(lines(out)[0].hs, { event: 'PreToolUse', session_id: 'ses-test', cwd: work, tool: { class: 'shell', name: 'bash', input: { command: 'ls' } } });
    assert.deepEqual(await h.tool_call({ toolName: 'bash', toolCallId: 'c2', input: { command: 'rm DENYME' } }, ctx(work)), { block: true, reason: 'denied by the team guard' });
    fs.rmSync(out);
    assert.equal(await h.tool_call({ toolName: 'read', toolCallId: 'c3', input: { path: 'a' } }, ctx(work)), undefined);
    assert.deepEqual(lines(out), [], 'the guard names shell only');
    assert.match((await h.tool_call({ toolCallId: 'c4', input: {} }, ctx(work))).reason, /names no tool, so a guard's matcher cannot be tested; failing closed/);
    // An MCP tool keeps its server in the envelope (pi names it mcp__<server>__<tool>).
    await h.tool_result({ toolName: 'mcp__probe__ping', toolCallId: 'c5', input: {}, isError: false }, ctx(work));
    assert.deepEqual(lines(out)[0].hs.tool, { class: 'mcp:probe', name: 'mcp__probe__ping', input: { mcp: { server: 'probe', tool: 'ping' } } });
    fs.rmSync(out);
    // UserPromptSubmit: continue, or handled (the agent skipped) with the hook's reason.
    assert.deepEqual(await h.input({ text: 'hello', source: 'interactive' }, ctx(work)), { action: 'continue' });
    assert.equal(lines(out)[0].hs.prompt, 'hello');
    assert.deepEqual(await h.input({ text: 'BLOCKME please', source: 'interactive' }, ctx(work)), { action: 'handled' });
    fs.rmSync(out);
    // SessionStart by source: startup matches, reload has no spec source and does not.
    await h.session_start({ reason: 'reload' }, ctx(work));
    assert.deepEqual(lines(out), []);
    await h.session_start({ reason: 'startup' }, ctx(work));
    assert.equal(lines(out)[0].hs.source, 'startup');
    await h.session_shutdown({ reason: 'quit' }, ctx(work));
    assert.equal(lines(out)[1].hs.event, 'SessionEnd');
    fs.rmSync(out);
    // Stop: the first block asks for one more run with the reason; the next settle says it was asked.
    const first = await h.agent_before_settle({ entries: [] }, ctx(work));
    assert.deepEqual(first, { entries: [{ type: 'custom_message', customType: 'hs-stop-hook', content: 'keep going: run the tests', display: false }], continue: true });
    assert.equal(await h.agent_before_settle({ entries: [] }, ctx(work)), undefined);
    assert.deepEqual(lines(out).map((l) => l.native.stop_hook_active), [false, true]);
  } finally {
    s.done();
  }
});

test('the extension fails closed on PreToolUse and UserPromptSubmit for every shim failure, and never on the notifications or Stop', async () => {
  const s = box();
  try {
    const hook = (event, over = {}) => ({ id: `hook.${event}`, event, matcher: null, args: ['--timeout', '5', '--', '/usr/bin/true'], limit_ms: 5000, ...over });
    const ext = async (cfg, list) => (await load(extensionSource({ provider: null, mcp: [], hooks: { node: process.execPath, shim: SHIM, margin_ms: 5000, marker: './hs-hooks.loaded', list, ...cfg } }), s.root)).handlers;
    const call = { toolName: 'bash', toolCallId: 'c', input: {} };
    const w = ctx(s.root);
    assert.equal(await (await ext({}, [hook('PreToolUse')])).tool_call(call, w), undefined);
    assert.match((await (await ext({ node: path.join(s.root, 'no-node') }, [hook('PreToolUse')])).tool_call(call, w)).reason, /hook\.PreToolUse: the hook shim could not start \(ENOENT\); failing closed/);
    assert.match((await (await ext({ shim: path.join(s.root, 'no-shim.js') }, [hook('PreToolUse')])).tool_call(call, w)).reason, /the hook shim exited 1; failing closed/);
    assert.deepEqual(await (await ext({ shim: path.join(s.root, 'no-shim.js') }, [hook('UserPromptSubmit')])).input({ text: 'x' }, w), { action: 'handled' });
    // A shim that stalls: its whole group killed at the limit plus the margin, and the call blocked at once.
    const pidFile = path.join(s.root, 'stall.pid');
    const stall = write(s.root, 'stall.mjs', `import fs from 'node:fs';\nimport { spawn } from 'node:child_process';\nconst c = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });\nfs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, c.pid]));\nsetTimeout(() => {}, 60000);\n`);
    const t0 = Date.now();
    assert.match((await (await ext({ shim: stall, margin_ms: 300 }, [hook('PreToolUse', { limit_ms: 200 })])).tool_call(call, w)).reason, /ran past its limit and was stopped; failing closed/);
    assert.ok(Date.now() - t0 < 3000);
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(pids.map(alive), [false, false], 'the shim and what it started are gone');
    // The same failures never fail a notification, and never ask Stop for another run.
    const bad = { node: path.join(s.root, 'no-node') };
    await (await ext(bad, [hook('PostToolUse')])).tool_result(call, w);
    await (await ext(bad, [hook('SessionStart')])).session_start({ reason: 'startup' }, w);
    await (await ext(bad, [hook('SessionEnd')])).session_shutdown({ reason: 'quit' }, w);
    assert.equal(await (await ext(bad, [hook('Stop')])).agent_before_settle({ entries: [] }, w), undefined);
  } finally {
    s.done();
  }
});
