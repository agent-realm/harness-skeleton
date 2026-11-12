// The hook shim runs a hook's process in a process group of its own (design note §5.6). At the
// hook's limit it kills the whole group and blocks at once, so nothing the hook started outlives the
// decision: a shell's forked command included. A hook that exits within its limit is not touched.
// The same core serves every driver's shim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from './fixtures.js';

const shim = (name) => fileURLToPath(new URL(`../src/shim/${name}`, import.meta.url));
const SHIMS = [
  ['claude-code.js', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
  ['codex.js', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
  ['opencode.js', { tool: 'shell', input: { command: 'ls' }, sessionID: 'ses_test', directory: '/w' }],
];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid) => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
};
// Waits without blocking the event loop, for a shim this test still feeds through a pipe.
const pidSoon = async (file) => {
  for (let i = 0; i < 100; i++) {
    const t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (/^\d+$/.test(t)) return Number(t);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no pid in ${file}`);
};
const pidIn = (file) => {
  for (let i = 0; i < 50; i++) {
    const t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (/^\d+$/.test(t)) return Number(t);
    spawnSync('/bin/sleep', ['0.02']);
  }
  throw new Error(`no pid in ${file}`);
};

for (const [name, payload] of SHIMS) {
  test(`${name}: a stalled hook whose shell forked a descendant is blocked at its limit, and the descendant is gone`, async () => {
    const root = tmpdir();
    try {
      const pidFile = path.join(root, 'child.pid');
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [shim(name), 'PreToolUse', '--timeout', '1', '--', '/bin/sh', '-c', `sleep 30 & echo $! > '${pidFile}'; wait`], { input: JSON.stringify(payload), encoding: 'utf8' });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /ran past its limit and was stopped; failing closed/);
      assert.ok(Date.now() - t0 < 5000, 'decided at the limit');
      assert.equal(await gone(pidIn(pidFile)), true, 'nothing the hook started outlives the decision');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a hook that exits within its limit is not touched: what it leaves in the background is its own', async () => {
  const root = tmpdir();
  let pid = null;
  try {
    const pidFile = path.join(root, 'bg.pid');
    const r = spawnSync(process.execPath, [shim('claude-code.js'), 'PreToolUse', '--timeout', '5', '--', '/bin/sh', '-c', `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'`], { input: JSON.stringify(SHIMS[0][1]), encoding: 'utf8' });
    assert.equal(r.status, 0);
    pid = pidIn(pidFile);
    assert.equal(alive(pid), true);
  } finally {
    if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a harness that cancels the hook by signalling the shim: the hook\'s group goes too, and the event is blocked', async () => {
  const root = tmpdir();
  try {
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const pidFile = path.join(root, `${sig}.pid`);
      const child = spawn(process.execPath, [shim('claude-code.js'), 'PreToolUse', '--timeout', '30', '--', '/bin/sh', '-c', `sleep 30 & echo $! > '${pidFile}'; wait`], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      const exited = new Promise((r) => child.on('close', (code) => r(code)));
      child.stdin.end(JSON.stringify(SHIMS[0][1]));
      const pid = await pidSoon(pidFile);
      child.kill(sig);
      assert.equal(await exited, 2, sig);
      assert.match(stderr, new RegExp(`the hook was cancelled \\(${sig}\\) and its processes stopped; failing closed`));
      assert.equal(await gone(pid), true, `${sig}: the forked process is gone`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('whatever throws on the way blocks the event with a reason, never exit 1', () => {
  // A payload that is JSON but not an object: reading its fields throws inside the shim.
  for (const [name] of SHIMS) {
    const r = spawnSync(process.execPath, [shim(name), 'PreToolUse', '--', '/usr/bin/true'], { input: 'null', encoding: 'utf8' });
    assert.equal(r.status, 2, name);
    assert.match(r.stderr, /^hs hook shim: .+; failing closed$/);
  }
});
