#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.7, §12 row 35), on Codex. It starts the real harness, so
// it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/agent-plugins-codex-cache.mjs --codex <path> [--hs-rev <sha>] [--keep]
//
// The route a Codex driver can take for an Agent Plugins package without writing config.toml:
// the package copied into the plugin cache, plugins/cache/<marketplace>/<plugin>/<version>/ [CX §10],
// and enabled for one launch by a CLI override. Codex splits an override's key on every `.`, with no
// quoting (codex-rs/config/src/overrides.rs, rust-v0.160.0), and deep-merges the override layer's
// tables into the config (merge.rs), so the override is one inline table,
// `-c plugins={"<plugin>@<marketplace>"={enabled=true}}`, which keeps every other plugin entry and
// takes a plugin name holding a dot. Each run has a data folder of its own and starts `codex exec`
// from hs's launch-spec for a plain layer (endpoint and model only) against a scripted model with no
// script, which records markers and answers 400. The package is lib/agent-plugins.mjs's clean one
// (one valid skill; one stdio server whose args use ${PLUGIN_ROOT} and whose env uses
// ${PLUGIN_DATA}). Runs:
//   control       no plugin. Expected: no marker reaches a request (the premise).
//   byhand        what `codex plugin add` writes, by hand, after `codex plugin marketplace add`: the
//                 cache directory and an enabled [plugins] table in config.toml. Expected: it loads
//                 (the positive control, as in agent-plugins-codex.mjs).
//   cache         the cache directory only: no marketplace added, no config.toml, enabled by the
//                 inline-table override. Expected: the skill reaches the request with its
//                 description; the server starts in the plugin root with both placeholders
//                 expanded; its tool reaches the request; config.toml is not written.
//   dotted        `cache` for a package whose name has a dot. Expected: it loads the same way.
//   no_enable     the cache directory only, with no override. Recorded: whether a cached plugin
//                 loads unenabled.
//   quoted_key    the cache directory only, enabled by `-c plugins."<plugin>@<marketplace>".enabled=true`.
//                 Recorded: whether the quoted dotted key reaches the plugin (the source says it is
//                 split on every `.`, quotes kept).
//   other_dir     `cache`, the version directory named `hs` rather than the manifest's version.
//                 Recorded: whether Codex finds a package under any version directory.
//   driver        hs's own route (milestone 6a.15): the package as a plugin item in a layer, `hs
//                 plan --mode materialize`, refused by `hs apply` without a receipt and applied with
//                 one, then hs's launch-spec. Expected: the plan's tree is
//                 plugins/cache/harness-skeleton/<name>/hs; the launch carries the inline-table
//                 override; the package loads as in `cache`; config.toml is not written. hs plans
//                 only for a Codex inside its descriptor's range, so outside it the plan's refusal
//                 (version_unsupported) is recorded and the driver's checks are not judged.
// After each run the check records which top-level entries Codex added to the data folder, by name.
// The model and the server record names and booleans only. The credential is a dummy; HOME and XDG
// are scratch.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';
import { probe, writePackage } from '../lib/agent-plugins.mjs';

const codex = guard('agent-plugins-codex-cache.mjs', '--codex');
const PROMPT = 'tier 1 Agent Plugins cache check on Codex';
const TOOL = 'hs_plugin_tool';
const NAME = 'hs-bench-plugin';
const DOTTED = 'hs.bench-plugin';
const MARKET = 'hs-bench-cache';
const M = { skill: 'hs-tier1-ap-skill-4d1a', tool: 'hs-tier1-ap-tool-2b7f' };
const b = bench('hs-tier1-agent-plugins-cx-cache-');

