// Milestone 6a.1: model roles, endpoints and login at launch (design note §5.2), on Claude Code
// and Codex. A credential is a reference handed to the caller (env_from_refs); hs never resolves
// one and never writes one. Fixture folders, layers and stub binaries only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { handlers } from '../src/native.js';
import ccDriver from '../src/drivers/claude-code/index.js';
import { codexFolder, layer, write } from './fixtures.js';
import { linuxHost, ok, receiptFor, sandbox, settings } from './sandbox.js';

const REF = 'keychain:example/gateway-key';
const roles = '[model.roles]\nprimary = "toy-model"\nsmall = "toy-model-small"\nsubagent = "toy-model"\neffort = "high"\n';
const endpoint = (wire, auth = 'bearer', login = 'endpoint') => `[endpoints.${wire}]\nbase_url = "https://gateway.example/api"\ncredential = "${REF}"\nauth = "${auth}"\n${login ? `\n[login]\nmode = "${login}"\n` : ''}`;
// An endpoint launch needs a folder with no stored login; the fixtures model a logged-in folder.
const logout = (folder, file) => fs.rmSync(path.join(folder, file));
// launch-spec's overlay files go under the sandbox, outside the data folder, and go with it.
const box = () => {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  return s;
};
const overlayEnv = (spec) => JSON.parse(fs.readFileSync(spec.files.find((f) => f.role === 'settings').path, 'utf8')).env;
const SWITCHES_OFF = { CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '', CLAUDE_CODE_USE_ANTHROPIC_AWS: '' };
const CC_OTHERS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY'];

test('Claude Code launch: roles by flag and variables, the endpoint, the credential as a reference', () => {
  const s = box();
  try {
    logout(s.folder, '.credentials.json');
    const team = layer(s.root, 'roles', roles);
    const local = write(s.root, 'local.toml', endpoint('anthropic-messages'));
    const spec = ok(s.call('launch-spec', { layers: [team], local }));
    assert.deepEqual(spec.argv, ['claude', '--settings', spec.files[0].path, '--model', 'toy-model']);
    assert.equal(spec.env_set.ANTHROPIC_BASE_URL, 'https://gateway.example/api');
    // The overlay carries the same variables, above the folder's settings, and cancels the cloud
    // switches; never a credential or a reference.
    assert.deepEqual(overlayEnv(spec), {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'toy-model-small', CLAUDE_CODE_SUBAGENT_MODEL: 'toy-model', CLAUDE_CODE_EFFORT_LEVEL: 'high',
      ANTHROPIC_BASE_URL: 'https://gateway.example/api', ...SWITCHES_OFF,
    });
    assert.doesNotMatch(fs.readFileSync(spec.files[0].path, 'utf8'), /keychain:|TOKEN|API_KEY/);
    assert.equal(spec.env_set.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'toy-model-small');
    assert.equal(spec.env_set.CLAUDE_CODE_SUBAGENT_MODEL, 'toy-model');
    assert.equal(spec.env_set.CLAUDE_CODE_EFFORT_LEVEL, 'high');
    assert.deepEqual(spec.env_from_refs, { ANTHROPIC_AUTH_TOKEN: REF });
    for (const v of ['ANTHROPIC_API_KEY', ...CC_OTHERS]) assert.ok(spec.env_unset.includes(v), v);
    assert.ok(!spec.env_unset.includes('ANTHROPIC_AUTH_TOKEN'), 'the variable the caller fills is not unset');
    assert.doesNotMatch(JSON.stringify([spec.argv, spec.env_set]), /keychain:/, 'a reference travels only in env_from_refs');
    assert.ok(!spec.notes.some((n) => /account state/.test(n)), 'the fixture holds no cached account state');

    const xkey = ok(s.call('launch-spec', { layers: [team], local: write(s.root, 'local2.toml', endpoint('anthropic-messages', 'x-api-key')) }));
    assert.deepEqual(xkey.env_from_refs, { ANTHROPIC_API_KEY: REF });
    assert.ok(xkey.env_unset.includes('ANTHROPIC_AUTH_TOKEN') && !xkey.env_unset.includes('ANTHROPIC_API_KEY'));
  } finally {
    s.done();
  }
});

