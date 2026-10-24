#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §10, "Retention holds between launches"), on Claude Code.
// It starts the real harness, so it runs only on a bench: a disposable VM or a CI runner. Never
// on a user's workstation, never against a user's data folder (AGENTS.md, Testing). It refuses
// to run unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/retention-between-launches.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// Three throwaway data folders each hold a transcript planted 50 days old:
//   A  [state] retention_days = 400 delivered under overlay (persisted: it keeps more than 30),
//      plus a second transcript planted 500 days old, older than 400: its deletion proves A's
//      own sweep ran, so A keeping the 50-day one is retention, not a start that never swept
//   B  the control: nothing delivered
//   C  delivered like A, then launched from a project whose .claude/settings.json sets 1 day
// Claude Code then starts once in each folder WITHOUT the overlay. Expected: the 50-day transcript
// survives in A while A's 500-day one is gone, and the 50-day one is gone from B (the positive control: the sweep ran) and from C (only managed
// policy is a floor, design note §5.12). No model is reached: the launch points at a dead local
// port with a dummy key, under a scratch HOME and XDG roots, with every login variable unset.
// The verdict is pass, fail, or inconclusive when the control's transcript survives.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hsBin = path.join(repo, 'bin', 'hs.js');
const DAY = 86_400_000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
}

// The hs commit the check ran: --hs-rev, else the checkout's own HEAD, else unknown. A bench copy
// usually carries no .git, so the caller passes it.
function hsRev() {
  const given = arg('--hs-rev');
  if (given) return given;
  const p = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return p.status === 0 ? p.stdout.trim() : 'unknown';
}

if (process.env.HS_BENCH !== '1') {
  process.stderr.write('refusing to run: a tier 1 check starts a real harness; set HS_BENCH=1 on a bench only\n');
  process.exit(2);
}
const claude = arg('--claude');
if (!claude) {
  process.stderr.write('usage: HS_BENCH=1 node conformance/tier1/retention-between-launches.mjs --claude <path> [--hs-rev <sha>] [--keep]\n');
  process.exit(2);
}

const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-tier1-retention-')));
const scratch = {
  HOME: path.join(work, 'home'),
  XDG_CONFIG_HOME: path.join(work, 'xdg', 'config'),
  XDG_DATA_HOME: path.join(work, 'xdg', 'data'),
  XDG_CACHE_HOME: path.join(work, 'xdg', 'cache'),
  XDG_STATE_HOME: path.join(work, 'xdg', 'state'),
  TMPDIR: path.join(work, 'tmp'),
};

// From here on, the scratch directory is removed on every way out: a normal end, an error, or
// SIGINT/SIGTERM (Node skips `finally` on a signal). --keep keeps it.
function cleanup() {
  if (process.argv.includes('--keep')) process.stderr.write(`kept ${work}\n`);
  else fs.rmSync(work, { recursive: true, force: true });
}
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    cleanup();
    process.exit(code);
  });
}

function hs(op, args) {
  const out = execFileSync(process.execPath, [hsBin, op, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...scratch } });
  const res = JSON.parse(out);
  if (!res.ok) throw new Error(`hs ${op}: ${res.error.code}: ${res.error.message}`);
  return res.result;
}

// A transcript planted `days` old, in a project of its own.
function plant(f, id, days) {
  const t = path.join(f, 'projects', '-bench-old-project', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, JSON.stringify({ type: 'user', message: { role: 'user', content: 'planted by the tier 1 retention check' } }) + '\n');
  const when = new Date(Date.now() - days * DAY);
  fs.utimesSync(t, when, when);
  return t;
}

// A folder with one transcript planted 50 days old.
function folder(name) {
  const f = path.join(work, name);
  return { f, t: plant(f, '0b1f5a3e-4c2d-4e8f-9a7b-1c2d3e4f5a6b', 50) };
}

