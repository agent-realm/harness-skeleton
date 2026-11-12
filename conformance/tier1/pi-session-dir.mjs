#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §8), on pi. It starts the real harness, so it runs only on
// a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/pi-session-dir.mjs --pi <path> [--hs-rev <sha>] [--keep]
//
// pi keeps a working directory's sessions in <agent dir>/sessions/<group>, the group its own
// encoding of that directory (getDefaultSessionDirPath, the 1.5.2 package: dist/core/
// session-manager.js), and reads a project's .pi/settings.json sessionDir before it resolves
// project trust. Given the working directory (`--cwd`), hs's launch passes --session-dir with the
// group it computes; that copies a pi internal, so this check compares it with what pi writes.
// For each working directory (a plain name, one with spaces, one with a colon, one in unicode, and
// one reached through a symlink), in a folder of its own:
//   plain      hs's launch without --cwd: the group pi itself writes
//   computed   hs's launch-spec with --cwd: the group in its --session-dir
//   project    with .pi/settings.json { sessionDir: "./elsewhere" } in the working directory, hs's
//              launch with --cwd: where the session lands
//   continued  the project file removed, hs's launch without --cwd and with --continue: whether pi
//              takes up the newest session of that group (no new file; the file grows)
// and, for the first directory only, the premise: with the project file, hs's launch without --cwd
// writes the session into ./elsewhere. The model is scripted, the key a dummy. Names only.

import fs from 'node:fs';
import path from 'node:path';
import { DUMMY, REF_VAR, bench, evidence, guard } from '../lib/bench.mjs';

const pi = guard('pi-session-dir.mjs', '--pi');
const PROMPT = 'tier 1 pi session dir check';
const b = bench('hs-tier1-pi-session-dir-');

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};
const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.statSync(path.join(d, n)).isDirectory()).sort() : []);
const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).sort() : []);
const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);

try {
  const plain = path.join(b.work, 'plain');
  put(path.join(plain, 'spec.toml'), '[spec]\nname = "plain"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');
  const root = path.join(b.scratch.HOME, 'projects');
  const cases = [['plain-name', 'work'], ['spaces', 'with some spaces'], ['colon', 'co:lon'], ['unicode', 'ünïcødé-日本'], ['symlink', null]];

  // One hs launch, run as a caller runs it: `runIn` is where pi runs, `given` the cwd hs is told.
  const launch = async (folder, runIn, { given, extra = [] } = {}) => {
    const L = await b.model('ENDPOINT', { fallback: { text: 'done' } });
    const local = path.join(b.work, `local-${path.basename(folder)}.toml`);
    put(local, `[endpoints.openai-chat]\nbase_url = "${L.url}/v1"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
    const spec = b.hs('launch-spec', ['--harness', 'pi', '--folder', folder, '--layer', plain, '--local', local, '--bin', pi, '--headless', ...(given ? ['--cwd', given] : [])]);
    const env = { ...spec.env_set };
    for (const [v, ref] of Object.entries(spec.env_from_refs)) {
      if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
      env[v] = DUMMY;
    }
    for (const v of spec.env_unset) env[v] = undefined;
    const r = await b.launch([L], [pi, ...spec.argv.slice(1), ...extra, PROMPT], env, runIn);
    if (spec.temp_dir) fs.rmSync(spec.temp_dir, { recursive: true, force: true });
    return { spec, exit: r.exit, requests: r.seen.ENDPOINT.length };
  };

  const runs = {};
  for (const [key, name] of cases) {
    const folder = path.join(b.work, `pi-${key}`);
    fs.mkdirSync(folder, { recursive: true });
    let cwd = path.join(root, name ?? 'real-work');
    fs.mkdirSync(cwd, { recursive: true });
    let runIn = cwd;
    if (name === null) {
      runIn = path.join(root, 'linked-work');
      fs.symlinkSync(cwd, runIn);
      cwd = fs.realpathSync.native(cwd);
    }
    const sessions = path.join(folder, 'sessions');
    const out = { requests: [] };

    const first = await launch(folder, runIn);
    out.requests.push(first.requests);
    const written = dirs(sessions);
    out.pi_groups = written.length;
    const piGroup = written[0] ?? null;

    const computed = b.hs('launch-spec', ['--harness', 'pi', '--folder', folder, '--layer', plain, '--bin', pi, '--headless', '--cwd', runIn]);
    const sd = computed.argv[computed.argv.indexOf('--session-dir') + 1];
    out.computed_matches_pi = piGroup !== null && sd === path.join(folder, 'sessions', piGroup);
    out.bound_cwd_is_real = computed.cwd === cwd;

    put(path.join(cwd, '.pi', 'settings.json'), { sessionDir: './elsewhere' });
    if (key === 'plain-name') {
      const moved = await launch(folder, runIn);
      out.requests.push(moved.requests);
      out.premise_moved = files(path.join(cwd, 'elsewhere')).length === 1;
    }
    const before = files(path.join(sessions, piGroup ?? '-'));
    const project = await launch(folder, runIn, { given: runIn });
    out.requests.push(project.requests);
    const after = files(path.join(sessions, piGroup ?? '-'));
    const added = after.filter((f) => !before.includes(f));
    out.project_kept_in_group = added.length === 1 && dirs(sessions).length === 1;
    out.project_elsewhere = files(path.join(cwd, 'elsewhere')).length - (key === 'plain-name' ? 1 : 0);

    fs.rmSync(path.join(cwd, '.pi'), { recursive: true, force: true });
    const newest = added[0] ? path.join(sessions, piGroup, added[0]) : null;
    const was = newest ? size(newest) : 0;
    const continued = await launch(folder, runIn, { extra: ['--continue'] });
    out.requests.push(continued.requests);
    out.continued_newest = newest !== null && files(path.join(sessions, piGroup)).length === after.length && size(newest) > was;
    runs[key] = out;
  }

  const R = Object.values(runs);
  const checks = {
    'premise: a project .pi/settings.json sessionDir moves a session hs launches without --cwd out of the folder': runs['plain-name'].premise_moved === true,
    'each working directory gets one group from pi, and hs\'s computed --session-dir is exactly it: spaces, a colon, unicode and a symlink included': R.every((r) => r.pi_groups === 1 && r.computed_matches_pi && r.bound_cwd_is_real),
    'with the project\'s sessionDir present, hs\'s launch with --cwd writes the session into that group, and none elsewhere': R.every((r) => r.project_kept_in_group && r.project_elsewhere === 0),
    'a later plain start with --continue takes up the session hs\'s launch wrote, as pi\'s own': R.every((r) => r.continued_newest),
    'every launch reached the model': R.every((r) => r.requests.every((n) => n > 0)),
  };
  const verdict = !checks[Object.keys(checks)[0]] ? 'inconclusive: the premise failed' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: pi\'s session directory under hs\'s launch, and the group hs computes for a working directory (design note v0.2 §8)',
    at: new Date().toISOString(),
    evidence: evidence(b, pi),
    runs,
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 pi session dir check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}
