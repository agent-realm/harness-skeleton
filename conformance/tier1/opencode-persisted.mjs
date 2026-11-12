#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §7.4, §7.5), on OpenCode. It starts the real harness, so it
// runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/opencode-persisted.mjs --opencode <path> [--hs-rev <sha>] [--keep]
//
// A recording check ahead of `materialize` on OpenCode (milestone 7.2): what a data folder's own
// config directory, config/opencode/ (the XDG config root, packages/util/src/global-roots.ts at tag
// v2.2.7), gives a start that hs launches for a plain layer, and how OpenCode treats that directory.
// Each run has a folder of its own; the start is hs's own launch-spec for a layer holding only the
// endpoint and the model (the endpoint never persists, so a start always comes through hs), against
// a scripted model on the OpenAI Chat wire, with a dummy key. Runs:
//   control         an empty folder. Expected: a request reaches the model, no marker (the premise).
//   byhand          the folder's config/opencode/ holding opencode.json with a local MCP server under
//                   mcp.servers, a skill under skills/, and an AGENTS.md. Expected: the skill and
//                   AGENTS.md reach a request and the server starts (the positive control): the
//                   launch's inline layer keeps what the folder's config holds.
//   writes          recorded: whether a start rewrites opencode.json (its bytes, its keys) and what it
//                   adds under config/opencode/, by name.
//   jsonc           recorded: with opencode.json and opencode.jsonc both defining server `probe`, each
//                   with a tool of its own marker, which one a start loads.
//   service_reload  recorded: a background service started in the folder (as a user's own start leaves
//                   one), then AGENTS.md rewritten with a new marker and a run attached to the service
//                   without --standalone: whether the service picks up the change without a restart.
//                   Then `service stop`. Expected: no process left.
//   driver          hs's own route (milestone 7.2): a layer holding a stdio MCP server (self-contained
//                   in its directory) and a skill, planned under materialize, refused by `hs apply`
//                   with a receipt that allows nothing, applied with one, then a start through hs's
//                   launch for the plain layer. Expected: the plan writes opencode.json's
//                   mcp.servers.probe, the copy hs-run/mcp.probe and config/opencode/skills/notes; the
//                   start loads the skill and runs the server from its copy; hs's launch-spec for the
//                   same layer skips both.
//   removed         `hs remove`, then a start. Expected: neither the skill nor the server.
// Names and booleans only. The credential is a dummy; HOME and XDG are scratch.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DUMMY, REF_VAR, bench, evidence, guard } from '../lib/bench.mjs';
import { probe, serverSource } from '../lib/agent-plugins.mjs';

const oc = guard('opencode-persisted.mjs', '--opencode');
const PROMPT = 'tier 1 OpenCode persisted check';
const M = { skill: 'hs-tier1-ocp-skill-3a9d', agents: 'hs-tier1-ocp-agents-7c1e', agents2: 'hs-tier1-ocp-agents2-5f02', toolJson: 'hs-tier1-ocp-json-8b4c', toolJsonc: 'hs-tier1-ocp-jsonc-2d6f', tool: 'hs-tier1-ocp-tool-9e3b' };
const b = bench('hs-tier1-opencode-persisted-');

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const names = (dir, depth = 3, rel = '') => {
  if (depth === 0 || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((n) => {
    const p = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    return fs.lstatSync(p).isDirectory() ? [r, ...names(p, depth - 1, r)] : [r];
  });
};
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
const benchPids = () => {
  if (!fs.existsSync('/proc')) return [];
  return fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid).filter((p) => {
    try {
      return fs.readFileSync(`/proc/${p}/environ`, 'latin1').includes(`${b.work}/`);
    } catch {
      return false;
    }
  }).map(Number);
};

