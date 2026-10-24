#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.5, §7.5; milestone 6a.7), on Codex. It starts the real
// harness, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/codex-mcp-at-launch.mjs --codex <path> [--hs-rev <sha>] [--keep]
//
// MCP servers reach a Codex launch as `-c mcp_servers.<id>.*` overrides, under a launch receipt,
// with secrets by variable name only. Measured, with `codex exec` against a local Responses
// endpoint that answers 400:
//   control   no server. Expected: no request carries the stdio server's marker, and the remote
//             server gets nothing (the premise).
//   refused   launch-spec with a stdio and a remote server and no receipt. Expected:
//             receipt_required; runs-code and sends-data.
//   carried   with a receipt. Expected: the stdio server starts and its tool's marker reaches the
//             model's request; the server saw its env ref as the dummy, forwarded by env_vars
//             under its derived name and renamed by the /bin/sh prelude, with no derived name
//             left; the remote server got the bearer dummy (bearer_token_env_var); config.toml
//             is not written.
//   shell     the scripted model (@agent-realm/scripted-model) calls exec_command with `env`, and
//             the check keeps only which names the tool's output holds. stock: the launch with hs's
//             -c shell_environment_policy.ignore_default_excludes=false taken out, in a folder
//             with no policy (the premise: Codex 0.160.0 defaults the excludes off, so the shell
//             tool sees HS_SECRET_* and HS_ENDPOINT_KEY). forced: the folder sets
//             ignore_default_excludes = true and the launch is hs's own; the shell tool sees
//             neither, and still sees a plain variable. Both run `env` with
//             --sandbox danger-full-access (below).
// The model and the listener record kinds, markers and tool names only; the server records only whether its
// value matched. Credentials are dummies; HOME and XDG are scratch.

import fs from 'node:fs';
import path from 'node:path';
import { DUMMY, REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';

const codex = guard('codex-mcp-at-launch.mjs', '--codex');
const MARK = 'hs-tier1-codex-mcp-marker-3b8f';
const TOOL = 'hs_marker_tool';
const PROMPT = 'tier 1 Codex MCP at launch check';
const b = bench('hs-tier1-codex-mcp-');
const VISIBLE = 'HS_BENCH_VISIBLE';
const SCRUB = 'shell_environment_policy.ignore_default_excludes=false';

// The script of a shell run: the run's first request calls exec_command with `env`; the next,
// holding the call's output, ends the turn. Other runs load no script, so every request gets 400.
const ENV_CALL = { steps: [
  { when: { turn: 1 }, reply: { tool_calls: [{ id: 'call_env', name: 'exec_command', args: { cmd: 'env' } }] } },
  { when: { after_tool: 'call_env' }, reply: { text: 'done' } },
] };
// Which names the call's output holds, never their values.
const shell = { saw: null };
function inspect(json) {
  const outputs = (Array.isArray(json?.input) ? json.input : []).filter((i) => i?.type === 'function_call_output' && i.call_id === 'call_env');
  if (!outputs.length) return;
  const text = outputs.map((o) => (typeof o.output === 'string' ? o.output : JSON.stringify(o.output))).join('\n');
  shell.saw = {
    names: [...new Set([...text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]))].sort(),
    visible: text.includes(`${VISIBLE}=`),
    hs_secret: text.includes('HS_SECRET_'),
    endpoint_key: text.includes('HS_ENDPOINT_KEY'),
    dummy: text.includes(DUMMY),
  };
}

const SERVER = `import fs from 'node:fs';
fs.writeFileSync(process.env.HS_PROBE_OUT, JSON.stringify({
  db_pass: process.env.DB_PASS === ${JSON.stringify(DUMMY)} ? 'match' : process.env.DB_PASS === undefined ? 'unset' : 'mismatch',
  derived: Object.keys(process.env).some((k) => k.startsWith('HS_SECRET_')) ? 'present' : 'absent',
}));
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hs-bench', version: '1.0.0' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: ${JSON.stringify(TOOL)}, description: ${JSON.stringify(`A bench tool. ${MARK}`)}, inputSchema: { type: 'object', properties: {} } }] } });
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
`;
const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left,
  at_endpoint: r.seen.ENDPOINT.map((q) => ({ method: q.method, path: q.path, credential: q.credential, markers: q.markers, tools: q.tools })), at_remote: r.seen.REMOTE });

