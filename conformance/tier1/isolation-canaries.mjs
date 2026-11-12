#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §8, question 7), on OpenCode and pi. It starts the real
// harnesses, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/isolation-canaries.mjs --opencode <path> --pi <path> [--hs-rev <sha>] [--keep]
//
// A recording check of the isolation known limits: material the spec never named that reaches a
// launched agent anyway. Canaries, each a marker the model's requests are searched for:
//   global      a skill in ~/.agents/skills (both harnesses read it from $HOME, with no switch named)
//   ancestor    an AGENTS.md in a parent of the working directory, inside $HOME
//   project     a skill in that parent's .agents/skills (OpenCode's project walk; pi's is trust-gated)
//   cwd         an AGENTS.md in the working directory itself: the project's own instructions,
//               recorded, since a switch that drops the ancestors may drop it too
// and the launch's own carriers, which a switch must not break: the spec's skill and AGENTS.md. Each
// launch is hs's own `launch-spec` for that spec, run as a caller runs it, then with a candidate
// switch added; the model is scripted, the key a dummy, and the network refused. Candidates:
//   OpenCode  skills_denied: permissions in the inline layer, `skill` denied for every id and allowed
//             for the spec's (2.x lists only skills its rules do not deny, last match winning: source
//             v2.2.7 packages/core/src/skill.ts, permission.ts); project_off:
//             OPENCODE_DISABLE_PROJECT_CONFIG=1, which turns the project walk off
//             (packages/cli/src/server-process.ts, packages/core/src/config/discovery.ts); both.
//   pi        no_skills: --no-skills, the spec's skill still passed with --skill (additive); no_context:
//             --no-context-files, the spec's AGENTS.md still passed with --append-system-prompt;
//             both (the 1.5.2 package docs: cli).
// Judged: the leaks are there without a switch (the premise), and which switch closes which leak
// with the carriers intact. Names and booleans only. The credential is a dummy.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DUMMY, REF_VAR, arg, bench, evidence, guard } from '../lib/bench.mjs';

