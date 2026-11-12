#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.6, §7.5; milestone 8.2), on pi. It starts the real harness,
// so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/pi-hooks.mjs --pi <path> [--hs-rev <sha>] [--keep]
//
// Hooks on pi through hs's launch extension: `hs launch-spec --harness pi` for a spec with an
// endpoint, a stdio MCP server, and one hook on every event the extension carries, run as a caller
// runs it, with pi's network through a local proxy that refuses every host and a scratch HOME. Each
// hook's process records the envelope it got, by name, with the time; the guard blocks the bash
// command holding DENYME and stalls on the one holding SLOWME (2 s limit); the Stop hook blocks once,
// with a reason the model should then see. Runs:
//   main       the model asks for an allowed bash command, the denied one, the stalled one and the MCP
//              tool, then answers; the Stop hook asks for one more run. Expected: the allowed command
//              runs, the other two never do, the guard's reason and the shim's fail-closed reason reach
//              the model, and the session goes on; PostToolUse sees the calls that ran, the MCP one
//              with class mcp:probe; UserPromptSubmit sees the prompt; SessionStart (startup) and the
//              readiness marker come before the first model request; SessionEnd fires; the Stop
//              hook's reason reaches a request after the first answer, the second Stop envelope says
//              stop_hook_active, and the run ends; no host is asked for; the folder holds only what pi
//              writes.
//   blocked    the prompt holds BLOCKME, which the UserPromptSubmit hook refuses. Expected: no model
//              request at all.
//   broken     hs's launch extension made unparsable after launch-spec wrote it. Expected: pi does not
//              run (exit 1, no request) and no marker is written: hooks never go missing silently.
// Names, booleans, counts and times only. The credential is a dummy.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { serverSource } from '../lib/agent-plugins.mjs';
import { DUMMY, REF_VAR, bench, evidence, guard } from '../lib/bench.mjs';

const pi = guard('pi-hooks.mjs', '--pi');
const M = { guard: 'hs-tier1-pih-guard-3e7a', stop: 'hs-tier1-pih-stop-b51c', failClosed: 'ran past its limit and was stopped; failing closed', mcp: 'hs-tier1-pih-mcp-90d4' };
const b = bench('hs-tier1-pi-hooks-');

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
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

