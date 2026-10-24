// Milestone 4a: observe --cwd, overlay plans and applies, and launch-spec, on Claude Code and Codex.
// Fixture folders, fixture repositories and stub binaries only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { digestOf } from '../src/records.js';
import { codexFolder, layer, skillMd, write } from './fixtures.js';
import { linuxHost, ok, receiptFor, sandbox, settings } from './sandbox.js';

function observeCwd(s, cwd, harness = 'claude-code', folder = s.folder, state = s.opts.state) {
  return handle({ protocol: PROTOCOL, op: 'observe', args: { harness, harness_path: folder, state: true, cwd } }, { ...s.opts, state });
}

function forge(plan, operations) {
  const { digest, ...body } = { ...plan, operations };
  return { ...body, digest: 'sha256:' + digestOf(body) };
}

// Every file in a folder with its bytes: nothing may change under launch-spec.
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${n}` : n);
    else out[rel] = st.isFile() ? fs.readFileSync(abs, 'base64') : 'special';
  };
  walk('');
  return out;
}

test('observe --cwd, Claude Code: local over project over folder; managed over all', () => {
  const s = sandbox();
  try {
    const repo = path.join(s.root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const cwd = path.join(repo, 'pkg');
    write(cwd, '.claude/settings.json', JSON.stringify({ cleanupPeriodDays: 3 }));
    write(s.folder, 'settings.json', JSON.stringify({ cleanupPeriodDays: 400 }));

    let r = ok(observeCwd(s, cwd)).state.retention_days;
    assert.deepEqual([r.value, r.source, r.from], [3, 'project', path.join(cwd, '.claude/settings.json')]);
    assert.match(r.unverified.at(-1), /--settings/);
    assert.doesNotMatch(r.unverified.at(-1), /settings\.local\.json/, 'the project layers were read; only the launch flag is left');

    write(repo, '.claude/settings.local.json', JSON.stringify({ cleanupPeriodDays: 50 }));
    r = ok(observeCwd(s, cwd)).state.retention_days;
    assert.deepEqual([r.value, r.source], [50, 'local'], 'local settings live at the git root and outrank the project');
    assert.deepEqual(r.cwd.layers.map((l) => [l.source, l.present, l.sets === true]), [['local', true, true], ['project', true, true]]);

    const managed = path.join(s.root, 'managed');
    write(managed, 'managed-settings.json', JSON.stringify({ cleanupPeriodDays: 9999 }));
    r = ok(observeCwd(s, cwd, 'claude-code', s.folder, { managedRoot: managed, mdmPlists: [] })).state.retention_days;
    assert.deepEqual([r.value, r.source, r.unverified], [9999, 'managed', undefined]);

    // a worktree: local settings are read in the main checkout
    const wt = path.join(s.root, 'wt');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    write(wt, '.git', `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
    r = ok(observeCwd(s, wt)).state.retention_days;
    assert.deepEqual([r.value, r.source], [50, 'local']);

    assert.equal(handle({ protocol: PROTOCOL, op: 'observe', args: { harness: 'claude-code', harness_path: s.folder, cwd } }, s.opts).error.code, 'bad_request', '--cwd goes with --state');
    assert.equal(observeCwd(s, 'relative/dir').error.code, 'bad_request');
  } finally {
    s.done();
  }
});

