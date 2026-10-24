// hs takes `host` from the session adapters package. The package tests
// the rule itself (its test/host.test.js: the forms, the r- file, no D-Bus read); hs tests what it
// adds: macOS and Linux only, and the package's errors mapped onto the envelope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_PLATFORMS, hostFromMachineId, hostId } from '../src/host.js';
import { HsError } from '../src/protocol.js';

test('host: hs covers macOS and Linux; Windows is refused before the package is asked', () => {
  assert.deepEqual([...HOST_PLATFORMS], ['darwin', 'linux']);
  assert.throws(() => hostId({ platform: 'win32' }), (e) => e instanceof HsError && e.code === 'platform_unsupported');
});

test('host: a machine id gives the package\'s value; none gives r-; an unreadable r- file is an HsError', () => {
  assert.deepEqual(hostId({ platform: 'linux', readFile: () => '0123456789abcdef0123456789abcdef\n' }),
    { host: hostFromMachineId('0123456789abcdef0123456789abcdef'), source: 'machine-id' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-host-'));
  try {
    const env = { XDG_STATE_HOME: dir, HOME: dir };
    const r = hostId({ platform: 'linux', readFile: () => null, env });
    assert.match(r.host, /^r-[0-9a-f]{32}$/);
    assert.equal(r.source, 'random');
    fs.rmSync(path.join(dir, 'sessions-model', 'host-id'));
    fs.mkdirSync(path.join(dir, 'sessions-model', 'host-id'));
    assert.throws(() => hostId({ platform: 'linux', readFile: () => null, env }), (e) => e instanceof HsError && e.code === 'host_unreadable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
