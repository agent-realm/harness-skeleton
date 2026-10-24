// Milestone 6a.13 (item 2d): hooks under materialize on Claude Code (design note §5.4, §7.5). A
// persisted hook is a group of its own in settings.json's hooks.<Event>, set as one element
// without touching the user's groups; it runs hs's shim from the folder's copy
// (hs-run/hook-shim/) and its process from its bound copy (hs-run/hook.<id>/). A gating hook sets
// onFailure "block" (Claude Code 2.1.295 and later), and its command names the way out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setElement, setKey } from '../src/json-edit.js';
import { handlers } from '../src/native.js';
import { digestOf } from '../src/records.js';
import ccDriver from '../src/drivers/claude-code/index.js';
import { layer } from './fixtures.js';
import { ok, receiptFor, sandbox } from './sandbox.js';

const D = ccDriver.descriptor;
const mode = (p) => fs.statSync(p).mode & 0o777;

// The user's settings.json, in their own layout: four spaces, their own PreToolUse group.
const USER_FILE = `{
    "model": "sonnet",
    "cleanupPeriodDays": 9999,
    "hooks": {
        "PreToolUse": [
            { "matcher": "Write", "hooks": [{ "type": "command", "command": "my-own-guard" }] }
        ]
    },
    "env": { "A": "1" }
}
`;

function guardLayer(s, extra = '') {
  const dir = layer(s.root, `guards${extra.length}`, `[hook.g]\nevent = "PreToolUse"\nmatch = { tool = ["shell"] }\nrun = { exec = "guard/run.sh", self_contained = true }\ntimeout = 20\n${extra}`,
    { 'guard/run.sh': '#!/bin/sh\ncat >/dev/null\nexit 0\n', 'guard/lib.sh': 'X=1\n' });
  fs.chmodSync(path.join(dir, 'guard/run.sh'), 0o755);
  return dir;
}

