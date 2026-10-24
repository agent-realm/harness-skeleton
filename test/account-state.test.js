// Milestone 6a.2: endpoint hygiene (design note §5.2, §7.2). A plan for a spec with an endpoint
// clears the cached claude.ai account state in .claude.json, a one-way state write: allowed only
// by the receipt, journaled without values, kept out of the ledger, never restored by remove.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { handlers } from '../src/native.js';
import ccDriver from '../src/drivers/claude-code/index.js';
import { spawnSync } from 'node:child_process';
import { LOOKUP_MS, SECURITY, keychainItem } from '../src/drivers/claude-code/login.js';
import { layer, write } from './fixtures.js';
import { ok, receiptFor, sandbox } from './sandbox.js';

const MARK = 'acct-MARKER-0000';
const ENDPOINT = '[endpoints.anthropic-messages]\nbase_url = "https://gateway.example/api"\ncredential = "env:GATEWAY_KEY"\n';
const claudeJson = (folder) => JSON.parse(fs.readFileSync(path.join(folder, '.claude.json'), 'utf8'));
// Every file hs keeps about itself, as one string.
function records(folder) {
  const dir = path.join(folder, '.harness-skeleton');
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}
function plant(folder) {
  fs.rmSync(path.join(folder, '.credentials.json'), { force: true });
  write(folder, '.claude.json', JSON.stringify({
    userID: 'kept', projects: { '/w': { allowedTools: [] } },
    oauthAccount: { accountUuid: MARK, emailAddress: `${MARK}@example.invalid` }, cachedGrowthBookFeatures: { flag: MARK },
  }));
}

test('a plan with an endpoint clears the cached account state, one way, by key, with no value anywhere', () => {
  const s = sandbox();
  try {
    plant(s.folder);
    const team = layer(s.root, 'empty', '');
    const local = write(s.root, 'local.toml', ENDPOINT);
    const plan = ok(s.call('plan', { layers: [team], local, owner: 'tool' }));
    const clears = plan.operations.filter((o) => o.action === 'clear');
    assert.deepEqual(clears.map((o) => o.address_id), ['.claude.json#oauthAccount', '.claude.json#cachedGrowthBookFeatures']);
    for (const o of clears) {
      assert.deepEqual(o.risk, ['clears-state']);
      assert.equal(o.class, 'state');
      assert.ok(!Object.hasOwn(o, 'value') && !Object.hasOwn(o, 'previous'));
    }
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(MARK), 'no value in the plan');

    const denied = s.call('apply', { plan, receipt: receiptFor(plan, []) });
    assert.equal(denied.error.code, 'receipt_required', 'a state write needs the receipt');
    assert.ok(claudeJson(s.folder).oauthAccount);

    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.deepEqual(claudeJson(s.folder), { userID: 'kept', projects: { '/w': { allowedTools: [] } } }, 'only the account state goes');
    const kept = records(s.folder);
    assert.doesNotMatch(kept, new RegExp(MARK), 'no value in the journal, the ledger or the stored plan');
    assert.match(kept, /"before":\{"present":true\}/);
    assert.doesNotMatch(kept, /"address_id":".claude.json#|".claude.json#oauthAccount":/, 'no ledger entry');

    assert.equal(ok(s.call('plan', { layers: [team], local, owner: 'tool' })).unchanged, true);
    ok(s.call('remove', { owner: 'tool' }));
    assert.ok(!Object.hasOwn(claudeJson(s.folder), 'oauthAccount'), 'remove restores nothing');
  } finally {
    s.done();
  }
});

test('no endpoint, no clear; overlay with no_persist_state leaves it and says so', () => {
  const s = sandbox();
  try {
    plant(s.folder);
    const team = layer(s.root, 'empty', '');
    let plan = ok(s.call('plan', { layers: [team], owner: 'tool' }));
    assert.ok(!plan.operations.some((o) => o.action === 'clear'));
    plan = ok(s.call('plan', { layers: [team], local: write(s.root, 'local.toml', ENDPOINT), owner: 'tool', mode: 'overlay', no_persist_state: true }));
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.skipped.filter((x) => /left in place/.test(x.reason)).length, 2);
  } finally {
    s.done();
  }
});

