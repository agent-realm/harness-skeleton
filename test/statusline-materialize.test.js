// Milestone 6a.11 (item 2b): the status line under materialize on Claude Code, bound by copy
// (design note §7.5). A persisted status line runs at every start with no launch receipt, so the
// plan binds what it runs: the process's one layer directory is copied into hs-run/statusline/
// (owner-only, digest-bound in the ledger), and settings.json#statusLine names the copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handlers } from '../src/native.js';
import ccDriver from '../src/drivers/claude-code/index.js';
import { layer, write } from './fixtures.js';
import { ok, receiptFor, sandbox, settings } from './sandbox.js';

const D = ccDriver.descriptor;
const mode = (p) => fs.statSync(p).mode & 0o777;

function boundLayer(s, name = 'sl', run = 'exec = "bin/status.sh", args = ["--short"], self_contained = true') {
  const dir = layer(s.root, name, `[statusline]\nrun = { ${run} }\nrefresh = 5\n`, { 'bin/status.sh': '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\necho status\n', 'bin/lib.sh': 'X=1\n' });
  fs.chmodSync(path.join(dir, 'bin/status.sh'), 0o755);
  return dir;
}

test('a status line bound by copy: hs-run/statusline/ owner-only, settings.json names the copy, receipted; launch skips it; drift in words; remove restores', () => {
  const s = sandbox();
  try {
    const team = boundLayer(s);
    const plan = ok(s.call('plan', { layers: [team], owner: 'builder' }));
    // The skeleton's retention default rides along under materialize; it is not the status line's.
    const mine = plan.operations.filter((o) => o.item === 'statusline');
    const ops = mine.map((o) => [o.action, o.handler, o.address_id, o.risk]);
    assert.deepEqual(ops, [['create', 'tree', 'hs-run/statusline', ['runs-code']], ['create', 'json-key', 'settings.json#statusLine', ['runs-code']]]);
    // The receipt names the limit: only the copied tree is bound.
    for (const o of mine) assert.match(o.note, /only that tree is bound: what it loads at run time from elsewhere .* is not/);
    const copy = path.join(s.folder, 'hs-run/statusline');
    assert.deepEqual(mine[1].value, { type: 'command', command: `${path.join(copy, 'status.sh')} --short`, refreshInterval: 5 });
    assert.equal(s.call('apply', { plan, receipt: receiptFor(plan, []) }).error.code, 'receipt_required');
    assert.equal(fs.existsSync(copy), false);
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.equal(settings(s.folder).statusLine.command, `${path.join(copy, 'status.sh')} --short`);
    // Owner-only copies.
    assert.equal(mode(path.join(s.folder, 'hs-run')), 0o700);
    assert.equal(mode(copy), 0o700);
    assert.equal(mode(path.join(copy, 'status.sh')), 0o700);
    assert.equal(mode(path.join(copy, 'lib.sh')), 0o600);
    // At launch it is installed: skipped, so no launch receipt is asked for it.
    const spec = ok(s.call('launch-spec', { layers: [team] }));
    assert.ok(spec.skipped.some((x) => x.item === 'statusline' && /installed in the folder by a plan/.test(x.reason)));
    // An edit in the layer is a new plan's business: the launch carries the new one, under a receipt.
    fs.appendFileSync(path.join(team, 'bin/lib.sh'), 'Y=2\n');
    assert.equal(s.call('launch-spec', { layers: [team] }).error.code, 'receipt_required');
    assert.deepEqual(ok(s.call('plan', { layers: [team], owner: 'builder' })).operations.map((o) => [o.action, o.address_id]), [['update', 'hs-run/statusline']]);
    fs.writeFileSync(path.join(team, 'bin/lib.sh'), 'X=1\n');
    // A copy changed in the folder is drift, in words, and the launch no longer trusts it.
    fs.appendFileSync(path.join(copy, 'lib.sh'), 'curl evil\n');
    const managed = ok(s.call('observe', {})).managed.find((m) => m.address === 'hs-run/statusline');
    assert.equal(managed.drift, 'changed');
    assert.match(managed.note, /not what the plan installed under its receipt; the persisted process no longer runs what was consented to/);
    assert.equal(s.call('launch-spec', { layers: [team] }).error.code, 'receipt_required');
    fs.writeFileSync(path.join(copy, 'lib.sh'), 'X=1\n');
    // remove takes both out.
    ok(s.call('remove', { owner: 'builder' }));
    assert.equal(fs.existsSync(copy), false);
    assert.equal(settings(s.folder).statusLine, undefined);
  } finally {
    s.done();
  }
});

