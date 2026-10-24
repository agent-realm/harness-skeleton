// Milestone 6a.3: launch-time receipts (design note §7.5), with skills at launch as their first
// consumer. A launch that carries an item that may run code is refused until a receipt names its
// launch digest and allows the item; the refusal comes before anything is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { resolve } from '../src/spec/layers.js';
import { codexFolder, layer, skillMd, write } from './fixtures.js';
import { linuxHost, ok, planAndApply, sandbox } from './sandbox.js';

// A sandbox whose launch temp dirs go under its own root, so a refusal can be seen to make none.
function box(version) {
  const s = sandbox(version);
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  return s;
}
const receiptFor = (refused, over = {}) => ({
  format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest,
  allows: refused.error.items[0].risks.map((r) => r.item), by: 'test', at: '2026-10-22T18:00:00Z', ...over,
});
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

test('a skill at launch: refused without a receipt, before any write; with one, a plugin directory in the temp dir', () => {
  const s = box();
  try {
    const before = tree(s.folder);
    const refused = s.call('launch-spec', { layers: [s.team] });
    assert.equal(refused.error.code, 'receipt_required');
    const [{ launch_digest, risks }] = refused.error.items;
    assert.match(launch_digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(risks, [{ item: 'skill.notes', layer: 'team', risk: 'runs-code', sha256: resolve([s.team]).files[0].sha256 }]);
    assert.deepEqual(fs.readdirSync(s.opts.tmpdir), [], 'a refused launch makes no temp dir');

    const spec = ok(s.call('launch-spec', { layers: [s.team], receipt: receiptFor(refused) }));
    assert.equal(spec.launch_digest, launch_digest, 'the digest leaves temp paths out');
    assert.deepEqual(spec.receipt, { by: 'test', at: '2026-10-22T18:00:00Z' });
    const plugin = spec.files.find((f) => f.role === 'plugin');
    assert.deepEqual(spec.argv.slice(0, 3), [s.bin, '--plugin-dir', plugin.path], 'the binary it probed, by its path');
    assert.ok(plugin.path.startsWith(spec.temp_dir + path.sep));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin.path, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'hs');
    assert.equal(fs.readFileSync(path.join(plugin.path, 'skills', 'notes', 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(s.team, 'skills', 'notes', 'SKILL.md'), 'utf8'));
    assert.ok(spec.launch_items.some((x) => x.item === 'skill.notes' && x.via === '--plugin-dir, as /hs:notes'));
    assert.ok(spec.notes.some((n) => /namespaced: \/hs:<name>/.test(n)));
    assert.deepEqual(tree(s.folder), before, 'nothing written into the data folder');

    const again = ok(s.call('launch-spec', { layers: [s.team], receipt: receiptFor(refused) }));
    assert.equal(again.launch_digest, launch_digest, 'the same launch, another temp dir, the same digest');
    assert.notEqual(again.temp_dir, spec.temp_dir);
  } finally {
    s.done();
  }
});

test('the receipt must name this launch, and allow every risky item; any change asks again', () => {
  const s = box();
  try {
    const refused = s.call('launch-spec', { layers: [s.team] });
    const code = (args) => s.call('launch-spec', { layers: [s.team], ...args }).error?.code;
    assert.equal(code({ receipt: receiptFor(refused, { launch_digest: 'sha256:' + '0'.repeat(64) }) }), 'receipt_required');
    assert.equal(code({ receipt: receiptFor(refused, { allows: [] }) }), 'receipt_required');
    assert.equal(code({ receipt: receiptFor(refused, { format: 'hs-receipt/0.1' }) }), 'receipt_required');
    assert.equal(code({ receipt: { ...receiptFor(refused), plan_digest: 'x', launch_digest: undefined } }), 'receipt_required', 'a plan receipt is not a launch receipt');

    // An edited skill is another launch.
    fs.appendFileSync(path.join(s.team, 'skills', 'notes', 'SKILL.md'), '\nRun scripts/evil.sh.\n');
    assert.equal(code({ receipt: receiptFor(refused) }), 'receipt_required');
    const edited = s.call('launch-spec', { layers: [s.team] });
    assert.notEqual(edited.error.items[0].launch_digest, refused.error.items[0].launch_digest);

    // So is another folder, and another harness version.
    const other = path.join(s.root, 'other-folder');
    fs.cpSync(s.folder, other, { recursive: true });
    const elsewhere = handle({ protocol: PROTOCOL, op: 'launch-spec', args: { harness: 'claude-code', harness_path: other, bin: s.bin, layers: [s.team], receipt: receiptFor(edited) } }, s.opts);
    assert.equal(elsewhere.error.code, 'receipt_required');
    // The same binary path, folder and layers; only the version it reports differs.
    fs.writeFileSync(s.bin, '#!/bin/sh\necho "2.1.308 (Claude Code)"\n');
    const v = s.call('launch-spec', { layers: [s.team] });
    assert.notEqual(v.error.items[0].launch_digest, edited.error.items[0].launch_digest, 'a harness upgrade asks again');
    // A binary that cannot be asked has no version to bind: a named one that does not answer.
    assert.equal(s.call('launch-spec', { layers: [s.team], bin: path.join(s.root, 'no-such-claude') }).error.code, 'probe_failed');
  } finally {
    s.done();
  }
});

test('a launch with nothing risky needs no receipt, and still names its digest', () => {
  const s = box();
  try {
    const empty = layer(s.root, 'empty', '');
    const spec = ok(s.call('launch-spec', { layers: [empty], local: write(s.root, 'local.toml', '[state]\nretention_days = 400\n') }));
    assert.deepEqual(spec.risks, []);
    assert.match(spec.launch_digest, /^sha256:/);
    assert.ok(!('receipt' in spec));
  } finally {
    s.done();
  }
});

test('a skill a plan installed in the folder at this content is not carried again; an edited one is', () => {
  const s = box();
  try {
    planAndApply(s, {});
    const spec = ok(s.call('launch-spec', { layers: [s.team] }));
    assert.deepEqual(spec.risks, []);
    assert.ok(spec.skipped.some((x) => x.item === 'skill.notes' && /installed in the folder by a plan/.test(x.reason)));
    assert.ok(!spec.argv.includes('--plugin-dir'));
    fs.appendFileSync(path.join(s.team, 'skills', 'notes', 'SKILL.md'), '\nmore\n');
    assert.equal(s.call('launch-spec', { layers: [s.team] }).error.code, 'receipt_required');
  } finally {
    s.done();
  }
});

test('a skill holding a symlink is refused at launch, before the receipt is asked for', () => {
  const s = box();
  try {
    const linked = layer(s.root, 'linked', '', { 'skills/tool/SKILL.md': skillMd('tool') });
    fs.symlinkSync('/etc/hosts', path.join(linked, 'skills', 'tool', 'hosts'));
    assert.equal(s.call('launch-spec', { layers: [linked] }).error.code, 'write_refused');
  } finally {
    s.done();
  }
});

test('Codex: a skill at launch is refused as item_unsupported, with the reason', () => {
  const s = box();
  try {
    const folder = codexFolder(s.root);
    const res = handle({ protocol: PROTOCOL, op: 'launch-spec', args: { harness: 'codex', harness_path: folder, layers: [s.team] } }, { ...s.opts, host: linuxHost });
    assert.equal(res.error.code, 'item_unsupported');
    assert.ok(res.error.items.length > 0 && res.error.items.every((i) => i.startsWith('skill')), JSON.stringify(res.error.items));
    assert.match(res.error.message, /no skill root a launch can add/);
    assert.match(res.error.message, /skills\/extraRoots\/set/);
  } finally {
    s.done();
  }
});

test('review: a skill edited in the folder and the layer alike is carried again, under the receipt', () => {
  const s = box();
  try {
    planAndApply(s, {});
    const edited = '---\nname: notes\ndescription: Take notes.\n---\nAlso run scripts/x.sh.\n';
    fs.writeFileSync(path.join(s.team, 'skills', 'notes', 'SKILL.md'), edited);
    fs.writeFileSync(path.join(s.folder, 'skills', 'notes', 'SKILL.md'), edited);
    const res = s.call('launch-spec', { layers: [s.team] });
    assert.equal(res.error.code, 'receipt_required', 'the folder matches the layer, but not what a plan installed');
  } finally {
    s.done();
  }
});

test('review: a risky launch with TMPDIR inside the data folder is refused before anything is made there, the version probe included', () => {
  const s = sandbox();
  const tmpdir = process.env.TMPDIR;
  const mkdtemp = fs.mkdtempSync;
  const made = [];
  try {
    // The process's own temp dir inside the folder; the probe cleans up after itself, so every
    // mkdtemp is recorded as it happens.
    const inside = path.join(s.folder, 'tmp-inside');
    fs.mkdirSync(inside);
    process.env.TMPDIR = inside;
    fs.mkdtempSync = (prefix, ...rest) => {
      made.push(prefix);
      return mkdtemp(prefix, ...rest);
    };
    const res = s.call('launch-spec', { layers: [s.team] });
    fs.mkdtempSync = mkdtemp;
    assert.equal(res.error.code, 'write_refused');
    assert.deepEqual(made.filter((p) => p.startsWith(s.folder)), [], 'no scratch and no temp dir in the data folder');
  } finally {
    fs.mkdtempSync = mkdtemp;
    if (tmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpdir;
    s.done();
  }
});
