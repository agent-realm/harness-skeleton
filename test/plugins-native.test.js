// Milestone 6a.17: packages in Claude Code's own plugin format, claude-plugin (design note §5.7),
// delivered whole on Claude Code: at launch as one --plugin-dir each, under materialize as the 6a.16
// directory marketplace. validate checks the name and refuses the manifest fields that would bring in
// what the spec does not bind. Codex does not get the format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { digestPath, resolve } from '../src/spec/layers.js';
import { validate } from '../src/spec/validate.js';
import ccDescriptor from '../src/drivers/claude-code/descriptor.js';
import cxDescriptor from '../src/drivers/codex/descriptor.js';
import { codexFolder, layer, skillMd, write } from './fixtures.js';
import { linuxHost, ok, receiptFor, sandbox, settings } from './sandbox.js';

// A layer `nat` holding one claude-plugin package under plugins/<name>, and its plugin item.
function natLayer(root, { name = 'deploy-kit', id = name, manifest = {}, noManifest = false, files = {} } = {}) {
  const base = `plugins/${name}`;
  const pkg = {
    ...(noManifest ? {} : { [`${base}/.claude-plugin/plugin.json`]: JSON.stringify({ name, version: '1.0.0', description: 'a kit', ...manifest }) }),
    [`${base}/skills/notes/SKILL.md`]: skillMd('notes', 'Take notes.'),
    [`${base}/commands/hello.md`]: '---\ndescription: say hello\n---\nHello.\n',
    [`${base}/hooks/hooks.json`]: '{"hooks":{}}',
    [`${base}/bin/tool`]: '#!/bin/sh\nexit 0\n',
    [`${base}/.mcp.json`]: JSON.stringify({ mcpServers: { local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/srv.js'] } } }),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`${base}/${k}`, v])),
  };
  const dir = layer(root, 'nat', `[plugin.${JSON.stringify(id)}]\nsource = "${base}"\nformat = "claude-plugin"\n`, pkg);
  fs.chmodSync(path.join(dir, base, 'bin/tool'), 0o755);
  return dir;
}
const errors = (dir, d = ccDescriptor) => validate(resolve([dir]), d).problems.filter((p) => p.severity === 'error');
const codesOf = (dir, d) => errors(dir, d).map((p) => p.code);

test('validate: a claude-plugin package passes on Claude Code, with or without a manifest', () => {
  const s = sandbox();
  try {
    const nat = natLayer(s.root);
    assert.deepEqual(validate(resolve([nat]), ccDescriptor).problems, []);
    fs.rmSync(nat, { recursive: true });
    const bare = natLayer(s.root, { noManifest: true });
    assert.deepEqual(validate(resolve([bare]), ccDescriptor).problems, [], 'no manifest: the plugin takes its directory\'s name, which hs makes the item\'s');
    fs.rmSync(bare, { recursive: true });
    // Fields that bring in nothing the spec does not bind pass: empty lists and tables, an inline
    // server map, a server file in the package.
    const fine = natLayer(s.root, { manifest: { dependencies: [], userConfig: {}, mcpServers: ['./servers.json', { inline: { command: 'node' } }] }, files: { 'servers.json': '{}' } });
    assert.deepEqual(codesOf(fine), []);
  } finally {
    s.done();
  }
});

test('validate: the name, a malformed manifest, and the manifest fields a claude-plugin package may not hold', () => {
  const s = sandbox();
  const one = (opts) => {
    const dir = natLayer(s.root, opts);
    const out = errors(dir);
    fs.rmSync(dir, { recursive: true });
    return out;
  };
  try {
    assert.deepEqual(one({ id: 'other' }).map((p) => p.code), ['plugin_name_mismatch']);
    assert.deepEqual(one({ name: 'hs' }).map((p) => p.code), ['plugin_name_reserved'], 'the plugin hs carries skills in at launch');
    assert.deepEqual(one({ name: 'hs', noManifest: true }).map((p) => p.code), ['plugin_name_reserved'], 'reserved by the item\'s name, manifest or not');
    assert.deepEqual(one({ manifest: { name: 7 } }).map((p) => p.code), ['plugin_malformed']);
    assert.deepEqual(one({ files: { '.claude-plugin/plugin.json': '{"name": "deploy-kit",' } }).map((p) => p.code), ['plugin_malformed']);
    const deps = one({ manifest: { dependencies: ['secrets-vault'] } });
    assert.deepEqual(deps.map((p) => p.code), ['plugin_field_unsupported']);
    assert.match(deps[0].message, /dependencies: Claude Code enables the plugins it names/);
    const config = one({ manifest: { userConfig: { api_token: { type: 'string', title: 'T', description: 'D', sensitive: true } } } });
    assert.match(config[0].message, /userConfig: .*credential store/);
    assert.equal(one({ manifest: { channels: [{ server: 'local' }] } })[0].code, 'plugin_field_unsupported');
    for (const mcpServers of ['./bundle.mcpb', ['./servers.json', './b.DXT'], 'HTTPS://example.com/server.mcpb', [{ x: { command: 'node' } }, 'https://example.com/s']]) {
      const p = one({ manifest: { mcpServers }, files: { 'servers.json': '{}' } });
      assert.deepEqual(p.map((x) => x.code), ['plugin_field_unsupported'], JSON.stringify(mcpServers));
      assert.match(p[0].message, /mcpServers: an MCP bundle/);
      assert.doesNotMatch(p[0].message, /example\.com|bundle\.mcpb/, 'no value quoted');
    }
    // The manifest is not read through a symlink.
    const linked = natLayer(s.root);
    const pkg = path.join(linked, 'plugins/deploy-kit');
    fs.renameSync(path.join(pkg, '.claude-plugin'), path.join(s.root, 'elsewhere'));
    fs.symlinkSync(path.join(s.root, 'elsewhere'), path.join(pkg, '.claude-plugin'));
    assert.deepEqual(codesOf(linked), ['plugin_malformed']);
  } finally {
    s.done();
  }
});

test('validate on Codex: no route for claude-plugin, so nothing is checked, and plan and launch-spec do not deliver it', () => {
  const s = sandbox();
  try {
    const nat = natLayer(s.root, { manifest: { dependencies: ['x'] } });
    assert.deepEqual(codesOf(nat, cxDescriptor), [], 'checked only where a route maps the format');
    fs.rmSync(nat, { recursive: true });
    const folder = codexFolder(s.root);
    const bin = write(s.root, 'bin/codex', '#!/bin/sh\necho "codex-cli 0.160.0"\n');
    fs.chmodSync(bin, 0o755);
    const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'codex', harness_path: folder, bin, ...args } }, { host: linuxHost, home: s.home, state: { managedRoot: null, mdmPlists: [] } });
    const clean = natLayer(s.root, { name: 'other-kit' });
    const plan = call('plan', { layers: [clean], owner: 'builder', mode: 'materialize' });
    assert.equal(plan.error.code, 'not_implemented');
    assert.match(plan.error.message, /plugin\.other-kit \(format claude-plugin\)/);
    assert.equal(call('launch-spec', { layers: [clean] }).error.code, 'not_implemented');
  } finally {
    s.done();
  }
});

