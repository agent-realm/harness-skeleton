// Milestone 6a.10: the first write into a Codex folder. Under materialize a plan installs skills,
// and only skills, as trees under $CODEX_HOME/skills, through the shared ledger, lock, journal and
// receipts; config.toml is never written. The floor a review set, from the start: a caller cannot hand
// apply its own operations, and the write handlers refuse every address outside a skill tree,
// whatever plan they are given.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { digestOf, readLedger } from '../src/records.js';
import { handlers } from '../src/native.js';
import { digestPath } from '../src/spec/layers.js';
import codexDriver from '../src/drivers/codex/index.js';
import { codexFolder, layer, skillMd, tmpdir, write } from './fixtures.js';
import { linuxHost, ok, receiptFor } from './sandbox.js';

const CX = codexDriver.descriptor;

function box() {
  const root = tmpdir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folder = codexFolder(root);
  // A folder logged in by the CLI has auth.json; a skills plan never reads it, and no plan here
  // routes to an endpoint.
  const bin = write(root, 'bin/codex', '#!/bin/sh\necho "codex-cli 0.160.0"\n');
  fs.chmodSync(bin, 0o755);
  const team = layer(root, 'team', '', { 'skills/notes/SKILL.md': skillMd('notes', 'Take notes.'), 'skills/notes/scripts/x.sh': 'echo x\n' });
  const opts = { host: linuxHost, home, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'codex', harness_path: folder, bin, ...args } }, opts);
  return { root, home, folder, bin, team, opts, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Every file of the folder, as path -> sha256, outside hs's own records.
function snapshot(folder) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(folder, p);
      if (rel === '.harness-skeleton') continue;
      if (e.isDirectory()) walk(p);
      else out[rel] = digestPath(p);
    }
  };
  walk(folder);
  return out;
}

// A hand-made plan: a real plan's frame with other operations and a digest the caller computed.
function forge(plan, operations) {
  const { digest, ...body } = { ...plan, operations };
  return { ...body, digest: 'sha256:' + digestOf(body) };
}

