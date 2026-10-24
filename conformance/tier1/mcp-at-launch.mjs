#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.5, §7.5; milestone 6a.4), on Claude Code. It starts the
// real harness, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/mcp-at-launch.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// MCP servers reach a launch through `--mcp-config <file>`, under a launch receipt, with each ref
// written as ${HS_REF_<ref>} for the caller to fill. Measured here:
//   control   the same endpoint launch with no server. Expected: no request names the stdio
//             server's tool, and the remote server gets nothing (the premise).
//   refused   launch-spec with a stdio and a remote server and no receipt. Expected:
//             receipt_required; runs-code for the stdio server, sends-data naming the remote one.
//   carried   with a receipt. Expected: the stdio server starts and its tool reaches the model's
//             request; the server saw its env ref expanded to the bench's dummy; the remote server
//             got the bearer dummy in its header (so ${VAR} expands in a --mcp-config file); no
//             server is written into the data folder.
// The stdio server is a few lines of JSON-RPC written into the layer. The listeners record the kind
// of credential and which markers a request carries; the server records only whether its value
// matched. The credentials are dummies; HOME and XDG are scratch.

import fs from 'node:fs';
import path from 'node:path';
import { DUMMY, REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';

const claude = guard('mcp-at-launch.mjs');
const MARK = 'hs-tier1-mcp-marker-9d2b';
const TOOL = 'hs_marker_tool';
const PROMPT = 'tier 1 MCP at launch check';
const b = bench('hs-tier1-mcp-at-launch-');

// A minimal stdio MCP server: newline-delimited JSON-RPC, one tool. It writes whether DB_PASS is
// the expected value, never the value itself.
const SERVER = `import fs from 'node:fs';
fs.writeFileSync(process.env.HS_PROBE_OUT, process.env.DB_PASS === ${JSON.stringify(DUMMY)} ? 'match' : process.env.DB_PASS === undefined ? 'unset' : 'mismatch');
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

const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, at_endpoint: r.seen.ENDPOINT, at_remote: r.seen.REMOTE });

try {
  const L = await b.listener('ENDPOINT', { markers: [MARK, `mcp__local__${TOOL}`] });
  const R = await b.listener('REMOTE');
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const folder = path.join(b.work, 'folder');
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
  fs.writeFileSync(local, `[refs]\nDB_PASSWORD = "env:${REF_VAR}"\nREMOTE_TOKEN = "env:${REF_VAR}"\n\n[endpoints.anthropic-messages]\nbase_url = "${L.url}"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const args = (layer, extra = []) => ['--harness', 'claude-code', '--folder', folder, '--layer', layer, '--local', local, '--bin', claude, '--headless', ...extra];
  const listeners = [L, R];
  const start = (spec) => {
    const l = fromSpec(spec, {}, claude, [PROMPT]);
    return b.launch(listeners, l.argv, l.env, cwd);
  };

  const control = await start(b.hs('launch-spec', args(plain)));

  const refused = b.hsCall('launch-spec', args(servers));
  const refusal = refused.ok ? null : refused.error;
  const digest = refusal?.items?.[0]?.launch_digest ?? null;
  const risks = refusal?.items?.[0]?.risks ?? [];
  const receiptFile = path.join(b.work, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ format: 'hs-receipt/0.2', launch_digest: digest, allows: [...new Set(risks.map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() }));
  const spec = b.hs('launch-spec', args(servers, ['--receipt', receiptFile]));
  const carried = await start(spec);
  const probed = fs.existsSync(probe) ? fs.readFileSync(probe, 'utf8') : 'not started';
  let folderMcp = [];
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(folder, '.claude.json'), 'utf8'));
    folderMcp = Object.keys(doc.mcpServers ?? {});
  } catch {
    // no .claude.json
  }

  const has = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  const checks = {
    'without servers no request names the tool, and the remote server gets nothing (premise)': control.seen.ENDPOINT.length > 0 && !has(control, MARK) && control.seen.REMOTE.length === 0,
    'without a receipt launch-spec refuses: runs-code for the stdio server, sends-data naming the remote one': refusal?.code === 'receipt_required'
      && risks.some((r) => r.item === 'mcp.local' && r.risk === 'runs-code')
      && risks.some((r) => r.item === 'mcp.remote' && r.risk === 'sends-data' && r.destination === `${R.url}/mcp`),
    'with the receipt the launch carries --mcp-config': spec.argv.includes('--mcp-config') && spec.launch_digest === digest,
    'the stdio server starts and its tool reaches the request': has(carried, `mcp__local__${TOOL}`) && has(carried, MARK),
    'the stdio server saw its env ref expanded to the dummy': probed === 'match',
    'the remote server got the bearer dummy in its header': carried.seen.REMOTE.some((q) => q.credential === 'bearer:bench-dummy'),
    'no server is written into the data folder': folderMcp.length === 0,
  };
  const reached = control.seen.ENDPOINT.length > 0 && carried.seen.ENDPOINT.length > 0;
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: MCP servers at launch, through --mcp-config under a launch receipt (design note v0.2 §5.5, §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, claude),
    runs: { control: shape(control), carried: shape(carried) },
    refusal: refusal ? { code: refusal.code, risks: risks.map((r) => ({ item: r.item, risk: r.risk, ...(r.destination ? { destination: '<REMOTE>/mcp' } : {}), ...(r.files ? { files: r.files.map((f) => f.path) } : {}), ...(r.text ? { text: r.text } : {}) })) } : null,
    stdio_server_env_ref: probed,
    folder_mcp_servers: folderMcp,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(R.url).join('<REMOTE>').split(L.url).join('<ENDPOINT>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 MCP at launch check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
