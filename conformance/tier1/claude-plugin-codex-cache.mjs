#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.7, §12 row 18), on Codex. It starts the real harness, so
// it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/claude-plugin-codex-cache.mjs --codex <path> [--hs-rev <sha>] [--keep]
//
// What Codex loads from a package in Claude Code's own format, claude-plugin, placed in its plugin
// cache: the route a Codex driver would take, as it does for Agent Plugins (6a.15). hs refuses the
// format on Codex (milestone 6a.18) because only the skills load; the checks below marked as
// premises are that refusal's, so a Codex that starts loading more fails this check, and the
// refusal is looked at again. Codex finds
// .claude-plugin/plugin.json among its manifest paths and reads it as its legacy manifest, with
// skills/, hooks/hooks.json, .mcp.json and .app.json as the defaults, and commands migrated into
// skills (codex-rs/utils/plugins/src/plugin_namespace.rs, core-plugins/src/manifest.rs, loader.rs,
// command_migration.rs, rust-v0.160.0). Hook processes get CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA
// "for OOTB compat" (hooks/src/engine/discovery.rs); whether ${CLAUDE_PLUGIN_ROOT} in .mcp.json is
// expanded is not visible there. The package is lib/claude-plugin.mjs's: a skill, a command, a
// SessionStart hook and a stdio server written as Claude Code documents it, each leaving a mark.
// Each run has a data folder of its own and starts `codex exec` from hs's launch-spec for a plain
// layer against a scripted model with no script, which records markers and answers 400. Runs:
//   control   no plugin. Expected: no marker, no hook, no server (the premise).
//   byhand    `codex plugin marketplace add`, the cache directory and an enabled [plugins] table in
//             config.toml, as a user installs it. Expected: the skill reaches a request (the positive
//             control). Recorded: every other component.
//   cache     the cache directory alone, enabled by `-c plugins={...}`, with hook trust bypassed so
//             that a registered hook shows. Expected: the skill loads; the stdio server, given with
//             ${CLAUDE_PLUGIN_ROOT} as Claude Code documents it, does not start; the command does not
//             reach a request (premises); the hook runs.
//   trusted   the same without the bypass, as hs launches. Expected: the hook does not run (premise).
//   relative  a package whose .mcp.json gives the server as `./bin/hs-probe ./server.mjs`, with no
//             placeholder. Expected: the server does not start either (premise).
//   bare      no manifest. Recorded: whether Codex loads the package, and under which name.
// Names and booleans only. The credential is a dummy; HOME and XDG are scratch.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';
import { probe } from '../lib/agent-plugins.mjs';
import { writeNativePackage } from '../lib/claude-plugin.mjs';

const codex = guard('claude-plugin-codex-cache.mjs', '--codex');
const PROMPT = 'tier 1 claude-plugin cache check on Codex';
const TOOL = 'hs_native_tool';
const NAME = 'hs-bench-native';
const REL = 'hs-bench-relative';
const BARE = 'hs-bench-bare';
const MARKET = 'hs-bench-cp-cache';
const M = { skill: 'hs-tier1-cp-skill-7e2c', command: 'hs-tier1-cp-command-91d3', tool: 'hs-tier1-cp-tool-5a08' };
const BYPASS = '--dangerously-bypass-hook-trust';
const b = bench('hs-tier1-claude-plugin-cx-cache-');

const markers = [M.skill, M.command, M.tool, `${NAME}:notes`, `${REL}:notes`, `${BARE}:notes`, 'hs-bench-hello'];
const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: r.seen.ENDPOINT.length,
  markers: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.markers))].sort(), hook_ran: r.hook,
  server: r.probe ? { started: r.probe.started, args_expanded: r.probe.args_expanded, root_matches: r.probe.root_matches, cwd_is_root: r.probe.cwd_is_root, data_exists: r.probe.data_exists, env_names: r.probe.env_names } : null });
const table = (name) => `{${JSON.stringify(`${name}@${MARKET}`)}={enabled=true}}`;

