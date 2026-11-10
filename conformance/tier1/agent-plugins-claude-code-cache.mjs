#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.7, §12 row 35), on Claude Code. It starts the real harness,
// so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/agent-plugins-claude-code-cache.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// What a Claude Code driver would have to write so that an Agent Plugins package, translated to the
// .claude-plugin layout by hs (design note §5.7), loads in a bare start of a data folder, with no
// --plugin-dir: the route `materialize` needs. Claude Code keeps an installed plugin at
// plugins/cache/<marketplace>/<plugin>/<version>/, with plugins/installed_plugins.json,
// plugins/known_marketplaces.json, and `enabledPlugins` in settings.json [CC §10]. hs writes
// settings.json key by key already (§7.5); the two records are Claude Code's own files. Each run has a
// data folder of its own and starts `claude -p` from hs's launch-spec for a plain layer (endpoint and
// model only, no plugin) against a local listener that answers 400 and records markers and tool
// names. The plugin is hs's own translation of lib/agent-plugins.mjs's clean package, taken from
// hs launch-spec's temp dir. Runs:
//   control        no plugin. Expected: no marker reaches a request (the premise).
//   cli            `claude plugin marketplace add <dir>` and `claude plugin install <p>@<m>`, as a user
//                  installs it, from a directory marketplace holding the translated plugin. Expected:
//                  both succeed, and the plugin loads (the positive control for every run below).
//                  Recorded, by name only: what the install wrote under plugins/, the keys of
//                  settings.json and of its enabledPlugins, and the top-level keys of the two records.
//   cache_enabled  the translated plugin copied to plugins/cache/<m>/<p>/<version>/, and
//                  settings.json#enabledPlugins/<p>@<m> = true. No record. Recorded: whether it loads.
//   cache_known    cache_enabled plus the cli run's known_marketplaces.json, its folder path
//                  rewritten. Recorded: whether it loads.
//   cache_records  cache_known plus the cli run's installed_plugins.json, rewritten the same way.
//                  Recorded: whether it loads.
// A plugin counts as loaded when its skill reaches a request by name (<plugin>:notes) or by its
// description's marker, and its server's tool is offered. The listener and the server record names
// and booleans only. The credential is a dummy; HOME and XDG are scratch.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';
import { probe, writePackage } from '../lib/agent-plugins.mjs';

const claude = guard('agent-plugins-claude-code-cache.mjs');
const PROMPT = 'tier 1 Agent Plugins cache check on Claude Code';
const TOOL = 'hs_plugin_tool';
const NAME = 'hs-bench-plugin';
const MARKET = 'hs-bench-cc-market';
const VERSION = '1.0.0';
const M = { skill: 'hs-tier1-ap-skill-4d1a', tool: 'hs-tier1-ap-tool-2b7f' };
const b = bench('hs-tier1-agent-plugins-cc-cache-');

const markers = [M.skill, M.tool, `${NAME}:notes`];
const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: r.seen.ENDPOINT.length,
  markers: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.markers))].sort(), bench_tools: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.tools ?? []).filter((t) => typeof t === 'string' && t.includes(TOOL)))].sort() });

