// Milestone 6a.12 (item 2c): MCP servers under materialize on Claude Code. A server persists in
// user scope, .claude.json#mcpServers/<id> [CC §8], ref-free only, and a stdio server's one layer
// directory is bound by copy into hs-run/ (design note §5.4, §7.5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handlers } from '../src/native.js';
import ccDriver from '../src/drivers/claude-code/index.js';
import { layer, write } from './fixtures.js';
import { ok, receiptFor, sandbox } from './sandbox.js';

const D = ccDriver.descriptor;
const claudeJson = (folder) => JSON.parse(fs.readFileSync(path.join(folder, '.claude.json'), 'utf8'));
const mode = (p) => fs.statSync(p).mode & 0o777;
const mine = (plan, item) => plan.operations.filter((o) => o.item === item);

function serverLayer(s) {
  return layer(s.root, 'servers', '[mcp.db]\nexec = "node"\nargs = ["srv/server.mjs", "--port", "1"]\nenv = { MODE = "x" }\nself_contained = true\n',
    { 'srv/server.mjs': 'import "./lib.mjs";\n', 'srv/lib.mjs': 'export {};\n' });
}

test('a stdio server persisted in user scope, its directory bound by copy; receipted; launch skips it; remove restores', () => {
  const s = sandbox();
  try {
    const before = claudeJson(s.folder);
    const team = serverLayer(s);
    const plan = ok(s.call('plan', { layers: [team], owner: 'builder' }));
    const ops = mine(plan, 'mcp.db');
    assert.deepEqual(ops.map((o) => [o.action, o.handler, o.address_id, o.risk]), [
      ['create', 'tree', 'hs-run/mcp.db', ['runs-code']], ['create', 'json-key', '.claude.json#mcpServers/db', ['runs-code']]]);
    const copy = path.join(s.folder, 'hs-run/mcp.db');
    assert.deepEqual(ops[1].value, { type: 'stdio', command: 'node', args: [path.join(copy, 'server.mjs'), '--port', '1'], env: { MODE: 'x' } });
    assert.match(ops[1].note, /only that tree is bound/);
    assert.match(ops[1].note, /a project or local server named db wins over this user-scope one/);
    assert.equal(s.call('apply', { plan, receipt: receiptFor(plan, []) }).error.code, 'receipt_required');
    ok(s.call('apply', { plan, receipt: receiptFor(plan) }));
    const after = claudeJson(s.folder);
    assert.deepEqual(after.mcpServers.db, ops[1].value);
    for (const k of Object.keys(before)) if (k !== 'mcpServers') assert.deepEqual(after[k], before[k], `.claude.json#${k} kept`);
    assert.equal(mode(copy), 0o700);
    assert.equal(mode(path.join(copy, 'server.mjs')), 0o600);
    // At launch it is in the folder's user scope already: not carried in --mcp-config again.
    const spec = ok(s.call('launch-spec', { layers: [team] }));
    assert.ok(spec.skipped.some((x) => x.item === 'mcp.db' && /installed in the folder by a plan/.test(x.reason)));
    assert.ok(!spec.files.some((f) => f.role === 'mcp'));
    // Edited in the layer, it is carried at launch again, under a launch receipt.
    fs.appendFileSync(path.join(team, 'srv/lib.mjs'), '// changed\n');
    assert.equal(s.call('launch-spec', { layers: [team] }).error.code, 'receipt_required');
    fs.writeFileSync(path.join(team, 'srv/lib.mjs'), 'export {};\n');
    ok(s.call('remove', { owner: 'builder' }));
    assert.equal(claudeJson(s.folder).mcpServers?.db, undefined);
    assert.equal(fs.existsSync(copy), false);
  } finally {
    s.done();
  }
});

test('a remote server persists by its text, sends-data; a launcher keeps fetches-code; refs, cwd and exposure are refused', () => {
  const s = sandbox();
  try {
    const remote = layer(s.root, 'remote', '[mcp.api]\nurl = "https://api.example/mcp"\nheaders = { X-Org = "acme" }\n');
    let ops = mine(ok(s.call('plan', { layers: [remote], owner: 'builder' })), 'mcp.api');
    assert.deepEqual(ops.map((o) => [o.handler, o.address_id, o.risk]), [['json-key', '.claude.json#mcpServers/api', ['sends-data']]]);
    assert.deepEqual(ops[0].value, { type: 'http', url: 'https://api.example/mcp', headers: { 'X-Org': 'acme' } });
    const npx = layer(s.root, 'npx', '[mcp.n]\nexec = "npx"\nargs = ["-y", "@scope/server"]\n');
    ops = mine(ok(s.call('plan', { layers: [npx], owner: 'builder' })), 'mcp.n');
    assert.deepEqual(ops[0].risk.sort(), ['fetches-code', 'runs-code']);
    assert.match(ops[0].note, /binds the command text only/);
    const local = write(s.root, 'local.toml', '[refs]\nR = "env:R"\n');
    const refused = (toml) => s.call('plan', { layers: [layer(s.root, `r${Math.random()}`.replace('.', ''), `[refs.R]\ndescription = "r"\n\n${toml}`)], local, owner: 'builder' }).error;
    for (const toml of [
      '[mcp.e]\nexec = "x"\nenv_refs = { A = "R" }\n',
      '[mcp.h]\nurl = "https://x.example/mcp"\nheader_refs = { X-Key = "R" }\n',
      '[mcp.b]\nurl = "https://x.example/mcp"\nbearer_ref = "R"\n',
    ]) {
      const e = refused(toml);
      assert.equal(e.code, 'item_unsupported', toml);
      assert.match(e.items[0].reason, /empty secret/);
    }
    const cwd = s.call('plan', { layers: [layer(s.root, 'cwd', '[mcp.c]\nexec = "x"\ncwd = "."\n')], owner: 'builder' }).error;
    assert.match(cwd.items[0].reason, /no working directory/);
  } finally {
    s.done();
  }
});

