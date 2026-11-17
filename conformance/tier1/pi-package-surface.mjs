#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.6, §5.7, §8), on pi. It starts the real harness, so it
// runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/pi-package-surface.mjs --pi <path> [--hs-rev <sha>] [--keep]
//
// A recording check ahead of delivering pi's own package format: what a pi package's extension can
// do beside hs's launch extension and its guard. pi runs handlers "in extension load order, then
// registration order"; later tool_call handlers "see mutations made by earlier handlers" (the 1.5.2
// package: docs/extensions.md, Handler Composition, tool_call). The package, passed by hand with -e,
// has an extension that:
//   - on tool_call, logs what it saw beside hs's guard, rewrites a command marked MUTATEME, and
//     answers { block: false } to one marked DENYME;
//   - registers a tool of its own, pkg_echo;
//   - on before_agent_start, appends a marker to the system prompt;
//   - on resources_discover, adds a skill path;
//   - on session_start, records whether the endpoint key variable is set (presence only; the key is
//     a dummy).
// hs's own launch carries a PreToolUse guard on every tool, which logs what it saw and blocks
// DENYME. The model is scripted (no real model turns): touch allowed, touch DENYME, touch MUTATEME,
// pkg_echo, then an answer. The network is refused. Runs:
//   after       the package's -e after hs's launch extension
//   before      the package's -e before it
//   noskills    as after, with --no-skills
//   deps        a second package whose extension imports a dependency it declares but does not
//               bundle (recorded)
//   bundled     a package whose extension imports a dependency bundled in its node_modules
//               (recorded)
//   silent      a package whose extension writes a file when it loads and another on
//               before_agent_start, with no tool call, loaded before hs's extension so hs's guard
//               runs last: the files are written and the guard sees nothing
// Then hs's own route for the format (milestone 8.5), each launch hs's launch-spec run as a caller
// runs it, with no tool call scripted:
//   driver      a spec with a pi package (an extension that writes a file when it loads, importing a
//               dependency bundled in its node_modules; a skill) and a PostToolUse hook: it loads
//   refused     the same package beside a PreToolUse guard, and under strict isolation: refused by
//               launch-spec, naming the package (and the hook)
//   strict_ok   a skills-only package under strict isolation: its skill reaches the model
//   planned     after plan and apply, a start through hs's launch for a plain layer: it loads from
//               the folder's settings.json packages; hs's launch for the package skips it
//   removed     after remove, a start: it does not load
// Names and booleans only.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DUMMY, REF_VAR, bench, evidence, guard } from '../lib/bench.mjs';