try {
  const L = await b.listener('ENDPOINT', { markers, toolNames: true });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const plain = path.join(b.work, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'spec.toml'), '[spec]\nname = "plain"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[endpoints.anthropic-messages]\nbase_url = "${L.url}"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const probeOut = path.join(b.work, 'probe');

  // The package, and hs's own translation of it: launch-spec for a layer holding it as a plugin
  // item, under a receipt, in a throwaway folder; the plugin tree is copied out of the temp dir.
  const kit = path.join(b.work, 'kit');
  writePackage(path.join(kit, NAME), { name: NAME, tool: TOOL, probeOut, marks: M });
  fs.writeFileSync(path.join(kit, 'spec.toml'), `[spec]\nname = "kit"\nversion = "1.0.0"\nformat = "0.2"\n\n[plugin.${JSON.stringify(NAME)}]\nsource = ${JSON.stringify(NAME)}\nformat = "agent-plugins"\n`);
  const specFolder = path.join(b.work, 'folder-spec');
  fs.mkdirSync(specFolder);
  const specArgs = ['--harness', 'claude-code', '--folder', specFolder, '--layer', plain, '--layer', kit, '--local', local, '--bin', claude, '--headless'];
  const refused = b.hsCall('launch-spec', specArgs);
  const items = refused.ok ? [] : refused.error.items ?? [];
  const receipt = path.join(b.work, 'receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({ format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() }));
  const carried = b.hs('launch-spec', [...specArgs, '--receipt', receipt]);
  const tree = carried.files.find((f) => f.role === `plugin.${NAME}`)?.path;
  if (!tree) throw new Error('hs launch-spec carried no translated plugin');
  const translated = path.join(b.work, 'translated', NAME);
  fs.cpSync(tree, translated, { recursive: true });
  fs.rmSync(carried.temp_dir, { recursive: true, force: true });

  // A directory marketplace of that one plugin [CC §10].
  const market = path.join(b.work, 'market');
  fs.cpSync(translated, path.join(market, NAME), { recursive: true });
  fs.mkdirSync(path.join(market, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: MARKET, owner: { name: 'bench' }, plugins: [{ name: NAME, source: `./${NAME}`, description: 'A tier 1 bench plugin.' }] }, null, 2) + '\n');

  const folderFor = (variant) => {
    const f = path.join(b.work, `claude-home-${variant}`);
    fs.mkdirSync(f);
    return f;
  };
  const cli = (folder, args) => {
    const p = spawnSync(claude, ['plugin', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...b.scratch, CLAUDE_CONFIG_DIR: folder }, timeout: 120_000 });
    return { exit: p.status };
  };
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  // Names only: what lies under plugins/ (two levels), the keys of settings.json and its
  // enabledPlugins, the top-level keys of the two records and whether they name the folder.
  const listing = (folder) => {
    const pl = path.join(folder, 'plugins');
    const under = [];
    if (fs.existsSync(pl)) {
      for (const a of fs.readdirSync(pl).sort()) {
        const p = path.join(pl, a);
        under.push(a);
        if (fs.statSync(p).isDirectory()) for (const c of fs.readdirSync(p).sort()) under.push(`${a}/${c}`);
      }
    }
    const settings = readJson(path.join(folder, 'settings.json'));
    const rec = (n) => {
      const f = path.join(pl, n);
      if (!fs.existsSync(f)) return null;
      const text = fs.readFileSync(f, 'utf8');
      const j = readJson(f);
      return { keys: j && typeof j === 'object' ? Object.keys(j).sort() : null, names_folder: text.includes(folder), names_market_dir: text.includes(market) };
    };
    return {
      plugins: under,
      settings_keys: settings ? Object.keys(settings).sort() : null,
      enabled_plugins: settings?.enabledPlugins ? Object.keys(settings.enabledPlugins).sort() : null,
      installed_plugins: rec('installed_plugins.json'),
      known_marketplaces: rec('known_marketplaces.json'),
    };
  };
  const run = async (folder) => {
    fs.rmSync(probeOut, { force: true });
    const spec = b.hs('launch-spec', ['--harness', 'claude-code', '--folder', folder, '--layer', plain, '--local', local, '--bin', claude, '--headless']);
    const l = fromSpec(spec, {}, claude, [PROMPT]);
    const r = await b.launch([L], l.argv, l.env, cwd);
    return { ...r, probe: probe(probeOut) };
  };
  const cacheAt = (folder, version) => {
    const dir = path.join(folder, 'plugins', 'cache', MARKET, NAME, version);
    fs.cpSync(translated, dir, { recursive: true });
    return dir;
  };
  const enable = (folder) => fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ enabledPlugins: { [`${NAME}@${MARKET}`]: true } }, null, 2) + '\n');
  // A record of the cli run, with that folder's path rewritten to this one's.
  const copyRecord = (from, to, n) => {
    const f = path.join(from, 'plugins', n);
    if (!fs.existsSync(f)) return false;
    fs.mkdirSync(path.join(to, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(to, 'plugins', n), fs.readFileSync(f, 'utf8').split(from).join(to));
    return true;
  };

  const control = await run(folderFor('control'));

  const cliFolder = folderFor('cli');
  const install = { marketplace_add: cli(cliFolder, ['marketplace', 'add', market]), plugin_install: cli(cliFolder, ['install', `${NAME}@${MARKET}`, '--scope', 'user']) };
  // Recorded: an install that wants confirmation is tried once more with -y.
  if (install.plugin_install.exit !== 0) install.plugin_install_yes = cli(cliFolder, ['install', `${NAME}@${MARKET}`, '--scope', 'user', '-y']);
  const installed = install.plugin_install.exit === 0 || install.plugin_install_yes?.exit === 0;
  const cliListing = listing(cliFolder);
  const cliRun = await run(cliFolder);
  // The version directory the install chose, if it wrote one under the cache.
  const cached = path.join(cliFolder, 'plugins', 'cache', MARKET, NAME);
  const versionDirs = fs.existsSync(cached) ? fs.readdirSync(cached).sort() : [];
  const version = versionDirs[0] ?? VERSION;

  const enabledFolder = folderFor('cache-enabled');
  cacheAt(enabledFolder, version);
  enable(enabledFolder);
  const enabledRun = await run(enabledFolder);

  const knownFolder = folderFor('cache-known');
  cacheAt(knownFolder, version);
  enable(knownFolder);
  const knownCopied = copyRecord(cliFolder, knownFolder, 'known_marketplaces.json');
  const knownRun = await run(knownFolder);

  const recordsFolder = folderFor('cache-records');
  cacheAt(recordsFolder, version);
  enable(recordsFolder);
  const recordsCopied = copyRecord(cliFolder, recordsFolder, 'known_marketplaces.json') && copyRecord(cliFolder, recordsFolder, 'installed_plugins.json');
  const recordsRun = await run(recordsFolder);

  const has = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  const offered = (r) => r.seen.ENDPOINT.some((q) => (q.tools ?? []).some((t) => typeof t === 'string' && t.includes(TOOL)));
  const loads = (r) => ({ skill_loads: has(r, `${NAME}:notes`) || has(r, M.skill), server_starts: r.probe?.started === true, tool_offered: offered(r), server_in_root: r.probe?.cwd_is_root ?? null });
  const whole = (r) => (has(r, `${NAME}:notes`) || has(r, M.skill)) && r.probe?.started === true && offered(r);
  const checks = {
    'without a plugin no marker reaches a request (premise)': control.seen.ENDPOINT.length > 0 && !markers.some((m) => has(control, m)) && !offered(control),
    'cli: marketplace add and install succeed, and the translated plugin loads in a bare start (positive control)': install.marketplace_add.exit === 0 && installed && whole(cliRun),
  };
  const recorded = {
    cli_wrote: cliListing,
    version_dirs: versionDirs,
    cache_enabled: loads(enabledRun),
    cache_known: { ...loads(knownRun), record_copied: knownCopied },
    cache_records: { ...loads(recordsRun), records_copied: recordsCopied },
  };
  const reached = [control, cliRun, enabledRun, knownRun, recordsRun].every((r) => r.seen.ENDPOINT.length > 0);
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : !checks['cli: marketplace add and install succeed, and the translated plugin loads in a bare start (positive control)'] ? 'inconclusive: the positive control did not load' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: what makes a translated Agent Plugins package load in a bare start of a Claude Code data folder (design note v0.2 §5.7, §12 row 35)',
    at: new Date().toISOString(),
    evidence: evidence(b, claude),
    runs: { control: shape(control), cli: shape(cliRun), cache_enabled: shape(enabledRun), cache_known: shape(knownRun), cache_records: shape(recordsRun) },
    installs: install,
    recorded,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 Agent Plugins cache check on Claude Code failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
