#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.7, §12 row 18), on Claude Code. It starts the real harness,
// so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/claude-plugin-claude-code.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// A package in Claude Code's own format, claude-plugin, delivered whole by hs (milestone 6a.17): at
// launch as one --plugin-dir, the package copied into launch-spec's temp dir; under materialize as the
// plugin of a directory marketplace in hs-run/, with two settings.json keys. Each run has a data folder
// of its own and starts `claude -p` against a local listener that answers 400 and records markers and
// tool names. The package is lib/claude-plugin.mjs's: a skill, a command, a SessionStart hook and a
// stdio server, each leaving a mark. Runs:
//   control   no plugin. Expected: no marker reaches a request, no hook runs, no server starts (the
//             premise).
//   direct    the package passed by hand, `--plugin-dir <package>`, beside hs's launch-spec for a
//             plain layer. Expected: the plugin loads whole: skill, server and hook (the positive
//             control). Recorded: whether the command's marker reaches a request.
//   launch    hs launch-spec for a layer holding the package as a plugin item: refused without a
//             receipt, its one risk runs-code; with one, started. Expected: one --plugin-dir, whose
//             tree is the package byte for byte (its digest), and the plugin loads whole.
//   bare      the same for a package with no .claude-plugin/plugin.json. Expected: the plugin loads
//             under the item's name, which hs gives the directory it copies the package into.
//   driver    `hs plan --mode materialize`, refused by `hs apply` with a receipt that allows nothing,
//             applied with one, then a bare start. Expected: the plan writes hs-run/plugin.<name>/ and
//             the two settings.json keys, its tree's plugin/ is the package byte for byte, the plugin
//             loads whole, and hs's launch-spec for the same spec skips it rather than carry it again.
//   removed   `hs remove` on the driver's folder, then a bare start. Expected: the plugin no longer
//             loads: no marker, no hook, no server.
//   off_direct   a package whose manifest sets `defaultEnabled: false`, passed by hand. Recorded:
//             whether it loads (as documented, it should not).
//   off_launch   the same package through hs launch-spec, whose --settings overlay turns it on by its
//             session id, <name>@inline. Expected: it loads whole.
//   folder_direct  the first package passed by hand to a folder whose settings.json sets
//             <name>@inline to false. Recorded: whether it loads (as documented, it should not).
//   folder_launch  the same folder through hs launch-spec. Expected: the overlay outranks the
//             folder's settings, and the plugin loads whole.
// A plugin loads whole when its skill reaches a request by name (<plugin>:notes) or by its
// description's marker, its server starts and its tool is offered, and its hook has run. The listener,
// the server and the hook record names and booleans only. The credential is a dummy; HOME and XDG are
// scratch.

import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';
import { probe } from '../lib/agent-plugins.mjs';
import { writeNativePackage } from '../lib/claude-plugin.mjs';
import { digestPath } from '../../src/spec/layers.js';

const claude = guard('claude-plugin-claude-code.mjs');
const PROMPT = 'tier 1 claude-plugin check on Claude Code';
const TOOL = 'hs_native_tool';
const NAME = 'hs-bench-native';
const BARE = 'hs-bench-bare';
const OFF = 'hs-bench-off';
const M = { skill: 'hs-tier1-cp-skill-7e2c', command: 'hs-tier1-cp-command-91d3', tool: 'hs-tier1-cp-tool-5a08' };
const b = bench('hs-tier1-claude-plugin-cc-');