const pi = guard('pi-package-surface.mjs', '--pi');
const PROMPT = 'tier 1 pi package surface check';
const M = { prompt: 'hs-tier1-pks-prompt-41c7', skill: 'hs-tier1-pks-skill-9e02', echo: 'hs-tier1-pks-echo-6ab3', guard: 'hs-tier1-pks-guard-d150' };
const b = bench('hs-tier1-pi-package-');

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
const suffix = (cmd) => String(cmd).split('.').pop();

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
  const ran = path.join(b.work, 'ran');
  const order = path.join(b.work, 'order.log');
  const keySeen = path.join(b.work, 'key-seen.json');

  // hs's side: a spec with an endpoint and a PreToolUse guard on every tool.
  const kit = path.join(b.work, 'kit');
  put(path.join(kit, 'guard.mjs'), `import fs from 'node:fs';
const e = JSON.parse(fs.readFileSync(0, 'utf8'));
const cmd = String(e.hs?.tool?.input?.command ?? '');
fs.appendFileSync(${JSON.stringify(order)}, 'hs ' + (e.hs?.tool?.name ?? '?') + ' ' + (cmd ? cmd.split('.').pop() : '-') + '\\n');
if (cmd.includes('DENYME')) { process.stderr.write(${JSON.stringify(M.guard)}); process.exit(2); }
process.exit(0);
`);
  put(path.join(kit, 'spec.toml'), ['[spec]', 'name = "kit"', 'version = "1.0.0"', 'format = "0.2"', '', '[model.roles]', 'primary = "bench-primary"', '',
    '[hook.guard]', 'event = "PreToolUse"', `run = { exec = ${JSON.stringify(process.execPath)}, args = ["guard.mjs"] }`, 'timeout = 5', ''].join('\n'));

  // The package: a manifest declaring one extension; the skill it adds at runtime lives outside it.
  const discovered = path.join(b.work, 'discovered-skills');
  put(path.join(discovered, 'found', 'SKILL.md'), `---\nname: found\ndescription: A skill an extension adds at runtime. ${M.skill}\n---\nUse it.\n`);
  const pkg = path.join(b.work, 'pkg');
  put(path.join(pkg, 'package.json'), { name: 'hs-bench-pkg', version: '1.0.0', pi: { extensions: ['./ext.js'], skills: [], prompts: [], themes: [] } });
  put(path.join(pkg, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0]\n\n- first\n');
  put(path.join(pkg, 'ext.js'), `import { appendFileSync, writeFileSync } from 'node:fs';
import { Type } from 'typebox';
export default function (pi) {
  pi.on('tool_call', async (event) => {
    const cmd = String(event?.input?.command ?? '');
    appendFileSync(${JSON.stringify(order)}, 'pkg ' + (event?.toolName ?? event?.name ?? '?') + ' ' + (cmd ? cmd.split('.').pop() : '-') + '\\n');
    if (cmd.includes('MUTATEME')) event.input.command = cmd.replace('MUTATEME', 'MUTATED');
    if (cmd.includes('DENYME')) return { block: false };
  });
  pi.registerTool({
    name: 'pkg_echo', label: 'Echo', description: 'A bench tool of the package.',
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: ${JSON.stringify(M.echo)} }], details: {} }; },
  });
  pi.on('before_agent_start', async (event) => ({ systemPrompt: event.systemPrompt + ' ' + ${JSON.stringify(M.prompt)} }));
  pi.on('resources_discover', async () => ({ skillPaths: [${JSON.stringify(discovered)}] }));
  pi.on('session_start', async () => {
    writeFileSync(${JSON.stringify(keySeen)}, JSON.stringify({ key_set: typeof process.env.HS_ENDPOINT_KEY === 'string' && process.env.HS_ENDPOINT_KEY.length > 0 }));
  });
}
`);
  // Two packages for dependencies: one declaring a dependency it does not bundle, one bundling it.
  const depOut = (n) => path.join(b.work, `dep-${n}.loaded`);
  const depPkg = (dir, n, bundle) => {
    put(path.join(dir, 'package.json'), { name: `hs-bench-${n}`, version: '1.0.0', dependencies: { 'hs-bench-dep': '1.0.0' }, pi: { extensions: ['./ext.js'], skills: [], prompts: [], themes: [] } });
    put(path.join(dir, 'ext.js'), `import { writeFileSync } from 'node:fs';\nimport dep from 'hs-bench-dep';\nexport default function () {\n  writeFileSync(${JSON.stringify(depOut(n))}, String(dep));\n}\n`);
    if (bundle) {
      put(path.join(dir, 'node_modules', 'hs-bench-dep', 'package.json'), { name: 'hs-bench-dep', version: '1.0.0', type: 'module', main: 'index.js' });
      put(path.join(dir, 'node_modules', 'hs-bench-dep', 'index.js'), 'export default "bundled";\n');
    }
    return dir;
  };
  // A package that acts with no tool call at all.
  const silentOut = (n) => path.join(b.work, `silent-${n}.written`);
  const silent = path.join(b.work, 'pkg-silent');
  put(path.join(silent, 'package.json'), { name: 'hs-bench-silent', version: '1.0.0', pi: { extensions: ['./ext.js'], skills: [], prompts: [], themes: [] } });
  put(path.join(silent, 'ext.js'), `import { writeFileSync } from 'node:fs';\nexport default function (pi) {\n  writeFileSync(${JSON.stringify(silentOut('load'))}, 'x');\n  pi.on('before_agent_start', async () => { writeFileSync(${JSON.stringify(silentOut('turn'))}, 'x'); });\n}\n`);
  const missing = depPkg(path.join(b.work, 'pkg-missing'), 'missing', false);
  const bundled = depPkg(path.join(b.work, 'pkg-bundled'), 'bundled', true);

  const steps = [
    { when: { tool: 'bash' }, reply: { tool_calls: [{ id: 'c1', name: 'bash', args: { command: `touch ${ran}.allowed` } }] } },
    { when: { after_tool: 'c1' }, reply: { tool_calls: [{ id: 'c2', name: 'bash', args: { command: `touch ${ran}.DENYME` } }] } },
    { when: { after_tool: 'c2' }, reply: { tool_calls: [{ id: 'c3', name: 'bash', args: { command: `touch ${ran}.MUTATEME` } }] } },
    { when: { after_tool: 'c3' }, reply: { tool_calls: [{ id: 'c4', name: 'pkg_echo', args: {} }] } },
    { when: { after_tool: 'c4' }, reply: { text: 'done' } },
  ];
  const local = path.join(b.work, 'local.toml');
  const run = async (variant, { place = 'after', extra = [], packages = [pkg], script = true } = {}) => {
    const from = hosts.length;
    for (const f of [order, keySeen, `${ran}.allowed`, `${ran}.DENYME`, `${ran}.MUTATEME`, `${ran}.MUTATED`]) fs.rmSync(f, { force: true });
    const L = await b.model('ENDPOINT', { markers: Object.values(M), ...(script ? { steps } : {}), fallback: { text: 'done' } });
    put(local, `[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
    const folder = path.join(b.work, `pi-${variant}`);
    fs.mkdirSync(folder, { recursive: true });
    const args = ['--harness', 'pi', '--folder', folder, '--layer', kit, '--local', local, '--bin', pi, '--headless'];
    const refused = b.hsCall('launch-spec', args);
    const items = refused.ok ? [] : refused.error.items ?? [];
    const receipt = path.join(b.work, `receipt-${variant}.json`);
    put(receipt, { format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((x) => x.item))], by: 'tier1-bench', at: new Date().toISOString() });
    const spec = b.hs('launch-spec', [...args, '--receipt', receipt]);
    const env = { ...spec.env_set, ...viaProxy };
    for (const [v, ref] of Object.entries(spec.env_from_refs)) {
      if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
      env[v] = DUMMY;
    }
    for (const v of spec.env_unset) env[v] = undefined;
    const pkgArgs = packages.flatMap((p) => ['-e', p]);
    const tail = spec.argv.slice(1);
    const argv = place === 'before' ? [pi, ...pkgArgs, ...tail] : [pi, ...tail, ...pkgArgs];
    const before = names(folder);
    const r = await b.launch([L], [...argv, ...extra, PROMPT], env, cwd);
    if (spec.temp_dir) fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    const seen = r.seen.ENDPOINT;
    return {
      exit: r.exit, timed_out: r.timed_out, requests: seen.length,
      order: fs.existsSync(order) ? fs.readFileSync(order, 'utf8').trim().split('\n').filter(Boolean) : [],
      ran: { allowed: fs.existsSync(`${ran}.allowed`), denied: fs.existsSync(`${ran}.DENYME`), unmutated: fs.existsSync(`${ran}.MUTATEME`), mutated: fs.existsSync(`${ran}.MUTATED`) },
      prompt_marker: seen.some((q) => q.markers.includes(M.prompt)),
      skill_marker: seen.some((q) => q.markers.includes(M.skill)),
      echo_offered: seen.some((q) => (q.tools ?? []).includes('pkg_echo')),
      echo_result: seen.some((q) => q.markers.includes(M.echo) && (q.tool_results ?? []).length > 0),
      key: fs.existsSync(keySeen) ? JSON.parse(fs.readFileSync(keySeen, 'utf8')) : null,
      dep: { missing: fs.existsSync(depOut('missing')), bundled: fs.existsSync(depOut('bundled')) },
      silent: { at_load: fs.existsSync(silentOut('load')), before_agent_start: fs.existsSync(silentOut('turn')) },
      folder_added: names(folder).filter((n) => !before.includes(n) && !n.startsWith('sessions')),
      hosts: [...new Set(hosts.slice(from))].sort(),
    };
  };

  const runs = {};
  runs.after = await run('after');
  runs.before = await run('before', { place: 'before' });
  runs.noskills = await run('noskills', { extra: ['--no-skills'] });
  runs.deps = await run('deps', { packages: [missing], script: false });
  runs.bundled = await run('bundled', { packages: [bundled], script: false });
  runs.silent = await run('silent', { place: 'before', packages: [silent], script: false });

  // hs's own route. A run with hs's launch for `layer` in `folder`, no package added by hand.
  const loadedOut = path.join(b.work, 'route.loaded');
  const routeRun = async (variant, layer, folder) => {
    const from = hosts.length;
    fs.rmSync(loadedOut, { force: true });
    const L = await b.model('ENDPOINT', { markers: Object.values(M), fallback: { text: 'done' } });
    put(local, `[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
    const args = ['--harness', 'pi', '--folder', folder, '--layer', layer, '--local', local, '--bin', pi, '--headless'];
    const refused = b.hsCall('launch-spec', args);
    if (!refused.ok && refused.error.code !== 'receipt_required') return { refused: refused.error.code, items: refused.error.items ?? [], hosts: [] };
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
    const r = await b.launch([L], [pi, ...spec.argv.slice(1), PROMPT], env, cwd);
    if (spec.temp_dir) fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    const seen = r.seen.ENDPOINT;
    return {
      exit: r.exit, requests: seen.length, receipt_needed: !refused.ok,
      item: spec.launch_items.some((i) => i.item === 'plugin.tools') ? 'carried' : spec.skipped.some((x) => x.item === 'plugin.tools') ? 'skipped' : null,
      loaded: fs.existsSync(loadedOut) ? fs.readFileSync(loadedOut, 'utf8') : null,
      skill_reached: seen.some((q) => q.markers.includes(M.skill)),
      hosts: [...new Set(hosts.slice(from))].sort(),
    };
  };
  const routePkg = (dir, { extensions = true } = {}) => {
    put(path.join(dir, 'package.json'), { name: 'tools', version: '1.0.0', ...(extensions ? { dependencies: { 'hs-bench-dep': '1.0.0' } } : {}), pi: { extensions: extensions ? ['./ext.js'] : [], skills: ['./skills'], prompts: [], themes: [] } });
    put(path.join(dir, 'skills', 'notes', 'SKILL.md'), `---\nname: notes\ndescription: A packaged skill. ${M.skill}\n---\nUse it.\n`);
    if (extensions) {
      put(path.join(dir, 'ext.js'), `import { writeFileSync } from 'node:fs';\nimport dep from 'hs-bench-dep';\nexport default function () {\n  writeFileSync(${JSON.stringify(loadedOut)}, String(dep));\n}\n`);
      put(path.join(dir, 'node_modules', 'hs-bench-dep', 'package.json'), { name: 'hs-bench-dep', version: '1.0.0', type: 'module', main: 'index.js' });
      put(path.join(dir, 'node_modules', 'hs-bench-dep', 'index.js'), 'export default "bundled";\n');
    }
  };
  const routeLayer = (name, { hook = null, strict = false, extensions = true, pkg: withPkg = true } = {}) => {
    const dir = path.join(b.work, `route-${name}`);
    if (withPkg) routePkg(path.join(dir, 'packages', 'tools'), { extensions });
    put(path.join(dir, 'spec.toml'), [...(strict ? ['isolation = "strict"', ''] : []), '[spec]', `name = "route-${name}"`, 'version = "1.0.0"', 'format = "0.2"', '', '[model.roles]', 'primary = "bench-primary"', '',
      ...(withPkg ? ['[plugin."tools"]', 'source = "packages/tools"', 'format = "pi-package"', ''] : []),
      ...(hook ? [`[hook.${hook === 'PreToolUse' ? 'guard' : 'after'}]`, `event = "${hook}"`, 'run = { exec = "/bin/true" }', ''] : [])].join('\n'));
    return dir;
  };
  const rf = (n) => { const f = path.join(b.work, `route-folder-${n}`); fs.mkdirSync(f, { recursive: true }); return f; };
  runs.driver = await routeRun('driver', routeLayer('driver', { hook: 'PostToolUse' }), rf('driver'));
  runs.refused_guard = await routeRun('refused-guard', routeLayer('guard', { hook: 'PreToolUse' }), rf('guard'));
  runs.refused_strict = await routeRun('refused-strict', routeLayer('strict', { strict: true }), rf('strict'));
  runs.strict_ok = await routeRun('strict-ok', routeLayer('strict-ok', { strict: true, extensions: false }), rf('strict-ok'));
  const pf = rf('planned');
  const planLayer = routeLayer('planned');
  const common = ['--harness', 'pi', '--folder', pf, '--bin', pi];
  const plan = b.hs('plan', [...common, '--layer', planLayer, '--local', local, '--owner', 'tier1', '--mode', 'materialize']);
  const planFile = path.join(b.work, 'plan.json');
  put(planFile, plan);
  const planReceipt = path.join(b.work, 'receipt-plan.json');
  put(planReceipt, { format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench', at: new Date().toISOString() });
  b.hs('apply', [...common, '--plan', planFile, '--receipt', planReceipt]);
  runs.planned = { ...(await routeRun('planned', routeLayer('plain', { pkg: false }), pf)), planned: plan.operations.map((o) => o.address_id).sort() };
  runs.planned_skip = await routeRun('planned-skip', planLayer, pf);
  b.hs('remove', [...common, '--owner', 'tier1']);
  runs.removed = await routeRun('removed', routeLayer('plain2', { pkg: false }), pf);
  proxy.close();
  proxy = null;

  const A = runs.after;
  const B = runs.before;
  const checks = {
    'premise: hs\'s launch with the package reaches the model, its guard logs every shell call, and the package\'s extension loads': A.requests > 0 && A.order.some((l) => l.startsWith('hs ')) && A.order.some((l) => l.startsWith('pkg ')),
    'the guard holds against an answer of { block: false }: the denied command never runs, in either load order': !A.ran.denied && !B.ran.denied,
    'a package\'s extension acts with no tool call: with hs\'s guard loaded last, it writes a file at load and another before the agent starts, and the guard sees nothing': runs.silent.requests > 0 && runs.silent.silent.at_load && runs.silent.silent.before_agent_start && runs.silent.order.length === 0,
    'driver: hs\'s launch carries the package under a receipt; its extension loads, importing its bundled dependency, and its skill reaches the model': runs.driver.receipt_needed && runs.driver.item === 'carried' && runs.driver.loaded === 'bundled' && runs.driver.skill_reached,
    'refused: beside a PreToolUse guard the package with extensions is refused, naming the package and the hook; under strict isolation it is isolation_unmet': runs.refused_guard.refused === 'item_unsupported' && runs.refused_guard.items.includes('plugin.tools') && runs.refused_guard.items.includes('hook.guard') && runs.refused_strict.refused === 'isolation_unmet',
    'strict_ok: under strict isolation a skills-only package is carried, and its skill reaches the model': runs.strict_ok.item === 'carried' && runs.strict_ok.skill_reached,
    'planned: plan writes the copy and the settings.json packages member; a start with no -e loads the package; hs\'s launch for it then skips it': JSON.stringify(runs.planned.planned) === JSON.stringify(['hs-run/pipkg.tools', 'settings.json#packages[pipkg.tools]']) && runs.planned.loaded === 'bundled' && runs.planned.skill_reached && runs.planned_skip.item === 'skipped',
    'removed: after hs remove a start loads neither the extension nor the skill': runs.removed.requests > 0 && runs.removed.loaded === null && !runs.removed.skill_reached,
    'no host is asked for in any run': Object.values(runs).every((r) => r.hosts.length === 0),
  };
  const verdict = !checks[Object.keys(checks)[0]] ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: what a pi package\'s extension can do beside hs\'s launch extension and guard, ahead of delivering pi packages (design note v0.2 §5.6, §5.7, §8)',
    at: new Date().toISOString(),
    evidence: evidence(b, pi),
    runs,
    recorded: {
      order_after: A.order, order_before: B.order,
      mutation_after_guard_runs: A.ran.mutated && A.order.some((l) => l === 'hs bash MUTATEME'),
      guard_sees_mutation_when_first: B.order.some((l) => l === 'hs bash MUTATED'),
      package_tool_reaches_guard: A.order.some((l) => l.startsWith('hs pkg_echo')),
      package_tool_runs: A.echo_result,
      system_prompt_changed: A.prompt_marker,
      runtime_skill: { default: A.skill_marker, no_skills: runs.noskills.skill_marker },
      key_variable_visible: A.key?.key_set ?? null,
      dependency: { missing_loaded: runs.deps.dep.missing, missing_run_reached_model: runs.deps.requests > 0, bundled_loaded: runs.bundled.dep.bundled },
      folder_added: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, r.folder_added])),
    },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>').split(proxyUrl).join('<PROXY>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 pi package surface check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (proxy) proxy.close();
  if (!(await b.finish())) process.exitCode = 4;
}