test('Codex launch: a provider of its own, roles by -m and -c, no small role', () => {
  const s = box();
  try {
    const folder = codexFolder(s.root);
    logout(folder, 'auth.json');
    const call = (op, args) => handle({ protocol: PROTOCOL, op, args: { harness: 'codex', harness_path: folder, ...args } }, { ...s.opts, host: linuxHost });
    const team = layer(s.root, 'roles', roles);
    const local = write(s.root, 'local.toml', endpoint('openai-responses'));
    const spec = ok(call('launch-spec', { layers: [team], local }));
    assert.deepEqual(spec.argv, ['codex',
      '-m', 'toy-model', '-c', 'agents.default_subagent_model="toy-model"', '-c', 'model_reasoning_effort="high"',
      '-c', 'model_provider="hs"',
      '-c', 'model_providers.hs={name="hs", base_url="https://gateway.example/api", env_key="HS_ENDPOINT_KEY", wire_api="responses"}',
      // The key sits in Codex's environment, and Codex 0.160.0 hands *KEY* variables to the shell
      // tool unless the default excludes are on, which they are not by default.
      '-c', 'shell_environment_policy.ignore_default_excludes=false']);
    assert.ok(spec.notes.some((n) => /ignore_default_excludes is forced false/.test(n)));
    assert.ok(spec.unverified.some((u) => /managed_config\.toml outranks -c/.test(u)));
    assert.deepEqual(spec.env_from_refs, { HS_ENDPOINT_KEY: REF });
    for (const v of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) assert.ok(spec.env_unset.includes(v), v);
    assert.ok(spec.skipped.some((x) => x.item === 'model.roles.small'));
    assert.doesNotMatch(JSON.stringify([spec.argv, spec.env_set]), /keychain:/);

    const xkey = ok(call('launch-spec', { layers: [team], local: write(s.root, 'l2.toml', endpoint('openai-responses', 'x-api-key')) }));
    assert.ok(xkey.argv.some((a) => /env_http_headers=\{"x-api-key"="HS_ENDPOINT_KEY"\}/.test(a)));

    // A folder that turns the default excludes off is outranked by the flag.
    fs.writeFileSync(path.join(folder, 'config.toml'), 'model = "gpt-6"\n\n[shell_environment_policy]\nignore_default_excludes = true\n');
    const off = ok(call('launch-spec', { layers: [team], local }));
    assert.equal(off.argv.at(-1), 'shell_environment_policy.ignore_default_excludes=false');
    // A launch with no secret in Codex's environment leaves the policy alone.
    const none = ok(call('launch-spec', { layers: [team] }));
    assert.ok(!none.argv.some((a) => a.startsWith('shell_environment_policy')));
  } finally {
    s.done();
  }
});

