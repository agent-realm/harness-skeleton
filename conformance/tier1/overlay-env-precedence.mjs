#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §7.5, "the overlay's env wins per variable"), on Claude Code.
// It starts the real harness, so it runs only on a bench: a disposable VM or a CI runner. Never
// on a user's workstation, never against a user's data folder (AGENTS.md, Testing). It refuses
// to run unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/overlay-env-precedence.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// A settings `env` value overwrites the shell value [CC §19], so hs's launch-spec repeats every
// variable it sets in the --settings overlay, the command-line level above the folder's settings
// [CC §2], and cancels the cloud switches there with "". An endpoint launch also unsets every
// other credential variable. Both carry the no-leak guarantee of an endpoint launch, so they are
// measured here, not inferred.
//
// Two local listeners stand in for endpoints: FOLDER, the one the folder's own settings.json names,
// and ENDPOINT, the one the spec names. Each records the path, the model and the kind of credential
// of every request it gets (never a value), and answers 400. Six launches, each in a fresh folder
// with no login. A control runs without hs and shows the premise; its check is the launch hs
// describes, built the way a caller builds it: its own shell, then env_set, the credential
// reference resolved, then env_unset.
//   control-a  the folder's settings env sets ANTHROPIC_BASE_URL=FOLDER and role variables; the
//              shell sets ANTHROPIC_BASE_URL=ENDPOINT and other role values.
//              Expected at FOLDER: the folder's settings beat the shell (the premise).
//   check-a    the same folder and shell, plus ambient credentials; hs's launch-spec for an endpoint
//              at ENDPOINT with roles. Expected at ENDPOINT only, with the spec's roles.
//   control-b  the folder's settings env selects Bedrock (CLAUDE_CODE_USE_BEDROCK=1) with its base
//              URL at FOLDER and auth skipped; the shell points at ENDPOINT. Expected at FOLDER.
//   check-b    the same folder and shell, plus ambient credentials; hs's launch-spec. Expected at
//              ENDPOINT only: the overlay's "" cancelled the switch.
//   control-c  no folder settings; the shell holds the endpoint's key as ANTHROPIC_API_KEY and an
//              ambient ANTHROPIC_AUTH_TOKEN, which outranks it [CC §7]. Expected: the ambient token
//              reaches ENDPOINT (the leak an earlier fix closed).
//   check-c    the same shell; hs's launch-spec for an endpoint with auth = "x-api-key". Expected:
//              only the key reaches ENDPOINT; env_unset cleared the ambient token.
// No model and no account is reached: both listeners are local, every credential is a dummy, and
// HOME and the XDG roots are scratch. A variable no request shows (a small or subagent model a
// one-shot prompt never uses) is reported as not observed, never as a pass.
//
// Each launch runs in a process group of its own. After it exits, whatever is left of the group is
// killed and waited for (and recorded); on an error or SIGINT/SIGTERM too, before the scratch
// directory is removed. A descendant that leaves the group (setsid) is out of reach.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hsBin = path.join(repo, 'bin', 'hs.js');
const DUMMY = 'hs-tier1-dummy-not-a-key';
const AMBIENT = 'hs-tier1-ambient-not-a-key';
const REF_VAR = 'HS_BENCH_ENDPOINT_TOKEN';

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
  process.stderr.write('usage: HS_BENCH=1 node conformance/tier1/overlay-env-precedence.mjs --claude <path> [--hs-rev <sha>] [--keep]\n');
  process.exit(2);
}

const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-tier1-overlay-env-')));
const scratch = {
  HOME: path.join(work, 'home'),
  XDG_CONFIG_HOME: path.join(work, 'xdg', 'config'),
  XDG_DATA_HOME: path.join(work, 'xdg', 'data'),
  XDG_CACHE_HOME: path.join(work, 'xdg', 'cache'),
  XDG_STATE_HOME: path.join(work, 'xdg', 'state'),
  TMPDIR: path.join(work, 'tmp'),
};
const quiet = { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

// The running launch's process group (its leader's pid), or null.
let group = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killGroup(g = group) {
  if (g === null) return;
  try {
    process.kill(-g, 'SIGKILL');
  } catch {
    // already gone
  }
}

// Kill whatever is left of the launch's group and wait until none of it runs. Returns whether
// anything was left running when it was called. The group is captured once: a signal's cleanup
// and the launch itself may both wait on it, and a cleared `group` must never become kill(0).
async function endGroup() {
  const g = group;
  if (g === null) return false;
  let left = false;
  try {
    process.kill(-g, 0);
    left = true;
  } catch {
    // nothing left
  }
  killGroup(g);
  const until = Date.now() + 10_000;
  for (;;) {
    try {
      process.kill(-g, 0);
    } catch (e) {
      if (e.code === 'ESRCH') {
        if (group === g) group = null;
        return left;
      }
      throw e;
    }
    if (Date.now() > until) throw new Error(`process group ${g} did not exit`);
    await sleep(50);
  }
}

// The scratch directory goes only once the launch's group is gone. --keep keeps it.
const servers = [];
function removeScratch() {
  if (process.argv.includes('--keep')) process.stderr.write(`kept ${work}\n`);
  else fs.rmSync(work, { recursive: true, force: true });
}
async function cleanup() {
  for (const s of servers) s.closeAllConnections?.();
  try {
    await endGroup();
    removeScratch();
    return true;
  } catch (e) {
    process.stderr.write(`${e.message}; kept ${work}\n`);
    return false;
  }
}
let stopping = false;
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    cleanup().finally(() => process.exit(code));
  });
}

