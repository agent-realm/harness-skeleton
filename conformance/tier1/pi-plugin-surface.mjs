#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.7), on pi. It starts the real harness, so it runs only on
// a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/pi-plugin-surface.mjs --pi <path> [--hs-rev <sha>] [--keep]
//
// A recording check ahead of delivering Agent Plugins packages to pi: how pi 1.5 loads a local pi
// package (the 1.5.2 package docs: packages; dist/core/package-manager.js), the native unit a
// translation would produce. The package is built by hand, as the translation would build it:
//   package.json   a `pi` manifest declaring only ./package/skills and one extension, ./hs-plugin.js
//   hs-plugin.js   registers a stdio MCP server, `probe`, and on session_start records which prompt
//                  templates and skills pi lists (pi.getCommands(), names only)
//   package/       the Agent Plugins package's place: a skill (marker), and code and resources the
//                  manifest does not declare: extensions/undeclared.js (creates a file if it loads),
//                  prompts/, themes/
//   extensions/, prompts/   the same undeclared kinds at the package's own root, which a manifest
//                  that lists resources turns off
// Each run is hs's own launch for a plain spec (an endpoint, the primary model), run as a caller
// runs it, plus the package where the run says; the model is scripted (it calls the MCP tool, then
// answers), the key a dummy, the network refused. Runs:
//   control    no package: what pi writes into the folder on its own
//   elocal     the package passed with -e <dir>
//   settings   the package inside the folder, named in its settings.json `packages`, no -e
//   extdir     the package as a directory in the folder's extensions/, no -e: recorded
//   noskills   as elocal, with --no-skills: recorded
//   static     hs's launch-spec for a spec with an MCP server: every -e value it passes
// Names and booleans only.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DUMMY, REF_VAR, bench, evidence, guard } from '../lib/bench.mjs';
import { probe, serverSource } from '../lib/agent-plugins.mjs';

const pi = guard('pi-plugin-surface.mjs', '--pi');
const PROMPT = 'tier 1 pi plugin surface check';
const M = { skill: 'hs-tier1-pps-skill-58e1', mcpTool: 'hs-tier1-pps-tool-c4a0' };
const TOOL = 'mcp__probe__ping';
const b = bench('hs-tier1-pi-plugin-');

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

