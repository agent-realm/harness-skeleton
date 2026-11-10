// Milestone 6a.15: Agent Plugins packages on Codex (design note §5.7). Codex reads the format
// natively and loads a plugin only from its cache in the data folder, when enabled. Under
// materialize a plan installs the package as a tree in plugins/cache/harness-skeleton/<name>/hs/;
// each launch through launch-spec enables it with one inline -c table; config.toml is never written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { checkAddress } from '../src/native.js';
import { digestPath, resolve } from '../src/spec/layers.js';
import codexDriver from '../src/drivers/codex/index.js';
import { codexFolder, layer, skillMd, tmpdir, write } from './fixtures.js';
import { linuxHost, ok, receiptFor } from './sandbox.js';

const CX = codexDriver.descriptor;
const PLUGIN = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

function box({ name = 'notes-kit', mcp = true } = {}) {
  const root = tmpdir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folder = codexFolder(root);
  const bin = write(root, 'bin/codex', '#!/bin/sh\necho "codex-cli 0.160.0"\n');
  fs.chmodSync(bin, 0o755);
  const base = `plugins/${name}`;
  const kit = layer(root, 'kit', `[plugin.${JSON.stringify(name)}]\nsource = "${base}"\nformat = "agent-plugins"\n`, {
    [`${base}/plugin.json`]: JSON.stringify({ $schema: PLUGIN, name, version: '1.0.0' }),
    [`${base}/skills/notes/SKILL.md`]: skillMd('notes', 'Take notes.'),
    ...(mcp ? { [`${base}/mcp.json`]: JSON.stringify({ $schema: MCP, mcpServers: {
      local: { type: 'stdio', command: './bin/run', env: { TOKEN: '${HOME}' } },
      remote: { type: 'sse', url: 'https://example.com/sse' },
    } }) } : {}),
  });
  const opts = { host: linuxHost, home, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'codex', harness_path: folder, bin, ...args } }, opts);
  return { root, folder, kit, base, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const config = (folder) => fs.readFileSync(path.join(folder, 'config.toml'), 'utf8');

test('Codex materialize: the package as a tree in the plugin cache, receipted; config.toml untouched; the bare-start cost named', () => {
  const s = box();
  try {
    const before = config(s.folder);
    const plan = ok(s.call('plan', { layers: [s.kit], owner: 'builder', mode: 'materialize' }));
    const op = plan.operations.find((o) => o.item === 'plugin.notes-kit');
    assert.equal(op.address_id, 'plugins/cache/harness-skeleton/notes-kit/hs');
    assert.deepEqual(op.risk, ['runs-code', 'sends-data']);
    assert.match(op.note, /enabled as notes-kit@harness-skeleton by -c plugins at each launch through launch-spec; a bare `codex` start in this folder does not load it/);
    assert.ok(plan.launch_only.some((x) => x.item === 'plugin.notes-kit' && /-c plugins=\{"notes-kit@harness-skeleton"=\{enabled=true\}\}/.test(x.via)));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const at = path.join(s.folder, 'plugins/cache/harness-skeleton/notes-kit/hs');
    assert.equal(digestPath(at), resolve([s.kit]).plugins[0].sha256, 'the package, as bound');
    assert.equal(config(s.folder), before, 'config.toml is never written');
  } finally {
    s.done();
  }
});

test('Codex launch-spec: an installed package is enabled by one inline -c table; Codex keeps the literal text, so validate refuses none', () => {
  const s = box();
  try {
    const plan = ok(s.call('plan', { layers: [s.kit], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const spec = ok(s.call('launch-spec', { layers: [s.kit] }));
    const i = spec.argv.indexOf('plugins={"notes-kit@harness-skeleton"={enabled=true}}');
    assert.ok(i > 0 && spec.argv[i - 1] === '-c', spec.argv.join(' '));
    assert.ok(spec.launch_items.some((x) => x.item === 'plugin.notes-kit' && /installed in the folder by a plan at this content/.test(x.via)));
    assert.deepEqual(spec.risks, [], 'the plan\'s receipt covered it');
  } finally {
    s.done();
  }
});

test('Codex launch-spec: a package not installed, or edited since, is refused; overlay refuses it; a native format is not delivered', () => {
  const s = box();
  try {
    const refused = s.call('launch-spec', { layers: [s.kit] });
    assert.equal(refused.error.code, 'item_unsupported');
    assert.match(refused.error.message, /loads a plugin only from its cache in the data folder/);
    const plan = ok(s.call('plan', { layers: [s.kit], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    write(s.kit, `${s.base}/skills/notes/extra.md`, 'more');
    assert.equal(s.call('launch-spec', { layers: [s.kit] }).error.code, 'item_unsupported', 'an edited package is not what the plan installed');
    const overlay = s.call('plan', { layers: [s.kit], owner: 'builder', mode: 'overlay' });
    assert.match(overlay.error.message, /plugin\.notes-kit \(item_unsupported\)/, 'under overlay nothing is written, so the plan is refused by item');
    const native = layer(s.root, 'native', '[plugin.cc]\nsource = "p"\nformat = "claude-plugin"\n', { 'p/.claude-plugin/plugin.json': '{"name":"cc"}' });
    const n = s.call('plan', { layers: [native], owner: 'builder', mode: 'materialize' });
    assert.equal(n.error.code, 'not_implemented');
    assert.match(n.error.message, /plugin\.cc \(format claude-plugin\)/);
  } finally {
    s.done();
  }
});

test('Codex: a dotted plugin name keeps its dot in the cache path and the enable key', () => {
  const s = box({ name: 'notes.kit', mcp: false });
  try {
    const plan = ok(s.call('plan', { layers: [s.kit], owner: 'builder', mode: 'materialize' }));
    const op = plan.operations.find((o) => o.item === 'plugin.notes.kit');
    assert.equal(op.address_id, 'plugins/cache/harness-skeleton/notes.kit/hs');
    assert.deepEqual(op.risk, ['runs-code'], 'skills only');
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const spec = ok(s.call('launch-spec', { layers: [s.kit] }));
    assert.ok(spec.argv.includes('plugins={"notes.kit@harness-skeleton"={enabled=true}}'));
  } finally {
    s.done();
  }
});

test('the write floor: a plugin tree only one level under its cache root, never beside or below it', () => {
  for (const ok of ['plugins/cache/harness-skeleton/notes-kit/hs', 'plugins/cache/harness-skeleton/a.b/hs', 'skills/notes']) {
    assert.equal(checkAddress(CX, 'tree', { path: ok }), ok);
  }
  for (const bad of ['plugins/cache/other/notes-kit/hs', 'plugins/cache/harness-skeleton/notes-kit', 'plugins/cache/harness-skeleton/notes-kit/hs/x', 'plugins/cache/harness-skeleton/.hidden/hs', 'plugins/cache/harness-skeleton/Up/hs', 'plugins/cache/harness-skeleton/notes-kit/.x', 'config.toml']) {
    assert.throws(() => checkAddress(CX, 'tree', { path: bad }), (e) => e.code === 'write_refused', bad);
  }
});

test('describe on Codex: the plugins capability, native', () => {
  const s = box();
  try {
    const d = ok(s.call('describe', {}));
    const cap = d.capabilities.find((c) => c.capability === 'plugins');
    assert.equal(cap.mechanism, 'native');
    assert.deepEqual(cap.facets.formats['agent-plugins'].refuses, ['plugin_path_unsupported: .codex-plugin in the package']);
    assert.deepEqual(cap.facets.formats['agent-plugins'].harness_specific, ['com.openai']);
  } finally {
    s.done();
  }
});

test('Codex: a package holding .codex-plugin/ is refused (plugin_path_unsupported); on Claude Code it is nested, so it passes', async () => {
  const s = box({ mcp: false });
  try {
    write(s.kit, `${s.base}/.codex-plugin/plugin.json`, JSON.stringify({ name: 'notes-kit' }));
    const v = ok(s.call('validate', { layers: [s.kit] }));
    const p = v.problems.filter((x) => x.severity === 'error');
    assert.deepEqual(p.map((x) => [x.code, x.item]), [['plugin_path_unsupported', 'plugin.notes-kit']]);
    assert.match(p[0].message, /holds \.codex-plugin \(in some letter case\), a path the format never discovers/);
    fs.renameSync(path.join(s.kit, s.base, '.codex-plugin'), path.join(s.kit, s.base, '.Codex-Plugin'));
    const cased = ok(s.call('validate', { layers: [s.kit] })).problems.filter((x) => x.severity === 'error');
    assert.deepEqual(cased.map((x) => x.code), ['plugin_path_unsupported'], 'in any letter case, whatever the file system');
    const { validate } = await import('../src/spec/validate.js');
    const cc = (await import('../src/drivers/claude-code/descriptor.js')).default;
    assert.deepEqual(validate(resolve([s.kit]), cc).problems.filter((x) => x.severity === 'error'), []);
  } finally {
    s.done();
  }
});

test('Codex: a package carrying extensions["com.openai"] is harness-specific in the plan, and runs-code even with no skill or server', () => {
  const s = box({ mcp: false });
  try {
    fs.rmSync(path.join(s.kit, s.base, 'skills'), { recursive: true });
    write(s.kit, `${s.base}/plugin.json`, JSON.stringify({ $schema: PLUGIN, name: 'notes-kit', extensions: { 'com.openai': { apps: './.app.json' } } }));
    const plan = ok(s.call('plan', { layers: [s.kit], owner: 'builder', mode: 'materialize' }));
    const op = plan.operations.find((o) => o.item === 'plugin.notes-kit');
    assert.deepEqual(op.risk, ['runs-code']);
    assert.match(op.note, /harness-specific: it carries extensions\["com\.openai"\], which Codex reads for apps, hooks, onboarding skill, interface, and drops hooks and apps for this format/);
    // Without it, and with no skill or server, the package runs nothing.
    write(s.kit, `${s.base}/plugin.json`, JSON.stringify({ $schema: PLUGIN, name: 'notes-kit' }));
    const bare = ok(s.call('plan', { layers: [s.kit], owner: 'builder', mode: 'materialize' }));
    assert.deepEqual(bare.operations.find((o) => o.item === 'plugin.notes-kit').risk, []);
  } finally {
    s.done();
  }
});
