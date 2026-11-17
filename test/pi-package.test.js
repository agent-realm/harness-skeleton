// Milestone 8.5: pi's own package format (design note v0.2 §5.7), delivered whole: at launch with
// -e, under materialize as hs-run/pipkg.<name>/ and a member of settings.json `packages`. A
// package with extensions is refused beside a blocking hook and under strict isolation; validate
// keeps its resource paths inside it and requires its dependencies bundled. No test starts a real
// harness: the binary is a stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { resolve } from '../src/spec/layers.js';
import { validate } from '../src/spec/validate.js';
import piDescriptor from '../src/drivers/pi/descriptor.js';
import { layer, skillMd, tmpdir, write } from './fixtures.js';
import { linuxHost, ok, receiptFor } from './sandbox.js';

function box() {
  const root = fs.realpathSync.native(tmpdir());
  const folder = path.join(root, 'pi-folder');
  fs.mkdirSync(folder);
  const bin = write(root, 'bin/pi', '#!/bin/sh\necho "1.5.2"\n');
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home: path.join(root, 'home'), tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'pi', harness_path: folder, bin, ...args } }, opts);
  return { root, folder, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
// A layer with one pi package under packages/<name>, and its plugin item; `toml` adds items.
function kit(root, { name = 'tools', layerName = 'kit', manifest, files = {}, toml = '', strict = false } = {}) {
  const base = `packages/${name}`;
  const pkg = manifest === null ? {} : { [`${base}/package.json`]: JSON.stringify(manifest ?? { name, version: '1.0.0', pi: { extensions: ['./ext.js'], skills: ['./skills'] } }) };
  const dir = layer(root, layerName, `[plugin.${JSON.stringify(name)}]\nsource = ${JSON.stringify(base)}\nformat = "pi-package"\n${toml}`, {
    ...pkg,
    [`${base}/ext.js`]: 'export default function () {}\n',
    [`${base}/skills/notes/SKILL.md`]: skillMd('notes'),
    ...Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined).map(([k, v]) => [`${base}/${k}`, v])),
  });
  // A file given as undefined is left out (the fixture's ext.js, say).
  for (const [k, v] of Object.entries(files)) if (v === undefined) fs.rmSync(path.join(dir, base, k), { recursive: true, force: true });
  if (strict) fs.writeFileSync(path.join(dir, 'spec.toml'), `isolation = "strict"\n\n${fs.readFileSync(path.join(dir, 'spec.toml'), 'utf8')}`);
  return dir;
}
const SKILLS_ONLY = (name = 'tools') => ({ name, version: '1.0.0', pi: { extensions: [], skills: ['./skills'] } });
const GUARD = '\n[hook.guard]\nevent = "PreToolUse"\nmatch = { tool = ["shell"] }\nrun = { exec = "/bin/true" }\n';
const AFTER = '\n[hook.after]\nevent = "PostToolUse"\nrun = { exec = "/bin/true" }\n';
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
const launch = (s, args) => {
  const refused = s.call('launch-spec', { headless: true, ...args });
  if (refused.error?.code !== 'receipt_required') return refused;
  return s.call('launch-spec', { headless: true, ...args, receipt: allow(refused) });
};
const errors = (dir) => validate(resolve([dir]), piDescriptor).problems.filter((p) => p.severity === 'error');

test('describe: pi-package on pi is native, with its refusals named', () => {
  const s = box();
  try {
    const f = ok(s.call('describe', {})).capabilities.find((c) => c.capability === 'plugins').facets.formats['pi-package'];
    assert.equal(f.mechanism, 'native');
    assert.deepEqual(f.components, ['extensions', 'skills', 'prompts', 'themes']);
    for (const re of [/plugin_path_unsupported/, /not bundled in node_modules/, /beside a blocking hook/, /isolation_unmet: a package with extensions under strict/]) assert.ok(f.refuses.some((r) => re.test(r)), re);
  } finally {
    s.done();
  }
});

test('validate: resource paths stay inside the package, dependencies are bundled, and the name is the item\'s', () => {
  const s = box();
  try {
    assert.deepEqual(errors(kit(s.root)), []);
    for (const [i, entry] of ['../outside', '/abs/ext.js', '~/ext.js', 'npm:@example/ext', 'https://example.com/ext.js'].entries()) {
      const p = errors(kit(s.root, { layerName: `p${i}`, manifest: { name: 'tools', pi: { extensions: [entry] } } }));
      assert.ok(p.some((x) => x.code === 'plugin_path_unsupported' && /pi\.extensions names a resource outside the package/.test(x.message)), entry);
    }
    assert.deepEqual(errors(kit(s.root, { layerName: 'filter', manifest: { name: 'tools', pi: { extensions: ['./ext.js', '!./old.js'] } } })), [], 'a filter mark is not a path');
    const missing = errors(kit(s.root, { layerName: 'dep', manifest: { name: 'tools', dependencies: { 'left-pad': '1.0.0' }, pi: { extensions: ['./ext.js'] } } }));
    assert.ok(missing.some((x) => x.code === 'plugin_field_unsupported' && /dependencies names left-pad, which is not bundled in node_modules\/.*stops pi from starting/.test(x.message)));
    assert.deepEqual(errors(kit(s.root, { layerName: 'bundled', manifest: { name: 'tools', dependencies: { '@scope/dep': '1.0.0' }, pi: { extensions: ['./ext.js'] } }, files: { 'node_modules/@scope/dep/index.js': 'export default 1;\n' } })), []);
    assert.ok(errors(kit(s.root, { layerName: 'other-name', manifest: { name: 'not-tools', pi: { extensions: [] } } })).some((x) => x.code === 'plugin_name_mismatch'));
  } finally {
    s.done();
  }
});