test('launch-spec names the cached account state an endpoint launch would start with, by key', () => {
  const s = sandbox();
  try {
    plant(s.folder);
    const team = layer(s.root, 'empty', '');
    const local = write(s.root, 'local.toml', ENDPOINT);
    const spec = ok(s.call('launch-spec', { layers: [team], local }));
    const note = spec.notes.find((n) => /account state/.test(n));
    assert.match(note, /oauthAccount, cachedGrowthBookFeatures/);
    assert.doesNotMatch(JSON.stringify(spec), new RegExp(MARK));
    fs.rmSync(spec.temp_dir, { recursive: true });
    write(s.folder, '.claude.json', '{"userID": "kept"}');
    const clean = ok(s.call('launch-spec', { layers: [team], local }));
    assert.ok(!clean.notes.some((n) => /account state/.test(n)));
    fs.rmSync(clean.temp_dir, { recursive: true });
  } finally {
    s.done();
  }
});

test('the floor: .claude.json is clear-only, and only for the account state keys', () => {
  const s = sandbox();
  try {
    plant(s.folder);
    const D = ccDriver.descriptor;
    const w = (key, value) => handlers['json-key'].write(s.folder, D, { file: '.claude.json', key }, value);
    assert.throws(() => w('oauthAccount', { accountUuid: 'x' }), { code: 'write_refused' }, 'never set');
    assert.throws(() => w('userID', undefined), { code: 'write_refused' }, 'not an account state key');
    assert.throws(() => w('projects', undefined), { code: 'write_refused' });
    w('oauthAccount', undefined);
    assert.ok(!Object.hasOwn(claudeJson(s.folder), 'oauthAccount'));
  } finally {
    s.done();
  }
});

test('recover finishes the clears a crash interrupted, and sweeps the staged copy it left', () => {
  const s = sandbox();
  try {
    plant(s.folder);
    const team = layer(s.root, 'empty', '');
    const plan = ok(s.call('plan', { layers: [team], local: write(s.root, 'local.toml', ENDPOINT), owner: 'tool' }));
    const first = plan.operations.findIndex((o) => o.action === 'clear');
    const crashed = handle({ protocol: PROTOCOL, op: 'apply', args: { harness: 'claude-code', harness_path: s.folder, bin: s.bin, plan, receipt: receiptFor(plan) } }, { ...s.opts, crashAfter: first });
    assert.equal(crashed.ok, false);
    assert.ok(Object.hasOwn(claudeJson(s.folder), 'oauthAccount'), 'the crash came before the clears');
    // A copy a hard crash left mid-write, as atomicWrite stages it.
    write(path.join(s.folder, '.harness-skeleton', 'tmp'), 'stage..claude.json.4242.deadbeef', JSON.stringify({ oauthAccount: { accountUuid: MARK } }));
    const r = ok(s.call('recover', {}));
    assert.equal(r.recovered.length, 1);
    assert.equal(r.staged_copies_removed, 1);
    const left = claudeJson(s.folder);
    assert.ok(!Object.hasOwn(left, 'oauthAccount') && !Object.hasOwn(left, 'cachedGrowthBookFeatures'));
    assert.doesNotMatch(records(s.folder), new RegExp(MARK));
  } finally {
    s.done();
  }
});

test('the clears of one file are one write: no staged copy holds a value due for deletion, and none outlives a failed rename', () => {
  const s = sandbox();
  const rename = fs.renameSync;
  try {
    plant(s.folder);
    const team = layer(s.root, 'empty', '');
    const plan = ok(s.call('plan', { layers: [team], local: write(s.root, 'local.toml', ENDPOINT), owner: 'tool' }));
    const staged = [];
    fs.renameSync = (from, to) => {
      if (to.endsWith('.claude.json') && staged.length === 0) {
        staged.push(fs.readFileSync(from, 'utf8'));
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      return rename(from, to);
    };
    assert.equal(s.call('apply', { plan, receipt: receiptFor(plan) }).ok, false);
    fs.renameSync = rename;
    assert.equal(staged.length, 1);
    assert.doesNotMatch(staged[0], new RegExp(MARK), 'the staged copy held none of the cleared values');
    assert.deepEqual(fs.readdirSync(path.join(s.folder, '.harness-skeleton', 'tmp')).filter((f) => f.startsWith('stage.')), [], 'no staged copy left');
    ok(s.call('recover', {}));
    assert.ok(!Object.hasOwn(claudeJson(s.folder), 'oauthAccount'));
    assert.doesNotMatch(records(s.folder), new RegExp(MARK));
  } finally {
    fs.renameSync = rename;
    s.done();
  }
});

// ---- a folder still logged in (§5.2, §7.5): refused, never cleared ---------------------------

const darwin = { platform: 'darwin', ioreg: () => '"IOPlatformUUID" = "8F3A1C2E-5B7D-4E9F-A1B2-C3D4E5F60718"' };
const service = (p) => `Claude Code-credentials-${crypto.createHash('sha256').update(p).digest('hex').slice(0, 8)}`;
// Calls on a given host with a stubbed keychain lookup, recording every service name it is asked.
function on(s, host, answer, harnessPath = s.folder) {
  const asked = [];
  const opts = { ...s.opts, host, keychain: (svc) => {
    asked.push(svc);
    return answer(svc);
  } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'claude-code', harness_path: harnessPath, bin: s.bin, ...args } }, opts);
  return { call, asked };
}