test('observe --cwd, Codex: trusted project layers, closest first; untrusted ones skipped and named', () => {
  const s = sandbox();
  try {
    const folder = codexFolder(s.root);
    const repo = path.join(s.root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const cwd = path.join(repo, 'a', 'b');
    write(repo, '.codex/config.toml', '[history]\npersistence = "save-all"\n');
    write(cwd, '.codex/config.toml', '[history]\npersistence = "none"\n');
    write(folder, 'config.toml', '[history]\npersistence = "save-all"\n');
    const state = { managedRoot: null, platform: 'linux' };

    let h = ok(observeCwd(s, cwd, 'codex', folder, state)).state.prompt_history;
    assert.deepEqual([h.value, h.source], ['keep', 'folder'], 'untrusted: Codex skips the project files');
    assert.ok(h.unverified.some((u) => /not a trusted project/.test(u)));

    write(folder, 'config.toml', `[history]\npersistence = "save-all"\n\n[projects."${repo}"]\ntrust_level = "trusted"\n`);
    h = ok(observeCwd(s, cwd, 'codex', folder, state)).state.prompt_history;
    assert.deepEqual([h.value, h.source, h.from], ['none', 'project', path.join(cwd, '.codex/config.toml')], 'the closest file wins');
    assert.deepEqual(h.cwd.layers.map((l) => l.file), [path.join(cwd, '.codex/config.toml'), path.join(repo, '.codex/config.toml')]);

    const etc = path.join(s.root, 'etc');
    write(etc, 'managed_config.toml', '[history]\npersistence = "save-all"\n');
    h = ok(observeCwd(s, cwd, 'codex', folder, { managedRoot: etc, platform: 'linux' })).state.prompt_history;
    assert.deepEqual([h.value, h.source], ['keep', 'managed']);
  } finally {
    s.done();
  }
});

test('overlay, Claude Code: a longer retention is persisted, a shorter one is launch-only, no default, no skills', () => {
  const s = sandbox();
  try {
    const empty = layer(s.root, 'empty', '');
    let plan = ok(s.call('plan', { layers: [empty], owner: 'tool', mode: 'overlay' }));
    assert.equal(plan.unchanged, true, 'no skeleton default under overlay: the folder may be the user\'s');

    let local = write(s.root, 'local.toml', '[state]\nretention_days = 400\nsessions = "none"\n');
    plan = ok(s.call('plan', { layers: [empty], local, owner: 'tool', mode: 'overlay' }));
    assert.deepEqual(plan.operations.map((o) => [o.item, o.action, o.value]), [['state.retention_days', 'create', 400]]);
    assert.deepEqual(plan.launch_only.map((x) => x.item), ['state.retention_days', 'state.sessions']);
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.equal(settings(s.folder).cleanupPeriodDays, 400);

    local = write(s.root, 'local.toml', '[state]\nretention_days = 7\n');
    plan = ok(s.call('plan', { layers: [empty], local, owner: 'tool', mode: 'overlay' }));
    assert.deepEqual(plan.operations, [], 'a shorter value never outlives the tool\'s launches');
    assert.deepEqual(plan.reduces_capture.map((x) => [x.from, x.to]), [[400, 7]]);
    assert.match(plan.skipped.find((x) => x.item === 'state.retention_days').reason, /launches only/);

    local = write(s.root, 'local.toml', '[state]\nretention_days = 800\n');
    plan = ok(s.call('plan', { layers: [empty], local, owner: 'tool', mode: 'overlay', no_persist_state: true }));
    assert.deepEqual(plan.operations, []);
    assert.match(plan.reduces_capture[0].notice, /no_persist_state/);

    const res = ok(s.call('plan', { layers: [s.team], owner: 'tool', mode: 'overlay' }));
    assert.ok(!res.operations.some((o) => o.item === 'skill.notes'), 'a skill is never written under overlay');
    assert.ok(res.launch_only.some((x) => x.item === 'skill.notes'));
  } finally {
    s.done();
  }
});

test('overlay: a hand-made plan cannot add a write, and the handlers refuse what overlay never writes', () => {
  const s = sandbox();
  try {
    const empty = layer(s.root, 'empty', '');
    const local = write(s.root, 'local.toml', '[state]\nretention_days = 400\n');
    const plan = ok(s.call('plan', { layers: [empty], local, owner: 'tool', mode: 'overlay' }));
    const tree = forge(plan, [...plan.operations, { id: 'op-2', item: 'skill.x', handler: 'tree', address: { path: 'skills/x' }, address_id: 'skills/x', class: 'config',
      source: s.team, source_sha256: 'x', desired_sha256: 'x', precondition: { sha256: null }, risk: [], action: 'create', previous: { present: false } }]);
    assert.equal(s.call('apply', { plan: tree, receipt: receiptFor(tree) }).error.code, 'plan_stale');
    const key = forge(plan, [{ ...plan.operations[0], address: { file: 'settings.json', key: 'apiKeyHelper' }, address_id: 'settings.json#apiKeyHelper', value: '/tmp/x' }]);
    assert.equal(s.call('apply', { plan: key, receipt: receiptFor(key) }).error.code, 'plan_stale');
    const mode = forge({ ...plan, args: { ...plan.args, mode: 'materialize' } }, plan.operations);
    assert.equal(s.call('apply', { plan: mode, receipt: receiptFor(mode) }).error.code, 'plan_stale', 'materialize would add the default');
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/x')), false);
    assert.equal(settings(s.folder).apiKeyHelper, undefined);
  } finally {
    s.done();
  }
});

test('launch-spec, Claude Code: --settings in a temp dir, the binding, the unsets, nothing written to the folder', () => {
  const s = sandbox();
  try {
    const before = snapshot(s.folder);
    const local = write(s.root, 'local.toml', '[state]\nretention_days = 400\nsessions = "none"\nprompt_history = "none"\n');
    const empty = layer(s.root, 'empty', '');
    const spec = ok(s.call('launch-spec', { layers: [empty], local }));
    const settingsFile = spec.files.find((f) => f.role === 'settings');
    assert.deepEqual(spec.argv, ['claude', '--settings', settingsFile.path]);
    // The overlay repeats the variables: a settings env value overwrites the shell's [CC §19].
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile.path, 'utf8')), { cleanupPeriodDays: 400, env: { CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' } });
    assert.equal(fs.statSync(settingsFile.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(spec.temp_dir).mode & 0o777, 0o700);
    assert.ok(!spec.temp_dir.startsWith(s.folder));
    assert.deepEqual(spec.env_set, { CLAUDE_CONFIG_DIR: s.folder, CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' });
    assert.deepEqual(spec.env_unset, ['CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_TMPDIR']);
    assert.ok(spec.skipped.some((x) => x.item === 'state.prompt_history'));
    assert.deepEqual(snapshot(s.folder), before, 'launch-spec writes nothing into the data folder');

    const headless = ok(s.call('launch-spec', { layers: [empty], local, headless: true }));
    assert.deepEqual(headless.argv.slice(3), ['-p', '--output-format', 'json', '--no-session-persistence']);
    assert.match(headless.headless.result, /143 on SIGTERM/);
    fs.rmSync(spec.temp_dir, { recursive: true });
    fs.rmSync(headless.temp_dir, { recursive: true });

    const none = ok(s.call('launch-spec', { layers: [empty] }));
    assert.deepEqual([none.argv, none.files, none.temp_dir], [['claude'], [], null], 'nothing to carry: no temp dir');
    assert.equal(s.call('launch-spec', { layers: [s.team] }).error.code, 'receipt_required', 'a skill at launch needs a launch receipt (6a.3)');
  } finally {
    s.done();
  }
});

test('launch-spec and overlay, Codex: -c for prompt history, --ephemeral headless only, nothing written', () => {
  const s = sandbox();
  try {
    const folder = codexFolder(s.root);
    const bin = write(s.root, 'bin/codex', '#!/bin/sh\necho "codex-cli 0.160.0"\n');
    fs.chmodSync(bin, 0o755);
    const call = (op, args) => handle({ protocol: PROTOCOL, op, args: { harness: 'codex', harness_path: folder, bin, ...args } }, { ...s.opts, host: linuxHost });
    const before = snapshot(folder);
    const empty = layer(s.root, 'empty', '');
    const local = write(s.root, 'local.toml', '[state]\nprompt_history = "none"\nsessions = "none"\nretention_days = 90\n');

    const spec = ok(call('launch-spec', { layers: [empty], local }));
    assert.deepEqual(spec.argv, ['codex', '-c', 'history.persistence="none"']);
    assert.deepEqual(spec.env_set, { CODEX_HOME: folder });
    assert.deepEqual(spec.env_unset, ['CODEX_SQLITE_HOME']);
    assert.equal(spec.temp_dir, null);
    assert.deepEqual(spec.skipped.map((x) => x.item).sort(), ['state.retention_days', 'state.sessions']);

    const headless = ok(call('launch-spec', { layers: [empty], local, headless: true }));
    assert.deepEqual(headless.argv, ['codex', 'exec', '--json', '-c', 'history.persistence="none"', '--ephemeral']);
    assert.match(headless.cwd_requirements[0], /git repository/);

    const plan = ok(call('plan', { layers: [empty], local, owner: 'tool', mode: 'overlay' }));
    assert.deepEqual(plan.operations, [], 'nothing is written into a Codex folder');
    assert.deepEqual(plan.launch_only.map((x) => x.item), ['state.prompt_history', 'state.sessions']);
    assert.match(plan.reduces_capture[0].notice, /config\.toml is not written/);
    ok(call('apply', { plan, receipt: receiptFor(plan) }));
    // Materialize writes only skills on Codex (6a.10): with none, it plans no write either.
    assert.deepEqual(ok(call('plan', { layers: [empty], local, owner: 'tool' })).operations, []);

    // apply writes its own records, nothing else
    const after = snapshot(folder);
    for (const k of Object.keys(after)) if (!k.startsWith('.harness-skeleton/')) assert.equal(after[k], before[k], k);
  } finally {
    s.done();
  }
});

// A review's fix round.

test('overlay on a folder that sets its own retention: skip, adopt and give back, or launch only', () => {
  const s = sandbox();
  try {
    const empty = layer(s.root, 'empty', '');
    const spec = (days) => write(s.root, `local-${days}.toml`, `[state]\nretention_days = ${days}\n`);

    // the folder keeps 9999, the spec says 9999 (as a managed 9999 makes it): nothing to write
    write(s.folder, 'settings.json', JSON.stringify({ cleanupPeriodDays: 9999 }));
    let plan = ok(s.call('plan', { layers: [empty], local: spec(9999), owner: 'tool', mode: 'overlay' }));
    assert.deepEqual(plan.operations, []);
    assert.match(plan.skipped.find((x) => x.item === 'state.retention_days').reason, /already keeps 9999/);

    // the folder keeps 9999, the spec says 400: launch-only, listed as reducing capture
    plan = ok(s.call('plan', { layers: [empty], local: spec(400), owner: 'tool', mode: 'overlay' }));
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.reduces_capture.map((x) => [x.from, x.to]), [[9999, 400]]);

    // the folder keeps 30, the spec says 9999: written, the user's 30 adopted as previous
    write(s.folder, 'settings.json', JSON.stringify({ model: 'opus', cleanupPeriodDays: 30 }));
    plan = ok(s.call('plan', { layers: [empty], local: spec(9999), owner: 'tool', mode: 'overlay' }));
    const op = plan.operations[0];
    assert.deepEqual([op.action, op.value, op.previous, op.adopted], ['update', 9999, { present: true, value: 30 }, true]);
    assert.match(op.note, /replaces the folder's own 30 days/);
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.deepEqual(settings(s.folder), { model: 'opus', cleanupPeriodDays: 9999 });
    ok(s.call('remove', { owner: 'tool' }));
    assert.deepEqual(settings(s.folder), { model: 'opus', cleanupPeriodDays: 30 }, 'remove gives the user\'s value back');
  } finally {
    s.done();
  }
});

test('overlay --prune never lowers a persisted retention; with no_persist_state it writes nothing', () => {
  const s = sandbox();
  try {
    const empty = layer(s.root, 'empty', '');
    let plan = ok(s.call('plan', { layers: [empty], local: write(s.root, 'l400.toml', '[state]\nretention_days = 400\n'), owner: 'tool', mode: 'overlay' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.equal(settings(s.folder).cleanupPeriodDays, 400);

    for (const [local, extra] of [
      [write(s.root, 'l7.toml', '[state]\nretention_days = 7\n'), {}],
      [undefined, {}],
      [write(s.root, 'l800.toml', '[state]\nretention_days = 800\n'), { no_persist_state: true }],
    ]) {
      plan = ok(s.call('plan', { layers: [empty], ...(local ? { local } : {}), owner: 'tool', mode: 'overlay', prune: true, ...extra }));
      assert.deepEqual(plan.operations, [], JSON.stringify(extra));
      ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
      assert.equal(settings(s.folder).cleanupPeriodDays, 400);
    }
  } finally {
    s.done();
  }
});

test('an unchanged plan\'s apply writes nothing, not even records; it is still checked', () => {
  const s = sandbox();
  try {
    const folder = codexFolder(s.root);
    const bin = write(s.root, 'bin/codex', '#!/bin/sh\necho "codex-cli 0.160.0"\n');
    fs.chmodSync(bin, 0o755);
    const call = (op, args) => handle({ protocol: PROTOCOL, op, args: { harness: 'codex', harness_path: folder, bin, ...args } }, { ...s.opts, host: linuxHost });
    const empty = layer(s.root, 'empty', '');
    const plan = ok(call('plan', { layers: [empty], local: write(s.root, 'l.toml', '[state]\nprompt_history = "none"\n'), owner: 'tool', mode: 'overlay' }));
    const res = ok(call('apply', { plan, receipt: receiptFor(plan) }));
    assert.deepEqual([res.unchanged, res.apply_id], [true, null]);
    assert.equal(fs.existsSync(path.join(folder, '.harness-skeleton')), false, 'no records in a folder that may be the user\'s ~/.codex');
    const forged = forge(plan, [{ id: 'op-1', item: 'x', handler: 'json-key', address: { file: 'config.toml', key: 'k' }, address_id: 'config.toml#k', class: 'config',
      value: 1, desired_sha256: digestOf(1), precondition: { sha256: null }, risk: [], action: 'create', previous: { present: false } }]);
    assert.equal(call('apply', { plan: forged, receipt: receiptFor(forged) }).error.code, 'plan_stale');
    assert.equal(call('apply', { plan, receipt: { ...receiptFor(plan), plan_digest: 'sha256:00' } }).error.code, 'receipt_required');
  } finally {
    s.done();
  }
});

test('launch-spec refuses a temp root inside the data folder', () => {
  const s = sandbox();
  try {
    const local = write(s.root, 'local.toml', '[state]\nretention_days = 400\n');
    const res = handle({ protocol: PROTOCOL, op: 'launch-spec', args: { harness: 'claude-code', harness_path: s.folder, layers: [layer(s.root, 'e', '')], local } },
      { ...s.opts, tmpdir: path.join(s.folder, 'debug') });
    assert.equal(res.error.code, 'write_refused');
    assert.equal(fs.readdirSync(path.join(s.folder, 'debug')).some((n) => n.startsWith('hs-launch-')), false);
  } finally {
    s.done();
  }
});

test('observe --cwd: a worktree with a relative gitdir; the Codex trust match is named as unverified', () => {
  const s = sandbox();
  try {
    const repo = path.join(s.root, 'main-repo');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt2'), { recursive: true });
    write(repo, '.claude/settings.local.json', JSON.stringify({ cleanupPeriodDays: 77 }));
    const wt = path.join(s.root, 'wt2');
    write(wt, '.git', 'gitdir: ../main-repo/.git/worktrees/wt2\n');
    const r = ok(observeCwd(s, wt)).state.retention_days;
    assert.deepEqual([r.value, r.source, r.from], [77, 'local', path.join(repo, '.claude/settings.local.json')]);

    const folder = codexFolder(s.root);
    const h = ok(observeCwd(s, repo, 'codex', folder, { managedRoot: null, platform: 'linux' })).state.prompt_history;
    assert.ok(h.unverified.some((u) => /matched exactly/.test(u)));
  } finally {
    s.done();
  }
});