try {
for (const d of Object.values(scratch)) fs.mkdirSync(d, { recursive: true });
const A = folder('A');
A.ancient = plant(A.f, '7c9e2d41-0a3b-4f6e-8d5c-2b1a0f9e8d7c', 500);
const B = folder('B');
const C = folder('C');
const layer = path.join(work, 'layer');
fs.mkdirSync(layer);
fs.writeFileSync(path.join(layer, 'spec.toml'), '[spec]\nname = "tier1"\nversion = "1.0.0"\nformat = "0.2"\n');
const local = path.join(work, 'local.toml');
fs.writeFileSync(local, '[state]\nretention_days = 400\n');

// Deliver under overlay to A and C, through plan and apply as a tool would.
const delivered = {};
for (const x of [A, C]) {
  const plan = hs('plan', ['--harness', 'claude-code', '--folder', x.f, '--layer', layer, '--local', local, '--owner', 'tier1', '--mode', 'overlay', '--bin', claude]);
  const planFile = path.join(work, `plan-${path.basename(x.f)}.json`);
  const receiptFile = path.join(work, `receipt-${path.basename(x.f)}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  fs.writeFileSync(receiptFile, JSON.stringify({ format: 'hs-receipt/0.2', plan_digest: plan.digest, allows: [], by: 'tier1-bench' }));
  hs('apply', ['--harness', 'claude-code', '--folder', x.f, '--plan', planFile, '--receipt', receiptFile, '--bin', claude]);
  delivered[path.basename(x.f)] = JSON.parse(fs.readFileSync(path.join(x.f, 'settings.json'), 'utf8')).cleanupPeriodDays;
}

// The working directories: a plain one, and a project that sets a short period.
const plain = path.join(work, 'work');
const shortProject = path.join(work, 'short-project');
fs.mkdirSync(plain);
fs.mkdirSync(path.join(shortProject, '.claude'), { recursive: true });
fs.writeFileSync(path.join(shortProject, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 1 }));

// One start per folder, without the overlay. Only PATH comes from outside; the model endpoint is a
// dead local port with a dummy key, so nothing reaches a model or an account.
function start(x, cwd) {
  const env = {
    PATH: process.env.PATH,
    ...scratch,
    CLAUDE_CONFIG_DIR: x.f,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: 'hs-tier1-dummy-not-a-key',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const p = spawnSync(claude, ['-p', 'tier 1 retention check'], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  return { exit: p.status, signal: p.signal, timed_out: p.error?.code === 'ETIMEDOUT' };
}
const starts = { A: start(A, plain), B: start(B, plain), C: start(C, shortProject) };

const kept = (x) => fs.existsSync(x.t);
const observed = {
  A: hs('observe', ['--harness', 'claude-code', '--folder', A.f, '--state']).state.retention_days,
  C: hs('observe', ['--harness', 'claude-code', '--folder', C.f, '--state', '--cwd', shortProject]).state.retention_days,
};
const result = { A_kept: kept(A), A_500_day_kept: fs.existsSync(A.ancient), B_kept: kept(B), C_kept: kept(C) };
const verdict = result.B_kept || result.A_500_day_kept
  ? `inconclusive: ${result.B_kept ? 'the control' : 'A'} kept a transcript older than its period, so its sweep did not run`
  : result.A_kept && !result.C_kept
      && delivered.A === 400 && delivered.C === 400
      && observed.A.source === 'folder' && observed.A.value === 400
      && observed.C.source === 'project' && observed.C.value === 1
    ? 'pass'
    : 'fail';

const version = spawnSync(claude, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...scratch } }).stdout.trim();
const report = {
  check: 'tier 1: retention holds between launches (design note v0.2 §10)',
  at: new Date().toISOString(),
  evidence: { harness: version, node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, hs_commit: hsRev() },
  delivered,
  starts,
  observed: { A: { value: observed.A.value, source: observed.A.source }, C: { value: observed.C.value, source: observed.C.source } },
  result,
  expected: {
    delivered: { A: 400, C: 400 },
    observed: { A: { value: 400, source: 'folder' }, C: { value: 1, source: 'project' } },
    result: { A_kept: true, A_500_day_kept: false, B_kept: false, C_kept: false },
  },
  verdict,
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 retention check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  cleanup();
}