test('macOS: a keychain item for the folder, under either spelling, is a login; plan and launch-spec refuse', () => {
  const s = sandbox();
  try {
    plant(s.folder);
    const alias = path.join(s.root, 'alias');
    fs.symlinkSync(s.folder, alias);
    const team = layer(s.root, 'empty', '');
    const local = write(s.root, 'local.toml', ENDPOINT);
    const m = on(s, darwin, (svc) => (svc === service(alias) ? 'present' : 'absent'), alias);
    const planned = m.call('plan', { layers: [team], local, owner: 'tool' });
    assert.equal(planned.error.code, 'login_present');
    assert.match(JSON.stringify(planned.error), new RegExp(service(alias)));
    assert.deepEqual([...new Set(m.asked)].sort(), [service(alias), service(s.folder)].sort(), 'the given spelling and the real one');
    const launched = m.call('launch-spec', { layers: [team], local });
    assert.equal(launched.error.code, 'login_present');
    assert.ok(Object.hasOwn(claudeJson(s.folder), 'oauthAccount'), 'nothing cleared');
    // A grant with no oauthAccount left is refused too.
    write(s.folder, '.claude.json', '{"userID": "kept"}');
    assert.equal(m.call('launch-spec', { layers: [team], local }).error.code, 'login_present');
  } finally {
    s.done();
  }
});

