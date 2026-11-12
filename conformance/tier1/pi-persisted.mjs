#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §7.4, §7.5), on pi. It starts the real harness, so it runs
// only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/pi-persisted.mjs --pi <path> [--hs-rev <sha>] [--keep]
//
// A recording check ahead of `materialize` on pi (milestone 8.3): what a bare pi start reads from
// the folder's own files, the agent dir PI_CODING_AGENT_DIR [P15:configuration]: mcp.json's
// servers, skills/, settings.json's defaultProvider and defaultModel, and how a start treats those
// files. The model is a provider in the folder's models.json on the scripted endpoint
// (openai-completions), its key read from a variable holding a dummy: a stand-in for whatever
// provider the folder has, since hs never persists an endpoint. Each run has a folder of its own, a
// scratch HOME, and pi's network through a proxy that refuses every host. Runs:
//   control   the folder holds only models.json and settings.json (defaultProvider, defaultModel),
//             and the start passes no --provider or --model. Expected: the model is reached (the
//             premise: the folder's settings pick the model).
//   byhand    the same plus mcp.json with a stdio server (exposure "direct"), a skill under skills/,
//             and an AGENTS.md. Expected: the server starts and its tool is offered, and the skill and
//             AGENTS.md reach a request (the positive control).
//   writes    recorded: whether a start rewrites mcp.json, settings.json or models.json (their bytes)
//             and what it adds beside them, by name.
//   exposure  recorded: an mcp.json server with no exposure: the tools a request is offered.
//   driver    hs's own route (milestone 8.3): a layer holding the model bench/bench-primary, a stdio
//             MCP server (self-contained in its directory) and a skill, planned under materialize,
//             refused by `hs apply` with a receipt that allows nothing, applied with one, then a bare
//             start with no hs launch at all. Expected: the plan writes mcp.json's mcpServers.probe,
//             its copy in hs-run/, skills/notes and settings.json's defaultProvider and defaultModel;
//             the start reaches the model settings.json names, runs the server from its copy and
//             offers its tool, and loads the skill; hs's launch-spec for the same layer skips what the
//             plan installed; after `hs remove` a bare start offers no tool of the server and loads no
//             skill.
// Names, booleans and counts only. The credential is a dummy.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { serverSource } from '../lib/agent-plugins.mjs';
import { DUMMY, bench, evidence, guard } from '../lib/bench.mjs';

