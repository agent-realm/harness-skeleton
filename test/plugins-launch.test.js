// Agent Plugins packages (design note §5.7): validate's refusals on each harness's route, the
// package bound in the spec digest, and the Claude Code translation carried at launch with
// --plugin-dir under the launch receipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolve } from '../src/spec/layers.js';
import { validate } from '../src/spec/validate.js';
import ccDescriptor from '../src/drivers/claude-code/descriptor.js';
import cxDescriptor from '../src/drivers/codex/descriptor.js';
import { layer, skillMd, write } from './fixtures.js';
import { ok, receiptFor, sandbox, settings } from './sandbox.js';
import { digestOf } from '../src/records.js';

const PLUGIN = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const META = { version: '1.2.0', description: 'a kit', author: { name: 'A' }, homepage: 'https://example.com', repository: 'https://example.com/r', license: 'MIT', keywords: ['k'] };

// A layer `kit` holding one package under plugins/<name>, and its plugin item.
function kitLayer(root, { name = 'notes-kit', id = name, manifest = {}, mcp, files = {}, item = {} } = {}) {
  const base = `plugins/${name}`;
  const pkg = {
    [`${base}/plugin.json`]: JSON.stringify({ $schema: PLUGIN, name, ...META, extensions: { 'com.example': { x: 1 } }, ...manifest }),
    [`${base}/skills/notes/SKILL.md`]: skillMd('notes', 'Take notes.'),
    [`${base}/commands/inert.md`]: '---\ndescription: never discovered\n---\n',
    [`${base}/hooks/hooks.json`]: '{"hooks":{}}',
    [`${base}/bin/run`]: '#!/bin/sh\nexit 0\n',
    ...(mcp === null ? {} : { [`${base}/mcp.json`]: JSON.stringify(mcp ?? { $schema: MCP, mcpServers: {
      local: { type: 'stdio', command: './bin/run', args: ['--root', '${PLUGIN_ROOT}/x'], env: { DATA: '${PLUGIN_DATA}/db' } },
      onpath: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/srv.js'] },
      remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Team': 'a' } },
      legacy: { type: 'sse', url: 'https://example.com/sse' },
    } }) }),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`${base}/${k}`, v])),
  };
  const fields = { source: base, format: 'agent-plugins', ...item };
  const toml = `[plugin.${JSON.stringify(id)}]\n${Object.entries(fields).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n')}\n`;
  const dir = layer(root, 'kit', toml, pkg);
  fs.chmodSync(path.join(dir, base, 'bin/run'), 0o755);
  return dir;
}
const problems = (dir, d = ccDescriptor) => validate(resolve([dir]), d).problems.filter((p) => p.severity === 'error');
const codesOf = (dir, d) => problems(dir, d).map((p) => p.code);

test('validate: a valid package passes on Claude Code and Codex, and plugin is a checked kind', () => {
  const s = sandbox();
  try {
    const kit = kitLayer(s.root);
    for (const d of [ccDescriptor, cxDescriptor]) {
      const v = validate(resolve([kit]), d);
      assert.deepEqual(v.problems, [], d.name);
      assert.ok(!v.unchecked_kinds.includes('plugin'));
      assert.deepEqual(v.plugins.map((p) => p.id), ['plugin.notes-kit']);
    }
  } finally {
    s.done();
  }
});

