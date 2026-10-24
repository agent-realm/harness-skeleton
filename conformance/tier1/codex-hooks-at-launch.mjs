#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.6, §7.5; milestone 6a.8), on Codex. It starts the real
// harness, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/codex-hooks-at-launch.mjs --codex <path> [--hs-rev <sha>] [--keep]
//
// Hooks reach a Codex launch as `-c hooks.<Event>` groups running hs's hook shim, trusted for the
// launch by one `-c hooks.state` table whose trusted_hash hs computes. The scripted model
// (@agent-realm/scripted-model) answers a run's first request with exec_command `touch <marker>`,
// and the request holding the call's output with the end of the turn. The
// folder's config.toml holds a PreToolUse hook of its own on Bash, the event and tool the launch's
// guard also hooks, trusted in its own [hooks.state] by the same hash; it records and allows. Measured, with `codex exec --sandbox danger-full-access` (the
// read-only sandbox's bwrap cannot set up loopback on the bench):
//   untrusted the launch with the -c hooks.state pair taken out. Expected: no spec hook runs, the
//             command runs, and the folder's own hook runs (the premise: trust gates the hooks,
//             and the folder's key and hash are right).
//   refused   no receipt. Expected: receipt_required, runs-code for each hook.
//   trusted   with the receipt. Expected: SessionStart got the envelope and its env ref, and its
//             context reached the request; the PreToolUse guard got the shell call's envelope and
//             denied it, so the command did not run and the tool's output carried the reason; the
//             folder's own PreToolUse hook ran too: the launch's -c hooks.PreToolUse adds a layer and
//             replaces none of the folder's hooks, and its trust table shadows none of the folder's.
//   crash     a guard whose process exits 1. Expected: the shim fails closed; the command did not
//             run.
// Hooks and probes record kinds and match/mismatch only. Credentials are dummies; HOME and XDG
// are scratch.

