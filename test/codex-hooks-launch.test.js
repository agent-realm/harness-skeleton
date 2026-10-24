// Milestone 6a.8: hooks at launch on Codex (design note §5.6, §7.5). Each hook is a `-c hooks.<Event>`
// group running hs's hook shim, trusted for the launch by one `-c hooks.state` table whose
// trusted_hash hs computes as Codex does. Each runs code, so each needs the launch receipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { hookHash } from '../src/drivers/codex/deliver.js';
import { envelope, toolClass, translate } from '../src/shim/codex.js';
import { translate as ccTranslate } from '../src/shim/claude-code.js';
import { codexFolder, layer, write } from './fixtures.js';
import { linuxHost, ok, sandbox } from './sandbox.js';

const SHIM = fileURLToPath(new URL('../src/shim/codex.js', import.meta.url));

function box() {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  s.codex = codexFolder(s.root);
  s.codexBin = write(s.root, 'bin/codex', '#!/bin/sh\necho "codex-cli 0.160.0"\n');
  fs.chmodSync(s.codexBin, 0o755);
  s.cx = (op, args) => handle({ protocol: PROTOCOL, op, args: { harness: 'codex', harness_path: s.codex, bin: s.codexBin, ...args } }, { ...s.opts, host: linuxHost });
  return s;
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
// The value of `-c <key>=…`, parsed as Codex parses it: as TOML.
function flag(argv, key) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-c' && argv[i + 1].startsWith(`${key}=`)) return parseToml(`v = ${argv[i + 1].slice(key.length + 1)}`).v;
  }
  return undefined;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const launch = (s, team, local) => {
  const refused = s.cx('launch-spec', { layers: [team], ...(local ? { local } : {}) });
  assert.equal(refused.error?.code, 'receipt_required', JSON.stringify(refused.error));
  return { refused, spec: ok(s.cx('launch-spec', { layers: [team], ...(local ? { local } : {}), receipt: allow(refused) })) };
};

test('the trust hash: canonical JSON of the normalized identity, as Codex computes it', () => {
  // Keys sorted at every depth, no spaces; the input order does not matter.
  const identity = { matcher: 'Bash', hooks: [{ type: 'command', timeout: 600, command: '/opt/adapter/hook.sh', async: false }], event_name: 'pre_tool_use' };
  // The canonical string is {"event_name":"pre_tool_use","hooks":[{"async":false,"command":"/opt/adapter/hook.sh","timeout":600,"type":"command"}],"matcher":"Bash"}.
  assert.equal(hookHash(identity), 'sha256:9af9b23f4b194e94c98aee3ec20beaad8e7858a54d4a83b33d84b1892b820170');
  assert.equal(hookHash({ event_name: 'pre_tool_use', hooks: identity.hooks, matcher: 'Bash' }), hookHash(identity));
});