test('what bind by copy cannot bind is refused with the reason; a process naming no layer path is bound by its text', () => {
  const s = sandbox();
  try {
    const refusal = (run, files = {}) => {
      const l = layer(s.root, `r${Math.random()}`.replace('.', ''), `[statusline]\nrun = { ${run} }\n`, files);
      return s.call('plan', { layers: [l], owner: 'builder' }).error;
    };
    let e = refusal('exec = "bin/status.sh"', { 'bin/status.sh': 'x' });
    assert.equal(e.code, 'item_unsupported');
    assert.match(e.items[0].reason, /self_contained = true/);
    e = refusal('exec = "a/x", args = ["b/y"], self_contained = true', { 'a/x': 'x', 'b/y': 'y' });
    assert.match(e.items[0].reason, /one directory/);
    e = refusal('exec = "status.sh", self_contained = true', { 'status.sh': 'x' });
    assert.match(e.items[0].reason, /a file at the layer's root/);
    e = refusal('exec = "bin/s", env = { A = "1" }', { 'bin/s': 'x' });
    assert.match(e.items[0].reason, /no environment field/);
    assert.equal(s.call('validate', { layers: [layer(s.root, 'bad', '[statusline]\nrun = { exec = "s", self_contained = "yes" }\n')] }).result.problems.some((p) => /self_contained is true or false/.test(p.message)), true);

    // Bound by its text: a bare command, an absolute path (not bound), a shell string.
    const text = (run) => ok(s.call('plan', { layers: [layer(s.root, `t${Math.random()}`.replace('.', ''), `[statusline]\nrun = { ${run} }\n`)], owner: 'builder' })).operations.filter((o) => o.item === 'statusline');
    let ops = text('exec = "my-status", args = ["--x"]');
    assert.deepEqual(ops.map((o) => o.address_id), ['settings.json#statusLine']);
    assert.equal(ops[0].value.command, 'my-status --x');
    assert.match(ops[0].note, /binds the command text only/);
    ops = text('exec = "/opt/status/bin/st"');
    assert.match(ops[0].note, /the file at \/opt\/status\/bin\/st is not bound; only the command text is/);
    ops = text('shell = "echo hi"');
    assert.match(ops[0].note, /shell string/);
  } finally {
    s.done();
  }
});

test('the user\'s own status line is not overwritten; overlay stays launch-only; hs-run takes no hidden, nested or escaping address', () => {
  const s = sandbox();
  try {
    const team = boundLayer(s);
    const own = JSON.parse(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'));
    own.statusLine = { type: 'command', command: 'my-own-line' };
    fs.writeFileSync(path.join(s.folder, 'settings.json'), JSON.stringify(own));
    const res = s.call('plan', { layers: [team], owner: 'builder' });
    assert.equal(res.error.code, 'unowned_conflict');
    assert.ok(res.error.items.some((i) => i.item === 'statusline'));
    const overlay = ok(s.call('plan', { layers: [team], owner: 'builder', mode: 'overlay' }));
    assert.ok(overlay.launch_only.some((x) => x.item === 'statusline'));
    assert.deepEqual(overlay.operations.filter((o) => o.address_id.startsWith('hs-run')), []);
    const ctx = { applyId: 'x', opId: 'op-1', onStage: () => {} };
    for (const p of ['hs-run/.x', 'hs-run/a/b', 'hs-run/../escaped', '../hs-run/x']) {
      assert.throws(() => handlers.tree.write(s.folder, D, { path: p }, path.join(team, 'bin'), 'x', ctx), { code: 'write_refused' }, p);
    }
    assert.equal(fs.existsSync(path.join(s.root, 'escaped')), false);
  } finally {
    s.done();
  }
});

test('review: a status line in local.toml, beside its own self-contained directory, plans and applies', () => {
  const s = sandbox();
  try {
    const install = path.join(s.root, 'install');
    const local = write(install, 'local.toml', '[statusline]\nrun = { exec = "bin/status.sh", self_contained = true }\n');
    write(install, 'bin/status.sh', '#!/bin/sh\necho status\n');
    fs.chmodSync(path.join(install, 'bin/status.sh'), 0o755);
    const empty = layer(s.root, 'empty', '');
    const plan = ok(s.call('plan', { layers: [empty], local, owner: 'builder' }));
    const tree = plan.operations.find((o) => o.address_id === 'hs-run/statusline');
    assert.equal(tree.source, path.join(install, 'bin'));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.equal(settings(s.folder).statusLine.command, path.join(s.folder, 'hs-run/statusline/status.sh'));
    assert.equal(fs.readFileSync(path.join(s.folder, 'hs-run/statusline/status.sh'), 'utf8'), '#!/bin/sh\necho status\n');
    // A source outside every layer and local.toml's directory is still refused at apply.
    const elsewhere = path.join(s.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const { digest, ...body } = { ...plan, operations: plan.operations.map((o) => (o.address_id === 'hs-run/statusline' ? { ...o, source: elsewhere } : o)) };
    assert.notEqual(s.call('apply', { plan: { ...body, digest }, receipt: receiptFor(plan) }).ok, true);
  } finally {
    s.done();
  }
});
