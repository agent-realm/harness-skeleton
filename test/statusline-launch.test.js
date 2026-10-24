// Milestone 6a.5: the status line at launch (design note §5.9, §5.10, §7.5). On Claude Code it is a
// command in the --settings overlay, under the launch receipt since it runs code; Codex has no
// custom status line, so an if-supported one is skipped and a required one refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { shellQuote } from '../src/process.js';
import { codexFolder, layer, write } from './fixtures.js';
import { linuxHost, ok, sandbox } from './sandbox.js';

function box() {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  return s;
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
const overlay = (spec) => JSON.parse(fs.readFileSync(spec.files.find((f) => f.role === 'settings').path, 'utf8'));
// The fixture writes [spec] first, and a bare key belongs to the table above it.
const statusLayer = (s, name, run, extra = '', files = {}) => layer(s.root, name, `[statusline]\nrun = ${run}\n${extra}`, files);

test('Claude Code: the status line in the --settings overlay, under the launch receipt', () => {
  const s = box();
  try {
    const team = statusLayer(s, 'status', '{ exec = "bin/status.sh" }', 'refresh = 5\n', { 'bin/status.sh': '#!/bin/sh\necho status\n' });
    const refused = s.call('launch-spec', { layers: [team] });
    assert.equal(refused.error.code, 'receipt_required');
    const [risk] = refused.error.items[0].risks;
    assert.deepEqual([risk.item, risk.layer, risk.risk, risk.files.map((f) => f.path)], ['statusline', 'status', 'runs-code', ['bin/status.sh']]);
    const spec = ok(s.call('launch-spec', { layers: [team], receipt: allow(refused) }));
    assert.deepEqual(overlay(spec).statusLine, { type: 'command', command: path.join(team, 'bin', 'status.sh'), refreshInterval: 5 });
    assert.ok(spec.argv.includes('--settings'));
    assert.ok(spec.launch_items.some((x) => x.item === 'statusline' && x.via === '--settings statusLine'));
    // An edited script is another launch.
    fs.appendFileSync(path.join(team, 'bin', 'status.sh'), 'echo more\n');
    assert.equal(s.call('launch-spec', { layers: [team], receipt: allow(refused) }).error.code, 'receipt_required');
  } finally {
    s.done();
  }
});

test('the command is quoted word by word; a shell string is the command as written', () => {
  const s = box();
  try {
    const team = statusLayer(s, 'status', `{ exec = "node", args = ["status.js", "it's", "--x"] }`, '', { 'status.js': 'x\n' });
    const refused = s.call('launch-spec', { layers: [team] });
    const spec = ok(s.call('launch-spec', { layers: [team], receipt: allow(refused) }));
    assert.equal(overlay(spec).statusLine.command, `node ${path.join(team, 'status.js')} 'it'\\''s' --x`);
    assert.equal(shellQuote(['a b', '$HOME', 'plain-1.0']), `'a b' '$HOME' plain-1.0`, 'no shell expansion reaches an argument');

    const sh = statusLayer(s, 'sh', '{ shell = "echo $(date)" }');
    const r2 = s.call('launch-spec', { layers: [sh] });
    assert.deepEqual(r2.error.items[0].risks, [{ item: 'statusline', layer: 'sh', risk: 'runs-code', text: 'echo $(date)' }]);
    assert.equal(overlay(ok(s.call('launch-spec', { layers: [sh], receipt: allow(r2) }))).statusLine.command, 'echo $(date)');
  } finally {
    s.done();
  }
});

test('refused: an env on the status line, a ${...} in its strings, a path through a symlink', () => {
  const s = box();
  try {
    const env = statusLayer(s, 'env', '{ exec = "status", env = { A = "1" } }');
    assert.equal(s.call('launch-spec', { layers: [env] }).error.code, 'not_implemented');
    // A review finding: a working directory is refused, never dropped.
    const cwd = statusLayer(s, 'cwd', '{ exec = "node", args = ["bin/status.js"], cwd = "assets" }');
    const refusedCwd = s.call('launch-spec', { layers: [cwd] });
    assert.equal(refusedCwd.error.code, 'not_implemented');
    assert.deepEqual(refusedCwd.error.items, ['statusline.run cwd (Claude Code\'s statusLine has no working directory field)']);
    const interp = statusLayer(s, 'interp', '{ exec = "status", args = ["${ANTHROPIC_AUTH_TOKEN}"] }');
    const res = s.call('launch-spec', { layers: [interp] });
    assert.equal(res.error.code, 'spec_invalid');
    assert.ok(res.error.items.some((p) => p.code === 'interpolation_refused'));
    const outside = path.join(s.root, 'elsewhere');
    write(outside, 'status.sh', 'echo x\n');
    const linked = statusLayer(s, 'linked', '{ exec = "bin/status.sh" }');
    fs.symlinkSync(outside, path.join(linked, 'bin'));
    assert.equal(s.call('launch-spec', { layers: [linked] }).error.code, 'write_refused');
  } finally {
    s.done();
  }
});

test('validate: the status line shape; plans list it as launch_only', () => {
  const s = box();
  try {
    const val = (toml) => ok(handle({ protocol: PROTOCOL, op: 'validate', args: { harness: 'claude-code', layers: [layer(s.root, `l${Math.random()}`.replace('.', ''), toml)] } }, s.opts)).problems.filter((p) => p.code === 'item_malformed').length;
    assert.equal(val('[statusline]\nrefresh = 5\n'), 1, 'run is needed');
    assert.equal(val('[statusline]\nrun = { exec = "s" }\nrefresh = 0\n'), 1);
    assert.equal(val('[statusline]\nrun = { exec = "s" }\nrequire = "maybe"\n'), 1);
    assert.equal(val('[statusline]\nrun = { exec = "s", shell = "t" }\n'), 1);
    // A review finding: args beside a shell string would be dropped; a cwd is a string, with no ${.
    assert.equal(val('[statusline]\nrun = { shell = "echo hi", args = ["x"] }\n'), 1);
    assert.equal(val('[statusline]\nrun = { exec = "s", cwd = 3 }\n'), 1);
    assert.ok(ok(handle({ protocol: PROTOCOL, op: 'validate', args: { harness: 'claude-code', layers: [layer(s.root, 'cwdi', '[statusline]\nrun = { exec = "s", cwd = "d/${HOME}" }\n')] } }, s.opts)).problems.some((p) => p.code === 'interpolation_refused'));
    assert.equal(val('[statusline]\nrun = { exec = "s" }\nrefresh = 2\nrequire = "required"\n'), 0);
    const team = statusLayer(s, 'status', '{ exec = "status" }');
    assert.ok(ok(s.call('plan', { layers: [team], owner: 'tool', mode: 'overlay' })).launch_only.some((x) => x.item === 'statusline' && /launch receipt/.test(x.via)));
  } finally {
    s.done();
  }
});

test('Codex: no custom status line, so an if-supported one is skipped and named, a required one refused', () => {
  const s = box();
  try {
    const folder = codexFolder(s.root);
    const call = (layers) => handle({ protocol: PROTOCOL, op: 'launch-spec', args: { harness: 'codex', harness_path: folder, layers } }, { ...s.opts, host: linuxHost });
    const soft = statusLayer(s, 'soft', '{ exec = "status" }');
    const spec = ok(call([soft]));
    assert.ok(spec.skipped.some((x) => x.item === 'statusline' && /no custom status line/.test(x.reason)));
    const hard = statusLayer(s, 'hard', '{ exec = "status" }', 'require = "required"\n');
    assert.equal(call([hard]).error.code, 'item_unsupported');
  } finally {
    s.done();
  }
});
