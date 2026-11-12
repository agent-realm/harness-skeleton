#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §4, §5, §7.5, §8), on pi. It starts the real harness, so it runs
// only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/pi-launch-surface.mjs --pi <path> [--hs-rev <sha>] [--keep]
//
// A recording check ahead of a pi driver (milestone 8.1): what a launch can carry with nothing written
// into the folder, so each launch is built here by hand as a driver would build it. pi 1.5.x keeps one
// root, PI_CODING_AGENT_DIR (default ~/.pi/agent), and loads an extension passed with -e before startup
// continues: a provider it registers is there for model selection, and an MCP server it registers is
// the session's (the 1.5.2 package docs: configuration, extensions, custom-provider, mcp). Each run has
// a folder of its own as the root, a scratch HOME, and pi's network through a local proxy that
// records the host names it is asked for and refuses them; the model on loopback stays off the proxy.
// The model is scripted (openai-completions). Runs:
//   control      an -e extension registering provider `hs` with apiKey "$HS_BENCH_PI_KEY", --provider
//                hs --model bench-primary, a --skill and an --append-system-prompt file, pi's offline
//                switches on (PI_OFFLINE, PI_SKIP_VERSION_CHECK, PI_TELEMETRY=0). Expected: the model is
//                reached with the dummy key, the skill and the appended text reach a request, the
//                folder's AGENTS.md does and the default root's does not, sessions land in the folder,
//                and no host is asked for. The escapes are judged as known limits: ~/.agents/skills and
//                an ancestor AGENTS.md reach a request; the project's trust-gated .pi/ does not in JSON
//                mode. Recorded: what pi writes under HOME, and whether a cwd AGENTS.md reaches.
//   online       the same with the offline switches off: the hosts pi asks for (recorded), and that the
//                explicit provider still reaches the model.
//   mcp_direct   the extension registers a stdio MCP server with exposure "direct" and a ${HS_REF_…}
//                value in its env. Expected: it starts, the value expanded, and its tool is offered as
//                mcp__probe__ping.
//   mcp_default  the same with no exposure: the tools a request is offered (recorded).
//   mcp_folder   the folder's mcp.json defines a server named like the extension's: which one starts
//                (recorded; the docs say the file's wins).
//   carriers     where pi interpolates or executes text: a leading `!command` and a ${VAR} in the
//                provider's apiKey and headers, in an MCP server's env and args, and in a remote MCP
//                server's headers. Each `!command` touches a file of its own, so a run shows which ran;
//                the apiKey's runs on its own (carrier_key), since a key that resolves to nothing may
//                stop pi before the headers are resolved.
//                Judged: pi runs a leading `!command` in the apiKey, a provider header and an MCP env
//                value, and expands ${VAR} in a provider header and an MCP env value: the premises for
//                refusing such spec text. Recorded: the rest.
//   broken       an -e extension that does not parse, beside the provider's (recorded): whether pi
//                starts, and reaches the model.
//   hooks        the extension's tool_call handler blocks one bash command and throws for another
//                (recorded, ahead of hooks): neither runs, and whether their reasons reach the model.
// Names, booleans and counts only. The credential is a dummy.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { OTHER, OTHER_VALUE, serverSource } from '../lib/agent-plugins.mjs';
import { DUMMY, bench, evidence, guard } from '../lib/bench.mjs';