try {
  const L = await b.model('ENDPOINT', { markers });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const plain = path.join(b.work, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'spec.toml'), '[spec]\nname = "plain"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[endpoints.openai-responses]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const probeOut = path.join(b.work, 'probe');
  const hookProbe = path.join(b.work, 'hook-ran');

  // One package per name, and a marketplace of it in Codex's layout for the byhand run.
  const pkgs = {};
  const pkgFor = (name, opts = {}) => {
    if (pkgs[name]) return pkgs[name];
    const dir = path.join(b.work, 'market', name);
    writeNativePackage(path.join(dir, name), { name, tool: TOOL, probeOut, hookProbe, marks: M, ...opts });
    fs.mkdirSync(path.join(dir, '.agents', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: MARKET, plugins: [{ name, source: `./${name}` }] }, null, 2) + '\n');
    pkgs[name] = { market: dir, pkg: path.join(dir, name) };
    return pkgs[name];
  };
  const folderFor = (variant) => {
    const f = path.join(b.work, `codex-home-${variant}`);
    fs.mkdirSync(f);
    return f;
  };
  const cache = (folder, name) => {
    const dir = path.join(folder, 'plugins', 'cache', MARKET, name, '1.0.0');
    fs.cpSync(pkgFor(name).pkg, dir, { recursive: true });
    return dir;
  };
  const cli = (folder, args) => spawnSync(codex, ['plugin', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...b.scratch, CODEX_HOME: folder }, timeout: 120_000 }).status;
  const run = async (folder, extra = []) => {
    for (const f of [probeOut, hookProbe]) fs.rmSync(f, { force: true });
    const spec = b.hs('launch-spec', ['--harness', 'codex', '--folder', folder, '--layer', plain, '--local', local, '--bin', codex, '--headless']);
    const l = fromSpec(spec, {}, codex, [...extra, '--skip-git-repo-check', PROMPT]);
    const r = await b.launch([L], l.argv, l.env, cwd);
    return { ...r, probe: probe(probeOut), hook: fs.existsSync(hookProbe) };
  };

  const control = await run(folderFor('control'));

  const byhandFolder = folderFor('byhand');
  const byhandAdd = cli(byhandFolder, ['marketplace', 'add', pkgFor(NAME).market]);
  cache(byhandFolder, NAME);
  fs.appendFileSync(path.join(byhandFolder, 'config.toml'), `\n[plugins."${NAME}@${MARKET}"]\nenabled = true\n`);
  const byhand = await run(byhandFolder, [BYPASS]);

  const cacheFolder = folderFor('cache');
  cache(cacheFolder, NAME);
  const cached = await run(cacheFolder, ['-c', `plugins=${table(NAME)}`, BYPASS]);

  const trustedFolder = folderFor('trusted');
  cache(trustedFolder, NAME);
  const trusted = await run(trustedFolder, ['-c', `plugins=${table(NAME)}`]);

  // The server given relative to the plugin root, with no placeholder.
  const relPkg = pkgFor(REL).pkg;
  fs.writeFileSync(path.join(relPkg, '.mcp.json'), JSON.stringify({ mcpServers: { probe: { command: './bin/hs-probe', args: ['./server.mjs'], env: { HS_PROBE_OUT: probeOut } } } }, null, 2) + '\n');
  const relFolder = folderFor('relative');
  cache(relFolder, REL);
  const relative = await run(relFolder, ['-c', `plugins=${table(REL)}`]);

  pkgFor(BARE, { noManifest: true });
  const bareFolder = folderFor('bare');
  cache(bareFolder, BARE);
  const bare = await run(bareFolder, ['-c', `plugins=${table(BARE)}`]);

  const has = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  const parts = (r, name = NAME) => ({
    skill: has(r, M.skill), skill_by_name: has(r, `${name}:notes`), command: has(r, M.command), command_name: has(r, 'hs-bench-hello'),
    tool: has(r, M.tool), server_started: r.probe?.started === true, args_expanded: r.probe?.args_expanded ?? null, root_matches: r.probe?.root_matches ?? null, cwd_is_root: r.probe?.cwd_is_root ?? null, hook: r.hook,
  });
  const checks = {
    'without a plugin no marker reaches a request, no hook runs, no server starts (premise)': control.seen.ENDPOINT.length > 0 && !markers.some((m) => has(control, m)) && control.probe === null && control.hook === false,
    'byhand: marketplace add, the cache directory and the [plugins] table load the package\'s skill (positive control)': byhandAdd === 0 && has(byhand, M.skill),
    'cache: enabled by -c plugins, the skill loads from the cache': has(cached, M.skill),
    'cache: the stdio server, given with ${CLAUDE_PLUGIN_ROOT}, does not start (premise of the refusal)': cached.probe === null && !has(cached, M.tool),
    'relative: the stdio server given relative to the plugin root does not start (premise of the refusal)': relative.probe === null && !has(relative, M.tool),
    'cache: the command does not reach a request, as Codex migrates commands only at install (premise of the refusal)': !has(cached, M.command) && !has(cached, 'hs-bench-hello'),
    'trusted: as hs launches, the package\'s hook does not run, while with hook trust bypassed it does (premise of the refusal)': trusted.hook === false && cached.hook === true,
  };
  const recorded = { byhand: parts(byhand), cache: parts(cached), trusted: parts(trusted), relative: parts(relative, REL), bare: parts(bare, BARE) };
  const reached = [control, byhand, cached, trusted, relative, bare].every((r) => r.seen.ENDPOINT.length > 0);
  const positive = 'byhand: marketplace add, the cache directory and the [plugins] table load the package\'s skill (positive control)';
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : !checks[positive] ? 'inconclusive: the positive control did not load' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: what Codex loads from a claude-plugin package in its plugin cache (design note v0.2 §5.7, §12 row 18)',
    at: new Date().toISOString(),
    evidence: evidence(b, codex),
    runs: { control: shape(control), byhand: shape(byhand), cache: shape(cached), trusted: shape(trusted), relative: shape(relative), bare: shape(bare) },
    recorded,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 claude-plugin cache check on Codex failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
