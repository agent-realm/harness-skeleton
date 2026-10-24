import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostFromMachineId, machineIdOk, readMachineId, randomHostFile, readOrCreateRandomHost, host, hostLabel } from '../src/host.js';

// Expected values computed outside Node, with `printf '%s' '<salt><id>' | shasum -a 256 | cut -c1-32`.
// The same two vectors as harness-skeleton's test/host.test.js, so the two agree until hs imports
// this module.
test('host: sha256 of the salt and the machine id, first 32 hex digits', () => {
  assert.equal(hostFromMachineId('12345678-ABCD-4EF0-9876-0123456789AB'), '8eccd832b69f22c3fb68fe834980f48f');
  assert.equal(hostFromMachineId('0123456789abcdef0123456789abcdef'), 'd1073ef8de4b1a552a089f5890c636a2');
});

test('host: the case of a macOS or Windows id is kept as stored', () => {
  assert.notEqual(hostFromMachineId('12345678-ABCD-4EF0-9876-0123456789AB'), hostFromMachineId('12345678-abcd-4ef0-9876-0123456789ab'));
});

test('machine id form: Linux 32 lowercase hex; macOS and Windows a UUID; never empty or uninitialized', () => {
  assert.equal(machineIdOk('0123456789abcdef0123456789abcdef', 'linux'), true);
  for (const bad of ['', 'uninitialized', '0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef', '12345678-abcd-4ef0-9876-0123456789ab']) {
    assert.equal(machineIdOk(bad, 'linux'), false, bad);
  }
  assert.equal(machineIdOk('12345678-ABCD-4EF0-9876-0123456789AB', 'darwin'), true);
  assert.equal(machineIdOk('12345678-abcd-4ef0-9876-0123456789ab', 'win32'), true);
  assert.equal(machineIdOk('{12345678-abcd-4ef0-9876-0123456789ab}', 'win32'), false);
});

test('machine id, Linux: /etc/machine-id, trimmed', () => {
  const files = { '/etc/machine-id': '0123456789abcdef0123456789abcdef\n' };
  assert.equal(readMachineId({ platform: 'linux', readFile: (f) => files[f] ?? null }), '0123456789abcdef0123456789abcdef');
});

test('machine id, Linux: the D-Bus copy is never read, even when /etc/machine-id is empty', () => {
  const dbus = '/var/lib/dbus/machine-id';
  const read = [];
  for (const bad of ['', '\n', 'uninitialized\n', '0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef', null]) {
    const files = { '/etc/machine-id': bad, [dbus]: 'fedcba9876543210fedcba9876543210\n' };
    const readFile = (f) => { read.push(f); return files[f] ?? null; };
    assert.equal(readMachineId({ platform: 'linux', readFile }), null, JSON.stringify(bad));
  }
  assert.ok(!read.includes(dbus));
});

test('machine id, macOS: the quoted IOPlatformUUID from ioreg, without its quotes', () => {
  const out = '+-o Mac  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformSerialNumber" = "X"\n      "IOPlatformUUID" = "12345678-ABCD-4EF0-9876-0123456789AB"\n    }\n';
  assert.equal(readMachineId({ platform: 'darwin', ioreg: () => out }), '12345678-ABCD-4EF0-9876-0123456789AB');
  assert.equal(readMachineId({ platform: 'darwin', ioreg: () => '"IOPlatformUUID" = "not-a-uuid"' }), null);
  assert.equal(readMachineId({ platform: 'darwin', ioreg: () => null }), null);
});

test('machine id, Windows: MachineGuid as stored, no braces', () => {
  const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    12345678-abcd-4ef0-9876-0123456789ab\r\n\r\n';
  assert.equal(readMachineId({ platform: 'win32', reg: () => out }), '12345678-abcd-4ef0-9876-0123456789ab');
  assert.equal(readMachineId({ platform: 'win32', reg: () => null }), null);
});

