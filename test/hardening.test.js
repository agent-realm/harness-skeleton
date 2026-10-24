// A review's fix round: a caller cannot hand apply its own operations; the write handlers hold
// a floor of their own; replaced trees stay in the records; the lock, the journal and recover
// survive crashes; shared and default items are never lost to another owner or to --prune.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { DEFAULT_RETENTION_DAYS } from '../src/defaults.js';
import { acquireLock, digestOf, readLedger, recordsDir } from '../src/records.js';
import { handlers } from '../src/native.js';
import { digestPath } from '../src/spec/layers.js';
import ccDriver from '../src/drivers/claude-code/index.js';
import { layer, skillMd, write } from './fixtures.js';
import { HOST, ok, planAndApply, receiptFor, sandbox, settings } from './sandbox.js';

const D = ccDriver.descriptor;

// A hand-made plan: a real plan's frame with other operations and a digest the caller computed.
function forge(plan, operations) {
  const { digest, ...body } = { ...plan, operations };
  return { ...body, digest: 'sha256:' + digestOf(body) };
}

function journalOf(s) {
  const dir = path.join(recordsDir(s.folder), 'journal');
  return path.join(dir, fs.readdirSync(dir).sort().at(-1));
}

test('a hand-made plan cannot write outside the folder, into credentials, or from an outside source', () => {
  const s = sandbox();
  try {
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    const cred = path.join(s.folder, '.credentials.json');
    const credBefore = fs.readFileSync(cred);
    const secret = write(s.root, 'secret-dir/id_ed25519', 'PRIVATE KEY');

    const escape = forge(plan, [{ ...plan.operations[0], address: { path: '../escaped' }, address_id: '../escaped', risk: [] }]);
    let res = s.call('apply', { plan: escape, receipt: receiptFor(escape, []) });
    assert.equal(res.error.code, 'plan_stale');
    assert.equal(fs.existsSync(path.join(s.root, 'escaped')), false);

    const plant = forge(plan, [{ id: 'op-1', item: 'x', handler: 'json-key', address: { file: '.credentials.json', key: 'planted' }, address_id: '.credentials.json#planted',
      class: 'config', value: 'y', desired_sha256: digestOf('y'), precondition: { sha256: null }, risk: [], action: 'create', previous: { present: false } }]);
    res = s.call('apply', { plan: plant, receipt: receiptFor(plant, []) });
    assert.equal(res.error.code, 'plan_stale');
    assert.deepEqual(fs.readFileSync(cred), credBefore);

    const steal = forge(plan, [{ ...plan.operations[0], source: path.dirname(secret), source_sha256: digestPath(path.dirname(secret)), desired_sha256: digestPath(path.dirname(secret)), risk: [] }]);
    res = s.call('apply', { plan: steal, receipt: receiptFor(steal, []) });
    assert.equal(res.error.code, 'plan_stale');
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/notes')), false);

    // a forged operation list with the real arguments is stale; changing the recorded arguments
    // instead only makes another legitimate plan, which the receipt then has to name
    const extra = forge(plan, [...plan.operations, { ...plan.operations[0], id: 'op-3' }]);
    assert.equal(s.call('apply', { plan: extra, receipt: receiptFor(extra) }).error.code, 'plan_stale');
  } finally {
    s.done();
  }
});

test('the write handlers refuse a bad address whatever operation they are given', () => {
  const s = sandbox();
  try {
    const ctx = { applyId: 'x', opId: 'op-1', onStage: () => {} };
    assert.throws(() => handlers.tree.write(s.folder, D, { path: '../escaped' }, s.team, 'x', ctx), { code: 'write_refused' });
    assert.throws(() => handlers.tree.write(s.folder, D, { path: 'skills/../../escaped' }, s.team, 'x', ctx), { code: 'write_refused' });
    assert.throws(() => handlers.tree.write(s.folder, D, { path: 'plugins/x' }, s.team, 'x', ctx), { code: 'write_refused' }, 'plugins/ is not a delivery root');
    assert.throws(() => handlers.tree.write(s.folder, D, { path: 'projects/-work-repo/aaaa' }, s.team, 'x', ctx), { code: 'state_write_refused' });
    assert.throws(() => handlers.tree.write(s.folder, D, { path: 'projects/x' }, s.team, 'x', ctx), { code: 'write_refused' });
    assert.throws(() => handlers['json-key'].current(s.folder, D, { file: '.credentials.json', key: 'k' }), { code: 'state_write_refused' }, 'refused before the file is read');
    assert.throws(() => handlers['json-key'].write(s.folder, D, { file: 'settings.local.json', key: 'k' }, 1), { code: 'write_refused' });
    assert.throws(() => handlers['json-key'].write(s.folder, D, { file: '/etc/passwd', key: 'k' }, 1), { code: 'write_refused' });
    assert.equal(fs.existsSync(path.join(s.root, 'escaped')), false);
  } finally {
    s.done();
  }
});