test('Codex: a PreToolUse guard as -c hooks, trusted for the launch, under the receipt', () => {
  const s = box();
  try {
    const team = layer(s.root, 'guards', '[hook.g]\nevent = "PreToolUse"\nmatch = { tool = ["shell"] }\nrun = { exec = "guard.sh", args = ["--strict"] }\ntimeout = 20\n', { 'guard.sh': '#!/bin/sh\n' });
    const { refused, spec } = launch(s, team);
    assert.deepEqual(refused.error.items[0].risks.map((r) => [r.item, r.risk, r.blocks]), [['hook.g', 'runs-code', true], ['hook.g', 'trust', undefined]]);
    const trustRisk = refused.error.items[0].risks[1];
    const groups = plain(flag(spec.argv, 'hooks.PreToolUse'));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].matcher, 'Bash');
    const [handler] = groups[0].hooks;
    assert.equal(handler.type, 'command');
    assert.equal(handler.timeout, 30, 'the shim stops the process at 20 s; Codex\'s own timeout sits 10 s above');
    assert.match(handler.command, /shim\/codex\.js'? PreToolUse --timeout 20 -- '?[^ ']*guards\/guard\.sh'? --strict$/);
    const state = plain(flag(spec.argv, 'hooks.state'));
    assert.deepEqual(Object.keys(state), ['/<session-flags>/config.toml:pre_tool_use:0:0']);
    assert.equal(state['/<session-flags>/config.toml:pre_tool_use:0:0'].trusted_hash,
      hookHash({ event_name: 'pre_tool_use', matcher: 'Bash', hooks: [{ ...handler, async: false }] }));
    // The trust risk names the gate, and binds the key and the hash the launch trusts.
    assert.deepEqual([trustRisk.gate, trustRisk.key, trustRisk.hash], ['codex hook trust (the /hooks review)', '/<session-flags>/config.toml:pre_tool_use:0:0', state['/<session-flags>/config.toml:pre_tool_use:0:0'].trusted_hash]);
    assert.equal(spec.argv.filter((a) => a.startsWith('hooks.state=')).length, 1, 'one trust table: a second -c hooks.state would replace the first');
    assert.ok(!spec.argv.includes('--dangerously-bypass-hook-trust'));
    assert.ok(spec.unverified.some((u) => /trusted_hash is computed by hs/.test(u)));
    assert.doesNotMatch(spec.argv.join(' '), /\$\{/);
  } finally {
    s.done();
  }
});

test('Codex: groups per event, indexes in the trust keys, no matcher where the event has none, refs by derived name', () => {
  const s = box();
  try {
    const team = layer(s.root, 'many', `[refs.T]\ndescription = "t"\n
[hook.a]\nevent = "PreToolUse"\nmatch = { tool = ["edit", "mcp:my-db"] }\nrun = { exec = "a" }\n
[hook.b]\nevent = "PreToolUse"\nrun = { exec = "b", env = { MODE = "x" }, env_refs = { TOK = "T" } }\n
[hook.p]\nevent = "UserPromptSubmit"\nrun = { exec = "p" }\n
[hook.e]\nevent = "SessionEnd"\nrun = { exec = "e" }\n`);
    const local = write(s.root, 'local.toml', '[refs]\nT = "env:T"\n');
    const { spec } = launch(s, team, local);
    const pre = plain(flag(spec.argv, 'hooks.PreToolUse'));
    assert.equal(pre[0].matcher, '^(apply_patch|mcp__my-db__.*)$', 'a pattern makes the matcher an anchored regex');
    assert.equal(pre[1].matcher, undefined, 'no match: every tool');
    assert.match(pre[1].hooks[0].command, /--env MODE=x --env-ref TOK=HS_SECRET_T --/);
    assert.deepEqual(spec.env_from_refs, { HS_SECRET_T: 'env:T' });
    assert.ok(spec.argv.includes('shell_environment_policy.ignore_default_excludes=false'));
    const prompt = plain(flag(spec.argv, 'hooks.UserPromptSubmit'));
    assert.equal(prompt[0].matcher, undefined);
    const end = plain(flag(spec.argv, 'hooks.SessionEnd'))[0].hooks[0];
    assert.equal(end.timeout, 3, 'Codex caps SessionEnd at 3 s');
    assert.match(end.command, /SessionEnd --timeout 2 --/);
    const state = plain(flag(spec.argv, 'hooks.state'));
    assert.deepEqual(Object.keys(state).sort(), [
      '/<session-flags>/config.toml:pre_tool_use:0:0', '/<session-flags>/config.toml:pre_tool_use:1:0',
      '/<session-flags>/config.toml:session_end:0:0', '/<session-flags>/config.toml:user_prompt_submit:0:0',
    ]);
    assert.equal(state['/<session-flags>/config.toml:user_prompt_submit:0:0'].trusted_hash,
      hookHash({ event_name: 'user_prompt_submit', hooks: [{ ...prompt[0].hooks[0], async: false }] }), 'no matcher in the hash');
    assert.equal(state['/<session-flags>/config.toml:pre_tool_use:1:0'].trusted_hash,
      hookHash({ event_name: 'pre_tool_use', hooks: [{ ...pre[1].hooks[0], async: false }] }));
  } finally {
    s.done();
  }
});