test('macOS: no item under either spelling; the clear goes ahead, oauthAccount included, and apply re-derives the same plan', () => {
  const s = sandbox();
  try {
    plant(s.folder);
    const alias = path.join(s.root, 'alias');
    fs.symlinkSync(s.folder, alias);
    const team = layer(s.root, 'empty', '');
    const local = write(s.root, 'local.toml', ENDPOINT);
    const m = on(s, darwin, () => 'absent', alias);
    const plan = ok(m.call('plan', { layers: [team], local, owner: 'tool' }));
    assert.deepEqual(plan.operations.filter((o) => o.action === 'clear').map((o) => o.address.key), ['oauthAccount', 'cachedGrowthBookFeatures']);
    assert.ok(plan.unverified.some((u) => /another spelling cannot be ruled out/.test(u)));
    ok(m.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.ok(!Object.hasOwn(claudeJson(s.folder), 'oauthAccount'));
    const spec = ok(m.call('launch-spec', { layers: [team], local }));
    assert.ok(spec.unverified.some((u) => /another spelling cannot be ruled out/.test(u)));
    fs.rmSync(spec.temp_dir, { recursive: true });
  } finally {
    s.done();
  }
});

test('macOS: the keychain cannot be asked; oauthAccount counts as a login, and without it only unverified', () => {
  const s = sandbox();
  try {
    plant(s.folder);
    const team = layer(s.root, 'empty', '');
    const local = write(s.root, 'local.toml', ENDPOINT);
    const m = on(s, darwin, () => 'unknown');
    const res = m.call('plan', { layers: [team], local, owner: 'tool' });
    assert.equal(res.error.code, 'login_present');
    assert.match(JSON.stringify(res.error.items), /oauthAccount/);
    write(s.folder, '.claude.json', JSON.stringify({ cachedGrowthBookFeatures: { flag: 1 } }));
    const plan = ok(m.call('plan', { layers: [team], local, owner: 'tool' }));
    assert.deepEqual(plan.operations.filter((o) => o.action === 'clear').map((o) => o.address.key), ['cachedGrowthBookFeatures'], 'the feature flags go on their own');
    assert.ok(plan.unverified.some((u) => /did not answer/.test(u) && /may be locked/.test(u)));
  } finally {
    s.done();
  }
});

test('macOS: the default folder is also asked under the unsuffixed name', () => {
  const s = sandbox('2.1.307', { defaultFolder: true });
  try {
    fs.rmSync(path.join(s.folder, '.credentials.json'), { force: true });
    const m = on(s, darwin, () => 'absent');
    ok(m.call('plan', { layers: [layer(s.root, 'empty', '')], local: write(s.root, 'local.toml', ENDPOINT), owner: 'tool' }));
    assert.ok(m.asked.includes('Claude Code-credentials'));
  } finally {
    s.done();
  }
});

test('Linux: .credentials.json is the whole store; it refuses, oauthAccount alone is a stale cache, the keychain is never asked', () => {
  const s = sandbox();
  try {
    const team = layer(s.root, 'empty', '');
    const local = write(s.root, 'local.toml', ENDPOINT);
    const m = on(s, s.opts.host, () => 'present');
    assert.equal(m.call('plan', { layers: [team], local, owner: 'tool' }).error.code, 'login_present', 'the fixture holds .credentials.json');
    plant(s.folder);
    const plan = ok(m.call('plan', { layers: [team], local, owner: 'tool' }));
    assert.ok(plan.operations.some((o) => o.address_id === '.claude.json#oauthAccount'));
    assert.deepEqual(m.asked, []);
  } finally {
    s.done();
  }
});

test('the lookup: /usr/bin/security by absolute path, attributes only, output discarded, a short limit; each answer mapped', () => {
  const calls = [];
  const fake = (result) => (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  assert.deepEqual(keychainItem('svc', fake({ status: 0 })), { state: 'present' });
  assert.deepEqual(keychainItem('svc', fake({ status: 44 })), { state: 'absent' });
  assert.deepEqual(keychainItem('svc', fake({ status: 51 })), { state: 'unknown', why: 'exit 51' });
  assert.deepEqual(keychainItem('svc', fake({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } })), { state: 'unknown', why: 'timeout' });
  assert.deepEqual(keychainItem('svc', fake({ status: null, error: { code: 'ENOENT' } })), { state: 'unknown', why: 'ENOENT' });
  assert.equal(SECURITY, '/usr/bin/security');
  for (const c of calls) {
    assert.equal(c.cmd, '/usr/bin/security', 'never resolved through PATH');
    assert.deepEqual(c.args, ['find-generic-password', '-s', 'svc'], 'no -w, no -g: attributes only');
    assert.equal(c.opts.stdio, 'ignore');
    assert.ok(c.opts.timeout > 0 && c.opts.timeout <= 5000);
    assert.equal(c.opts.killSignal, 'SIGKILL', 'a SIGTERM the child ignores would let it overrun the limit');
  }
  assert.equal(LOOKUP_MS, 5000);
});

test('the lookup\'s limit holds against a child that ignores SIGTERM', () => {
  // A harmless local process standing in for a security that does not handle SIGTERM: it ignores
  // the signal (inherited across exec) and would sleep 30 s. Run with keychainItem's own options.
  const stubborn = (cmd, args, opts) => spawnSync('/bin/sh', ['-c', "trap '' TERM; exec sleep 30"], opts);
  const t0 = Date.now();
  assert.deepEqual(keychainItem('svc', stubborn, 300), { state: 'unknown', why: 'timeout' });
  assert.ok(Date.now() - t0 < 3000, `returned after ${Date.now() - t0} ms`);
});

test('macOS: a lookup with no answer in time stops the asking, names the locked case, and with oauthAccount refuses', () => {
  const s = sandbox();
  try {
    plant(s.folder);
    const alias = path.join(s.root, 'alias');
    fs.symlinkSync(s.folder, alias);
    const team = layer(s.root, 'empty', '');
    const local = write(s.root, 'local.toml', ENDPOINT);
    const m = on(s, darwin, () => ({ state: 'unknown', why: 'timeout' }), alias);
    const res = m.call('plan', { layers: [team], local, owner: 'tool' });
    assert.equal(res.error.code, 'login_present');
    assert.match(JSON.stringify(res.error.items), /oauthAccount, with the keychain not answering \(timeout\)/);
    assert.equal(m.asked.length, 1, 'a dialog may be up: no second lookup');
    write(s.folder, '.claude.json', JSON.stringify({ cachedGrowthBookFeatures: { flag: 1 } }));
    const plan = ok(m.call('plan', { layers: [team], local, owner: 'tool' }));
    assert.ok(plan.unverified.some((u) => /may be locked/.test(u) && /unlock dialog/.test(u) && /asked no further names/.test(u)));
  } finally {
    s.done();
  }
});
