#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.2 endpoint hygiene, §7.2), on Claude Code. It starts the
// real harness, so it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/account-state.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// A plan for a spec with an endpoint clears the cached claude.ai account state in .claude.json, a
// one-way state write, and launch-spec only names what is left. That design holds if an endpoint
// start never writes the state back, and if the clear leaves a .claude.json the harness still
// starts from. Both are measured here. One local listener stands in for the endpoint; it records
// the kind of credential and which planted markers a request carries, never a value.
//   fresh-1, fresh-2  hs's endpoint launch in a fresh folder, twice. Expected: no account state
//                     key in .claude.json after either start.
//   control           a folder with dummy account state planted; launch-spec must name it; a start
//                     without the clear. Recorded: whether the planted ids reach the endpoint.
//   cleared           the same folder, the state planted again, after hs plan and apply (overlay,
//                     the receipt allowing the clear; at least one key must be cleared). Expected: the keys gone, launch-spec silent, the start reaching the
//                     endpoint with no planted id, and no key written back.
// No model and no account is reached: the listener is local, the credential and the account
// state are dummies, and HOME and the XDG roots are scratch.

import fs from 'node:fs';
import path from 'node:path';
import ccDriver from '../../src/drivers/claude-code/index.js';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';

const claude = guard('account-state.mjs');
const AS = ccDriver.descriptor.account_state;
const MARKERS = ['acct-bench-0000', 'org-bench-0000', 'bench@example.invalid', 'hs-bench-flag'];
const PROMPT = 'tier 1 account state check';
const b = bench('hs-tier1-account-state-');

// The account state keys a folder's .claude.json holds, by name.
function accountKeys(folder) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(folder, AS.file), 'utf8'));
    return AS.keys.filter((k) => Object.hasOwn(doc, k));
  } catch (e) {
    return [`unreadable: ${e.code ?? 'not JSON'}`];
  }
}
const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, at_endpoint: r.seen.ENDPOINT });
const noteOf = (spec) => spec.notes.find((n) => n.includes('account state')) ?? null;

try {
  const L = await b.listener('ENDPOINT', { markers: MARKERS });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const layer = path.join(b.work, 'layer');
  fs.mkdirSync(layer);
  fs.writeFileSync(path.join(layer, 'spec.toml'), '[spec]\nname = "tier1-account-state"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[endpoints.anthropic-messages]\nbase_url = "${L.url}"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const launchSpec = (f) => b.hs('launch-spec', ['--harness', 'claude-code', '--folder', f, '--layer', layer, '--local', local, '--bin', claude, '--headless']);
  const start = (spec) => {
    const l = fromSpec(spec, {}, claude, [PROMPT]);
    return b.launch([L], l.argv, l.env, cwd);
  };

  const runs = {};
  const fresh = path.join(b.work, 'fresh');
  fs.mkdirSync(fresh);
  for (const n of [1, 2]) {
    const r = await start(launchSpec(fresh));
    runs[`fresh-${n}`] = { ...shape(r), account_keys_after: accountKeys(fresh) };
  }

  const planted = path.join(b.work, 'planted');
  fs.mkdirSync(planted);
  const STATE = {
    oauthAccount: { accountUuid: 'acct-bench-0000', emailAddress: 'bench@example.invalid', organizationUuid: 'org-bench-0000' },
    cachedGrowthBookFeatures: { 'hs-bench-flag': true },
    cachedGrowthBookFeaturesAt: 1,
  };
  // Merged into what the folder's .claude.json holds now, so the harness's own keys stay.
  const plant = () => {
    const file = path.join(planted, AS.file);
    let doc = {};
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // none yet
    }
    fs.writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, ...doc, ...STATE }));
  };
  plant();
  const plantedKeys = accountKeys(planted);
  const before = launchSpec(planted);
  const control = await start(before);
  runs.control = { ...shape(control), account_keys_before: plantedKeys, launch_spec_note: noteOf(before), account_keys_after: accountKeys(planted) };

  // The state is planted again after the control start, which may have rewritten the file, so
  // the plan always has the same keys to clear.
  plant();
  const replanted = accountKeys(planted);
  // The clear, as a tool makes it: plan, a receipt that allows its operations, apply.
  const plan = b.hs('plan', ['--harness', 'claude-code', '--folder', planted, '--layer', layer, '--local', local, '--owner', 'tier1', '--mode', 'overlay', '--bin', claude]);
  const planFile = path.join(b.work, 'plan.json');
  const receiptFile = path.join(b.work, 'receipt.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  fs.writeFileSync(receiptFile, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: plan.operations.filter((o) => o.risk.length).map((o) => o.id), by: 'tier1-bench' }));
  b.hs('apply', ['--harness', 'claude-code', '--folder', planted, '--plan', planFile, '--receipt', receiptFile, '--bin', claude]);
  const clearedKeys = accountKeys(planted);
  const after = launchSpec(planted);
  const cleared = await start(after);
  runs.cleared = {
    ...shape(cleared), plan_operations: plan.operations.map((o) => `${o.action} ${o.address_id} [${o.risk.join(',')}]`),
    account_keys_after_apply: clearedKeys, launch_spec_note: noteOf(after), account_keys_after: accountKeys(planted),
  };

  const all = Object.values(runs);
  const reached = all.every((r) => r.at_endpoint.length > 0);
  const credentialsOk = all.every((r) => r.at_endpoint.every((q) => q.credential === 'bearer:bench-dummy'));
  const checks = {
    'no endpoint start writes account state back': ['fresh-1', 'fresh-2', 'cleared'].every((k) => runs[k].account_keys_after.length === 0),
    'launch-spec names the planted state': runs.control.launch_spec_note !== null && plantedKeys.every((k) => runs.control.launch_spec_note.includes(k)),
    // Never vacuous: the replanted keys are there, and the plan must clear each of them, at least one.
    'the plan clears every planted key, and nothing else': replanted.length > 0 && replanted.length === plantedKeys.length
      && plan.operations.length === replanted.length
      && plan.operations.every((o) => o.action === 'clear' && o.risk.includes('clears-state') && replanted.includes(o.address.key)),
    'apply leaves no account state': clearedKeys.length === 0,
    'launch-spec is silent after the clear': runs.cleared.launch_spec_note === null,
    'no planted id reaches the endpoint after the clear': runs.cleared.at_endpoint.every((q) => q.markers.length === 0),
  };
  const verdict = !reached || !credentialsOk
    ? `inconclusive: ${!reached ? 'a start reached no endpoint' : 'a request carried a credential other than the bench dummy'}`
    : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: endpoint hygiene, the cached account state cleared one way and not written back (design note v0.2 §5.2, §7.2)',
    at: new Date().toISOString(),
    evidence: evidence(b, claude),
    runs,
    checks,
    observations: {
      'planted ids at the endpoint before the clear': [...new Set(runs.control.at_endpoint.flatMap((q) => q.markers))],
      'account state keys the control start left in place': runs.control.account_keys_after,
    },
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 account state check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
