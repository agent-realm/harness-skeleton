// Shared machinery for tier 1 checks that start a real harness (conformance/README.md): the bench
// guard, a scratch HOME and XDG roots, local listeners that stand in for endpoints, a scripted
// model (@agent-realm/scripted-model) for a check that needs the model to answer, launches in a
// process group of their own, and a cleanup that waits for that group before the scratch directory
// goes. The same rules as `tier1/overlay-env-precedence.mjs`, which predates this module.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptedModel } from '@agent-realm/scripted-model';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hsBin = path.join(repo, 'bin', 'hs.js');
export const DUMMY = 'hs-tier1-dummy-not-a-key';
export const REF_VAR = 'HS_BENCH_ENDPOINT_TOKEN';
const QUIET = { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
}

// Refuse off a bench; return the harness binary given by `flag`. `script` names the check in the
// usage line.
export function guard(script, flag = '--claude') {
  if (process.env.HS_BENCH !== '1') {
    process.stderr.write('refusing to run: a tier 1 check starts a real harness; set HS_BENCH=1 on a bench only\n');
    process.exit(2);
  }
  const bin = arg(flag);
  if (!bin) {
    process.stderr.write(`usage: HS_BENCH=1 node conformance/tier1/${script} ${flag} <path> [--hs-rev <sha>] [--keep]\n`);
    process.exit(2);
  }
  return bin;
}

// The hs commit the check ran: --hs-rev, else the checkout's own HEAD, else unknown.
export function hsRev() {
  const given = arg('--hs-rev');
  if (given) return given;
  const p = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return p.status === 0 ? p.stdout.trim() : 'unknown';
}

