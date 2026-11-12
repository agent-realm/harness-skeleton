#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §8, question 7), on OpenCode and pi. It starts the real
// harnesses, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/strict-isolation.mjs --opencode <path> --pi <path> [--hs-rev <sha>] [--keep]
//
// hs's own `isolation = "strict"`: only the instructions and skills the spec names reach the agent.
// Canaries, each a marker the model's requests are searched for:
//   global     a skill in ~/.agents/skills
//   ancestor   an AGENTS.md in a parent of the working directory, inside $HOME
//   project    a skill in that parent's .agents/skills
//   cwd        an AGENTS.md in the working directory: the project's own instructions, which strict
//              never adds back
//   fagents    an AGENTS.md of the data folder's own (OpenCode: config/opencode/; pi: the agent dir)
//   fskill     a skill of the data folder's own that no plan installed
//   dotpi      pi only: a .pi/APPEND_SYSTEM.md in the working directory, with the folder's
//              settings.json trusting every project (defaultProjectTrust "always"), so a launch that
//              does not refuse trust loads it
// and the carriers strict must keep: the spec's skill and AGENTS.md, and a skill a plan of the spec
// installed into the folder first (`kept`). Each harness gets two launches of hs's own
// `launch-spec`, run as a caller runs it: the same spec without `isolation` (the premise: the
// canaries reach), then with `isolation = "strict"`. The model is scripted, the key a dummy, the
// network refused. Names and booleans only.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DUMMY, REF_VAR, arg, bench, evidence, guard } from '../lib/bench.mjs';

