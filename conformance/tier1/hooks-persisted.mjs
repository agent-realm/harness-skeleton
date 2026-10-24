#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.4, §7.5; milestone 6a.13), on Claude Code. It starts the
// real harness, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/hooks-persisted.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// Hooks persisted by a plan under materialize: each a group of its own in settings.json's
// hooks.<Event>, beside the user's own; run through the shim's copy in hs-run/hook-shim/ and the
// process's bound copy in hs-run/hook.<id>/. A gating hook sets onFailure "block". Measured, with
// `claude -p` against a local endpoint that answers 400:
//   applied   plan and apply with the receipt. Expected: settings.json is the user's file with
//             exactly the two groups inserted; launch-spec carries neither hook (both installed);
//             the SessionStart hook's context reaches the model's request; the UserPromptSubmit
//             guard lets the prompt through.
//   broken    the shim's copy removed. Expected: the guard cannot start, and onFailure "block"
//             keeps the prompt from the model: no request is sent.
//   removed   hs remove. Expected: each element is gone, and settings.json is the user's file
//             plus the two arrays the plan created, now empty: an array (or object) hs created stays,
//             since the user's own empty one looks the same (§7.4). The user's bytes are kept.
// Credentials are dummies; HOME and XDG are scratch.

import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';

const claude = guard('hooks-persisted.mjs');
const MARK = 'hs-tier1-hooks-persisted-context-2b9e';
const PROMPT = 'tier 1 hooks persisted check';
const b = bench('hs-tier1-hooks-persisted-');

const USER_FILE = `{
    "theme": "dark",
    "cleanupPeriodDays": 9999,
    "hooks": {
        "PreToolUse": [
            { "matcher": "Write", "hooks": [{ "type": "command", "command": "true" }] }
        ]
    }
}
`;

try {
  const L = await b.listener('ENDPOINT', { markers: [MARK] });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const folder = path.join(b.work, 'folder');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'settings.json'), USER_FILE);
  const layerDir = path.join(b.work, 'hooks');
  fs.mkdirSync(path.join(layerDir, 'h'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'h/start.mjs'), `import fs from 'node:fs';\nfs.readFileSync(0);\nprocess.stdout.write(JSON.stringify({ context: ${JSON.stringify(MARK)} }));\n`);
  fs.writeFileSync(path.join(layerDir, 'h/gate.mjs'), `import fs from 'node:fs';\nfs.readFileSync(0);\n`);
  fs.writeFileSync(path.join(layerDir, 'spec.toml'), `[spec]
name = "hooks"
version = "1.0.0"
format = "0.2"

[model.roles]
primary = "bench-primary"

[hook.start]
event = "SessionStart"
run = { exec = "node", args = ["h/start.mjs"], self_contained = true }

[hook.gate]
event = "UserPromptSubmit"
run = { exec = "node", args = ["h/gate.mjs"], self_contained = true }
`);
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[endpoints.anthropic-messages]\nbase_url = "${L.url}"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const common = ['--harness', 'claude-code', '--folder', folder, '--local', local, '--bin', claude];
  const start = (spec) => {
    const l = fromSpec(spec, {}, claude, [PROMPT]);
    return b.launch([L], l.argv, l.env, cwd);
  };

  const plan = b.hs('plan', [...common, '--layer', layerDir, '--owner', 'tier1']);
  const planFile = path.join(b.work, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const receipt = path.join(b.work, 'receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench' }));
  b.hs('apply', [...common, '--plan', planFile, '--receipt', receipt]);
  const settings = fs.readFileSync(path.join(folder, 'settings.json'), 'utf8');
  const doc = JSON.parse(settings);
  const elements = plan.operations.filter((o) => o.handler === 'json-element');
  const spec = b.hs('launch-spec', [...common, '--layer', layerDir, '--headless']);
  const applied = await start(spec);

  fs.rmSync(path.join(folder, 'hs-run/hook-shim/claude-code.js'));
  const broken = await start(spec);

  b.hs('remove', [...common, '--owner', 'tier1']);
  const restored = fs.readFileSync(path.join(folder, 'settings.json'), 'utf8');

  const gate = doc.hooks?.UserPromptSubmit?.at(-1)?.hooks?.[0];
  const checks = {
    'the plan sets one element per hook, and copies the shim and each process': elements.map((o) => o.address_id).sort().join(',') === 'settings.json#hooks/SessionStart[hook.start],settings.json#hooks/UserPromptSubmit[hook.gate]'
      && plan.operations.some((o) => o.address_id === 'hs-run/hook-shim') && plan.operations.some((o) => o.address_id === 'hs-run/hook.start') && plan.operations.some((o) => o.address_id === 'hs-run/hook.gate'),
    'settings.json keeps the user\'s group and every key; the guard has onFailure block and names the way out': JSON.stringify(doc.hooks.PreToolUse) === JSON.stringify(JSON.parse(USER_FILE).hooks.PreToolUse)
      && doc.theme === 'dark' && gate?.onFailure === 'block' && /to take it away: hs remove --owner tier1/.test(gate?.command ?? ''),
    'the user\'s bytes before the hooks object are untouched': settings.startsWith(USER_FILE.slice(0, USER_FILE.indexOf('"hooks"'))),
    'launch-spec carries neither installed hook': spec.skipped.filter((x) => x.item.startsWith('hook.')).length === 2,
    'the persisted SessionStart hook\'s context reached the request, and the guard let the prompt through': applied.seen.ENDPOINT.some((q) => q.markers.includes(MARK)),
    'with the shim\'s copy gone, the guard cannot start and onFailure block keeps the prompt from the model': broken.seen.ENDPOINT.length === 0,
    'remove takes each element out; the user\'s bytes are kept, and only the two arrays the plan created stay, empty': (() => {
      const want = JSON.parse(USER_FILE);
      want.hooks.SessionStart = [];
      want.hooks.UserPromptSubmit = [];
      const userPart = USER_FILE.slice(0, USER_FILE.indexOf('        ]\n') + '        ]'.length);
      // Compared with keys sorted: the plan added the arrays in its own order.
      const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
      return JSON.stringify(canon(JSON.parse(restored))) === JSON.stringify(canon(want)) && restored.startsWith(userPart);
    })(),
  };
  const reached = applied.seen.ENDPOINT.length > 0;
  const verdict = !reached ? 'inconclusive: the applied start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const shape = (r) => ({ exit: r.exit, timed_out: r.timed_out, requests: r.seen.ENDPOINT.length, context: r.seen.ENDPOINT.some((q) => q.markers.includes(MARK)) });
  const report = {
    check: 'tier 1: hooks persisted by a plan under materialize, as settings.json elements beside the user\'s, run from hs-run copies, a guard failing closed with onFailure block (design note v0.2 §5.4, §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, claude),
    runs: { applied: shape(applied), broken: shape(broken) },
    operations: plan.operations.map((o) => `${o.address_id} ${o.risk.join('+')}`),
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 hooks persisted check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