test('pi launch: the package as it is, -e, runs-code bound by a digest over the whole tree, a native addon named, the reach said', () => {
  const s = box();
  try {
    const k = kit(s.root, { files: { 'node_modules/dep/index.js': 'export default 1;\n', 'node_modules/dep/build/fast.node': 'binary' }, manifest: { name: 'tools', dependencies: { dep: '1.0.0' }, pi: { extensions: ['./ext.js'] } } });
    const refused = s.call('launch-spec', { layers: [k], headless: true });
    assert.equal(refused.error.code, 'receipt_required');
    const risk = refused.error.items[0].risks.find((r) => r.item === 'plugin.tools');
    assert.equal(risk.risk, 'runs-code');
    assert.deepEqual(risk.native_addons, ['node_modules/dep/build/fast.node']);
    assert.match(risk.note, /read the launch's environment, credential variables included, and reach the network/);
    const spec = ok(launch(s, { layers: [k] }));
    const tree = spec.files.find((f) => f.role === 'plugin.tools').path;
    assert.equal(spec.argv[spec.argv.indexOf(tree) - 1], '-e');
    assert.ok(fs.existsSync(path.join(tree, 'node_modules/dep/index.js')), 'copied whole');
    // A changed dependency is another digest: the receipt no longer fits.
    fs.writeFileSync(path.join(k, 'packages/tools/node_modules/dep/index.js'), 'export default 2;\n');
    const again = s.call('launch-spec', { layers: [k], headless: true, receipt: allow(refused) });
    assert.equal(again.error?.code, 'receipt_required');
  } finally {
    s.done();
  }
});

test('a package with extensions beside a blocking hook is refused, naming both; beside a notifying hook it is carried with a note; a skills-only package passes', () => {
  const s = box();
  try {
    let r = s.call('launch-spec', { layers: [kit(s.root, { layerName: 'g', toml: GUARD })], headless: true });
    assert.equal(r.error?.code, 'item_unsupported');
    assert.match(r.error.message, /plugin\.tools: its extensions are code in pi's process.*act with no tool call at all.*the blocking hook hook\.guard \(PreToolUse\) would not hold beside it/);
    assert.deepEqual(r.error.items, ['plugin.tools', 'hook.guard']);
    const plan = s.call('plan', { layers: [kit(s.root, { layerName: 'gp', toml: GUARD })], owner: 'builder', mode: 'materialize' });
    assert.equal(plan.error?.code, 'item_unsupported');
    const after = ok(launch(s, { layers: [kit(s.root, { layerName: 'a', toml: AFTER })] }));
    assert.ok(after.notes.some((n) => /plugin\.tools: .*the notifying hooks of this launch see only what reaches them/.test(n)));
    r = launch(s, { layers: [kit(s.root, { layerName: 'so', manifest: SKILLS_ONLY(), toml: GUARD })] });
    assert.equal(r.ok, true, 'skills, prompts and themes are files the digest binds');
  } finally {
    s.done();
  }
});

test('strict isolation refuses a package with extensions, and carries a skills-only one', () => {
  const s = box();
  try {
    const r = s.call('launch-spec', { layers: [kit(s.root, { strict: true })], headless: true });
    assert.equal(r.error?.code, 'isolation_unmet');
    assert.match(r.error.message, /isolation = "strict": plugin\.tools: its extensions are code in pi's process.*which strict cannot keep to the spec/);
    const plan = s.call('plan', { layers: [kit(s.root, { strict: true, layerName: 'sp' })], owner: 'builder', mode: 'materialize' });
    assert.equal(plan.error?.code, 'isolation_unmet');
    assert.equal(launch(s, { layers: [kit(s.root, { strict: true, layerName: 'so', manifest: SKILLS_ONLY() })] }).ok, true);
  } finally {
    s.done();
  }
});

test('materialize: the copy in hs-run/ and a packages member; a launch skips it; remove takes both and touches no plugin data', () => {
  const s = box();
  try {
    write(s.folder, 'settings.json', '{\n  "packages": [\n    "npm:@example/mine@1.0.0"\n  ]\n}\n');
    const k = kit(s.root);
    const plan = ok(s.call('plan', { layers: [k], owner: 'builder', mode: 'materialize' }));
    assert.deepEqual(plan.operations.map((o) => o.address_id).sort(), ['hs-run/pipkg.tools', 'settings.json#packages[pipkg.tools]']);
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8')).packages, ['npm:@example/mine@1.0.0', './hs-run/pipkg.tools']);
    assert.ok(fs.existsSync(path.join(s.folder, 'hs-run/pipkg.tools/ext.js')));
    const spec = ok(launch(s, { layers: [k] }));
    assert.ok(spec.skipped.some((x) => x.item === 'plugin.tools' && /installed in the folder by a plan, at this content/.test(x.reason)));
    write(s.folder, 'hs-run/plugin-data/tools/keep', 'x');
    const removed = ok(s.call('remove', { owner: 'builder', purge_data: true }));
    assert.equal(removed.plugin_data, undefined, 'a native package has no data directory of hs\'s');
    assert.ok(fs.existsSync(path.join(s.folder, 'hs-run/plugin-data/tools/keep')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8')).packages, ['npm:@example/mine@1.0.0']);
    // A member the user added by hand: a launch refuses to load a second copy beside it.
    write(s.folder, 'settings.json', JSON.stringify({ packages: ['./hs-run/pipkg.tools'] }));
    const r = s.call('launch-spec', { layers: [k], headless: true });
    assert.match(r.error.message, /the folder holds this package at other content/);
  } finally {
    s.done();
  }
});

// Whether a package has extensions, read as pi's own loader reads it (descriptor, pi_package;
// plugins.js nativePackage): a manifest field counts only as a list of strings; with none, the four
// conventional directories, if any exists; with none of those, the package itself.
test('extensions by pi\'s loader rule: the package itself when nothing is listed and no directory exists; a listed or conventional skills-only package has none', () => {
  const s = box();
  try {
    const guarded = (layerName, manifest, files) => s.call('launch-spec', { layers: [kit(s.root, { layerName, manifest, files, toml: GUARD })], headless: true });
    // No list, none of the four directories, a root index.js: the package itself is the extension.
    let r = guarded('itself', { name: 'tools' }, { 'index.js': 'export default function () {}\n', 'ext.js': undefined, skills: undefined });
    assert.equal(r.error?.code, 'item_unsupported', 'the package itself loads as an extension');
    const strict = s.call('launch-spec', { layers: [kit(s.root, { layerName: 'itself-strict', manifest: { name: 'tools' }, files: { 'index.js': 'x', 'ext.js': undefined, skills: undefined }, strict: true })], headless: true });
    assert.equal(strict.error?.code, 'isolation_unmet');
    // A listed skills-only package, a root index.js beside it: nothing but the skills loads.
    r = launch(s, { layers: [kit(s.root, { layerName: 'listed', manifest: SKILLS_ONLY(), files: { 'index.js': 'x' }, toml: GUARD })] });
    assert.equal(r.ok, true);
    // No list, a skills/ directory: the conventional directories, no extensions/; the root index.js does not load.
    r = launch(s, { layers: [kit(s.root, { layerName: 'conventional', manifest: { name: 'tools' }, files: { 'index.js': 'x' }, toml: GUARD })] });
    assert.equal(r.ok, true);
    // An empty extensions/ directory still stops the fallback to the package itself.
    const k = kit(s.root, { layerName: 'empty-ext', manifest: { name: 'tools' }, files: { 'index.js': 'x' }, toml: GUARD });
    fs.rmSync(path.join(k, 'packages/tools/skills'), { recursive: true, force: true });
    fs.mkdirSync(path.join(k, 'packages/tools/extensions'));
    r = launch(s, { layers: [k] });
    assert.equal(r.ok, true);
  } finally {
    s.done();
  }
});

test('validate: a pi block that is not an object, or a resource field that is not a list of paths, is refused', () => {
  const s = box();
  try {
    for (const [i, manifest] of [{ name: 'tools', pi: 'x' }, { name: 'tools', pi: { skills: 'skills' } }, { name: 'tools', pi: { extensions: null } }, { name: 'tools', pi: { extensions: ['./ext.js', 3] } }].entries()) {
      const p = errors(kit(s.root, { layerName: `shape${i}`, manifest }));
      assert.ok(p.some((x) => x.code === 'plugin_field_unsupported' && /is not (an object|a list of paths); pi keeps a resource field only as a list of strings/.test(x.message)), JSON.stringify(manifest.pi));
    }
  } finally {
    s.done();
  }
});

test('validate: a resource pattern beyond * and ?, or with a .. segment, is refused; * and ? pass', () => {
  const s = box();
  try {
    for (const [i, entry] of ['{..,x}/*.js', '[.][.]/*.js', '.[.]/*.js', './{.,..}/*.js', '{../,}*.js', 'x/{..,y}/../*.js', 'x/../ext.js', 'ext(1).js', 'a\\b.js'].entries()) {
      const p = errors(kit(s.root, { layerName: `g${i}`, manifest: { name: 'tools', pi: { extensions: [entry] } } }));
      assert.ok(p.some((x) => x.code === 'plugin_path_unsupported' && /a pattern beyond \* and \?/.test(x.message)), entry);
    }
    assert.deepEqual(errors(kit(s.root, { layerName: 'star', manifest: { name: 'tools', pi: { extensions: ['./*.js', 'ex?.js'] } } })), []);
  } finally {
    s.done();
  }
});
