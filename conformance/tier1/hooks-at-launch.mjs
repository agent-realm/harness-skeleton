#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.6, §7.5; milestone 6a.6), on Claude Code. It starts the
// real harness, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/hooks-at-launch.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// Hooks reach a launch in the --settings overlay, each through hs's hook shim, under a launch
// receipt. In a headless run, SessionStart and UserPromptSubmit fire before the model is asked,
// so they can be measured with no model:
//   control   no hooks. Expected: no request carries the context marker (the premise).
//   refused   launch-spec with hooks and no receipt. Expected: receipt_required, runs-code each.
//   allowed   a SessionStart hook that records the envelope it got, and a UserPromptSubmit hook
//             whose decision is allow with a context marker. Expected: SessionStart got the
//             envelope (event, source startup, the native payload) and its env ref as the dummy;
//             the marker reaches the model's request as context.
//   denied    a UserPromptSubmit hook whose decision is deny. Expected: the prompt is blocked, so
//             no request reaches the endpoint.
// The report records the tool names the request carried: the source of the tool-class table.
// The hooks record only kinds and markers, never a value; credentials are dummies; HOME and XDG
// are scratch.

import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';

const claude = guard('hooks-at-launch.mjs');
const MARK = 'hs-tier1-hook-context-4e7a';
const PROMPT = 'tier 1 hooks at launch check';
const b = bench('hs-tier1-hooks-at-launch-');

const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, at_endpoint: r.seen.ENDPOINT.map((q) => ({ path: q.path, markers: q.markers, credential: q.credential })) });

try {
  const L = await b.listener('ENDPOINT', { markers: [MARK], toolNames: true });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const folder = path.join(b.work, 'folder');
  fs.mkdirSync(folder);
  const probe = path.join(b.work, 'session-start.json');
  const header = (name) => `[spec]\nname = "${name}"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n`;
  const plain = path.join(b.work, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'spec.toml'), header('plain'));

  const hooksLayer = (name, decision) => {
    const dir = path.join(b.work, name);
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'start.mjs'), `import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(process.env.HS_PROBE_OUT, JSON.stringify({ event: input.hs.event, source: input.hs.source ?? null, session: typeof input.hs.session_id === 'string', native_event: input.native?.hook_event_name ?? null, key: process.env.GUARD_KEY === process.env.HS_BENCH_EXPECT ? 'match' : 'mismatch' }));
`);
    fs.writeFileSync(path.join(dir, 'hooks', 'prompt.mjs'), `import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(${JSON.stringify(decision)} === 'deny' ? { decision: 'deny', reason: 'blocked by the tier 1 hook' } : { decision: 'allow', context: ${JSON.stringify(MARK)} + ' ' + (input.hs.prompt ? 'saw the prompt' : 'no prompt') }));
`);
    fs.writeFileSync(path.join(dir, 'spec.toml'), `${header(name)}
[refs.GUARD_KEY]
description = "a dummy the SessionStart hook checks"

[hook.start]
event = "SessionStart"
match = { source = ["startup"] }
run = { exec = "node", args = ["hooks/start.mjs"], env = { HS_PROBE_OUT = "${probe}" }, env_refs = { GUARD_KEY = "GUARD_KEY" } }

[hook.prompt]
event = "UserPromptSubmit"
run = { exec = "node", args = ["hooks/prompt.mjs"] }
`);
    return dir;
  };
  const allowed = hooksLayer('allowed', 'allow');
  const denied = hooksLayer('denied', 'deny');
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[refs]\nGUARD_KEY = "env:${REF_VAR}"\n\n[endpoints.anthropic-messages]\nbase_url = "${L.url}"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const args = (layer, extra = []) => ['--harness', 'claude-code', '--folder', folder, '--layer', layer, '--local', local, '--bin', claude, '--headless', ...extra];
  const start = (spec) => {
    const l = fromSpec(spec, {}, claude, [PROMPT]);
    // The hook compares its ref with this, and records only whether they match.
    return b.launch([L], l.argv, { ...l.env, HS_BENCH_EXPECT: l.env.HS_REF_GUARD_KEY }, cwd);
  };
  const receiptFor = (layer) => {
    const refused = b.hsCall('launch-spec', args(layer));
    const items = refused.ok ? [] : refused.error.items[0].risks;
    const file = path.join(b.work, `receipt-${path.basename(layer)}.json`);
    fs.writeFileSync(file, JSON.stringify({ format: 'hs-receipt/0.2', launch_digest: refused.error?.items?.[0]?.launch_digest ?? null, allows: [...new Set(items.map((r) => r.item))], by: 'tier1-bench', at: new Date().toISOString() }));
    return { refused, file };
  };

  const control = await start(b.hs('launch-spec', args(plain)));

  const a = receiptFor(allowed);
  const allowedRun = await start(b.hs('launch-spec', args(allowed, ['--receipt', a.file])));
  const startProbe = fs.existsSync(probe) ? JSON.parse(fs.readFileSync(probe, 'utf8')) : null;
  const d = receiptFor(denied);
  const deniedRun = await start(b.hs('launch-spec', args(denied, ['--receipt', d.file])));

  // The tool names the model was offered: the source of the tool-class table.
  const toolNames = [...new Set(allowedRun.seen.ENDPOINT.flatMap((q) => q.tools ?? []))].sort();

  const risks = a.refused.ok ? [] : a.refused.error.items[0].risks;
  const marked = (r) => r.seen.ENDPOINT.some((q) => q.markers.includes(MARK));
  const checks = {
    'without hooks no request carries the marker (premise)': control.seen.ENDPOINT.length > 0 && !marked(control),
    'without a receipt launch-spec refuses, runs-code for each hook': a.refused.error?.code === 'receipt_required' && ['hook.start', 'hook.prompt'].every((i) => risks.some((r) => r.item === i && r.risk === 'runs-code')),
    'SessionStart got the envelope: the event, source startup, the session id, the native payload': startProbe?.event === 'SessionStart' && startProbe?.source === 'startup' && startProbe?.session === true && startProbe?.native_event === 'SessionStart',
    'SessionStart got its env ref through the shim': startProbe?.key === 'match',
    'an allow with context reaches the model\'s request': marked(allowedRun),
    'a deny blocks the prompt: no request reaches the endpoint': deniedRun.seen.ENDPOINT.length === 0,
  };
  const reached = control.seen.ENDPOINT.length > 0 && allowedRun.seen.ENDPOINT.length > 0;
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: hooks at launch, through hs\'s hook shim under a launch receipt (design note v0.2 §5.6, §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, claude),
    runs: { control: shape(control), allowed: shape(allowedRun), denied: shape(deniedRun) },
    session_start_envelope: startProbe,
    tool_names: toolNames,
    risks: risks.map((r) => ({ item: r.item, risk: r.risk })),
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 hooks at launch check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
