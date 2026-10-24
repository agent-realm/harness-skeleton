import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { codexFolder, tmpdir, write } from './fixtures.js';

const linuxHost = { platform: 'linux', readFile: (f) => (f === '/etc/machine-id' ? '0123456789abcdef0123456789abcdef\n' : null) };

function observe(folder, state = { managedRoot: null, platform: 'linux' }, home = path.dirname(folder)) {
  const res = handle({ protocol: PROTOCOL, op: 'observe', args: { harness: 'codex', harness_path: folder, state: true } }, { host: linuxHost, state, home });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return res.result;
}

test('codex observe --state: classes, unknown, credentials stat-ed only', () => {
  const root = tmpdir();
  const folder = codexFolder(root);
  const auth = path.join(folder, 'auth.json');
  try {
    fs.chmodSync(auth, 0o000);
    const r = observe(folder);
    assert.deepEqual(r.store, { host: 'd1073ef8de4b1a552a089f5890c636a2', harness: 'codex', harness_path: folder });
    const pats = (c) => r.inventory.classes[c].map((x) => x.pattern).sort();
    assert.deepEqual(pats('sessions'), ['session_index.jsonl', 'sessions', 'state_*.sqlite*']);
    assert.deepEqual(pats('history'), ['history.jsonl', 'memories_*.sqlite*']);
    assert.deepEqual(pats('credentials'), ['auth.json']);
    assert.deepEqual(pats('logs'), ['log', 'logs_*.sqlite*']);
    assert.deepEqual(r.inventory.unknown.items.map((u) => u.path), ['ambient-suggestions']);
    assert.equal(r.inventory.classes.sessions.find((x) => x.pattern === 'state_*.sqlite*').entries, 2);
    assert.doesNotMatch(JSON.stringify(r), /never-read/);
  } finally {
    fs.chmodSync(auth, 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex observe --state: prompt history by the 0.160.0 layer order', () => {
  const root = tmpdir();
  try {
    const folder = codexFolder(root);
    const etc = path.join(root, 'etc-codex');
    const linux = { managedRoot: etc, platform: 'linux' };

    let h = observe(folder).state.prompt_history;
    assert.deepEqual([h.value, h.source, h.native], ['keep', 'default', 'history.persistence']);
    assert.ok(h.unverified.some((u) => /outrank the folder/.test(u)));
    assert.ok(h.unverified.some((u) => /cloud-managed config/.test(u)), 'cloud-managed defaults are named when the folder sets nothing');

    write(etc, 'config.toml', '[history]\npersistence = "none"\n');
    h = observe(folder, linux).state.prompt_history;
    assert.deepEqual([h.value, h.source, h.from], ['none', 'system', path.join(etc, 'config.toml')]);

    write(folder, 'config.toml', '[history]\npersistence = "save-all"\n');
    h = observe(folder, linux).state.prompt_history;
    assert.deepEqual([h.value, h.source], ['keep', 'folder'], 'the folder outranks the system layer');
    assert.ok(!h.unverified.some((u) => /cloud-managed/.test(u)), 'cloud-managed sits below the folder, so it cannot matter here');

    // the legacy managed file outranks the folder and every launch layer
    write(etc, 'managed_config.toml', '[history]\npersistence = "none"\nmax_bytes = 1000\n');
    h = observe(folder, linux).state.prompt_history;
    assert.deepEqual([h.value, h.source, h.from, h.max_bytes], ['none', 'managed', path.join(etc, 'managed_config.toml'), 1000]);
    assert.deepEqual(h.unverified, [], 'managed holds for every launch, and Linux has no MDM domain');

    fs.rmSync(path.join(etc, 'managed_config.toml'));
    write(folder, 'config.toml', '[history]\npersistence = "sometimes"\n');
    h = observe(folder, linux).state.prompt_history;
    assert.deepEqual([h.valid, h.source], [false, 'folder']);

    const r = observe(folder).state;
    assert.deepEqual([r.retention_days.value, r.retention_days.expressible], [null, false]);
    assert.ok(observe(folder, { managedRoot: null, platform: 'darwin' }).state.prompt_history.unverified.some((u) => /MDM domain com\.openai\.codex/.test(u)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex observe --state: sqlite_home and log_dir are reported as escapes; bad TOML has no excerpt', () => {
  const root = tmpdir();
  try {
    const folder = codexFolder(root);
    write(folder, 'config.toml', 'sqlite_home = "/var/codex-db"\nlog_dir = "/var/log/codex"\n');
    let esc = observe(folder).escapes;
    assert.deepEqual(esc.filter((e) => /moved by/.test(e.note)).map((e) => [e.path, e.class, e.set_by.source]),
      [['/var/codex-db', 'sessions', 'folder'], ['/var/log/codex', 'logs', 'folder']]);

    // set only by the system layer: still an escape
    const etc = path.join(root, 'etc-codex');
    write(etc, 'config.toml', 'sqlite_home = "/srv/codex-db"\n');
    write(folder, 'config.toml', 'model = "x"\n');
    esc = observe(folder, { managedRoot: etc, platform: 'linux' }).escapes;
    assert.deepEqual(esc.filter((e) => /moved by/.test(e.note)).map((e) => [e.path, e.set_by.source]), [['/srv/codex-db', 'system']]);

    write(folder, 'config.toml', 'api_key = TOP_SECRET_VALUE\n');
    const r = observe(folder);
    assert.match(r.errors[0], /not TOML \(line 1/);
    assert.doesNotMatch(JSON.stringify(r), /TOP_SECRET/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex observe --state: a config.toml link to a credential store is refused', () => {
  const root = tmpdir();
  try {
    const folder = codexFolder(root);
    fs.rmSync(path.join(folder, 'config.toml'));
    fs.symlinkSync('auth.json', path.join(folder, 'config.toml'));
    const h = observe(folder).state.prompt_history;
    assert.match(h.refused, /credential store by name/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex describe and detect', () => {
  const d = handle({ protocol: PROTOCOL, op: 'describe', args: { harness: 'codex' } }).result;
  assert.equal(d.binding.env_set[0], 'CODEX_HOME');
  assert.ok(d.path_classes.every((p) => p.class && p.source));
  assert.ok(d.capabilities.find((c) => c.capability === 'state').dropped.some((x) => /retention_days/.test(x)));

  const root = tmpdir();
  try {
    const record = path.join(root, 'env.txt');
    const bin = write(root, 'bin/codex', `#!/bin/sh\nenv > "${record}"\necho "codex-cli 0.160.2"\n`);
    fs.chmodSync(bin, 0o755);
    const r = handle({ protocol: PROTOCOL, op: 'detect', args: { harness: 'codex', bin } }).result;
    assert.deepEqual([r.version, r.range], ['0.160.2', 'compatible']);
    const env = fs.readFileSync(record, 'utf8');
    assert.match(env, /CODEX_HOME=.*hs-detect-/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