const markers = [M.skill, M.tool, `${NAME}:notes`, `${DOTTED}:notes`];
const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: r.seen.ENDPOINT.length,
  markers: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.markers))].sort() });
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

  // One package per name, and a marketplace of it for the byhand run's `marketplace add`.
  const pkgs = {};
  const pkgFor = (name) => {
    if (pkgs[name]) return pkgs[name];
    const dir = path.join(b.work, 'market', name);
    writePackage(path.join(dir, name), { name, tool: TOOL, probeOut, marks: M });
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
  const cache = (folder, name, version = '1.0.0') => {
    const dir = path.join(folder, 'plugins', 'cache', MARKET, name, version);
    fs.cpSync(pkgFor(name).pkg, dir, { recursive: true });
    return dir;
  };
  const cli = (folder, args) => spawnSync(codex, ['plugin', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...b.scratch, CODEX_HOME: folder }, timeout: 120_000 }).status;
  const configTables = (folder) => {
    const f = path.join(folder, 'config.toml');
    if (!fs.existsSync(f)) return null;
    // Table headers only, never a value.
    return [...new Set(fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^\s*\[/.test(l)).map((l) => l.trim().replace(/^\[+|\]+$/g, '').split('.')[0]))].sort();
  };
  const run = async (folder, extra = [], layers = [plain]) => {
    fs.rmSync(probeOut, { force: true });
    const before = fs.readdirSync(folder).sort();
    const spec = b.hs('launch-spec', ['--harness', 'codex', '--folder', folder, ...layers.flatMap((l) => ['--layer', l]), '--local', local, '--bin', codex, '--headless']);
    const l = fromSpec(spec, {}, codex, [...extra, '--skip-git-repo-check', PROMPT]);
    const r = await b.launch([L], l.argv, l.env, cwd);
    const after = fs.readdirSync(folder).sort();
    return { ...r, probe: probe(probeOut), added: after.filter((n) => !before.includes(n)), config_tables: configTables(folder) };
  };

  const control = await run(folderFor('control'));

  const byhandFolder = folderFor('byhand');
  const byhandAdd = cli(byhandFolder, ['marketplace', 'add', pkgFor(NAME).market]);
  const marketTables = configTables(byhandFolder);
  cache(byhandFolder, NAME);
  fs.appendFileSync(path.join(byhandFolder, 'config.toml'), `\n[plugins."${NAME}@${MARKET}"]\nenabled = true\n`);
  const byhand = await run(byhandFolder);

  const cacheFolder = folderFor('cache');
  cache(cacheFolder, NAME);
  const cached = await run(cacheFolder, ['-c', `plugins=${table(NAME)}`]);

  const dottedFolder = folderFor('dotted');
  cache(dottedFolder, DOTTED);
  const dotted = await run(dottedFolder, ['-c', `plugins=${table(DOTTED)}`]);

  const bareFolder = folderFor('no-enable');
  cache(bareFolder, NAME);
  const bare = await run(bareFolder);

  const quotedFolder = folderFor('quoted-key');
  cache(quotedFolder, NAME);
  const quoted = await run(quotedFolder, ['-c', `plugins."${NAME}@${MARKET}".enabled=true`]);

  const otherFolder = folderFor('other-dir');
  cache(otherFolder, NAME, 'hs');
  const other = await run(otherFolder, ['-c', `plugins=${table(NAME)}`]);

  // hs's own route: plan, apply under the plan's receipt, launch-spec.
  const driverFolder = folderFor('driver');
  const kit = path.join(b.work, 'kit');
  fs.cpSync(pkgFor(NAME).pkg, path.join(kit, NAME), { recursive: true });
  fs.writeFileSync(path.join(kit, 'spec.toml'), `[spec]\nname = "kit"\nversion = "1.0.0"\nformat = "0.2"\n\n[plugin.${JSON.stringify(NAME)}]\nsource = ${JSON.stringify(NAME)}\nformat = "agent-plugins"\n`);
  const common = ['--harness', 'codex', '--folder', driverFolder, '--bin', codex];
  const planned = b.hsCall('plan', [...common, '--layer', plain, '--layer', kit, '--local', local, '--owner', 'tier1', '--mode', 'materialize']);
  const outOfRange = !planned.ok && planned.error.code === 'version_unsupported';
  let driver = null;
  let driverOp = null;
  let driverSpec = null;
  let refusedApply = null;
  if (!outOfRange) {
    if (!planned.ok) throw new Error(`hs plan: ${planned.error.code}: ${planned.error.message}`);
    const plan = planned.result;
    const planFile = path.join(b.work, 'driver-plan.json');
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const noReceipt = path.join(b.work, 'driver-no-receipt.json');
    fs.writeFileSync(noReceipt, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: [], by: 'tier1-bench' }));
    refusedApply = b.hsCall('apply', [...common, '--plan', planFile, '--receipt', noReceipt]);
    const receiptFile = path.join(b.work, 'driver-receipt.json');
    fs.writeFileSync(receiptFile, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench', at: new Date().toISOString() }));
    b.hs('apply', [...common, '--plan', planFile, '--receipt', receiptFile]);
    driverOp = plan.operations.find((o) => o.item === `plugin.${NAME}`);
    driverSpec = b.hs('launch-spec', [...common, '--layer', plain, '--layer', kit, '--local', local, '--headless']);
    driver = await run(driverFolder, [], [plain, kit]);
  }

  const has = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  const loads = (r, name = NAME) => ({ skill_loads: has(r, `${name}:notes`) || has(r, M.skill), skill_description_reaches: has(r, M.skill), server_starts: r.probe?.started === true, tool_reaches: has(r, M.tool) });
  const whole = (r, name = NAME) => has(r, `${name}:notes`) && has(r, M.skill) && r.probe?.started === true && r.probe.args_expanded === true && r.probe.data_expanded === true && r.probe.cwd_is_root === true && has(r, M.tool);
  const checks = {
    'without a plugin no marker reaches a request (premise)': control.seen.ENDPOINT.length > 0 && !markers.some((m) => has(control, m)),
    'byhand: marketplace add, the cache directory and the [plugins] table load the package (positive control)': byhandAdd === 0 && whole(byhand),
    'cache: the cache directory and the inline-table override alone load the package, skill and server, the server in the plugin root with both placeholders expanded': whole(cached),
    'cache: config.toml is not written': cached.config_tables === null,
    'dotted: a dotted plugin name loads the same way': whole(dotted, DOTTED) && dotted.config_tables === null,
    ...(outOfRange ? {} : {
      'driver: the plan installs the package at plugins/cache/harness-skeleton/<name>/hs, and apply refuses without a receipt': driverOp?.address_id === `plugins/cache/harness-skeleton/${NAME}/hs` && refusedApply.ok === false && refusedApply.error.code === 'receipt_required',
      'driver: launch-spec carries the inline-table override': driverSpec.argv.includes(`plugins={"${NAME}@harness-skeleton"={enabled=true}}`),
      'driver: the package loads, skill and server, as in cache; config.toml is not written': whole(driver) && driver.config_tables === null,
    }),
  };
  const recorded = {
    marketplace_add_config_tables: marketTables,
    no_enable: loads(bare),
    quoted_key: loads(quoted),
    other_dir: loads(other),
    // What each run's folder gained beyond what the control's did, by name.
    added_beyond_control: Object.fromEntries(Object.entries({ byhand, cache: cached, dotted, no_enable: bare, quoted_key: quoted, other_dir: other, ...(driver ? { driver } : {}) }).map(([k, r]) => [k, r.added.filter((n) => !control.added.includes(n))])),
    driver: outOfRange ? { plan: 'version_unsupported: this Codex is outside the driver descriptor\'s range, so hs plans nothing; the driver\'s checks are not judged' } : { plan_risk: driverOp?.risk ?? null },
  };
  const reached = [control, byhand, cached, dotted, bare, quoted, other, ...(driver ? [driver] : [])].every((r) => r.seen.ENDPOINT.length > 0);
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : !checks['byhand: marketplace add, the cache directory and the [plugins] table load the package (positive control)'] ? 'inconclusive: the positive control did not load' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: an Agent Plugins 1.0.0 package on Codex from the plugin cache, enabled by a launch override, with no config.toml write (design note v0.2 §5.7, §12 row 35)',
    at: new Date().toISOString(),
    evidence: evidence(b, codex),
    runs: { control: shape(control), byhand: shape(byhand), cache: shape(cached), dotted: shape(dotted), no_enable: shape(bare), quoted_key: shape(quoted), other_dir: shape(other), ...(driver ? { driver: shape(driver) } : {}) },
    server_probes: { byhand: byhand.probe, cache: cached.probe, dotted: dotted.probe, no_enable: bare.probe, quoted_key: quoted.probe, other_dir: other.probe, ...(driver ? { driver: driver.probe } : {}) },
    recorded,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 Agent Plugins cache check on Codex failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
