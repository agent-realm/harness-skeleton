// Milestone 8.3: materialize on pi (design note §7.4, §7.5). A plan writes into the folder, pi's agent
// dir: mcp.json's mcpServers.<id> one key at a time, the bound copies of stdio servers into hs-run/,
// the skills into skills/, and settings.json's defaultProvider and defaultModel for a model with no
// endpoint. The endpoint, the login, AGENTS.md and hooks stay launch only. A launch skips what a plan
// installed at this content. No test starts a real harness: the binary is a stub.

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
  const folder = path.join(root, 'pi-folder');
  fs.mkdirSync(folder);
  const bin = write(root, 'bin/pi', '#!/bin/sh\necho "1.5.2"\n');
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home, tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'pi', harness_path: folder, bin, ...args } }, opts);
  return { root, home, folder, bin, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const read = (s, f) => JSON.parse(fs.readFileSync(path.join(s.folder, f), 'utf8'));
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
const team = (s, extra = []) => layer(s.root, 'team', [
  '[model.roles]', 'primary = "bench/bench-primary"', '',
  '[mcp.db]', 'exec = "srv/server.js"', 'args = ["--port", "1"]', 'env = { DB_HOST = "localhost" }', 'self_contained = true', 'exposure = "deferred"', '',
  '[mcp.docs]', 'url = "https://docs.example/mcp"', 'headers = { "X-Team" = "a" }', '',
  '[hook.g]', 'event = "PreToolUse"', 'match = { tool = ["shell"] }', 'run = { exec = "/usr/bin/true" }', '',
  ...extra,
].join('\n'), { 'srv/server.js': 'x\n', 'skills/notes/SKILL.md': skillMd('notes'), 'AGENTS.md': 'Rules.\n' });

test('materialize: the model, two servers and a skill into the folder\'s own files, receipted; the user\'s keys kept; a launch skips them; remove takes them out', () => {
  const s = box();
  try {
    fs.writeFileSync(path.join(s.folder, 'settings.json'), '{\n  "theme": "dark",\n  "quietStartup": true\n}\n');
    fs.writeFileSync(path.join(s.folder, 'mcp.json'), '{\n  "mcpServers": {\n    "mine": { "command": "my-own" }\n  }\n}\n');
    const t = team(s);
    const plan = ok(s.call('plan', { layers: [t], owner: 'builder', mode: 'materialize' }));
    assert.deepEqual(plan.operations.map((o) => [o.address_id, o.risk]), [
      ['settings.json#defaultProvider', []],
      ['settings.json#defaultModel', []],
      ['hs-run/mcp.db', ['runs-code']],
      ['mcp.json#mcpServers/db', ['runs-code']],
      ['mcp.json#mcpServers/docs', ['sends-data']],
      ['skills/notes', ['runs-code']],
    ]);
    assert.ok(plan.launch_only.some((x) => x.item === 'instructions (AGENTS.md)' && /not persisted in this build/.test(x.via)));
    assert.ok(plan.launch_only.some((x) => x.item === 'hook.g' && /not persisted in this build/.test(x.via)));
    assert.equal(s.call('apply', { plan, receipt: { ...receiptFor(plan), allows: [] } }).error.code, 'receipt_required');
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const st = read(s, 'settings.json');
    assert.deepEqual([st.theme, st.quietStartup, st.defaultProvider, st.defaultModel], ['dark', true, 'bench', 'bench-primary']);
    const mcp = read(s, 'mcp.json').mcpServers;
    assert.deepEqual(mcp.mine, { command: 'my-own' }, 'the user\'s own server stays');
    assert.deepEqual(mcp.db, { command: path.join(s.folder, 'hs-run/mcp.db/server.js'), args: ['--port', '1'], env: { DB_HOST: 'localhost' }, exposure: 'deferred' });
    assert.deepEqual(mcp.docs, { url: 'https://docs.example/mcp', headers: { 'X-Team': 'a' }, exposure: 'direct' });
    assert.equal(fs.readFileSync(path.join(s.folder, 'skills/notes/SKILL.md'), 'utf8'), skillMd('notes'));
    assert.equal(fs.statSync(path.join(s.folder, 'hs-run')).mode & 0o777, 0o700);
    // A launch skips what the plan installed; the hook still rides the launch extension.
    const refused = s.call('launch-spec', { layers: [t], headless: true });
    const spec = ok(s.call('launch-spec', { layers: [t], headless: true, receipt: allow(refused) }));
    for (const id of ['mcp.db', 'mcp.docs', 'skill.notes']) assert.ok(spec.skipped.some((x) => x.item === id && /installed in the folder by a plan/.test(x.reason)), id);
    assert.ok(spec.launch_items.some((x) => x.item === 'hook.g'));
    // A second plan is unchanged; remove takes everything out, the user's keys kept.
    assert.deepEqual(ok(s.call('plan', { layers: [t], owner: 'builder', mode: 'materialize' })).operations, []);
    ok(s.call('remove', { owner: 'builder' }));
    assert.equal(fs.readFileSync(path.join(s.folder, 'settings.json'), 'utf8'), '{\n  "theme": "dark",\n  "quietStartup": true\n}\n');
    assert.deepEqual(read(s, 'mcp.json'), { mcpServers: { mine: { command: 'my-own' } } });
    assert.equal(fs.existsSync(path.join(s.folder, 'skills/notes')), false);
    assert.equal(fs.existsSync(path.join(s.folder, 'hs-run/mcp.db')), false);
  } finally {
    s.done();
  }
});

test('materialize refusals: refs, a working directory, a model with no provider, spec text pi would expand or run, SSE; with an endpoint the model stays launch only', () => {
  const s = box();
  try {
    const cases = [
      ['refs', '[refs.T]\ndescription = "t"\n\n[mcp.r]\nurl = "https://x.example/mcp"\nheader_refs = { "X-T" = "T" }\n', /cannot carry a ref/],
      ['cwd', '[mcp.p]\nexec = "/usr/bin/env"\ncwd = "/tmp"\n', /working directory is not carried in this build/],
      ['model', '[model.roles]\nprimary = "bench-primary"\n', /give it as provider\/model/],
      ['model $', '[model.roles]\nprimary = "bench/$X"\n', /the model id holds \$ or a leading !/],
      ['env !', '[mcp.p]\nexec = "/usr/bin/env"\nenv = { A = "!touch x" }\n', /mcp\.p: env\.A holds \$ or a leading !/],
      ['header $', '[mcp.r]\nurl = "https://x.example/mcp"\nheaders = { X = "$S" }\n', /mcp\.r: headers\.X holds/],
      ['arg ~', '[mcp.p]\nexec = "/usr/bin/env"\nargs = ["~/x"]\n', /argument 1 starts with ~/],
      ['sse', '[mcp.r]\nurl = "https://x.example/mcp"\ntype = "sse"\n', /not sse/],
    ];
    for (const [i, [name, toml, re]] of cases.entries()) {
      const local = write(s.root, `l${i}.toml`, '[refs]\nT = "env:T"\n');
      const r = s.call('plan', { layers: [layer(s.root, `r${i}`, toml)], local, owner: 'builder', mode: 'materialize' });
      assert.ok(r.error, name);
      assert.match(JSON.stringify(r.error.items), re, name);
    }
    const ep = write(s.root, 'ep.toml', '[endpoints.openai-chat]\nbase_url = "https://gateway.example/v1"\ncredential = "env:K"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n');
    const plan = ok(s.call('plan', { layers: [layer(s.root, 'm', '[model.roles]\nprimary = "bench-primary"\n')], local: ep, owner: 'builder', mode: 'materialize' }));
    assert.deepEqual(plan.operations, []);
    assert.match(plan.launch_only.find((x) => x.item === 'model.roles.primary').via, /never persists/);
  } finally {
    s.done();
  }
});
