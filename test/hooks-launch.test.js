// Milestone 6a.6: hooks at launch (design note §5.6, §7.5), on Claude Code. Each hook is a command
// in the --settings overlay that runs hs's hook shim, which hands the spec's process the envelope
// and translates its decision back. Each runs code, so each needs the launch receipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { envelope, toolClass, translate } from '../src/shim/claude-code.js';
import { layer, tmpdir, write } from './fixtures.js';
import { ok, sandbox } from './sandbox.js';

const SHIM = fileURLToPath(new URL('../src/shim/claude-code.js', import.meta.url));
function box() {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  return s;
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
const overlay = (spec) => JSON.parse(fs.readFileSync(spec.files.find((f) => f.role === 'settings').path, 'utf8'));

test('the shim: tool classes and the envelope from a native payload', () => {
  assert.deepEqual(['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'WebFetch', 'WebSearch', 'mcp__db__query', 'Agent'].map(toolClass),
    ['shell', 'edit', 'edit', 'edit', 'read', 'fetch', 'fetch', 'mcp:db', null]);
  assert.deepEqual(envelope('PreToolUse', { session_id: 's1', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'ls' } }).hs,
    { event: 'PreToolUse', session_id: 's1', cwd: '/w', tool: { class: 'shell', name: 'Bash', input: { command: 'ls' } } });
  assert.deepEqual(envelope('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/w/a.txt' } }).hs.tool.input, { paths: ['/w/a.txt'] });
  assert.deepEqual(envelope('PreToolUse', { tool_name: 'mcp__db__query', tool_input: {} }).hs.tool, { class: 'mcp:db', name: 'mcp__db__query', input: { mcp: { server: 'db', tool: 'query' } } });
  const prompt = envelope('UserPromptSubmit', { session_id: 's1', prompt: 'hi' });
  assert.equal(prompt.hs.prompt, 'hi');
  assert.equal(prompt.hs.tool, undefined);
  assert.deepEqual(prompt.native, { session_id: 's1', prompt: 'hi' }, 'the native payload rides along');
  assert.equal(envelope('SessionStart', { source: 'resume' }).hs.source, 'resume');
});

test('the shim: decisions translated to Claude Code\'s protocol', () => {
  assert.deepEqual(translate('PreToolUse', { status: 2, stdout: '', stderr: 'no' }), { code: 2, stdout: '', stderr: 'no' });
  assert.deepEqual(translate('PreToolUse', { status: 0, stdout: '{"decision": "deny", "reason": "not here"}', stderr: '' }), { code: 2, stdout: '', stderr: 'not here' });
  // A review finding: an allow skips the permission prompt, so only a may_allow hook gives one.
  assert.deepEqual(JSON.parse(translate('PreToolUse', { status: 0, stdout: '{"decision":"allow","reason":"ok"}', stderr: '' }, { mayAllow: true }).stdout),
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'ok' } });
  assert.deepEqual(translate('PreToolUse', { status: 0, stdout: '{"decision":"allow"}', stderr: '' }), { code: 0, stdout: '', stderr: '' }, 'without may_allow, allow only continues');
  // A review finding: a guard that crashes fails closed on a gating event, never elsewhere.
  for (const event of ['PreToolUse', 'UserPromptSubmit']) {
    assert.equal(translate(event, { status: 1, stdout: '', stderr: 'boom' }).code, 2, `${event} exit 1`);
    const killed = translate(event, { status: null, signal: 'SIGKILL', stdout: '', stderr: '' });
    assert.equal(killed.code, 2, `${event} signal`);
    assert.match(killed.stderr, /died by SIGKILL; failing closed/);
    assert.match(translate(event, { status: null, signal: 'SIGKILL', timedOut: true, stdout: '', stderr: '' }).stderr, /ran past its limit/);
  }
  // A review finding: PermissionRequest does not honour exit 2; a block there is the decision object.
  const deny = (r) => JSON.parse(r.stdout).hookSpecificOutput;
  for (const res of [{ status: 0, stdout: '{"decision":"deny","reason":"no"}' }, { status: 2, stderr: 'no' }, { status: 1, stderr: 'boom' }, { status: null, signal: 'SIGKILL' }]) {
    const r = translate('PermissionRequest', { stdout: '', stderr: '', ...res });
    assert.equal(r.code, 0, JSON.stringify(res));
    assert.deepEqual([deny(r).hookEventName, deny(r).decision.behavior], ['PermissionRequest', 'deny']);
  }
  assert.equal(deny(translate('PermissionRequest', { status: 0, stdout: '{"decision":"deny","reason":"no"}', stderr: '' })).decision.message, 'no');
  assert.match(translate('PreToolUse', { status: 3, stdout: '{"decision":"allow"}', stderr: '' }, { mayAllow: true }).stderr, /exited 3; failing closed/, 'a crash is not an allow, whatever it printed');
  assert.deepEqual(translate('Stop', { status: 0, stdout: '{"decision":"allow"}', stderr: '' }), { code: 0, stdout: '', stderr: '' }, 'allow elsewhere is continue');
  assert.deepEqual(JSON.parse(translate('UserPromptSubmit', { status: 0, stdout: '{"context":"remember x"}', stderr: '' }).stdout),
    { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'remember x' } });
  assert.deepEqual(translate('SessionStart', { status: 0, stdout: 'plain words\n', stderr: '' }), { code: 0, stdout: 'plain words\n', stderr: '' }, 'plain stdout passes through');
  assert.deepEqual(translate('Stop', { status: 1, stdout: 'oops', stderr: 'err' }), { code: 1, stdout: 'oops', stderr: 'err' }, 'a non-blocking error stays one');
});