test('Codex: refused hooks: may_allow, read and fetch classes, a SessionEnd limit Codex cannot keep; plans list hooks as launch_only', () => {
  const s = box();
  try {
    const cases = [
      ['allow', '[hook.h]\nevent = "PreToolUse"\nmay_allow = true\nrun = { exec = "x" }\n'],
      ['read', '[hook.h]\nevent = "PreToolUse"\nmatch = { tool = ["read"] }\nrun = { exec = "x" }\n'],
      ['fetch', '[hook.h]\nevent = "PostToolUse"\nmatch = { tool = ["shell", "fetch"] }\nrun = { exec = "x" }\n'],
      ['end', '[hook.h]\nevent = "SessionEnd"\ntimeout = 5\nrun = { exec = "x" }\n'],
    ];
    for (const [n, toml] of cases) {
      const res = s.cx('launch-spec', { layers: [layer(s.root, `r-${n}`, toml)] });
      assert.deepEqual([res.error?.code, res.error?.items], ['item_unsupported', ['hook.h']], n);
    }
    const team = layer(s.root, 'plan', '[hook.s]\nevent = "Stop"\nrun = { exec = "x" }\n');
    const plan = ok(s.cx('plan', { layers: [team], owner: 'tool', mode: 'overlay' }));
    assert.ok(plan.launch_only.some((x) => x.item === 'hook.s' && /hooks\.state/.test(x.via)));
    const { refused } = launch(s, team);
    assert.equal(refused.error.items[0].risks[0].blocks, true);
    const start = layer(s.root, 'start', '[hook.s]\nevent = "SessionStart"\nrun = { exec = "x" }\n');
    assert.equal(s.cx('launch-spec', { layers: [start] }).error.items[0].risks[0].blocks, false);
  } finally {
    s.done();
  }
});