test('a persisted guard: its own group in hooks.PreToolUse, the user\'s file byte for byte around it, onFailure block, the way out in its command; remove restores the exact file', () => {
  const s = sandbox();
  try {
    fs.writeFileSync(path.join(s.folder, 'settings.json'), USER_FILE);
    const team = guardLayer(s);
    const plan = ok(s.call('plan', { layers: [team], owner: 'builder' }));
    assert.deepEqual(plan.operations.map((o) => [o.action, o.handler, o.address_id, o.risk]), [
      ['create', 'tree', 'hs-run/hook-shim', ['runs-code']],
      ['create', 'tree', 'hs-run/hook.g', ['runs-code']],
      ['create', 'json-element', 'settings.json#hooks/PreToolUse[hook.g]', ['runs-code']],
    ]);
    const group = plan.operations[2].value;
    assert.equal(group.matcher, 'Bash');
    const [handler] = group.hooks;
    assert.equal(handler.onFailure, 'block');
    assert.equal(handler.timeout, 30);
    assert.match(handler.command, new RegExp(`hs-run/hook-shim/claude-code\\.js'? PreToolUse --timeout 20 -- '?${s.folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/hs-run/hook\\.g/run\\.sh'?`));
    assert.match(handler.command, /# hs: a persisted PreToolUse hook .*hs-run\/hook\.g\/\); to take it away: hs remove --owner builder on this folder, or delete this entry from settings\.json hooks\.PreToolUse$/);
    assert.match(plan.operations[2].note, /a guard: onFailure "block"/);
    assert.equal(s.call('apply', { plan, receipt: receiptFor(plan, []) }).error.code, 'receipt_required');
    assert.equal(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'), USER_FILE);
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    // Exactly the user's file with our one element inserted: every other byte as it was.
    const after = fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8');
    assert.equal(after, setElement(USER_FILE, ['hooks', 'PreToolUse'], (v) => JSON.stringify(v).includes('/hs-run/hook.g/'), group));
    assert.deepEqual(JSON.parse(after).hooks.PreToolUse[0], JSON.parse(USER_FILE).hooks.PreToolUse[0]);
    assert.equal(mode(path.join(s.folder, 'hs-run/hook-shim')), 0o700);
    assert.equal(mode(path.join(s.folder, 'hs-run/hook.g/run.sh')), 0o700);
    assert.ok(fs.existsSync(path.join(s.folder, 'hs-run/hook-shim/claude-code.js')));
    // At launch it is installed: skipped, not carried in --settings again.
    const spec = ok(s.call('launch-spec', { layers: [team] }));
    assert.ok(spec.skipped.some((x) => x.item === 'hook.g' && /installed in the folder by a plan/.test(x.reason)));
    // A second plan is unchanged; remove restores the exact bytes.
    assert.deepEqual(ok(s.call('plan', { layers: [team], owner: 'builder' })).operations, []);
    ok(s.call('remove', { owner: 'builder' }));
    assert.equal(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'), USER_FILE);
    assert.equal(fs.existsSync(path.join(s.folder, 'hs-run/hook.g')), false);
  } finally {
    s.done();
  }
});

test('a gating hook is refused below Claude Code 2.1.295; a non-gating one persists there, without onFailure', () => {
  const s = sandbox('2.1.290');
  try {
    const res = s.call('plan', { layers: [guardLayer(s)], owner: 'builder' });
    assert.equal(res.error.code, 'item_unsupported');
    assert.match(res.error.items.find((i) => i.item === 'hook.g').reason, /fails closed only with onFailure: "block", which Claude Code 2\.1\.295 and later honour; this folder's Claude Code is 2\.1\.290/);
    const start = layer(s.root, 'start', '[hook.s]\nevent = "SessionStart"\nrun = { exec = "echo", args = ["hi"] }\n');
    const plan = ok(s.call('plan', { layers: [start], owner: 'builder' }));
    const el = plan.operations.find((o) => o.handler === 'json-element');
    assert.equal(el.value.hooks[0].onFailure, undefined);
    assert.match(el.note, /binds the command text only/);
  } finally {
    s.done();
  }
});

test('refused and risky: refs, a cwd outside the copy; may_allow carries grants-permission; overlay stays launch-only', () => {
  const s = sandbox();
  try {
    const refs = layer(s.root, 'refs', '[refs.R]\ndescription = "r"\n\n[hook.r]\nevent = "Stop"\nrun = { exec = "x", env_refs = { T = "R" } }\n');
    const local = path.join(s.root, 'local.toml');
    fs.writeFileSync(local, '[refs]\nR = "env:R"\n');
    let e = s.call('plan', { layers: [refs], local, owner: 'builder' }).error;
    assert.equal(e.code, 'item_unsupported');
    assert.match(e.items[0].reason, /empty secret/);
    e = s.call('plan', { layers: [layer(s.root, 'cwd', '[hook.c]\nevent = "Stop"\nrun = { exec = "x", cwd = "elsewhere" }\n', { 'elsewhere/.keep': '' })], owner: 'builder' }).error;
    assert.match(e.items[0].reason, /cwd must lie in the directory it runs from/);
    const allow = ok(s.call('plan', { layers: [guardLayer(s, 'may_allow = true\n')], owner: 'builder' }));
    assert.deepEqual(allow.operations.find((o) => o.handler === 'json-element').risk, ['runs-code', 'grants-permission']);
    const overlay = ok(s.call('plan', { layers: [guardLayer(s)], owner: 'builder', mode: 'overlay' }));
    assert.ok(overlay.launch_only.some((x) => x.item === 'hook.g'));
    assert.ok(!overlay.operations.some((o) => o.address_id.startsWith('hs-run') || o.handler === 'json-element'));
  } finally {
    s.done();
  }
});

test('the handlers: an element only in hooks/<Event> of settings.json, never a hidden id; the shim copied only from hs\'s own shim', () => {
  const s = sandbox();
  try {
    const before = fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8');
    const v = { hooks: [{ type: 'command', command: '/x/hs-run/hook.g/run' }] };
    for (const a of [
      { file: 'settings.json', key: 'permissions/allow', id: 'hook.g' },
      { file: 'settings.json', key: 'hooks/PreToolUse/x', id: 'hook.g' },
      { file: 'settings.json', key: 'hooks/PreToolUse', id: '.x' },
      { file: '.claude.json', key: 'hooks/PreToolUse', id: 'hook.g' },
      { file: 'settings.local.json', key: 'hooks/PreToolUse', id: 'hook.g' },
    ]) {
      assert.throws(() => handlers['json-element'].write(s.folder, D, a, v), { code: 'write_refused' }, JSON.stringify(a));
    }
    assert.equal(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'), before);
    // A plan that names another source for hs-run/hook-shim is refused at apply (re-derived: stale).
    const plan = ok(s.call('plan', { layers: [guardLayer(s)], owner: 'builder' }));
    const elsewhere = path.join(s.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const { digest, ...body } = { ...plan, operations: plan.operations.map((o) => (o.address_id === 'hs-run/hook-shim' ? { ...o, source: elsewhere } : o)) };
    const forged = { ...body, digest: 'sha256:' + digestOf(body) };
    assert.notEqual(s.call('apply', { plan: forged, receipt: receiptFor(forged) }).ok, true);
    assert.equal(fs.existsSync(path.join(s.folder, 'hs-run/hook-shim')), false);
  } finally {
    s.done();
  }
});

test('json-key edits are in place too: a plan that sets a settings key keeps the user\'s layout', () => {
  const s = sandbox();
  try {
    const own = USER_FILE.replace('    "cleanupPeriodDays": 9999,\n', '');
    fs.writeFileSync(path.join(s.folder, 'settings.json'), own);
    const empty = layer(s.root, 'empty', '');
    const plan = ok(s.call('plan', { layers: [empty], owner: 'builder' }));
    assert.ok(plan.operations.some((o) => o.address_id === 'settings.json#cleanupPeriodDays'));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.equal(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'), setKey(own, ['cleanupPeriodDays'], 9999));
  } finally {
    s.done();
  }
});

test('review: a hook whose command mentions another hook\'s copy is still only itself', () => {
  const s = sandbox();
  try {
    const team = layer(s.root, 'two', '[hook.a]\nevent = "Stop"\nrun = { exec = "echo", args = ["/f/hs-run/hook.b/"] }\n\n[hook.b]\nevent = "Stop"\nrun = { exec = "echo", args = ["b"] }\n');
    const plan = ok(s.call('plan', { layers: [team], owner: 'builder' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const stop = JSON.parse(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8')).hooks.Stop;
    assert.equal(stop.length, 2);
    for (const id of ['hook.a', 'hook.b']) {
      const got = handlers['json-element'].current(s.folder, D, { file: 'settings.json', key: 'hooks/Stop', id });
      assert.equal(got.present, true, id);
      assert.match(got.value.hooks[0].command, new RegExp(`hs-run/${id.replace('.', '\\.')}/\\); to take it away`));
    }
    assert.deepEqual(ok(s.call('plan', { layers: [team], owner: 'builder' })).operations, [], 'a second plan sees both as installed');
    ok(s.call('remove', { owner: 'builder' }));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8')).hooks.Stop, []);
  } finally {
    s.done();
  }
});

test('review: an edit landing after the new copy is staged is refused, and survives', () => {
  const s = sandbox();
  try {
    const file = path.join(s.folder, 'settings.json');
    fs.writeFileSync(file, USER_FILE);
    const copy = path.join(s.folder, 'hs-run/hook.g');
    const v = { hooks: [{ type: 'command', command: `x ${D.launch.hooks.persist.recovery('Stop', copy, 'builder')}` }] };
    const concurrent = USER_FILE.replace('"dark"', '"light"').replace('"sonnet"', '"opus"');
    assert.throws(() => handlers['json-element'].write(s.folder, D, { file: 'settings.json', key: 'hooks/Stop', id: 'hook.g' }, v, {
      onStaged: () => fs.writeFileSync(file, concurrent),
    }), { code: 'precondition_failed' });
    assert.equal(fs.readFileSync(file, 'utf8'), concurrent, 'the concurrent edit is kept, not overwritten');
    assert.deepEqual(fs.readdirSync(path.join(s.folder, '.harness-skeleton', 'tmp')).filter((n) => n.startsWith('stage.')), [], 'no staged copy is left behind');
  } finally {
    s.done();
  }
});

test('review: in a folder whose path holds a parenthesis and a space, hs still knows its own group; a second plan is unchanged and remove takes it out', () => {
  const s = sandbox('2.1.307', { prefix: 'hs test (work) ' });
  try {
    assert.match(s.folder, /\(work\) /);
    fs.writeFileSync(path.join(s.folder, 'settings.json'), USER_FILE);
    const team = guardLayer(s);
    const plan = ok(s.call('plan', { layers: [team], owner: 'builder' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8')).hooks.PreToolUse.length, 2);
    assert.deepEqual(ok(s.call('plan', { layers: [team], owner: 'builder' })).operations, [], 'a second plan has no operations');
    assert.ok(ok(s.call('launch-spec', { layers: [team] })).skipped.some((x) => x.item === 'hook.g'));
    ok(s.call('remove', { owner: 'builder' }));
    assert.equal(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'), USER_FILE, 'remove leaves no group');
  } finally {
    s.done();
  }
});

test('review: another folder\'s comment, or the same comment for another event, is not ours', () => {
  const s = sandbox();
  try {
    const owns = (command, key = 'hooks/PreToolUse') => D.writable.element_owner({ hooks: [{ type: 'command', command }] }, { id: 'hook.g', folder: s.folder, key });
    const R = D.launch.hooks.persist.recovery;
    const copy = path.join(s.folder, 'hs-run', 'hook.g');
    assert.equal(owns(`x ${R('PreToolUse', copy, 'builder')}`), true);
    assert.equal(owns(`x ${R('PreToolUse', path.join(s.root, 'other', 'hs-run', 'hook.g'), 'builder')}`), false, 'another folder');
    assert.equal(owns(`x ${R('PreToolUse', copy, 'builder')}`, 'hooks/Stop'), false, 'another event');
    assert.equal(owns(`x ${R('PreToolUse', copy, 'Not An Owner')}`), false, 'not an owner name');
    assert.equal(owns(`x ${R('PreToolUse', copy, 'builder')} trailing`), false, 'not at the end');
  } finally {
    s.done();
  }
});

test('review: a key held twice on the edit path refuses the plan, for a hook and for a settings key', () => {
  const s = sandbox();
  try {
    const file = path.join(s.folder, 'settings.json');
    const dup = '{"hooks": {"PreToolUse": []}, "model": "sonnet", "hooks": {"PreToolUse": [{"matcher": "Write", "hooks": [{"type": "command", "command": "my-own-guard"}]}]}}\n';
    fs.writeFileSync(file, dup);
    const res = s.call('plan', { layers: [guardLayer(s)], owner: 'builder' });
    assert.equal(res.ok, false);
    assert.match(JSON.stringify(res.error), /"hooks\\" 2 times; JSON readers take the last one/);
    assert.equal(fs.readFileSync(file, 'utf8'), dup);
    fs.writeFileSync(file, '{"cleanupPeriodDays": 30, "cleanupPeriodDays": 7}\n');
    const res2 = s.call('plan', { layers: [layer(s.root, 'empty', '')], owner: 'builder' });
    assert.equal(res2.ok, false);
    assert.match(JSON.stringify(res2.error), /"cleanupPeriodDays\\" 2 times/);
  } finally {
    s.done();
  }
});

test('review: the guard is bound to a node the plan names; hs under another node is drift for plan, not a second copy at launch; a missing node is reported', () => {
  const s = sandbox();
  const real = process.execPath;
  try {
    const team = guardLayer(s);
    const gone = path.join(s.root, 'gone', 'bin', 'node');
    process.execPath = gone;
    const plan = ok(s.call('plan', { layers: [team], owner: 'builder' }));
    const op = plan.operations.find((o) => o.handler === 'json-element');
    assert.match(op.note, new RegExp(`bound to the node at ${gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: if that node is removed or moved .*every matching action in this folder is blocked until a plan is applied again`));
    assert.ok(plan.unverified.some((u) => /another Claude Code using this folder/.test(u)));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    process.execPath = real;
    // hs now runs under another node: the launch still counts the folder's group as installed,
    // names the missing node, and does not carry the hook a second time.
    const spec = ok(s.call('launch-spec', { layers: [team] }));
    assert.ok(spec.skipped.some((x) => x.item === 'hook.g'));
    assert.ok(spec.notes.some((n) => n.includes(`the node at ${gone}, which is missing, so every matching action is blocked`)));
    assert.equal(JSON.stringify(spec.files ?? []).includes('PreToolUse'), false, 'not carried in --settings');
    // A plan shows the drift as an update to the node hs runs under now.
    const again = ok(s.call('plan', { layers: [team], owner: 'builder' }));
    assert.deepEqual(again.operations.map((o) => [o.action, o.address_id]), [['update', 'settings.json#hooks/PreToolUse[hook.g]']]);
    assert.ok(again.operations[0].value.hooks[0].command.startsWith(real.includes(' ') ? `'${real}'` : real));
  } finally {
    process.execPath = real;
    s.done();
  }
});

test('review: a file that is not valid UTF-8 is never rewritten; a folder path with a line break is refused for a persisted hook', () => {
  const s = sandbox();
  try {
    const file = path.join(s.folder, 'settings.json');
    const bytes = Buffer.concat([Buffer.from('{\n  "model": "sonnet",\n  "x": "'), Buffer.from([0xff]), Buffer.from('"\n}\n')]);
    fs.writeFileSync(file, bytes);
    const res = s.call('plan', { layers: [guardLayer(s)], owner: 'builder' });
    assert.equal(res.ok, false);
    assert.match(JSON.stringify(res.error), /not valid UTF-8/);
    assert.throws(() => handlers['json-element'].write(s.folder, D, { file: 'settings.json', key: 'hooks/Stop', id: 'hook.g' }, { hooks: [] }), /not valid UTF-8/);
    assert.ok(fs.readFileSync(file).equals(bytes), 'the bytes are as they were');
  } finally {
    s.done();
  }
  const t = sandbox('2.1.307', { prefix: 'hs-line\nbreak-' });
  try {
    const res = t.call('plan', { layers: [guardLayer(t)], owner: 'builder' });
    assert.equal(res.ok, false);
    assert.match(JSON.stringify(res.error), /hook\.g.*line break or a control character/);
  } finally {
    t.done();
  }
});
