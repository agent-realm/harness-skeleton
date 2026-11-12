#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.7, milestone 8.4), on pi. It starts the real harness, so
// it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/agent-plugins-pi.mjs --pi <path> [--hs-rev <sha>] [--keep]
//
// hs's own route for an Agent Plugins package on pi: translated into one generated pi package. The
// package (conformance/lib/agent-plugins.mjs) holds a skill and a stdio MCP server whose probe
// records what it was started with, plus code the format never discovers: an extensions/ file that
// creates a probe file if it loads. The model is scripted (it calls the server's tool, then
// answers), the key a dummy, the network refused. Runs:
//   launch     hs's launch-spec for the package, run as a caller runs it: the -e route
//   refused    a package whose server env holds $HOME: validate and launch-spec refuse it
//   bare       after hs plan and apply under materialize, a start through hs's launch for a plain
//              layer (no -e for the plugin): the folder's settings.json packages route
//   skipped    hs's launch-spec for the package after the plan: the plugin skipped as installed
//   strict     the same with isolation = "strict": the installed plugin named again with -e
//   removed    after hs remove, a start: neither skill nor server; the plugin data kept, then
//              deleted by remove --purge-data after a second plan
// Names and booleans only.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DUMMY, REF_VAR, bench, evidence, guard } from '../lib/bench.mjs';
import { probe, writePackage } from '../lib/agent-plugins.mjs';

