// Milestone 7.3: hooks on OpenCode through hs's bridge plugin (design note §5.6, §8). A launch writes
// one plain .js plugin into its config directory's plugins/; it runs hs's hook shim for each hook on
// the plugin hook its event rides on. Only tool execute.before can refuse, so PreToolUse is the one
// guard; every other event but PostToolUse is refused when required and skipped when if-supported.
// No test starts a real harness: the plugin is loaded here with a stand-in for OpenCode's ctx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { SHIM, bridgeSource } from '../src/drivers/opencode/bridge.js';
import { layer, tmpdir, write } from './fixtures.js';
import { linuxHost, ok } from './sandbox.js';

function box() {
  const root = tmpdir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folder = path.join(root, 'oc-folder');
  for (const r of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(folder, r, 'opencode'), { recursive: true });
  const bin = write(root, 'bin/opencode', '#!/bin/sh\necho "opencode v2.2.7"\n');
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home, tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'opencode', harness_path: folder, bin, ...args } }, opts);
  return { root, home, folder, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });

// The hook process: writes the envelope it got to HOOK_OUT, then decides by the command: DENYME
// blocks (exit 2, a reason), anything else continues.
const HOOK = `import fs from 'node:fs';
const raw = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.HOOK_OUT, raw + '\\n');
const e = JSON.parse(raw);
if (String(e.hs.tool?.input?.command ?? '').includes('DENYME')) { process.stderr.write('denied by the team guard'); process.exit(2); }
process.exit(0);
`;
const hookToml = (out, extra = []) => [
  '[hook.guard]', 'event = "PreToolUse"', 'match = { tool = ["shell"] }',
  `run = { exec = ${JSON.stringify(process.execPath)}, args = ["hook.mjs"], env = { HOOK_OUT = ${JSON.stringify(out)} } }`, 'timeout = 5', '',
  '[hook.log]', 'event = "PostToolUse"',
  `run = { exec = ${JSON.stringify(process.execPath)}, args = ["hook.mjs"], env = { HOOK_OUT = ${JSON.stringify(out)} } }`, '',
  ...extra,
].join('\n');