test('--adopt keeps the user\'s own skill in the records and gives it back on the last remove; reset keeps the drift', () => {
  const s = sandbox();
  try {
    const original = skillMd('notes', 'the user wrote this');
    write(s.folder, 'skills/notes/SKILL.md', original);
    const { plan, res } = planAndApply(s, { adopt: true });
    assert.equal(plan.operations.find((o) => o.item === 'skill.notes').action, 'update');
    const prev = readLedger(s.folder).addresses['skills/notes'].previous;
    assert.equal(fs.readFileSync(path.join(s.folder, prev.tree, 'SKILL.md'), 'utf8'), original);
    assert.match(prev.tree, new RegExp(`replaced/${res.apply_id}/op-1/notes$`));

    // the user edits the managed skill; the next materialize resets it and keeps the edit
    write(s.folder, 'skills/notes/SKILL.md', skillMd('notes', 'edited after delivery'));
    const reset = planAndApply(s, {});
    assert.equal(reset.plan.operations.find((o) => o.item === 'skill.notes').action, 'reset');
    const kept = path.join(recordsDir(s.folder), 'replaced', reset.res.apply_id, 'op-1', 'notes', 'SKILL.md');
    assert.match(fs.readFileSync(kept, 'utf8'), /edited after delivery/);

    ok(s.call('remove', { owner: 'builder' }));
    assert.equal(fs.readFileSync(path.join(s.folder, 'skills/notes/SKILL.md'), 'utf8'), original, 'the user\'s skill is back');
  } finally {
    s.done();
  }
});

test('a skill holding a symlink is refused', () => {
  const s = sandbox();
  try {
    fs.symlinkSync('../../.credentials.json', path.join(s.team, 'skills/notes/notes.md'));
    const res = s.call('plan', { layers: [s.team], owner: 'builder' });
    assert.equal(res.error.code, 'write_refused');
    assert.match(res.error.message, /skill\.notes/);
  } finally {
    s.done();
  }
});

test('lock: never empty, a stale or unreadable lock is taken by recover only, release only by its holder', () => {
  const s = sandbox();
  try {
    const lockFile = path.join(recordsDir(s.folder), 'lock');
    write(s.folder, '.harness-skeleton/lock', '');
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    const res = s.call('apply', { plan, receipt: receiptFor(plan) });
    assert.equal(res.error.code, 'folder_busy');
    assert.match(res.error.message, /cannot be read.*recover/);
    ok(s.call('recover', {}));
    assert.equal(fs.existsSync(lockFile), false);

    // the takeover race: another taker replaces the stale lock with a fresh one between this
    // taker's read and its rename; the fresh lock is put back and this taker stands down
    write(s.folder, '.harness-skeleton/lock', JSON.stringify({ pid: 9999999, host: HOST, op: 'apply', nonce: 'dead' }));
    const fresh = JSON.stringify({ pid: process.pid, host: HOST, op: 'recover', nonce: 'winner' });
    assert.throws(() => acquireLock(s.folder, { op: 'recover', takeStale: true, host: HOST, beforeTakeover: () => {
      fs.rmSync(lockFile);
      fs.writeFileSync(lockFile, fresh);
    } }), { code: 'folder_busy', message: /taken by another process/ });
    assert.equal(fs.readFileSync(lockFile, 'utf8'), fresh, 'the winner keeps its lock');
    fs.rmSync(lockFile);

    const held = acquireLock(s.folder, { op: 'test', host: HOST });
    const body = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(typeof body.nonce, 'string');
    fs.writeFileSync(lockFile, JSON.stringify({ ...body, nonce: 'someone-else' }));
    held.release();
    assert.equal(fs.existsSync(lockFile), true, 'a lock that is no longer ours is not removed');
  } finally {
    s.done();
  }
});