// A bench: a scratch directory with its own HOME and XDG roots, listeners, and at most one
// launch at a time, each in a process group of its own. `cleanup()` kills and waits for that
// group, then removes the directory (--keep keeps it); a group that will not exit keeps it too.
export function bench(prefix) {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const scratch = {
    HOME: path.join(work, 'home'),
    XDG_CONFIG_HOME: path.join(work, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(work, 'xdg', 'data'),
    XDG_CACHE_HOME: path.join(work, 'xdg', 'cache'),
    XDG_STATE_HOME: path.join(work, 'xdg', 'state'),
    TMPDIR: path.join(work, 'tmp'),
  };
  for (const d of Object.values(scratch)) fs.mkdirSync(d, { recursive: true });
  const servers = [];
  const models = [];
  let group = null;
  let stopping = false;

  const killGroup = (g = group) => {
    if (g === null) return;
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      // already gone
    }
  };
  // Captured once per call: a signal's cleanup and the launch may both wait, and a cleared group
  // must never become kill(0), the script's own group.
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
  async function cleanup() {
    for (const s of servers) s.closeAllConnections?.();
    for (const m of models) m.close();
    try {
      await endGroup();
      if (process.argv.includes('--keep')) process.stderr.write(`kept ${work}\n`);
      else fs.rmSync(work, { recursive: true, force: true });
      return true;
    } catch (e) {
      process.stderr.write(`${e.message}; kept ${work}\n`);
      return false;
    }
  }
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      cleanup().finally(() => process.exit(code));
    });
  }

  // A listener that records each request (path, model, the kind of credential among `known`
  // dummies, and which `markers` its body or headers carry) and answers 400.
  // `toolNames` also records the names of the tools a request offers the model, names only. A
  // check that needs the model to answer uses `model` below.
  function listener(name, { known = { [DUMMY]: 'bench-dummy' }, markers = [], toolNames = false } = {}) {
    const log = [];
    // Own properties only: a credential such as `constructor` is not a label.
    const kind = (v) => (Object.hasOwn(known, v) ? known[v] : 'other');
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          // not JSON
        }
        const kinds = [];
        const bearer = /^Bearer (.*)$/i.exec(req.headers.authorization ?? '');
        if (bearer) kinds.push(`bearer:${kind(bearer[1])}`);
        if (req.headers['x-api-key'] !== undefined) kinds.push(`x-api-key:${kind(req.headers['x-api-key'])}`);
        const headers = Object.values(req.headers).join('\n');
        log.push({
          method: req.method, path: (req.url ?? '').split('?')[0], model: json?.model ?? null,
          credential: kinds.length ? kinds.join(',') : 'none',
          markers: markers.filter((m) => body.includes(m) || headers.includes(m)),
          ...(toolNames && Array.isArray(json?.tools) ? { tools: json.tools.map((t) => t?.name ?? t?.type ?? null) } : {}),
        });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `hs tier 1 bench listener ${name}: not a model` } }));
      });
    });
    servers.push(server);
    return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ name, log, url: `http://127.0.0.1:${server.address().port}` })));
  }

  // A scripted model standing in for an endpoint: it records as a listener does (the credential's
  // kind among `known` dummies, `markers`, tool names), on 127.0.0.1 only, and answers from the
  // script a run `load`s ({ steps, fallback }, the package's format); with none loaded, every
  // request gets 400. `inspect(body)` is the check's own look at a request, for what the harness
  // sent back (a tool's output, say); the check keeps names only.
  async function model(name, { known = { [DUMMY]: 'bench-dummy' }, markers = [], inspect } = {}) {
    const m = await scriptedModel({ markers, credentials: known, inspect });
    models.push(m);
    return { name, log: m.seen, url: m.url, load: m.load };
  }

  // One headless start in a process group of its own; only PATH comes from outside. A start that
  // cannot be spawned rejects.
  function start(argv, env, cwd) {
    if (stopping) return Promise.reject(new Error('stopped by a signal'));
    return new Promise((ok, fail) => {
      let timedOut = false;
      let settled = false;
      const p = spawn(argv[0], argv.slice(1), { cwd, env: { PATH: process.env.PATH, ...scratch, ...QUIET, ...env }, stdio: 'ignore', detached: true });
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

  // A launch with every listener's log cleared first: what each saw, and whether any of the
  // launch's group outlived it.
  async function launch(listeners, argv, env, cwd) {
    for (const l of listeners) l.log.length = 0;
    const started = await start(argv, env, cwd);
    const left = await endGroup();
    return { ...started, descendants_left: left, seen: Object.fromEntries(listeners.map((l) => [l.name, [...l.log]])) };
  }

  // The whole response, ok or not (the CLI exits 1 on an error response).
  function hsCall(op, args) {
    let out;
    try {
      out = execFileSync(process.execPath, [hsBin, op, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...scratch }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (typeof e.stdout !== 'string' || e.stdout === '') throw e;
      out = e.stdout;
    }
    return JSON.parse(out);
  }
  function hs(op, args) {
    const res = hsCall(op, args);
    if (!res.ok) throw new Error(`hs ${op}: ${res.error.code}: ${res.error.message}`);
    return res.result;
  }

  async function finish() {
    if (stopping) return true;
    const ok = await cleanup();
    for (const s of servers) s.close();
    for (const m of models) await m.close();
    return ok;
  }

  return { work, scratch, listener, model, launch, hs, hsCall, finish, version: (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...scratch } }).stdout.trim() };
}

// The launch hs describes, built as a caller builds it: its own shell, then env_set, each
// reference resolved (only the bench's own env: reference, to the dummy), then env_unset.
export function fromSpec(spec, shell, bin, tail) {
  const env = { ...shell, ...spec.env_set };
  for (const [v, ref] of Object.entries(spec.env_from_refs)) {
    if (ref !== `env:${REF_VAR}`) throw new Error(`unexpected reference for ${v}`);
    env[v] = DUMMY;
  }
  for (const v of spec.env_unset) delete env[v];
  return { argv: [bin, ...spec.argv.slice(1), ...tail], env };
}

export function evidence(b, bin) {
  return { harness: b.version(bin), node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, hs_commit: hsRev() };
}