try {
  const L = await b.model('ENDPOINT', { markers: [MARK], inspect });
  const R = await b.listener('REMOTE');
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const folder = path.join(b.work, 'codex-home');
  fs.mkdirSync(folder);
  const probe = path.join(b.work, 'probe-out');
  const header = (name) => `[spec]\nname = "${name}"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n`;
  const plain = path.join(b.work, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'spec.toml'), header('plain'));
  const servers = path.join(b.work, 'servers');
  fs.mkdirSync(servers);
  fs.writeFileSync(path.join(servers, 'server.mjs'), SERVER);
  fs.writeFileSync(path.join(servers, 'spec.toml'), `${header('servers')}
[refs.DB_PASSWORD]
description = "the stdio server's password"

[refs.REMOTE_TOKEN]
description = "the remote server's token"

[mcp.local]
exec = "node"
args = ["server.mjs"]
env = { HS_PROBE_OUT = "${probe}" }
env_refs = { DB_PASS = "DB_PASSWORD" }

[mcp.remote]
url = "${R.url}/mcp"
bearer_ref = "REMOTE_TOKEN"
`);
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[refs]\nDB_PASSWORD = "env:${REF_VAR}"\nREMOTE_TOKEN = "env:${REF_VAR}"\n\n[endpoints.openai-responses]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const args = (layer, extra = []) => ['--harness', 'codex', '--folder', folder, '--layer', layer, '--local', local, '--bin', codex, '--headless', ...extra];
  const listeners = [L, R];
  const start = (spec, { strip = false, unsandboxed = false } = {}) => {
    // codex exec outside a git repository needs --skip-git-repo-check (launch-spec's cwd_requirements).
    // The shell runs run their one scripted `env` unsandboxed: the read-only sandbox's bwrap cannot
    // set up loopback on this bench, and the environment policy applies with or without it
    // (populate_env [CX §12]).
    const tail = ['--skip-git-repo-check', ...(unsandboxed ? ['--sandbox', 'danger-full-access'] : []), PROMPT];
    const l = fromSpec(spec, { [VISIBLE]: 'visible' }, codex, tail);
    if (strip) {
      const i = l.argv.indexOf(SCRUB);
      if (i < 1 || l.argv[i - 1] !== '-c') throw new Error('the launch carries no scrub flag to take out');
      l.argv.splice(i - 1, 2);
    }
    return b.launch(listeners, l.argv, l.env, cwd);
  };
  const shellRun = async (spec, opts) => {
    shell.saw = null;
    L.load(ENV_CALL);
    const r = await start(spec, opts);
    L.load({ steps: [] });
    return { ...shape(r), saw: shell.saw };
  };

  const control = await start(b.hs('launch-spec', args(plain)));
  const refused = b.hsCall('launch-spec', args(servers));
  const refusal = refused.ok ? null : refused.error;
  const risks = refusal?.items?.[0]?.risks ?? [];
  const digest = refusal?.items?.[0]?.launch_digest ?? null;
  const receiptFile = path.join(b.work, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ format: 'hs-receipt/0.2', launch_digest: digest, allows: [...new Set(risks.map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() }));
  const spec = b.hs('launch-spec', args(servers, ['--receipt', receiptFile]));
  const configBefore = fs.existsSync(path.join(folder, 'config.toml')) ? fs.readFileSync(path.join(folder, 'config.toml'), 'utf8') : null;
  const carried = await start(spec);
  const configAfter = fs.existsSync(path.join(folder, 'config.toml')) ? fs.readFileSync(path.join(folder, 'config.toml'), 'utf8') : null;
  const stock = await shellRun(spec, { strip: true, unsandboxed: true });
  fs.writeFileSync(path.join(folder, 'config.toml'), '[shell_environment_policy]\nignore_default_excludes = true\n');
  const forcedSpec = b.hs('launch-spec', args(servers, ['--receipt', receiptFile]));
  const forced = await shellRun(forcedSpec, { unsandboxed: true });
  const probed = fs.existsSync(probe) ? JSON.parse(fs.readFileSync(probe, 'utf8')) : { db_pass: 'not started', derived: 'not started' };

  const marked = (r) => r.seen.ENDPOINT.some((q) => q.markers.includes(MARK));
  const checks = {
    'without servers no request carries the marker, and the remote server gets nothing (premise)': control.seen.ENDPOINT.length > 0 && !marked(control) && control.seen.REMOTE.length === 0,
    'without a receipt launch-spec refuses: runs-code and sends-data': refusal?.code === 'receipt_required'
      && risks.some((r) => r.item === 'mcp.local' && r.risk === 'runs-code') && risks.some((r) => r.item === 'mcp.remote' && r.risk === 'sends-data' && r.destination === `${R.url}/mcp`),
    'with the receipt the launch carries -c mcp_servers overrides': spec.argv.some((a) => a.startsWith('mcp_servers.local.command=')) && spec.argv.some((a) => a.startsWith('mcp_servers.remote.url=')) && spec.launch_digest === digest,
    'the stdio server starts and its tool reaches the request': marked(carried),
    'the stdio server saw its env ref as the dummy, renamed from its derived variable': probed.db_pass === 'match',
    'no derived variable reached the stdio server': probed.derived === 'absent',
    'the remote server got the bearer dummy': carried.seen.REMOTE.some((q) => q.credential === 'bearer:bench-dummy'),
    'config.toml is not written': configBefore === configAfter && (configAfter === null || !configAfter.includes('mcp_servers')),
    'the launch carries the scrub flag': spec.argv.includes(SCRUB) && forcedSpec.argv.includes(SCRUB),
    'without the flag the shell tool sees the secret variables (premise: the 0.160.0 default)': stock.saw?.visible === true && stock.saw.hs_secret && stock.saw.endpoint_key,
    'with the flag, over a folder that turns the excludes off, the shell tool sees neither, and still sees a plain variable': forced.saw?.visible === true && !forced.saw.hs_secret && !forced.saw.endpoint_key && !forced.saw.dummy,
  };
  const reached = control.seen.ENDPOINT.length > 0 && carried.seen.ENDPOINT.length > 0 && stock.saw !== null && forced.saw !== null;
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: MCP servers at launch on Codex, through -c mcp_servers under a launch receipt (design note v0.2 §5.5, §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, codex),
    runs: { control: shape(control), carried: shape(carried), shell_stock: stock, shell_forced: forced },
    refusal: refusal ? { code: refusal.code, risks: risks.map((r) => ({ item: r.item, risk: r.risk })) } : null,
    stdio_server_env_ref: probed,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(R.url).join('<REMOTE>').split(L.url).join('<ENDPOINT>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 Codex MCP at launch check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
