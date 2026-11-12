// Milestone 7.1: the OpenCode driver (design note §4, §5, §8). A folder holds OpenCode's four XDG
// roots; a launch carries an inline config layer and a config directory, and passes --standalone,
// so a background service running in the folder never supplies the config. No test starts a real
// harness: the binary is a stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { layer, skillMd, tmpdir, write } from './fixtures.js';
import { linuxHost, ok } from './sandbox.js';

const REF = 'keychain:example/gateway-key';
const ENDPOINT = `[endpoints.openai-chat]\nbase_url = "https://gateway.example/v1"\ncredential = "${REF}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`;

function box(version = '2.2.7') {
  const root = tmpdir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folder = path.join(root, 'oc-folder');
  for (const r of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(folder, r, 'opencode'), { recursive: true });
  const bin = write(root, 'bin/opencode', `#!/bin/sh\necho "opencode v${version}"\n`);
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home, tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'opencode', harness_path: folder, bin, ...args } }, opts);
  return { root, home, folder, bin, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
const content = (spec) => JSON.parse(spec.env_set.OPENCODE_CONFIG_CONTENT);

test('describe: the four XDG roots bind the folder; the two escapes a launch cannot close are named known limits', () => {
  const s = box();
  try {
    const d = ok(s.call('describe', {}));
    assert.equal(d.harness, 'opencode');
    assert.deepEqual(d.binding.env_set, ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']);
    assert.deepEqual(d.binding.folder_layout, { XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' });
    assert.deepEqual(d.known_limits.map((k) => [k.path, k.kind]), [['~/.agents/skills', 'inbound-read'], ['~/.opencode/', 'outbound-write']]);
    assert.match(d.known_limits[0].note, /no switch in 2\.x/);
    assert.match(d.versions.note, /1\.x .* out of range: its run has no --standalone/);
    assert.ok(d.operations.includes('launch-spec') && d.operations.includes('observe --state'));
  } finally {
    s.done();
  }
});

test('detect: 2.2.7 is in range; 1.19.5 is outside it', () => {
  for (const [v, range] of [['2.2.7', 'compatible'], ['1.19.5', 'outside']]) {
    const s = box(v);
    try {
      const d = ok(s.call('detect', {}));
      assert.equal(d.version, v);
      assert.equal(d.range, range, v);
    } finally {
      s.done();
    }
  }
});

test('observe --state: the known limits are reported when their paths exist; [state] items are not expressible', () => {
  const s = box();
  try {
    const before = ok(s.call('observe', { state: true }));
    const esc = (o, p) => o.escapes.find((e) => e.path === p);
    assert.equal(esc(before, '~/.agents/skills').applies, false);
    assert.equal(esc(before, '~/.opencode/').applies, false);
    fs.mkdirSync(path.join(s.home, '.agents', 'skills', 'x'), { recursive: true });
    fs.mkdirSync(path.join(s.home, '.opencode'));
    write(s.folder, 'data/opencode/opencode.db', 'x');
    write(s.folder, 'state/opencode/service.json', '{}');
    const after = ok(s.call('observe', { state: true }));
    assert.equal(esc(after, '~/.agents/skills').applies, true, 'a caller sees the leak');
    assert.deepEqual(esc(after, '~/.agents/skills').present.map((p) => p.kind), ['dir']);
    assert.equal(esc(after, '~/.opencode/').applies, true);
    for (const k of ['retention_days', 'sessions', 'prompt_history']) assert.equal(after.state[k].expressible, false, k);
    assert.ok(JSON.stringify(after.inventory).includes('"sessions"'), 'opencode.db classed as sessions');
  } finally {
    s.done();
  }
});

test('launch-spec: the endpoint, the model, MCP servers with refs, a skill and AGENTS.md, under a receipt; --standalone and the binding', () => {
  const s = box();
  try {
    const team = layer(s.root, 'team', [
      '[model.roles]', 'primary = "bench-primary"', 'small = "bench-small"', '',
      '[refs.DB_PASSWORD]', 'description = "db"', '', '[refs.DOCS_TOKEN]', 'description = "docs"', '',
      '[mcp.db]', 'exec = "node"', 'args = ["server.js"]', 'env = { DB_HOST = "localhost" }', 'env_refs = { DB_PASS = "DB_PASSWORD" }', '',
      '[mcp.docs]', 'url = "https://docs.example/mcp"', 'header_refs = { "X-Token" = "DOCS_TOKEN" }', '',
    ].join('\n'), { 'server.js': 'x\n', 'skills/notes/SKILL.md': skillMd('notes'), 'AGENTS.md': 'Team rules.\n' });
    const proj = layer(s.root, 'proj', '', { 'AGENTS.md': 'Project rules.\n' });
    const local = write(s.root, 'local.toml', `[refs]\nDB_PASSWORD = "keychain:example/db"\nDOCS_TOKEN = "env:DOCS_TOKEN"\n\n${ENDPOINT}`);
    const layers = [team, proj];
    const refused = s.call('launch-spec', { layers, local, headless: true });
    assert.equal(refused.error.code, 'receipt_required');
    assert.deepEqual(refused.error.items[0].risks.map((r) => [r.item, r.risk]), [['mcp.db', 'runs-code'], ['mcp.docs', 'sends-data'], ['skill.notes', 'runs-code']]);
    const spec = ok(s.call('launch-spec', { layers, local, headless: true, receipt: allow(refused) }));
    assert.deepEqual(spec.argv.slice(1), ['run', '--standalone', '--format', 'json', '-m', 'hs/bench-primary']);
    // The binding: the four roots in the folder; the host's config layers unset.
    assert.equal(spec.env_set.XDG_DATA_HOME, path.join(s.folder, 'data'));
    assert.equal(spec.env_set.XDG_STATE_HOME, path.join(s.folder, 'state'));
    assert.equal(spec.env_set.OPENCODE_DISABLE_CLAUDE_CODE, '1');
    for (const v of ['OPENCODE_CONFIG', 'OPENCODE_PERMISSION', 'OPENCODE_DB', 'OPENCODE_AUTH_CONTENT', 'OPENAI_API_KEY']) assert.ok(spec.env_unset.includes(v), v);
    // A variable the launch sets is never also unset, so a caller gets one environment whichever
    // list it applies first; the host's own value is replaced by the set.
    for (const v of ['OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT']) assert.ok(!spec.env_unset.includes(v) && v in spec.env_set, v);
    for (const v of Object.keys(spec.env_set)) assert.ok(!spec.env_unset.includes(v), v);
    // The inline layer: the provider, and the servers, refs as {env:…} placeholders.
    const c = content(spec);
    assert.deepEqual(c.providers, { hs: { name: 'harness-skeleton endpoint', env: ['HS_ENDPOINT_KEY'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://gateway.example/v1' }, models: { 'bench-primary': { name: 'bench-primary' } } } });
    assert.deepEqual(c.mcp.servers.db, { type: 'local', command: ['node', path.join(team, 'server.js')], environment: { DB_HOST: 'localhost', DB_PASS: '{env:HS_REF_DB_PASSWORD}' } });
    assert.deepEqual(c.mcp.servers.docs, { type: 'remote', url: 'https://docs.example/mcp', headers: { 'X-Token': '{env:HS_REF_DOCS_TOKEN}' }, oauth: false });
    assert.deepEqual(spec.env_from_refs, { HS_ENDPOINT_KEY: REF, HS_REF_DB_PASSWORD: 'keychain:example/db', HS_REF_DOCS_TOKEN: 'env:DOCS_TOKEN' });
    assert.doesNotMatch(spec.env_set.OPENCODE_CONFIG_CONTENT, /keychain:|env:DOCS/, 'no reference in what OpenCode reads');
    // The config directory: the skill, and AGENTS.md by layer.
    const dir = spec.env_set.OPENCODE_CONFIG_DIR;
    assert.equal(dir, spec.files.find((f) => f.role === 'config_dir').path);
    assert.ok(dir.startsWith(spec.temp_dir + path.sep));
    assert.equal(fs.readFileSync(path.join(dir, 'skills/notes/SKILL.md'), 'utf8'), skillMd('notes'));
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# team\n\nTeam rules.\n\n# proj\n\nProject rules.\n');
    assert.ok(spec.skipped.some((x) => x.item === 'model.roles.small'));
    // The digest leaves the temp path out: a second launch, the same digest.
    const again = ok(s.call('launch-spec', { layers, local, headless: true, receipt: allow(refused) }));
    assert.equal(again.launch_digest, spec.launch_digest);
    assert.notEqual(again.env_set.OPENCODE_CONFIG_DIR, dir);
  } finally {
    s.done();
  }
});

// Milestone 7.1, the lead's (b): every launch passes --standalone, so a run never attaches to a
// background service in the folder and runs on its config (tier 1, opencode-launch-surface).
test('every launch passes --standalone, headless or not, whatever it carries, and with a service registered in the folder', () => {
  const s = box();
  try {
    write(s.folder, 'state/opencode/service.json', '{"url":"http://127.0.0.1:1"}');
    const empty = layer(s.root, 'empty', '');
    const model = layer(s.root, 'model', '[model.roles]\nprimary = "openai/gpt-x"\n');
    for (const layers of [[empty], [model]]) {
      for (const headless of [true, false]) {
        const spec = ok(s.call('launch-spec', { layers, headless }));
        assert.ok(spec.argv.includes('--standalone'), `${layers.map((l) => path.basename(l))} headless=${headless}`);
        assert.ok(spec.notes.some((n) => /--standalone on every launch/.test(n)));
      }
    }
    const spec = ok(s.call('launch-spec', { layers: [model], headless: false }));
    assert.deepEqual(spec.argv.slice(1), ['--standalone', '-m', 'openai/gpt-x'], 'without an endpoint the model is passed as given');
    assert.ok(spec.env_unset.includes('OPENCODE_CONFIG_DIR') && spec.env_unset.includes('OPENCODE_CONFIG_CONTENT'), 'unset when the launch sets neither');
    assert.ok(spec.unverified.some((u) => /interactive launch is not measured/.test(u)));
  } finally {
    s.done();
  }
});

test('launch-spec refusals: a stored login, an x-api-key endpoint, {env:} or {file:} text, an SSE server, a required status line', () => {
  const s = box();
  try {
    const roles = layer(s.root, 'roles', '[model.roles]\nprimary = "m"\n');
    const local = write(s.root, 'local.toml', ENDPOINT);
    write(s.folder, 'data/opencode/auth.json', '{}');
    assert.equal(s.call('launch-spec', { layers: [roles], local }).error.code, 'login_present');
    fs.rmSync(path.join(s.folder, 'data/opencode/auth.json'));
    const ok1 = ok(s.call('launch-spec', { layers: [roles], local }));
    assert.ok(ok1.unverified.some((u) => /keeps its logins in data\/opencode\/opencode\.db/.test(u)));
    const xkey = write(s.root, 'x.toml', ENDPOINT.replace('auth = "bearer"', 'auth = "x-api-key"'));
    assert.equal(s.call('launch-spec', { layers: [roles], local: xkey }).error.code, 'item_unsupported');
    for (const [name, toml] of [
      ['envsub', '[mcp.a]\nexec = "/bin/true"\nenv = { X = "{env:HOME}" }\n'],
      ['filesub', '[mcp.b]\nexec = "/bin/true"\nargs = ["{file:/etc/passwd}"]\n'],
    ]) {
      const l = layer(s.root, name, toml);
      const r = s.call('launch-spec', { layers: [l] });
      const refusedCode = r.error.code === 'receipt_required' ? s.call('launch-spec', { layers: [l], receipt: allow(r) }).error.code : r.error.code;
      assert.equal(refusedCode, 'interpolation_refused', name);
    }
    const sse = layer(s.root, 'sse', '[mcp.s]\nurl = "https://x.example/sse"\ntype = "sse"\n');
    assert.equal(s.call('launch-spec', { layers: [sse] }).error.code, 'item_unsupported');
    const sl = layer(s.root, 'sl', '[statusline]\nrequire = "required"\n[statusline.run]\nexec = "/bin/true"\n');
    assert.equal(s.call('launch-spec', { layers: [sl] }).error.code, 'item_unsupported');
  } finally {
    s.done();
  }
});

test('plan: under overlay it names what a launch carries; materialize is not in this build', () => {
  const s = box();
  try {
    const team = layer(s.root, 'team', '[model.roles]\nprimary = "m"\nsmall = "s"\n\n[mcp.db]\nexec = "/bin/true"\n', { 'skills/notes/SKILL.md': skillMd('notes'), 'AGENTS.md': 'Rules.\n' });
    const plan = ok(s.call('plan', { layers: [team], owner: 'builder', mode: 'overlay' }));
    assert.deepEqual(plan.operations, []);
    const only = plan.launch_only.map((x) => x.item).sort();
    assert.deepEqual(only, ['instructions (AGENTS.md)', 'mcp.db', 'model.roles.primary', 'skill.notes']);
    assert.ok(plan.skipped.some((x) => x.item === 'model.roles.small'));
    assert.equal(s.call('plan', { layers: [team], owner: 'builder', mode: 'materialize' }).error.code, 'not_implemented');
  } finally {
    s.done();
  }
});