test('validate: the item\'s shape, its source and its name', () => {
  const s = sandbox();
  try {
    const out = kitLayer(s.root, { item: { source: '../elsewhere' } });
    assert.deepEqual(codesOf(out), ['item_malformed']);
    fs.rmSync(out, { recursive: true });
    const extra = kitLayer(s.root, { item: { require: 'required' } });
    assert.deepEqual(codesOf(extra), ['item_malformed']);
    fs.rmSync(extra, { recursive: true });
    const named = kitLayer(s.root, { id: 'other' });
    assert.deepEqual(codesOf(named), ['plugin_name_mismatch']);
    fs.rmSync(named, { recursive: true });
    // A source reached through a symlink is not bound, so the item is refused.
    const linked = kitLayer(s.root);
    fs.renameSync(path.join(linked, 'plugins'), path.join(s.root, 'real-plugins'));
    fs.symlinkSync(path.join(s.root, 'real-plugins'), path.join(linked, 'plugins'));
    assert.deepEqual(codesOf(linked), ['item_malformed']);
    fs.rmSync(linked, { recursive: true });
    const reserved = kitLayer(s.root, { name: 'hs' });
    assert.deepEqual(codesOf(reserved), ['plugin_name_reserved'], 'the name of the plugin hs launches skills in');
    assert.deepEqual(codesOf(reserved, cxDescriptor), [], 'not reserved where hs launches no such plugin');
  } finally {
    s.done();
  }
});

