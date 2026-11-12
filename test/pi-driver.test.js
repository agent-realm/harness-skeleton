// Milestone 8.1: the pi driver, launch only (design note §4, §5, §7.5, §8). The folder is pi's one
// root, PI_CODING_AGENT_DIR. A launch writes nothing into it: one extension hs generates in the temp
// dir registers the endpoint's provider and the spec's MCP servers; skills go by --skill, AGENTS.md
// as a system-prompt append. Spec text pi could expand or run is refused in every carrier. No test
// starts a real harness: the binary is a stub, and the extension is loaded with a stand-in for pi.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { extensionSource } from '../src/drivers/pi/extension.js';
import { layer, skillMd, tmpdir, write } from './fixtures.js';
import { linuxHost, ok } from './sandbox.js';

const REF = 'keychain:example/gateway-key';
const ENDPOINT = (url = 'https://gateway.example/v1') => `[endpoints.openai-chat]\nbase_url = ${JSON.stringify(url)}\ncredential = "${REF}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`;

function box(version = '1.5.2') {
  const root = tmpdir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folder = path.join(root, 'pi-folder');
  fs.mkdirSync(folder);
  const bin = write(root, 'bin/pi', `#!/bin/sh\necho "${version}"\n`);
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home, tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'pi', harness_path: folder, bin, ...args } }, opts);
  return { root, home, folder, bin, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
const launch = (s, args) => {
  const refused = s.call('launch-spec', { headless: true, ...args });
  if (refused.error?.code !== 'receipt_required') return refused;
  return s.call('launch-spec', { headless: true, ...args, receipt: allow(refused) });
};

// pi, as far as the launch extension uses it: what it registers, recorded.
let loaded = 0;
async function register(file, dir) {
  const copy = path.join(dir, `hs-launch-${loaded++}.mjs`);
  fs.copyFileSync(file, copy);
  const factory = (await import(pathToFileURL(copy).href)).default;
  const seen = { providers: [], servers: [] };
  factory({ registerProvider: (id, config) => seen.providers.push([id, config]), registerMcpServer: (name, config) => seen.servers.push([name, config]) });
  return seen;
}
const mode = (p) => fs.statSync(p).mode & 0o777;

test('describe: the folder is PI_CODING_AGENT_DIR; the known limits, the 1.5 line and the network are named', () => {
  const s = box();
  try {
    const d = ok(s.call('describe', {}));
    assert.equal(d.harness, 'pi');
    assert.deepEqual(d.binding.env_set, ['PI_CODING_AGENT_DIR']);
    assert.equal(d.binding.default_folder, '~/.pi/agent');
    for (const v of ['PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR', 'PI_SELF_UPDATE_COMMAND']) assert.ok(d.binding.env_unset.includes(v), v);
    assert.deepEqual(d.known_limits.map((k) => k.path), ['~/.agents/skills', 'AGENTS.md and CLAUDE.md in the working directory and every parent', '.pi/ in the working directory']);
    assert.deepEqual(d.versions.compatible, { min: '1.5.2', below: '1.6.0' });
    assert.match(d.versions.note, /0\.x is out of range/);
    assert.match(d.launch_network.with_endpoint, /PI_OFFLINE/);
    // The 2-byte empty-store rule is named, so a pi that changes that file shows as a refusal.
    assert.deepEqual([d.login_store.files, d.login_store.empty_bytes], [['auth.json'], 2]);
    assert.match(d.login_store.rule, /any other size, or a link, counts as a login/);
  } finally {
    s.done();
  }
});

test('detect: 1.5.2 is in range; 1.4.0 and 0.80.2 are outside it', () => {
  for (const [v, range] of [['1.5.2', 'compatible'], ['1.4.0', 'outside'], ['0.80.2', 'outside']]) {
    const s = box(v);
    try {
      assert.equal(ok(s.call('detect', {})).range, range, v);
    } finally {
      s.done();
    }
  }
});

test('observe --state: project trust is reported by default, counts and, with --cwd, whether a trusted project .pi/ is there; never a path', () => {
  const s = box();
  try {
    let o = ok(s.call('observe', { state: true }));
    assert.deepEqual(o.project_trust, { default: 'ask', default_source: 'default', saved: { trusted: 0, untrusted: 0 } });
    const proj = path.join(s.root, 'hs-proj-7c1e');
    const work = path.join(proj, 'work');
    fs.mkdirSync(work, { recursive: true });
    const real = fs.realpathSync(work);
    write(s.folder, 'settings.json', JSON.stringify({ defaultProjectTrust: 'never', sessionDir: '/elsewhere/sessions' }));
    write(s.folder, 'trust.json', JSON.stringify({ [path.dirname(real)]: true, [path.join(s.root, 'other')]: false, [path.join(s.root, 'cleared')]: null }));
    o = ok(s.call('observe', { state: true }));
    assert.deepEqual(o.project_trust, { default: 'never', default_source: 'settings.json', saved: { trusted: 1, untrusted: 1 } });
    assert.ok(o.escapes.some((e) => e.path === 'settings.json sessionDir' && e.applies === true), 'a sessionDir moving sessions out is reported');
    // No .pi/ there: nothing to load, whatever the decision.
    o = ok(s.call('observe', { state: true, cwd: work }));
    assert.deepEqual(o.project_trust.cwd, { protected_present: [], saved_decision: true, headless: 'nothing to load', interactive: 'nothing to load', trusted_project_pi: false });
    // A .pi/ with protected resources, trusted through its parent's saved decision: it loads.
    write(work, '.pi/mcp.json', '{}');
    write(work, '.pi/APPEND_SYSTEM.md', 'x\n');
    o = ok(s.call('observe', { state: true, cwd: work }));
    assert.deepEqual(o.project_trust.cwd, { protected_present: ['mcp.json', 'APPEND_SYSTEM.md'], saved_decision: true, headless: 'loads', interactive: 'loads', trusted_project_pi: true });
    // With no saved decision, the default decides: "never" skips.
    write(s.folder, 'trust.json', '{}');
    o = ok(s.call('observe', { state: true, cwd: work }));
    assert.deepEqual([o.project_trust.cwd.headless, o.project_trust.cwd.interactive, o.project_trust.cwd.trusted_project_pi], ['skipped', 'skipped', false]);
    assert.doesNotMatch(JSON.stringify(o), /elsewhere/, 'the sessionDir value is not shown');
    write(s.folder, 'trust.json', JSON.stringify({ [path.dirname(real)]: true }));
    assert.doesNotMatch(JSON.stringify(ok(s.call('observe', { state: true, cwd: work })).project_trust), new RegExp(path.basename(proj)), 'no saved path is shown');
  } finally {
    s.done();
  }
});

test('launch-spec: the endpoint, the model, MCP servers with refs, a skill and AGENTS.md, under a receipt; the extension registers them; nothing in the folder', async () => {
  const s = box();
  try {
    const team = layer(s.root, 'team', [
      '[model.roles]', 'primary = "bench-primary"', 'small = "bench-small"', '',
      '[refs.DB_PASSWORD]', 'description = "db"', '', '[refs.DOCS_TOKEN]', 'description = "docs"', '',
      '[mcp.db]', 'exec = "node"', 'args = ["server.js", "--port", "$PORT"]', 'env = { DB_HOST = "localhost" }', 'env_refs = { DB_PASS = "DB_PASSWORD" }', '',
      '[mcp.docs]', 'url = "https://docs.example/mcp"', 'header_refs = { "X-Token" = "DOCS_TOKEN" }', 'exposure = "deferred"', '',
    ].join('\n'), { 'server.js': 'x\n', 'skills/notes/SKILL.md': skillMd('notes'), 'AGENTS.md': 'Team rules.\n' });
    const local = write(s.root, 'local.toml', `[refs]\nDB_PASSWORD = "keychain:example/db"\nDOCS_TOKEN = "env:DOCS_TOKEN"\n\n${ENDPOINT()}`);
    const refused = s.call('launch-spec', { layers: [team], local, headless: true });
    assert.equal(refused.error.code, 'receipt_required');
    assert.deepEqual(refused.error.items[0].risks.map((r) => [r.item, r.risk]), [['mcp.db', 'runs-code'], ['mcp.docs', 'sends-data'], ['skill.notes', 'runs-code']]);
    const spec = ok(s.call('launch-spec', { layers: [team], local, headless: true, receipt: allow(refused) }));
    const role = (r) => spec.files.find((f) => f.role === r).path;
    assert.deepEqual(spec.argv.slice(1), ['--mode', 'json', '--provider', 'hs', '--model', 'bench-primary', '-e', role('extension'), '--skill', path.join(role('skills'), 'notes'), '--append-system-prompt', role('instructions')]);
    assert.equal(spec.env_set.PI_CODING_AGENT_DIR, s.folder);
    assert.deepEqual([spec.env_set.PI_OFFLINE, spec.env_set.PI_SKIP_VERSION_CHECK, spec.env_set.PI_TELEMETRY], ['1', '1', '0']);
    for (const v of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR']) assert.ok(spec.env_unset.includes(v), v);
    for (const v of Object.keys(spec.env_set)) assert.ok(!spec.env_unset.includes(v), v);
    assert.deepEqual(spec.env_from_refs, { HS_ENDPOINT_KEY: REF, HS_REF_DB_PASSWORD: 'keychain:example/db', HS_REF_DOCS_TOKEN: 'env:DOCS_TOKEN' });
    assert.ok(spec.skipped.some((x) => x.item === 'model.roles.small'));
    // The temp dir is 700 and every file hs generates in it 600 (the lead's ask (b)).
    assert.equal(mode(spec.temp_dir), 0o700);
    assert.equal(mode(role('extension')), 0o600);
    assert.equal(mode(role('instructions')), 0o600);
    assert.equal(fs.readFileSync(role('instructions'), 'utf8'), '# team\n\nTeam rules.\n');
    assert.equal(fs.readFileSync(path.join(role('skills'), 'notes', 'SKILL.md'), 'utf8'), skillMd('notes'));
    // What the extension registers: the provider with its key read from a variable, and the servers
    // with their refs as ${HS_REF_…}, each with an exposure.
    const seen = await register(role('extension'), s.root);
    assert.deepEqual(seen.providers.map(([id, c]) => [id, c.baseUrl, c.apiKey, c.api, c.models.map((m) => m.id)]), [['hs', 'https://gateway.example/v1', '$HS_ENDPOINT_KEY', 'openai-completions', ['bench-primary']]]);
    assert.deepEqual(seen.servers, [
      ['db', { command: 'node', args: [path.join(team, 'server.js'), '--port', '$PORT'], env: { DB_HOST: 'localhost', DB_PASS: '${HS_REF_DB_PASSWORD}' }, exposure: 'direct' }],
      ['docs', { url: 'https://docs.example/mcp', headers: { 'X-Token': '${HS_REF_DOCS_TOKEN}' }, exposure: 'deferred' }],
    ]);
    assert.doesNotMatch(fs.readFileSync(role('extension'), 'utf8'), /keychain:|env:DOCS/, 'no reference in what pi reads');
    assert.deepEqual(fs.readdirSync(s.folder), [], 'nothing written into the folder');
    // A plan names it all launch only; materialize is not in this build.
    const plan = ok(s.call('plan', { layers: [team], local, owner: 'builder', mode: 'overlay' }));
    assert.deepEqual(plan.launch_only.map((x) => x.item).sort(), ['endpoints.openai-chat', 'instructions (AGENTS.md)', 'login.mode', 'mcp.db', 'mcp.docs', 'model.roles.primary', 'skill.notes']);
    assert.equal(s.call('plan', { layers: [team], local, owner: 'builder', mode: 'materialize' }).error.code, 'not_implemented');
  } finally {
    s.done();
  }
});

test('the launch extension is code built from spec data: hostile values arrive byte for byte, and the file parses', async () => {
  const s = box();
  try {
    const hostile = 'q"uo\'te `tick` */ end </script> \\ back\nline   sep';
    const team = layer(s.root, 'team', [
      '[model.roles]', `primary = ${JSON.stringify(`model ${hostile}`)}`, '',
      '[mcp.p]', 'exec = "/usr/bin/env"', `args = [${JSON.stringify(hostile)}, "*/ x"]`, `env = { ${JSON.stringify(`K ${hostile}`)} = ${JSON.stringify(hostile)} }`, '',
      '[mcp.r]', 'url = "https://docs.example/mcp"', `headers = { ${JSON.stringify(`X-${hostile}`)} = ${JSON.stringify(hostile)} }`, '',
    ].join('\n'));
    const local = write(s.root, 'local.toml', ENDPOINT(`https://gateway.example/v1?q=${encodeURIComponent('"`*/')}"\``));
    const spec = ok(launch(s, { layers: [team], local }));
    const seen = await register(spec.files.find((f) => f.role === 'extension').path, s.root);
    const [, provider] = seen.providers[0];
    assert.equal(provider.baseUrl, `https://gateway.example/v1?q=${encodeURIComponent('"`*/')}"\``);
    assert.equal(provider.models[0].id, `model ${hostile}`);
    assert.deepEqual(seen.servers, [
      ['p', { command: '/usr/bin/env', args: [hostile, '*/ x'], env: { [`K ${hostile}`]: hostile }, exposure: 'direct' }],
      ['r', { url: 'https://docs.example/mcp', headers: { [`X-${hostile}`]: hostile }, exposure: 'direct' }],
    ]);
  } finally {
    s.done();
  }
});

test('extensionSource: a value holding ${, a backtick, */ or a line break is data, byte for byte, never code', async () => {
  const root = tmpdir();
  try {
    const nasty = ['${process.exit(9)}', '`${x}`', '*/ throw 1 /*', '");process.exit(9);("', '\n}\n', '  ', '</script>'];
    const config = { provider: { id: 'hs', config: { baseUrl: nasty[0], models: nasty.map((n) => ({ id: n })) } }, mcp: nasty.map((n, i) => [`s${i}`, { command: n, args: nasty, env: { [n]: n } }]) };
    const file = write(root, 'x.js', extensionSource(config));
    const seen = await register(file, root);
    assert.deepEqual(seen.providers, [['hs', config.provider.config]]);
    assert.deepEqual(seen.servers, config.mcp);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refused, by carrier: spec text pi would expand or run, a ~ path pi would take as home, a folder server of the same name', () => {
  const s = box();
  try {
    const cases = [
      ['model id $', '[model.roles]\nprimary = "m$X"\n', null, 'interpolation_refused', /model\.roles\.primary: the model id holds \$ or a leading !/],
      ['model id !', '[model.roles]\nprimary = "!touch x"\n', null, 'interpolation_refused', /the model id holds \$ or a leading !/],
      ['base_url $', '[model.roles]\nprimary = "m"\n', 'https://gateway.example/$X', 'interpolation_refused', /endpoints\.openai-chat: base_url holds \$/],
      ['env value $', '[mcp.p]\nexec = "/usr/bin/env"\nenv = { A = "$HOME" }\n', null, 'interpolation_refused', /mcp\.p: env\.A holds \$ or a leading !/],
      ['env value !', '[mcp.p]\nexec = "/usr/bin/env"\nenv = { A = "!touch x" }\n', null, 'interpolation_refused', /mcp\.p: env\.A holds/],
      ['env value leading space !', '[mcp.p]\nexec = "/usr/bin/env"\nenv = { A = "  !touch x" }\n', null, 'interpolation_refused', /mcp\.p: env\.A holds/],
      ['env name $', '[mcp.p]\nexec = "/usr/bin/env"\nenv = { "A$B" = "1" }\n', null, 'interpolation_refused', /mcp\.p: the env name "A\$B" holds/],
      ['header value !', '[mcp.r]\nurl = "https://x.example/mcp"\nheaders = { X = "!cat /etc/passwd" }\n', null, 'interpolation_refused', /mcp\.r: headers\.X holds/],
      ['header value $', '[mcp.r]\nurl = "https://x.example/mcp"\nheaders = { X = "$SECRET" }\n', null, 'interpolation_refused', /mcp\.r: headers\.X holds/],
      ['header name $', '[mcp.r]\nurl = "https://x.example/mcp"\nheaders = { "X$Y" = "1" }\n', null, 'interpolation_refused', /mcp\.r: the header name "X\$Y" holds/],
      ['header_refs name !', '[refs.T]\ndescription = "t"\n\n[mcp.r]\nurl = "https://x.example/mcp"\nheader_refs = { "!X" = "T" }\n', null, 'interpolation_refused', /mcp\.r: the header name "!X" holds/],
      ['url $', '[mcp.r]\nurl = "https://x.example/$P"\n', null, 'interpolation_refused', /mcp\.r: url holds/],
      ['arg ~', '[mcp.p]\nexec = "/usr/bin/env"\nargs = ["~/secret"]\n', null, 'item_unsupported', /mcp\.p: argument 1 starts with ~, and pi expands a leading ~\//],
      ['cwd ~', '[mcp.p]\nexec = "/usr/bin/env"\ncwd = "~/work"\n', null, 'item_unsupported', /mcp\.p: cwd starts with ~/],
      ['sse', '[mcp.r]\nurl = "https://x.example/mcp"\ntype = "sse"\n', null, 'item_unsupported', /pi supports streamable HTTP, not sse/],
    ];
    for (const [i, [name, toml, url, code, re]] of cases.entries()) {
      const team = layer(s.root, `t${i}`, toml);
      const local = url ? write(s.root, `local${i}.toml`, `[refs]\nT = "env:T"\n\n${ENDPOINT(url)}`) : write(s.root, `local${i}.toml`, '[refs]\nT = "env:T"\n');
      const r = launch(s, { layers: [team], local });
      assert.equal(r.error?.code, code, name);
      assert.match(r.error.message, re, name);
    }
    // A shell string's own $ is the shell's: pi passes arguments as written.
    const sh = layer(s.root, 'sh', '[mcp.p]\nshell = "exec server --port $PORT"\n');
    assert.ok(launch(s, { layers: [sh] }).ok);
    // The folder's mcp.json names the same server: pi would start that one instead.
    write(s.folder, 'mcp.json', JSON.stringify({ mcpServers: { p: { command: 'other' } } }));
    const r = launch(s, { layers: [sh] });
    assert.equal(r.error?.code, 'item_unsupported');
    assert.match(r.error.message, /mcp\.p: the folder's mcp\.json defines a server of this name, which pi starts instead/);
  } finally {
    s.done();
  }
});

test('refused or skipped by name: a stored login with an endpoint, a hook event pi has no route for, a status line by require', () => {
  const s = box();
  try {
    // pi writes an empty auth.json, 2 bytes, on every start: told by its size, it holds no login.
    write(s.folder, 'auth.json', '{}');
    const m = layer(s.root, 'm', '[model.roles]\nprimary = "m"\n');
    const local = write(s.root, 'l.toml', ENDPOINT());
    assert.ok(launch(s, { layers: [m], local }).ok, 'the empty store pi writes is no login');
    // Any other size counts as a login, and a link does too: the file is never opened.
    write(s.folder, 'auth.json', '{"x":1}');
    assert.equal(launch(s, { layers: [m], local }).error?.code, 'login_present');
    fs.rmSync(path.join(s.folder, 'auth.json'));
    fs.symlinkSync(path.join(s.root, 'nowhere'), path.join(s.folder, 'auth.json'));
    assert.equal(launch(s, { layers: [m], local }).error?.code, 'login_present');
    fs.rmSync(path.join(s.folder, 'auth.json'));
    const hook = layer(s.root, 'h', '[hook.g]\nevent = "PermissionRequest"\nrun = { exec = "true" }\n');
    assert.equal(launch(s, { layers: [hook] }).error?.code, 'item_unsupported');
    const sl = layer(s.root, 's', '[statusline]\nrun = { exec = "true" }\n');
    assert.ok(ok(launch(s, { layers: [sl] })).skipped.some((x) => /no status line/.test(x.reason)));
    const slr = layer(s.root, 'sr', '[statusline]\nrun = { exec = "true" }\nrequire = "required"\n');
    assert.equal(launch(s, { layers: [slr] }).error?.code, 'item_unsupported');
  } finally {
    s.done();
  }
});
