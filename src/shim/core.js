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
// other code, dies by a signal, or runs past --timeout (stopped by the shim, SIGKILL) blocks too:
// a guard that crashes or stalls fails closed. A block's reason is never empty: an empty stderr on
// exit 2 lets the call through on some harnesses [CX §11].
//
//   node src/shim/<harness>.js <Event> [--may-allow] [--timeout <s>] [--cwd <dir>] [--env K=V]... [--env-ref K=VAR]... -- <exec> [args...]
//
// `--env-ref K=VAR` gives the process K from the shim's own variable VAR, which the caller filled
// from a reference at launch (§5.3), so no value or `${…}` is ever in the command line.

import { spawnSync } from 'node:child_process';
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
  const mcp = new RegExp(`^${H.mcp_prefix}(.+?)__(.+)$`);

  // The tool class of a native tool name, by the hook table; an MCP tool is mcp:<server>.
  function toolClass(name) {
    if (typeof name !== 'string') return null;
    for (const [cls, names] of Object.entries(H.classes)) if (names.includes(name)) return cls;
    const m = mcp.exec(name);
    return m ? `mcp:${m[1]}` : null;
  }

  // The envelope's `hs` part from a native payload (§5.6).
  function envelope(event, native) {
    const hs = { event, session_id: native.session_id ?? null, cwd: native.cwd ?? null };
    if (H.tool_events.includes(event)) {
      const input = native.tool_input ?? {};
      const name = native.tool_name ?? null;
      const m = typeof name === 'string' ? mcp.exec(name) : null;
      // A patch tool carries its patch in `command`: its paths are the patch's, and it is no shell
      // command.
      const patch = (H.patch_tools ?? []).includes(name);
      const paths = patch ? patchPaths(H, input.command) : [input.file_path, input.notebook_path, input.path].filter((p) => typeof p === 'string');
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

function run(H) {
  const { envelope, block, translate } = shimFor(H);
  let opts;
  let native = {};
  try {
    opts = parseArgs(process.argv.slice(2));
    const raw = fs.readFileSync(0, 'utf8');
    native = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    const t = block(opts?.event ?? process.argv[2], `hs hook shim: ${e.message}`);
    if (t.stdout) process.stdout.write(t.stdout);
    if (t.stderr) process.stderr.write(t.stderr);
    process.exit(t.code);
  }
  const env = { ...process.env, ...opts.env };
  for (const [k, v] of Object.entries(opts.envRefs)) env[k] = process.env[v] ?? '';
  const limit = Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout * 1000 : undefined;
  const res = spawnSync(opts.command[0], opts.command.slice(1), {
    input: JSON.stringify(envelope(opts.event, native)), cwd: opts.cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    timeout: limit, killSignal: 'SIGKILL',
  });
  const timedOut = res.error?.code === 'ETIMEDOUT';
  let t;
  if (res.error && !timedOut) t = block(opts.event, `hs hook shim: the hook's process could not be run (${res.error.code ?? res.error.message}); failing closed`);
  else t = translate(opts.event, { ...res, timedOut }, { mayAllow: opts.mayAllow });
  if (t.stdout) process.stdout.write(t.stdout);
  if (t.stderr) process.stderr.write(t.stderr);
  process.exit(t.code);
}

// Run as the hook command when the driver's shim file is the script node was given.
export function mainIf(H, url) {
  if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url))) run(H);
}
