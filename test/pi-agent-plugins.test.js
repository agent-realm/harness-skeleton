// Milestone 8.4: Agent Plugins packages on pi (design note v0.2 §5.7), translated into one generated
// pi package: at launch with -e, under materialize as hs-run/plugin.<name>/ and a member of
// settings.json `packages`. No test starts a real harness: the binary is a stub; the generated
// extension runs against a stand-in for pi's API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { resolve } from '../src/spec/layers.js';
import { validate } from '../src/spec/validate.js';
import piDescriptor from '../src/drivers/pi/descriptor.js';
import { layer, skillMd, tmpdir, write } from './fixtures.js';
import { linuxHost, ok, receiptFor } from './sandbox.js';

const PLUGIN = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const SERVERS = {
  local: { type: 'stdio', command: './bin/run', args: ['--root', '${PLUGIN_ROOT}/x', 'literal-${HS_KEEP}'], env: { DATA: '${PLUGIN_DATA}/db' } },
  onpath: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/srv.js'], cwd: '${PLUGIN_DATA}/work' },
  remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Team': 'a' } },
};

function box(tmpName = 'tmp') {
  const root = fs.realpathSync.native(tmpdir());
  const folder = path.join(root, 'pi-folder');
  fs.mkdirSync(folder);
  const bin = write(root, 'bin/pi', '#!/bin/sh\necho "1.5.2"\n');
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, tmpName);
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home: path.join(root, 'home'), tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'pi', harness_path: folder, bin, ...args } }, opts);
  return { root, folder, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
// A layer holding one package under plugins/<name>, and its plugin item.
function kit(root, { name = 'notes-kit', servers = SERVERS, files = {}, format = 'agent-plugins', layerName = 'kit', extra = '' } = {}) {
  const base = `plugins/${name}`;
  const dir = layer(root, layerName, `[plugin.${JSON.stringify(name)}]\nsource = ${JSON.stringify(base)}\nformat = ${JSON.stringify(format)}\n${extra}`, {
    [`${base}/plugin.json`]: JSON.stringify({ $schema: PLUGIN, name, version: '1.2.0' }),
    [`${base}/skills/notes/SKILL.md`]: skillMd('notes', 'Take notes.'),
    [`${base}/extensions/undeclared.js`]: 'export default function () {}\n',
    [`${base}/bin/run`]: '#!/bin/sh\nexit 0\n',
    ...(servers ? { [`${base}/mcp.json`]: JSON.stringify({ $schema: MCP, mcpServers: servers }) } : {}),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`${base}/${k}`, v])),
  });
  fs.chmodSync(path.join(dir, base, 'bin/run'), 0o755);
  return dir;
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
const launch = (s, args) => {
  const refused = s.call('launch-spec', { headless: true, ...args });
  if (refused.error?.code !== 'receipt_required') return refused;
  return s.call('launch-spec', { headless: true, ...args, receipt: allow(refused) });
};
const codes = (dir) => validate(resolve([dir]), piDescriptor).problems.filter((p) => p.severity === 'error');

test('describe: agent-plugins on pi is bridged (skills, mcp), with the text pi would change and the data rule named; claude-plugin is refused', () => {
  const s = box();
  try {
    const d = ok(s.call('describe', {}));
    const cap = d.capabilities.find((c) => c.capability === 'plugins');
    const f = cap.facets.formats['agent-plugins'];
    assert.deepEqual([f.mechanism, f.components, f.versions], ['bridged', ['skills', 'mcp'], ['1.0.0']]);
    assert.ok(f.refuses.some((r) => /\$ or a leading ! in env, headers, url, and a leading ~ in command, args, cwd/.test(r)));
    assert.match(f.data.kept_on_remove, /deleted only by remove with --purge-data/);
    assert.match(cap.facets.refused_formats['claude-plugin'], /no loader for the \.claude-plugin layout.*Use the Agent Plugins format/);
  } finally {
    s.done();
  }
});

