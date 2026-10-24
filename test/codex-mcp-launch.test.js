// Milestone 6a.7: MCP servers at launch on Codex (design note §5.5, §7.5): `-c mcp_servers.<id>.*`
// overrides, under the launch receipt, with secrets by variable name only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { handle } from '../src/hs.js';
import { tomlString } from '../src/drivers/codex/deliver.js';
import { PROTOCOL } from '../src/protocol.js';
import { codexFolder, layer, write } from './fixtures.js';
import { linuxHost, ok, sandbox } from './sandbox.js';

function box() {
  const s = sandbox();
  s.opts.tmpdir = path.join(s.root, 'tmp');
  fs.mkdirSync(s.opts.tmpdir);
  s.codex = codexFolder(s.root);
  // A stub for the Codex binary, inside the compatible range: no test starts a real harness.
  s.codexBin = write(s.root, 'bin/codex', '#!/bin/sh\necho "codex-cli 0.160.0"\n');
  fs.chmodSync(s.codexBin, 0o755);
  s.cx = (op, args) => handle({ protocol: PROTOCOL, op, args: { harness: 'codex', harness_path: s.codex, bin: s.codexBin, ...args } }, { ...s.opts, host: linuxHost });
  return s;
}
const allow = (refused) => ({ format: 'hs-receipt/0.2', launch_digest: refused.error.items[0].launch_digest, allows: [...new Set(refused.error.items[0].risks.map((r) => r.item))], by: 'test', at: 'now' });
// The -c overrides for one server, as key -> value.
function overrides(argv, id) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-c') continue;
    const m = new RegExp(`^mcp_servers\\.${id}\\.([a-z_]+)=(.*)$`).exec(argv[i + 1]);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

