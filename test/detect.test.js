import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { rangeStatus } from '../src/version.js';
import { tmpdir, write } from './fixtures.js';

// A stand-in for the claude binary. It records the environment it was given, then prints a
// version. No real harness is started in these tests.
function stub(root, version, record) {
  const file = write(root, 'bin/claude', `#!/bin/sh
env > "${record}"
echo "${version} (Claude Code)"
`);
  fs.chmodSync(file, 0o755);
  return file;
}

function detect(bin) {
  return handle({ protocol: PROTOCOL, op: 'detect', args: { harness: 'claude-code', bin } });
}

test('detect: the binary runs only under a scratch HOME, XDG roots and data folder', () => {
  const root = tmpdir();
  try {
    const record = path.join(root, 'env.txt');
    process.env.HS_TEST_SENTINEL = 'must-not-reach-the-binary';
    let res;
    try {
      res = detect(stub(root, '2.1.307', record));
    } finally {
      delete process.env.HS_TEST_SENTINEL;
    }
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.deepEqual(res.result.version, '2.1.307');
    assert.equal(res.result.range, 'compatible');

    const env = Object.fromEntries(fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const scratch = path.dirname(env.HOME);
    assert.match(path.basename(scratch), /^hs-detect-/);
    for (const v of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR']) {
      assert.ok(env[v].startsWith(scratch + path.sep), `${v}=${env[v]}`);
    }
    assert.equal(env.HS_TEST_SENTINEL, undefined, 'nothing but PATH is inherited');
    assert.equal(fs.existsSync(scratch), false, 'the scratch directory is removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detect: range status, a missing binary, a failing binary', () => {
  const root = tmpdir();
  try {
    assert.equal(detect(stub(root, '2.0.1', path.join(root, 'e'))).result.range, 'outside');
    assert.equal(detect(path.join(root, 'nope')).error.code, 'probe_failed');
    const bad = write(root, 'bin/bad', '#!/bin/sh\nexit 3\n');
    fs.chmodSync(bad, 0o755);
    assert.equal(detect(bad).error.code, 'probe_failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('version ranges: certified, compatible, outside, unknown', () => {
  const ranges = { certified: ['2.1.300'], compatible: { min: '2.1.289', below: '2.2.0' } };
  assert.equal(rangeStatus('2.1.300', ranges), 'certified');
  assert.equal(rangeStatus('2.1.289', ranges), 'compatible');
  assert.equal(rangeStatus('2.1.999', ranges), 'compatible');
  assert.equal(rangeStatus('2.2.0', ranges), 'outside');
  assert.equal(rangeStatus('2.1.288', ranges), 'outside');
  assert.equal(rangeStatus(null, ranges), 'unknown');
});