// OpenCode's ctx, as far as the bridge uses it: location.directory, and tool.hook registering a
// callback per plugin hook (tier 1, opencode-bridge).
function fakeCtx(directory) {
  const hooks = {};
  return { hooks, ctx: { location: { directory }, tool: { hook: async (name, fn) => { hooks[name] = fn; } } } };
}
// The plugin, written where a launch puts it: its own directory in <temp dir>, so its readiness
// marker lands in <temp dir>.
let loaded = 0;
async function load(source, dir) {
  const temp = path.join(dir, `launch-${loaded++}`);
  const f = path.join(temp, 'hs-hooks', 'server.mjs');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, source);
  const plugin = (await import(pathToFileURL(f).href)).default;
  return Object.assign(plugin, { marker: path.join(temp, 'hs-hooks.loaded') });
}
const event = (tool, input) => ({ tool, sessionID: 'ses_test', agent: 'build', messageID: 'msg_1', id: 'call_1', input });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('launch-spec: PreToolUse and PostToolUse ride the bridge plugin, a directory the inline layer names, under a receipt; an if-supported event with no route is skipped', async () => {
  const s = box();
  try {
    const out = path.join(s.root, 'envelopes.jsonl');
    const team = layer(s.root, 'team', hookToml(out, ['[hook.prompt]', 'event = "UserPromptSubmit"', `run = { exec = "true" }`, 'require = "if-supported"', '']), { 'hook.mjs': HOOK });
    const refused = s.call('launch-spec', { layers: [team], headless: true });
    assert.equal(refused.error.code, 'receipt_required');
    const risks = refused.error.items[0].risks;
    assert.deepEqual(risks.map((r) => [r.item, r.risk, r.blocks]), [['hook.guard', 'runs-code', true], ['hook.log', 'runs-code', false]]);
    const spec = ok(s.call('launch-spec', { layers: [team], headless: true, receipt: allow(refused) }));
    const dir = spec.files.find((f) => f.role === 'hooks_plugin').path;
    assert.deepEqual(JSON.parse(spec.env_set.OPENCODE_CONFIG_CONTENT).plugins, [dir], 'a configured plugin path is a directory');
    assert.equal(JSON.parse(spec.env_set.OPENCODE_CONFIG_CONTENT).instructions, undefined, 'no instructions without an AGENTS.md');
    assert.ok(!('OPENCODE_CONFIG_DIR' in spec.env_set));
    assert.ok(!spec.launch_items.some((i) => i.item === 'instructions (AGENTS.md)'), 'a bridge alone carries no instructions');
    const plugin = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
    assert.doesNotMatch(plugin, /^\s*import .* from '(?!node:)/m, 'no import but node: modules, so OpenCode installs nothing');
    assert.ok(plugin.includes(JSON.stringify(SHIM)), 'it runs hs\'s shim for OpenCode');
    assert.equal(plugin.split('/* hs:config */').length, 1, 'the configuration is written in');
    const guard = spec.launch_items.find((i) => i.item === 'hook.guard');
    assert.match(guard.via, /<temp>\/hs-hooks in OPENCODE_CONFIG_CONTENT's plugins \(tool\.execute\.before, \^\(shell\)\$\), through hs's hook shim$/);
    assert.match(spec.launch_items.find((i) => i.item === 'hook.log').via, /tool\.execute\.after.*cannot block on OpenCode/);
    assert.match(spec.skipped.find((x) => x.item === 'hook.prompt').reason, /UserPromptSubmit: .*session\.prompt.* not refuse/);
    assert.ok(spec.notes.some((n) => /fails closed/.test(n)) && spec.notes.some((n) => /context output is not delivered/.test(n)) && spec.notes.some((n) => /tool\.class null/.test(n)));
    assert.ok(spec.notes.some((n) => /bridge plugin fails to load, OpenCode starts without it.*a missing marker tells a caller its guards are not active/.test(n)), 'the one fail-open case, measured, is named');
    // What a caller checks before it takes the guards as active.
    assert.deepEqual(spec.readiness.map((r) => [r.what, r.path]), [['hooks', path.join(spec.temp_dir, 'hs-hooks.loaded')]]);
    assert.match(spec.readiness[0].means, /until it exists, no hook of this launch is active/);
    assert.equal(path.dirname(dir), spec.temp_dir, 'the plugin directory is one tree in the temp dir, as the marker\'s relative path assumes');
    // Under a plan, hooks stay launch only.
    const plan = ok(s.call('plan', { layers: [team], owner: 'builder', mode: 'materialize' }));
    assert.match(plan.launch_only.find((x) => x.item === 'hook.guard').via, /hooks bridge plugin.*not persisted in this build/);
  } finally {
    s.done();
  }
});

test('launch-spec refuses, by name: a required event with no route, may_allow, and an MCP server match', () => {
  const s = box();
  try {
    const cases = [
      [['[hook.p]', 'event = "UserPromptSubmit"', 'run = { exec = "true" }'], /hook\.p: UserPromptSubmit: .*session\.prompt.*would not block/],
      [['[hook.s]', 'event = "SessionStart"', 'run = { exec = "true" }'], /hook\.s: SessionStart: OpenCode 2\.x has no plugin hook for this event/],
      [['[hook.a]', 'event = "PreToolUse"', 'match = { tool = ["shell"] }', 'may_allow = true', 'run = { exec = "true" }'], /hook\.a: may_allow: .*deny only/],
      [['[hook.m]', 'event = "PreToolUse"', 'match = { tool = ["mcp:db"] }', 'run = { exec = "true" }'], /hook\.m: tool class mcp:db: .*server a would also match server a_b/],
    ];
    for (const [i, [toml, re]] of cases.entries()) {
      const team = layer(s.root, `t${i}`, toml.join('\n') + '\n');
      const r = s.call('launch-spec', { layers: [team], headless: true });
      assert.equal(r.error?.code, 'item_unsupported', toml[0]);
      assert.match(r.error.message, re);
      const plan = s.call('plan', { layers: [team], owner: 'builder', mode: 'materialize' });
      assert.equal(plan.error?.code, 'item_unsupported', `the plan refuses it too: ${toml[0]}`);
      assert.match(plan.error.items[0].reason, re);
    }
  } finally {
    s.done();
  }
});

test('the bridge: PreToolUse continues or blocks by the hook, with the envelope in hs\'s shape; a tool its matcher does not name never runs it', async () => {
  const s = box();
  try {
    const out = path.join(s.root, 'envelopes.jsonl');
    const team = layer(s.root, 'team', hookToml(out), { 'hook.mjs': HOOK });
    const refused = s.call('launch-spec', { layers: [team], headless: true });
    const spec = ok(s.call('launch-spec', { layers: [team], headless: true, receipt: allow(refused) }));
    const plugin = await load(fs.readFileSync(path.join(spec.files.find((f) => f.role === 'hooks_plugin').path, 'server.js'), 'utf8'), s.root);
    assert.equal(plugin.id, 'hs-hooks');
    const work = path.join(s.root, 'work');
    const { ctx, hooks } = fakeCtx(work);
    assert.equal(fs.existsSync(plugin.marker), false);
    await plugin.setup(ctx);
    assert.deepEqual(Object.keys(hooks).sort(), ['execute.after', 'execute.before']);
    // Its hooks registered, the bridge says so in the launch's temp dir.
    const m = JSON.parse(fs.readFileSync(plugin.marker, 'utf8'));
    assert.deepEqual([m.plugin, m.hooks, m.pid], ['hs-hooks', 2, process.pid]);
    // A tool call that names no tool fails closed: the guard's matcher cannot be tested.
    await assert.rejects(hooks['execute.before'](event(undefined, { command: 'ls' })), /the tool call names no tool, so a guard's matcher cannot be tested; failing closed/);
    await hooks['execute.before'](event('shell', { command: 'ls -la', workdir: '.' }));
    const [env] = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(env.hs, { event: 'PreToolUse', session_id: 'ses_test', cwd: work, tool: { class: 'shell', name: 'shell', input: { command: 'ls -la' } } });
    assert.equal(env.native.id, 'call_1', 'native is OpenCode\'s event, with the directory added');
    await assert.rejects(hooks['execute.before'](event('shell', { command: 'rm -rf DENYME' })), { message: 'denied by the team guard' });
    fs.rmSync(out);
    await hooks['execute.before'](event('read', { path: 'a.txt' }));
    assert.equal(fs.existsSync(out), false, 'the guard names shell only');
    // PostToolUse runs for every tool, and a patch's paths come from its headers.
    await hooks['execute.after']({ ...event('patch', { patchText: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** End Patch' }), status: 'completed', result: { output: 'ok' } });
    const [after] = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(after.hs.tool, { class: 'edit', name: 'patch', input: { paths: ['src/a.js'] } });
    // An MCP tool's name tells hs nothing it can trust: no class.
    fs.rmSync(out);
    await hooks['execute.after']({ ...event('probe_ping', {}), status: 'completed', result: {} });
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).hs.tool.class, null);
  } finally {
    s.done();
  }
});

test('the bridge fails closed on PreToolUse for every shim failure, and never rejects on PostToolUse', async () => {
  const s = box();
  try {
    const hook = (over = {}) => ({ id: 'hook.guard', event: 'PreToolUse', on: 'execute.before', matcher: null, args: ['--timeout', '5', '--', '/usr/bin/true'], limit_ms: 5000, ...over });
    const bridge = async (cfg, hooks) => {
      const plugin = await load(bridgeSource({ id: 'hs-hooks', node: process.execPath, shim: SHIM, margin_ms: 5000, marker: '../../hs-hooks.loaded', hooks, ...cfg }), s.root);
      const { ctx, hooks: h } = fakeCtx(s.root);
      await plugin.setup(ctx);
      return h;
    };
    // The real shim continues on exit 0.
    await (await bridge({}, [hook()]))['execute.before'](event('shell', { command: 'true' }));
    // A node that is not there: the shim cannot start.
    await assert.rejects((await bridge({ node: path.join(s.root, 'no-node') }, [hook()]))['execute.before'](event('shell', {})), /hook\.guard: the hook shim could not start \(ENOENT\); failing closed/);
    // A shim that is not there: node exits 1.
    await assert.rejects((await bridge({ shim: path.join(s.root, 'no-shim.js') }, [hook()]))['execute.before'](event('shell', {})), /the hook shim exited 1; failing closed/);
    // A shim that stalls: stopped at its limit plus the margin, its whole group killed, blocked at once.
    const pidFile = path.join(s.root, 'stall.pid');
    const stall = write(s.root, 'stall.mjs', `import fs from 'node:fs';\nimport { spawn } from 'node:child_process';\nconst c = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });\nfs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, c.pid]));\nsetTimeout(() => {}, 60000);\n`);
    const t0 = Date.now();
    await assert.rejects((await bridge({ shim: stall, margin_ms: 300 }, [hook({ limit_ms: 200 })]))['execute.before'](event('shell', {})), /the hook shim ran past its limit and was stopped; failing closed/);
    assert.ok(Date.now() - t0 < 3000, 'decided at the limit, not when the descendant ends');
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(pids.map(alive), [false, false], 'the shim and what it started are gone');
    // The hook's own process stalling: the shim stops it at the hook's limit and blocks.
    await assert.rejects((await bridge({}, [hook({ args: ['--timeout', '1', '--', '/bin/sleep', '30'], limit_ms: 1000 })]))['execute.before'](event('shell', {})), /ran past its limit and was stopped; failing closed/);
    // With no matcher, a call that names no tool still runs the hook, whose shim decides.
    await (await bridge({}, [hook()]))['execute.before'](event(undefined, {}));
    // A registration that fails leaves no marker: the bridge is not known to have loaded.
    const failing = await load(bridgeSource({ id: 'hs-hooks', node: process.execPath, shim: SHIM, margin_ms: 5000, marker: '../../hs-hooks.loaded', hooks: [hook()] }), s.root);
    await assert.rejects(failing.setup({ location: { directory: s.root }, tool: { hook: async () => { throw new Error('no such hook'); } } }));
    assert.equal(fs.existsSync(failing.marker), false);
    // PostToolUse cannot refuse: the same failures resolve.
    const post = (over) => hook({ event: 'PostToolUse', on: 'execute.after', ...over });
    await (await bridge({ node: path.join(s.root, 'no-node') }, [post()]))['execute.after']({ ...event('shell', {}), status: 'completed', result: {} });
    await (await bridge({ shim: path.join(s.root, 'no-shim.js') }, [post()]))['execute.after']({ ...event('shell', {}), status: 'completed', result: {} });
  } finally {
    s.done();
  }
});

test('bridgeSource: the configuration is JSON in place of the marker, a $ in it kept as written', async () => {
  const src = bridgeSource({ id: 'hs-hooks', node: '/opt/n$&de/bin/node', shim: SHIM, margin_ms: 5000, hooks: [{ id: 'hook.x', event: 'PreToolUse', on: 'execute.before', matcher: '^(shell)$', args: ['--', "/bin/echo", "$'x"], limit_ms: 1000 }] });
  assert.ok(src.includes('"/opt/n$&de/bin/node"') && src.includes('"$\'x"') && src.includes('"^(shell)$"'));
});