test('r- file: XDG_STATE_HOME when absolute, else ~/.local/state; %LOCALAPPDATA% on Windows', () => {
  assert.equal(randomHostFile({ platform: 'linux', env: { XDG_STATE_HOME: '/s', HOME: '/h' } }), '/s/sessions-model/host-id');
  assert.equal(randomHostFile({ platform: 'linux', env: { XDG_STATE_HOME: 'rel', HOME: '/h' } }), '/h/.local/state/sessions-model/host-id');
  assert.equal(randomHostFile({ platform: 'darwin', env: { HOME: '/h' } }), '/h/.local/state/sessions-model/host-id');
  assert.equal(randomHostFile({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } }), 'C:\\Users\\u\\AppData\\Local\\sessions-model\\host-id');
  assert.equal(randomHostFile({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\u' } }), 'C:\\Users\\u\\AppData\\Local\\sessions-model\\host-id');
});

test('r- fallback: created once, mode 600, then read back the same', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-host-'));
  try {
    const file = path.join(dir, 'sessions-model', 'host-id');
    const first = readOrCreateRandomHost(file);
    assert.match(first, /^r-[0-9a-f]{32}$/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), first.slice(2));
    assert.equal(readOrCreateRandomHost(file), first);
    const env = { XDG_STATE_HOME: dir, HOME: dir };
    assert.deepEqual(host({ platform: 'linux', readFile: () => null, env }), { host: first, source: 'random' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r- fallback: a stored value in the wrong form is refused, never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-host-'));
  try {
    const file = path.join(dir, 'host-id');
    fs.writeFileSync(file, 'garbage\n');
    assert.throws(() => readOrCreateRandomHost(file), { code: 'host_unreadable' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'garbage\n');
    const empty = path.join(dir, 'empty');
    fs.writeFileSync(empty, '');
    assert.throws(() => readOrCreateRandomHost(empty), { code: 'host_unreadable', message: /32 lowercase hex/ });
    assert.equal(fs.readFileSync(empty, 'utf8'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r- fallback: a directory, a blocked parent, an unreadable file: host_unreadable', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-host-'));
  try {
    const asDir = path.join(dir, 'a', 'host-id');
    fs.mkdirSync(asDir, { recursive: true });
    assert.throws(() => readOrCreateRandomHost(asDir), { code: 'host_unreadable', message: /EISDIR/ });

    fs.writeFileSync(path.join(dir, 'c-file'), '');
    assert.throws(() => readOrCreateRandomHost(path.join(dir, 'c-file', 'host-id')), { code: 'host_unreadable' });

    if (process.getuid?.() === 0) {
      t.diagnostic('running as root: the unreadable-file case is skipped');
      return;
    }
    const locked = path.join(dir, 'b', 'host-id');
    fs.mkdirSync(path.dirname(locked));
    fs.writeFileSync(locked, '0123456789abcdef0123456789abcdef\n', { mode: 0o000 });
    assert.throws(() => readOrCreateRandomHost(locked), { code: 'host_unreadable', message: /EACCES/ });
    fs.chmodSync(locked, 0o600);
    assert.equal(fs.readFileSync(locked, 'utf8'), '0123456789abcdef0123456789abcdef\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r- fallback: created by link, so no temp file and no partial host-id is left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-host-'));
  try {
    const file = path.join(dir, 'sessions-model', 'host-id');
    readOrCreateRandomHost(file);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['host-id']);
    assert.equal(fs.statSync(file).nlink, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('host: derived from the machine id when one is readable', () => {
  const files = { '/etc/machine-id': '0123456789abcdef0123456789abcdef\n' };
  assert.deepEqual(host({ platform: 'linux', readFile: (f) => files[f] ?? null }), { host: 'd1073ef8de4b1a552a089f5890c636a2', source: 'machine-id' });
});

test('host: a platform outside macOS, Linux and Windows is refused, never given an r- value', () => {
  assert.throws(() => host({ platform: 'freebsd', env: { HOME: '/nonexistent' } }), { code: 'platform_unsupported' });
});

test('host label: the short hostname, never part of a key', () => {
  assert.equal(hostLabel('macbook.local'), 'macbook');
  assert.equal(hostLabel('build-01.example.org'), 'build-01');
  assert.equal(hostLabel(''), 'host');
});

// sessions-model, Conformance, Known-answer vectors.
test('host: the known answers', () => {
  const linux = (content) => host({ platform: 'linux', readFile: (f) => (f === '/etc/machine-id' ? content : '0f1e2d3c4b5a69788796a5b4c3d2e1f0\n'), env: { XDG_STATE_HOME: '/nonexistent-sa', HOME: '/nonexistent-sa' } });
  assert.equal(host({ platform: 'darwin', ioreg: () => '"IOPlatformUUID" = "8F3A1C2E-5B7D-4E9F-A1B2-C3D4E5F60718"' }).host, 'a9c0e0812394b435f67384b7335eb4ec');
  assert.equal(linux('0f1e2d3c4b5a69788796a5b4c3d2e1f0\n').host, '0d0d3eefb2fba3434590abdc952a7ef7');
  assert.equal(host({ platform: 'win32', reg: () => '    MachineGuid    REG_SZ    3d6f8a2c-9b1e-4c7d-8e5f-0a1b2c3d4e5f\r\n' }).host, '7887e6927739c4faced8534b18da80a4');
  // No derived host: each falls to the r- value, which cannot be created under /nonexistent-sa.
  for (const bad of ['', 'uninitialized\n', '0f1e2d3c4b5a69788796a5b4c3d2e1f\n']) {
    assert.throws(() => linux(bad), { code: 'host_unreadable' }, JSON.stringify(bad));
  }
  // The two known mistakes are never produced.
  assert.notEqual(hostFromMachineId('8F3A1C2E-5B7D-4E9F-A1B2-C3D4E5F60718'), '9bd6f0009abf4eb43b4bb380a9337e91');
  assert.notEqual(linux('0f1e2d3c4b5a69788796a5b4c3d2e1f0\n').host, '306d491e299c0cafad3f50eda755590e');
});