test('validate: plugin_version_unsupported for either file, plugin_skill_invalid naming the skill', () => {
  const s = sandbox();
  try {
    const future = kitLayer(s.root, { manifest: { $schema: 'https://agent-plugins.org/schemas/9.9.9/plugin.schema.json' } });
    const p = problems(future);
    assert.deepEqual(p.map((x) => x.code), ['plugin_version_unsupported']);
    assert.match(p[0].message, /plugin\.json's \$schema names Agent Plugins 9\.9\.9; this adapter maps 1\.0\.0 on Claude Code/);
    fs.rmSync(future, { recursive: true });
    const mixed = kitLayer(s.root, { mcp: { $schema: 'https://agent-plugins.org/schemas/9.9.9/mcp.schema.json', mcpServers: {} } });
    assert.match(problems(mixed)[0].message, /mcp\.json's \$schema names Agent Plugins 9\.9\.9.*without its MCP servers/);
    fs.rmSync(mixed, { recursive: true });
    const invalid = kitLayer(s.root, { files: { 'skills/no-desc/SKILL.md': '---\nname: no-desc\n---\n' } });
    const q = problems(invalid);
    assert.deepEqual(q.map((x) => [x.code, x.skill, x.item]), [['plugin_skill_invalid', 'no-desc', 'plugin.notes-kit']]);
  } finally {
    s.done();
  }
});

test('validate: literal text and a working directory beyond the root are refused on Claude Code\'s route only', () => {
  const s = sandbox();
  try {
    const literal = kitLayer(s.root, { mcp: { $schema: MCP, mcpServers: {
      a: { type: 'stdio', command: 'x', env: { TOKEN: '${HOME}' } },
      b: { type: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
    } } });
    const p = problems(literal);
    assert.deepEqual(p.map((x) => x.code), ['plugin_placeholder_literal', 'plugin_placeholder_literal']);
    assert.match(p[0].message, /server "a": env "TOKEN" holds \$\{…\} text the format keeps literal/);
    assert.ok(!p.some((x) => /HOME|API_TOKEN/.test(x.message)), 'the text is never echoed');
    assert.deepEqual(codesOf(literal, cxDescriptor), [], 'Codex is not a route that expands it');
    fs.rmSync(literal, { recursive: true });
    const cwd = kitLayer(s.root, { mcp: { $schema: MCP, mcpServers: {
      root: { type: 'stdio', command: 'x', cwd: '${PLUGIN_ROOT}' },
      sub: { type: 'stdio', command: 'x', cwd: './sub' },
    } } });
    assert.deepEqual(problems(cwd).map((x) => [x.code, /"sub"/.test(x.message)]), [['plugin_cwd_unsupported', true]]);
    assert.deepEqual(codesOf(cwd, cxDescriptor), []);
  } finally {
    s.done();
  }
});

test('the package is bound in the spec digest; a spec without a plugin keeps the digest it had', () => {
  const s = sandbox();
  try {
    const plain = resolve([s.team]);
    assert.deepEqual(plain.plugins, []);
    const kit = kitLayer(s.root);
    const before = resolve([kit]);
    assert.equal(before.plugins.length, 1);
    write(kit, 'plugins/notes-kit/skills/notes/extra.md', 'more');
    const after = resolve([kit]);
    assert.notEqual(after.digest, before.digest, 'a file added to the package changes the digest');
    assert.notEqual(after.plugins[0].sha256, before.plugins[0].sha256);
    assert.equal(resolve([s.team]).digest, plain.digest);
  } finally {
    s.done();
  }
});

test('a tombstone removes the plugin it names, never one whose name extends it with a dot; `plugin` removes them all', () => {
  const s = sandbox();
  try {
    const pkg = (name) => ({ [`p/${name}/plugin.json`]: JSON.stringify({ $schema: PLUGIN, name }) });
    const base = layer(s.root, 'base', '[plugin.notes]\nsource = "p/notes"\nformat = "agent-plugins"\n\n[plugin."notes.kit"]\nsource = "p/notes.kit"\nformat = "agent-plugins"\n\n[model.roles]\nprimary = "m"\nsmall = "s"\n', { ...pkg('notes'), ...pkg('notes.kit') });
    const one = layer(s.root, 'one', '[remove]\nitems = ["plugin.notes"]\n');
    const r = resolve([base, one]);
    assert.deepEqual(r.items.filter((i) => i.kind === 'plugin').map((i) => i.id), ['plugin.notes.kit']);
    assert.deepEqual(r.plugins.map((p) => p.id), ['plugin.notes.kit']);
    assert.deepEqual(r.removed.map((x) => x.id), ['plugin.notes']);
    const all = layer(s.root, 'all', '[remove]\nitems = ["plugin", "model.roles"]\n');
    const r2 = resolve([base, all]);
    assert.deepEqual(r2.items.filter((i) => i.kind === 'plugin' || i.kind === 'model.roles'), [], 'a kind removes every item of it');
    const model = layer(s.root, 'model', '[remove]\nitems = ["model"]\n');
    assert.deepEqual(resolve([base, model]).items.filter((i) => i.kind === 'model.roles'), [], 'a prefix of the kind still removes');
  } finally {
    s.done();
  }
});

test('plan on Claude Code: launch_only under overlay; a native format is not delivered', () => {
  const s = sandbox();
  try {
    const kit = kitLayer(s.root);
    const overlay = ok(s.call('plan', { layers: [kit], owner: 'builder', mode: 'overlay' }));
    assert.ok(overlay.launch_only.some((x) => x.item === 'plugin.notes-kit' && /--plugin-dir, translated to the \.claude-plugin layout/.test(x.via)));
    const native = layer(s.root, 'native', '[plugin.cc]\nsource = "p"\nformat = "claude-plugin"\n', { 'p/.claude-plugin/plugin.json': '{"name":"cc"}' });
    const launch = s.call('launch-spec', { layers: [native] });
    assert.equal(launch.error.code, 'not_implemented');
    assert.match(launch.error.message, /plugin\.cc \(format claude-plugin\)/);
  } finally {
    s.done();
  }
});

test('launch-spec on Claude Code: refused without a receipt; with one, the translated plugin of §5.7', () => {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  try {
    const kit = kitLayer(s.root);
    const bound = resolve([kit]).plugins[0];
    const folderBefore = fs.readdirSync(s.folder, { recursive: true }).sort();
    const refused = s.call('launch-spec', { layers: [kit] });
    assert.equal(refused.error.code, 'receipt_required');
    assert.deepEqual(fs.readdirSync(s.opts.tmpdir), [], 'a refused launch makes no temp dir');
    const [{ launch_digest, risks }] = refused.error.items;
    assert.deepEqual(risks, [
      { item: 'plugin.notes-kit', layer: 'kit', risk: 'runs-code', sha256: bound.sha256 },
      { item: 'plugin.notes-kit', layer: 'kit', risk: 'sends-data', server: 'remote', destination: 'https://example.com/mcp' },
      { item: 'plugin.notes-kit', layer: 'kit', risk: 'sends-data', server: 'legacy', destination: 'https://example.com/sse' },
    ]);

    const spec = ok(s.call('launch-spec', { layers: [kit], receipt: { format: 'hs-receipt/0.2', launch_digest, allows: ['plugin.notes-kit'] } }));
    const tree = spec.files.find((f) => f.role === 'plugin.notes-kit');
    assert.deepEqual(spec.argv.slice(1, 3), ['--plugin-dir', tree.path]);
    assert.equal(path.basename(tree.path), 'notes-kit');
    // At the translated plugin's root: the manifest, .mcp.json, a copy of skills/, and the package.
    assert.deepEqual(fs.readdirSync(tree.path).sort(), ['.claude-plugin', '.mcp.json', 'package', 'skills']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tree.path, '.claude-plugin/plugin.json'), 'utf8')), { name: 'notes-kit', ...META }, '$schema and extensions dropped, name and metadata kept');
    assert.deepEqual(fs.readdirSync(path.join(tree.path, 'package')).sort(), ['bin', 'commands', 'hooks', 'mcp.json', 'plugin.json', 'skills'], 'the package whole, nested');
    assert.ok(fs.statSync(path.join(tree.path, 'package/bin/run')).mode & 0o100, 'modes kept');
    assert.equal(fs.readFileSync(path.join(tree.path, 'skills/notes/SKILL.md'), 'utf8'), skillMd('notes', 'Take notes.'));
    const prelude = ['-c', 'cd "$PLUGIN_ROOT" && exec "$@"', 'sh'];
    const R = '${CLAUDE_PLUGIN_ROOT}/package';
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tree.path, '.mcp.json'), 'utf8')), { mcpServers: {
      local: { type: 'stdio', command: '/bin/sh', args: [...prelude, `${R}/bin/run`, '--root', `${R}/x`], env: { DATA: '${CLAUDE_PLUGIN_DATA}/db', PLUGIN_ROOT: R, PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' } },
      onpath: { type: 'stdio', command: '/bin/sh', args: [...prelude, 'node', `${R}/srv.js`], env: { PLUGIN_ROOT: R, PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' } },
      remote: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-Team': 'a' } },
      legacy: { type: 'sse', url: 'https://example.com/sse' },
    } });
    const item = spec.launch_items.find((x) => x.item === 'plugin.notes-kit');
    assert.match(item.via, /Agent Plugins 1\.0\.0 translated to the \.claude-plugin layout, the package nested under package\/: skills as \/notes-kit:<skill>; 4 MCP server\(s\), each stdio one started in the plugin root through a \/bin\/sh prelude \(bridged\)/);
    assert.ok(spec.unverified.some((u) => /PLUGIN_DATA keep its contents/.test(u)));
    assert.deepEqual(fs.readdirSync(s.folder, { recursive: true }).sort(), folderBefore, 'nothing written into the data folder');

    // The launch digest binds the package: an edit asks for a new receipt.
    write(kit, 'plugins/notes-kit/bin/run', '#!/bin/sh\nexit 1\n');
    const changed = s.call('launch-spec', { layers: [kit], receipt: { format: 'hs-receipt/0.2', launch_digest, allows: ['plugin.notes-kit'] } });
    assert.equal(changed.error.code, 'receipt_required');
    assert.notEqual(changed.error.items[0].launch_digest, launch_digest);
  } finally {
    s.done();
  }
});

