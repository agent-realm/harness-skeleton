#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.7, §10), on Codex. It starts the real harness, so it
// runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/agent-plugins-codex.mjs --codex <path> [--hs-rev <sha>] [--keep]
//
// Codex reads an Agent Plugins 1.0.0 package natively (§12 row 35). No hs code delivers plugins
// yet: the check installs each package the way a user does, with `codex plugin marketplace add
// <dir>` and `codex plugin add <plugin>@<marketplace>`, into a data folder of its own, and starts
// `codex exec` from hs's launch-spec for a plain layer (endpoint and model only) against a scripted
// model with no script, which records markers and answers 400. The packages (lib/agent-plugins.mjs):
// `clean` (one valid skill; one stdio server whose args use ${PLUGIN_ROOT} and whose env uses
// ${PLUGIN_DATA}), `future` (the same, with only its two $schema values naming 9.9.9), and `mixed`
// (`clean` plus a skill without the description the Agent Skills specification requires), and
// `literal` (`clean` plus text the format keeps literal, in a stdio server's env and in a remote
// server's header). Runs:
//   control  no plugin. Expected: no marker reaches a request (the premise).
//   clean    Expected: the install succeeds; the skill reaches the request as <plugin>:notes, with
//            its description; the server starts with both placeholders expanded, PLUGIN_ROOT and
//            PLUGIN_DATA in its environment, in the plugin root; its tool reaches the request.
//   future   Expected: `codex plugin add` refuses it. Written into the folder the way the install
//            writes (the cache directory and the [plugins] table), it still loads nothing: no
//            marker, no server, while `clean` loaded.
//   mixed    Expected: the valid skill's name and marker reach the request; the invalid skill's
//            reach none.
//   literal  with HS_BENCH_OTHER set in Codex's environment. Expected: the stdio server's env and
//            the remote server's header both arrive as written, unexpanded [AP §9.2].
// The model and the server record names and booleans only. The credential is a dummy; HOME and XDG
// are scratch.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';
import { LITERAL_MARKERS, OTHER, OTHER_VALUE, literalOpts, probe, writePackage } from '../lib/agent-plugins.mjs';

const codex = guard('agent-plugins-codex.mjs', '--codex');
const PROMPT = 'tier 1 Agent Plugins check on Codex';
const TOOL = 'hs_plugin_tool';
const NAME = 'hs-bench-plugin';
const M = { skill: 'hs-tier1-ap-skill-4d1a', invalid: 'hs-tier1-ap-nodesc-8e3c', tool: 'hs-tier1-ap-tool-2b7f' };
const b = bench('hs-tier1-agent-plugins-cx-');

const markers = [M.skill, M.invalid, M.tool, `${NAME}:notes`, `${NAME}:no-desc`, 'mcp__probe'];
const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: r.seen.ENDPOINT.length,
  markers: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.markers))].sort(), remote: [...new Set(r.seen.REMOTE.flatMap((q) => q.markers))].sort() });