const pi = guard('agent-plugins-pi.mjs', '--pi');
const PROMPT = 'tier 1 agent plugins on pi check';
const M = { skill: 'hs-tier1-app-skill-6d20', tool: 'hs-tier1-app-tool-a3f9' };
const NAME = 'bench-kit';
const TOOL = `mcp__${NAME}__probe__ping`;
const b = bench('hs-tier1-agent-plugins-pi-');

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const names = (dir, depth = 3, rel = '') => {
  if (depth === 0 || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((n) => {
    const p = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    return fs.lstatSync(p).isDirectory() ? [`${r}/`, ...names(p, depth - 1, r)] : [r];
  });
};

let proxy = null;
try {
  const hosts = [];
  proxy = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    try {
      hosts.push(new URL(req.url).hostname);
    } catch {
      hosts.push((req.headers.host ?? '').split(':')[0] || null);
    }
    res.writeHead(403).end();
  });
  proxy.on('clientError', (_e, socket) => socket.destroy());
  proxy.on('connect', (req, socket) => {
    socket.on('error', () => {});
    hosts.push(String(req.url).split(':')[0]);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const viaProxy = { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

  const cwd = path.join(b.scratch.HOME, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const probeOut = path.join(b.work, 'probe.json');
  const undeclared = path.join(b.work, 'undeclared.loaded');
  // The layers: the package, the same with strict isolation, a plain one, and a refused one.
  const layerWith = (dir, { strict = false, pkg = true, env = {} } = {}) => {
    put(path.join(dir, 'spec.toml'), [...(strict ? ['isolation = "strict"', ''] : []), '[spec]', `name = "${path.basename(dir)}"`, 'version = "1.0.0"', 'format = "0.2"', '', '[model.roles]', 'primary = "bench-primary"', '',
      ...(pkg ? [`[plugin.${JSON.stringify(NAME)}]`, `source = "plugins/${NAME}"`, 'format = "agent-plugins"', ''] : [])].join('\n'));
    if (pkg) {
      writePackage(path.join(dir, 'plugins', NAME), {
        name: NAME, marks: { skill: M.skill, tool: M.tool }, tool: 'ping', probeOut, env,
        files: { 'extensions/undeclared.js': `import { writeFileSync } from 'node:fs';\nexport default function () {\n  writeFileSync(${JSON.stringify(undeclared)}, 'loaded');\n}\n` },
      });
    }
    return dir;
  };
  const kit = layerWith(path.join(b.work, 'kit'));
  const strictKit = layerWith(path.join(b.work, 'kit-strict'), { strict: true });
  const plain = layerWith(path.join(b.work, 'plain'), { pkg: false });
  const badKit = layerWith(path.join(b.work, 'kit-bad'), { env: { HS_HOME: '$HOME' } });

  const folder = path.join(b.work, 'pi-folder');
  fs.mkdirSync(folder);
  const common = ['--harness', 'pi', '--folder', folder, '--bin', pi];
  const local = path.join(b.work, 'local.toml');
  // One launch through hs, run as a caller runs it, with a receipt where one is needed.
  const run = async (variant, layer) => {
    const from = hosts.length;
    fs.rmSync(probeOut, { force: true });
    fs.rmSync(undeclared, { force: true });
    const steps = [
      { when: { tool: TOOL }, reply: { tool_calls: [{ id: 'call_ping', name: TOOL, args: {} }] } },
      { when: { after_tool: 'call_ping' }, reply: { text: 'done' } },
    ];
    const L = await b.model('ENDPOINT', { markers: Object.values(M), steps, fallback: { text: 'done' } });
    put(local, `[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
    const args = [...common, '--layer', layer, '--local', local, '--headless'];
    const refused = b.hsCall('launch-spec', args);
    const items = refused.ok ? [] : refused.error.items ?? [];
    const receipt = path.join(b.work, `receipt-${variant}.json`);
    put(receipt, { format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((x) => x.item))], by: 'tier1-bench', at: new Date().toISOString() });
    const spec = refused.ok ? refused.result : b.hs('launch-spec', [...args, '--receipt', receipt]);
    const env = { ...spec.env_set, ...viaProxy };
    for (const [v, ref] of Object.entries(spec.env_from_refs)) {
      if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
      env[v] = DUMMY;
    }
    for (const v of spec.env_unset) env[v] = undefined;
    const before = names(folder);
    const r = await b.launch([L], [pi, ...spec.argv.slice(1), PROMPT], env, cwd);
    if (spec.temp_dir) fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    const seen = r.seen.ENDPOINT;
    const p = probe(probeOut);
    return {
      exit: r.exit, timed_out: r.timed_out, requests: seen.length,
      receipt_needed: !refused.ok && refused.error.code === 'receipt_required',
      plugin_item: spec.launch_items.find((i) => i.item === `plugin.${NAME}`)?.via ? 'carried' : spec.skipped.some((x) => x.item === `plugin.${NAME}`) ? 'skipped' : null,
      skill_reached: seen.some((q) => q.markers.includes(M.skill)),
      tools: [...new Set(seen.flatMap((q) => q.tools ?? []))].filter((t) => typeof t === 'string' && t.startsWith('mcp__')).sort(),
      tool_called: seen.some((q) => (q.tool_results ?? []).length > 0),
      server: p ? { started: p.started, args_expanded: p.args_expanded, data_expanded: p.data_expanded, env_names: p.env_names, root_matches: p.root_matches, data_exists: p.data_exists, data_writable: p.data_writable, data_matches: p.data_matches, cwd_is_root: p.cwd_is_root } : null,
      undeclared_loaded: fs.existsSync(undeclared),
      folder_added: names(folder).filter((n) => !before.includes(n) && !n.startsWith('sessions')),
      hosts: [...new Set(hosts.slice(from))].sort(),
    };
  };
  const serverOk = (r) => r.server?.started && r.server.args_expanded && r.server.data_expanded && r.server.root_matches && r.server.data_exists && r.server.data_writable && r.server.data_matches && r.server.cwd_is_root
    && JSON.stringify(r.server.env_names) === JSON.stringify(['PLUGIN_ROOT', 'PLUGIN_DATA']);

  const runs = {};
  runs.launch = await run('launch', kit);
  const v = b.hsCall('validate', [...common, '--layer', badKit]);
  const lr = b.hsCall('launch-spec', [...common, '--layer', badKit, '--headless']);
  runs.refused = { validate: v.ok ? (v.result.problems ?? []).filter((x) => x.severity === 'error').map((x) => x.code) : v.error.code, launch: lr.ok ? null : lr.error.code };

  const plan = b.hs('plan', [...common, '--layer', kit, '--owner', 'tier1', '--mode', 'materialize']);
  const planFile = path.join(b.work, 'plan.json');
  put(planFile, plan);
  const receiptFile = path.join(b.work, 'receipt-plan.json');
  put(receiptFile, { format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench', at: new Date().toISOString() });
  b.hs('apply', [...common, '--plan', planFile, '--receipt', receiptFile]);
  const planned = plan.operations.map((o) => o.address_id).sort();
  runs.bare = await run('bare', plain);
  runs.skipped = await run('skipped', kit);
  runs.strict = await run('strict', strictKit);
  const removed = b.hs('remove', [...common, '--owner', 'tier1']);
  runs.removed = await run('removed', plain);
  const dataDir = path.join(folder, 'hs-run', 'plugin-data', NAME);
  const dataKept = fs.existsSync(dataDir) && removed.plugin_data?.kept?.length === 1;
  const plan2 = b.hs('plan', [...common, '--layer', kit, '--owner', 'tier1', '--mode', 'materialize']);
  put(planFile, plan2);
  put(receiptFile, { format: 'hs-receipt/0.2', plan_digest: plan2.digest, allows: plan2.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench', at: new Date().toISOString() });
  b.hs('apply', [...common, '--plan', planFile, '--receipt', receiptFile]);
  const purged = b.hs('remove', [...common, '--owner', 'tier1', '--purge-data']);
  const dataPurged = !fs.existsSync(dataDir) && purged.plugin_data?.removed?.length === 1;
  proxy.close();
  proxy = null;

  const L = runs.launch;
  const B = runs.bare;
  const checks = {
    'launch: hs\'s launch needs a receipt, carries the plugin, and its skill reaches the model (premise)': L.receipt_needed && L.plugin_item === 'carried' && L.skill_reached,
    'launch: the server starts with the placeholders expanded, PLUGIN_ROOT and PLUGIN_DATA set, the data directory existing and writable, in the plugin root; its tool is offered and a call reaches it': serverOk(L) && L.tools.includes(TOOL) && L.tool_called,
    'launch: the package\'s undeclared extensions/ code does not load, and pi writes nothing into the folder beyond its own files': !L.undeclared_loaded && L.folder_added.every((n) => ['auth.json', 'models-store.json'].includes(n)),
    'refused: a server env holding $HOME is refused by validate (plugin_placeholder_literal) and by launch-spec': Array.isArray(runs.refused.validate) && runs.refused.validate.includes('plugin_placeholder_literal') && runs.refused.launch === 'spec_invalid',
    'bare: the plan writes the tree and the settings.json packages member; a start with no -e loads the skill and the server, its data in hs-run/plugin-data, and not the undeclared code': JSON.stringify(planned) === JSON.stringify([`hs-run/plugin.${NAME}`, `settings.json#packages[plugin.${NAME}]`]) && B.skill_reached && serverOk(B) && B.tools.includes(TOOL) && !B.undeclared_loaded,
    'skipped: hs\'s launch for the package after the plan skips it, and the skill and server still load from the folder': runs.skipped.plugin_item === 'skipped' && runs.skipped.skill_reached && runs.skipped.server?.started === true,
    'strict: under isolation = "strict" the installed plugin is named again, and its skill and server load, the tool offered once': runs.strict.plugin_item === 'carried' && runs.strict.skill_reached && runs.strict.server?.started === true && runs.strict.tools.filter((t) => t === TOOL).length === 1,
    'removed: after hs remove a start has neither skill nor server; the plugin data is kept, and remove --purge-data deletes it': !runs.removed.skill_reached && runs.removed.server === null && dataKept && dataPurged,
    'no host is asked for in any run': Object.values(runs).filter((r) => r.hosts).every((r) => r.hosts.length === 0),
  };
  const verdict = !checks[Object.keys(checks)[0]] ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: Agent Plugins packages on pi, translated into a pi package, at launch and under materialize (design note v0.2 §5.7, milestone 8.4)',
    at: new Date().toISOString(),
    evidence: evidence(b, pi),
    runs,
    recorded: { planned, removed_notes: removed.notes ?? [], purged_notes: purged.notes ?? [] },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>').split(proxyUrl).join('<PROXY>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 agent plugins on pi check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (proxy) proxy.close();
  if (!(await b.finish())) process.exitCode = 4;
}