test('an endpoint launch unsets every other credential and provider variable, in every login mode', () => {
  const s = box();
  try {
    logout(s.folder, '.credentials.json');
    const team = layer(s.root, 'roles', roles);
    for (const login of ['isolated', null]) {
      // An ambient ANTHROPIC_AUTH_TOKEN outranks ANTHROPIC_API_KEY [CC §7]: with auth = "x-api-key"
      // it would otherwise reach the endpoint in its place.
      const spec = ok(s.call('launch-spec', { layers: [team], local: write(s.root, `l-${login}.toml`, endpoint('anthropic-messages', 'x-api-key', login)) }));
      assert.deepEqual(spec.env_from_refs, { ANTHROPIC_API_KEY: REF }, String(login));
      for (const v of ['ANTHROPIC_AUTH_TOKEN', ...CC_OTHERS]) assert.ok(spec.env_unset.includes(v), `${login}: ${v}`);
      assert.ok(!spec.env_unset.includes('ANTHROPIC_API_KEY'));
      assert.ok(!spec.unverified.some((n) => /keychain/.test(n)), 'on Linux .credentials.json is the whole store; macOS is in account-state.test.js');
    }
    // No endpoint: the folder's own login is the login, and nothing is unset for it.
    const bare = ok(s.call('launch-spec', { layers: [team] }));
    assert.ok(!CC_OTHERS.some((v) => bare.env_unset.includes(v)));
    assert.deepEqual(bare.env_from_refs, {});

    const folder = codexFolder(s.root);
    logout(folder, 'auth.json');
    const spec = ok(handle({ protocol: PROTOCOL, op: 'launch-spec', args: { harness: 'codex', harness_path: folder, layers: [team], local: write(s.root, 'cx.toml', endpoint('openai-responses', 'bearer', 'isolated')) } }, { ...s.opts, host: linuxHost }));
    for (const v of ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_IDENTITY_TOKEN_FILE']) assert.ok(spec.env_unset.includes(v), v);
    assert.ok(spec.unverified.some((n) => /keyring/.test(n)));
    assert.deepEqual(bare.unverified, []);
  } finally {
    s.done();
  }
});

test('an endpoint launch on a folder with a stored login is login_present; the file is checked by name only', () => {
  const s = box();
  try {
    const team = layer(s.root, 'roles', roles);
    for (const login of ['endpoint', 'isolated']) {
      const res = s.call('launch-spec', { layers: [team], local: write(s.root, `l-${login}.toml`, endpoint('anthropic-messages', 'bearer', login)) });
      assert.equal(res.error.code, 'login_present', login);
      assert.deepEqual(res.error.items, ['.credentials.json']);
      assert.doesNotMatch(JSON.stringify(res), /never-read/, 'the file is never opened');
    }
    // A link counts too, whatever it points at.
    const cred = path.join(s.folder, '.credentials.json');
    fs.rmSync(cred);
    fs.symlinkSync(path.join(s.root, 'nowhere.json'), cred);
    assert.equal(s.call('launch-spec', { layers: [team], local: write(s.root, 'l3.toml', endpoint('anthropic-messages')) }).error.code, 'login_present');
    // Without an endpoint the folder's own login is the point of it.
    ok(s.call('launch-spec', { layers: [team] }));

    const folder = codexFolder(s.root);
    const res = handle({ protocol: PROTOCOL, op: 'launch-spec', args: { harness: 'codex', harness_path: folder, layers: [team], local: write(s.root, 'cx.toml', endpoint('openai-responses')) } }, { ...s.opts, host: linuxHost });
    assert.equal(res.error.code, 'login_present');
    assert.deepEqual(res.error.items, ['auth.json']);
  } finally {
    s.done();
  }
});

test('the folder\'s settings env: role variables are overridden by the overlay; a credential variable is login_present', () => {
  const s = box();
  try {
    logout(s.folder, '.credentials.json');
    const team = layer(s.root, 'roles', roles);
    const local = write(s.root, 'local.toml', endpoint('anthropic-messages'));
    // A role a materialize left in the folder, a base URL the user set, a switch: the overlay,
    // above the folder's settings [CC §2], carries this launch's values and cancels the switch.
    write(s.folder, 'settings.json', JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'old-model', ANTHROPIC_BASE_URL: 'https://elsewhere.example', CLAUDE_CODE_USE_BEDROCK: '1' } }));
    const env = overlayEnv(ok(s.call('launch-spec', { layers: [team], local })));
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'toy-model');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://gateway.example/api');
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '');
    // A role-only launch carries its roles there too.
    assert.equal(overlayEnv(ok(s.call('launch-spec', { layers: [team] }))).CLAUDE_CODE_SUBAGENT_MODEL, 'toy-model');

    // A credential in the folder's settings env would override the caller's: refused, by key name.
    write(s.folder, 'settings.json', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'saved-SECRET-value', FOO: 'bar' } }));
    let res = s.call('launch-spec', { layers: [team], local });
    assert.equal(res.error.code, 'login_present');
    assert.deepEqual(res.error.items, ['settings.json#env/ANTHROPIC_AUTH_TOKEN']);
    assert.doesNotMatch(JSON.stringify(res), /SECRET/, 'the value is never shown');
    ok(s.call('launch-spec', { layers: [team] }), 'without an endpoint the folder\'s settings are its own business');
    // What cannot be checked is refused: env not an object, settings.json a link.
    write(s.folder, 'settings.json', JSON.stringify({ env: 'x' }));
    assert.equal(s.call('launch-spec', { layers: [team], local }).error.code, 'login_present');
    fs.rmSync(path.join(s.folder, 'settings.json'));
    fs.symlinkSync(write(s.root, 'shared-settings.json', '{}'), path.join(s.folder, 'settings.json'));
    res = s.call('launch-spec', { layers: [team], local });
    assert.equal(res.error.code, 'login_present');
    assert.match(res.error.message, /cannot be checked/);
  } finally {
    s.done();
  }
});

