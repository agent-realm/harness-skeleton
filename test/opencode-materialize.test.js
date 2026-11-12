// Milestone 7.2: materialize on OpenCode (design note §7.4, §7.5). A plan writes into the folder's own
// config directory, config/opencode/: opencode.json's `model` and `mcp.servers.<id>` keys one by one,
// the bound copies of stdio servers into hs-run/, and the skills into its skills/. A launch skips
// what a plan installed at this content. No test starts a real harness: the binary is a stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { layer, skillMd, tmpdir, write } from './fixtures.js';
import { linuxHost, ok, receiptFor } from './sandbox.js';

function box() {
  const root = tmpdir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folder = path.join(root, 'oc-folder');
  for (const r of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(folder, r, 'opencode'), { recursive: true });
  const bin = write(root, 'bin/opencode', '#!/bin/sh\necho "opencode v2.2.7"\n');
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home, tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'opencode', harness_path: folder, bin, ...args } }, opts);
  return { root, home, folder, bin, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const cfg = (s) => path.join(s.folder, 'config', 'opencode');
const json = (s) => JSON.parse(fs.readFileSync(path.join(cfg(s), 'opencode.json'), 'utf8'));
const team = (s, { cwd = false } = {}) => layer(s.root, 'team', [
  '[model.roles]', 'primary = "openai/gpt-x"', '',
  '[mcp.db]', 'exec = "srv/server.js"', 'args = ["--port", "1"]', 'env = { DB_HOST = "localhost" }', 'self_contained = true', ...(cwd ? ['cwd = "srv"'] : []), '',
  '[mcp.docs]', 'url = "https://docs.example/mcp"', 'headers = { "X-Team" = "a" }', '',
].join('\n'), { 'srv/server.js': 'x\n', 'skills/notes/SKILL.md': skillMd('notes'), 'AGENTS.md': 'Rules.\n' });

test('materialize: the model, two servers and a skill into config/opencode/, receipted; the user\'s own keys kept', () => {
  const s = box();
  try {
    fs.writeFileSync(path.join(cfg(s), 'opencode.json'), '{\n  "share": "disabled"\n}\n');
    const t = team(s);
    const plan = ok(s.call('plan', { layers: [t], owner: 'builder', mode: 'materialize' }));
    assert.deepEqual(plan.operations.map((o) => [o.address_id, o.risk]), [
      ['config/opencode/opencode.json#model', []],
      ['hs-run/mcp.db', ['runs-code']],
      ['config/opencode/opencode.json#mcp/servers/db', ['runs-code']],
      ['config/opencode/opencode.json#mcp/servers/docs', ['sends-data']],
      ['config/opencode/skills/notes', ['runs-code']],
    ]);
    assert.ok(plan.launch_only.some((x) => x.item === 'instructions (AGENTS.md)' && /not persisted in this build/.test(x.via)));
    assert.equal(s.call('apply', { plan, receipt: { ...receiptFor(plan), allows: [] } }).error.code, 'receipt_required');
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const j = json(s);
    assert.equal(j.share, 'disabled', 'the user\'s own key stays');
    assert.equal(j.model, 'openai/gpt-x');
    assert.deepEqual(j.mcp.servers.db, { type: 'local', command: [path.join(s.folder, 'hs-run/mcp.db/server.js'), '--port', '1'], environment: { DB_HOST: 'localhost' } });
    assert.deepEqual(j.mcp.servers.docs, { type: 'remote', url: 'https://docs.example/mcp', headers: { 'X-Team': 'a' }, oauth: false });
    assert.equal(fs.readFileSync(path.join(cfg(s), 'skills/notes/SKILL.md'), 'utf8'), skillMd('notes'));
    assert.ok(fs.existsSync(path.join(s.folder, 'hs-run/mcp.db/server.js')));
  } finally {
    s.done();
  }
});

test('materialize then launch: what a plan installed at this content is skipped; an edited skill is carried, an edited server refused', () => {
  const s = box();
  try {
    const t = team(s);
    const plan = ok(s.call('plan', { layers: [t], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const spec = ok(s.call('launch-spec', { layers: [t], headless: true }));
    for (const id of ['mcp.db', 'mcp.docs', 'skill.notes']) assert.ok(spec.skipped.some((x) => x.item === id && /installed in the folder by a plan, at this content/.test(x.reason)), id);
    // Only the spec's AGENTS.md is left for the inline layer, named by path. No config directory is
    // set, since one would replace the folder's config/opencode/ and with it what the plan installed
    // and this launch skips (tier 1, opencode-persisted, mixed).
    assert.deepEqual(Object.keys(JSON.parse(spec.env_set.OPENCODE_CONFIG_CONTENT)), ['instructions']);
    assert.ok(!('OPENCODE_CONFIG_DIR' in spec.env_set) && spec.env_unset.includes('OPENCODE_CONFIG_DIR'));
    assert.ok(spec.argv.includes('--standalone'));
    // The edited skill reaches the launch from its temp dir, beside the folder's copy.
    write(t, 'skills/notes/extra.md', 'more');
    const edited = s.call('launch-spec', { layers: [t], headless: true });
    assert.equal(edited.error.code, 'receipt_required');
    assert.deepEqual(edited.error.items[0].risks.map((r) => r.item), ['skill.notes']);
    // An edited server: the folder's opencode.json holds the installed one, which the launch's would
    // merge into key by key.
    fs.rmSync(path.join(t, 'skills/notes/extra.md'));
    write(t, 'srv/server.js', 'changed\n');
    const r = s.call('launch-spec', { layers: [t], headless: true });
    assert.equal(r.error.code, 'item_unsupported');
    assert.match(r.error.message, /mcp\.db: the folder's config\/opencode\/opencode\.json defines mcp\.servers\.db, and the launch's would merge into it key by key/);
  } finally {
    s.done();
  }
});

test('launch: a spec server named like one the folder\'s own config defines is refused', () => {
  const s = box();
  try {
    fs.writeFileSync(path.join(cfg(s), 'opencode.json'), JSON.stringify({ mcp: { servers: { db: { type: 'local', command: ['/bin/true'] } } } }));
    const t = layer(s.root, 'mine', '[mcp.db]\nexec = "/bin/true"\n');
    assert.equal(s.call('launch-spec', { layers: [t] }).error.code, 'item_unsupported');
    const other = layer(s.root, 'other', '[mcp.dbx]\nexec = "/bin/true"\n');
    assert.equal(s.call('launch-spec', { layers: [other] }).error.code, 'receipt_required', 'another name is carried');
  } finally {
    s.done();
  }
});

test('materialize refusals: an opencode.jsonc in the folder, refs, a working directory, a model with no provider; endpoint and login stay launch only', () => {
  const s = box();
  try {
    fs.writeFileSync(path.join(cfg(s), 'opencode.jsonc'), '{}\n');
    const r = s.call('plan', { layers: [team(s)], owner: 'builder', mode: 'materialize' });
    assert.equal(r.error.code, 'item_unsupported');
    assert.ok(r.error.items.every((x) => x.item === 'model.roles.primary' || x.item.startsWith('mcp.')));
    assert.match(r.error.items[0].reason, /opencode\.jsonc outranks opencode\.json/);
    fs.rmSync(path.join(cfg(s), 'opencode.jsonc'));
    fs.rmSync(path.join(s.root, 'team'), { recursive: true });
    const cwd = s.call('plan', { layers: [team(s, { cwd: true })], owner: 'builder', mode: 'materialize' });
    assert.match(JSON.stringify(cwd.error.items), /working directory is not carried in this build/);
    const refs = layer(s.root, 'refs', '[refs.TOKEN]\ndescription = "t"\n\n[mcp.r]\nurl = "https://x.example/mcp"\nheader_refs = { "X-T" = "TOKEN" }\n');
    const local = write(s.root, 'local.toml', '[refs]\nTOKEN = "env:TOKEN"\n');
    const rr = s.call('plan', { layers: [refs], local, owner: 'builder', mode: 'materialize' });
    assert.match(JSON.stringify(rr.error.items), /cannot carry a ref/);
    const bare = layer(s.root, 'bare', '[model.roles]\nprimary = "gpt-x"\n');
    assert.match(JSON.stringify(s.call('plan', { layers: [bare], owner: 'builder', mode: 'materialize' }).error.items), /must name its provider/);
    const ep = layer(s.root, 'ep', '[model.roles]\nprimary = "bench"\n');
    const epLocal = write(s.root, 'ep.toml', '[endpoints.openai-chat]\nbase_url = "https://gw.example/v1"\ncredential = "env:K"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n');
    const plan = ok(s.call('plan', { layers: [ep], local: epLocal, owner: 'builder', mode: 'materialize' }));
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.launch_only.map((x) => x.item).sort(), ['endpoints.openai-chat', 'login.mode', 'model.roles.primary']);
  } finally {
    s.done();
  }
});

test('remove: the keys, the copy and the skill go; the user\'s own keys stay', () => {
  const s = box();
  try {
    fs.writeFileSync(path.join(cfg(s), 'opencode.json'), '{\n  "share": "disabled"\n}\n');
    const plan = ok(s.call('plan', { layers: [team(s)], owner: 'builder', mode: 'materialize' }));
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    ok(s.call('remove', { owner: 'builder' }));
    const j = json(s);
    assert.equal(j.share, 'disabled');
    assert.equal(j.model, undefined);
    assert.equal(j.mcp?.servers?.db, undefined);
    assert.equal(j.mcp?.servers?.docs, undefined);
    assert.ok(!fs.existsSync(path.join(cfg(s), 'skills/notes')));
    assert.ok(!fs.existsSync(path.join(s.folder, 'hs-run/mcp.db')));
  } finally {
    s.done();
  }
});

// A persisted {env:…} or {file:…} would be read by every bare OpenCode start, with no receipt in the
// way: the plan refuses it, quoting no value, and nothing lands in opencode.json.
test('materialize refuses {env:} and {file:} in what it would persist, quoting no value; nothing is written', () => {
  const s = box();
  try {
    const before = '{\n  "share": "disabled"\n}\n';
    fs.writeFileSync(path.join(cfg(s), 'opencode.json'), before);
    for (const [name, toml] of [
      ['file-in-env-value', '[mcp.a]\nexec = "/bin/true"\nenv = { X = "{file:/etc/hosts}" }\n'],
      ['file-in-env-key', '[mcp.a]\nexec = "/bin/true"\nenv = { "{file:/etc/hosts}" = "x" }\n'],
      ['file-in-header-name', '[mcp.a]\nurl = "https://x.example/mcp"\nheaders = { "{file:/etc/hosts}" = "x" }\n'],
      ['env-in-model', '[model.roles]\nprimary = "openai/{env:HOME}"\n'],
    ]) {
      const l = layer(s.root, name, toml);
      const r = s.call('plan', { layers: [l], owner: 'builder', mode: 'materialize' });
      assert.equal(r.error?.code, 'interpolation_refused', name);
      assert.doesNotMatch(JSON.stringify(r.error), /hosts|HOME/, `${name}: no value quoted`);
      assert.equal(fs.readFileSync(path.join(cfg(s), 'opencode.json'), 'utf8'), before, `${name}: opencode.json untouched`);
    }
    assert.ok(!fs.existsSync(path.join(s.folder, 'hs-run')), 'no copy made');
  } finally {
    s.done();
  }
});
