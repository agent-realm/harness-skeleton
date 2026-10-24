import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { classify, inventory } from '../src/inventory.js';
import descriptor from '../src/drivers/claude-code/descriptor.js';
import { claudeCodeFolder, tmpdir, write } from './fixtures.js';

const noManaged = { managedRoot: null, mdmPlists: [] };
const linuxHost = { platform: 'linux', readFile: (f) => (f === '/etc/machine-id' ? '0123456789abcdef0123456789abcdef\n' : null) };

// `home` is always a fixture directory, so no test looks at the real home.
function observe(folder, state = noManaged, home = path.dirname(folder)) {
  return handle({ protocol: PROTOCOL, request_id: 't', op: 'observe', args: { harness: 'claude-code', harness_path: folder, state: true } },
    { host: linuxHost, state, home });
}

function patterns(inv, cls) {
  return inv.classes[cls].map((r) => r.pattern).sort();
}

test('inventory: every entry gets the class of the first matching rule', () => {
  const root = tmpdir();
  try {
    const inv = inventory(claudeCodeFolder(root), descriptor.paths);
    assert.deepEqual(patterns(inv, 'sessions'), ['projects/*/*', 'projects/*/*.jsonl']);
    assert.deepEqual(patterns(inv, 'history'), ['file-history', 'history.jsonl', 'projects/*/memory']);
    assert.deepEqual(patterns(inv, 'config'), ['.claude.json', 'CLAUDE.md', 'plugins/*', 'settings.json', 'skills']);
    assert.deepEqual(patterns(inv, 'cache'), ['paste-cache', 'plugins/cache']);
    assert.deepEqual(patterns(inv, 'credentials'), ['.credentials.json']);
    assert.deepEqual(patterns(inv, 'runtime'), ['sessions']);
    assert.deepEqual(patterns(inv, 'logs'), ['debug']);

    const transcripts = inv.classes.sessions.find((r) => r.pattern === 'projects/*/*.jsonl');
    assert.equal(transcripts.entries, 2);
    assert.deepEqual(transcripts.paths.map((p) => p.path), ['projects/-work-repo/aaaa.jsonl', 'projects/-work-repo/bbbb.jsonl']);
    const sidecars = inv.classes.sessions.find((r) => r.pattern === 'projects/*/*');
    assert.equal(sidecars.files, 2); // subagents/agent-1.jsonl and tool-results/r1.txt
    assert.deepEqual(inv.classes.config.find((r) => r.pattern === '.claude.json').mixed, ['runtime', 'history']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('classify agrees with the inventory walk on every path it lists', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    const inv = inventory(folder, descriptor.paths);
    let checked = 0;
    for (const [cls, rows] of Object.entries(inv.classes)) {
      for (const row of rows) {
        for (const p of row.paths ?? []) {
          assert.equal(classify(p.path, descriptor.paths, { isDir: p.kind === 'dir' }), cls, p.path);
          checked++;
        }
      }
    }
    for (const p of inv.unknown.items) assert.equal(classify(p.path, descriptor.paths, { isDir: p.kind === 'dir' }), 'unknown', p.path);
    assert.ok(checked > 10);
    // inside a subtree a class rule covers: a session directory's files, a plugin cache file
    assert.equal(classify('projects/-work-repo/aaaa/subagents/agent-1.jsonl', descriptor.paths), 'sessions');
    assert.equal(classify('plugins/cache/some-plugin/plugin.json', descriptor.paths), 'cache');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inventory: unknown paths are reported, at any depth, never hidden', () => {
  const root = tmpdir();
  try {
    const inv = inventory(claudeCodeFolder(root), descriptor.paths);
    assert.deepEqual(inv.unknown.items.map((e) => e.path), ['mystery', 'projects/-work-repo/stray.txt']);
    assert.equal(inv.unknown.truncated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inventory: credentials are stat-ed, never read', () => {
  const root = tmpdir();
  const folder = claudeCodeFolder(root);
  const cred = path.join(folder, '.credentials.json');
  try {
    fs.chmodSync(cred, 0o000); // any read would now throw
    const inv = inventory(folder, descriptor.paths);
    const row = inv.classes.credentials[0];
    assert.equal(row.paths[0].path, '.credentials.json');
    assert.equal(row.paths[0].bytes, '{"token":"never-read"}'.length);
    assert.doesNotMatch(JSON.stringify(inv), /never-read/);
  } finally {
    fs.chmodSync(cred, 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inventory: a symlink is listed as itself, not followed', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    const outside = path.join(root, 'outside');
    write(outside, 'big.bin', 'x'.repeat(5000));
    fs.symlinkSync(outside, path.join(folder, 'skills', 'linked'));
    fs.symlinkSync(outside, path.join(folder, 'elsewhere'));
    const inv = inventory(folder, descriptor.paths);
    const skills = inv.classes.config.find((r) => r.pattern === 'skills');
    assert.ok(skills.bytes < 5000);
    assert.equal(inv.unknown.items.find((e) => e.path === 'elsewhere').kind, 'symlink');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inventory: a rule with many entries reports totals, not every path', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    for (let i = 0; i < 25; i++) write(folder, `projects/-big/s${String(i).padStart(2, '0')}.jsonl`, '{}\n');
    const row = inventory(folder, descriptor.paths).classes.sessions.find((r) => r.pattern === 'projects/*/*.jsonl');
    assert.equal(row.entries, 27);
    assert.equal(row.paths, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe --state: the store key, the inventory and the [state] values', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    const res = observe(folder);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.deepEqual(res.result.store, { host: 'd1073ef8de4b1a552a089f5890c636a2', harness: 'claude-code', harness_path: folder });
    assert.equal(res.result.host_source, 'machine-id');
    const r = res.result.state.retention_days;
    assert.deepEqual([r.value, r.source, r.native], [30, 'default', 'cleanupPeriodDays']);
    assert.match(r.unverified.at(-1), /settings\.local\.json, and --settings, outrank the folder/);
    assert.equal(res.result.state.prompt_history.expressible, false);
    assert.deepEqual(res.result.harness_defaults, { retention_days: 30, sessions: 'keep', prompt_history: 'keep' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe --state: the folder value, then managed policy over it', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    write(folder, 'settings.json', JSON.stringify({ cleanupPeriodDays: 120 }));
    let r = observe(folder).result.state.retention_days;
    assert.deepEqual([r.value, r.source, r.from], [120, 'folder', path.join(folder, 'settings.json')]);

    const managed = path.join(root, 'managed');
    write(managed, 'managed-settings.json', JSON.stringify({ cleanupPeriodDays: 9999 }));
    r = observe(folder, { managedRoot: managed, mdmPlists: [] }).result.state.retention_days;
    assert.deepEqual([r.value, r.source, r.from], [9999, 'managed', path.join(managed, 'managed-settings.json')]);
    assert.equal(r.unverified, undefined, 'managed policy holds for every launch');

    write(managed, 'managed-settings.d/10-short.json', JSON.stringify({ cleanupPeriodDays: 7 }));
    r = observe(folder, { managedRoot: managed, mdmPlists: [] }).result.state.retention_days;
    assert.equal(r.value, 7);
    assert.match(r.from, /10-short\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe --state: managed sources are first-wins unless one says merge', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    const managed = path.join(root, 'managed');
    write(managed, 'managed-settings.json', JSON.stringify({ cleanupPeriodDays: 9999 }));
    const plist = path.join(root, 'mdm.plist');
    const fakePlist = (settings) => (f) => (f === plist ? { present: true, value: settings } : { present: false });

    let r = observe(folder, { managedRoot: managed, mdmPlists: [plist], plistToJson: fakePlist({ model: 'x' }) }).result.state.retention_days;
    assert.deepEqual([r.value, r.source], [30, 'default']); // the MDM source wins whole, and sets no retention

    r = observe(folder, { managedRoot: managed, mdmPlists: [plist], plistToJson: fakePlist({ managedSourcesBehavior: 'merge' }) }).result.state.retention_days;
    assert.deepEqual([r.value, r.source], [9999, 'managed']);

    r = observe(folder, { managedRoot: managed, mdmPlists: [plist], plistToJson: fakePlist({ managedSourcesBehavior: 'merge', cleanupPeriodDays: 400 }) }).result.state.retention_days;
    assert.equal(r.value, 400); // the higher source wins per key
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe --state: invalid values are flagged, unreadable settings reported', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    write(folder, 'settings.json', JSON.stringify({ cleanupPeriodDays: 0 }));
    const r = observe(folder).result.state.retention_days;
    assert.equal(r.valid, false);
    write(folder, 'settings.json', '{ not json');
    const res = observe(folder).result;
    assert.equal(res.state.retention_days.source, 'default');
    assert.match(res.errors[0], /settings\.json: not JSON/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe --state: a server-managed cache is named as unverified', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    write(folder, 'remote-settings.json', '{}');
    const r = observe(folder).result.state.retention_days;
    assert.match(r.unverified[0], /remote-settings\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe: nothing in the folder changes', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    const snapshot = () => {
      const out = [];
      const walk = (d) => {
        for (const n of fs.readdirSync(d).sort()) {
          const p = path.join(d, n);
          const st = fs.lstatSync(p);
          out.push([path.relative(folder, p), st.size, st.mtimeMs]);
          if (st.isDirectory()) walk(p);
        }
      };
      walk(folder);
      return out;
    };
    const before = snapshot();
    observe(folder);
    assert.deepEqual(snapshot(), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe --state: settings.json through a symlink is followed, except to a credential store or transcript', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    const settings = path.join(folder, 'settings.json');
    const relink = (target) => {
      fs.rmSync(settings, { force: true });
      fs.symlinkSync(target, settings);
    };

    // a dotfiles link outside the folder is what Claude Code reads, so it is followed and named
    const dotfile = write(root, 'dotfiles/claude-settings.json', JSON.stringify({ cleanupPeriodDays: 77 }));
    relink(dotfile);
    let r = observe(folder).result.state.retention_days;
    assert.deepEqual([r.value, r.source, r.from, r.via_symlink], [77, 'folder', dotfile, true]);

    // the folder's credential store: refused before any open (mode 000 would make a read throw)
    const cred = path.join(folder, '.credentials.json');
    fs.chmodSync(cred, 0o000);
    try {
      relink('.credentials.json');
      const res = observe(folder).result;
      assert.match(res.state.retention_days.refused, /credential store by name/);
      assert.equal(res.state.retention_days.value, null);
      assert.doesNotMatch(JSON.stringify(res), /never-read/);
    } finally {
      fs.chmodSync(cred, 0o600);
    }

    // another harness's credential file by name, and the Anthropic profile store, outside the folder
    relink(write(root, 'elsewhere/auth.json', '{"cleanupPeriodDays": 5}'));
    assert.match(observe(folder).result.state.retention_days.refused, /credential store by name/);
    relink(write(root, '.config/anthropic/profile.json', '{"cleanupPeriodDays": 5}'));
    assert.match(observe(folder).result.state.retention_days.refused, /inside the credential store ~\/\.config\/anthropic/);

    // a transcript: refused; sessions leave only through sessions.*
    relink('projects/-work-repo/aaaa.jsonl');
    assert.match(observe(folder).result.state.retention_days.refused, /a sessions path of the data folder/);
    relink('projects/-work-repo/aaaa'); // a session directory
    assert.match(observe(folder).result.state.retention_days.refused, /a sessions path of the data folder/);

    // not a regular file: a directory, and a FIFO, which must not hang the open
    relink(path.join(root, 'dotfiles'));
    let res = observe(folder).result;
    assert.match(res.errors[0], /not a regular file/);
    const fifo = path.join(root, 'fifo');
    if (spawnSync('mkfifo', [fifo]).status === 0) {
      relink(fifo);
      res = observe(folder).result;
      assert.match(res.errors[0], /not a regular file/);
    }

    // a dangling link
    relink('nowhere.json');
    assert.match(observe(folder).result.state.retention_days.refused, /does not resolve/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe --state: ~/.claude.json beside the default folder is listed, stat-ed only', () => {
  const root = tmpdir();
  const home = path.join(root, 'home');
  try {
    fs.mkdirSync(home);
    fs.renameSync(claudeCodeFolder(home), path.join(home, '.claude'));
    const folder = path.join(home, '.claude');
    const sidecar = write(home, '.claude.json', '{"oauthAccount":"never-read"}');
    fs.chmodSync(sidecar, 0o000);
    fs.mkdirSync(path.join(home, '.claude.json.lock'));
    write(home, '.claude.json.tmp.123.abcd', '{}');

    const esc = observe(folder, noManaged, home).result.escapes.find((e) => e.path === '~/.claude.json');
    assert.equal(esc.applies, true);
    assert.deepEqual(esc.present.map((p) => [p.path, p.kind]), [
      ['~/.claude.json', 'file'], ['~/.claude.json.lock', 'dir'], ['~/.claude.json.tmp.123.abcd', 'file'],
    ]);
    assert.deepEqual([esc.class, esc.mixed], ['config', ['runtime', 'history']]);

    const other = claudeCodeFolder(root);
    assert.equal(observe(other, noManaged, home).result.escapes.find((e) => e.path === '~/.claude.json').applies, false);
    fs.chmodSync(sidecar, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe --state: a parse error never quotes the file', () => {
  const root = tmpdir();
  try {
    const folder = claudeCodeFolder(root);
    for (const text of ['TOP_SECRET_API_KEY invalid JSON', '{"cleanupPeriodDays": TOP_SECRET_API_KEY}', '{"a": "TOP_SECRET_API_KEY"']) {
      write(folder, 'settings.json', text);
      const res = observe(folder).result;
      assert.match(res.errors[0], /settings\.json: not JSON/);
      assert.doesNotMatch(JSON.stringify(res), /TOP_SECRET/, text);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('observe without --state: Codex has no delivery yet, so it answers --state only', () => {
  const res = handle({ protocol: PROTOCOL, request_id: 't', op: 'observe', args: { harness: 'codex', harness_path: '/' } });
  assert.equal(res.error.code, 'not_implemented');
});
