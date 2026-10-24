// sessions-model's known-answer vectors for `host` and `harness_path` (contracts/sessions-model.md,
// "Known-answer vectors", in agent-realm/sessions-model), so memhouse, hs and the session-adapters
// package agree byte for byte. The machine ids are synthetic. hs now takes
// both from the package; these run through hs's own entry points, as a consumer sees them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostFromMachineId, hostId } from '../src/host.js';
import { readMachineId } from '@agent-realm/session-adapters/host';
import { harnessPath } from '../src/harness-path.js';

test('host: the known answers', () => {
  const ioreg = (id) => () => `+-o Mac  <class IOPlatformExpertDevice>\n  {\n    "IOPlatformUUID" = "${id}"\n  }\n`;
  const mac = readMachineId({ platform: 'darwin', ioreg: ioreg('8F3A1C2E-5B7D-4E9F-A1B2-C3D4E5F60718') });
  assert.equal(hostFromMachineId(mac), 'a9c0e0812394b435f67384b7335eb4ec');
  const linux = readMachineId({ platform: 'linux', readFile: () => '0f1e2d3c4b5a69788796a5b4c3d2e1f0\n' });
  assert.equal(hostFromMachineId(linux), '0d0d3eefb2fba3434590abdc952a7ef7');
  // hs refuses Windows (design note §2), but the hash itself must agree with the vector
  assert.equal(hostFromMachineId('3d6f8a2c-9b1e-4c7d-8e5f-0a1b2c3d4e5f'), '7887e6927739c4faced8534b18da80a4');
  assert.throws(() => hostId({ platform: 'win32' }), { code: 'platform_unsupported' });
});

test('host: the two known wrong answers are never produced', () => {
  const mac = readMachineId({ platform: 'darwin', ioreg: () => '"IOPlatformUUID" = "8F3A1C2E-5B7D-4E9F-A1B2-C3D4E5F60718"' });
  assert.notEqual(hostFromMachineId(mac), '9bd6f0009abf4eb43b4bb380a9337e91', 'no case change');
  const linux = readMachineId({ platform: 'linux', readFile: () => '0f1e2d3c4b5a69788796a5b4c3d2e1f0\n' });
  assert.notEqual(hostFromMachineId(linux), '306d491e299c0cafad3f50eda755590e', 'surrounding whitespace is stripped');
});

test('host: the rows that give the r- value', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ka-'));
  try {
    const env = { XDG_STATE_HOME: state, HOME: state };
    for (const [why, files] of [
      ['empty (zero bytes)', { '/etc/machine-id': '' }],
      ['uninitialized', { '/etc/machine-id': 'uninitialized\n' }],
      ['31 hex digits', { '/etc/machine-id': '0f1e2d3c4b5a69788796a5b4c3d2e1f\n' }],
      ['empty, with a valid D-Bus id', { '/etc/machine-id': '', '/var/lib/dbus/machine-id': '0f1e2d3c4b5a69788796a5b4c3d2e1f0\n' }],
    ]) {
      const r = hostId({ platform: 'linux', readFile: (f) => files[f] ?? null, env });
      assert.match(r.host, /^r-[0-9a-f]{32}$/, why);
      assert.equal(r.source, 'random', why);
    }
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('harness_path: the known answers', (t) => {
  const f = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ka-')));
  try {
    fs.mkdirSync(path.join(f, 'real', 'Claude-Home'), { recursive: true });
    const want = path.join(f, 'real', 'Claude-Home');
    fs.symlinkSync(want, path.join(f, 'link'));
    assert.equal(harnessPath(path.join(f, 'link')), want, 'a symlink resolves');
    assert.equal(harnessPath(want + '/'), want, 'no trailing slash');
    assert.equal(harnessPath(path.join(f, 'real') + '/./Claude-Home'), want, 'no ./ segment');

    if (process.platform === 'darwin' && fs.lstatSync('/tmp').isSymbolicLink()) {
      const viaTmp = fs.mkdtempSync('/tmp/hs-ka-');
      try {
        assert.equal(harnessPath(viaTmp), path.join('/private', viaTmp), '/tmp resolves to /private/tmp');
      } finally {
        fs.rmSync(viaTmp, { recursive: true, force: true });
      }
    }

    const caseInsensitive = fs.existsSync(path.join(f, 'real', 'claude-home'));
    if (caseInsensitive) {
      assert.equal(harnessPath(path.join(f, 'real', 'claude-home')), want, 'the on-disk case');
    } else {
      // the row the contract says is owed a Linux run: no case folding
      fs.mkdirSync(path.join(f, 'a', '.claude'), { recursive: true });
      fs.mkdirSync(path.join(f, 'a', '.Claude'));
      const lower = harnessPath(path.join(f, 'a', '.claude'));
      const upper = harnessPath(path.join(f, 'a', '.Claude'));
      assert.equal(lower, path.join(f, 'a', '.claude'));
      assert.equal(upper, path.join(f, 'a', '.Claude'));
      assert.notEqual(lower, upper, 'two values, unchanged');
      t.diagnostic('case-sensitive volume: ran the .claude / .Claude row');
    }
  } finally {
    fs.rmSync(f, { recursive: true, force: true });
  }
});