test('launch-spec on Claude Code: the package copied whole, one --plugin-dir, runs-code under the launch receipt', () => {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  try {
    const nat = natLayer(s.root);
    const bound = resolve([nat]).plugins[0];
    const folderBefore = fs.readdirSync(s.folder, { recursive: true }).sort();
    const refused = s.call('launch-spec', { layers: [nat] });
    assert.equal(refused.error.code, 'receipt_required');
    assert.deepEqual(fs.readdirSync(s.opts.tmpdir), [], 'a refused launch makes no temp dir');
    const [{ launch_digest, risks }] = refused.error.items;
    assert.deepEqual(risks, [{ item: 'plugin.deploy-kit', layer: 'nat', risk: 'runs-code', sha256: bound.sha256 }]);

    const spec = ok(s.call('launch-spec', { layers: [nat], receipt: { format: 'hs-receipt/0.2', launch_digest, allows: ['plugin.deploy-kit'] } }));
    const tree = spec.files.find((f) => f.role === 'plugin.deploy-kit');
    assert.deepEqual(spec.argv.slice(1, 3), ['--plugin-dir', tree.path]);
    assert.equal(path.basename(tree.path), 'deploy-kit');
    assert.equal(tree.sha256, bound.sha256, 'the copy is the package, byte for byte, and nothing else');
    assert.deepEqual(fs.readdirSync(tree.path).sort(), ['.claude-plugin', '.mcp.json', 'bin', 'commands', 'hooks', 'skills']);
    assert.ok(fs.statSync(path.join(tree.path, 'bin/tool')).mode & 0o100, 'modes kept');
    const item = spec.launch_items.find((x) => x.item === 'plugin.deploy-kit');
    assert.match(item.via, /--plugin-dir, the package delivered whole as Claude Code's own format: its hooks run as Claude Code runs a plugin's hooks, not through hs's hook shim/);
    assert.ok(spec.unverified.some((u) => /claude plugin validate/.test(u)));
    assert.ok(!spec.unverified.some((u) => /PLUGIN_DATA/.test(u)), 'the Agent Plugins note only for a translated package');
    assert.deepEqual(fs.readdirSync(s.folder, { recursive: true }).sort(), folderBefore, 'nothing written into the data folder');

    // The launch digest binds the package: an edit asks for a new receipt.
    write(nat, 'plugins/deploy-kit/bin/tool', '#!/bin/sh\nexit 1\n');
    const changed = s.call('launch-spec', { layers: [nat], receipt: { format: 'hs-receipt/0.2', launch_digest, allows: ['plugin.deploy-kit'] } });
    assert.equal(changed.error.code, 'receipt_required');
    assert.notEqual(changed.error.items[0].launch_digest, launch_digest);
  } finally {
    s.done();
  }
});

test('launch-spec on Claude Code: a package without a manifest takes its directory name; one holding a symlink is refused before any write', () => {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  try {
    const bare = natLayer(s.root, { noManifest: true });
    const [{ launch_digest }] = s.call('launch-spec', { layers: [bare] }).error.items;
    const spec = ok(s.call('launch-spec', { layers: [bare], receipt: { format: 'hs-receipt/0.2', launch_digest, allows: ['plugin.deploy-kit'] } }));
    const tree = spec.files.find((f) => f.role === 'plugin.deploy-kit').path;
    assert.equal(path.basename(tree), 'deploy-kit');
    assert.ok(!fs.existsSync(path.join(tree, '.claude-plugin')), 'hs writes no manifest of its own');
    fs.rmSync(bare, { recursive: true });
    fs.rmSync(path.dirname(path.dirname(tree)), { recursive: true }); // the launch's temp dir, which the caller removes

    const linked = natLayer(s.root);
    fs.symlinkSync('/etc/hostname', path.join(linked, 'plugins/deploy-kit/skills/notes/link'));
    const r = s.call('launch-spec', { layers: [linked] });
    assert.equal(r.error.code, 'write_refused');
    assert.deepEqual(fs.readdirSync(s.opts.tmpdir), []);
  } finally {
    s.done();
  }
});

test('launch-spec on Claude Code: a plugin that would start off is turned on by its session id, and only then', () => {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  const launch = (layers) => {
    const [{ launch_digest, risks }] = s.call('launch-spec', { layers }).error.items;
    const spec = ok(s.call('launch-spec', { layers, receipt: { format: 'hs-receipt/0.2', launch_digest, allows: [...new Set(risks.map((r) => r.item))] } }));
    const f = spec.files.find((x) => x.role === 'settings');
    return { spec, enabled: f ? JSON.parse(fs.readFileSync(f.path, 'utf8')).enabledPlugins : undefined };
  };
  try {
    // A package and hs's skills plugin that start on: no overlay key.
    const on = natLayer(s.root);
    assert.equal(launch([s.team, on]).enabled, undefined);
    fs.rmSync(on, { recursive: true });
    // A manifest that starts the plugin off: validate accepts it, the launch turns it on.
    const off = natLayer(s.root, { manifest: { defaultEnabled: false } });
    assert.deepEqual(codesOf(off), [], 'defaultEnabled is no reason to refuse: the launch turns the plugin on');
    const a = launch([s.team, off]);
    assert.deepEqual(a.enabled, { 'deploy-kit@inline': true });
    assert.ok(a.spec.notes.some((n) => /turned on for this session.*deploy-kit@inline/.test(n)));
    assert.ok(a.spec.unverified.some((u) => /project or local settings in the working directory, and managed settings/.test(u)));
    fs.rmSync(off, { recursive: true });
    // Folder settings that turn names off: those carried are turned on, the user's own keys stay
    // in the folder, and a name the launch does not carry is left alone.
    fs.writeFileSync(path.join(s.folder, 'settings.json'), JSON.stringify({ model: 'sonnet', enabledPlugins: { 'deploy-kit@inline': false, 'hs@inline': false, 'other@inline': false } }));
    assert.deepEqual(launch([s.team, natLayer(s.root)]).enabled, { 'hs@inline': true, 'deploy-kit@inline': true });
  } finally {
    s.done();
  }
});

test('plan on Claude Code: a claude-plugin package is launch_only under overlay', () => {
  const s = sandbox();
  try {
    const plan = ok(s.call('plan', { layers: [natLayer(s.root)], owner: 'builder', mode: 'overlay' }));
    assert.ok(plan.launch_only.some((x) => x.item === 'plugin.deploy-kit' && /--plugin-dir, the package as it is, under a launch receipt/.test(x.via)));
  } finally {
    s.done();
  }
});

test('materialize on Claude Code: the package as the plugin of a directory marketplace, two settings keys; skipped at launch, refused when edited, removed', () => {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  try {
    const nat = natLayer(s.root);
    const bound = resolve([nat]).plugins[0];
    const plan = ok(s.call('plan', { layers: [nat], owner: 'builder', mode: 'materialize' }));
    const ops = plan.operations.filter((o) => o.item === 'plugin.deploy-kit');
    assert.deepEqual(ops.map((o) => [o.address_id, o.risk]), [
      ['hs-run/plugin.deploy-kit', ['runs-code']],
      ['settings.json#extraKnownMarketplaces/hs-deploy-kit', []],
      ['settings.json#enabledPlugins/deploy-kit@hs-deploy-kit', ['runs-code']],
    ]);
    assert.match(ops[0].note, /a directory marketplace, hs-deploy-kit, in hs-run\/plugin\.deploy-kit, the package delivered whole/);
    assert.ok(plan.unverified.some((u) => /claude plugin validate/.test(u)));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const at = path.join(s.folder, 'hs-run/plugin.deploy-kit');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(at, '.claude-plugin/marketplace.json'), 'utf8')), { name: 'hs-deploy-kit', owner: { name: 'harness-skeleton' }, plugins: [{ name: 'deploy-kit', source: './plugin' }] });
    assert.equal(digestPath(path.join(at, 'plugin')), bound.sha256, 'the plugin is the package, byte for byte');
    const st = settings(s.folder);
    assert.deepEqual(st.extraKnownMarketplaces, { 'hs-deploy-kit': { source: { source: 'directory', path: at } } });
    assert.deepEqual(st.enabledPlugins, { 'deploy-kit@hs-deploy-kit': true });

    const spec = ok(s.call('launch-spec', { layers: [nat] }));
    assert.ok(!spec.argv.includes('--plugin-dir'), 'installed: not carried again');
    assert.ok(spec.skipped.some((x) => x.item === 'plugin.deploy-kit' && /installed in the folder by a plan, at this content/.test(x.reason)));
    write(nat, 'plugins/deploy-kit/commands/hello.md', 'edited');
    const edited = s.call('launch-spec', { layers: [nat] });
    assert.equal(edited.error.code, 'item_unsupported');
    assert.match(edited.error.message, /holds this plugin at other content \(hs-run\/plugin\.deploy-kit\)/);

    ok(s.call('remove', { owner: 'builder' }));
    assert.ok(!fs.existsSync(at));
    const after = settings(s.folder);
    assert.equal(after.enabledPlugins?.['deploy-kit@hs-deploy-kit'], undefined);
    assert.equal(after.extraKnownMarketplaces?.['hs-deploy-kit'], undefined);
  } finally {
    s.done();
  }
});

test('describe: the claude-plugin route on Claude Code, with what it refuses', () => {
  const s = sandbox();
  try {
    const cap = ok(s.call('describe', {})).capabilities.find((c) => c.capability === 'plugins');
    const f = cap.facets.formats['claude-plugin'];
    assert.equal(f.mechanism, 'native');
    assert.equal(f.readiness, 'untested');
    assert.ok(f.components.includes('hooks') && f.components.includes('bin'));
    assert.deepEqual(f.refuses, [
      'plugin_field_unsupported: dependencies, userConfig, channels in .claude-plugin/plugin.json, while they hold anything',
      'plugin_field_unsupported: mcpServers naming an MCP bundle (.mcpb, .dxt, or a URL)',
    ]);
  } finally {
    s.done();
  }
});
