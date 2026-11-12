// The hook shim's core, for every driver (design note §5.6). A harness runs a driver's shim as a
// hook command; the shim reads the native payload on stdin, hands the spec's process one envelope,
// `{"hs": {...}, "native": {...}}`, and translates the process's decision back to the harness's
// protocol, as the driver's hook table `H` says:
//   exit 0                      continue (plain stdout passes through)
//   exit 2                      block, stderr the reason
//   stdout {"decision": "deny"} block, with its reason (exit 2, the reason on stderr)
//   stdout {"decision": "allow"} on PreToolUse, for a hook that declared may_allow (--may-allow):
//                               permissionDecision allow; otherwise, continue
//   stdout {"context": "…"}     hookSpecificOutput.additionalContext, on the events that take it
// A process that cannot be run blocks (exit 2). On a gating event, a process that exits with any
// other code, dies by a signal, or runs past --timeout blocks too: a guard that crashes or stalls
// fails closed. A block's reason is never empty: an empty stderr on exit 2 lets the call through on
// some harnesses [CX §11].
// The process runs in a process group of its own. At --timeout the shim kills that whole group,
// SIGKILL, and decides at once: a process the hook started (a shell's forked command, say) never
// outlives the decision, and never holds it by keeping the pipes open. A hook that exits on its
// own within its limit is not touched; what it leaves running in the background is its own.
// Its own group is also its own session (no controlling terminal), so a harness that cancels the
// hook by signalling the shim (SIGTERM, SIGINT, SIGHUP) no longer reaches it: the shim kills the
// group then, and blocks. Anything that throws on the way blocks too, never exit 1, which some
// harnesses read as a non-blocking error.
//
//   node src/shim/<harness>.js <Event> [--may-allow] [--timeout <s>] [--cwd <dir>] [--env K=V]... [--env-ref K=VAR]... -- <exec> [args...]
//
// `--env-ref K=VAR` gives the process K from the shim's own variable VAR, which the caller filled
// from a reference at launch (§5.3), so no value or `${…}` is ever in the command line.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The paths a patch names, by its file headers (`*** Update File: <path>` and the like).
function patchPaths(H, text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split('\n')) {
    for (const h of H.patch_headers) if (line.startsWith(h)) out.push(line.slice(h.length).trim());
  }
  return out;
}