// The kind of credential a request carries, never its value.
function kind(v) {
  return v === DUMMY ? 'bench-dummy' : v === AMBIENT ? 'ambient' : 'other';
}
function credentialKind(headers) {
  const kinds = [];
  const bearer = /^Bearer (.*)$/i.exec(headers.authorization ?? '');
  if (bearer) kinds.push(`bearer:${kind(bearer[1])}`);
  if (headers['x-api-key'] !== undefined) kinds.push(`x-api-key:${kind(headers['x-api-key'])}`);
  return kinds.length ? kinds.join(',') : 'none';
}

// A listener that records each request and answers 400, which a client does not retry.
function listener(name) {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let model = null;
      try {
        model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model ?? null;
      } catch {
        // not JSON
      }
      // Bedrock carries the model in the path.
      const inPath = /^\/model\/([^/]+)\//.exec(req.url ?? '');
      log.push({ method: req.method, path: (req.url ?? '').split('?')[0], model: model ?? (inPath ? decodeURIComponent(inPath[1]) : null), credential: credentialKind(req.headers) });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `hs tier 1 bench listener ${name}: not a model` } }));
    });
  });
  servers.push(server);
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ name, log, url: `http://127.0.0.1:${server.address().port}` })));
}

function hs(op, args) {
  const out = execFileSync(process.execPath, [hsBin, op, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...scratch } });
  const res = JSON.parse(out);
  if (!res.ok) throw new Error(`hs ${op}: ${res.error.code}: ${res.error.message}`);
  return res.result;
}

// A fresh folder with no login, whose settings.json sets `env`.
function folder(name, env) {
  const f = path.join(work, name);
  fs.mkdirSync(f);
  fs.writeFileSync(path.join(f, 'settings.json'), JSON.stringify({ env }, null, 2) + '\n');
  return f;
}

// One headless start, in a process group of its own. Only PATH comes from outside. A start that
// cannot be spawned rejects, so the outer handler reports it and cleans up.
function start(argv, env, cwd) {
  return new Promise((ok, fail) => {
    let timedOut = false;
    let settled = false;
    const p = spawn(argv[0], argv.slice(1), { cwd, env: { PATH: process.env.PATH, ...scratch, ...quiet, ...env }, stdio: 'ignore', detached: true });
    group = p.pid ?? null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, 120_000);
    p.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      fail(new Error(`${argv[0]} could not be started: ${e.code ?? e.message}`));
    });
    p.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      ok({ exit: code, signal, timed_out: timedOut });
    });
  });
}

const PROMPT = 'tier 1 overlay env check';

// Run one launch with both listeners' logs cleared first; return what each one saw, and whether
// any of its process group outlived it.
async function launch(L, argv, env, cwd) {
  // A signal's cleanup kills the running launch; the next one must not start behind it.
  if (stopping) throw new Error('stopped by a signal');
  for (const l of Object.values(L)) l.log.length = 0;
  const started = await start(argv, env, cwd);
  const left = await endGroup();
  return { ...started, descendants_left: left, folder: [...L.folder.log], endpoint: [...L.endpoint.log] };
}

// The launch hs describes, built as a caller builds it: its own shell, then env_set, then each
// reference resolved (here only the bench's own env: reference, to the dummy), then env_unset.
function fromSpec(spec, shell) {
  const env = { ...shell, ...spec.env_set };
  for (const [v, ref] of Object.entries(spec.env_from_refs)) {
    if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
    env[v] = DUMMY;
  }
  for (const v of spec.env_unset) delete env[v];
  return { argv: [claude, ...spec.argv.slice(1), PROMPT], env };
}

