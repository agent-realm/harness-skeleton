#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.6, §8), on OpenCode. It starts the real harness, so it runs
// only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/opencode-bridge.mjs --opencode <path> [--hs-rev <sha>] [--keep]
//
// A recording check ahead of a hooks bridge on OpenCode (milestone 7.3): what a local plugin can do in
// OpenCode 2.x, and whether loading one fetches anything. 2.x plugins are Plugin.define({ id, setup })
// from @opencode/plugin, with hooks registered per domain in setup: ctx.tool.hook("execute.before"),
// ctx.permission.hook("evaluate"), ctx.session.hook("prompt"), ctx.shell.hook("create.before"),
// ctx.event.subscribe (https://opencode.ai/v2/docs/build/plugins/server, read 2026-11-12); at startup
// OpenCode "installs missing packages in the background" (/v2/docs/plugins). Each run has a data folder
// of its own, a scratch HOME, and OpenCode's network through a local proxy that records the host names
// it is asked for (CONNECT and plain), forwarding them (open) or refusing them (blocked); the model on
// loopback stays off the proxy. The model is scripted: it asks the `shell` tool (2.x's name; 1.x
// called it bash) for one command the plugin allows
// and then one it denies, then answers. The plugin goes in OPENCODE_CONFIG_DIR/plugins/ and writes what
// it sees to a probe file, by name: the domains its ctx has, the hooks that fired, the fields of their
// events, the tool names, the event types, and whether it could run a process and read its exit code.
// Runs, each with the network open and then blocked:
//   none     no plugin (the baseline): the hosts OpenCode asks for without one.
//   plain    a plain .js plugin with no import, exporting { id, setup }.
//   sdk      the same through import { Plugin } from "@opencode/plugin".
// Judged: the baseline reaches the model (the premise); recorded: everything else, for the decision in
// the 7.3 note (artifacts, private). Names and booleans only. The credential is a dummy.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { DUMMY, bench, evidence, guard } from '../lib/bench.mjs';

