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
//   The control and online runs also run under `strace -e trace=connect` (when the bench has it): the
//   count of connections to anything but loopback, DNS apart, so traffic that would bypass the proxy
//   is seen too. Counts only, never an address.
//   proxy_control  a provider on an outside host: it is asked for through the proxy, so the proxy
//                does see pi's requests (the premise for "no host is asked for").
//   mcp_direct   the extension registers a stdio MCP server with exposure "direct" and a ${HS_REF_…}
//                value in its env. Expected: it starts, the value expanded, and its tool is offered as
//                mcp__probe__ping.
//   mcp_default  the same with no exposure: the tools a request is offered (recorded).
//   mcp_folder   the folder's mcp.json defines a server named like the extension's: which one starts
//                (recorded; the docs say the file's wins).
//   carriers     where pi interpolates or executes text, one carrier set per run so that one failure
//                does not hide another: a leading `!command` in the provider's apiKey (carrier_key), in a
//                provider header, an MCP server's env and args (carrier_bang), in a remote MCP server's
//                headers (carrier_remote); a ${VAR} in a provider header, an MCP server's env and args,
//                and a remote MCP server's headers (carrier_var). Each `!command` touches a file of its
//                own, so a run shows which ran. Judged: pi runs a leading `!command` in the apiKey, a
//                provider header, an MCP env value and a remote MCP header, and expands ${VAR} in a
//                provider header and an MCP env value: the premises for refusing such spec text.
//                Recorded: the rest, and whether each run still reached the model.
//   broken       an -e extension that does not parse, beside the provider's (recorded): whether pi
//                starts, and reaches the model.
//   hooks        the extension's tool_call handler blocks one bash command and throws for another
//                (recorded, ahead of hooks): neither runs, and whether their reasons reach the model.
//   driver       hs's own launch (milestone 8.1): `hs launch-spec --harness pi` for a spec with an
//                endpoint, a model, a stdio MCP server whose ref reaches its env, a skill and an
//                AGENTS.md, refused without a receipt and run with one, as a caller runs it.
//                Expected: the model is reached with the dummy key and no host is asked for; the skill
//                and AGENTS.md reach a request; the server starts with its ref expanded and its tool
//                is offered; nothing is written into the folder but pi's sessions.
// Names, booleans and counts only. The credential is a dummy.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { OTHER, OTHER_VALUE, serverSource } from '../lib/agent-plugins.mjs';
import { DUMMY, REF_VAR, bench, evidence, guard } from '../lib/bench.mjs';

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

// A stdio MCP server that records, as booleans, which form of OTHER's value reached its arguments
// and its HS_LITERAL variable, and answers initialize and tools/list.
const carrierServer = `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.writeFileSync(process.env.HS_PROBE_OUT, JSON.stringify({
  started: true,
  arg_is_other: args.includes(${JSON.stringify(OTHER_VALUE)}), arg_kept_literal: args.includes('\${${OTHER}}'),
  env_is_other: process.env.HS_LITERAL === ${JSON.stringify(OTHER_VALUE)}, env_kept_literal: process.env.HS_LITERAL === '\${${OTHER}}',
}));
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hs-bench', version: '1.0.0' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'A bench tool.', inputSchema: { type: 'object', properties: {} } }] } });
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
`;