test('an endpoint for another wire is gateway_required, in launch-spec and in plan', () => {
  const s = box();
  try {
    const team = layer(s.root, 'roles', roles);
    const local = write(s.root, 'local.toml', endpoint('openai-responses'));
    assert.equal(s.call('launch-spec', { layers: [team], local }).error.code, 'gateway_required');
    assert.equal(s.call('plan', { layers: [team], local, owner: 'tool', mode: 'overlay' }).error.code, 'gateway_required');
    const folder = codexFolder(s.root);
    const res = handle({ protocol: PROTOCOL, op: 'launch-spec', args: { harness: 'codex', harness_path: folder, layers: [team], local: write(s.root, 'l2.toml', endpoint('anthropic-messages')) } }, { ...s.opts, host: linuxHost });
    assert.equal(res.error.code, 'gateway_required');
  } finally {
    s.done();
  }
});

test('validate: endpoints, login and roles; a pasted credential is never echoed', () => {
  const s = box();
  try {
    const val = (toml, local) => ok(handle({ protocol: PROTOCOL, op: 'validate', args: { harness: 'claude-code', layers: [layer(s.root, `l${Math.random()}`.replace('.', ''), toml)], ...(local ? { local: write(s.root, `${Math.random()}.toml`, local) } : {}) } }, s.opts));
    let r = val('', '[endpoints.anthropic-messages]\nbase_url = "https://x.example"\ncredential = "sk-ant-PASTED-SECRET-123"\n');
    assert.deepEqual(r.problems.map((p) => p.code), ['ref_not_reference']);
    assert.doesNotMatch(JSON.stringify(r), /PASTED-SECRET/);
    r = val('', '[endpoints.smoke-signals]\nbase_url = "ftp://x"\ncredential = "keychain:a/b"\nauth = "cookie"\n');
    assert.deepEqual(r.problems.map((p) => p.code).sort(), ['endpoint_wire_unknown', 'item_malformed', 'item_malformed']);
    r = val('', '[login]\nmode = "endpoint"\n');
    assert.match(r.problems[0].message, /needs an endpoint/);
    r = val('[model.roles]\nprimary = ""\nnarrator = "x"\n');
    assert.equal(r.problems.filter((p) => p.code === 'item_malformed').length, 2);
    assert.deepEqual(val(roles, endpoint('anthropic-messages')).problems, []);
  } finally {
    s.done();
  }
});