const models = (run) => [...run.folder, ...run.endpoint].map((r) => r.model).filter(Boolean);
const credentials = (run) => run.endpoint.map((r) => r.credential);

try {
  for (const d of Object.values(scratch)) fs.mkdirSync(d, { recursive: true });
  const L = { folder: await listener('FOLDER'), endpoint: await listener('ENDPOINT') };
  const cwd = path.join(work, 'work');
  fs.mkdirSync(cwd);

  const layer = path.join(work, 'layer');
  fs.mkdirSync(layer);
  fs.writeFileSync(path.join(layer, 'spec.toml'), '[spec]\nname = "tier1-overlay-env"\nversion = "1.0.0"\nformat = "0.2"\n\n'
    + '[model.roles]\nprimary = "bench-primary"\nsmall = "bench-small"\nsubagent = "bench-subagent"\n');
  const localFor = (name, auth) => {
    const f = path.join(work, `${name}.toml`);
    fs.writeFileSync(f, `[endpoints.anthropic-messages]\nbase_url = "${L.endpoint.url}"\ncredential = "env:${REF_VAR}"\nauth = "${auth}"\n\n[login]\nmode = "endpoint"\n`);
    return f;
  };
  const bearerLocal = localFor('local-bearer', 'bearer');
  const keyLocal = localFor('local-x-api-key', 'x-api-key');
  const spec = (f, local) => hs('launch-spec', ['--harness', 'claude-code', '--folder', f, '--layer', layer, '--local', local, '--bin', claude, '--headless']);

  const shell = { ANTHROPIC_BASE_URL: L.endpoint.url, ANTHROPIC_AUTH_TOKEN: DUMMY };
  const shellRoles = { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'shell-small', CLAUDE_CODE_SUBAGENT_MODEL: 'shell-subagent' };
  const ambient = { ANTHROPIC_API_KEY: AMBIENT, CLAUDE_CODE_OAUTH_TOKEN: AMBIENT };
  const base = [claude, '--model', 'bench-primary', '-p', '--output-format', 'json', PROMPT];
  const folderA = { ANTHROPIC_BASE_URL: L.folder.url, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'folder-small', CLAUDE_CODE_SUBAGENT_MODEL: 'folder-subagent' };
  const folderB = { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: L.folder.url, CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', AWS_REGION: 'us-east-1' };

  const fA1 = folder('control-a', folderA);
  const controlA = await launch(L, base, { ...shell, ...shellRoles, CLAUDE_CONFIG_DIR: fA1 }, cwd);
  const fA2 = folder('check-a', folderA);
  const specA = spec(fA2, bearerLocal);
  const a = fromSpec(specA, { ...shell, ...shellRoles, ...ambient });
  const overlayA = JSON.parse(fs.readFileSync(specA.files.find((x) => x.role === 'settings').path, 'utf8'));
  const checkA = await launch(L, a.argv, a.env, cwd);

  const fB1 = folder('control-b', folderB);
  const controlB = await launch(L, base, { ...shell, CLAUDE_CONFIG_DIR: fB1 }, cwd);
  const fB2 = folder('check-b', folderB);
  const b = fromSpec(spec(fB2, bearerLocal), { ...shell, ...ambient });
  const checkB = await launch(L, b.argv, b.env, cwd);

  const shellC = { ANTHROPIC_BASE_URL: L.endpoint.url, ANTHROPIC_API_KEY: DUMMY, ANTHROPIC_AUTH_TOKEN: AMBIENT, CLAUDE_CODE_OAUTH_TOKEN: AMBIENT };
  const fC1 = folder('control-c', {});
  const controlC = await launch(L, base, { ...shellC, CLAUDE_CONFIG_DIR: fC1 }, cwd);
  const fC2 = folder('check-c', {});
  const specC = spec(fC2, keyLocal);
  const c = fromSpec(specC, shellC);
  const checkC = await launch(L, c.argv, c.env, cwd);

  // Routing: fail when the folder's endpoint gets a request despite the overlay; pass when only
  // the spec's does and the control shows the folder's settings winning without the overlay.
  function routed(control, check) {
    if (check.folder.length) return 'fail: a request reached the folder\'s endpoint despite the overlay';
    if (!control.folder.length || control.endpoint.length) return 'inconclusive: without the overlay the folder\'s settings did not win, so the overlay\'s win is not shown';
    if (!check.endpoint.length) return 'inconclusive: no request reached either endpoint';
    return 'pass';
  }
  // A role: fail when the folder's value is used; pass only when the check uses the spec's value
  // and the control used the folder's value, not the shell's.
  function role(name, folderValue, shellValue, specValue) {
    const control = [...new Set(models(controlA).filter((m) => m === folderValue || m === shellValue))];
    const seen = models(checkA);
    const premise = control.includes(folderValue) && !control.includes(shellValue);
    const verdict = seen.includes(folderValue) ? 'fail: the folder\'s value was used'
      : !seen.includes(specValue) ? `not observed: no request named a ${name} model`
        : !premise ? 'inconclusive: without the overlay the folder\'s value did not win, so the overlay\'s win is not shown'
          : 'pass';
    return { verdict, control };
  }
  // The ambient token: fail when it reaches the endpoint at hs's launch; pass when only the key
  // does and the control shows the ambient token reaching the endpoint without hs.
  function cleared(control, check) {
    const got = credentials(check);
    if (got.some((k) => k.includes('ambient'))) return 'fail: an ambient credential reached the endpoint';
    if (!credentials(control).some((k) => k.includes('bearer:ambient'))) return 'inconclusive: without hs the ambient token did not reach the endpoint, so clearing it is not shown';
    if (!got.length) return 'inconclusive: no request reached the endpoint';
    if (!got.every((k) => k === 'x-api-key:bench-dummy')) return `fail: the endpoint got ${[...new Set(got)].join('; ')}`;
    return 'pass';
  }
  const variables = {
    ANTHROPIC_BASE_URL: routed(controlA, checkA),
    CLAUDE_CODE_USE_BEDROCK: routed(controlB, checkB),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: role('small', 'folder-small', 'shell-small', 'bench-small'),
    CLAUDE_CODE_SUBAGENT_MODEL: role('subagent', 'folder-subagent', 'shell-subagent', 'bench-subagent'),
    'ANTHROPIC_AUTH_TOKEN (ambient, endpoint auth = "x-api-key")': cleared(controlC, checkC),
  };
  const bearerChecks = [...credentials(checkA), ...credentials(checkB)];
  const bearerOk = bearerChecks.length > 0 && bearerChecks.every((k) => k === 'bearer:bench-dummy');
  const verdicts = Object.values(variables).map((v) => (typeof v === 'string' ? v : v.verdict));
  const required = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_AUTH_TOKEN (ambient, endpoint auth = "x-api-key")'];
  const verdict = verdicts.some((v) => v.startsWith('fail')) || !bearerOk
    ? 'fail'
    : required.every((k) => variables[k] === 'pass')
      ? 'pass'
      : 'inconclusive';

  const version = spawnSync(claude, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...scratch } }).stdout.trim();
  const shape = (run) => ({ exit: run.exit, signal: run.signal, timed_out: run.timed_out, descendants_left: run.descendants_left, at_folder: run.folder, at_endpoint: run.endpoint });
  const report = {
    check: 'tier 1: the --settings overlay env wins per variable over the folder\'s settings env, and an endpoint launch clears ambient credentials (design note v0.2 §7.5)',
    at: new Date().toISOString(),
    evidence: { harness: version, node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, hs_commit: hsRev() },
    launch_spec: {
      argv: specA.argv.map((x) => (x === specA.files[0]?.path ? '<overlay settings.json>' : x)),
      overlay: overlayA,
      env_unset: specA.env_unset,
      env_from_refs: { 'check-a/b': Object.keys(specA.env_from_refs), 'check-c': Object.keys(specC.env_from_refs) },
      unverified: specA.unverified,
    },
    launches: {
      'control-a': shape(controlA), 'check-a': shape(checkA),
      'control-b': shape(controlB), 'check-b': shape(checkB),
      'control-c': shape(controlC), 'check-c': shape(checkC),
    },
    variables,
    endpoint_credentials_a_b: bearerOk ? 'every request at the endpoint carried the bench dummy as a bearer token' : bearerChecks,
    expected: {
      'control-a': 'at FOLDER only', 'check-a': 'at ENDPOINT only, model bench-primary, bearer:bench-dummy',
      'control-b': 'at FOLDER only (Bedrock)', 'check-b': 'at ENDPOINT only, bearer:bench-dummy',
      'control-c': 'at ENDPOINT, with bearer:ambient', 'check-c': 'at ENDPOINT, with x-api-key:bench-dummy only',
    },
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict === 'inconclusive' ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 overlay env check failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!stopping) {
    if (!(await cleanup())) process.exitCode = 4;
    for (const s of servers) s.close();
  }
}