test('the shim end to end: the envelope on stdin, env and env refs, cwd; a process that cannot run fails closed', () => {
  const root = tmpdir();
  try {
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    const seen = path.join(root, 'seen.json');
    const hook = write(root, 'hook.mjs', `import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ hs: input.hs, a: process.env.A, b: process.env.B === 'dummy-value' ? 'match' : 'no', cwd: process.cwd() }));
process.stdout.write(input.hs.tool.input.command === 'rm -rf /' ? '{"decision":"deny","reason":"refused by the guard"}' : '{"decision":"allow"}');
`);
    const run = (command, extra = []) => spawnSync(process.execPath, [SHIM, 'PreToolUse', '--may-allow', '--cwd', work, '--env', 'A=1', '--env-ref', 'B=HS_REF_B', ...extra, '--', process.execPath, hook], {
      input: JSON.stringify({ session_id: 's1', cwd: '/w', tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', env: { PATH: process.env.PATH, HS_REF_B: 'dummy-value' },
    });
    let r = run('ls');
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'allow');
    const got = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.deepEqual([got.hs.event, got.hs.tool.class, got.a, got.b, fs.realpathSync(got.cwd)], ['PreToolUse', 'shell', '1', 'match', fs.realpathSync(work)]);
    r = run('rm -rf /');
    assert.deepEqual([r.status, r.stderr], [2, 'refused by the guard']);
    const missing = spawnSync(process.execPath, [SHIM, 'PreToolUse', '--', path.join(root, 'no-such-hook')], { input: '{}', encoding: 'utf8' });
    assert.equal(missing.status, 2, 'a guard that cannot run fails closed');
    assert.match(missing.stderr, /failing closed/);
    // A guard that crashes fails closed too, end to end.
    const crash = write(root, 'crash.mjs', 'process.exit(1);\n');
    const crashed = spawnSync(process.execPath, [SHIM, 'PreToolUse', '--', process.execPath, crash], { input: '{"tool_name":"Bash","tool_input":{"command":"ls"}}', encoding: 'utf8' });
    assert.equal(crashed.status, 2);
    // A review finding: a guard that stalls past its limit is stopped by the shim, which blocks.
    const slow = write(root, 'slow.mjs', 'setTimeout(() => {}, 30000);\n');
    const t0 = Date.now();
    const stalled = spawnSync(process.execPath, [SHIM, 'PreToolUse', '--timeout', '1', '--', process.execPath, slow], { input: '{"tool_name":"Bash","tool_input":{}}', encoding: 'utf8' });
    assert.equal(stalled.status, 2);
    assert.match(stalled.stderr, /ran past its limit/);
    assert.ok(Date.now() - t0 < 10000, 'stopped at the limit, not after the process');
    const stalledPR = spawnSync(process.execPath, [SHIM, 'PermissionRequest', '--timeout', '1', '--', process.execPath, slow], { input: '{"tool_name":"Bash","tool_input":{}}', encoding: 'utf8' });
    assert.deepEqual([stalledPR.status, JSON.parse(stalledPR.stdout).hookSpecificOutput.decision.behavior], [0, 'deny']);
    // Without --may-allow the same allow does not skip the prompt.
    const plain = spawnSync(process.execPath, [SHIM, 'PreToolUse', '--', process.execPath, hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), encoding: 'utf8' });
    assert.deepEqual([plain.status, plain.stdout], [0, '']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude Code: a hook in the --settings overlay through the shim, under the launch receipt', () => {
  const s = box();
  try {
    const team = layer(s.root, 'guards', '[refs.GUARD_KEY]\ndescription = "k"\n\n[hook.guard]\nevent = "PreToolUse"\nmatch = { tool = ["shell", "mcp:db"] }\nrun = { exec = "hooks/guard.sh", env = { MODE = "strict" }, env_refs = { KEY = "GUARD_KEY" } }\ntimeout = 20\nmay_allow = true\n', { 'hooks/guard.sh': '#!/bin/sh\nexit 0\n' });
    const local = write(s.root, 'local.toml', '[refs]\nGUARD_KEY = "keychain:example/guard"\n');
    const refused = s.call('launch-spec', { layers: [team], local });
    assert.equal(refused.error.code, 'receipt_required');
    const [risk, grant] = refused.error.items[0].risks;
    assert.deepEqual([risk.item, risk.risk, risk.files.map((f) => f.path)], ['hook.guard', 'runs-code', ['hooks/guard.sh']]);
    // A review finding: a hook whose allow skips the permission prompt says so, with what it covers.
    assert.deepEqual(grant, { item: 'hook.guard', layer: 'guards', risk: 'grants-permission', event: 'PreToolUse', tools: ['shell', 'mcp:db'], matcher: '^(Bash|mcp__db__.*)$' });
    const spec = ok(s.call('launch-spec', { layers: [team], local, receipt: allow(refused) }));
    const [entry] = overlay(spec).hooks.PreToolUse;
    assert.equal(entry.matcher, '^(Bash|mcp__db__.*)$');
    assert.equal(entry.hooks[0].type, 'command');
    assert.equal(entry.hooks[0].timeout, 30, 'the native timeout sits above the shim\'s limit');
    assert.ok(entry.hooks[0].command.includes('--timeout 20'));
    assert.equal(risk.blocks, true);
    const cmd = entry.hooks[0].command;
    assert.ok(cmd.startsWith(`${process.execPath} ${SHIM} PreToolUse --may-allow `));
    assert.ok(cmd.includes(`--env MODE=strict --env-ref KEY=HS_REF_GUARD_KEY -- ${path.join(team, 'hooks', 'guard.sh')}`));
    assert.doesNotMatch(cmd, /\$\{|keychain:/, 'no ${…} and no reference in the command');
    assert.deepEqual(spec.env_from_refs, { HS_REF_GUARD_KEY: 'keychain:example/guard' });
  } finally {
    s.done();
  }
});

test('matchers: exact names, a source list, none; validation', () => {
  const s = box();
  try {
    const hooksOf = (toml) => {
      const team = layer(s.root, `h${Math.random()}`.replace('.', ''), toml);
      const refused = s.call('launch-spec', { layers: [team] });
      return overlay(ok(s.call('launch-spec', { layers: [team], receipt: allow(refused) }))).hooks;
    };
    assert.equal(hooksOf('[hook.a]\nevent = "PostToolUse"\nmatch = { tool = ["edit", "mcp:db/query"] }\nrun = { exec = "x" }\n').PostToolUse[0].matcher, 'Edit|Write|NotebookEdit|mcp__db__query');
    assert.equal(hooksOf('[hook.b]\nevent = "SessionStart"\nmatch = { source = ["startup", "resume"] }\nrun = { exec = "x" }\n').SessionStart[0].matcher, 'startup|resume');
    const prompt = hooksOf('[hook.c]\nevent = "UserPromptSubmit"\nrun = { shell = "echo hi" }\n').UserPromptSubmit[0];
    assert.ok(!('matcher' in prompt));
    assert.equal(prompt.hooks[0].timeout, 70, 'the default limit, 60 s, plus the margin');
    assert.ok(prompt.hooks[0].command.includes('--timeout 60'));
    // A review finding: names outside the exact-match charset are escaped and anchored.
    assert.equal(hooksOf('[hook.d]\nevent = "SubagentStop"\nmatch = { agent = ["reviewer.v1", "code-reviewer"] }\nrun = { exec = "x" }\n').SubagentStop[0].matcher, '^(reviewer\\.v1|code-reviewer)$');
    assert.equal(hooksOf('[hook.e]\nevent = "SubagentStop"\nmatch = { agent = ["code-reviewer"] }\nrun = { exec = "x" }\n').SubagentStop[0].matcher, 'code-reviewer');
    // A review finding: a hook on an event that cannot block says so, in the receipt and the launch.
    const start = layer(s.root, 'start', '[hook.s]\nevent = "SessionStart"\nrun = { exec = "x" }\n');
    const sr = s.call('launch-spec', { layers: [start] });
    assert.equal(sr.error.items[0].risks[0].blocks, false);
    assert.ok(ok(s.call('launch-spec', { layers: [start], receipt: allow(sr) })).launch_items.some((x) => x.item === 'hook.s' && /cannot block on Claude Code/.test(x.via)));

    const problems = (toml) => ok(handle({ protocol: PROTOCOL, op: 'validate', args: { harness: 'claude-code', layers: [layer(s.root, `v${Math.random()}`.replace('.', ''), toml)] } }, s.opts)).problems.map((p) => p.code);
    assert.deepEqual(problems('[hook.x]\nevent = "OnSomething"\nrun = { exec = "x" }\n'), ['item_malformed']);
    assert.deepEqual(problems('[hook.x]\nevent = "UserPromptSubmit"\nmatch = { tool = ["shell"] }\nrun = { exec = "x" }\n'), ['item_malformed']);
    assert.deepEqual(problems('[hook.x]\nevent = "PreToolUse"\nmatch = { tool = ["browser"] }\nrun = { exec = "x" }\n'), ['item_malformed']);
    assert.deepEqual(problems('[hook.x]\nevent = "SessionStart"\nmatch = { source = ["boot"] }\nrun = { exec = "x" }\n'), ['item_malformed']);
    assert.deepEqual(problems('[hook.x]\nevent = "Stop"\n'), ['item_malformed']);
    assert.deepEqual(problems('[hook.x]\nevent = "Stop"\nrun = { exec = "x", args = ["${ANTHROPIC_AUTH_TOKEN}"] }\n'), ['interpolation_refused']);
    assert.deepEqual(problems('[hook.x]\nevent = "Stop"\nrun = { exec = "x" }\nrequire = "required"\ntimeout = 5\n'), []);
    assert.deepEqual(problems('[hook.x]\nevent = "Stop"\nrun = { exec = "x" }\nmay_allow = true\n'), ['item_malformed'], 'may_allow is for PreToolUse');
    // Without may_allow, no grants-permission risk and no --may-allow.
    const quiet = layer(s.root, 'quiet', '[hook.q]\nevent = "PreToolUse"\nrun = { exec = "x" }\n');
    const qr = s.call('launch-spec', { layers: [quiet] });
    assert.deepEqual(qr.error.items[0].risks.map((r) => r.risk), ['runs-code']);
    assert.ok(!overlay(ok(s.call('launch-spec', { layers: [quiet], receipt: allow(qr) }))).hooks.PreToolUse[0].hooks[0].command.includes('--may-allow'));
    const team = layer(s.root, 'planned', '[hook.p]\nevent = "Stop"\nrun = { exec = "x" }\n');
    assert.ok(ok(s.call('plan', { layers: [team], owner: 'tool', mode: 'overlay' })).launch_only.some((x) => x.item === 'hook.p' && /hook shim/.test(x.via)));
  } finally {
    s.done();
  }
});