test('materialize persists the roles in settings.json, keeping the folder\'s own env; overlay writes nothing for them', () => {
  const s = box();
  try {
    logout(s.folder, '.credentials.json');
    write(s.folder, 'settings.json', JSON.stringify({ env: { FOO: 'bar' }, theme: 'dark' }));
    const team = layer(s.root, 'roles', roles);
    const local = write(s.root, 'local.toml', `[state]\nretention_days = 9999\n\n${endpoint('anthropic-messages')}`);
    let plan = ok(s.call('plan', { layers: [team], local, owner: 'builder' }));
    assert.deepEqual(plan.operations.map((o) => o.address_id).sort(), [
      'settings.json#cleanupPeriodDays', 'settings.json#env/ANTHROPIC_DEFAULT_HAIKU_MODEL', 'settings.json#env/CLAUDE_CODE_EFFORT_LEVEL',
      'settings.json#env/CLAUDE_CODE_SUBAGENT_MODEL', 'settings.json#model']);
    assert.ok(plan.launch_only.some((x) => x.item === 'endpoints.anthropic-messages'), 'the endpoint is never written');
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    assert.deepEqual(settings(s.folder), {
      env: { FOO: 'bar', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'toy-model-small', CLAUDE_CODE_SUBAGENT_MODEL: 'toy-model', CLAUDE_CODE_EFFORT_LEVEL: 'high' },
      theme: 'dark', cleanupPeriodDays: 9999, model: 'toy-model',
    });
    assert.doesNotMatch(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'), /keychain:|gateway\.example/);
    assert.equal(ok(s.call('plan', { layers: [team], local, owner: 'builder' })).unchanged, true);
    ok(s.call('remove', { owner: 'builder' }));
    assert.deepEqual(settings(s.folder), { env: { FOO: 'bar' }, theme: 'dark' });

    plan = ok(s.call('plan', { layers: [team], local: write(s.root, 'l2.toml', endpoint('anthropic-messages')), owner: 'tool', mode: 'overlay' }));
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.launch_only.map((x) => x.item).sort(), ['endpoints.anthropic-messages', 'login.mode', 'model.roles.effort', 'model.roles.primary', 'model.roles.small', 'model.roles.subagent']);
  } finally {
    s.done();
  }
});

test('the floor: no credential or routing key and no key through a non-object, whatever an operation asks', () => {
  const s = box();
  try {
    const D = ccDriver.descriptor;
    for (const key of ['env/ANTHROPIC_AUTH_TOKEN', 'env/ANTHROPIC_API_KEY', 'env/CLAUDE_CODE_OAUTH_TOKEN', 'apiKeyHelper', 'env/ANTHROPIC_BASE_URL', 'env/CLAUDE_CODE_USE_BEDROCK', 'env/CLAUDE_CODE_USE_VERTEX', 'env//x']) {
      assert.throws(() => handlers['json-key'].write(s.folder, D, { file: 'settings.json', key }, 'x'), { code: 'write_refused' }, key);
    }
    // Nor an object holding one: its value could carry the credential in.
    assert.throws(() => handlers['json-key'].write(s.folder, D, { file: 'settings.json', key: 'env' }, { ANTHROPIC_API_KEY: 'x' }), { code: 'write_refused' });
    assert.throws(() => handlers['json-key'].current(s.folder, D, { file: 'settings.json', key: 'env' }), { code: 'write_refused' });
    for (const env of ['not an object', null]) {
      write(s.folder, 'settings.json', JSON.stringify({ env }));
      assert.throws(() => handlers['json-key'].write(s.folder, D, { file: 'settings.json', key: 'env/X' }, 'y'), { code: 'write_refused' });
      assert.ok(handlers['json-key'].current(s.folder, D, { file: 'settings.json', key: 'env/X' }).blocked, `env ${env} is blocked at plan time`);
    }
    // A plan through a null object is refused before any write.
    const res = s.call('plan', { layers: [layer(s.root, 'roles', roles)], owner: 'builder' });
    assert.equal(res.error.code, 'write_refused');
    assert.match(res.error.items.find((i) => i.item === 'model.roles.subagent').reason, /env is not an object/);
  } finally {
    s.done();
  }
});