try {
  const L = await b.model('ENDPOINT', { markers });
  const R = await b.listener('REMOTE', { markers: LITERAL_MARKERS });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const plain = path.join(b.work, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'spec.toml'), '[spec]\nname = "plain"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[endpoints.openai-responses]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const probeOut = path.join(b.work, 'probe');

  // A marketplace of one package, at <dir>/.agents/plugins/marketplace.json, its source `./<name>`.
  const market = (variant, opts) => {
    const dir = path.join(b.work, 'markets', variant);
    writePackage(path.join(dir, NAME), { name: NAME, tool: TOOL, probeOut, ...opts });
    fs.mkdirSync(path.join(dir, '.agents', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: `hs-bench-${variant}`, plugins: [{ name: NAME, source: `./${NAME}` }] }, null, 2) + '\n');
    return { dir, name: `hs-bench-${variant}` };
  };
  // A data folder of its own per run, so no run sees another's plugins.
  const folderFor = (variant) => {
    const f = path.join(b.work, `codex-home-${variant}`);
    fs.mkdirSync(f);
    return f;
  };
  // The install commands, as a user runs them: exit code, and whether stderr names the manifest.
  const cli = (folder, args) => {
    const p = spawnSync(codex, ['plugin', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...b.scratch, CODEX_HOME: folder }, timeout: 120_000 });
    return { exit: p.status, names_manifest: /plugin\.json/.test(`${p.stderr}${p.stdout}`) };
  };
  const install = (folder, m) => ({ marketplace_add: cli(folder, ['marketplace', 'add', m.dir]), plugin_add: cli(folder, ['add', `${NAME}@${m.name}`]) });
  const run = async (folder, extraEnv = {}) => {
    fs.rmSync(probeOut, { force: true });
    const spec = b.hs('launch-spec', ['--harness', 'codex', '--folder', folder, '--layer', plain, '--local', local, '--bin', codex, '--headless']);
    const l = fromSpec(spec, extraEnv, codex, ['--skip-git-repo-check', PROMPT]);
    const r = await b.launch([L, R], l.argv, l.env, cwd);
    return { ...r, probe: probe(probeOut) };
  };

  const control = await run(folderFor('control'));

  const cleanFolder = folderFor('clean');
  const cleanInstall = install(cleanFolder, market('clean', { marks: { skill: M.skill, tool: M.tool } }));
  const clean = await run(cleanFolder);
  const dataDir = path.join(cleanFolder, 'plugins', 'data', 'agent-plugins');
  const cleanData = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).length : 0;

  const futureFolder = folderFor('future');
  const futureMarket = market('future', { version: '9.9.9', marks: { skill: M.skill, tool: M.tool } });
  const futureInstall = install(futureFolder, futureMarket);
  // What the install writes for a package it accepts (the cache directory and the [plugins] table),
  // written by hand, so the launch shows what the loader does with the package.
  const futureCache = path.join(futureFolder, 'plugins', 'cache', futureMarket.name, NAME, '1.0.0');
  const futureWritten = !fs.existsSync(futureCache);
  if (futureWritten) {
    fs.cpSync(path.join(futureMarket.dir, NAME), futureCache, { recursive: true });
    fs.appendFileSync(path.join(futureFolder, 'config.toml'), `\n[plugins."${NAME}@${futureMarket.name}"]\nenabled = true\n`);
  }
  const future = await run(futureFolder);

  const mixedFolder = folderFor('mixed');
  const mixedInstall = install(mixedFolder, market('mixed', { marks: M }));
  const mixed = await run(mixedFolder);

  const literalFolder = folderFor('literal');
  const literalInstall = install(literalFolder, market('literal', { marks: { skill: M.skill, tool: M.tool }, ...literalOpts(`${R.url}/mcp`) }));
  const lit = await run(literalFolder, { [OTHER]: OTHER_VALUE });

  const has = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  const loaded = (r, skill, mark) => has(r, `${NAME}:${skill}`) || has(r, mark);
  const any = (r) => markers.some((m) => has(r, m));
  const p = clean.probe;
  const checks = {
    'without a plugin no marker reaches a request (premise)': control.seen.ENDPOINT.length > 0 && !any(control),
    'clean: marketplace add and plugin add succeed': cleanInstall.marketplace_add.exit === 0 && cleanInstall.plugin_add.exit === 0,
    'clean: the skill reaches the request as <plugin>:notes, with its description': has(clean, `${NAME}:notes`) && has(clean, M.skill),
    'clean: the server starts with ${PLUGIN_ROOT} expanded in args': p?.args_expanded === true,
    'clean: ${PLUGIN_DATA} is expanded in env': p?.data_expanded === true,
    'clean: PLUGIN_ROOT and PLUGIN_DATA are in the server\'s environment': ['PLUGIN_ROOT', 'PLUGIN_DATA'].every((k) => p?.env_names?.includes(k)),
    'clean: the server runs in the plugin root': p?.cwd_is_root === true,
    'clean: the server\'s tool reaches the request': has(clean, M.tool),
    'future (9.9.9): plugin add refuses it': futureInstall.plugin_add.exit !== 0,
    'future (9.9.9): written as an install writes, it loads nothing, while clean loaded': futureWritten && !any(future) && future.probe === null && has(clean, M.skill),
    'mixed: the valid skill\'s name and marker reach the request': has(mixed, `${NAME}:notes`) && has(mixed, M.skill),
    'mixed: the invalid skill\'s name and marker reach none': !loaded(mixed, 'no-desc', M.invalid),
    'literal: the install succeeds and the stdio server starts': literalInstall.plugin_add.exit === 0 && lit.probe?.started === true,
    'literal: the env text reaches the stdio server unexpanded': lit.probe?.literal_kept === true,
    'literal: the header text reaches the remote server unexpanded': lit.seen.REMOTE.some((q) => q.markers.includes(LITERAL_MARKERS[0])) && !lit.seen.REMOTE.some((q) => q.markers.includes(OTHER_VALUE)),
  };
  const reached = [control, clean, future, mixed, lit].every((r) => r.seen.ENDPOINT.length > 0);
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: an Agent Plugins 1.0.0 package on Codex, installed as a user installs it (design note v0.2 §5.7, §10)',
    at: new Date().toISOString(),
    evidence: evidence(b, codex),
    installs: { clean: cleanInstall, future: futureInstall, mixed: mixedInstall, literal: literalInstall },
    runs: { control: shape(control), clean: shape(clean), future: shape(future), mixed: shape(mixed), literal: shape(lit) },
    server_probes: { clean: clean.probe, future: future.probe, mixed: mixed.probe, literal: lit.probe },
    plugin_data_dirs: cleanData,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(R.url).join('<REMOTE>').split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 Agent Plugins check on Codex failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