test('journal: a torn last line is dropped and reported; a bad line elsewhere stops recover', () => {
  const s = sandbox();
  try {
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    handle({ protocol: PROTOCOL, op: 'apply', args: { harness: 'claude-code', harness_path: s.folder, bin: s.bin, plan, receipt: receiptFor(plan) } }, { ...s.opts, crashAfter: 1 });
    const j = journalOf(s);
    fs.appendFileSync(j, '{"event":"op-be');
    const rec = ok(s.call('recover', {}));
    assert.equal(rec.recovered[0].torn_journal_line, true);
    assert.equal(settings(s.folder).cleanupPeriodDays, DEFAULT_RETENTION_DAYS);
    // recover's own events were appended after the fragment, on lines of their own
    const after = fs.readFileSync(j, 'utf8').split('\n').filter(Boolean);
    assert.equal(after.filter((l) => l.startsWith('{"event":"op-be') && !l.endsWith('}')).length, 1, 'the fragment is a line of its own');
    assert.equal(JSON.parse(after[after.indexOf('{"event":"op-be') + 1]).after_torn, true);
    // and the folder is not blocked: the next apply runs
    const next = ok(s.call('plan', { layers: [layer(s.root, 'next', '', { 'skills/next/SKILL.md': skillMd('next') })], owner: 'builder', prune: false }));
    ok(s.call('apply', { plan: next, receipt: receiptFor(next) }));

    const plan2 = ok(s.call('plan', { layers: [layer(s.root, 'more', '', { 'skills/more/SKILL.md': skillMd('more') })], owner: 'other' }));
    handle({ protocol: PROTOCOL, op: 'apply', args: { harness: 'claude-code', harness_path: s.folder, bin: s.bin, plan: plan2, receipt: receiptFor(plan2) } }, { ...s.opts, crashAfter: 0 });
    const lines = fs.readFileSync(journalOf(s), 'utf8').split('\n');
    fs.writeFileSync(journalOf(s), ['not json', ...lines].join('\n'));
    assert.equal(s.call('recover', {}).error.code, 'recover_failed');
  } finally {
    s.done();
  }
});

test('recover checks what the journal calls done, and writes nothing when any address conflicts', () => {
  const s = sandbox();
  try {
    let plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    handle({ protocol: PROTOCOL, op: 'apply', args: { harness: 'claude-code', harness_path: s.folder, bin: s.bin, plan, receipt: receiptFor(plan) } }, { ...s.opts, crashAfter: 2 });
    // both operations are journaled done, but the key's rename was lost
    write(s.folder, 'settings.json', '{}');
    ok(s.call('recover', {}));
    assert.equal(settings(s.folder).cleanupPeriodDays, DEFAULT_RETENTION_DAYS, 'recover looked, and wrote it again');
    ok(s.call('remove', { owner: 'builder' }));

    plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    handle({ protocol: PROTOCOL, op: 'apply', args: { harness: 'claude-code', harness_path: s.folder, bin: s.bin, plan, receipt: receiptFor(plan) } }, { ...s.opts, crashAfter: 0 });
    write(s.folder, 'settings.json', JSON.stringify({ cleanupPeriodDays: 5 })); // neither absent nor 9999
    assert.equal(s.call('recover', {}).error.code, 'recover_failed');
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/notes')), false, 'the pending skill was not installed either');
  } finally {
    s.done();
  }
});

