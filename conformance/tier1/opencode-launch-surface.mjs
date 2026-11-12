#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §4, §8), on OpenCode. It starts the real harness, so it runs
// only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/opencode-launch-surface.mjs --opencode <path> [--opencode1 <path>] [--hs-rev <sha>] [--keep]
//
// A recording check ahead of an OpenCode driver: what a launch can carry, with no hs driver yet, so
// each launch is built here by hand as a driver would build it. OpenCode 2.x keeps its roots in the
// four XDG directories (packages/util/src/global-roots.ts, tag v2.2.7), reads an inline config layer
// from OPENCODE_CONFIG_CONTENT (packages/core/src/config.ts) and an extra config directory from
// OPENCODE_CONFIG_DIR (packages/cli/src/server-process.ts). Its CLI talks to a server: "A one-off
// run uses the background service when it is already up, but never leaves a new one running"
// (packages/cli/src/commands/handlers/run.ts); clients find the service "at its registration under
// XDG_STATE_HOME" (packages/cli/src/services/service-config.ts); `--standalone` runs "with a
// private server instead of the background service" (`run --help`). Every run has a data folder of
// its own holding config/, data/, cache/ and state/, with the four XDG variables pointed there, the
// Claude Code and external-skill switches on (OPENCODE_DISABLE_CLAUDE_CODE,
// OPENCODE_DISABLE_EXTERNAL_SKILLS), a scratch HOME holding canaries, and a scripted model on the
// OpenAI Chat wire with no script, which records names and markers and answers 400. The provider is
// a 2.x `providers` entry (`package` @opencode/ai/providers/openai-compatible, `settings.baseURL`,
// the key named in `env`, a dummy value). Runs:
//   control      the provider and model through OPENCODE_CONFIG_CONTENT, `run --standalone`.
//                Expected: a request reaches the model, for the configured model, with the dummy key
//                (the premise, and the positive control for the provider route).
//   config_dir   OPENCODE_CONFIG_DIR holding an AGENTS.md and a skill, and a global AGENTS.md in the
//                folder's XDG config. Expected: the directory's AGENTS.md and the skill reach a
//                request. Recorded: whether the global AGENTS.md does too.
//   mcp          a local MCP server in OPENCODE_CONFIG_CONTENT (`mcp.servers`). Expected: it starts.
//                Recorded: whether its tool's marker reaches a request (2.x offers MCP tools through
//                Code Mode by default).
//   service      a background service started in one folder with its own config (`opencode service
//                start`), then three runs: in that folder without --standalone, with --standalone,
//                and in another folder without it. Expected: the first attaches and runs on the
//                service's config, not the launch's (the premise for a driver passing --standalone);
//                the second and third run on the launch's config. Then `opencode service stop`.
//                Expected: no process with the bench's environment is left.
//   v1           with --opencode1, the 1.x line: its version, whether `run --help` offers
//                --standalone, and whether a launch with the 2.x config reaches the model.
// Recorded for every run: which canaries reach a request (~/.claude/CLAUDE.md, ~/.agents/skills,
// ~/.opencode/skills, an AGENTS.md above the working directory), and what OpenCode writes in the
// folder, in OPENCODE_CONFIG_DIR and in HOME (names only). The credential is a dummy.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DUMMY, arg, bench, evidence, guard } from '../lib/bench.mjs';
import { probe, serverSource } from '../lib/agent-plugins.mjs';

const oc = guard('opencode-launch-surface.mjs', '--opencode');
const oc1 = arg('--opencode1');
const PROMPT = 'tier 1 OpenCode launch surface check';
const KEY = 'HS_BENCH_OC_KEY';
const TOOL = 'hs_oc_tool';
const M = {
  agents: 'hs-tier1-oc-agents-3f1a', global: 'hs-tier1-oc-global-9b2c', skill: 'hs-tier1-oc-skill-6d4e', tool: 'hs-tier1-oc-tool-1c7b',
  claude: 'hs-tier1-oc-claude-2e8f', agentsDir: 'hs-tier1-oc-agentsdir-5a3d', dotOpencode: 'hs-tier1-oc-dotoc-7c9e', ancestor: 'hs-tier1-oc-ancestor-4b6a',
};
const CANARIES = { claude_md: M.claude, agents_skills: M.agentsDir, dot_opencode_skills: M.dotOpencode, ancestor_agents_md: M.ancestor };
const b = bench('hs-tier1-opencode-');

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const skill = (name, mark) => `---\nname: ${name}\ndescription: ${mark}\n---\nA bench skill.\n`;
// Names under a directory, `depth` levels deep, relative to it.
const names = (dir, depth = 3, rel = '') => {
  if (depth === 0 || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((n) => {
    const p = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    return fs.lstatSync(p).isDirectory() ? [r, ...names(p, depth - 1, r)] : [r];
  });
};
// Pids of processes whose environment carries the bench's work dir (Linux), never this one.
const benchPids = () => {
  if (!fs.existsSync('/proc')) return [];
  return fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid).filter((p) => {
    try {
      return fs.readFileSync(`/proc/${p}/environ`, 'latin1').includes(b.work);
    } catch {
      return false;
    }
  }).map(Number);
};

