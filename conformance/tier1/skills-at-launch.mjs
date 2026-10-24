#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §7.5, launch-time receipts; milestone 6a.3), on Claude Code.
// It starts the real harness, so it runs only on a bench (AGENTS.md, Testing), and refuses unless
// HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/skills-at-launch.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// A skill carried at launch goes through a plugin directory in the launch's temp dir
// (`--plugin-dir`), under a launch receipt. Measured here:
//   control   the same endpoint launch without the skill. Expected: the skill's marker reaches no
//             request (the premise: only the plugin brings it).
//   refused   launch-spec with the skill and no receipt. Expected: receipt_required, with the launch
//             digest and the skill as a runs-code risk, and no temp dir made.
//   carried   launch-spec with a receipt for that digest; the harness started from it. Expected:
//             the marker reaches the request, under the name hs:notes, and nothing is copied into
//             the data folder.
// One local listener stands in for the endpoint; it records the kind of credential and which
// markers a request carries, never a value. The credential is a dummy; HOME and XDG are scratch.

import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';

const claude = guard('skills-at-launch.mjs');
const MARK = 'hs-tier1-skill-marker-5c1e';
const PROMPT = 'tier 1 skills at launch check';
const b = bench('hs-tier1-skills-at-launch-');

const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, at_endpoint: r.seen.ENDPOINT });
const launchDirs = () => fs.readdirSync(b.scratch.TMPDIR).filter((n) => n.startsWith('hs-launch-'));

try {
  const L = await b.listener('ENDPOINT', { markers: [MARK, 'hs:notes'] });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const folder = path.join(b.work, 'folder');
  fs.mkdirSync(folder);
  const header = (name) => `[spec]\nname = "${name}"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n`;
  const plain = path.join(b.work, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'spec.toml'), header('plain'));
  const team = path.join(b.work, 'team');
  fs.mkdirSync(path.join(team, 'skills', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(team, 'spec.toml'), header('team'));
  fs.writeFileSync(path.join(team, 'skills', 'notes', 'SKILL.md'), `---\nname: notes\ndescription: Take notes. ${MARK}\n---\nWrite notes.\n`);
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[endpoints.anthropic-messages]\nbase_url = "${L.url}"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const args = (layer, extra = []) => ['--harness', 'claude-code', '--folder', folder, '--layer', layer, '--local', local, '--bin', claude, '--headless', ...extra];
  const start = (spec) => {
    const l = fromSpec(spec, {}, claude, [PROMPT]);
    return b.launch([L], l.argv, l.env, cwd);
  };

  const control = await start(b.hs('launch-spec', args(plain)));

  const dirsBefore = launchDirs();
  const refused = b.hsCall('launch-spec', args(team));
  const refusal = refused.ok ? null : refused.error;
  const madeDir = launchDirs().length !== dirsBefore.length;
  const digest = refusal?.items?.[0]?.launch_digest ?? null;
  const risks = refusal?.items?.[0]?.risks ?? [];

  const receiptFile = path.join(b.work, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ format: 'hs-receipt/0.2', launch_digest: digest, allows: risks.map((r) => r.item), by: 'tier1-bench', at: new Date().toISOString() }));
  const spec = b.hs('launch-spec', args(team, ['--receipt', receiptFile]));
  const folderBefore = fs.readdirSync(folder).sort();
  const carried = await start(spec);
  const folderAfter = fs.readdirSync(folder).sort();

  const marked = (r) => r.seen.ENDPOINT.some((q) => q.markers.includes(MARK));
  const named = (r) => r.seen.ENDPOINT.some((q) => q.markers.includes('hs:notes'));
  const checks = {
    'without the plugin the skill reaches no request (premise)': control.seen.ENDPOINT.length > 0 && !marked(control),
    'without a receipt launch-spec refuses, naming the skill as runs-code': refusal?.code === 'receipt_required' && risks.length === 1 && risks[0].item === 'skill.notes' && risks[0].risk === 'runs-code',
    'the refusal makes no temp dir': !madeDir,
    'with the receipt the launch carries --plugin-dir and the same digest': spec.argv.includes('--plugin-dir') && spec.launch_digest === digest,
    'the skill reaches the request, as hs:notes': marked(carried) && named(carried),
    'nothing is copied into the data folder': !folderAfter.includes('skills') && !folderAfter.some((n) => !folderBefore.includes(n) && n === 'plugins'),
  };
  const reached = control.seen.ENDPOINT.length > 0 && carried.seen.ENDPOINT.length > 0;
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: a skill at launch, through --plugin-dir under a launch receipt (design note v0.2 §7.5)',
    at: new Date().toISOString(),
    evidence: evidence(b, claude),
    runs: { control: shape(control), carried: shape(carried) },
    refusal: refusal ? { code: refusal.code, risks } : null,
    launch_digest: digest,
    folder_entries_after: folderAfter,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 skills at launch check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