try {
  const hosts = [];
  const proxy = http.createServer((req, res) => {
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

  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const kit = path.join(b.work, 'kit');
  const hookLog = path.join(b.work, 'hook-envelopes.jsonl');
  const stopState = path.join(b.work, 'stop-state');
  const server = path.join(b.work, 'mcp-server.mjs');
  put(server, serverSource('ping', M.mcp));
  // One hook process for every role: it records the envelope it got, by name, with the time.
  put(path.join(kit, 'hook.mjs'), `import fs from 'node:fs';
const e = JSON.parse(fs.readFileSync(0, 'utf8'));
const role = process.env.HOOK_ROLE;
const cmd = String(e.hs?.tool?.input?.command ?? '');
fs.appendFileSync(process.env.HOOK_OUT, JSON.stringify({
  role, at: Date.now(), event: e.hs?.event ?? null, class: e.hs?.tool?.class ?? null, name: e.hs?.tool?.name ?? null,
  session: typeof e.hs?.session_id === 'string' && e.hs.session_id.length > 0, cwd_is_run: e.hs?.cwd === ${JSON.stringify(cwd)},
  command: cmd.includes('DENYME') ? 'deny' : cmd.includes('SLOWME') ? 'slow' : cmd ? 'allow' : null,
  prompt: typeof e.hs?.prompt === 'string' ? (e.hs.prompt.includes('BLOCKME') ? 'blocked' : 'plain') : null,
  source: e.hs?.source ?? null, stop_hook_active: e.native?.stop_hook_active ?? null,
}) + '\\n');
if (role === 'guard' && cmd.includes('DENYME')) { process.stderr.write(${JSON.stringify(M.guard)}); process.exit(2); }
if (role === 'guard' && cmd.includes('SLOWME')) setTimeout(() => {}, 60000);
else if (role === 'prompt' && typeof e.hs?.prompt === 'string' && e.hs.prompt.includes('BLOCKME')) { process.stderr.write('prompt refused'); process.exit(2); }
else if (role === 'stop' && !fs.existsSync(${JSON.stringify(stopState)})) { fs.writeFileSync(${JSON.stringify(stopState)}, 'x'); process.stderr.write(${JSON.stringify(M.stop)}); process.exit(2); }
else process.exit(0);
`);
  const runLine = (role) => `run = { exec = ${JSON.stringify(process.execPath)}, args = ["hook.mjs"], env = { HOOK_OUT = ${JSON.stringify(hookLog)}, HOOK_ROLE = "${role}" } }`;
  put(path.join(kit, 'spec.toml'), [
    '[spec]', 'name = "kit"', 'version = "1.0.0"', 'format = "0.2"', '',
    '[model.roles]', 'primary = "bench-primary"', '',
    '[mcp.probe]', `exec = ${JSON.stringify(process.execPath)}`, `args = [${JSON.stringify(server)}]`, `env = { HS_PROBE_OUT = ${JSON.stringify(path.join(b.work, 'probe.json'))} }`, '',
    '[hook.guard]', 'event = "PreToolUse"', 'match = { tool = ["shell"] }', runLine('guard'), 'timeout = 2', '',
    '[hook.mcp]', 'event = "PreToolUse"', 'match = { tool = ["mcp:probe"] }', runLine('log'), '',
    '[hook.after]', 'event = "PostToolUse"', runLine('log'), '',
    '[hook.prompt]', 'event = "UserPromptSubmit"', runLine('prompt'), '',
    '[hook.start]', 'event = "SessionStart"', 'match = { source = ["startup"] }', runLine('log'), '',
    '[hook.end]', 'event = "SessionEnd"', runLine('log'), '',
    '[hook.stop]', 'event = "Stop"', runLine('stop'), '',
  ].join('\n'));

  const stamp = (_body, record) => { record.at = Date.now(); };
  const driverRun = async (variant, prompt, { breakExtension = false, steps } = {}) => {
    const from = hosts.length;
    fs.rmSync(hookLog, { force: true });
    fs.rmSync(stopState, { force: true });
    const L = await b.model('ENDPOINT', { markers: Object.values(M), ...(steps ? { steps } : {}), fallback: { text: 'done' }, inspect: stamp });
    const folder = path.join(b.work, `pi-${variant}`);
    fs.mkdirSync(folder, { recursive: true });
    const local = path.join(b.work, `local-${variant}.toml`);
    put(local, `[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
    const args = ['--harness', 'pi', '--folder', folder, '--layer', kit, '--local', local, '--bin', pi, '--headless'];
    const refused = b.hsCall('launch-spec', args);
    const items = refused.ok ? [] : refused.error.items ?? [];
    const receipt = path.join(b.work, `receipt-${variant}.json`);
    put(receipt, { format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() });
    const spec = b.hs('launch-spec', [...args, '--receipt', receipt]);
    const env = { ...spec.env_set, ...viaProxy };
    for (const [v, ref] of Object.entries(spec.env_from_refs)) {
      if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
      env[v] = DUMMY;
    }
    for (const v of spec.env_unset) env[v] = undefined;
    const ext = spec.files.find((f) => f.role === 'extension').path;
    if (breakExtension) fs.writeFileSync(ext, 'export default function (pi) {\n');
    const t0 = Date.now();
    const r = await b.launch([L], [pi, ...spec.argv.slice(1), prompt], env, cwd);
    const ms = Date.now() - t0;
    const ready = (spec.readiness ?? []).find((x) => x.what === 'hooks');
    const marker = ready && fs.existsSync(ready.path) ? JSON.parse(fs.readFileSync(ready.path, 'utf8')) : null;
    fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    const seen = r.seen.ENDPOINT;
    const firstAt = Math.min(...seen.map((q) => q.at ?? Infinity));
    return {
      refused: refused.ok ? null : refused.error.code, risks: (items[0]?.risks ?? []).map((x) => [x.item, x.risk, x.blocks ?? null]),
      exit: r.exit, timed_out: r.timed_out, requests: seen.length, ms,
      credential: [...new Set(seen.map((q) => q.credential))],
      markers: Object.entries(M).filter(([, m]) => seen.some((q) => q.markers.includes(m))).map(([k]) => k).sort(),
      // Which request first carries the Stop hook's reason, by position.
      stop_reason_at: seen.findIndex((q) => q.markers.includes(M.stop)),
      readiness_in_temp_dir: ready ? path.dirname(ready.path) === spec.temp_dir : null,
      marker: marker ? { hooks: marker.hooks, before_first_request: typeof marker.at === 'number' && marker.at < firstAt } : null,
      hooks: readLines(hookLog).map(({ at, ...l }) => ({ ...l, before_first_request: at < firstAt })),
      ran: { allowed: fs.existsSync(path.join(b.work, `ran-${variant}.allowed`)), denied: fs.existsSync(path.join(b.work, `ran-${variant}.DENYME`)), slow: fs.existsSync(path.join(b.work, `ran-${variant}.SLOWME`)) },
      hosts: [...new Set(hosts.slice(from))].sort(),
      folder: names(folder, 2).filter((n) => !n.startsWith('sessions')),
    };
  };
  const ran = (variant) => path.join(b.work, `ran-${variant}`);
  const steps = (variant) => [
    { when: { tool: 'bash' }, reply: { tool_calls: [{ id: 'call_ok', name: 'bash', args: { command: `touch ${ran(variant)}.allowed` } }] } },
    { when: { after_tool: 'call_ok' }, reply: { tool_calls: [{ id: 'call_deny', name: 'bash', args: { command: `touch ${ran(variant)}.DENYME` } }] } },
    { when: { after_tool: 'call_deny' }, reply: { tool_calls: [{ id: 'call_slow', name: 'bash', args: { command: `touch ${ran(variant)}.SLOWME` } }] } },
    { when: { after_tool: 'call_slow' }, reply: { tool_calls: [{ id: 'call_mcp', name: 'mcp__probe__ping', args: {} }] } },
    { when: { after_tool: 'call_mcp' }, reply: { text: 'done' } },
  ];
  const runs = {};
  runs.main = await driverRun('main', 'tier 1 pi hooks check', { steps: steps('main') });
  runs.blocked = await driverRun('blocked', 'tier 1 pi hooks check BLOCKME');
  runs.broken = await driverRun('broken', 'tier 1 pi hooks check', { breakExtension: true });
  const left = benchPids();
  proxy.close();

  const R = runs.main;
  const of = (role, event) => R.hooks.filter((h) => h.role === role && h.event === event);
  const guardCalls = of('guard', 'PreToolUse');
  const after = R.hooks.filter((h) => h.event === 'PostToolUse');
  const stops = of('stop', 'Stop');
  const checks = {
    'main: hs launch-spec refuses without a receipt, each hook runs-code and only the gates block': R.refused === 'receipt_required' && JSON.stringify(R.risks.filter(([i]) => i.startsWith('hook.'))) === JSON.stringify([['hook.after', 'runs-code', false], ['hook.end', 'runs-code', false], ['hook.guard', 'runs-code', true], ['hook.mcp', 'runs-code', true], ['hook.prompt', 'runs-code', true], ['hook.start', 'runs-code', false], ['hook.stop', 'runs-code', true]]),
    'main: the readiness marker, named by launch-spec in its temp dir, is written with every hook registered before the first model request': R.readiness_in_temp_dir === true && R.marker?.hooks === 7 && R.marker.before_first_request,
    'main: the guard lets the allowed command run, blocks the denied one with its reason reaching the model, and fails closed on the stalled one with the shim\'s reason reaching the model; neither runs': R.ran.allowed && !R.ran.denied && !R.ran.slow && R.markers.includes('guard') && R.markers.includes('failClosed'),
    'main: the guard\'s envelope is hs\'s for each bash call (PreToolUse, class shell, a session id, the run\'s directory)': guardCalls.length === 3 && guardCalls.every((h) => h.class === 'shell' && h.name === 'bash' && h.session && h.cwd_is_run) && JSON.stringify(guardCalls.map((h) => h.command)) === JSON.stringify(['allow', 'deny', 'slow']),
    'main: an MCP tool reaches its hook as mcp__probe__ping, class mcp:probe, and PostToolUse sees the calls that ran': of('log', 'PreToolUse').some((h) => h.class === 'mcp:probe' && h.name === 'mcp__probe__ping') && after.some((h) => h.command === 'allow') && after.some((h) => h.class === 'mcp:probe'),
    'main: UserPromptSubmit sees the prompt; SessionStart (startup) comes before the first model request; SessionEnd fires': of('prompt', 'UserPromptSubmit').some((h) => h.prompt === 'plain') && of('log', 'SessionStart').some((h) => h.source === 'startup' && h.before_first_request) && of('log', 'SessionEnd').length >= 1,
    'main: the Stop hook\'s block asks for one more run, its reason reaching a later request; the next Stop says stop_hook_active, and the run ends': stops.length >= 2 && stops[0].stop_hook_active === false && stops[1].stop_hook_active === true && R.stop_reason_at > 0 && R.exit === 0 && !R.timed_out,
    'main: no host is asked for, the session goes on to its end without hanging, and the folder holds only what pi writes': R.hosts.length === 0 && R.ms < 90000 && R.folder.every((n) => ['auth.json', 'models-store.json'].includes(n)),
    'blocked: a prompt the UserPromptSubmit hook refuses reaches no model': runs.blocked.requests === 0 && runs.blocked.hooks.some((h) => h.event === 'UserPromptSubmit' && h.prompt === 'blocked'),
    'broken: hs\'s launch extension made unparsable stops pi (exit 1, no request), and no marker is written': runs.broken.exit === 1 && runs.broken.requests === 0 && runs.broken.marker === null,
    'no process with the bench\'s environment is left': left.length === 0,
  };
  const verdict = !(R.requests > 0) ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: hooks on pi through hs\'s launch extension (design note v0.2 §5.6, §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, pi),
    runs,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>').split(proxyUrl).join('<PROXY>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 pi hooks check failed to run: ${e.message}\n`);
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