const markers = [M.skill, M.command, M.tool, `${NAME}:notes`, `${BARE}:notes`, `${OFF}:notes`, `${NAME}:hs-bench-hello`];
const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: r.seen.ENDPOINT.length,
  markers: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.markers))].sort(), bench_tools: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.tools ?? []).filter((t) => typeof t === 'string' && t.includes(TOOL)))].sort(), hook_ran: r.hook, server: r.probe ? { started: r.probe.started, cwd_is_root: r.probe.cwd_is_root, root_matches: r.probe.root_matches, data_exists: r.probe.data_exists } : null });

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
  const hookProbe = path.join(b.work, 'hook-ran');

  const kitFor = (name, opts = {}) => {
    const dir = path.join(b.work, `kit-${name}`);
    writeNativePackage(path.join(dir, name), { name, tool: TOOL, probeOut, hookProbe, marks: M, ...opts });
    fs.writeFileSync(path.join(dir, 'spec.toml'), `[spec]\nname = "kit-${name}"\nversion = "1.0.0"\nformat = "0.2"\n\n[plugin.${JSON.stringify(name)}]\nsource = ${JSON.stringify(name)}\nformat = "claude-plugin"\n`);
    return dir;
  };
  const folderFor = (variant) => {
    const f = path.join(b.work, `claude-home-${variant}`);
    fs.mkdirSync(f);
    return f;
  };
  const clear = () => {
    fs.rmSync(probeOut, { force: true });
    fs.rmSync(hookProbe, { force: true });
  };
  const start = async (argv, env) => {
    const r = await b.launch([L], argv, env, cwd);
    return { ...r, probe: probe(probeOut), hook: fs.existsSync(hookProbe) };
  };
  // A bare start: hs's launch-spec for the plain layer only, plus any argv given before the prompt.
  const run = async (folder, extra = []) => {
    clear();
    const spec = b.hs('launch-spec', ['--harness', 'claude-code', '--folder', folder, '--layer', plain, '--local', local, '--bin', claude, '--headless']);
    const l = fromSpec(spec, {}, claude, [PROMPT]);
    return start([l.argv[0], ...extra, ...l.argv.slice(1)], l.env);
  };
  // hs's launch for the plain layer and a kit, under the receipt the refusal asks for.
  const launch = async (folder, kitDir, name) => {
    clear();
    const args = ['--harness', 'claude-code', '--folder', folder, '--layer', plain, '--layer', kitDir, '--local', local, '--bin', claude, '--headless'];
    const refused = b.hsCall('launch-spec', args);
    const items = refused.ok ? [] : refused.error.items ?? [];
    const receipt = path.join(b.work, `receipt-${name}.json`);
    fs.writeFileSync(receipt, JSON.stringify({ format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() }));
    const spec = b.hs('launch-spec', [...args, '--receipt', receipt]);
    const tree = spec.files.find((f) => f.role === `plugin.${name}`);
    const treeDigest = tree ? digestPath(tree.path) : null;
    const l = fromSpec(spec, {}, claude, [PROMPT]);
    const r = await start(l.argv, l.env);
    fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    return { ...r, refused: refused.ok ? null : refused.error.code, risks: (items[0]?.risks ?? []).map((x) => [x.item, x.risk]), plugin_dirs: spec.argv.filter((a) => a === '--plugin-dir').length, tree_basename: tree ? path.basename(tree.path) : null, treeDigest };
  };
  const materialize = (folder, kitDir) => {
    const common = ['--harness', 'claude-code', '--folder', folder, '--bin', claude];
    const plan = b.hs('plan', [...common, '--layer', plain, '--layer', kitDir, '--local', local, '--owner', 'tier1', '--mode', 'materialize']);
    const planFile = path.join(folder, '..', `plan-${path.basename(folder)}.json`);
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const nothing = `${planFile}.nothing`;
    fs.writeFileSync(nothing, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: [], by: 'tier1-bench' }));
    const refusedApply = b.hsCall('apply', [...common, '--plan', planFile, '--receipt', nothing]);
    const receiptFile = `${planFile}.receipt`;
    fs.writeFileSync(receiptFile, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench', at: new Date().toISOString() }));
    b.hs('apply', [...common, '--plan', planFile, '--receipt', receiptFile]);
    return { plan, refused: refusedApply.ok ? null : refusedApply.error.code, common };
  };

  const control = await run(folderFor('control'));

  const kit = kitFor(NAME);
  const pkg = path.join(kit, NAME);
  const pkgDigest = digestPath(pkg);
  const direct = await run(folderFor('direct'), ['--plugin-dir', pkg]);
  const launched = await launch(folderFor('launch'), kit, NAME);
  const bareKit = kitFor(BARE, { noManifest: true });
  const bare = await launch(folderFor('bare'), bareKit, BARE);

  const driverFolder = folderFor('driver');
  const dm = materialize(driverFolder, kit);
  const driverOps = dm.plan.operations.filter((o) => o.item === `plugin.${NAME}`).map((o) => [o.address_id, o.risk]);
  const installedDigest = (() => {
    const p = path.join(driverFolder, 'hs-run', `plugin.${NAME}`, 'plugin');
    return fs.existsSync(p) ? digestPath(p) : null;
  })();
  const driverRun = await run(driverFolder);
  const driverSpec = b.hs('launch-spec', [...dm.common, '--layer', plain, '--layer', kit, '--local', local, '--headless']);
  b.hs('remove', [...dm.common, '--owner', 'tier1']);
  const removedRun = await run(driverFolder);

  // A package that starts disabled, and a folder that turns the name off: by hand, then through hs.
  const offKit = kitFor(OFF, { manifest: { defaultEnabled: false } });
  const offDirect = await run(folderFor('off-direct'), ['--plugin-dir', path.join(offKit, OFF)]);
  const offLaunch = await launch(folderFor('off-launch'), offKit, OFF);
  const turnedOff = (variant) => {
    const f = folderFor(variant);
    fs.writeFileSync(path.join(f, 'settings.json'), JSON.stringify({ enabledPlugins: { [`${NAME}@inline`]: false } }, null, 2) + '\n');
    return f;
  };
  const folderDirect = await run(turnedOff('folder-direct'), ['--plugin-dir', pkg]);
  const folderLaunch = await launch(turnedOff('folder-launch'), kit, NAME);

  const has = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  const offered = (r) => r.seen.ENDPOINT.some((q) => (q.tools ?? []).some((t) => typeof t === 'string' && t.includes(TOOL)));
  const whole = (r, name = NAME) => (has(r, `${name}:notes`) || has(r, M.skill)) && r.probe?.started === true && offered(r) && r.hook === true;
  const none = (r) => r.seen.ENDPOINT.length > 0 && !markers.some((m) => has(r, m)) && !offered(r) && r.probe === null && r.hook === false;
  const checks = {
    'without a plugin no marker reaches a request, no hook runs, no server starts (premise)': none(control),
    'direct: the package passed by hand with --plugin-dir loads whole: skill, server and hook (positive control)': whole(direct),
    'launch: refused without a receipt, its one risk runs-code': launched.refused === 'receipt_required' && JSON.stringify(launched.risks) === JSON.stringify([[`plugin.${NAME}`, 'runs-code']]),
    'launch: one --plugin-dir, its tree the package byte for byte, and the plugin loads whole': launched.plugin_dirs === 1 && launched.treeDigest === pkgDigest && whole(launched),
    'bare: a package without a manifest loads under the item\'s name': bare.tree_basename === BARE && whole(bare, BARE),
    'driver: the plan writes hs-run/plugin.<name> and the two settings.json keys, runs-code, and apply refuses a receipt that allows nothing': JSON.stringify(driverOps) === JSON.stringify([[`hs-run/plugin.${NAME}`, ['runs-code']], [`settings.json#extraKnownMarketplaces/hs-${NAME}`, []], [`settings.json#enabledPlugins/${NAME}@hs-${NAME}`, ['runs-code']]]) && dm.refused === 'receipt_required',
    'driver: the installed plugin is the package byte for byte, and a bare start loads it whole': installedDigest === pkgDigest && whole(driverRun),
    'driver: hs launch-spec for the same spec skips the installed plugin rather than carry it': !driverSpec.argv.includes('--plugin-dir') && driverSpec.skipped.some((x) => x.item === `plugin.${NAME}`),
    'removed: after hs remove, a bare start no longer loads the plugin': none(removedRun),
    'off_launch: a package that starts disabled loads whole through hs, turned on by its session id': whole(offLaunch, OFF),
    'folder_launch: a folder that turns the name off is outranked by the launch overlay, and the plugin loads whole': whole(folderLaunch),
  };
  const recorded = {
    command_marker: { direct: has(direct, M.command), launch: has(launched, M.command), bare: has(bare, M.command), driver: has(driverRun, M.command) },
    skill_by_name: { direct: has(direct, `${NAME}:notes`), launch: has(launched, `${NAME}:notes`), bare: has(bare, `${BARE}:notes`), driver: has(driverRun, `${NAME}:notes`) },
    command_by_name: { direct: has(direct, `${NAME}:hs-bench-hello`), launch: has(launched, `${NAME}:hs-bench-hello`), driver: has(driverRun, `${NAME}:hs-bench-hello`) },
    off_direct_loads: { skill: has(offDirect, `${OFF}:notes`) || has(offDirect, M.skill), server: offDirect.probe?.started === true, hook: offDirect.hook },
    folder_direct_loads: { skill: has(folderDirect, `${NAME}:notes`) || has(folderDirect, M.skill), server: folderDirect.probe?.started === true, hook: folderDirect.hook },
  };
  const reached = [control, direct, launched, bare, driverRun, removedRun, offDirect, offLaunch, folderDirect, folderLaunch].every((r) => r.seen.ENDPOINT.length > 0);
  const positive = 'direct: the package passed by hand with --plugin-dir loads whole: skill, server and hook (positive control)';
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : !checks[positive] ? 'inconclusive: the positive control did not load' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: a claude-plugin package delivered whole by hs on Claude Code, at launch and under materialize (design note v0.2 §5.7, §12 row 18)',
    at: new Date().toISOString(),
    evidence: evidence(b, claude),
    runs: { control: shape(control), direct: shape(direct), launch: shape(launched), bare: shape(bare), driver: shape(driverRun), removed: shape(removedRun), off_direct: shape(offDirect), off_launch: shape(offLaunch), folder_direct: shape(folderDirect), folder_launch: shape(folderLaunch) },
    recorded,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 claude-plugin check on Claude Code failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