try {
  const L = await b.model('ENDPOINT', { markers: Object.values(M) });
  const work = path.join(b.work, 'work');
  const cwd = path.join(work, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const probeOut = path.join(b.work, 'probe');
  const server = path.join(b.work, 'srv', 'server.mjs');
  put(server, serverSource(TOOL, M.tool));

  // Canaries a bound launch should not read: in HOME, and an AGENTS.md above the working directory.
  const H = b.scratch.HOME;
  put(path.join(H, '.claude', 'CLAUDE.md'), `Bench instructions. ${M.claude}\n`);
  put(path.join(H, '.agents', 'skills', 'canary-a', 'SKILL.md'), skill('canary-a', M.agentsDir));
  put(path.join(H, '.opencode', 'skills', 'canary-o', 'SKILL.md'), skill('canary-o', M.dotOpencode));
  put(path.join(work, 'AGENTS.md'), `Bench ancestor instructions. ${M.ancestor}\n`);
  const homeBefore = names(H, 2);

  const config = (model, extra = {}) => JSON.stringify({
    providers: { bench: { name: 'Bench', env: [KEY], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `${L.url}/v1` },
      models: { 'bench-primary': { name: 'Bench primary' }, 'bench-service': { name: 'Bench service' } } } },
    model: `bench/${model}`,
    ...extra,
  });
  const folderFor = (variant) => {
    const f = path.join(b.work, `oc-${variant}`);
    for (const r of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(f, r), { recursive: true });
    return f;
  };
  const envFor = (folder, extra = {}) => ({
    XDG_CONFIG_HOME: path.join(folder, 'config'), XDG_DATA_HOME: path.join(folder, 'data'),
    XDG_CACHE_HOME: path.join(folder, 'cache'), XDG_STATE_HOME: path.join(folder, 'state'),
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    [KEY]: DUMMY, ...extra,
  });
  const run = async (bin, folder, { standalone = true, extra = {} } = {}) => {
    fs.rmSync(probeOut, { force: true });
    const argv = [bin, 'run', ...(standalone ? ['--standalone'] : []), '--format', 'json', PROMPT];
    const r = await b.launch([L], argv, envFor(folder, extra), cwd);
    return { ...r, probe: probe(probeOut) };
  };
  const cli = (bin, folder, args, extra = {}) => {
    const p = spawnSync(bin, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...b.scratch, ...envFor(folder, extra) }, timeout: 120_000 });
    return { exit: p.status, printed: (p.stdout ?? '').trim().length > 0 };
  };
  const has = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  const models = (r) => [...new Set(r.seen.ENDPOINT.map((q) => q.model))].sort();
  const canaries = (r) => Object.fromEntries(Object.entries(CANARIES).map(([k, m]) => [k, has(r, m)]));
  const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: r.seen.ENDPOINT.length,
    wires: [...new Set(r.seen.ENDPOINT.map((q) => q.wire))].sort(), models: models(r), credentials: [...new Set(r.seen.ENDPOINT.map((q) => q.credential))].sort(),
    markers: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.markers))].sort(), canaries: canaries(r), server_started: r.probe?.started === true });

  // control: the provider route.
  const controlFolder = folderFor('control');
  const control = await run(oc, controlFolder, { extra: { OPENCODE_CONFIG_CONTENT: config('bench-primary') } });

  // config_dir: an extra directory, and a global AGENTS.md beneath it.
  const dirFolder = folderFor('config-dir');
  put(path.join(dirFolder, 'config', 'opencode', 'AGENTS.md'), `Bench global instructions. ${M.global}\n`);
  const configDir = path.join(b.work, 'config-dir');
  put(path.join(configDir, 'AGENTS.md'), `Bench launch instructions. ${M.agents}\n`);
  put(path.join(configDir, 'skills', 'notes', 'SKILL.md'), skill('notes', M.skill));
  const configDirBefore = names(configDir);
  const dir = await run(oc, dirFolder, { extra: { OPENCODE_CONFIG_CONTENT: config('bench-primary'), OPENCODE_CONFIG_DIR: configDir } });

  // mcp: a local server in the inline layer.
  const mcpFolder = folderFor('mcp');
  const mcp = await run(oc, mcpFolder, { extra: { OPENCODE_CONFIG_CONTENT: config('bench-primary', { mcp: { servers: { probe: { type: 'local', command: [process.execPath, server], environment: { HS_PROBE_OUT: probeOut } } } } }) } });

  // service: a background service in one folder, on its own config.
  const svcFolder = folderFor('service');
  const svcEnv = { OPENCODE_CONFIG_CONTENT: config('bench-service') };
  const svcStart = cli(oc, svcFolder, ['service', 'start'], svcEnv);
  const svcRegistration = names(path.join(svcFolder, 'state'));
  const attached = await run(oc, svcFolder, { standalone: false, extra: { OPENCODE_CONFIG_CONTENT: config('bench-primary') } });
  const standalone = await run(oc, svcFolder, { standalone: true, extra: { OPENCODE_CONFIG_CONTENT: config('bench-primary') } });
  const otherFolder = folderFor('other');
  const other = await run(oc, otherFolder, { standalone: false, extra: { OPENCODE_CONFIG_CONTENT: config('bench-primary') } });
  const otherLeft = benchPids().length;
  const svcStop = cli(oc, svcFolder, ['service', 'stop'], svcEnv);
  await new Promise((r) => setTimeout(r, 2000));
  const left = benchPids();
  for (const p of left) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // gone
    }
  }

  // v1: the 1.x line, out of range.
  let v1 = null;
  if (oc1) {
    const v1Folder = folderFor('v1');
    const help = spawnSync(oc1, ['run', '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...b.scratch, ...envFor(v1Folder) }, timeout: 60_000 });
    const r = await run(oc1, v1Folder, { standalone: false, extra: { OPENCODE_CONFIG_CONTENT: config('bench-primary') } });
    v1 = { version: b.version(oc1), run_offers_standalone: /--standalone/.test(`${help.stdout}${help.stderr}`), launch_with_2x_config: shape(r) };
  }

  const checks = {
    'control: the provider and model through OPENCODE_CONFIG_CONTENT reach the model, with the dummy key (premise)': control.seen.ENDPOINT.length > 0 && models(control).every((m) => m === 'bench-primary') && control.seen.ENDPOINT.every((q) => q.credential === 'bench-dummy'),
    'config_dir: OPENCODE_CONFIG_DIR\'s AGENTS.md and skill reach a request': has(dir, M.agents) && has(dir, M.skill),
    'mcp: a local server in OPENCODE_CONFIG_CONTENT starts': mcp.probe?.started === true,
    'service: started in the folder with its own config': svcStart.exit === 0,
    'service: a run without --standalone attaches to the folder\'s service and runs on its config, not the launch\'s (premise for --standalone)': attached.seen.ENDPOINT.length > 0 && models(attached).every((m) => m === 'bench-service'),
    'service: with --standalone the run uses the launch\'s config': standalone.seen.ENDPOINT.length > 0 && models(standalone).every((m) => m === 'bench-primary'),
    'service: a run in another folder never reaches this folder\'s service': other.seen.ENDPOINT.length > 0 && models(other).every((m) => m === 'bench-primary'),
    'service: after `service stop` no process with the bench\'s environment is left': svcStop.exit === 0 && left.length === 0,
  };
  const recorded = {
    global_agents_md_with_config_dir: has(dir, M.global),
    mcp_tool_marker: has(mcp, M.tool),
    canaries: { control: canaries(control), config_dir: canaries(dir), mcp: canaries(mcp) },
    writes: {
      folder_after_control: names(controlFolder, 3),
      config_dir_added: names(configDir).filter((n) => !configDirBefore.includes(n)),
      home_added: names(H, 2).filter((n) => !homeBefore.includes(n)),
      service_state: svcRegistration,
    },
    service: { start: svcStart, stop: svcStop, processes_while_running: otherLeft, left_after_stop: left.length },
    v1,
  };
  const reached = [control, dir, mcp, attached, standalone, other].every((r) => r.seen.ENDPOINT.length > 0);
  const premise = Object.keys(checks)[0];
  const verdict = !checks[premise] ? 'inconclusive: the provider route did not reach the model' : !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: what an OpenCode launch can carry, and whether a run attaches to a background service (design note v0.2 §4, §8)',
    at: new Date().toISOString(),
    evidence: evidence(b, oc),
    runs: { control: shape(control), config_dir: shape(dir), mcp: shape(mcp), attached: shape(attached), standalone: shape(standalone), other: shape(other) },
    recorded,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 OpenCode launch surface check failed to run: ${e.message}\n`);
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