const oc = guard('opencode-bridge.mjs', '--opencode');
const PROMPT = 'tier 1 OpenCode bridge check';
const M = { deny: 'hs-tier1-ocb-deny-6e1f' };
const b = bench('hs-tier1-opencode-bridge-');

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const names = (dir, depth = 3, rel = '') => {
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

// The plugin body: records, by name, what it sees; denies the shell command that holds DENYME.
const pluginBody = (probe) => `
const fs = await import('node:fs');
const cp = await import('node:child_process');
const OUT = ${JSON.stringify(probe)};
const log = (o) => { try { fs.appendFileSync(OUT, JSON.stringify(o) + '\\n'); } catch {} };
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : []);
const def = {
  id: 'hs-bench-bridge',
  async setup(ctx) {
    log({ setup: true, ctx: keys(ctx) });
    const on = (domain, name, fn) => {
      try {
        if (typeof ctx?.[domain]?.hook !== 'function') return log({ hook: domain + '.' + name, registered: false, reason: 'no hook function' });
        ctx[domain].hook(name, fn);
        log({ hook: domain + '.' + name, registered: true });
      } catch (e) { log({ hook: domain + '.' + name, registered: false, reason: String(e?.name ?? 'error') }); }
    };
    on('tool', 'execute.before', (event) => {
      let status = null;
      try { status = cp.spawnSync('/bin/sh', ['-c', 'exit 3']).status; } catch {}
      log({ fired: 'tool.execute.before', fields: keys(event), tool: typeof event?.tool === 'string' ? event.tool : null, spawn_status: status });
    });
    on('tool', 'execute.after', (event) => log({ fired: 'tool.execute.after', fields: keys(event), tool: typeof event?.tool === 'string' ? event.tool : null }));
    on('permission', 'evaluate', (event) => {
      const text = JSON.stringify(event ?? {});
      const deny = text.includes('DENYME');
      log({ fired: 'permission.evaluate', fields: keys(event), deny });
      if (deny && event && typeof event === 'object') { event.effect = 'deny'; event.reason = ${JSON.stringify(M.deny)}; event.message = ${JSON.stringify(M.deny)}; }
    });
    on('session', 'prompt', (event) => log({ fired: 'session.prompt', fields: keys(event) }));
    on('shell', 'create.before', (event) => log({ fired: 'shell.create.before', fields: keys(event) }));
    try {
      if (typeof ctx?.event?.subscribe === 'function') {
        const sub = ctx.event.subscribe({});
        log({ subscribe: true });
        (async () => { try { for await (const e of sub) log({ event: typeof e?.type === 'string' ? e.type : null }); } catch {} })();
      } else log({ subscribe: false });
    } catch (e) { log({ subscribe: false, reason: String(e?.name ?? 'error') }); }
  },
};
`;

try {
  // A recording proxy: CONNECT and plain requests, host names only; forwards when open.
  const hosts = [];
  let blocked = false;
  const proxy = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    let host = null;
    try {
      host = new URL(req.url).hostname;
    } catch {
      host = (req.headers.host ?? '').split(':')[0] || null;
    }
    hosts.push({ host, via: 'http', refused: true });
    res.writeHead(blocked ? 403 : 502).end();
  });
  proxy.on('clientError', (_e, socket) => socket.destroy());
  proxy.on('connect', (req, socket) => {
    socket.on('error', () => {});
    const [host, port] = String(req.url).split(':');
    hosts.push({ host, via: 'connect', refused: blocked });
    if (blocked) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const up = net.connect(Number(port) || 443, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    socket.on('close', () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  // Each command leaves a file, so a run shows which of them ran.
  const steps = (ran) => [
    { when: { tool: 'shell' }, reply: { tool_calls: [{ id: 'call_ok', name: 'shell', args: { command: `touch ${ran}.allowed`, description: 'touch' } }] } },
    { when: { after_tool: 'call_ok' }, reply: { tool_calls: [{ id: 'call_deny', name: 'shell', args: { command: `touch ${ran}.DENYME`, description: 'touch' } }] } },
    { when: { after_tool: 'call_deny' }, reply: { text: 'done' } },
  ];
  const folderFor = (variant) => {
    const f = path.join(b.work, `oc-${variant}`);
    for (const r of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(f, r), { recursive: true });
    return f;
  };
  const run = async (variant, kind, netBlocked) => {
    blocked = netBlocked;
    const from = hosts.length;
    const ran = path.join(b.work, `ran-${variant}-${netBlocked ? 'blocked' : 'open'}`);
    const L = await b.model('ENDPOINT', { markers: [M.deny], steps: steps(ran), fallback: { text: 'done' } });
    const folder = folderFor(`${variant}-${netBlocked ? 'blocked' : 'open'}`);
    const dir = path.join(b.work, `config-dir-${variant}-${netBlocked ? 'blocked' : 'open'}`);
    const probe = path.join(b.work, `probe-${variant}-${netBlocked ? 'blocked' : 'open'}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    if (kind === 'plain') put(path.join(dir, 'plugins', 'hs-bench.js'), `${pluginBody(probe)}\nexport default def;\n`);
    if (kind === 'sdk') put(path.join(dir, 'plugins', 'hs-bench.js'), `import { Plugin } from '@opencode/plugin';\n${pluginBody(probe)}\nexport default Plugin.define(def);\n`);
    const before = names(dir);
    const content = JSON.stringify({ providers: { bench: { name: 'Bench', env: ['HS_BENCH_OC_KEY'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `${L.url}/v1` }, models: { 'bench-primary': { name: 'Bench primary' } } } }, model: 'bench/bench-primary' });
    const env = {
      XDG_CONFIG_HOME: path.join(folder, 'config'), XDG_DATA_HOME: path.join(folder, 'data'), XDG_CACHE_HOME: path.join(folder, 'cache'), XDG_STATE_HOME: path.join(folder, 'state'),
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_CONFIG_CONTENT: content, OPENCODE_CONFIG_DIR: dir, HS_BENCH_OC_KEY: DUMMY,
      HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    };
    const r = await b.launch([L], [oc, 'run', '--standalone', '--format', 'json', PROMPT], env, cwd);
    const lines = fs.existsSync(probe) ? fs.readFileSync(probe, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const fired = [...new Set(lines.filter((l) => l.fired).map((l) => l.fired))].sort();
    return {
      exit: r.exit, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: r.seen.ENDPOINT.length,
      tools_offered: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.tools ?? []))].filter((t) => typeof t === 'string').sort(),
      tool_results: r.seen.ENDPOINT.flatMap((q) => q.tool_results ?? []).length,
      deny_reason_reached_model: r.seen.ENDPOINT.some((q) => q.markers.includes(M.deny)),
      allowed_ran: fs.existsSync(`${ran}.allowed`),
      denied_ran: fs.existsSync(`${ran}.DENYME`),
      plugin: {
        loaded: lines.some((l) => l.setup), ctx: lines.find((l) => l.setup)?.ctx ?? null,
        registered: lines.filter((l) => l.hook).map((l) => [l.hook, l.registered, l.reason ?? null]),
        fired,
        fields: Object.fromEntries(fired.map((f) => [f, lines.find((l) => l.fired === f)?.fields ?? []])),
        tools_seen: [...new Set(lines.filter((l) => l.tool).map((l) => l.tool))].sort(),
        spawn_status: lines.find((l) => l.fired === 'tool.execute.before')?.spawn_status ?? null,
        denied_in_hook: lines.some((l) => l.fired === 'permission.evaluate' && l.deny),
        subscribe: lines.find((l) => 'subscribe' in l)?.subscribe ?? null,
        events: [...new Set(lines.filter((l) => l.event).map((l) => l.event))].sort(),
      },
      hosts: [...new Set(hosts.slice(from).map((h) => `${h.via}:${h.host}${h.refused ? ' (refused)' : ''}`))].sort(),
      config_dir_added: names(dir).filter((n) => !before.includes(n)),
    };
  };

  const runs = {};
  for (const netBlocked of [false, true]) {
    for (const kind of ['none', 'plain', 'sdk']) runs[`${kind}_${netBlocked ? 'blocked' : 'open'}`] = await run(kind, kind, netBlocked);
  }
  const left = benchPids();
  proxy.close();

  const plugins = ['plain_open', 'sdk_open', 'plain_blocked', 'sdk_blocked'].map((k) => runs[k]);
  const onlyCatalog = (x) => x.hosts.every((h) => /^connect:models\.opencode\.ai( \(refused\))?$/.test(h));
  const checks = {
    'none_open: with no plugin, a run reaches the model (premise)': runs.none_open.requests > 0,
    'none: with no plugin, both shell commands run (premise)': runs.none_open.allowed_ran && runs.none_open.denied_ran,
    'a local plugin, plain .js or through @opencode/plugin, loads with the network open and blocked, installs nothing and writes nothing into the config directory': plugins.every((x) => x.plugin.loaded && x.config_dir_added.length === 0),
    'with or without a plugin OpenCode asks for no host but its model catalog (models.opencode.ai): no package registry': Object.values(runs).every(onlyCatalog),
    'tool.execute.before fires for the shell tool, and a process run from the hook gives its exit code': plugins.every((x) => x.plugin.fired.includes('tool.execute.before') && x.plugin.tools_seen.includes('shell') && x.plugin.spawn_status === 3),
    'permission.evaluate with effect deny blocks the call (its command never runs) and its reason reaches the model; the allowed call runs': plugins.every((x) => x.plugin.denied_in_hook && !x.denied_ran && x.allowed_ran && x.deny_reason_reached_model),
    'none_blocked: with the network blocked and no plugin, a run still reaches the model on loopback (premise)': runs.none_blocked.requests > 0,
    'no process with the bench\'s environment is left': left.length === 0,
  };
  const verdict = !checks[Object.keys(checks)[0]] ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: what a local plugin can do in OpenCode 2.x, and whether loading one fetches anything (design note v0.2 §5.6, §8)',
    at: new Date().toISOString(),
    evidence: evidence(b, oc),
    runs,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>').split(proxyUrl).join('<PROXY>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 OpenCode bridge check failed to run: ${e.message}\n`);
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