const pi = guard('pi-launch-surface.mjs', '--pi');
const PROMPT = 'tier 1 pi launch-surface check';
const M = {
  skill: 'hs-tier1-pi-skill-5d1a', append: 'hs-tier1-pi-append-8c2f', folderAgents: 'hs-tier1-pi-folder-agents-9b41',
  defaultRoot: 'hs-tier1-pi-default-root-a3c6', agentsSkills: 'hs-tier1-pi-agents-skills-1b7e', ancestor: 'hs-tier1-pi-ancestor-4f90',
  projectPi: 'hs-tier1-pi-project-pi-77d2', cwdAgents: 'hs-tier1-pi-cwd-agents-2e18', mcpTool: 'hs-tier1-pi-mcp-tool-63ad',
  block: 'hs-tier1-pi-block-0c5e', thrown: 'hs-tier1-pi-thrown-d27b', other: OTHER_VALUE,
};
const KEY_VAR = 'HS_BENCH_PI_KEY';
const b = bench('hs-tier1-pi-launch-');

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const skill = (name, mark) => `---\nname: ${name}\ndescription: ${mark}\n---\nA bench skill.\n`;
const names = (dir, depth = 4, rel = '') => {
  if (depth === 0 || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((n) => {
    const p = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    return fs.lstatSync(p).isDirectory() ? [r, ...names(p, depth - 1, r)] : [r];
  });
};
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

// The extension a driver would generate: a provider, MCP servers, and (for the hooks run) a
// tool_call handler. Its configuration is JSON in the source.
const extension = ({ url, apiKey = `$${KEY_VAR}`, headers, mcp = {}, hooks = false }) => `
const PROVIDER = ${JSON.stringify({ name: 'hs bench', baseUrl: `${url}/v1`, apiKey, api: 'openai-completions', ...(headers ? { headers } : {}) })};
const MCP = ${JSON.stringify(mcp)};
export default function (pi) {
  pi.registerProvider('hs', { ...PROVIDER, models: [{ type: 'chat', id: 'bench-primary', name: 'bench-primary', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }] });
  for (const [name, config] of Object.entries(MCP)) pi.registerMcpServer(name, config);
  ${hooks ? `pi.on('tool_call', async (event) => {
    const cmd = String(event?.input?.command ?? '');
    if (cmd.includes('DENYME')) return { block: true, reason: ${JSON.stringify(M.block)} };
    if (cmd.includes('THROWME')) throw new Error(${JSON.stringify(M.thrown)});
  });` : ''}
}
`;

try {
  // A recording proxy that refuses every host: CONNECT and plain requests, host names only.
  const hosts = [];
  const proxy = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    let host = null;
    try {
      host = new URL(req.url).hostname;
    } catch {
      host = (req.headers.host ?? '').split(':')[0] || null;
    }
    hosts.push(host);
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
  const OFFLINE = { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };

  // The escapes, planted once: a skill in ~/.agents/skills, an AGENTS.md in the default root, one in
  // an ancestor of the working directory, one in the working directory, and a trust-gated project
  // .pi/APPEND_SYSTEM.md.
  const home = b.scratch.HOME;
  put(path.join(home, '.agents', 'skills', 'canary', 'SKILL.md'), skill('canary', M.agentsSkills));
  put(path.join(home, '.pi', 'agent', 'AGENTS.md'), `Default root. ${M.defaultRoot}\n`);
  const proj = path.join(b.work, 'proj');
  const cwd = path.join(proj, 'work');
  put(path.join(proj, 'AGENTS.md'), `Ancestor. ${M.ancestor}\n`);
  put(path.join(cwd, 'AGENTS.md'), `Working directory. ${M.cwdAgents}\n`);
  put(path.join(cwd, '.pi', 'APPEND_SYSTEM.md'), `Project. ${M.projectPi}\n`);
  const homeBefore = names(home, 6);

  // What a launch carries, beside the extension.
  const kit = path.join(b.work, 'kit');
  put(path.join(kit, 'skills', 'notes', 'SKILL.md'), skill('notes', M.skill));
  put(path.join(kit, 'APPEND.md'), `Launch instructions. ${M.append}\n`);

  const folderFor = (variant) => {
    const f = path.join(b.work, `pi-${variant}`);
    put(path.join(f, 'AGENTS.md'), `The folder's own. ${M.folderAgents}\n`);
    return f;
  };
  const stamp = (_body, record) => { record.at = Date.now(); };
  const run = async (variant, { ext = {}, extra = [], env = {}, offline = true, steps, folderFiles = {}, extraExtensions = [] } = {}) => {
    const from = hosts.length;
    const L = await b.model('ENDPOINT', { markers: Object.values(M), ...(steps ? { steps } : {}), fallback: { text: 'done' }, inspect: stamp });
    const folder = folderFor(variant);
    for (const [rel, content] of Object.entries(folderFiles)) put(path.join(folder, rel), content);
    const extFile = path.join(b.work, `ext-${variant}`, 'hs-launch.js');
    put(extFile, extension({ url: L.url, ...ext }));
    const argv = [pi, '--mode', 'json', '--provider', 'hs', '--model', 'bench-primary', '-e', extFile, ...extraExtensions.flatMap((e) => ['-e', e]), ...extra, PROMPT];
    const r = await b.launch([L], argv, { PI_CODING_AGENT_DIR: folder, [KEY_VAR]: DUMMY, [OTHER]: OTHER_VALUE, ...viaProxy, ...(offline ? OFFLINE : {}), ...env }, cwd);
    const seen = r.seen.ENDPOINT;
    return {
      exit: r.exit, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: seen.length,
      credential: [...new Set(seen.map((q) => q.credential))],
      markers: Object.entries(M).filter(([, m]) => seen.some((q) => q.markers.includes(m))).map(([k]) => k).sort(),
      tools: [...new Set(seen.flatMap((q) => q.tools ?? []))].filter((t) => typeof t === 'string').sort(),
      tool_results: seen.flatMap((q) => q.tool_results ?? []).length,
      hosts: [...new Set(hosts.slice(from))].sort(),
      folder: names(folder, 3).filter((n) => !n.startsWith('ext-')),
    };
  };

  const runs = {};
  runs.control = await run('control', { extra: ['--skill', path.join(kit, 'skills', 'notes'), '--append-system-prompt', path.join(kit, 'APPEND.md')] });
  const homeAfter = names(home, 6);
  runs.online = await run('online', { offline: false });

  // MCP through the extension.
  const server = path.join(b.work, 'mcp-server.mjs');
  put(server, serverSource('ping', M.mcpTool));
  const probeDir = path.join(b.work, 'probe-dir');
  fs.mkdirSync(probeDir, { recursive: true });
  const mcpCfg = (out, more = {}) => ({ command: process.execPath, args: [server], env: { HS_PROBE_OUT: out, HS_DATA_DIR: '${HS_REF_PROBE}' }, ...more });
  const out = (n) => path.join(b.work, `probe-${n}.json`);
  runs.mcp_direct = await run('mcp-direct', { ext: { mcp: { probe: mcpCfg(out('direct'), { exposure: 'direct' }) } }, env: { HS_REF_PROBE: probeDir } });
  runs.mcp_direct.probe = probe(out('direct'));
  runs.mcp_default = await run('mcp-default', { ext: { mcp: { probe: mcpCfg(out('default')) } }, env: { HS_REF_PROBE: probeDir } });
  runs.mcp_default.probe = probe(out('default'));
  runs.mcp_folder = await run('mcp-folder', {
    ext: { mcp: { probe: mcpCfg(out('folder-ext'), { exposure: 'direct' }) } }, env: { HS_REF_PROBE: probeDir },
    folderFiles: { 'mcp.json': { mcpServers: { probe: { command: process.execPath, args: [server], env: { HS_PROBE_OUT: out('folder-file'), HS_DATA_DIR: probeDir } } } } },
  });
  runs.mcp_folder.started = { extension: fs.existsSync(out('folder-ext')), folder_file: fs.existsSync(out('folder-file')) };

  // Where pi interpolates or executes text. Each !command touches its own file.
  const bang = (n) => path.join(b.work, `bang-${n}`);
  const remote = await b.listener('MCPHTTP', { markers: [OTHER_VALUE] });
  // The apiKey on its own: a key that resolves to nothing may stop pi before any header is resolved.
  runs.carrier_key = await run('carrier-key', { ext: { apiKey: `!touch ${bang('apikey')}` } });
  runs.carriers = await run('carriers', {
    ext: {
      headers: { 'X-HS-Bang': `!touch ${bang('header')}`, 'X-HS-Var': `\${${OTHER}}` },
      mcp: {
        probe: { command: process.execPath, args: [server, `\${${OTHER}}`, `!touch ${bang('args')}`], env: { HS_PROBE_OUT: out('carriers'), HS_LITERAL: `\${${OTHER}}`, HS_BANG: `!touch ${bang('env')}` }, exposure: 'direct' },
        remote: { url: `${remote.url}/mcp`, headers: { 'X-HS-Bang': `!touch ${bang('mcp-header')}`, 'X-HS-Var': `\${${OTHER}}` } },
      },
    },
  });
  const cp = probe(out('carriers'));
  runs.carriers.executed = Object.fromEntries(['apikey', 'header', 'args', 'env', 'mcp-header'].map((n) => [n, fs.existsSync(bang(n))]));
  runs.carriers.expanded = {
    provider_header: runs.carriers.markers.includes('other'),
    mcp_env: cp ? cp.literal_is_other : null,
    mcp_env_kept_literal: cp ? cp.literal_kept : null,
    mcp_args: cp ? cp.args_expanded : null,
    mcp_remote_header: remote.log.some((q) => q.markers.includes(OTHER_VALUE)),
    mcp_remote_reached: remote.log.length > 0,
  };

  // An extension that does not parse, beside the provider's.
  const broken = path.join(b.work, 'broken', 'hs-broken.js');
  put(broken, 'export default function (pi) {\n');
  runs.broken = await run('broken', { extraExtensions: [broken] });

  // tool_call: one bash command allowed, one blocked, one thrown on; then the answer.
  const ran = path.join(b.work, 'ran-hooks');
  runs.hooks = await run('hooks', {
    ext: { hooks: true },
    steps: [
      { when: { tool: 'bash' }, reply: { tool_calls: [{ id: 'call_ok', name: 'bash', args: { command: `touch ${ran}.allowed` } }] } },
      { when: { after_tool: 'call_ok' }, reply: { tool_calls: [{ id: 'call_deny', name: 'bash', args: { command: `touch ${ran}.DENYME` } }] } },
      { when: { after_tool: 'call_deny' }, reply: { tool_calls: [{ id: 'call_throw', name: 'bash', args: { command: `touch ${ran}.THROWME` } }] } },
      { when: { after_tool: 'call_throw' }, reply: { text: 'done' } },
    ],
  });
  runs.hooks.ran = { allowed: fs.existsSync(`${ran}.allowed`), denied: fs.existsSync(`${ran}.DENYME`), thrown: fs.existsSync(`${ran}.THROWME`) };

  const left = benchPids();
  proxy.close();

  const C = runs.control;
  const has = (r, k) => r.markers.includes(k);
  const checks = {
    'control: the extension\'s provider reaches the model with the dummy key, read from "$HS_BENCH_PI_KEY" (premise)': C.requests > 0 && C.credential.length === 1 && C.credential[0] === 'bearer:bench-dummy',
    'control: the --skill and the --append-system-prompt file reach a request': has(C, 'skill') && has(C, 'append'),
    'control: PI_CODING_AGENT_DIR binds the folder: its AGENTS.md reaches a request, the default root\'s does not, and the session lands in its sessions/': has(C, 'folderAgents') && !has(C, 'defaultRoot') && C.folder.some((n) => /^sessions\/.+\.jsonl$/.test(n)),
    'control: with PI_OFFLINE, PI_SKIP_VERSION_CHECK and PI_TELEMETRY=0, no host is asked for': C.hosts.length === 0,
    'known limits: ~/.agents/skills and an ancestor AGENTS.md reach a request; the trust-gated project .pi/ does not, in JSON mode': has(C, 'agentsSkills') && has(C, 'ancestor') && !has(C, 'projectPi'),
    'online: with the offline switches off, the explicit provider still reaches the model': runs.online.requests > 0,
    'mcp_direct: a server the extension registers starts, its ${HS_REF_…} env value expanded, and its tool is offered as mcp__probe__ping': runs.mcp_direct.probe?.started === true && runs.mcp_direct.probe?.data_expanded === true && runs.mcp_direct.tools.includes('mcp__probe__ping'),
    'carriers: pi runs a leading !command in the provider\'s apiKey, a provider header and an MCP env value': runs.carriers.executed.apikey && runs.carriers.executed.header && runs.carriers.executed.env,
    'carriers: pi expands ${VAR} in a provider header and an MCP env value': runs.carriers.expanded.provider_header && runs.carriers.expanded.mcp_env === true,
    'no process with the bench\'s environment is left': left.length === 0,
  };
  const verdict = !checks[Object.keys(checks)[0]] ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: what a pi launch can carry with nothing written into the folder (design note v0.2 §4, §5, §7.5, §8)',
    at: new Date().toISOString(),
    evidence: evidence(b, pi),
    runs,
    recorded: {
      home_written: homeAfter.filter((n) => !homeBefore.includes(n)),
      cwd_agents_reaches: has(C, 'cwdAgents'),
      online_hosts: runs.online.hosts,
      mcp_default_tools: runs.mcp_default.tools,
      mcp_default_started: runs.mcp_default.probe?.started ?? false,
      mcp_folder_started: runs.mcp_folder.started,
      carriers: { executed: runs.carriers.executed, expanded: runs.carriers.expanded },
      broken: { exit: runs.broken.exit, requests: runs.broken.requests },
      hooks: { ran: runs.hooks.ran, block_reason_reached: has(runs.hooks, 'block'), throw_reason_reached: has(runs.hooks, 'thrown'), exit: runs.hooks.exit },
    },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>').split(proxyUrl).join('<PROXY>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 pi launch-surface check failed to run: ${e.message}\n`);
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