test('the user\'s own server is not overwritten; .claude.json takes only mcpServers/<id>, never deeper, never a state key', () => {
  const s = sandbox();
  try {
    const doc = claudeJson(s.folder);
    doc.mcpServers = { db: { type: 'stdio', command: 'mine' } };
    fs.writeFileSync(path.join(s.folder, '.claude.json'), JSON.stringify(doc));
    const res = s.call('plan', { layers: [serverLayer(s)], owner: 'builder' });
    assert.equal(res.error.code, 'unowned_conflict');
    // The handlers: one level under mcpServers only; the account state is cleared, never set.
    assert.throws(() => handlers['json-key'].write(s.folder, D, { file: '.claude.json', key: 'mcpServers/a/b' }, {}), { code: 'write_refused' });
    assert.throws(() => handlers['json-key'].write(s.folder, D, { file: '.claude.json', key: 'mcpServers/.x' }, {}), { code: 'write_refused' });
    assert.throws(() => handlers['json-key'].write(s.folder, D, { file: '.claude.json', key: 'projects' }, {}), { code: 'write_refused' });
    assert.throws(() => handlers['json-key'].write(s.folder, D, { file: '.claude.json', key: D.account_state.keys[0] }, 'x'), { code: 'write_refused' });
    assert.throws(() => handlers['json-key'].clear(s.folder, D, '.claude.json', ['mcpServers/db']), { code: 'write_refused' }, 'a server is no clear-only key');
    assert.deepEqual(claudeJson(s.folder).mcpServers, { db: { type: 'stdio', command: 'mine' } });
  } finally {
    s.done();
  }
});

test('review: in the default folder a persisted server is refused (a bare claude reads ~/.claude.json, outside it); launch still carries it', () => {
  const s = sandbox('2.1.307', { defaultFolder: true });
  try {
    const team = serverLayer(s);
    const res = s.call('plan', { layers: [team], owner: 'builder' });
    assert.equal(res.error.code, 'item_unsupported');
    const item = res.error.items.find((i) => i.item === 'mcp.db');
    assert.match(item.reason, /default folder.*~\/\.claude\.json beside it, outside the folder/);
    assert.equal(fs.existsSync(path.join(s.home, '.claude.json')) && JSON.parse(fs.readFileSync(path.join(s.home, '.claude.json'), 'utf8')).mcpServers?.db !== undefined, false, '~/.claude.json is never written');
    // Under overlay, and at launch, the server is carried as before.
    assert.ok(ok(s.call('plan', { layers: [team], owner: 'builder', mode: 'overlay' })).launch_only.some((x) => x.item === 'mcp.db'));
    assert.equal(s.call('launch-spec', { layers: [team] }).error.code, 'receipt_required');
  } finally {
    s.done();
  }
});

test('review: the default folder is told by real path, so a folder ~/.claude links to counts too (a bare claude reaches it as ~/.claude)', async () => {
  const { handle } = await import('../src/hs.js');
  const { PROTOCOL } = await import('../src/protocol.js');
  const s = sandbox();
  try {
    // ~/.claude is a link to the sandbox's folder: a bare claude reaches that folder as ~/.claude,
    // and reads ~/.claude.json, outside it.
    fs.symlinkSync(s.folder, path.join(s.home, '.claude'));
    const res = s.call('plan', { layers: [serverLayer(s)], owner: 'builder' });
    assert.equal(res.error.code, 'item_unsupported');
    // A folder ~/.claude does not reach is not the default one, whatever its name.
    fs.rmSync(path.join(s.home, '.claude'));
    assert.ok(ok(s.call('plan', { layers: [serverLayer(s)], owner: 'builder' })).operations.some((o) => o.address_id === '.claude.json#mcpServers/db'));
    void handle; void PROTOCOL;
  } finally {
    s.done();
  }
});