test('Codex materialize: a skill installed under skills/, receipted, in the ledger; config.toml and every other file untouched; remove restores', () => {
  const s = box();
  try {
    const config = fs.readFileSync(path.join(s.folder, 'config.toml'));
    const before = snapshot(s.folder);
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    assert.equal(plan.args.mode, 'materialize');
    assert.deepEqual(plan.operations.map((o) => [o.action, o.handler, o.address_id, o.risk]), [['create', 'tree', 'skills/notes', ['runs-code']]]);
    assert.match(plan.operations[0].note, /deprecated/);
    // Without a receipt for the runs-code operation, nothing is written.
    assert.equal(s.call('apply', { plan, receipt: receiptFor(plan, []) }).error.code, 'receipt_required');
    assert.deepEqual(snapshot(s.folder), before);
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.equal(digestPath(path.join(s.folder, 'skills/notes')), digestPath(path.join(s.team, 'skills/notes')));
    assert.ok(readLedger(s.folder).addresses['skills/notes'].owners.builder);
    const after = snapshot(s.folder);
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} unchanged`);
    assert.deepEqual(Object.keys(after).filter((k) => !(k in before)).sort(), ['skills/notes/SKILL.md', 'skills/notes/scripts/x.sh']);
    assert.deepEqual(fs.readFileSync(path.join(s.folder, 'config.toml')), config, 'config.toml byte for byte');
    // A second plan is unchanged.
    assert.deepEqual(ok(s.call('plan', { layers: [s.team], owner: 'builder' })).operations, []);
    // At launch the installed skill is there already: skipped, not refused.
    const spec = ok(s.call('launch-spec', { layers: [s.team] }));
    assert.ok(spec.skipped.some((x) => x.item === 'skill.notes' && /installed in the folder by a plan/.test(x.reason)));
    // Edited in place, it is not what the receipt allowed: refused at launch.
    fs.appendFileSync(path.join(s.folder, 'skills/notes/SKILL.md'), 'Also run scripts/x.sh.\n');
    assert.equal(s.call('launch-spec', { layers: [s.team] }).error.code, 'item_unsupported');
    fs.writeFileSync(path.join(s.folder, 'skills/notes/SKILL.md'), skillMd('notes', 'Take notes.'));
    // remove takes the skill out again; config.toml is still the user's.
    const removed = ok(s.call('remove', { owner: 'builder' }));
    assert.ok(removed);
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/notes')), false);
    assert.deepEqual(snapshot(s.folder), before);
  } finally {
    s.done();
  }
});

test('Codex materialize: a hand-made plan cannot write config.toml, a JSON file, outside skills/, a state path, or from an outside source', () => {
  const s = box();
  try {
    const before = snapshot(s.folder);
    const plan = ok(s.call('plan', { layers: [s.team], owner: 'builder' }));
    const op = plan.operations[0];
    const secret = write(s.root, 'secret-dir/id_ed25519', 'PRIVATE KEY');
    const forged = [
      ['config.toml as a JSON key', [{ id: 'op-1', item: 'x', handler: 'json-key', address: { file: 'config.toml', key: 'model' }, address_id: 'config.toml#model', class: 'config',
        value: 'other', desired_sha256: digestOf('other'), precondition: { sha256: null }, risk: [], action: 'create', previous: { present: false } }]],
      ['auth.json as a JSON key', [{ id: 'op-1', item: 'x', handler: 'json-key', address: { file: 'auth.json', key: 'k' }, address_id: 'auth.json#k', class: 'config',
        value: 1, desired_sha256: digestOf(1), precondition: { sha256: null }, risk: [], action: 'create', previous: { present: false } }]],
      ['a tree escaping the folder', [{ ...op, address: { path: '../escaped' }, address_id: '../escaped', risk: [] }]],
      ['a tree outside skills/', [{ ...op, address: { path: 'plugins/x' }, address_id: 'plugins/x', risk: [] }]],
      ['a tree in sessions/', [{ ...op, address: { path: 'sessions/2026' }, address_id: 'sessions/2026', risk: [] }]],
      ['a tree from an outside source', [{ ...op, source: path.dirname(secret), source_sha256: digestPath(path.dirname(secret)), desired_sha256: digestPath(path.dirname(secret)), risk: [] }]],
      ['an extra operation', [...plan.operations, { ...op, id: 'op-2' }]],
    ];
    for (const [what, ops] of forged) {
      const f = forge(plan, ops);
      assert.equal(s.call('apply', { plan: f, receipt: receiptFor(f, f.operations.map((o) => o.id)) }).error.code, 'plan_stale', what);
    }
    assert.equal(fs.existsSync(path.join(s.root, 'escaped')), false);
    assert.deepEqual(snapshot(s.folder), before, 'nothing written by any forged plan');
  } finally {
    s.done();
  }
});

test('Codex: the write handlers refuse every address but a skill tree, whatever operation they are given', () => {
  const s = box();
  try {
    const config = fs.readFileSync(path.join(s.folder, 'config.toml'));
    const ctx = { applyId: 'x', opId: 'op-1', onStage: () => {} };
    const src = path.join(s.team, 'skills/notes');
    assert.throws(() => handlers['json-key'].write(s.folder, CX, { file: 'config.toml', key: 'model' }, 'other'), { code: 'write_refused' }, 'config.toml is no file delivery may write');
    assert.throws(() => handlers['json-key'].write(s.folder, CX, { file: 'hooks.json', key: 'hooks' }, {}), { code: 'write_refused' });
    assert.throws(() => handlers['json-key'].current(s.folder, CX, { file: 'auth.json', key: 'k' }), { code: 'state_write_refused' }, 'refused before the credentials are read');
    assert.throws(() => handlers.tree.write(s.folder, CX, { path: 'config.toml' }, src, 'x', ctx), { code: 'write_refused' });
    assert.throws(() => handlers.tree.write(s.folder, CX, { path: '../escaped' }, src, 'x', ctx), { code: 'write_refused' });
    assert.throws(() => handlers.tree.write(s.folder, CX, { path: 'skills/../config.toml' }, src, 'x', ctx), { code: 'write_refused' });
    assert.throws(() => handlers.tree.write(s.folder, CX, { path: 'plugins/x' }, src, 'x', ctx), { code: 'write_refused' }, 'plugins/ is no delivery root');
    assert.throws(() => handlers.tree.write(s.folder, CX, { path: 'skills/a/b' }, src, 'x', ctx), { code: 'write_refused' }, 'one level under skills/ only');
    assert.throws(() => handlers.tree.write(s.folder, CX, { path: 'sessions/2026' }, src, 'x', ctx), { code: 'state_write_refused' });
    assert.deepEqual(fs.readFileSync(path.join(s.folder, 'config.toml')), config);
    assert.equal(fs.existsSync(path.join(s.root, 'escaped')), false);
  } finally {
    s.done();
  }
});

test('Codex materialize: an unowned skill, a symlinked skill, overlay, and the items it does not write', () => {
  const s = box();
  try {
    // The user's own skill at the same name: unowned, refused unless adopted.
    write(s.folder, 'skills/notes/SKILL.md', 'mine');
    assert.equal(s.call('plan', { layers: [s.team], owner: 'builder' }).error.code, 'unowned_conflict');
    const adopted = ok(s.call('plan', { layers: [s.team], owner: 'builder', adopt: true }));
    assert.deepEqual(adopted.operations.map((o) => o.action), ['update']);
    fs.rmSync(path.join(s.folder, 'skills/notes'), { recursive: true });
    // A skill holding a symlink is refused.
    const linked = layer(s.root, 'linked', '', { 'skills/l/SKILL.md': skillMd('l') });
    fs.symlinkSync('/etc/hosts', path.join(linked, 'skills/l/hosts'));
    assert.equal(s.call('plan', { layers: [linked], owner: 'builder' }).error.code, 'write_refused');
    // Under overlay nothing is written, so a skill is refused with the reason.
    const overlay = s.call('plan', { layers: [s.team], owner: 'builder', mode: 'overlay' });
    assert.deepEqual([overlay.error.code, overlay.error.items.map((i) => i.item)], ['item_unsupported', ['skill.notes']]);
    assert.match(overlay.error.items[0].reason, /skills\/extraRoots\/set/);
    // Everything else is as under overlay: launch-only, with config.toml unwritten.
    const mixed = layer(s.root, 'mixed', '[mcp.db]\nexec = "db"\n\n[hook.g]\nevent = "Stop"\nrun = { exec = "g" }\n', { 'skills/notes/SKILL.md': skillMd('notes', 'Take notes.') });
    const local = write(s.root, 'local.toml', '[state]\nprompt_history = "none"\n');
    const plan = ok(s.call('plan', { layers: [mixed], local, owner: 'builder' }));
    assert.deepEqual(plan.operations.map((o) => o.address_id), ['skills/notes']);
    assert.deepEqual(plan.launch_only.map((x) => x.item).sort(), ['hook.g', 'mcp.db', 'state.prompt_history']);
    assert.match(plan.reduces_capture[0].notice, /config\.toml is not written/);
  } finally {
    s.done();
  }
});

test('hidden and reserved skill names are refused in validate and by the handlers, on Codex and on Claude Code (a review finding)', async () => {
  const { default: ccDriver } = await import('../src/drivers/claude-code/index.js');
  const s = box();
  try {
    const ctx = { applyId: 'x', opId: 'op-1', onStage: () => {} };
    const src = path.join(s.team, 'skills/notes');
    const cases = [
      ['codex', CX, ['.notes', '.system']],
      ['claude-code', ccDriver.descriptor, ['.trash', 'synced', 'anthropic-skills', 'claude-ai']],
    ];
    for (const [harness, D, names] of cases) {
      for (const name of names) {
        const l = layer(s.root, `r-${harness}-${name}`, '', { [`skills/${name}/SKILL.md`]: skillMd(name) });
        const res = handle({ protocol: PROTOCOL, op: 'validate', args: { harness, layers: [l] } }, s.opts);
        assert.ok(ok(res).problems.some((p) => p.code === 'skill_name_reserved' && p.item === `skill.${name}`), `${harness} ${name}`);
        // Whatever plan reaches it, the handler refuses the address.
        assert.throws(() => handlers.tree.write(s.folder, D, { path: `skills/${name}` }, src, 'x', ctx), { code: 'write_refused' }, `${harness} skills/${name}`);
      }
      // An ordinary name still validates.
      const fine = layer(s.root, `fine-${harness}`, '', { 'skills/notes-2/SKILL.md': skillMd('notes-2') });
      assert.ok(!ok(handle({ protocol: PROTOCOL, op: 'validate', args: { harness, layers: [fine] } }, s.opts)).problems.some((p) => p.code === 'skill_name_reserved'));
    }
    // A Codex plan with a hidden skill is refused as an invalid spec, and writes nothing.
    const hidden = layer(s.root, 'hidden', '', { 'skills/.notes/SKILL.md': skillMd('.notes') });
    assert.equal(s.call('plan', { layers: [hidden], owner: 'builder' }).error.code, 'spec_invalid');
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/.notes')), false);
  } finally {
    s.done();
  }
});