const pi = guard('pi-persisted.mjs', '--pi');
const PROMPT = 'tier 1 pi persisted check';
const M = { skill: 'hs-tier1-pip-skill-41ac', agents: 'hs-tier1-pip-agents-7d02', mcp: 'hs-tier1-pip-mcp-c93e' };
const KEY_VAR = 'HS_BENCH_PI_KEY';
const b = bench('hs-tier1-pi-persisted-');

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const skill = (name, mark) => `---\nname: ${name}\ndescription: ${mark}\n---\nA bench skill.\n`;
const names = (dir, depth = 3, rel = '') => {
  if (depth === 0 || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((n) => {
    const p = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    return fs.lstatSync(p).isDirectory() ? [r, ...names(p, depth - 1, r)] : [r];
  });
};
const digest = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
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
const probe = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

try {
  const hosts = [];
  const proxy = http.createServer((req, res) => {
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
  const env0 = { [KEY_VAR]: DUMMY, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const server = path.join(b.work, 'mcp-server.mjs');
  put(server, serverSource('ping', M.mcp));

  // The folder's own provider and model: a stand-in for the provider a user's folder has.
  const providerFiles = (folder, url) => {
    put(path.join(folder, 'models.json'), { providers: { bench: { baseUrl: `${url}/v1`, api: 'openai-completions', apiKey: `$${KEY_VAR}`, models: [{ id: 'bench-primary' }] } } });
    put(path.join(folder, 'settings.json'), { defaultProvider: 'bench', defaultModel: 'bench-primary' });
  };
  const run = async (variant, setup = () => {}, { settings = true } = {}) => {
    const from = hosts.length;
    const L = await b.model('ENDPOINT', { markers: Object.values(M), fallback: { text: 'done' } });
    const folder = path.join(b.work, `pi-${variant}`);
    fs.mkdirSync(folder, { recursive: true });
    if (settings) providerFiles(folder, L.url);
    // hs wrote the model into settings.json: only the provider is the folder's own here.
    else put(path.join(folder, 'models.json'), { providers: { bench: { baseUrl: `${L.url}/v1`, api: 'openai-completions', apiKey: `$${KEY_VAR}`, models: [{ id: 'bench-primary' }] } } });
    setup(folder);
    const files = ['mcp.json', 'settings.json', 'models.json'];
    const before = Object.fromEntries(files.map((f) => [f, digest(path.join(folder, f))]));
    const namesBefore = names(folder);
    const r = await b.launch([L], [pi, '--mode', 'json', PROMPT], { PI_CODING_AGENT_DIR: folder, ...env0 }, cwd);
    const seen = r.seen.ENDPOINT;
    return {
      exit: r.exit, timed_out: r.timed_out, requests: seen.length,
      credential: [...new Set(seen.map((q) => q.credential))],
      markers: Object.entries(M).filter(([, m]) => seen.some((q) => q.markers.includes(m))).map(([k]) => k).sort(),
      tools: [...new Set(seen.flatMap((q) => q.tools ?? []))].filter((t) => typeof t === 'string').sort(),
      rewritten: files.filter((f) => before[f] !== null && digest(path.join(folder, f)) !== before[f]),
      added: names(folder).filter((n) => !namesBefore.includes(n) && !n.startsWith('sessions/')),
      hosts: [...new Set(hosts.slice(from))].sort(),
    };
  };

  const runs = {};
  runs.control = await run('control');
  const byhandOut = path.join(b.work, 'probe-byhand.json');
  runs.byhand = await run('byhand', (folder) => {
    put(path.join(folder, 'mcp.json'), { mcpServers: { probe: { command: process.execPath, args: [server], env: { HS_PROBE_OUT: byhandOut }, exposure: 'direct' } } });
    put(path.join(folder, 'skills', 'notes', 'SKILL.md'), skill('notes', M.skill));
    put(path.join(folder, 'AGENTS.md'), `The folder's own. ${M.agents}\n`);
  });
  runs.byhand.probe = probe(byhandOut);
  const exposureOut = path.join(b.work, 'probe-exposure.json');
  runs.exposure = await run('exposure', (folder) => {
    put(path.join(folder, 'mcp.json'), { mcpServers: { probe: { command: process.execPath, args: [server], env: { HS_PROBE_OUT: exposureOut } } } });
  });
  runs.exposure.started = probe(exposureOut)?.started === true;

  // driver: hs's own plan and apply, then bare starts, before and after `hs remove`. Each start
  // writes its probe to a file of its own, so the second shows whether the server ran again.
  const kit = path.join(b.work, 'kit');
  const driverOut = path.join(b.work, 'probe-driver.json');
  put(path.join(kit, 'srv', 'server.mjs'), serverSource('ping', M.mcp));
  put(path.join(kit, 'skills', 'notes', 'SKILL.md'), skill('notes', M.skill));
  put(path.join(kit, 'spec.toml'), ['[spec]', 'name = "kit"', 'version = "1.0.0"', 'format = "0.2"', '',
    '[model.roles]', 'primary = "bench/bench-primary"', '',
    '[mcp.probe]', `exec = ${JSON.stringify(process.execPath)}`, 'args = ["srv/server.mjs"]', `env = { HS_PROBE_OUT = ${JSON.stringify(driverOut)} }`, 'self_contained = true', ''].join('\n'));
  const dFolder = path.join(b.work, 'pi-driver');
  fs.mkdirSync(dFolder, { recursive: true });
  const common = ['--harness', 'pi', '--folder', dFolder, '--bin', pi];
  const plan = b.hs('plan', [...common, '--layer', kit, '--owner', 'tier1', '--mode', 'materialize']);
  const planFile = path.join(b.work, 'plan.json');
  put(planFile, plan);
  const nothing = path.join(b.work, 'receipt-nothing.json');
  put(nothing, { format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: [], by: 'tier1-bench' });
  const refusedApply = b.hsCall('apply', [...common, '--plan', planFile, '--receipt', nothing]);
  const receiptFile = path.join(b.work, 'receipt.json');
  put(receiptFile, { format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench', at: new Date().toISOString() });
  b.hs('apply', [...common, '--plan', planFile, '--receipt', receiptFile]);
  const written = JSON.parse(fs.readFileSync(path.join(dFolder, 'mcp.json'), 'utf8')).mcpServers?.probe ?? null;
  runs.driver = await run('driver', () => {}, { settings: false });
  runs.driver.probe = probe(driverOut);
  runs.driver.plan = { operations: plan.operations.map((o) => o.address_id).sort(), refused_apply: refusedApply.ok ? null : refusedApply.error.code, server_from_copy: typeof written?.args?.[0] === 'string' && written.args[0].startsWith(path.join(dFolder, 'hs-run', 'mcp.probe') + path.sep) };
  const driverSpec = b.hsCall('launch-spec', [...common, '--layer', kit, '--headless']);
  runs.driver.launch_skipped = driverSpec.ok ? driverSpec.result.skipped.map((x) => x.item).sort() : [];
  b.hs('remove', [...common, '--owner', 'tier1']);
  // The probe file is the first start's; a start of the server after remove would write it again.
  const mtime = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : null);
  const before = mtime(driverOut);
  await new Promise((r) => setTimeout(r, 20));
  runs.removed = await run('driver', () => {}, { settings: false });
  runs.removed.server_started_again = mtime(driverOut) !== before;
  const left = benchPids();
  proxy.close();

  const C = runs.control;
  const B = runs.byhand;
  const checks = {
    'control: the folder\'s settings.json (defaultProvider, defaultModel) picks the model a bare start reaches, with the dummy key (premise)': C.requests > 0 && C.credential.length === 1 && C.credential[0] === 'bearer:bench-dummy',
    'byhand: a stdio server in the folder\'s mcp.json, exposure "direct", starts and its tool is offered as mcp__probe__ping': B.probe?.started === true && B.tools.includes('mcp__probe__ping'),
    'byhand: a skill in the folder\'s skills/ and its AGENTS.md reach a request': B.markers.includes('skill') && B.markers.includes('agents'),
    'driver: the plan writes mcp.json\'s mcpServers.probe, its copy in hs-run, the skill and settings.json\'s defaultProvider and defaultModel; apply refuses a receipt that allows nothing': JSON.stringify(runs.driver.plan.operations) === JSON.stringify(['hs-run/mcp.probe', 'mcp.json#mcpServers/probe', 'settings.json#defaultModel', 'settings.json#defaultProvider', 'skills/notes']) && runs.driver.plan.refused_apply === 'receipt_required',
    'driver: a bare start reaches the model settings.json names, runs the server from its copy in hs-run and offers its tool, and loads the skill': runs.driver.requests > 0 && runs.driver.plan.server_from_copy && runs.driver.probe?.started === true && runs.driver.tools.includes('mcp__probe__ping') && runs.driver.markers.includes('skill'),
    'driver: hs launch-spec for the same layer skips the server and the skill the plan installed': ['mcp.probe', 'skill.notes'].every((i) => runs.driver.launch_skipped.includes(i)),
    'driver: after hs remove, a bare start offers no tool of the server, does not start it, and loads no skill': runs.removed.requests > 0 && !runs.removed.tools.includes('mcp__probe__ping') && !runs.removed.markers.includes('skill') && runs.removed.server_started_again === false,
    'no host is asked for, and no process with the bench\'s environment is left': Object.values(runs).every((r) => r.hosts.length === 0) && left.length === 0,
  };
  const verdict = !checks[Object.keys(checks)[0]] ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: what a bare pi start reads from the folder\'s own files (design note v0.2 §7.4, §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, pi),
    runs,
    recorded: {
      rewritten: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, r.rewritten])),
      added: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, r.added])),
      exposure_default_tools: runs.exposure.tools, exposure_default_started: runs.exposure.started,
    },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>').split(proxyUrl).join('<PROXY>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 pi persisted check failed to run: ${e.message}\n`);
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