test('a crash between the two renames of a tree swap is finished by recover, from either side', () => {
  for (const variant of ['staged', 'aside']) {
    const s = sandbox();
    try {
      planAndApply(s, {});
      const v1 = digestPath(path.join(s.folder, 'skills/notes'));
      write(s.team, 'skills/notes/SKILL.md', skillMd('notes', 'version two'));
      const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
      const op = plan.operations.find((o) => o.item === 'skill.notes');
      const crashed = handle({ protocol: PROTOCOL, op: 'apply', args: { harness: 'claude-code', harness_path: s.folder, bin: s.bin, plan, receipt: receiptFor(plan) } },
        { ...s.opts, crashMidSwap: op.id });
      assert.equal(crashed.ok, false);
      assert.equal(fs.existsSync(path.join(s.folder, 'skills/notes')), false, 'the address is empty between the renames');
      if (variant === 'aside') {
        // the staged copy is lost too: recover puts the old tree back, then installs again
        const stage = fs.readFileSync(journalOf(s), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'op-stage');
        fs.rmSync(path.join(s.folder, stage.staged), { recursive: true });
      }
      ok(s.call('recover', {}));
      assert.equal(digestPath(path.join(s.folder, 'skills/notes')), op.desired_sha256);
      assert.notEqual(op.desired_sha256, v1);
      assert.equal(ok(s.call('plan', { layers: [s.team], owner: 'builder' })).unchanged, true);
    } finally {
      s.done();
    }
  }
});

test('a shared address is never updated by one owner alone', () => {
  const s = sandbox();
  try {
    planAndApply(s, {});
    const same = layer(s.root, 'same', '', { 'skills/notes/SKILL.md': skillMd('notes', 'Take notes.') });
    const shared = ok(s.call('plan', { layers: [same], owner: 'other-tool' }));
    assert.equal(shared.operations.find((o) => o.item === 'skill.notes').action, 'share');
    ok(s.call('apply', { plan: shared, receipt: receiptFor(shared) }));

    write(s.team, 'skills/notes/SKILL.md', skillMd('notes', 'builder wants a change'));
    const res = s.call('plan', { layers: [s.team], owner: 'builder' });
    assert.equal(res.error.code, 'owner_conflict');
  } finally {
    s.done();
  }
});

test('ownership is checked again under the lock: a prune planned before another owner shares is stale', () => {
  const s = sandbox();
  try {
    const a = layer(s.root, 'a', '', { 'skills/alpha/SKILL.md': skillMd('alpha') });
    const run = (owner, layers, extra = {}) => {
      const plan = ok(s.call('plan', { layers, owner, ...extra }));
      return ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    };
    run('builder', [a]);
    const prune = ok(s.call('plan', { layers: [layer(s.root, 'none', '')], owner: 'builder', prune: true }));
    assert.ok(prune.operations.some((o) => o.item === 'skill.alpha' && o.action === 'remove'));
    run('other-tool', [layer(s.root, 'a2', '', { 'skills/alpha/SKILL.md': skillMd('alpha') })]);
    const res = s.call('apply', { plan: prune, receipt: receiptFor(prune) });
    assert.equal(res.error.code, 'plan_stale');
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/alpha')), true);
  } finally {
    s.done();
  }
});

test('--prune never takes away the default retention this owner installed', () => {
  const s = sandbox();
  try {
    planAndApply(s, {});
    assert.equal(settings(s.folder).cleanupPeriodDays, DEFAULT_RETENTION_DAYS);
    const again = ok(s.call('plan', { layers: [s.team], owner: 'builder', prune: true }));
    assert.equal(again.unchanged, true, JSON.stringify(again.operations));
  } finally {
    s.done();
  }
});

test('the default folder: a fresh ~/.claude.json.lock beside it makes the folder busy', () => {
  const s = sandbox('2.1.307', { defaultFolder: true });
  try {
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    fs.mkdirSync(path.join(s.home, '.claude.json.lock'));
    assert.equal(s.call('apply', { plan, receipt: receiptFor(plan) }).error.code, 'folder_busy');
    fs.rmSync(path.join(s.home, '.claude.json.lock'), { recursive: true });
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
  } finally {
    s.done();
  }
});

test('records: a symlinked plans/, journal/ or tmp/ under .harness-skeleton/ is refused', () => {
  for (const sub of ['plans', 'journal', 'tmp', 'replaced']) {
    const s = sandbox();
    try {
      const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
      fs.mkdirSync(path.join(s.folder, '.harness-skeleton'), { recursive: true });
      fs.mkdirSync(path.join(s.root, 'outside'));
      fs.symlinkSync(path.join(s.root, 'outside'), path.join(s.folder, '.harness-skeleton', sub));
      assert.equal(s.call('apply', { plan, receipt: receiptFor(plan) }).error.code, 'write_refused', sub);
      assert.deepEqual(fs.readdirSync(path.join(s.root, 'outside')), [], sub);
    } finally {
      s.done();
    }
  }
});