test('Codex: a stdio server as -c overrides, under the launch receipt; a ref forwarded under its derived name and renamed by a prelude', () => {
  const s = box();
  try {
    const team = layer(s.root, 'servers', '[refs.DB_PASSWORD]\ndescription = "db"\n\n[mcp.db]\nexec = "node"\nargs = ["server.js", "--port", "1"]\nenv = { DB_HOST = "localhost" }\nenv_refs = { DB_PASS = "DB_PASSWORD" }\ncwd = "work"\n', { 'server.js': 'x\n', 'work/.keep': '' });
    const local = write(s.root, 'local.toml', '[refs]\nDB_PASSWORD = "keychain:example/db"\n');
    const refused = s.cx('launch-spec', { layers: [team], local });
    assert.equal(refused.error.code, 'receipt_required');
    assert.deepEqual(refused.error.items[0].risks.map((r) => [r.item, r.risk, r.files?.map((f) => f.path)]), [['mcp.db', 'runs-code', ['server.js']]]);
    const spec = ok(s.cx('launch-spec', { layers: [team], local, receipt: allow(refused) }));
    assert.deepEqual(overrides(spec.argv, 'db'), {
      command: '"/bin/sh"',
      args: JSON.stringify(['-c', 'export DB_PASS="$HS_SECRET_DB_PASSWORD"; unset HS_SECRET_DB_PASSWORD; exec "$0" "$@"', 'node', path.join(team, 'server.js'), '--port', '1']),
      env: '{"DB_HOST" = "localhost"}',
      env_vars: '["HS_SECRET_DB_PASSWORD"]',
      cwd: JSON.stringify(path.join(team, 'work')),
    });
    // The server's own name never enters Codex's environment, where the shell tool would see it;
    // the derived name holds SECRET, and the launch turns the default excludes on.
    assert.deepEqual(spec.env_from_refs, { HS_SECRET_DB_PASSWORD: 'keychain:example/db' });
    assert.equal(spec.argv.at(-1), 'shell_environment_policy.ignore_default_excludes=false');
    assert.doesNotMatch(spec.argv.join(' '), /keychain:|\$\{/, 'no reference and no ${...} in argv');
  } finally {
    s.done();
  }
});

test('Codex: a streamable HTTP server; refs as SECRET-named variables; SSE refused', () => {
  const s = box();
  try {
    const team = layer(s.root, 'servers', '[refs.TOKEN]\ndescription = "t"\n\n[refs.ORG_KEY]\ndescription = "k"\n\n[mcp.sentry]\nurl = "https://mcp.sentry.example/mcp"\nbearer_ref = "TOKEN"\nheaders = { X-Org = "acme" }\nheader_refs = { X-Key = "ORG_KEY" }\n');
    const local = write(s.root, 'local.toml', '[refs]\nTOKEN = "keychain:example/sentry"\nORG_KEY = "env:ORG_KEY"\n');
    const refused = s.cx('launch-spec', { layers: [team], local });
    assert.deepEqual(refused.error.items[0].risks, [{ item: 'mcp.sentry', layer: 'servers', risk: 'sends-data', destination: 'https://mcp.sentry.example/mcp' }]);
    const spec = ok(s.cx('launch-spec', { layers: [team], local, receipt: allow(refused) }));
    assert.deepEqual(overrides(spec.argv, 'sentry'), {
      url: '"https://mcp.sentry.example/mcp"',
      http_headers: '{"X-Org" = "acme"}',
      env_http_headers: '{"X-Key" = "HS_SECRET_ORG_KEY"}',
      bearer_token_env_var: '"HS_SECRET_TOKEN"',
    });
    assert.deepEqual(spec.env_from_refs, { HS_SECRET_ORG_KEY: 'env:ORG_KEY', HS_SECRET_TOKEN: 'keychain:example/sentry' });
    const sse = layer(s.root, 'sse', '[mcp.s]\nurl = "https://x.example/sse"\ntype = "sse"\n');
    assert.equal(s.cx('launch-spec', { layers: [sse] }).error.code, 'item_unsupported');
  } finally {
    s.done();
  }
});

test('Codex: the prelude, run: every name set from its ref, the derived names gone, the server in its place', () => {
  const s = box();
  try {
    const team = layer(s.root, 'servers', '[refs.R]\ndescription = "r"\n\n[refs.Q]\ndescription = "q"\n\n[mcp.p]\nshell = "printf \\"%s|%s|%s|\\" \\"$A\\" \\"$B\\" \\"$C\\"; printenv HS_SECRET_R || echo gone; echo $$"\nenv_refs = { A = "R", B = "R", C = "Q" }\n');
    const local = write(s.root, 'local.toml', '[refs]\nR = "env:R"\nQ = "env:Q"\n');
    const refused = s.cx('launch-spec', { layers: [team], local });
    const spec = ok(s.cx('launch-spec', { layers: [team], local, receipt: allow(refused) }));
    const o = overrides(spec.argv, 'p');
    assert.deepEqual(JSON.parse(o.env_vars), ['HS_SECRET_R', 'HS_SECRET_Q']);
    const run = spawnSync(JSON.parse(o.command), [...JSON.parse(o.args)], { encoding: 'utf8', env: { PATH: process.env.PATH, HS_SECRET_R: 'r-value', HS_SECRET_Q: 'q-value' } });
    const [line, pid] = run.stdout.trim().split('\n');
    assert.deepEqual(line.split('|'), ['r-value', 'r-value', 'q-value', 'gone']);
    assert.equal(Number(pid), run.pid, 'the server execs in the prelude\'s place, so the harness\'s signals reach it');
  } finally {
    s.done();
  }
});

test('Codex: refused ids and variables; a package launcher fetches code; plans list MCP as launch_only', () => {
  const s = box();
  try {
    const dotted = layer(s.root, 'dotted', '[mcp."my.db"]\nexec = "x"\n');
    assert.equal(s.cx('launch-spec', { layers: [dotted] }).error.code, 'item_unsupported', 'a -c path is dotted');
    fs.rmSync(path.join(s.codex, 'auth.json'), { force: true });
    // A server may read a name the launch unsets: it is set inside the server only.
    const unset = layer(s.root, 'unset', '[refs.R]\ndescription = "r"\n\n[mcp.c]\nexec = "x"\nenv_refs = { OPENAI_API_KEY = "R" }\n');
    const gw = write(s.root, 'gw.toml', '[refs]\nR = "env:R"\n\n[endpoints.openai-responses]\nbase_url = "https://gw.example/v1"\ncredential = "env:K"\n');
    const r1 = s.cx('launch-spec', { layers: [unset], local: gw });
    const spec = ok(s.cx('launch-spec', { layers: [unset], local: gw, receipt: allow(r1) }));
    assert.ok(spec.env_unset.includes('OPENAI_API_KEY'));
    assert.equal(spec.env_from_refs.OPENAI_API_KEY, undefined);
    assert.equal(spec.env_from_refs.HS_SECRET_R, 'env:R');
    // Two refs with one derived name, and a name no shell can set, are refused.
    const clash = layer(s.root, 'clash', '[refs.db-pass]\ndescription = "a"\n\n[refs.DB_PASS]\ndescription = "b"\n\n[mcp.c]\nexec = "x"\nenv_refs = { A = "db-pass", B = "DB_PASS" }\n');
    const both = write(s.root, 'both.toml', '[refs]\ndb-pass = "env:A"\nDB_PASS = "env:B"\n');
    assert.equal(s.cx('launch-spec', { layers: [clash], local: both }).error.code, 'bad_request');
    // A name under the derived prefix would clobber the prelude (a review's example: DB_PASS
    // would get R's value, and HS_SECRET_Q would be unset), in env_refs or env, in any case.
    for (const [n, body] of [['under', 'env_refs = { HS_SECRET_Q = "R", DB_PASS = "Q" }'], ['lower', 'env_refs = { hs_secret_q = "R" }'], ['env', 'env = { HS_SECRET_Q = "x" }\nenv_refs = { DB_PASS = "Q" }']]) {
      const l = layer(s.root, `prefix-${n}`, `[refs.R]\ndescription = "r"\n\n[refs.Q]\ndescription = "q"\n\n[mcp.c]\nexec = "x"\n${body}\n`);
      const lt = write(s.root, `prefix-${n}.toml`, '[refs]\nR = "env:R"\nQ = "env:Q"\n');
      const res = s.cx('launch-spec', { layers: [l], local: lt });
      assert.deepEqual([res.error?.code, res.error?.items], ['bad_request', ['mcp.c']], n);
    }
    const odd = layer(s.root, 'odd', '[refs.R]\ndescription = "r"\n\n[mcp.c]\nexec = "x"\nenv_refs = { "A-B" = "R" }\n');
    assert.equal(s.cx('launch-spec', { layers: [odd], local: gw }).error.code, 'item_unsupported');
    // A server the folder's config.toml defines under the same id: a -c override would merge into it.
    const plain = layer(s.root, 'plain', '[mcp.c]\nexec = "x"\n');
    assert.match(s.cx('launch-spec', { layers: [plain] }).error.items[0].risks.map((r) => r.item).join(), /mcp\.c/);
    const r2 = s.cx('launch-spec', { layers: [plain] });
    assert.ok(ok(s.cx('launch-spec', { layers: [plain], receipt: allow(r2) })).unverified.some((u) => /managed_config\.toml/.test(u)));
    fs.writeFileSync(path.join(s.codex, 'config.toml'), 'model = "gpt-6"\n\n[mcp_servers.c]\ncommand = "theirs"\n');
    const same = s.cx('launch-spec', { layers: [plain] });
    assert.deepEqual([same.error.code, same.error.items], ['bad_request', ['mcp.c']]);
    fs.writeFileSync(path.join(s.codex, 'config.toml'), 'model = \n');
    assert.equal(s.cx('launch-spec', { layers: [plain] }).error.code, 'bad_request', 'an unreadable config.toml cannot be told apart');
    fs.writeFileSync(path.join(s.codex, 'config.toml'), 'model = "gpt-6"\n');
    const npx = layer(s.root, 'npx', '[mcp.n]\nexec = "npx"\nargs = ["-y", "@scope/server@1.2.3"]\n');
    const risks = s.cx('launch-spec', { layers: [npx] }).error.items[0].risks;
    assert.deepEqual(risks.find((r) => r.risk === 'fetches-code').packages, [{ package: '@scope/server@1.2.3', pinned: true }]);
    const plan = ok(s.cx('plan', { layers: [npx], owner: 'tool', mode: 'overlay' }));
    assert.ok(plan.launch_only.some((x) => x.item === 'mcp.n' && /mcp_servers/.test(x.via)));
  } finally {
    s.done();
  }
});

test('Codex: -c values are TOML strings: control characters and DEL escaped, a lone surrogate refused', () => {
  for (const v of ['plain', 'q"uote', 'back\\slash', 'tab\tnew\nline', 'del\u007Fend', 'nul\u0000', 'astral \u{1F600}', 'é']) {
    assert.equal(parseToml(`v = ${tomlString(v)}`).v, v, JSON.stringify(v));
  }
  assert.equal(tomlString('a\u007Fb'), '"a\\u007Fb"');
  for (const v of ['\uD800', 'x\uDFFFy']) assert.throws(() => tomlString(v), (e) => e.code === 'bad_request', JSON.stringify(v));
  // Through launch-spec: a header with DEL reaches argv as valid TOML.
  const s = box();
  try {
    const team = layer(s.root, 'h', '[mcp.h]\nurl = "https://h.example/mcp"\nheaders = { X-A = "a\\u007Fb" }\n');
    const refused = s.cx('launch-spec', { layers: [team] });
    const spec = ok(s.cx('launch-spec', { layers: [team], receipt: allow(refused) }));
    assert.deepEqual({ ...parseToml(`t = ${overrides(spec.argv, 'h').http_headers}`).t }, { 'X-A': 'a\u007Fb' });
    // No secret in this launch, so the shell policy is left alone.
    assert.ok(!spec.argv.some((a) => a.startsWith('shell_environment_policy')));
  } finally {
    s.done();
  }
});