test('launch-spec on Claude Code: one --plugin-dir per package, beside the skills plugin; a package without skills or mcp.json', () => {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  try {
    const kit = kitLayer(s.root, { mcp: null });
    // Only remote servers: sends-data, no runs-code.
    const remote = layer(s.root, 'remote', '[plugin.remote-only]\nsource = "p"\nformat = "agent-plugins"\n', {
      'p/plugin.json': JSON.stringify({ $schema: PLUGIN, name: 'remote-only' }),
      'p/mcp.json': JSON.stringify({ $schema: MCP, mcpServers: { r: { type: 'sse', url: 'https://example.com/sse' } } }),
    });
    const layers = [s.team, kit, remote];
    const refused = s.call('launch-spec', { layers });
    const [{ launch_digest, risks }] = refused.error.items;
    assert.deepEqual(risks.map((r) => [r.item, r.risk]), [['skill.notes', 'runs-code'], ['plugin.notes-kit', 'runs-code'], ['plugin.remote-only', 'sends-data']]);
    const spec = ok(s.call('launch-spec', { layers, receipt: { format: 'hs-receipt/0.2', launch_digest, allows: ['skill.notes', 'plugin.notes-kit', 'plugin.remote-only'] } }));
    const dirs = spec.argv.flatMap((a, i) => (spec.argv[i - 1] === '--plugin-dir' ? [a] : []));
    assert.deepEqual(dirs.map((d) => spec.files.find((f) => f.path === d).role), ['plugin', 'plugin.notes-kit', 'plugin.remote-only']);
    const kitTree = spec.files.find((f) => f.role === 'plugin.notes-kit').path;
    assert.deepEqual(fs.readdirSync(kitTree).sort(), ['.claude-plugin', 'package', 'skills'], 'no .mcp.json without an mcp.json');
    const remoteTree = spec.files.find((f) => f.role === 'plugin.remote-only').path;
    assert.deepEqual(fs.readdirSync(remoteTree).sort(), ['.claude-plugin', '.mcp.json', 'package'], 'no skills/ without skills');
  } finally {
    s.done();
  }
});