export function shimFor(H) {
  // Where the native payload keeps each field: Claude Code's and Codex's names, unless the table
  // names its own (OpenCode's bridge hands over the plugin event, `sessionID`, `tool`, `input`).
  const F = { session_id: 'session_id', cwd: 'cwd', tool_name: 'tool_name', tool_input: 'tool_input', ...(H.fields ?? {}) };
  // An MCP tool's name, where the harness gives it a form of its own. A table with no prefix (OpenCode)
  // has none, so there an MCP tool has no class.
  const mcp = typeof H.mcp_prefix === 'string' ? new RegExp(`^${H.mcp_prefix}(.+?)__(.+)$`) : null;

  // The tool class of a native tool name, by the hook table; an MCP tool is mcp:<server>.
  function toolClass(name) {
    if (typeof name !== 'string') return null;
    for (const [cls, names] of Object.entries(H.classes)) if (names.includes(name)) return cls;
    const m = mcp?.exec(name);
    return m ? `mcp:${m[1]}` : null;
  }

  // The envelope's `hs` part from a native payload (§5.6).
  function envelope(event, native) {
    const hs = { event, session_id: native[F.session_id] ?? null, cwd: native[F.cwd] ?? null };
    if (H.tool_events.includes(event)) {
      const raw = native[F.tool_input];
      const input = raw !== null && typeof raw === 'object' ? raw : {};
      const name = native[F.tool_name] ?? null;
      const m = typeof name === 'string' && mcp ? mcp.exec(name) : null;
      // A patch tool carries its patch in one field (`command` unless the table names another): its
      // paths are the patch's, and it is no shell command.
      const patch = (H.patch_tools ?? []).includes(name);
      const paths = patch ? patchPaths(H, input[H.patch_field ?? 'command']) : [input.file_path, input.notebook_path, input.path].filter((p) => typeof p === 'string');
      hs.tool = {
        class: toolClass(name), name,
        input: {
          ...(!patch && typeof input.command === 'string' ? { command: input.command } : {}),
          ...(paths.length ? { paths } : {}),
          ...(typeof input.url === 'string' ? { url: input.url } : {}),
          ...(m ? { mcp: { server: m[1], tool: m[2] } } : {}),
        },
      };
    }
    if (typeof native.prompt === 'string') hs.prompt = native.prompt;
    if (typeof native.source === 'string') hs.source = native.source;
    return { hs, native };
  }

  // A block, as the event takes one: the decision object where the harness wants one, else exit
  // 2 with a reason that is never empty.
  function block(event, reason) {
    const why = typeof reason === 'string' && reason.trim() ? reason : `the ${event} hook blocked`;
    if (event === 'PermissionRequest' && H.permission_request_deny) return { code: 0, stdout: JSON.stringify(H.permission_request_deny(why)), stderr: '' };
    return { code: 2, stdout: '', stderr: why };
  }

  // The native result for a process's {status, signal, stdout, stderr, timedOut}: {code, stdout, stderr}.
  function translate(event, res, { mayAllow = false } = {}) {
    if (res.status === 2) return block(event, res.stderr);
    // A guard that crashes, or runs past its limit, fails closed: on a gating event, any exit but
    // 0 and 2, a signal, or the shim's own timeout, blocks.
    if (H.gating_events.includes(event) && (res.status !== 0 || res.timedOut)) {
      const how = res.timedOut ? 'ran past its limit and was stopped' : res.status === null || res.status === undefined ? `died by ${res.signal ?? 'a signal'}` : `exited ${res.status}`;
      return block(event, `the ${event} hook's process ${how}; failing closed${res.stderr ? `: ${res.stderr}` : ''}`);
    }
    const out = (res.stdout ?? '').trim();
    let decision = null;
    if (out.startsWith('{') && out.endsWith('}')) {
      try {
        decision = JSON.parse(out);
      } catch {
        decision = null;
      }
    }
    // A harness that takes output starting with { or [ as JSON, and lets the call through when it
    // does not parse [CX §11], gets a block instead on a gating event: such output must be one JSON
    // object. Plain text still passes.
    if (H.json_looking && H.gating_events.includes(event) && /^[{[]/.test(out) && (decision === null || typeof decision !== 'object' || Array.isArray(decision))) {
      return block(event, `the ${event} hook's output looks like JSON and is not one JSON object; failing closed`);
    }
    if (!decision || typeof decision !== 'object') return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    if (decision.decision === 'deny') return block(event, typeof decision.reason === 'string' ? decision.reason : 'denied by a hook');
    const specific = { hookEventName: event };
    // An allow skips the permission prompt, so only a hook that declared may_allow, which the launch
    // receipt names as grants-permission, may give one.
    if (decision.decision === 'allow' && event === 'PreToolUse' && mayAllow) {
      specific.permissionDecision = 'allow';
      if (typeof decision.reason === 'string') specific.permissionDecisionReason = decision.reason;
    }
    // Context only where the harness takes it: an output field an event does not define makes the
    // whole output invalid on a strict harness [CX §11].
    if (typeof decision.context === 'string' && (!H.context_events || H.context_events.includes(event))) specific.additionalContext = decision.context;
    const native = Object.keys(specific).length > 1 ? { hookSpecificOutput: specific } : {};
    return { code: 0, stdout: Object.keys(native).length ? JSON.stringify(native) : '', stderr: res.stderr ?? '' };
  }

  return { toolClass, envelope, block, translate };
}

export function parseArgs(argv) {
  const [event, ...rest] = argv;
  const opts = { event, mayAllow: false, timeout: undefined, cwd: undefined, env: {}, envRefs: {}, command: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      opts.command = rest.slice(i + 1);
      break;
    }
    if (a === '--may-allow') {
      opts.mayAllow = true;
      continue;
    }
    const v = rest[++i];
    if (a === '--cwd') opts.cwd = v;
    else if (a === '--timeout') opts.timeout = Number(v);
    else if (a === '--env' || a === '--env-ref') {
      const eq = v.indexOf('=');
      (a === '--env' ? opts.env : opts.envRefs)[v.slice(0, eq)] = v.slice(eq + 1);
    } else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

const MAX_OUTPUT = 16 * 1024 * 1024;

// Runs the hook's process in a group of its own: {status, signal, stdout, stderr} once it closes,
// {error} if it cannot be run or its output passes MAX_OUTPUT, {timedOut} at the limit, the group
// killed in the last two cases.
// `onStart(killGroup)` is called once the process runs, for a caller that must stop it early.
export function runProcess(argv, { input, cwd, env, limit, onStart }) {
  return new Promise((resolve) => {
    let child = null;
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    const end = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...r });
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      end({ error: e });
      return;
    }
    onStart?.(killGroup);
    if (limit) {
      timer = setTimeout(() => {
        killGroup();
        end({ status: null, signal: 'SIGKILL', timedOut: true });
      }, limit);
    }
    const take = (which) => (d) => {
      if (which === 'out') stdout += d;
      else stderr += d;
      if (stdout.length + stderr.length > MAX_OUTPUT) {
        killGroup();
        end({ error: Object.assign(new Error('output past its limit'), { code: 'ENOBUFS' }) });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));
    child.on('error', (e) => end({ error: e }));
    child.on('close', (status, signal) => end({ status, signal }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Writes a native result and exits with its code.
function finish(t) {
  if (t.stdout) process.stdout.write(t.stdout);
  if (t.stderr) process.stderr.write(t.stderr);
  process.exit(t.code);
}

async function run(H) {
  const { envelope, block, translate } = shimFor(H);
  let opts;
  let native = {};
  try {
    opts = parseArgs(process.argv.slice(2));
    const raw = fs.readFileSync(0, 'utf8');
    native = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    finish(block(opts?.event ?? process.argv[2], `hs hook shim: ${e.message}`));
  }
  // A harness that cancels the hook signals the shim: the hook's group goes with it, and the
  // event is blocked.
  let stop = null;
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      stop?.();
      finish(block(opts.event, `hs hook shim: the hook was cancelled (${sig}) and its processes stopped; failing closed`));
    });
  }
  const env = { ...process.env, ...opts.env };
  for (const [k, v] of Object.entries(opts.envRefs)) env[k] = process.env[v] ?? '';
  const limit = Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout * 1000 : undefined;
  const res = await runProcess(opts.command, { input: JSON.stringify(envelope(opts.event, native)), cwd: opts.cwd, env, limit, onStart: (kill) => { stop = kill; } });
  if (res.error) finish(block(opts.event, `hs hook shim: the hook's process could not be run (${res.error.code ?? res.error.message}); failing closed`));
  finish(translate(opts.event, res, { mayAllow: opts.mayAllow }));
}

// Run as the hook command when the driver's shim file is the script node was given. Whatever throws
// on the way is a block for the event, with a reason, never Node's exit 1.
export function mainIf(H, url) {
  if (!process.argv[1] || fs.realpathSync(process.argv[1]) !== fs.realpathSync(fileURLToPath(url))) return;
  const { block } = shimFor(H);
  run(H).catch((e) => finish(block(process.argv[2], `hs hook shim: ${e?.message ?? String(e)}; failing closed`)));
}