test('the Codex shim: classes, a patch\'s paths, blocks that always carry a reason, context only where Codex takes it, no bare allow', () => {
  assert.deepEqual(['Bash', 'apply_patch', 'mcp__db__query', 'Read'].map(toolClass), ['shell', 'edit', 'mcp:db', null]);
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: b.txt\n+b\n*** Delete File: c.txt\n*** End Patch\n';
  assert.deepEqual(envelope('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: patch } }).hs.tool, { class: 'edit', name: 'apply_patch', input: { paths: ['src/a.js', 'b.txt', 'c.txt'] } });
  assert.deepEqual(envelope('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }).hs.tool.input, { command: 'ls' });
  // Exit 2 with an empty or blank stderr lets the call through on Codex: the shim always gives a reason.
  for (const stderr of ['', '  \n']) {
    const t = translate('PreToolUse', { status: 2, stdout: '', stderr });
    assert.equal(t.code, 2);
    assert.ok(t.stderr.trim().length > 0);
  }
  // A crash, a signal, a stall: closed on the gating events.
  assert.equal(translate('PreToolUse', { status: 1, stdout: '', stderr: '' }).code, 2);
  assert.equal(translate('PermissionRequest', { status: null, signal: 'SIGSEGV', stdout: '' }).code, 2, 'exit 2 denies a PermissionRequest on Codex');
  assert.equal(translate('UserPromptSubmit', { status: 0, timedOut: true, stdout: '' }).code, 2);
  assert.deepEqual(translate('PermissionRequest', { status: 0, stdout: '{"decision":"deny","reason":"no"}' }), { code: 2, stdout: '', stderr: 'no' });
  // allow is never emitted: Codex would take a bare allow as a failed hook.
  assert.deepEqual(translate('PreToolUse', { status: 0, stdout: '{"decision":"allow"}', stderr: '' }), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(JSON.parse(translate('SessionStart', { status: 0, stdout: '{"context":"c"}' }).stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'c' } });
  assert.equal(translate('PermissionRequest', { status: 0, stdout: '{"context":"c"}' }).stdout, '', 'PermissionRequest has no additionalContext on Codex');
});

test('the Codex shim end to end: a process that exits 2 silently still blocks with a reason', () => {
  const s = box();
  try {
    const proc = write(s.root, 'quiet.sh', '#!/bin/sh\ncat >/dev/null\nexit 2\n');
    fs.chmodSync(proc, 0o755);
    const r = spawnSync(process.execPath, [SHIM, 'PreToolUse', '--timeout', '5', '--', proc], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }), encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.trim().length > 0);
    const gone = spawnSync(process.execPath, [SHIM, 'PreToolUse', '--', path.join(s.root, 'missing')], { input: '{}', encoding: 'utf8' });
    assert.equal(gone.status, 2);
    assert.match(gone.stderr, /failing closed/);
  } finally {
    s.done();
  }
});

test('the Codex shim: on a gating event, output that looks like JSON and is not one object blocks (Codex would let the call through)', () => {
  for (const stdout of ['{"decision":"deny",}', '[1]', '  {"decision": "deny"} trailing', '[info] done']) {
    const t = translate('PreToolUse', { status: 0, stdout, stderr: '' });
    assert.equal(t.code, 2, stdout);
    assert.match(t.stderr, /looks like JSON/);
  }
  assert.deepEqual(translate('PreToolUse', { status: 0, stdout: 'checked: fine\n', stderr: '' }), { code: 0, stdout: 'checked: fine\n', stderr: '' }, 'plain text passes');
  assert.equal(translate('PreToolUse', { status: 0, stdout: '{"other": 1}', stderr: '' }).code, 0, 'one JSON object with no decision continues');
  assert.equal(translate('SessionStart', { status: 0, stdout: '{"bad":', stderr: '' }).code, 0, 'not a gating event');
  // Claude Code's behaviour is unchanged.
  assert.equal(ccTranslate('PreToolUse', { status: 0, stdout: '{"decision":"deny",}', stderr: '' }).code, 0);
});

test('a layer directory holding ${…} never reaches a generated command or path, on Codex and on Claude Code', () => {
  const s = box();
  try {
    const dir = '${tool_name}';
    const hook = layer(s.root, dir, '[hook.g]\nevent = "PreToolUse"\nrun = { exec = "guard.sh" }\n', { 'guard.sh': '#!/bin/sh\n' });
    assert.ok(hook.includes('${tool_name}'));
    for (const harness of ['codex', 'claude-code']) {
      const args = harness === 'codex' ? { harness, harness_path: s.codex, bin: s.codexBin, layers: [hook] } : { harness, harness_path: s.folder, layers: [hook] };
      const res = handle({ protocol: PROTOCOL, op: 'launch-spec', args }, { ...s.opts, host: linuxHost });
      assert.deepEqual([res.error?.code, res.error?.items], ['interpolation_refused', ['hook.g']], harness);
    }
    const mcp = layer(s.root, '${HOME}x', '[mcp.m]\nexec = "node"\nargs = ["server.mjs"]\n', { 'server.mjs': '\n' });
    assert.equal(s.cx('launch-spec', { layers: [mcp] }).error?.code, 'interpolation_refused', 'an MCP server\'s layer path too');
    // A bare command found on PATH is not in the layer, so the layer's name does not matter.
    const bare = layer(s.root, '${x}bare', '[hook.b]\nevent = "Stop"\nrun = { exec = "true" }\n');
    assert.equal(s.cx('launch-spec', { layers: [bare] }).error?.code, 'receipt_required');
  } finally {
    s.done();
  }
});