test('launch-spec on Claude Code: a package holding a symlink is refused before any write', () => {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  try {
    const kit = kitLayer(s.root);
    fs.symlinkSync('/etc/hostname', path.join(kit, 'plugins/notes-kit/skills/notes/link'));
    const r = s.call('launch-spec', { layers: [kit] });
    assert.equal(r.error.code, 'write_refused');
    assert.deepEqual(fs.readdirSync(s.opts.tmpdir), []);
  } finally {
    s.done();
  }
});

test('describe: the plugins capability on Claude Code, by format', () => {
  const s = sandbox();
  try {
    const d = ok(s.call('describe', {}));
    const cap = d.capabilities.find((c) => c.capability === 'plugins');
    assert.equal(cap.mechanism, 'bridged');
    assert.equal(cap.readiness, 'untested');
    assert.deepEqual(Object.keys(cap.facets.formats), ['agent-plugins']);
    assert.deepEqual(cap.facets.formats['agent-plugins'].versions, ['1.0.0']);
    assert.deepEqual(cap.facets.formats['agent-plugins'].components, ['skills', 'mcp']);
    assert.equal(cap.facets.formats['agent-plugins'].refuses.length, 2);
  } finally {
    s.done();
  }
});

// Milestone 6a.16: under materialize, a directory marketplace in hs-run/ and two settings.json keys.
test('materialize on Claude Code: the marketplace tree and two settings keys, receipted; the user\'s settings kept', () => {
  const s = sandbox();
  try {
    const kit = kitLayer(s.root);
    const plan = ok(s.call('plan', { layers: [kit], owner: 'builder', mode: 'materialize' }));
    const ops = plan.operations.filter((o) => o.item === 'plugin.notes-kit');
    assert.deepEqual(ops.map((o) => [o.address_id, o.risk]), [
      ['hs-run/plugin.notes-kit', ['runs-code', 'sends-data']],
      ['settings.json#extraKnownMarketplaces/hs-notes-kit', []],
      ['settings.json#enabledPlugins/notes-kit@hs-notes-kit', ['runs-code', 'sends-data']],
    ]);
    assert.match(ops[0].note, /a directory marketplace, hs-notes-kit, in hs-run\/plugin\.notes-kit.*Claude Code keeps its own records of the marketplace/);
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const at = path.join(s.folder, 'hs-run/plugin.notes-kit');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(at, '.claude-plugin/marketplace.json'), 'utf8')), { name: 'hs-notes-kit', owner: { name: 'harness-skeleton' }, plugins: [{ name: 'notes-kit', source: './plugin' }] });
    assert.deepEqual(fs.readdirSync(path.join(at, 'plugin')).sort(), ['.claude-plugin', '.mcp.json', 'package', 'skills']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(at, 'plugin/.claude-plugin/plugin.json'), 'utf8')).name, 'notes-kit');
    assert.ok(fs.statSync(path.join(at, 'plugin/package/bin/run')).mode & 0o100, 'modes kept');
    const st = settings(s.folder);
    assert.deepEqual(st.extraKnownMarketplaces, { 'hs-notes-kit': { source: { source: 'directory', path: at } } });
    assert.deepEqual(st.enabledPlugins, { 'notes-kit@hs-notes-kit': true });
    assert.equal(st.model, 'sonnet', 'the user\'s own keys stay');
  } finally {
    s.done();
  }
});

