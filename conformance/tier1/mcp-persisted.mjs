#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.4, §7.5; milestone 6a.12), on Claude Code. It starts the
// real harness, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/mcp-persisted.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// MCP servers persisted by a plan under materialize: user scope, .claude.json#mcpServers/<id>, a
// stdio server's directory bound by copy into hs-run/. Measured, with `claude -p` against a local
// endpoint that answers 400:
//   control   no server. Expected: no request carries the stdio server's marker, and the remote
//             server gets nothing (the premise).
//   refused   apply without a receipt for the runs-code and sends-data operations. Expected:
//             receipt_required, and nothing written.
//   applied   plan and apply with the receipt. Expected: .claude.json holds both servers, the
//             copy is owner-only; launch-spec carries neither (both are installed), so no
//             --mcp-config is passed; the stdio server, started from its copy, puts its tool's
//             marker into the model's request; the remote server gets its literal header.
// Credentials are dummies; HOME and XDG are scratch.

import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';

const claude = guard('mcp-persisted.mjs');
const MARK = 'hs-tier1-mcp-persisted-marker-4a7c';
const HEADER = 'hs-tier1-mcp-persisted-header-4a7c';
const TOOL = 'hs_persisted_tool';
const PROMPT = 'tier 1 MCP persisted check';
const b = bench('hs-tier1-mcp-persisted-');

// A minimal stdio MCP server in two files, so the bound copy is a directory: it records that it
// started, from where, and serves one tool.
const SERVER = `import fs from 'node:fs';
import { DESCRIPTION } from './lib.mjs';
fs.writeFileSync(process.env.HS_PROBE_OUT, JSON.stringify({ started: true, from: import.meta.url }));
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
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: ${JSON.stringify(TOOL)}, description: DESCRIPTION, inputSchema: { type: 'object', properties: {} } }] } });
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
`;

try {
  const L = await b.listener('ENDPOINT', { markers: [MARK, `mcp__local__${TOOL}`] });
  const R = await b.listener('REMOTE', { markers: [HEADER] });
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
  fs.mkdirSync(path.join(servers, 'srv'), { recursive: true });
  fs.writeFileSync(path.join(servers, 'srv/server.mjs'), SERVER);
  fs.writeFileSync(path.join(servers, 'srv/lib.mjs'), `export const DESCRIPTION = ${JSON.stringify(`A persisted bench tool. ${MARK}`)};\n`);
  fs.writeFileSync(path.join(servers, 'spec.toml'), `${header('servers')}
[mcp.local]
exec = "node"
args = ["srv/server.mjs"]
env = { HS_PROBE_OUT = "${probe}" }
self_contained = true

[mcp.remote]
url = "${R.url}/mcp"
headers = { X-Bench = "${HEADER}" }
`);
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[endpoints.anthropic-messages]\nbase_url = "${L.url}"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const common = ['--harness', 'claude-code', '--folder', folder, '--local', local, '--bin', claude];
  const listeners = [L, R];
  const start = (spec) => {
    const l = fromSpec(spec, {}, claude, [PROMPT]);
    return b.launch(listeners, l.argv, l.env, cwd);
  };
  const marked = (r, name, m) => r.seen[name].some((q) => q.markers.includes(m));

  const control = await start(b.hs('launch-spec', [...common, '--layer', plain, '--headless']));
  const plan = b.hs('plan', [...common, '--layer', servers, '--owner', 'tier1']);
  const planFile = path.join(b.work, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const noReceipt = path.join(b.work, 'receipt-none.json');
  fs.writeFileSync(noReceipt, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: [], by: 'tier1-bench' }));
  const refused = b.hsCall('apply', [...common, '--plan', planFile, '--receipt', noReceipt]);
  const writtenBefore = fs.existsSync(path.join(folder, 'hs-run'));
  const receipt = path.join(b.work, 'receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench' }));
  b.hs('apply', [...common, '--plan', planFile, '--receipt', receipt]);
  const doc = JSON.parse(fs.readFileSync(path.join(folder, '.claude.json'), 'utf8'));
  const copy = path.join(folder, 'hs-run/mcp.local');
  const mode = (p) => fs.statSync(p).mode & 0o777;
  const spec = b.hs('launch-spec', [...common, '--layer', servers, '--headless']);
  const applied = await start(spec);
  const probed = fs.existsSync(probe) ? JSON.parse(fs.readFileSync(probe, 'utf8')) : { started: false };

  const ops = plan.operations.filter((o) => o.item.startsWith('mcp.')).map((o) => `${o.address_id} ${o.risk.join('+')}`);
  const checks = {
    'without servers no request carries the marker, and the remote server gets nothing (premise)': control.seen.ENDPOINT.length > 0 && !marked(control, 'ENDPOINT', MARK) && control.seen.REMOTE.length === 0,
    'the plan writes the copy and both user-scope servers, each under the receipt': ops.includes('hs-run/mcp.local runs-code') && ops.includes('.claude.json#mcpServers/local runs-code') && ops.includes('.claude.json#mcpServers/remote sends-data'),
    'apply without the receipt is refused, and writes nothing': refused.ok === false && refused.error.code === 'receipt_required' && !writtenBefore,
    '.claude.json holds both servers, and the copy is owner-only': Boolean(doc.mcpServers?.local && doc.mcpServers?.remote) && mode(copy) === 0o700 && mode(path.join(copy, 'server.mjs')) === 0o600,
    'launch-spec carries neither installed server: no --mcp-config': spec.skipped.filter((x) => x.item.startsWith('mcp.')).length === 2 && !spec.argv.includes('--mcp-config'),
    'the stdio server started from its bound copy, and its tool reached the request': probed.started === true && typeof probed.from === 'string' && probed.from.includes('/hs-run/mcp.local/') && marked(applied, 'ENDPOINT', MARK),
    'the remote server got its literal header': marked(applied, 'REMOTE', HEADER),
  };
  const reached = control.seen.ENDPOINT.length > 0 && applied.seen.ENDPOINT.length > 0;
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const shape = (r) => ({ exit: r.exit, timed_out: r.timed_out, requests: r.seen.ENDPOINT.length, marker: marked(r, 'ENDPOINT', MARK), at_remote: r.seen.REMOTE.length, header: r.seen.REMOTE.some((q) => q.markers.includes(HEADER)) });
  const report = {
    check: 'tier 1: MCP servers persisted by a plan under materialize, in user scope, a stdio server bound by copy (design note v0.2 §5.4, §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, claude),
    runs: { control: shape(control), applied: shape(applied) },
    operations: ops,
    refusal: refused.ok ? null : { code: refused.error.code },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(R.url).join('<REMOTE>').split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 MCP persisted check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