import fs from 'node:fs';
import path from 'node:path';
import { DUMMY, REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';
import { hookHash } from '../../src/drivers/codex/deliver.js';

const codex = guard('codex-hooks-at-launch.mjs', '--codex');
const MARK = 'hs-tier1-codex-hooks-context-7c2d';
const REASON = 'hs-tier1-guard-denied-7c2d';
const PROMPT = 'tier 1 Codex hooks at launch check';
const STATE = 'hooks.state=';
const b = bench('hs-tier1-codex-hooks-');

// A run's script: touch the run's marker, then end the turn once the call's output comes back.
const touchCall = (marker) => ({ steps: [
  { when: { turn: 1 }, reply: { tool_calls: [{ id: 'call_touch', name: 'exec_command', args: { cmd: `touch ${marker}` } }] } },
  { when: { after_tool: 'call_touch' }, reply: { text: 'done' } },
] });
// What the call's output says: the guard's reason, and whether the shim failed closed.
const model = { saw: null };
function inspect(json) {
  const outputs = (Array.isArray(json?.input) ? json.input : []).filter((i) => i?.type === 'function_call_output' && i.call_id === 'call_touch');
  if (!outputs.length) return;
  const text = outputs.map((o) => (typeof o.output === 'string' ? o.output : JSON.stringify(o.output))).join('\n');
  model.saw = { reason: text.includes(REASON), failing_closed: /failing closed/.test(text) };
}

// A hook process: records what it got (kinds and match/mismatch only), then answers.
const HOOK = (answer) => `import fs from 'node:fs';
const env = JSON.parse(fs.readFileSync(0, 'utf8'));
const t = env.hs.tool;
fs.writeFileSync(process.env.PROBE, JSON.stringify({
  event: env.hs.event, source: env.hs.source ?? null, session: typeof env.hs.session_id === 'string' && env.hs.session_id.length > 0,
  native: env.native?.hook_event_name ?? null,
  tool: t ? { class: t.class, name: t.name, command: typeof t.input?.command === 'string' && t.input.command.startsWith('touch ') } : null,
  env_ref: process.env.HOOK_TOKEN === undefined ? 'unset' : process.env.HOOK_TOKEN === ${JSON.stringify(DUMMY)} ? 'match' : 'mismatch',
}));
${answer}
`;

try {
  const L = await b.model('ENDPOINT', { markers: [MARK], inspect });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const folder = path.join(b.work, 'codex-home');
  fs.mkdirSync(folder);
  const probes = path.join(b.work, 'probes');
  fs.mkdirSync(probes);
  const probe = (n) => path.join(probes, n);
  const read = (n) => (fs.existsSync(probe(n)) ? JSON.parse(fs.readFileSync(probe(n), 'utf8')) : null);
  const clear = () => fs.rmSync(probes, { recursive: true, force: true }) || fs.mkdirSync(probes);

  // The folder's own hook, trusted in its own [hooks.state] by the same hash, keyed by the user
  // config's path [CX §11].
  const folderHook = path.join(b.work, 'folder-hook.mjs');
  fs.writeFileSync(folderHook, `import fs from 'node:fs';\nfs.readFileSync(0);\nfs.writeFileSync(${JSON.stringify(probe('folder'))}, '{"ran":true}');\n`);
  const folderCommand = `${process.execPath} ${folderHook}`;
  const folderHash = hookHash({ event_name: 'pre_tool_use', matcher: 'Bash', hooks: [{ type: 'command', command: folderCommand, timeout: 30, async: false }] });
  const folderKey = `${path.join(folder, 'config.toml')}:pre_tool_use:0:0`;
  fs.writeFileSync(path.join(folder, 'config.toml'), `[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(folderCommand)}\ntimeout = 30\n\n[hooks.state.${JSON.stringify(folderKey)}]\ntrusted_hash = ${JSON.stringify(folderHash)}\n`);

  const header = (name) => `[spec]\nname = "${name}"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n`;
  const guards = path.join(b.work, 'guards');
  fs.mkdirSync(guards);
  fs.writeFileSync(path.join(guards, 'start.mjs'), HOOK(`process.stdout.write(JSON.stringify({ context: ${JSON.stringify(MARK)} }));`));
  fs.writeFileSync(path.join(guards, 'guard.mjs'), HOOK(`process.stdout.write(JSON.stringify({ decision: 'deny', reason: ${JSON.stringify(REASON)} }));`));
  fs.writeFileSync(path.join(guards, 'spec.toml'), `${header('guards')}
[refs.HOOK_REF]
description = "a token for the start hook"

[hook.start]
event = "SessionStart"
match = { source = ["startup"] }
run = { exec = "node", args = ["start.mjs"], env = { PROBE = ${JSON.stringify(probe('start'))} }, env_refs = { HOOK_TOKEN = "HOOK_REF" } }

[hook.guard]
event = "PreToolUse"
match = { tool = ["shell"] }
run = { exec = "node", args = ["guard.mjs"], env = { PROBE = ${JSON.stringify(probe('guard'))} } }
`);
  const crash = path.join(b.work, 'crash');
  fs.mkdirSync(crash);
  fs.writeFileSync(path.join(crash, 'guard.mjs'), HOOK('process.exit(1);'));
  fs.writeFileSync(path.join(crash, 'spec.toml'), `${header('crash')}
[hook.guard]
event = "PreToolUse"
match = { tool = ["shell"] }
run = { exec = "node", args = ["guard.mjs"], env = { PROBE = ${JSON.stringify(probe('crash'))} } }
`);
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[refs]\nHOOK_REF = "env:${REF_VAR}"\n\n[endpoints.openai-responses]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const args = (layer, extra = []) => ['--harness', 'codex', '--folder', folder, '--layer', layer, '--local', local, '--bin', codex, '--headless', ...extra];
  const receiptFor = (layer) => {
    const refused = b.hsCall('launch-spec', args(layer));
    const items = refused.ok ? [] : refused.error.items;
    const file = path.join(b.work, `receipt-${path.basename(layer)}.json`);
    fs.writeFileSync(file, JSON.stringify({ format: 'hs-receipt/0.2', launch_digest: items[0]?.launch_digest ?? null, allows: [...new Set((items[0]?.risks ?? []).map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() }));
    return { refused, file };
  };
  const run = async (spec, name, { strip = false } = {}) => {
    clear();
    const marker = path.join(cwd, `ran-${name}`);
    fs.rmSync(marker, { force: true });
    model.saw = null;
    L.load(touchCall(marker));
    const l = fromSpec(spec, {}, codex, ['--skip-git-repo-check', '--sandbox', 'danger-full-access', PROMPT]);
    if (strip) {
      const i = l.argv.findIndex((a) => a.startsWith(STATE));
      if (i < 1 || l.argv[i - 1] !== '-c') throw new Error('the launch carries no trust table to take out');
      l.argv.splice(i - 1, 2);
    }
    const r = await b.launch([L], l.argv, l.env, cwd);
    L.load({ steps: [] });
    return {
      exit: r.exit, timed_out: r.timed_out, requests: r.seen.ENDPOINT.length, context_in_request: r.seen.ENDPOINT.some((q) => q.markers.includes(MARK)),
      command_ran: fs.existsSync(marker), tool_output: model.saw, start: read('start'), guard: read('guard'), crash: read('crash'), folder_hook: read('folder')?.ran === true,
    };
  };

  const { refused, file } = receiptFor(guards);
  const risks = refused.ok ? [] : refused.error.items[0].risks;
  const spec = b.hs('launch-spec', args(guards, ['--receipt', file]));
  const untrusted = await run(spec, 'untrusted', { strip: true });
  const trusted = await run(spec, 'trusted');
  const c = receiptFor(crash);
  const crashed = await run(b.hs('launch-spec', args(crash, ['--receipt', c.file])), 'crash');

  const checks = {
    'without the trust table no spec hook runs, the command runs, and the folder\'s own PreToolUse hook runs (premise)': untrusted.command_ran && untrusted.start === null && untrusted.guard === null && untrusted.folder_hook,
    'without a receipt launch-spec refuses: runs-code and trust for each hook': refused.error?.code === 'receipt_required' && ['hook.start', 'hook.guard'].every((id) => risks.some((r) => r.item === id && r.risk === 'runs-code') && risks.some((r) => r.item === id && r.risk === 'trust')),
    'the launch trusts its hooks by -c hooks.state, never by the bypass flag': spec.argv.some((a) => a.startsWith(STATE)) && !spec.argv.includes('--dangerously-bypass-hook-trust'),
    'SessionStart got the envelope (event, source startup, session id) and its env ref': trusted.start?.event === 'SessionStart' && trusted.start.source === 'startup' && trusted.start.session === true && trusted.start.env_ref === 'match',
    'the SessionStart context reached the request': trusted.context_in_request,
    'the PreToolUse guard got the shell call\'s envelope': trusted.guard?.event === 'PreToolUse' && trusted.guard.tool?.class === 'shell' && trusted.guard.tool.name === 'Bash' && trusted.guard.tool.command === true,
    'the guard\'s deny kept the command from running, with its reason in the tool output': !trusted.command_ran && trusted.tool_output?.reason === true,
    'the folder\'s own PreToolUse hook still ran beside the launch\'s PreToolUse guard': trusted.folder_hook,
    'a guard that crashes fails closed: the command did not run': crashed.crash?.event === 'PreToolUse' && !crashed.command_ran && crashed.tool_output?.failing_closed === true,
  };
  const reached = untrusted.requests > 0 && trusted.requests > 0 && crashed.requests > 0;
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: hooks at launch on Codex, through hs\'s hook shim, trusted by -c hooks.state under a launch receipt (design note v0.2 §5.6, §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, codex),
    refusal: refused.ok ? null : { code: refused.error.code, risks: risks.map((r) => ({ item: r.item, risk: r.risk, ...(r.blocks !== undefined ? { blocks: r.blocks } : {}), ...(r.gate ? { gate: r.gate } : {}) })) },
    runs: { untrusted, trusted, crash: crashed },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 Codex hooks at launch check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