test('materialize on Claude Code: a launch skips a plugin a plan installed at this content, and carries an edited one', () => {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  try {
    const kit = kitLayer(s.root, { mcp: null });
    const plan = ok(s.call('plan', { layers: [kit], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const spec = ok(s.call('launch-spec', { layers: [kit] }));
    assert.ok(!spec.argv.includes('--plugin-dir'), 'installed: not carried again');
    assert.ok(spec.skipped.some((x) => x.item === 'plugin.notes-kit' && /installed in the folder by a plan, at this content/.test(x.reason)));
    write(kit, 'plugins/notes-kit/skills/notes/extra.md', 'more');
    const edited = s.call('launch-spec', { layers: [kit] });
    assert.equal(edited.error.code, 'receipt_required', 'an edited package is not what the plan installed: carried at launch, under a receipt');
    const again = ok(s.call('plan', { layers: [kit], owner: 'builder', mode: 'materialize' }));
    assert.deepEqual(again.operations.filter((o) => o.item === 'plugin.notes-kit').map((o) => [o.address_id, o.action]), [['hs-run/plugin.notes-kit', 'update']]);
  } finally {
    s.done();
  }
});

test('materialize on Claude Code: remove takes the tree and both keys away', () => {
  const s = sandbox();
  try {
    const kit = kitLayer(s.root, { mcp: null });
    const plan = ok(s.call('plan', { layers: [kit], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    ok(s.call('remove', { owner: 'builder' }));
    assert.ok(!fs.existsSync(path.join(s.folder, 'hs-run/plugin.notes-kit')));
    const st = settings(s.folder);
    assert.equal(st.enabledPlugins?.['notes-kit@hs-notes-kit'], undefined);
    assert.equal(st.extraKnownMarketplaces?.['hs-notes-kit'], undefined);
  } finally {
    s.done();
  }
});

test('materialize on Claude Code: a forged plan whose generated tree copies from outside the layers is refused', () => {
  const s = sandbox();
  try {
    const kit = kitLayer(s.root, { mcp: null });
    const plan = ok(s.call('plan', { layers: [kit], owner: 'builder', mode: 'materialize' }));
    const outside = path.join(s.root, 'outside');
    fs.mkdirSync(outside);
    write(outside, 'x.txt', 'not from a layer');
    const operations = plan.operations.map((o) => (o.address_id === 'hs-run/plugin.notes-kit'
      ? { ...o, source: { generated: { ...o.source.generated, entries: o.source.generated.entries.map((e, i) => (i === 0 ? { ...e, source: outside, sha256: resolve([outside]).digest } : e)) } } }
      : o));
    const { digest, ...body } = { ...plan, operations };
    const forged = { ...body, digest: 'sha256:' + digestOf(body) };
    const res = s.call('apply', { plan: forged, receipt: receiptFor(forged) });
    assert.equal(res.ok, false);
    assert.ok(['write_refused', 'plan_stale', 'plan_tampered'].includes(res.error.code), res.error.code);
    assert.ok(!fs.existsSync(path.join(s.folder, 'hs-run/plugin.notes-kit')));
  } finally {
    s.done();
  }
});
