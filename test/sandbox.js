// A sandbox for delivery tests: a fake home, a Claude Code data folder, a stub claude binary
// and one layer with one skill. Nothing outside a temp directory is read or written.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { claudeCodeFolder, layer, skillMd, tmpdir, write } from './fixtures.js';

export const linuxHost = { platform: 'linux', readFile: (f) => (f === '/etc/machine-id' ? '0123456789abcdef0123456789abcdef\n' : null) };
export const HOST = 'd1073ef8de4b1a552a089f5890c636a2';

// One sandbox per test: a home, a data folder, a stub claude, a layer with one skill.
export function sandbox(version = '2.1.307', { defaultFolder = false, prefix } = {}) {
  const root = tmpdir(prefix);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  let folder = claudeCodeFolder(root);
  if (defaultFolder) {
    fs.renameSync(folder, path.join(home, '.claude'));
    folder = path.join(home, '.claude');
  }
  const bin = write(root, 'bin/claude', `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  fs.chmodSync(bin, 0o755);
  const team = layer(root, 'team', '', { 'skills/notes/SKILL.md': skillMd('notes', 'Take notes.') });
  const opts = { host: linuxHost, home, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'claude-code', harness_path: folder, bin, ...args } }, opts);
  return { root, home, folder, bin, team, opts, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function ok(res) {
  assert.equal(res.ok, true, JSON.stringify(res.error, null, 2));
  return res.result;
}

export function receiptFor(plan, allows = plan.operations.filter((o) => o.risk.length).map((o) => o.id)) {
  return { format: 'hs-receipt/0.2', plan_digest: plan.digest, allows, by: 'test' };
}

export function planAndApply(s, args, applyArgs = {}) {
  const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder', ...args }));
  const res = ok(s.call('apply', { plan, receipt: receiptFor(plan), ...applyArgs }));
  return { plan, res };
}

export function settings(folder) {
  return JSON.parse(fs.readFileSync(path.join(folder, 'settings.json'), 'utf8'));
}

