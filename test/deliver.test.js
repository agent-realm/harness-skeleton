// Delivery at tier 0 (design note v0.2 §10): plans against a golden file, apply then observe
// with no drift, a second plan unchanged, unmanaged keys kept, owners kept apart, a crash
// finished by recover, and state paths untouched. Fixture folders and a stub binary only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import * as delivery from '../src/deliver.js';
import { DEFAULT_RETENTION_DAYS } from '../src/defaults.js';
import { recordsDir, readLedger } from '../src/records.js';
import ccDriver from '../src/drivers/claude-code/index.js';
import { layer, skillMd, write } from './fixtures.js';
import { HOST, ok, planAndApply, receiptFor, sandbox, settings } from './sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Every sessions, history and credentials path, by digest (credentials by size and mtime only).
function stateSnapshot(folder) {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(folder, rel);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${n}` : n);
      return;
    }
    if (rel === '.credentials.json') out[rel] = `${st.size}:${st.mtimeMs}`;
    else out[rel] = fs.readFileSync(abs, 'base64');
  };
  for (const p of ['projects', 'history.jsonl', 'file-history', '.credentials.json']) walk(p);
  return out;
}

test('plan: matches the golden file', () => {
  const s = sandbox();
  try {
    const local = write(s.root, 'local.toml', '[state]\nretention_days = 120\n');
    const plan = ok(s.call('plan', { layers: [s.team], local, owner: 'builder' }));
    const normalized = JSON.parse(JSON.stringify(plan).split(s.root).join('<ROOT>'));
    delete normalized.digest; // digests cover absolute paths, which differ per run
    delete normalized.spec_digest;
    const golden = path.join(here, 'golden', 'plan-materialize.json');
    if (process.env.HS_UPDATE_GOLDEN === '1') fs.writeFileSync(golden, JSON.stringify(normalized, null, 2) + '\n');
    assert.deepEqual(normalized, JSON.parse(fs.readFileSync(golden, 'utf8')));
  } finally {
    s.done();
  }
});

test('apply, then observe shows no drift and a second plan is unchanged; unmanaged keys survive', () => {
  const s = sandbox();
  try {
    write(s.folder, 'settings.json', JSON.stringify({ model: 'sonnet', theme: 'dark' }));
    const before = stateSnapshot(s.folder);
    const { plan, res } = planAndApply(s, {});
    assert.deepEqual(plan.operations.map((o) => [o.item, o.action]), [['skill.notes', 'create'], ['state.retention_days', 'create']]);
    assert.deepEqual(res.operations.map((o) => o.action), ['create', 'create']);
    assert.deepEqual(settings(s.folder), { model: 'sonnet', theme: 'dark', cleanupPeriodDays: DEFAULT_RETENTION_DAYS });
    assert.ok(fs.existsSync(path.join(s.folder, 'skills/notes/SKILL.md')));

    const seen = ok(s.call('observe', {}));
    assert.deepEqual(seen.managed.map((m) => [m.address, m.drift]).sort(), [['settings.json#cleanupPeriodDays', 'none'], ['skills/notes', 'none']]);
    assert.deepEqual(seen.unmanaged.items.map((u) => u.address), ['settings.json#model', 'settings.json#theme', 'skills/demo']);
    assert.doesNotMatch(JSON.stringify(seen.unmanaged), /sonnet|dark/, 'unmanaged entries are named, values redacted');

    const again = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    assert.equal(again.unchanged, true);
    assert.deepEqual(stateSnapshot(s.folder), before, 'sessions, history and credentials are untouched');
    // the records: lock released, plan and receipt kept, journal complete
    const rec = recordsDir(s.folder);
    assert.equal(fs.existsSync(path.join(rec, 'lock')), false);
    assert.ok(fs.existsSync(path.join(rec, 'plans', `${plan.digest.slice(7)}.json`)));
    assert.ok(fs.existsSync(path.join(rec, 'receipts', `${plan.digest.slice(7)}.json`)));
    const journal = fs.readFileSync(path.join(rec, 'journal', `${res.apply_id}.jsonl`), 'utf8');
    assert.match(journal.trim().split('\n').at(-1), /"event":"complete"/);
  } finally {
    s.done();
  }
});

test('the retention default: 9999 when the spec sets none, never lowering a longer folder value', () => {
  const s = sandbox();
  try {
    let plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    const op = plan.operations.find((o) => o.item === 'state.retention_days');
    assert.deepEqual([op.value, op.address_id], [DEFAULT_RETENTION_DAYS, 'settings.json#cleanupPeriodDays']);
    assert.match(op.note, /question 8/);

    write(s.folder, 'settings.json', JSON.stringify({ cleanupPeriodDays: DEFAULT_RETENTION_DAYS + 1 }));
    plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    assert.equal(plan.operations.find((o) => o.item === 'state.retention_days'), undefined);
    assert.match(plan.skipped.find((x) => x.item === 'state.retention_days').reason, /never lowers it/);

    // an explicit shorter value is delivered, and listed under reduces capture
    const local = write(s.root, 'local.toml', '[state]\nretention_days = 7\nprompt_history = "none"\n');
    plan = ok(s.call('plan', { layers: [s.team], local, owner: 'builder', adopt: true }));
    assert.deepEqual(plan.reduces_capture, [{ item: 'state.retention_days', from: DEFAULT_RETENTION_DAYS + 1, to: 7, source: 'folder' }]);
    assert.ok(plan.skipped.some((x) => x.item === 'state.prompt_history'));
  } finally {
    s.done();
  }
});

test('managed policy: overridden_by_managed, and reduces capture when it keeps less', () => {
  const s = sandbox();
  try {
    const managed = path.join(s.root, 'managed');
    write(managed, 'managed-settings.json', JSON.stringify({ cleanupPeriodDays: 30 }));
    s.opts.state = { managedRoot: managed, mdmPlists: [] };
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    assert.deepEqual(plan.overridden_by_managed.map((x) => [x.item, x.managed]), [['state.retention_days', 30]]);
    assert.ok(plan.reduces_capture.some((x) => x.source === 'managed' && x.to === 30));
  } finally {
    s.done();
  }
});

test('receipts: required, bound to the plan digest, and naming every risky operation', () => {
  const s = sandbox();
  try {
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    assert.equal(s.call('apply', { plan }).error.code, 'receipt_required');
    assert.equal(s.call('apply', { plan, receipt: { ...receiptFor(plan), plan_digest: 'sha256:00' } }).error.code, 'receipt_required');
    const res = s.call('apply', { plan, receipt: receiptFor(plan, []) });
    assert.deepEqual([res.error.code, res.error.items], ['receipt_required', ['op-1']]);
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/notes')), false, 'nothing was written');
    assert.equal(fs.existsSync(path.join(recordsDir(s.folder), 'receipts')), false, 'a refused receipt is not recorded');
    const tampered = { ...plan, operations: plan.operations.map((o) => ({ ...o, value: 1 })) };
    assert.equal(s.call('apply', { plan: tampered, receipt: receiptFor(plan) }).error.code, 'plan_tampered');
  } finally {
    s.done();
  }
});

test('preconditions: a folder changed after planning refuses before any write', () => {
  const s = sandbox();
  try {
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    write(s.folder, 'settings.json', JSON.stringify({ model: 'opus', cleanupPeriodDays: 5 }));
    const res = s.call('apply', { plan, receipt: receiptFor(plan) });
    // apply derives the plan again under the lock; the folder now has an unowned key there
    assert.equal(res.error.code, 'unowned_conflict');
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/notes')), false, 'refused before the first write');

    // a precondition covers the managed key only: another key may change between plan and apply
    const fresh = ok(s.call('plan', { layers: [s.team], owner: 'builder', adopt: true }));
    write(s.folder, 'settings.json', JSON.stringify({ model: 'haiku', cleanupPeriodDays: 5 }));
    ok(s.call('apply', { plan: fresh, receipt: receiptFor(fresh) }));
    assert.deepEqual(settings(s.folder), { model: 'haiku', cleanupPeriodDays: DEFAULT_RETENTION_DAYS });
    ok(s.call('remove', { owner: 'builder' }));
    assert.deepEqual(settings(s.folder), { model: 'haiku', cleanupPeriodDays: 5 }, 'remove restores the adopted value');
    write(s.team, 'skills/notes/SKILL.md', skillMd('notes', 'changed'));
    const plan2 = ok(s.call('plan', { layers: [s.team], owner: 'builder', adopt: true }));
    write(s.team, 'skills/notes/SKILL.md', skillMd('notes', 'changed again'));
    assert.equal(s.call('apply', { plan: plan2, receipt: receiptFor(plan2) }).error.code, 'plan_stale');
  } finally {
    s.done();
  }
});

test('unowned items: refused, or adopted with --adopt; another owner\'s content is a conflict', () => {
  const s = sandbox();
  try {
    write(s.folder, 'skills/notes/SKILL.md', 'hand-made');
    let res = s.call('plan', { layers: [s.team], owner: 'builder' });
    assert.equal(res.error.code, 'unowned_conflict');
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder', adopt: true }));
    assert.equal(plan.operations.find((o) => o.item === 'skill.notes').action, 'update');
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));

    const other = layer(s.root, 'other', '', { 'skills/notes/SKILL.md': skillMd('notes', 'other content') });
    res = s.call('plan', { layers: [other], owner: 'other-tool' });
    assert.equal(res.error.code, 'owner_conflict');
  } finally {
    s.done();
  }
});

test('two owners: a shared address stays until its last owner removes it; prune touches one owner only', () => {
  const s = sandbox();
  try {
    write(s.folder, 'settings.json', JSON.stringify({ cleanupPeriodDays: 45 }));
    const local = write(s.root, 'local.toml', '[state]\nretention_days = 400\n');
    const a = layer(s.root, 'a', '', { 'skills/alpha/SKILL.md': skillMd('alpha') });
    const b = layer(s.root, 'b', '', { 'skills/beta/SKILL.md': skillMd('beta') });
    const run = (owner, layers, extra = {}) => {
      const plan = ok(s.call('plan', { layers, local, owner, adopt: true, ...extra }));
      return ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    };
    run('builder', [a]);
    run('other-tool', [b]);
    const ledger = readLedger(s.folder);
    assert.deepEqual(Object.keys(ledger.addresses['settings.json#cleanupPeriodDays'].owners).sort(), ['builder', 'other-tool']);

    // builder drops alpha from its spec and prunes: beta (other-tool) is untouched
    const empty = layer(s.root, 'empty', '');
    run('builder', [empty], { prune: true });
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/alpha')), false);
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/beta')), true);

    // builder removes everything: the shared key stays for other-tool
    ok(s.call('remove', { owner: 'builder' }));
    assert.equal(settings(s.folder).cleanupPeriodDays, 400);
    // other-tool removes: the key goes back to what it was before the first owner
    ok(s.call('remove', { owner: 'other-tool' }));
    assert.equal(settings(s.folder).cleanupPeriodDays, 45);
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/beta')), false);
    assert.deepEqual(readLedger(s.folder).addresses, {});
  } finally {
    s.done();
  }
});

test('remove: a key the folder did not have is deleted; a drifted item is left and reported', () => {
  const s = sandbox();
  try {
    write(s.folder, 'settings.json', JSON.stringify({ model: 'sonnet' }));
    planAndApply(s, {});
    write(s.folder, 'skills/notes/SKILL.md', 'edited by hand');
    const res = ok(s.call('remove', { owner: 'builder' }));
    assert.deepEqual(settings(s.folder), { model: 'sonnet' });
    assert.ok(res.skipped.some((x) => x.item === 'skill.notes'));
    assert.equal(fs.readFileSync(path.join(s.folder, 'skills/notes/SKILL.md'), 'utf8'), 'edited by hand');
  } finally {
    s.done();
  }
});

test('a crash mid-apply is finished by recover; state paths stay untouched throughout', () => {
  const s = sandbox();
  try {
    const before = stateSnapshot(s.folder);
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    const crashed = handle({ protocol: PROTOCOL, op: 'apply', args: { harness: 'claude-code', harness_path: s.folder, bin: s.bin, plan, receipt: receiptFor(plan) } },
      { ...s.opts, crashAfter: 1 });
    assert.equal(crashed.ok, false);
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/notes')), true);
    assert.equal(settings(s.folder).cleanupPeriodDays, undefined, 'the second operation never ran');

    // a new plan cannot run until recover has finished the old one
    const plan2 = ok(s.call('plan', { layers: [s.team], owner: 'builder', adopt: true }));
    assert.equal(s.call('apply', { plan: plan2, receipt: receiptFor(plan2) }).error.code, 'recover_first');

    const rec = ok(s.call('recover', {}));
    assert.deepEqual(rec.recovered.map((r) => r.finished), [['op-2']]);
    assert.equal(settings(s.folder).cleanupPeriodDays, DEFAULT_RETENTION_DAYS);
    assert.equal(ok(s.call('plan', { layers: [s.team], owner: 'builder' })).unchanged, true);
    ok(s.call('remove', { owner: 'builder' }));
    assert.deepEqual(stateSnapshot(s.folder), before);
  } finally {
    s.done();
  }
});

test('locks: a live harness session or held lock is folder_busy; a stale lock is taken over by recover only', () => {
  const s = sandbox();
  try {
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    write(s.folder, `sessions/${process.pid}.json`, '{}');
    // A harness running in the folder is transient: retryable (a review finding).
    assert.deepEqual(['code', 'retryable'].map((k) => s.call('apply', { plan, receipt: receiptFor(plan) }).error[k]), ['folder_busy', true]);
    fs.rmSync(path.join(s.folder, `sessions/${process.pid}.json`));

    fs.mkdirSync(path.join(s.folder, '.claude.json.lock'));
    assert.equal(s.call('apply', { plan, receipt: receiptFor(plan) }).error.code, 'folder_busy');
    fs.rmSync(path.join(s.folder, '.claude.json.lock'), { recursive: true });

    const dead = spawnSync('true').pid;
    write(s.folder, '.harness-skeleton/lock', JSON.stringify({ pid: dead, host: HOST, op: 'apply' }));
    const res = s.call('apply', { plan, receipt: receiptFor(plan) });
    assert.equal(res.error.code, 'folder_busy');
    assert.match(res.error.message, /stale.*recover/);
    assert.equal(res.error.retryable, false, 'only recover clears a stale lock');
    ok(s.call('recover', {}));
    assert.equal(fs.existsSync(path.join(s.folder, '.harness-skeleton/lock')), false);
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));

    write(s.folder, '.harness-skeleton/lock', JSON.stringify({ pid: process.pid, host: HOST, op: 'apply' }));
    const held = s.call('recover', {});
    assert.equal(held.error.code, 'folder_busy', 'a live holder is never taken over');
    assert.equal(held.error.retryable, true, 'a lock held by a live process is transient');
  } finally {
    s.done();
  }
});

test('refusals: a symlinked settings.json or skills dir, a state path, kinds this build does not deliver', () => {
  const s = sandbox();
  try {
    const outside = write(s.root, 'dotfiles/settings.json', '{}');
    fs.rmSync(path.join(s.folder, 'settings.json'));
    fs.symlinkSync(outside, path.join(s.folder, 'settings.json'));
    let res = s.call('plan', { layers: [s.team], owner: 'builder' });
    assert.equal(res.error.code, 'write_refused');
    assert.match(JSON.stringify(res.error.items), /symlink/);
    fs.rmSync(path.join(s.folder, 'settings.json'));

    fs.rmSync(path.join(s.folder, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(s.root, 'shared-skills'));
    fs.symlinkSync(path.join(s.root, 'shared-skills'), path.join(s.folder, 'skills'));
    res = s.call('plan', { layers: [s.team], owner: 'builder' });
    assert.equal(res.error.code, 'write_refused');
    fs.rmSync(path.join(s.folder, 'skills'));

    // a driver that maps an item onto a transcript is refused, whatever it asks
    const evil = { ...ccDriver, deliverables: () => ({
      deliverables: [{ item: 'x', handler: 'json-key', address: { file: 'projects/-work-repo/aaaa.jsonl', key: 'k' }, address_id: 'projects/-work-repo/aaaa.jsonl#k', value: 1, risk: [] }],
      not_implemented: [], skipped: [], reduces_capture: [], overridden_by_managed: [] }) };
    assert.throws(() => delivery.plan(evil, { harness_path: s.folder, layers: [s.team], owner: 'builder', bin: s.bin }, s.opts), { code: 'state_write_refused' });

    // the records directory itself linked out of the folder
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    fs.mkdirSync(path.join(s.root, 'elsewhere'));
    fs.symlinkSync(path.join(s.root, 'elsewhere'), path.join(s.folder, '.harness-skeleton'));
    assert.equal(s.call('apply', { plan, receipt: receiptFor(plan) }).error.code, 'write_refused');
    assert.deepEqual(fs.readdirSync(path.join(s.root, 'elsewhere')), []);
    fs.rmSync(path.join(s.folder, '.harness-skeleton'));

    const mcp = layer(s.root, 'mcp', '[mcp.db]\nexec = "db-mcp"\n', { 'AGENTS.md': '# rules\n' });
    res = s.call('plan', { layers: [mcp], owner: 'builder' });
    assert.deepEqual([res.error.code, res.error.items], ['not_implemented', ['instructions (AGENTS.md)']], 'an MCP server is carried at launch since 6a.4');
    const onlyMcp = layer(s.root, 'mcp-only', '[mcp.db]\nexec = "db-mcp"\n');
    // Under overlay an MCP server is carried at launch; under materialize it persists in user
    // scope since 6a.12 (test/mcp-materialize.test.js).
    assert.ok(ok(s.call('plan', { layers: [onlyMcp], owner: 'builder', mode: 'overlay' })).launch_only.some((x) => x.item === 'mcp.db' && /--mcp-config/.test(x.via)));
    assert.ok(ok(s.call('plan', { layers: [onlyMcp], owner: 'builder' })).operations.some((o) => o.address_id === '.claude.json#mcpServers/db'));
    // Codex plans materialize for skills since 6a.10 (test/codex-materialize.test.js).
  } finally {
    s.done();
  }
});

test('versions and arguments: outside the range refuses; strict refuses compatible; owners and modes are checked', () => {
  const s = sandbox('2.0.1');
  try {
    assert.equal(s.call('plan', { layers: [s.team], owner: 'builder' }).error.code, 'version_unsupported');
  } finally {
    s.done();
  }
  const t = sandbox();
  try {
    assert.equal(t.call('plan', { layers: [t.team], owner: 'builder', strict_version: true }).error.code, 'version_unsupported');
    assert.match(ok(t.call('plan', { layers: [t.team], owner: 'builder' })).warnings.join(), /uncertified_version/);
    assert.equal(t.call('plan', { layers: [t.team], owner: 'Bad Owner' }).error.code, 'bad_request');
    // Under overlay a skill is carried at launch, under a launch receipt (6a.3), never written.
    assert.ok(ok(t.call('plan', { layers: [t.team], owner: 'builder', mode: 'overlay' })).launch_only.some((x) => x.item === 'skill.notes' && /launch receipt/.test(x.via)));
    const bad = layer(t.root, 'bad', '[refs.X]\ndescription = "x"\n');
    assert.equal(t.call('plan', { layers: [bad], owner: 'builder' }).error.code, 'spec_invalid');
  } finally {
    t.done();
  }
});