const oc = guard('strict-isolation.mjs', '--opencode');
const pi = arg('--pi');
if (!pi) {
  process.stderr.write('strict-isolation.mjs needs --pi <path> too\n');
  process.exit(2);
}
const PROMPT = 'tier 1 strict isolation check';
const M = {
  skill: 'hs-tier1-str-skill-4f1a', agents: 'hs-tier1-str-agents-a9c2', kept: 'hs-tier1-str-kept-37d0',
  global: 'hs-tier1-str-global-e5b8', ancestor: 'hs-tier1-str-ancestor-0c6d', project: 'hs-tier1-str-project-9a17', cwd: 'hs-tier1-str-cwd-62fe',
  fagents: 'hs-tier1-str-fagents-d4a3', fskill: 'hs-tier1-str-fskill-18bc', dotpi: 'hs-tier1-str-dotpi-7e05',
};
const CARRIERS = ['skill', 'agents', 'kept'];
const b = bench('hs-tier1-strict-');

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

  // The canaries outside the folder, planted once in the scratch HOME.
  const home = b.scratch.HOME;
  const proj = path.join(home, 'proj');
  const cwd = path.join(proj, 'work');
  put(path.join(home, '.agents', 'skills', 'canary-global', 'SKILL.md'), skill('canary-global', M.global));
  put(path.join(proj, 'AGENTS.md'), `Ancestor. ${M.ancestor}\n`);
  put(path.join(proj, '.agents', 'skills', 'canary-project', 'SKILL.md'), skill('canary-project', M.project));
  put(path.join(cwd, 'AGENTS.md'), `Working directory. ${M.cwd}\n`);
  put(path.join(cwd, '.pi', 'APPEND_SYSTEM.md'), `Project system prompt. ${M.dotpi}\n`);

  // The spec, with and without strict: a skill and an AGENTS.md; and a layer a plan installs.
  const kitToml = (strict) => [...(strict ? ['isolation = "strict"', ''] : []), '[spec]', `name = "kit${strict ? '-strict' : ''}"`, 'version = "1.0.0"', 'format = "0.2"', '', '[model.roles]', 'primary = "bench-primary"', ''].join('\n');
  const kits = {};
  for (const strict of [false, true]) {
    const dir = path.join(b.work, strict ? 'kit-strict' : 'kit');
    put(path.join(dir, 'spec.toml'), kitToml(strict));
    put(path.join(dir, 'skills', 'notes', 'SKILL.md'), skill('notes', M.skill));
    put(path.join(dir, 'AGENTS.md'), `Spec instructions. ${M.agents}\n`);
    kits[strict] = dir;
  }
  const planned = path.join(b.work, 'planned');
  put(path.join(planned, 'spec.toml'), ['[spec]', 'name = "planned"', 'version = "1.0.0"', 'format = "0.2"', ''].join('\n'));
  put(path.join(planned, 'skills', 'kept', 'SKILL.md'), skill('kept', M.kept));

  // A folder with canaries of its own, and the planned layer applied into it.
  const folderFor = (harness, bin, variant) => {
    const folder = path.join(b.work, `${harness}-${variant}`);
    if (harness === 'opencode') {
      for (const r of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(folder, r), { recursive: true });
      put(path.join(folder, 'config', 'opencode', 'AGENTS.md'), `Folder instructions. ${M.fagents}\n`);
      put(path.join(folder, 'config', 'opencode', 'skills', 'fskill', 'SKILL.md'), skill('fskill', M.fskill));
    } else {
      fs.mkdirSync(folder, { recursive: true });
      put(path.join(folder, 'AGENTS.md'), `Folder instructions. ${M.fagents}\n`);
      put(path.join(folder, 'skills', 'fskill', 'SKILL.md'), skill('fskill', M.fskill));
      put(path.join(folder, 'settings.json'), { defaultProjectTrust: 'always' });
    }
    const common = ['--harness', harness, '--folder', folder, '--bin', bin];
    const plan = b.hs('plan', [...common, '--layer', planned, '--owner', 'tier1', '--mode', 'materialize']);
    const planFile = path.join(b.work, `plan-${harness}-${variant}.json`);
    put(planFile, plan);
    const receipt = path.join(b.work, `receipt-plan-${harness}-${variant}.json`);
    put(receipt, { format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench', at: new Date().toISOString() });
    b.hs('apply', [...common, '--plan', planFile, '--receipt', receipt]);
    return folder;
  };

  const launch = async (harness, bin, strict) => {
    const from = hosts.length;
    const variant = strict ? 'strict' : 'default';
    const L = await b.model('ENDPOINT', { markers: Object.values(M), fallback: { text: 'done' } });
    const folder = folderFor(harness, bin, variant);
    const local = path.join(b.work, `local-${harness}-${variant}.toml`);
    put(local, `[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
    const args = ['--harness', harness, '--folder', folder, '--layer', kits[strict], '--layer', planned, '--local', local, '--bin', bin, '--headless'];
    const refused = b.hsCall('launch-spec', args);
    const items = refused.ok ? [] : refused.error.items ?? [];
    const receipt = path.join(b.work, `receipt-${harness}-${variant}.json`);
    put(receipt, { format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() });
    const spec = b.hs('launch-spec', [...args, '--receipt', receipt]);
    const env = { ...spec.env_set, ...viaProxy };
    for (const [v, ref] of Object.entries(spec.env_from_refs)) {
      if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
      env[v] = DUMMY;
    }
    for (const v of spec.env_unset) env[v] = undefined;
    const r = await b.launch([L], [bin, ...spec.argv.slice(1), PROMPT], env, cwd);
    if (spec.temp_dir) fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    const seen = r.seen.ENDPOINT;
    return {
      exit: r.exit, timed_out: r.timed_out, requests: seen.length,
      isolation_item: spec.launch_items.find((i) => i.item === 'isolation')?.value ?? null,
      kept: spec.launch_items.some((i) => i.item === 'skill.kept') ? 'carried' : spec.skipped.some((x) => x.item === 'skill.kept') ? 'skipped' : null,
      reached: Object.entries(M).filter(([, m]) => seen.some((q) => q.markers.includes(m))).map(([k]) => k).sort(),
      hosts: [...new Set(hosts.slice(from))].sort(),
    };
  };

  const runs = { opencode: {}, pi: {} };
  runs.opencode.default = await launch('opencode', oc, false);
  runs.opencode.strict = await launch('opencode', oc, true);
  runs.pi.default = await launch('pi', pi, false);
  runs.pi.strict = await launch('pi', pi, true);
  const left = benchPids();
  proxy.close();
  proxy = null;

  const has = (r, ...ks) => ks.every((k) => r.reached.includes(k));
  const none = (r, ...ks) => ks.every((k) => !r.reached.includes(k));
  const O = runs.opencode;
  const P = runs.pi;
  const canaries = (h) => ['global', 'ancestor', 'project', 'cwd', 'fagents', 'fskill', ...(h === 'pi' ? ['dotpi'] : [])];
  const checks = {
    'opencode default: the carriers reach, and so do the global skill, the ancestor AGENTS.md, the project skill, the working directory\'s AGENTS.md, and the folder\'s own AGENTS.md and skill (the premise)': has(O.default, ...CARRIERS, ...canaries('opencode')),
    'opencode strict: the spec\'s skill and AGENTS.md and the planned skill (carried by the launch itself) reach; no canary does': has(O.strict, ...CARRIERS) && none(O.strict, ...canaries('opencode')) && O.strict.kept === 'carried' && O.strict.isolation_item === 'strict',
    'pi default: the carriers reach, and so do the global skill, the ancestor and working directory AGENTS.md, the folder\'s own AGENTS.md and skill, and the trusted project\'s .pi/APPEND_SYSTEM.md (the premise)': has(P.default, ...CARRIERS, 'global', 'ancestor', 'cwd', 'fagents', 'fskill', 'dotpi'),
    'pi strict: the spec\'s skill and AGENTS.md and the planned skill (named again with --skill) reach; no canary does, the trusted .pi/ included': has(P.strict, ...CARRIERS) && none(P.strict, ...canaries('pi')) && P.strict.kept === 'carried' && P.strict.isolation_item === 'strict',
    'no host is asked for, and no process with the bench\'s environment is left': [...Object.values(O), ...Object.values(P)].every((r) => r.hosts.length === 0) && left.length === 0,
  };
  const premise = O.default.requests > 0 && P.default.requests > 0;
  const verdict = !premise ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: hs\'s isolation = "strict" on OpenCode and pi: only the spec\'s instructions and skills reach the agent (design note v0.2 §8, question 7)',
    at: new Date().toISOString(),
    evidence: { opencode: evidence(b, oc), pi: evidence(b, pi) },
    runs,
    recorded: { pi_default_project_skill: P.default.reached.includes('project') },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>').split(proxyUrl).join('<PROXY>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 strict isolation check failed to run: ${e.message}\n`);
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