test('validate on pi: $ or a leading ! in env, headers or url, and a leading ~ in command, args or cwd, are refused; ${…} in args and the placeholders pass', () => {
  const s = box();
  try {
    assert.deepEqual(codes(kit(s.root)), [], 'the placeholders, and ${…} in args, which pi passes as written');
    const cases = [
      [{ a: { type: 'stdio', command: 'node', env: { K: '$HOME' } } }, /env "K" holds \$ or a leading !/],
      [{ a: { type: 'stdio', command: 'node', env: { K: '!date' } } }, /env "K" holds \$ or a leading !/],
      [{ a: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-T': '${TOKEN}' } } }, /a header value holds \$/],
      [{ a: { type: 'stdio', command: '~/bin/x' } }, /command starts with ~/],
      [{ a: { type: 'stdio', command: 'node', args: ['~/x'] } }, /args\[0\] starts with ~/],
    ];
    for (const [i, [servers, re]] of cases.entries()) {
      const p = codes(kit(s.root, { servers, layerName: `k${i}` }));
      assert.ok(p.some((x) => x.code === 'plugin_placeholder_literal' && re.test(x.message)), JSON.stringify(servers));
    }
  } finally {
    s.done();
  }
});

test('pi launch: the package translated into a pi package in the temp dir, -e, under a receipt; the manifest declares only its skills and hs\'s extension', () => {
  const s = box();
  try {
    const k = kit(s.root);
    const refused = s.call('launch-spec', { layers: [k], headless: true });
    assert.equal(refused.error.code, 'receipt_required');
    assert.deepEqual(refused.error.items[0].risks.map((r) => [r.item, r.risk]), [['plugin.notes-kit', 'runs-code'], ['plugin.notes-kit', 'sends-data']]);
    const spec = ok(launch(s, { layers: [k] }));
    const tree = spec.files.find((f) => f.role === 'plugin.notes-kit').path;
    assert.equal(path.dirname(tree), spec.temp_dir);
    assert.equal(spec.argv[spec.argv.indexOf(tree) - 1], '-e');
    const manifest = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.pi, { skills: ['./package/skills'], extensions: ['./hs-plugin.js'], prompts: [], themes: [] });
    assert.ok(fs.existsSync(path.join(tree, 'package', 'extensions', 'undeclared.js')), 'copied whole; inert, since the manifest does not declare it');
    assert.match(spec.launch_items.find((i) => i.item === 'plugin.notes-kit').via, /translated into a pi package.*3 MCP server\(s\), as notes-kit__local, notes-kit__onpath, notes-kit__remote/);
    assert.ok(spec.unverified.some((u) => /PLUGIN_DATA: .*not kept across launches/.test(u)));
    const again = ok(launch(s, { layers: [k] }));
    assert.equal(again.launch_digest, spec.launch_digest, 'no temp path in what the digest binds');
  } finally {
    s.done();
  }
});

test('the generated extension: root and data from where it sits, the placeholders replaced, a ./ command under the root, the cwd placed, the data directory made', async () => {
  const s = box();
  try {
    const spec = ok(launch(s, { layers: [kit(s.root)] }));
    const tree = spec.files.find((f) => f.role === 'plugin.notes-kit').path;
    // Loaded as pi loads it, from its place in the tree (.mjs, since node needs the type here).
    const ext = path.join(tree, 'hs-plugin.mjs');
    fs.copyFileSync(path.join(tree, 'hs-plugin.js'), ext);
    const registered = {};
    (await import(pathToFileURL(ext).href)).default({ registerMcpServer: (id, c) => { registered[id] = c; } });
    const root = path.join(tree, 'package');
    const data = path.join(spec.temp_dir, 'plugin-data', 'notes-kit');
    assert.deepEqual(registered['notes-kit__local'], {
      command: path.join(root, 'bin/run'), args: ['--root', `${root}/x`, 'literal-${HS_KEEP}'],
      env: { DATA: `${data}/db`, PLUGIN_ROOT: root, PLUGIN_DATA: data }, cwd: root, exposure: 'direct',
    });
    assert.equal(registered['notes-kit__onpath'].cwd, path.join(data, 'work'));
    assert.deepEqual(registered['notes-kit__remote'], { url: 'https://example.com/mcp', headers: { 'X-Team': 'a' }, exposure: 'direct' });
    assert.ok(fs.statSync(data).isDirectory());
  } finally {
    s.done();
  }
});

test('pi launch refuses, by name: an sse server, a server named like the spec\'s or the folder\'s, a temp root holding $, and claude-plugin', () => {
  const s = box();
  try {
    let r = s.call('launch-spec', { layers: [kit(s.root, { servers: { old: { type: 'sse', url: 'https://example.com/sse' } }, layerName: 'sse' })], headless: true });
    assert.equal(r.error.code, 'item_unsupported');
    assert.match(r.error.message, /server "old": pi supports streamable HTTP, not SSE/);
    r = s.call('launch-spec', { layers: [kit(s.root, { layerName: 'clash', extra: '\n[mcp.notes-kit__local]\nexec = "/bin/true"\n' })], headless: true });
    assert.match(r.error.message, /its server notes-kit__local has the tools' names of the spec's mcp\.notes-kit__local/);
    r = s.call('launch-spec', { layers: [kit(s.root, { layerName: 'clash-ns', extra: '\n[mcp.notes_kit__local]\nexec = "/bin/true"\n' })], headless: true });
    assert.match(r.error.message, /has the tools' names of the spec's mcp\.notes_kit__local \(pi makes a - in a server id _\)/, 'a - and a _ name the same tools');
    write(s.folder, 'mcp.json', JSON.stringify({ mcpServers: { 'notes-kit__remote': { command: '/bin/true' } } }));
    r = s.call('launch-spec', { layers: [kit(s.root, { layerName: 'folder-clash' })], headless: true });
    assert.match(r.error.message, /has the name of one the folder's mcp\.json defines/);
    fs.rmSync(path.join(s.folder, 'mcp.json'));
    r = s.call('launch-spec', { layers: [kit(s.root, { format: 'claude-plugin', layerName: 'cp' })], headless: true });
    assert.equal(r.error.code, 'item_unsupported');
    assert.match(r.error.message, /format claude-plugin: pi 1\.5 has no loader/);
  } finally {
    s.done();
  }
  const d = box('t$mp');
  try {
    const r = launch(d, { layers: [kit(d.root)] });
    assert.equal(r.error?.code, 'item_unsupported');
    assert.match(r.error.message, /the temp root .* holds \$ or a leading !/);
  } finally {
    d.done();
  }
});

test('materialize: the tree in hs-run/ and one member of settings.json packages, the user\'s members kept; a launch skips it; remove keeps the data unless --purge-data', () => {
  const s = box();
  try {
    write(s.folder, 'settings.json', '{\n  "packages": [\n    "npm:@example/mine@1.0.0"\n  ],\n  "theme": "dark"\n}\n');
    const k = kit(s.root);
    const plan = ok(s.call('plan', { layers: [k], owner: 'builder', mode: 'materialize' }));
    assert.deepEqual(plan.operations.map((o) => o.address_id).sort(), ['hs-run/plugin.notes-kit', 'settings.json#packages[plugin.notes-kit]']);
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const settings = JSON.parse(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { packages: ['npm:@example/mine@1.0.0', './hs-run/plugin.notes-kit'], theme: 'dark' });
    assert.ok(fs.existsSync(path.join(s.folder, 'hs-run/plugin.notes-kit/hs-plugin.js')));
    const spec = ok(launch(s, { layers: [k] }));
    assert.ok(spec.skipped.some((x) => x.item === 'plugin.notes-kit' && /installed in the folder by a plan, at this content/.test(x.reason)));
    // A server wrote data; the folder's own member was edited around ours.
    write(s.folder, 'hs-run/plugin-data/notes-kit/db', 'x');
    const edited = fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8').replace('"npm:@example/mine@1.0.0"', '"./mine-local",\n    "npm:@example/mine@1.0.0"');
    fs.writeFileSync(path.join(s.folder, 'settings.json'), edited);
    const removed = ok(s.call('remove', { owner: 'builder' }));
    assert.deepEqual(removed.plugin_data, { kept: ['hs-run/plugin-data/notes-kit'], removed: [] });
    assert.ok(removed.notes.includes('plugin data kept at hs-run/plugin-data/notes-kit; remove with --purge-data deletes it'));
    assert.equal(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'), edited.replace(',\n    "./hs-run/plugin.notes-kit"', ''), 'only the member is gone, every other byte kept');
    assert.ok(fs.existsSync(path.join(s.folder, 'hs-run/plugin-data/notes-kit/db')));
    assert.ok(!fs.existsSync(path.join(s.folder, 'hs-run/plugin.notes-kit')));
    // Again, with --purge-data.
    const again = ok(s.call('plan', { layers: [k], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan: again, receipt: receiptFor(again) }));
    const purged = ok(s.call('remove', { owner: 'builder', purge_data: true }));
    assert.deepEqual(purged.plugin_data, { kept: [], removed: ['hs-run/plugin-data/notes-kit'] });
    assert.ok(!fs.existsSync(path.join(s.folder, 'hs-run/plugin-data/notes-kit')));
  } finally {
    s.done();
  }
});

test('the packages member: a duplicate already present refuses the plan; one added by hand is the user\'s; a launch refuses a folder holding the plugin at other content', () => {
  const s = box();
  try {
    const k = kit(s.root);
    write(s.folder, 'settings.json', JSON.stringify({ packages: ['./hs-run/plugin.notes-kit', './hs-run/plugin.notes-kit'] }));
    let plan = s.call('plan', { layers: [k], owner: 'builder', mode: 'materialize' });
    assert.equal(plan.error?.code, 'write_refused', 'two entries for one address');
    write(s.folder, 'settings.json', JSON.stringify({ packages: ['./hs-run/plugin.notes-kit'] }));
    plan = s.call('plan', { layers: [k], owner: 'builder', mode: 'materialize' });
    assert.equal(plan.error?.code, 'unowned_conflict', 'a member the user added is in no ledger');
    const r = s.call('launch-spec', { layers: [k], headless: true });
    assert.equal(r.error?.code, 'item_unsupported');
    assert.match(r.error.message, /the folder holds this plugin at other content \(settings\.json#packages/);
  } finally {
    s.done();
  }
});

test('strict isolation: a plugin a plan installed is named again with -e from the folder, and its packages member is not refused', () => {
  const s = box();
  try {
    const k = kit(s.root);
    const plan = ok(s.call('plan', { layers: [k], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const strict = kit(s.root, { layerName: 'strict-kit' });
    fs.writeFileSync(path.join(strict, 'spec.toml'), `isolation = "strict"\n\n${fs.readFileSync(path.join(strict, 'spec.toml'), 'utf8')}`);
    const spec = ok(launch(s, { layers: [strict] }));
    const dir = path.join(s.folder, 'hs-run/plugin.notes-kit');
    assert.equal(spec.argv[spec.argv.indexOf(dir) - 1], '-e');
    assert.match(spec.launch_items.find((i) => i.item === 'plugin.notes-kit').via, /named again under strict isolation/);
  } finally {
    s.done();
  }
});
