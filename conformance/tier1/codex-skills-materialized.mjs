#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §7.5; milestone 6a.10), on Codex. It starts the real
// harness, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/codex-skills-materialized.mjs --codex <path> [--hs-rev <sha>] [--keep]
//
// A plan under materialize installs a skill into $CODEX_HOME/skills/<name>, a root Codex 0.160.0
// still loads and calls "Deprecated user skills location". This check fails loudly the day a
// release stops loading it. Measured, with `codex exec` against a local endpoint that answers 400
// and records which markers each request carries:
//   control   the folder before apply. Expected: no request carries the skill's marker (the premise).
//   refused   apply without a receipt for the runs-code operation. Expected: receipt_required, and
//             nothing written.
//   applied   plan and apply with the receipt. Expected: the request carries the skill's
//             description, its catalog line names `r<N>/<name>/SKILL.md` (Codex names files by a
//             root alias), and the request lists $CODEX_HOME/skills among the roots; config.toml
//             is byte for byte what it was.
//   launched  launch-spec over the delivered folder. Expected: the skill is skipped as installed,
//             not refused.
// Credentials are dummies; HOME and XDG are scratch.

import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';

const codex = guard('codex-skills-materialized.mjs', '--codex');
const MARK = 'hs-tier1-codex-skill-marker-5e1a';
const NAME = 'hs-bench-notes';
const PROMPT = 'tier 1 Codex skills materialized check';
const b = bench('hs-tier1-codex-skills-');

try {
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const folder = path.join(b.work, 'codex-home');
  fs.mkdirSync(folder);
  // A user's config.toml, which no plan may touch.
  const configText = '# the user\'s own config\n[history]\npersistence = "save-all"\n';
  fs.writeFileSync(path.join(folder, 'config.toml'), configText);
  const root = path.join(folder, 'skills');
  // The catalog line around the marker, for the report: names and paths only, no credential.
  let line = null;
  const inspect = (json) => {
    const text = JSON.stringify(json?.input ?? '');
    const i = text.indexOf(MARK);
    if (i >= 0 && line === null) line = text.slice(Math.max(0, text.lastIndexOf('\\n- ', i)), text.indexOf('\\n', i + MARK.length)).replace(/\\n/g, '');
  };
  // The scripted model with no script: it records, and answers every request 400.
  const L = await b.model('ENDPOINT', { markers: [MARK, root], inspect });
  const layer = path.join(b.work, 'team');
  fs.mkdirSync(path.join(layer, 'skills', NAME), { recursive: true });
  fs.writeFileSync(path.join(layer, 'spec.toml'), '[spec]\nname = "team"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');
  fs.writeFileSync(path.join(layer, 'skills', NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: Take bench notes. ${MARK}\n---\nWrite the notes.\n`);
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[endpoints.openai-responses]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const common = ['--harness', 'codex', '--folder', folder, '--bin', codex];
  const start = async (spec) => {
    const l = fromSpec(spec, {}, codex, ['--skip-git-repo-check', PROMPT]);
    return b.launch([L], l.argv, l.env, cwd);
  };
  const marked = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  // The endpoint and the model reach the launch; the plain layer has no skill.
  const plain = path.join(b.work, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'spec.toml'), '[spec]\nname = "plain"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');

  const control = await start(b.hs('launch-spec', [...common, '--layer', plain, '--local', local, '--headless']));
  const plan = b.hs('plan', [...common, '--layer', layer, '--owner', 'tier1', '--mode', 'materialize']);
  const planFile = path.join(b.work, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const noReceipt = path.join(b.work, 'receipt-none.json');
  fs.writeFileSync(noReceipt, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: [], by: 'tier1-bench' }));
  const refused = b.hsCall('apply', [...common, '--plan', planFile, '--receipt', noReceipt]);
  const writtenBeforeReceipt = fs.existsSync(path.join(folder, 'skills', NAME));
  const receipt = path.join(b.work, 'receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench' }));
  b.hs('apply', [...common, '--plan', planFile, '--receipt', receipt]);
  const applied = await start(b.hs('launch-spec', [...common, '--layer', plain, '--local', local, '--headless']));
  const launchSpec = b.hsCall('launch-spec', [...common, '--layer', layer, '--local', local, '--headless']);
  const config = fs.readFileSync(path.join(folder, 'config.toml'), 'utf8');

  const checks = {
    'before apply no request carries the skill (premise)': control.seen.ENDPOINT.length > 0 && !marked(control, MARK),
    'apply without a receipt for runs-code is refused, and writes nothing': refused.ok === false && refused.error.code === 'receipt_required' && !writtenBeforeReceipt,
    'the plan writes one tree, skills/<name>, runs-code': plan.operations.length === 1 && plan.operations[0].address_id === `skills/${NAME}` && plan.operations[0].risk.includes('runs-code'),
    'after apply the skill reaches the request: Codex loads $CODEX_HOME/skills': marked(applied, MARK),
    // The catalog names a file by a root alias, `(file: r<N>/<name>/SKILL.md)`, and the request lists
    // the roots; the folder's skills root is among them.
    'the catalog line names the skill\'s SKILL.md under a root alias, and the request names $CODEX_HOME/skills as a root': typeof line === 'string' && new RegExp(`\\(file: r\\d+/${NAME}/SKILL\\.md\\)`).test(line) && marked(applied, root),
    'config.toml is byte for byte the user\'s': config === configText,
    'launch-spec skips the installed skill, and does not refuse it': launchSpec.ok === true && launchSpec.result.skipped.some((x) => x.item === `skill.${NAME}`),
  };
  const reached = control.seen.ENDPOINT.length > 0 && applied.seen.ENDPOINT.length > 0;
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const shape = (r) => ({ exit: r.exit, timed_out: r.timed_out, requests: r.seen.ENDPOINT.length, skill_marker: marked(r, MARK), skills_root: marked(r, root) });
  const report = {
    check: 'tier 1: a skill materialized into $CODEX_HOME/skills reaches Codex (design note v0.2 §7.5); fails loudly if Codex stops loading that deprecated root',
    at: new Date().toISOString(),
    evidence: evidence(b, codex),
    runs: { control: shape(control), applied: shape(applied) },
    catalog_line: line ? line.split(b.work).join('<WORK>') : null,
    refusal: refused.ok ? null : { code: refused.error.code },
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(L.url).join('<ENDPOINT>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 Codex skills materialized check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