// Connections to anything but loopback, from an strace -e trace=connect log: DNS apart, counts only.
const connects = (file) => {
  if (!fs.existsSync(file)) return null;
  let dns = 0;
  let other = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /connect\(\d+, \{sa_family=AF_INET6?, sin6?_port=htons\((\d+)\), (?:sin_addr=inet_addr\("([^"]+)"\)|sin6_flowinfo=[^,]+, inet_pton\(AF_INET6, "([^"]+)")/.exec(line);
    if (!m) continue;
    const addr = m[2] ?? m[3];
    if (/^127\./.test(addr) || addr === '::1' || /^::ffff:127\./.test(addr)) continue;
    if (m[1] === '53') dns++;
    else other++;
  }
  return { dns, other };
};
const STRACE = spawnSync('strace', ['-V'], { encoding: 'utf8' }).status === 0;

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
  const run = async (variant, { ext = {}, extra = [], env = {}, offline = true, steps, folderFiles = {}, extraExtensions = [], trace = false, url } = {}) => {
    const from = hosts.length;
    const L = await b.model('ENDPOINT', { markers: Object.values(M), ...(steps ? { steps } : {}), fallback: { text: 'done' }, inspect: stamp });
    const folder = folderFor(variant);
    for (const [rel, content] of Object.entries(folderFiles)) put(path.join(folder, rel), content);
    const extFile = path.join(b.work, `ext-${variant}`, 'hs-launch.js');
    put(extFile, extension({ url: url ?? L.url, ...ext }));
    const traceFile = path.join(b.work, `trace-${variant}.log`);
    const argv = [...(trace && STRACE ? ['strace', '-f', '-qq', '-e', 'trace=connect', '-o', traceFile] : []), pi, '--mode', 'json', '--provider', 'hs', '--model', 'bench-primary', '-e', extFile, ...extraExtensions.flatMap((e) => ['-e', e]), ...extra, PROMPT];
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
      // What pi writes as its login store on a start: its size and mode, never its bytes.
      auth_store: fs.existsSync(path.join(folder, 'auth.json')) ? { bytes: fs.statSync(path.join(folder, 'auth.json')).size, mode: (fs.statSync(path.join(folder, 'auth.json')).mode & 0o777).toString(8) } : null,
      ...(trace ? { connects: STRACE ? connects(traceFile) : 'no strace on this bench' } : {}),
    };
  };

  const runs = {};
  runs.control = await run('control', { trace: true, extra: ['--skill', path.join(kit, 'skills', 'notes'), '--append-system-prompt', path.join(kit, 'APPEND.md')] });
  const homeAfter = names(home, 6);
  runs.online = await run('online', { offline: false, trace: true });
  runs.proxy_control = await run('proxy-control', { url: 'https://hs-bench-provider.invalid' });

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

  // Where pi interpolates or executes text, one carrier set per run. Each !command touches its own file.
  const bang = (n) => path.join(b.work, `bang-${n}`);
  const cserver = path.join(b.work, 'carrier-server.mjs');
  put(cserver, carrierServer);
  const VAR = `\${${OTHER}}`;
  runs.carrier_key = await run('carrier-key', { ext: { apiKey: `!touch ${bang('apikey')}` } });
  runs.carrier_bang = await run('carrier-bang', {
    ext: {
      headers: { 'X-HS-Bang': `!touch ${bang('header')}` },
      mcp: { probe: { command: process.execPath, args: [cserver, `!touch ${bang('args')}`], env: { HS_PROBE_OUT: out('carrier-bang'), HS_BANG: `!touch ${bang('env')}` }, exposure: 'direct' } },
    },
  });
  runs.carrier_bang.probe = probe(out('carrier-bang'));
  const remote = await b.listener('MCPHTTP', { markers: [OTHER_VALUE] });
  runs.carrier_remote = await run('carrier-remote', { ext: { mcp: { remote: { url: `${remote.url}/mcp`, headers: { 'X-HS-Bang': `!touch ${bang('mcp-header')}` } } } } });
  runs.carrier_var = await run('carrier-var', {
    ext: {
      headers: { 'X-HS-Var': VAR },
      mcp: {
        probe: { command: process.execPath, args: [cserver, VAR], env: { HS_PROBE_OUT: out('carrier-var'), HS_LITERAL: VAR }, exposure: 'direct' },
        remote: { url: `${remote.url}/mcp`, headers: { 'X-HS-Var': VAR } },
      },
    },
  });
  const cv = probe(out('carrier-var'));
  const carriers = {
    executed: Object.fromEntries(['apikey', 'header', 'args', 'env', 'mcp-header'].map((n) => [n, fs.existsSync(bang(n))])),
    expanded: {
      provider_header: runs.carrier_var.markers.includes('other'),
      mcp_env: cv ? cv.env_is_other : null, mcp_env_kept_literal: cv ? cv.env_kept_literal : null,
      mcp_args: cv ? cv.arg_is_other : null, mcp_args_kept_literal: cv ? cv.arg_kept_literal : null,
      mcp_remote_header: remote.log.some((q) => q.markers.includes(OTHER_VALUE)),
    },
    reached: Object.fromEntries(['carrier_key', 'carrier_bang', 'carrier_remote', 'carrier_var'].map((k) => [k, runs[k].requests > 0])),
    remote_requests: remote.log.length,
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

  // driver: hs's own launch-spec, and the launch it describes, run as a caller runs it: its argv and
  // env_set, each reference resolved here into its variable (the dummy key, the probe directory),
  // env_unset removed.
  const driverKit = path.join(b.work, 'kit-driver');
  const driverOut = out('driver');
  put(path.join(driverKit, 'spec.toml'), [
    '[spec]', 'name = "kit"', 'version = "1.0.0"', 'format = "0.2"', '',
    '[model.roles]', 'primary = "bench-primary"', '',
    '[refs.PROBE_DIR]', 'description = "the probe directory"', '',
    '[mcp.probe]', `exec = ${JSON.stringify(process.execPath)}`, `args = [${JSON.stringify(server)}]`,
    `env = { HS_PROBE_OUT = ${JSON.stringify(driverOut)} }`, 'env_refs = { HS_DATA_DIR = "PROBE_DIR" }', '',
  ].join('\n'));
  put(path.join(driverKit, 'skills', 'notes', 'SKILL.md'), skill('notes', M.skill));
  put(path.join(driverKit, 'AGENTS.md'), `Kit instructions. ${M.append}\n`);
  const driverFolder = path.join(b.work, 'pi-driver');
  const driverRun = async () => {
    const from = hosts.length;
    const L = await b.model('ENDPOINT', { markers: Object.values(M), fallback: { text: 'done' }, inspect: stamp });
    const folder = driverFolder;
    fs.mkdirSync(folder, { recursive: true });
    const local = path.join(b.work, 'local-driver.toml');
    put(local, `[refs]\nPROBE_DIR = "env:HS_BENCH_PROBE_DIR"\n\n[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
    const args = ['--harness', 'pi', '--folder', folder, '--layer', driverKit, '--local', local, '--bin', pi, '--headless'];
    const refused = b.hsCall('launch-spec', args);
    const items = refused.ok ? [] : refused.error.items ?? [];
    const receipt = path.join(b.work, 'receipt-driver.json');
    put(receipt, { format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() });
    const spec = b.hs('launch-spec', [...args, '--receipt', receipt]);
    const env = { ...spec.env_set, ...viaProxy };
    for (const [v, ref] of Object.entries(spec.env_from_refs)) {
      if (ref === `env:${REF_VAR}`) env[v] = DUMMY;
      else if (ref === 'env:HS_BENCH_PROBE_DIR') env[v] = probeDir;
      else throw new Error(`unexpected reference for ${v}`);
    }
    for (const v of spec.env_unset) env[v] = undefined;
    const r = await b.launch([L], [pi, ...spec.argv.slice(1), PROMPT], env, cwd);
    fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    const seen = r.seen.ENDPOINT;
    return {
      refused: refused.ok ? null : refused.error.code, exit: r.exit, timed_out: r.timed_out, requests: seen.length,
      credential: [...new Set(seen.map((q) => q.credential))],
      markers: Object.entries(M).filter(([, m]) => seen.some((q) => q.markers.includes(m))).map(([k]) => k).sort(),
      tools: [...new Set(seen.flatMap((q) => q.tools ?? []))].filter((t) => typeof t === 'string').sort(),
      hosts: [...new Set(hosts.slice(from))].sort(),
      folder: names(folder, 3),
      probe: probe(driverOut),
    };
  };
  runs.driver = await driverRun();
  // A second launch in the same folder: what pi wrote on the first start is no login.
  runs.driver_again = await driverRun();

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
    'proxy_control: a provider on an outside host is asked for through the proxy, so the proxy sees pi\'s requests (premise)': runs.proxy_control.hosts.includes('hs-bench-provider.invalid'),
    'control: under strace, pi connects to nothing but loopback with the offline switches on (DNS apart, none either)': !STRACE || (C.connects !== null && C.connects.other === 0 && C.connects.dns === 0),
    'carriers: pi runs a leading !command in the provider\'s apiKey, a provider header, an MCP env value and a remote MCP header': carriers.executed.apikey && carriers.executed.header && carriers.executed.env && carriers.executed['mcp-header'],
    'carriers: pi expands ${VAR} in a provider header and an MCP env value': carriers.expanded.provider_header && carriers.expanded.mcp_env === true,
    'pi writes an empty login store on every start: auth.json, 2 bytes, mode 600 (the premise for telling it from a login by its size)': [C, runs.online, runs.broken].every((r) => r.auth_store?.bytes === 2 && r.auth_store?.mode === '600'),
    'driver: hs launch-spec refuses without a receipt, and the launch it describes leaves in the folder only what pi itself writes on a start (sessions/, its empty auth.json and models-store.json)': runs.driver.refused === 'receipt_required' && runs.driver.folder.length > 0 && runs.driver.folder.filter((n) => !n.startsWith('sessions')).sort().join() === C.folder.filter((n) => !n.startsWith('sessions') && n !== 'AGENTS.md').sort().join(),
    'driver: a second launch in the same folder is not refused: pi\'s empty store is no login, and the model is reached again': runs.driver_again.refused === 'receipt_required' && runs.driver_again.requests > 0,
    'driver: the spec\'s model reaches the endpoint with the dummy key, and no host is asked for': runs.driver.requests > 0 && runs.driver.credential.length === 1 && runs.driver.credential[0] === 'bearer:bench-dummy' && runs.driver.hosts.length === 0,
    'driver: the skill and AGENTS.md reach a request': runs.driver.markers.includes('skill') && runs.driver.markers.includes('append'),
    'driver: the MCP server starts with its ref expanded, and its tool is offered as mcp__probe__ping': runs.driver.probe?.started === true && runs.driver.probe?.data_expanded === true && runs.driver.tools.includes('mcp__probe__ping'),
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
      carriers,
      online_connects: runs.online.connects ?? null,
      strace: STRACE,
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
