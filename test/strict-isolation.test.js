// Strict isolation (design note v0.2 §8, question 7): `isolation = "strict"` asks that only the
// instructions and skills the spec names reach the agent. Claude Code and Codex refuse it, naming
// each path; OpenCode and pi close their escapes by switch, and pi refuses what the folder holds
// that no switch keeps out. No test starts a real harness: the binaries are stubs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { unclosable } from '../src/isolation.js';
import { layer, skillMd, tmpdir, write } from './fixtures.js';
import { linuxHost, ok, receiptFor } from './sandbox.js';

const REF = 'keychain:example/gateway-key';
const ENDPOINT = `[endpoints.openai-chat]\nbase_url = "https://gateway.example/v1"\ncredential = "${REF}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`;
const VERSION = { 'claude-code': '2.1.307 (Claude Code)', codex: 'codex-cli 0.160.0', opencode: 'opencode v2.2.7', pi: '1.5.2' };

function box(harness) {
  const root = tmpdir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folder = path.join(root, `${harness}-folder`);
  if (harness === 'opencode') for (const r of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(folder, r, 'opencode'), { recursive: true });
  else fs.mkdirSync(folder);
  const bin = write(root, `bin/${harness}`, `#!/bin/sh\necho "${VERSION[harness]}"\n`);
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home, tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness, harness_path: folder, bin, ...args } }, opts);
  const local = write(root, 'local.toml', ENDPOINT);
  return { root, home, folder, bin, local, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
// A layer whose spec says `isolation = "strict"`: a top-level key, so before the [spec] table.
function strictLayer(root, name, toml = '', files = {}, value = 'strict') {
  const dir = layer(root, name, toml, files);
  const f = path.join(dir, 'spec.toml');
  fs.writeFileSync(f, `isolation = ${JSON.stringify(value)}\n\n${fs.readFileSync(f, 'utf8')}`);
  return dir;
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
const launch = (s, args) => {
  const refused = s.call('launch-spec', { headless: true, ...args });
  if (refused.error?.code !== 'receipt_required') return refused;
  return s.call('launch-spec', { headless: true, ...args, receipt: allow(refused) });
};
const KIT = ['[model.roles]', 'primary = "bench-primary"', ''].join('\n');
const kitFiles = { 'skills/notes/SKILL.md': skillMd('notes'), 'AGENTS.md': 'Spec rules.\n' };

test('validate: isolation is "default" or "strict"', () => {
  const s = box('opencode');
  try {
    const bad = strictLayer(s.root, 'bad', '', {}, 'paranoid');
    const v = ok(s.call('validate', { layers: [bad] }));
    assert.ok(v.problems.some((p) => p.item === 'isolation' && p.code === 'item_malformed' && /"default" or "strict"/.test(p.message)));
    for (const value of ['default', 'strict']) {
      const good = strictLayer(s.root, `good-${value}`, '', {}, value);
      assert.ok(!ok(s.call('validate', { layers: [good] })).problems.some((p) => p.item === 'isolation'), value);
    }
  } finally {
    s.done();
  }
});

test('describe: each harness says what strict does; Claude Code and Codex name what they would refuse for', () => {
  for (const h of ['claude-code', 'codex', 'opencode', 'pi']) {
    const s = box(h);
    try {
      const d = ok(s.call('describe', {}));
      assert.deepEqual(d.isolation.values, ['default', 'strict'], h);
      assert.match(d.isolation.project_instructions, /names them in the spec.*never added back/, h);
      if (h === 'claude-code' || h === 'codex') {
        assert.equal(d.isolation.strict.supported, false, h);
        assert.ok(d.isolation.strict.refused.some((p) => /working directory/.test(p)), `${h}: the project walk is named`);
      } else {
        assert.equal(d.isolation.strict.supported, true, h);
        assert.ok(d.isolation.strict.closes.some((c) => c.path === '~/.agents/skills'), h);
        assert.match(d.isolation.strict.launch_only, /only hs's own launches are isolated/);
      }
    } finally {
      s.done();
    }
  }
});

test('Claude Code and Codex: a strict launch and a strict plan are refused as isolation_unmet, naming the project walk', () => {
  for (const [h, re] of [['claude-code', /CLAUDE\.md, CLAUDE\.local\.md, AGENTS\.md and \.claude\/rules in the working directory and every parent/], ['codex', /AGENTS\.md from the project root \(its \.git\) down to the working directory/]]) {
    const s = box(h);
    try {
      const t = strictLayer(s.root, 'kit', KIT);
      const r = s.call('launch-spec', { layers: [t], headless: true });
      assert.equal(r.error?.code, 'isolation_unmet', h);
      assert.match(r.error.message, re, h);
      assert.match(r.error.message, /deliver without strict isolation, or on a harness that can/);
      assert.ok(r.error.items.some((p) => re.test(p)), `${h}: the path is an item`);
      const plan = s.call('plan', { layers: [t], owner: 'builder', mode: h === 'codex' ? 'materialize' : 'overlay' });
      assert.equal(plan.error?.code, 'isolation_unmet', `${h}: plan`);
    } finally {
      s.done();
    }
  }
});

test('Codex: a strict launch also names ~/.agents/skills when it is there', () => {
  const s = box('codex');
  try {
    fs.mkdirSync(path.join(s.home, '.agents', 'skills', 'x'), { recursive: true });
    const r = s.call('launch-spec', { layers: [strictLayer(s.root, 'kit', KIT)], headless: true });
    assert.ok(r.error.items.includes('~/.agents/skills'));
  } finally {
    s.done();
  }
});

test('unclosable: a located escape applies only when its path exists; a walk applies always; closable and strict ones never', () => {
  const root = tmpdir();
  try {
    const d = { name: 'Test', binding: { escapes: [
      { kind: 'inbound-read', path: '~/present', closable: false },
      { kind: 'inbound-read', path: '~/absent', closable: false },
      { kind: 'inbound-read', path: 'AGENTS.md in every parent', closable: false },
      { kind: 'inbound-read', path: '~/closed', closable: true },
      { kind: 'inbound-read', path: '~/switched', closable: false, strict: 'a switch' },
      { kind: 'outbound-write', path: '~/present', closable: false },
      { kind: 'inbound-read', path: '/nowhere-for-hs-tests/', closable: false, platforms: ['linux'] },
    ] } };
    fs.mkdirSync(path.join(root, 'present'));
    fs.mkdirSync(path.join(root, 'closed'));
    fs.mkdirSync(path.join(root, 'switched'));
    assert.deepEqual(unclosable(d, { home: root, platform: 'linux' }).map((e) => e.path), ['~/present', 'AGENTS.md in every parent']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode strict launch: the project walk off, skills denied but the spec\'s, and a config directory of its own; the spec\'s carriers still named', () => {
  const s = box('opencode');
  try {
    const t = strictLayer(s.root, 'kit', KIT, kitFiles);
    const spec = ok(launch(s, { layers: [t], local: s.local }));
    assert.equal(spec.env_set.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
    const dir = spec.env_set.OPENCODE_CONFIG_DIR;
    assert.equal(dir, spec.files.find((f) => f.role === 'hs-config').path);
    assert.equal(path.dirname(dir), spec.temp_dir);
    assert.deepEqual(fs.readdirSync(dir), ['README'], 'empty of config: the folder\'s config/opencode/ is not read');
    assert.ok(!spec.env_unset.includes('OPENCODE_CONFIG_DIR'));
    const c = JSON.parse(spec.env_set.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(c.permissions, [{ action: 'skill', resource: '*', effect: 'deny' }, { action: 'skill', resource: 'notes', effect: 'allow' }]);
    assert.equal(c.skills.length, 1);
    assert.equal(c.instructions.length, 1);
    assert.equal(fs.readFileSync(c.instructions[0], 'utf8'), '# kit\n\nSpec rules.\n', 'only the spec\'s AGENTS.md: the project\'s is never added');
    assert.deepEqual(spec.launch_items.find((i) => i.item === 'isolation'), { item: 'isolation', value: 'strict', via: 'OPENCODE_DISABLE_PROJECT_CONFIG=1; skill permissions in the inline layer that deny every skill but the spec\'s; OPENCODE_CONFIG_DIR set to an empty directory of the launch\'s own' });
    assert.ok(spec.notes.some((n) => /isolation = "strict": the folder's config\/opencode\/ .* is not read; the launch carries what a plan of this spec installed itself.*names them in the spec/.test(n)));
    // The digest leaves the temp paths out.
    const again = ok(launch(s, { layers: [t], local: s.local }));
    assert.equal(again.launch_digest, spec.launch_digest);
  } finally {
    s.done();
  }
});

test('OpenCode strict launch after materialize: what the plan installed is carried by the launch, since the folder\'s config is not read', () => {
  const s = box('opencode');
  try {
    // No model role: a persisted model would need the provider/model form.
    const t = strictLayer(s.root, 'kit', '[mcp.db]\nexec = "/bin/true"\n', { 'skills/notes/SKILL.md': skillMd('notes') });
    const plain = layer(s.root, 'plain', '[mcp.db]\nexec = "/bin/true"\n', { 'skills/notes/SKILL.md': skillMd('notes') });
    const plan = ok(s.call('plan', { layers: [plain], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const def = ok(launch(s, { layers: [plain] }));
    assert.ok(['mcp.db', 'skill.notes'].every((id) => def.skipped.some((x) => x.item === id)), 'the default launch skips them');
    const refused = s.call('launch-spec', { layers: [t], headless: true });
    assert.equal(refused.error.code, 'receipt_required');
    assert.deepEqual(refused.error.items[0].risks.map((r) => r.item).sort(), ['mcp.db', 'skill.notes'], 'the strict launch carries both, under its own receipt');
    const spec = ok(launch(s, { layers: [t] }));
    const c = JSON.parse(spec.env_set.OPENCODE_CONFIG_CONTENT);
    assert.ok(c.mcp.servers.db, 'the server is in the inline layer');
    assert.equal(spec.skipped.filter((x) => /installed in the folder by a plan/.test(x.reason)).length, 0);
  } finally {
    s.done();
  }
});

test('OpenCode: a strict plan is launch only; the default has nothing to deliver', () => {
  const s = box('opencode');
  try {
    const plan = ok(s.call('plan', { layers: [strictLayer(s.root, 'kit')], owner: 'builder', mode: 'materialize' }));
    assert.match(plan.launch_only.find((x) => x.item === 'isolation').via, /^launch-spec: OPENCODE_DISABLE_PROJECT_CONFIG=1.*only hs's own launches are isolated/);
    const def = ok(s.call('plan', { layers: [strictLayer(s.root, 'def', '', {}, 'default')], owner: 'builder', mode: 'materialize' }));
    assert.match(def.skipped.find((x) => x.item === 'isolation').reason, /isolation = "default": .*nothing to deliver/);
  } finally {
    s.done();
  }
});

test('pi strict launch: --no-skills, --no-context-files and --no-approve; the spec\'s skill and AGENTS.md still passed', () => {
  const s = box('pi');
  try {
    const t = strictLayer(s.root, 'kit', KIT, kitFiles);
    const spec = ok(launch(s, { layers: [t], local: s.local }));
    const a = spec.argv;
    for (const f of ['--no-skills', '--no-context-files', '--no-approve']) assert.ok(a.includes(f), f);
    assert.ok(a[a.indexOf('--skill') + 1].endsWith(path.join('skills', 'notes')));
    assert.ok(a.includes('--append-system-prompt'));
    assert.equal(spec.launch_items.find((i) => i.item === 'isolation').value, 'strict');
    assert.ok(spec.notes.some((n) => /the folder's own context files and skills are kept out too/.test(n)));
  } finally {
    s.done();
  }
});

test('pi strict launch after materialize: a skill the plan installed is named again with --skill; its server is not refused', () => {
  const s = box('pi');
  try {
    const toml = '[mcp.db]\nexec = "/bin/true"\n';
    const plain = layer(s.root, 'plain', toml, { 'skills/notes/SKILL.md': skillMd('notes') });
    const t = strictLayer(s.root, 'kit', toml, { 'skills/notes/SKILL.md': skillMd('notes') });
    const plan = ok(s.call('plan', { layers: [plain], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const spec = ok(launch(s, { layers: [t] }));
    const i = spec.argv.indexOf(path.join(s.folder, 'skills', 'notes'));
    assert.ok(i > 0 && spec.argv[i - 1] === '--skill', 'the installed skill, from the folder');
    assert.match(spec.launch_items.find((x) => x.item === 'skill.notes').via, /installed by a plan at this content, and named again since --no-skills drops discovery/);
    assert.ok(spec.skipped.some((x) => x.item === 'mcp.db'), 'the server the plan installed stays the folder\'s');
  } finally {
    s.done();
  }
});

test('pi strict launch: refused, naming each, when the folder holds instructions, extensions, packages or servers no plan installed', () => {
  const cases = [
    [(f) => write(f, 'SYSTEM.md', 'x'), 'SYSTEM.md'],
    [(f) => write(f, 'APPEND_SYSTEM.md', 'x'), 'APPEND_SYSTEM.md'],
    [(f) => write(f, 'extensions/mine.ts', 'x'), 'extensions/ (1 entry)'],
    [(f) => write(f, 'settings.json', JSON.stringify({ packages: ['npm:some-pi-package'] })), 'settings.json#packages'],
    [(f) => write(f, 'settings.json', JSON.stringify({ extensions: ['./x.ts'] })), 'settings.json#extensions'],
    [(f) => write(f, 'mcp.json', JSON.stringify({ mcpServers: { other: { command: '/bin/true' } } })), 'mcp.json#mcpServers/other'],
  ];
  for (const [plant, named] of cases) {
    const s = box('pi');
    try {
      plant(s.folder);
      const r = s.call('launch-spec', { layers: [strictLayer(s.root, 'kit', KIT)], headless: true });
      assert.equal(r.error?.code, 'isolation_unmet', named);
      assert.deepEqual(r.error.items, [named]);
      assert.match(r.error.message, /no switch keeps out without dropping hs's own extension/);
      assert.ok(ok(s.call('launch-spec', { layers: [layer(s.root, 'plain', KIT)], headless: true })), `${named}: a default launch is not refused`);
    } finally {
      s.done();
    }
  }
});