const oc = guard('isolation-canaries.mjs', '--opencode');
const pi = arg('--pi');
if (!pi) {
  process.stderr.write('isolation-canaries.mjs needs --pi <path> too\n');
  process.exit(2);
}
const PROMPT = 'tier 1 isolation canaries check';
const M = {
  skill: 'hs-tier1-iso-skill-0b4e', agents: 'hs-tier1-iso-agents-6c21',
  global: 'hs-tier1-iso-global-9e73', ancestor: 'hs-tier1-iso-ancestor-25fa', project: 'hs-tier1-iso-project-d1c8', cwd: 'hs-tier1-iso-cwd-73b9',
};
const b = bench('hs-tier1-isolation-');

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const skill = (name, mark) => `---\nname: ${name}\ndescription: ${mark}\n---\nA bench skill.\n`;
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

  // The canaries, planted once in the scratch HOME; the working directory sits two levels below it.
  const home = b.scratch.HOME;
  const proj = path.join(home, 'proj');
  const cwd = path.join(proj, 'work');
  put(path.join(home, '.agents', 'skills', 'canary-global', 'SKILL.md'), skill('canary-global', M.global));
  put(path.join(proj, 'AGENTS.md'), `Ancestor. ${M.ancestor}\n`);
  put(path.join(proj, '.agents', 'skills', 'canary-project', 'SKILL.md'), skill('canary-project', M.project));
  put(path.join(cwd, 'AGENTS.md'), `Working directory. ${M.cwd}\n`);

  // The spec: a skill and an AGENTS.md, the launch's own carriers.
  const kit = path.join(b.work, 'kit');
  put(path.join(kit, 'spec.toml'), ['[spec]', 'name = "kit"', 'version = "1.0.0"', 'format = "0.2"', '', '[model.roles]', 'primary = "bench-primary"', ''].join('\n'));
  put(path.join(kit, 'skills', 'notes', 'SKILL.md'), skill('notes', M.skill));
  put(path.join(kit, 'AGENTS.md'), `Spec instructions. ${M.agents}\n`);

  const launch = async (harness, bin, variant, { env: extraEnv = {}, argv: extraArgv = [], content } = {}) => {
    const from = hosts.length;
    const L = await b.model('ENDPOINT', { markers: Object.values(M), fallback: { text: 'done' } });
    const folder = path.join(b.work, `${harness}-${variant}`);
    if (harness === 'opencode') for (const r of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(folder, r), { recursive: true });
    else fs.mkdirSync(folder, { recursive: true });
    const local = path.join(b.work, `local-${harness}-${variant}.toml`);
    put(local, `[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
    const args = ['--harness', harness, '--folder', folder, '--layer', kit, '--local', local, '--bin', bin, '--headless'];
    const refused = b.hsCall('launch-spec', args);
    const items = refused.ok ? [] : refused.error.items ?? [];
    const receipt = path.join(b.work, `receipt-${harness}-${variant}.json`);
    put(receipt, { format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() });
    const spec = b.hs('launch-spec', [...args, '--receipt', receipt]);
    const env = { ...spec.env_set, ...viaProxy, ...extraEnv };
    for (const [v, ref] of Object.entries(spec.env_from_refs)) {
      if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
      env[v] = DUMMY;
    }
    for (const v of spec.env_unset) if (!(v in extraEnv)) env[v] = undefined;
    // A candidate that adds to OpenCode's inline layer: merged into hs's own.
    if (content) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...JSON.parse(spec.env_set.OPENCODE_CONFIG_CONTENT), ...content });
    const r = await b.launch([L], [bin, ...spec.argv.slice(1), ...extraArgv, PROMPT], env, cwd);
    fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    const seen = r.seen.ENDPOINT;
    return {
      exit: r.exit, timed_out: r.timed_out, requests: seen.length,
      reached: Object.entries(M).filter(([, m]) => seen.some((q) => q.markers.includes(m))).map(([k]) => k).sort(),
      hosts: [...new Set(hosts.slice(from))].sort(),
    };
  };

  const deny = { permissions: [{ action: 'skill', resource: '*', effect: 'deny' }, { action: 'skill', resource: 'notes', effect: 'allow' }] };
  const runs = { opencode: {}, pi: {} };
  runs.opencode.base = await launch('opencode', oc, 'base');
  runs.opencode.skills_denied = await launch('opencode', oc, 'skills-denied', { content: deny });
  runs.opencode.project_off = await launch('opencode', oc, 'project-off', { env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } });
  runs.opencode.both = await launch('opencode', oc, 'both', { content: deny, env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } });
  runs.pi.base = await launch('pi', pi, 'base');
  runs.pi.no_skills = await launch('pi', pi, 'no-skills', { argv: ['--no-skills'] });
  runs.pi.no_context = await launch('pi', pi, 'no-context', { argv: ['--no-context-files'] });
  runs.pi.both = await launch('pi', pi, 'both', { argv: ['--no-skills', '--no-context-files'] });
  const left = benchPids();
  proxy.close();
  proxy = null;

  const has = (r, ...ks) => ks.every((k) => r.reached.includes(k));
  const none = (r, ...ks) => ks.every((k) => !r.reached.includes(k));
  const O = runs.opencode;
  const P = runs.pi;
  const checks = {
    'opencode base: the spec\'s skill and AGENTS.md reach a request, and so do the global skill, the ancestor AGENTS.md and the project skill (the premise: the leaks are there)': has(O.base, 'skill', 'agents', 'global', 'ancestor', 'project'),
    'opencode skills_denied: skill permissions denying every id but the spec\'s keep the global and the project skill out, and the spec\'s skill reaches': has(O.skills_denied, 'skill', 'agents') && none(O.skills_denied, 'global', 'project'),
    'opencode project_off: OPENCODE_DISABLE_PROJECT_CONFIG keeps the ancestor AGENTS.md and the project skill out, and the spec\'s AGENTS.md and skill reach': has(O.project_off, 'skill', 'agents') && none(O.project_off, 'ancestor', 'project'),
    'opencode both: only the spec\'s skill and AGENTS.md reach, of the markers': has(O.both, 'skill', 'agents') && none(O.both, 'global', 'ancestor', 'project'),
    'pi base: the spec\'s skill and AGENTS.md reach a request, and so do the global skill and the ancestor AGENTS.md (the premise)': has(P.base, 'skill', 'agents', 'global', 'ancestor'),
    'pi no_skills: --no-skills keeps the global skill out, and the spec\'s skill, passed with --skill, reaches': has(P.no_skills, 'skill', 'agents') && none(P.no_skills, 'global'),
    'pi no_context: --no-context-files keeps the ancestor AGENTS.md out, and the spec\'s AGENTS.md, a system-prompt append, reaches': has(P.no_context, 'skill', 'agents') && none(P.no_context, 'ancestor'),
    'pi both: only the spec\'s skill and AGENTS.md reach, of the markers': has(P.both, 'skill', 'agents') && none(P.both, 'global', 'ancestor', 'project'),
    'no host is asked for, and no process with the bench\'s environment is left': [...Object.values(O), ...Object.values(P)].every((r) => r.hosts.length === 0) && left.length === 0,
  };
  const premise = O.base.requests > 0 && P.base.requests > 0;
  const verdict = !premise ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: the isolation known limits on OpenCode and pi, and the switches that close them (design note v0.2 §8, question 7)',
    at: new Date().toISOString(),
    evidence: { opencode: evidence(b, oc), pi: evidence(b, pi) },
    runs,
    recorded: {
      cwd_agents: Object.fromEntries([...Object.entries(O).map(([k, r]) => [`opencode.${k}`, r.reached.includes('cwd')]), ...Object.entries(P).map(([k, r]) => [`pi.${k}`, r.reached.includes('cwd')])]),
      pi_project_skill: Object.fromEntries(Object.entries(P).map(([k, r]) => [k, r.reached.includes('project')])),
    },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>').split(proxyUrl).join('<PROXY>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 isolation canaries check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  // A run that failed midway leaves the proxy listening, which would keep this process alive.
  if (proxy) proxy.close();
  for (const p of benchPids()) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // gone
    }
  }
  if (!(await b.finish())) process.exitCode = 4;
}