// The package, built at `dir`; `out(name)` is where its probes write.
function writeWrapper(dir, out) {
  const cfg = { node: process.execPath, server: path.join(dir, 'package', 'server.mjs'), root: path.join(dir, 'package'), mcpOut: out('mcp'), listOut: out('list') };
  put(path.join(dir, 'package.json'), { name: 'hs-probe-wrapper', version: '1.0.0', pi: { skills: ['./package/skills'], extensions: ['./hs-plugin.js'] } });
  put(path.join(dir, 'hs-plugin.js'), `import { writeFileSync } from 'node:fs';
const CFG = ${JSON.stringify(cfg)};
export default function (pi) {
  pi.registerMcpServer('probe', { command: CFG.node, args: [CFG.server], env: { HS_PROBE_OUT: CFG.mcpOut }, cwd: CFG.root, exposure: 'direct' });
  pi.on('session_start', async () => {
    const cmds = pi.getCommands();
    writeFileSync(CFG.listOut, JSON.stringify({ prompts: cmds.filter((c) => c.source === 'prompt').map((c) => c.name).sort(), skills: cmds.filter((c) => c.source === 'skill').map((c) => c.name).sort() }));
  });
}
`);
  put(path.join(dir, 'package', 'skills', 'wskill', 'SKILL.md'), `---\nname: wskill\ndescription: ${M.skill}\n---\nA bench skill.\n`);
  put(path.join(dir, 'package', 'server.mjs'), serverSource('ping', M.mcpTool));
  const loaded = (name) => `import { writeFileSync } from 'node:fs';\nexport default function () {\n  writeFileSync(${JSON.stringify(out(name))}, 'loaded');\n}\n`;
  put(path.join(dir, 'package', 'extensions', 'undeclared.js'), loaded('package-ext'));
  put(path.join(dir, 'package', 'prompts', 'pkgprompt.md'), '---\ndescription: an undeclared prompt\n---\nUndeclared.\n');
  put(path.join(dir, 'package', 'themes', 'pkgtheme.json'), { name: 'hs-undeclared-theme' });
  put(path.join(dir, 'extensions', 'rootundeclared.js'), loaded('root-ext'));
  put(path.join(dir, 'prompts', 'rootprompt.md'), '---\ndescription: an undeclared root prompt\n---\nUndeclared.\n');
}

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
  const plain = path.join(b.work, 'plain');
  put(path.join(plain, 'spec.toml'), '[spec]\nname = "plain"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');

  const run = async (variant, { place = null, extra = [] } = {}) => {
    const from = hosts.length;
    const out = (n) => path.join(b.work, `out-${variant}-${n}`);
    const steps = [
      { when: { tool: TOOL }, reply: { tool_calls: [{ id: 'call_ping', name: TOOL, args: {} }] } },
      { when: { after_tool: 'call_ping' }, reply: { text: 'done' } },
    ];
    const L = await b.model('ENDPOINT', { markers: Object.values(M), steps, fallback: { text: 'done' } });
    const folder = path.join(b.work, `pi-${variant}`);
    fs.mkdirSync(folder, { recursive: true });
    let wrapperArgs = [];
    if (place === 'e') {
      const dir = path.join(b.work, `wrapper-${variant}`);
      writeWrapper(dir, out);
      wrapperArgs = ['-e', dir];
    } else if (place === 'settings') {
      writeWrapper(path.join(folder, 'hs-run', 'plugin.probe'), out);
      put(path.join(folder, 'settings.json'), { packages: ['./hs-run/plugin.probe'] });
    } else if (place === 'extdir') {
      writeWrapper(path.join(folder, 'extensions', 'hs-probe-wrapper'), out);
    }
    const before = names(folder);
    const local = path.join(b.work, `local-${variant}.toml`);
    put(local, `[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
    const spec = b.hs('launch-spec', ['--harness', 'pi', '--folder', folder, '--layer', plain, '--local', local, '--bin', pi, '--headless']);
    const env = { ...spec.env_set, ...viaProxy };
    for (const [v, ref] of Object.entries(spec.env_from_refs)) {
      if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
      env[v] = DUMMY;
    }
    for (const v of spec.env_unset) env[v] = undefined;
    const r = await b.launch([L], [pi, ...spec.argv.slice(1), ...wrapperArgs, ...extra, PROMPT], env, cwd);
    if (spec.temp_dir) fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    const seen = r.seen.ENDPOINT;
    const list = probe(out('list'));
    return {
      exit: r.exit, timed_out: r.timed_out, requests: seen.length,
      skill_reached: seen.some((q) => q.markers.includes(M.skill)),
      declared_extension: list !== null,
      listed: list,
      undeclared_extension: { package: fs.existsSync(out('package-ext')), root: fs.existsSync(out('root-ext')) },
      mcp: { started: probe(out('mcp'))?.started === true, offered: seen.some((q) => (q.tools ?? []).includes(TOOL)), result_reached: seen.some((q) => q.markers.includes(M.mcpTool) && (q.tool_results ?? []).length > 0) },
      folder_added: names(folder).filter((n) => !before.includes(n) && !n.startsWith('sessions')),
      hosts: [...new Set(hosts.slice(from))].sort(),
    };
  };

  const runs = {};
  runs.control = await run('control');
  runs.elocal = await run('elocal', { place: 'e' });
  runs.settings = await run('settings', { place: 'settings' });
  runs.extdir = await run('extdir', { place: 'extdir' });
  runs.noskills = await run('noskills', { place: 'e', extra: ['--no-skills'] });

  // static: hs's own launch for a spec with an MCP server passes its generated extension with -e.
  const kit = path.join(b.work, 'kit');
  put(path.join(kit, 'spec.toml'), ['[spec]', 'name = "kit"', 'version = "1.0.0"', 'format = "0.2"', '', '[mcp.probe]', `exec = ${JSON.stringify(process.execPath)}`, 'args = ["--version"]', ''].join('\n'));
  const sFolder = path.join(b.work, 'pi-static');
  fs.mkdirSync(sFolder);
  const refused = b.hsCall('launch-spec', ['--harness', 'pi', '--folder', sFolder, '--layer', kit, '--bin', pi, '--headless']);
  const items = refused.ok ? [] : refused.error.items ?? [];
  const receipt = path.join(b.work, 'receipt-static.json');
  put(receipt, { format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((x) => x.item))], by: 'tier1-bench', at: new Date().toISOString() });
  const sSpec = b.hs('launch-spec', ['--harness', 'pi', '--folder', sFolder, '--layer', kit, '--bin', pi, '--headless', '--receipt', receipt]);
  const eValues = sSpec.argv.flatMap((a, i) => (a === '-e' || a === '--extension' ? [sSpec.argv[i + 1]] : []));
  runs.static = {
    e_values: eValues.length,
    all_local_in_temp: eValues.length > 0 && eValues.every((v) => path.isAbsolute(v) && v.startsWith(sSpec.temp_dir + path.sep)),
    remote_source_in_argv: sSpec.argv.some((a) => /^(npm|git):|^https?:\/\//.test(a)),
  };
  if (sSpec.temp_dir) fs.rmSync(sSpec.temp_dir, { recursive: true, force: true });
  proxy.close();
  proxy = null;

  const C = runs.control;
  const E = runs.elocal;
  const S = runs.settings;
  const undeclaredNone = (r) => !r.undeclared_extension.package && !r.undeclared_extension.root && (r.listed?.prompts ?? []).length === 0;
  const mcpOk = (r) => r.mcp.started && r.mcp.offered && r.mcp.result_reached;
  const checks = {
    'control: hs\'s launch for a plain spec reaches the model, with no marker (premise)': C.requests > 0 && !C.skill_reached && !C.declared_extension,
    'elocal: with -e <dir>, the declared skill reaches the model and the declared extension loads; neither undeclared extension loads and no undeclared prompt is listed': E.skill_reached && E.declared_extension && undeclaredNone(E),
    'elocal: the declared extension\'s MCP server starts, its tool is offered, and its result reaches the model': mcpOk(E),
    'settings: named in the folder\'s settings.json packages, the package loads at a start with no -e, the same way': S.skill_reached && S.declared_extension && undeclaredNone(S) && mcpOk(S),
    'static: every -e value hs passes is an absolute path inside its own temp dir, and no argv element is an npm, git or URL source': runs.static.all_local_in_temp && !runs.static.remote_source_in_argv,
    'no host is asked for in any run': Object.values(runs).filter((r) => r.hosts).every((r) => r.hosts.length === 0),
  };
  const verdict = !checks[Object.keys(checks)[0]] ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: how pi loads a local package, ahead of translating Agent Plugins packages into one (design note v0.2 §5.7)',
    at: new Date().toISOString(),
    evidence: evidence(b, pi),
    runs,
    recorded: {
      extdir: { declared_extension: runs.extdir.declared_extension, skill_reached: runs.extdir.skill_reached, undeclared: runs.extdir.undeclared_extension },
      noskills: { skill_reached: runs.noskills.skill_reached, listed_skills: runs.noskills.listed?.skills ?? null },
      folder_added: Object.fromEntries(Object.entries(runs).filter(([, r]) => r.folder_added).map(([k, r]) => [k, r.folder_added])),
      themes: 'not observable in JSON mode; the manifest rule covers all four resource kinds alike (dist/core/package-manager.js, collectPackageResources)',
    },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>').split(proxyUrl).join('<PROXY>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 pi plugin surface check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (proxy) proxy.close();
  if (!(await b.finish())) process.exitCode = 4;
}