try {
  const L = await b.model('ENDPOINT', { markers: Object.values(M) });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const probeOut = path.join(b.work, 'probe');
  const serverFor = (mark) => {
    const f = path.join(b.work, 'srv', `server-${mark}.mjs`);
    put(f, serverSource('hs_ocp_tool', mark));
    return f;
  };
  const plain = path.join(b.work, 'plain');
  put(path.join(plain, 'spec.toml'), '[spec]\nname = "plain"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');
  const local = path.join(b.work, 'local.toml');
  put(local, `[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const folderFor = (variant) => {
    const f = path.join(b.work, `oc-${variant}`);
    for (const r of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(f, r), { recursive: true });
    return f;
  };
  const cfg = (folder) => path.join(folder, 'config', 'opencode');
  // hs's own launch for the plain layer, run as a caller runs it.
  const run = async (folder) => {
    fs.rmSync(probeOut, { force: true });
    const spec = b.hs('launch-spec', ['--harness', 'opencode', '--folder', folder, '--layer', plain, '--local', local, '--bin', oc, '--headless']);
    const env = { ...spec.env_set };
    for (const [v, ref] of Object.entries(spec.env_from_refs)) {
      if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
      env[v] = DUMMY;
    }
    for (const v of spec.env_unset) env[v] = undefined;
    const r = await b.launch([L], [oc, ...spec.argv.slice(1), PROMPT], env, cwd);
    return { ...r, probe: probe(probeOut) };
  };
  const has = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  const shape = (r) => ({ exit: r.exit, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: r.seen.ENDPOINT.length,
    models: [...new Set(r.seen.ENDPOINT.map((q) => q.model))].sort(), markers: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.markers))].sort(), server_started: r.probe?.started === true });
  const localServer = (mark) => ({ type: 'local', command: [process.execPath, serverFor(mark)], environment: { HS_PROBE_OUT: probeOut } });

  const control = await run(folderFor('control'));

  // byhand, and what a start writes.
  const byFolder = folderFor('byhand');
  put(path.join(cfg(byFolder), 'opencode.json'), { mcp: { servers: { probe: localServer(M.tool) } } });
  put(path.join(cfg(byFolder), 'skills', 'notes', 'SKILL.md'), `---\nname: notes\ndescription: ${M.skill}\n---\nA bench skill.\n`);
  put(path.join(cfg(byFolder), 'AGENTS.md'), `Folder instructions. ${M.agents}\n`);
  const jsonFile = path.join(cfg(byFolder), 'opencode.json');
  const before = { sha: sha(jsonFile), keys: Object.keys(JSON.parse(fs.readFileSync(jsonFile, 'utf8'))).sort(), names: names(cfg(byFolder)) };
  const byhand = await run(byFolder);
  let afterKeys = null;
  try {
    afterKeys = Object.keys(JSON.parse(fs.readFileSync(jsonFile, 'utf8'))).sort();
  } catch {
    afterKeys = 'not JSON';
  }
  const writes = { rewritten: sha(jsonFile) !== before.sha, keys_before: before.keys, keys_after: afterKeys, added: names(cfg(byFolder)).filter((n) => !before.names.includes(n)) };

  // jsonc: both files define server `probe`.
  const jFolder = folderFor('jsonc');
  put(path.join(cfg(jFolder), 'opencode.json'), { mcp: { servers: { probe: localServer(M.toolJson) } } });
  put(path.join(cfg(jFolder), 'opencode.jsonc'), `// a comment\n${JSON.stringify({ mcp: { servers: { probe: localServer(M.toolJsonc) } } }, null, 2)}\n`);
  const jsonc = await run(jFolder);

  // service_reload: a service up in the folder, then AGENTS.md rewritten, then an attached run.
  const sFolder = folderFor('service');
  put(path.join(cfg(sFolder), 'AGENTS.md'), `Folder instructions. ${M.agents}\n`);
  const content = JSON.stringify({ providers: { bench: { name: 'Bench', env: ['HS_BENCH_OC_KEY'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `${L.url}/v1` }, models: { 'bench-primary': { name: 'Bench primary' } } } }, model: 'bench/bench-primary' });
  const sEnv = {
    XDG_CONFIG_HOME: path.join(sFolder, 'config'), XDG_DATA_HOME: path.join(sFolder, 'data'), XDG_CACHE_HOME: path.join(sFolder, 'cache'), XDG_STATE_HOME: path.join(sFolder, 'state'),
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_CONFIG_CONTENT: content, HS_BENCH_OC_KEY: DUMMY,
  };
  const cli = (args) => spawnSync(oc, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...b.scratch, ...sEnv }, timeout: 120_000 }).status;
  const svcStart = cli(['service', 'start']);
  const attachedBefore = await b.launch([L], [oc, 'run', '--format', 'json', PROMPT], sEnv, cwd);
  put(path.join(cfg(sFolder), 'AGENTS.md'), `Folder instructions, changed. ${M.agents2}\n`);
  await new Promise((r) => setTimeout(r, 3000));
  const attachedAfter = await b.launch([L], [oc, 'run', '--format', 'json', PROMPT], sEnv, cwd);
  const svcStop = cli(['service', 'stop']);
  await new Promise((r) => setTimeout(r, 2000));
  const left = benchPids();

  // driver: hs's own plan, apply, and a start through hs's launch for the plain layer.
  const kit = path.join(b.work, 'kit');
  put(path.join(kit, 'srv', 'server.mjs'), serverSource('hs_ocp_tool', M.tool));
  put(path.join(kit, 'skills', 'notes', 'SKILL.md'), `---\nname: notes\ndescription: ${M.skill}\n---\nA bench skill.\n`);
  put(path.join(kit, 'spec.toml'), ['[spec]', 'name = "kit"', 'version = "1.0.0"', 'format = "0.2"', '',
    '[mcp.probe]', `exec = ${JSON.stringify(process.execPath)}`, 'args = ["srv/server.mjs"]', `env = { HS_PROBE_OUT = ${JSON.stringify(probeOut)} }`, 'self_contained = true', ''].join('\n'));
  const dFolder = folderFor('driver');
  const common = ['--harness', 'opencode', '--folder', dFolder, '--bin', oc];
  const plan = b.hs('plan', [...common, '--layer', kit, '--owner', 'tier1', '--mode', 'materialize']);
  const planFile = path.join(b.work, 'plan.json');
  put(planFile, plan);
  const nothing = path.join(b.work, 'receipt-nothing.json');
  put(nothing, { format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: [], by: 'tier1-bench' });
  const refusedApply = b.hsCall('apply', [...common, '--plan', planFile, '--receipt', nothing]);
  const receiptFile = path.join(b.work, 'receipt.json');
  put(receiptFile, { format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench', at: new Date().toISOString() });
  b.hs('apply', [...common, '--plan', planFile, '--receipt', receiptFile]);
  const driverOps = plan.operations.map((o) => o.address_id).sort();
  const driver = await run(dFolder);
  const driverSpec = b.hs('launch-spec', [...common, '--layer', kit, '--headless']);
  b.hs('remove', [...common, '--owner', 'tier1']);
  const removed = await run(dFolder);

  const checks = {
    'driver: the plan writes mcp.servers.probe, its copy in hs-run and the skill, and apply refuses a receipt that allows nothing': JSON.stringify(driverOps) === JSON.stringify(['config/opencode/opencode.json#mcp/servers/probe', 'config/opencode/skills/notes', 'hs-run/mcp.probe'].sort()) && !refusedApply.ok && refusedApply.error.code === 'receipt_required',
    'driver: a start through hs\'s launch loads the skill and runs the server from its copy': has(driver, M.skill) && driver.probe?.started === true && has(driver, M.tool),
    'driver: hs launch-spec for the same layer skips both': ['mcp.probe', 'skill.notes'].every((id) => driverSpec.skipped.some((x) => x.item === id)) && driverSpec.env_set.OPENCODE_CONFIG_CONTENT === undefined,
    'removed: after hs remove a start has neither': removed.seen.ENDPOINT.length > 0 && !has(removed, M.skill) && removed.probe === null,
    'control: hs\'s launch for a plain layer reaches the model, with no marker (premise)': control.seen.ENDPOINT.length > 0 && !Object.values(M).some((m) => has(control, m)),
    'byhand: the folder\'s config/opencode/ gives a start its skill, AGENTS.md and MCP server, under hs\'s inline layer (positive control)': has(byhand, M.skill) && has(byhand, M.agents) && byhand.probe?.started === true,
    'service_reload: the service starts, and after `service stop` no process with the bench\'s environment is left': svcStart === 0 && svcStop === 0 && left.length === 0,
  };
  const recorded = {
    writes,
    jsonc: { json_tool: has(jsonc, M.toolJson), jsonc_tool: has(jsonc, M.toolJsonc) },
    service_reload: { attached_before: { old: has(attachedBefore, M.agents), requests: attachedBefore.seen.ENDPOINT.length }, attached_after: { old: has(attachedAfter, M.agents), new: has(attachedAfter, M.agents2), requests: attachedAfter.seen.ENDPOINT.length } },
  };
  const positive = Object.keys(checks)[1];
  const verdict = !checks[Object.keys(checks)[0]] ? 'inconclusive: the premise failed' : !checks[positive] ? 'inconclusive: the positive control did not load' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: what a data folder\'s own config directory gives an OpenCode start, and how OpenCode treats it (design note v0.2 §7.4, §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, oc),
    runs: { control: shape(control), byhand: shape(byhand), jsonc: shape(jsonc), attached_before: shape(attachedBefore), attached_after: shape(attachedAfter), driver: shape(driver), removed: shape(removed) },
    recorded,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 OpenCode persisted check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  for (const p of benchPids()) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // gone
    }
  }
  if (!(await b.finish())) process.exitCode = 4;
}
