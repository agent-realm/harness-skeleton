// The launch extension for pi (design note v0.2 §5.6, §7.5, milestones 8.1 and 8.2): a module pi
// loads with -e and awaits before startup continues. It registers the endpoint's provider and the
// spec's MCP servers for this session only, so nothing is written into the folder, and runs hs's
// hook shim (src/shim/pi.js) for each spec hook [P15:extensions, P15:custom-provider, P15:mcp]. A
// launch writes this file into its temp dir with its configuration in place of the marker below, as
// JSON of one whole object (src/drivers/pi/extension.js): every spec value is data in that object,
// never code. It imports nothing but node: modules.
//
// Hooks, by the pi event each rides on:
// - PreToolUse on tool_call: the shim's exit 0 continues; exit 2 blocks with its stderr as the reason.
//   Anything else fails closed: another exit, a signal, a shim that cannot start, a payload that
//   cannot be sent, or a shim still running at the hook's limit plus the margin, when its process
//   group is killed and the call blocked at once. A call that names no tool fails closed under a
//   guard with a matcher.
// - UserPromptSubmit on input: the same, a block being {action: "handled"}, which skips the agent.
// - Stop on agent_before_settle: the shim's exit 2 asks pi for one more run, its reason added as a
//   message for the model, as a Stop block does on Claude Code; stop_hook_active tells the hook the
//   run it ends was one it asked for. Anything else lets the agent stop.
// - PostToolUse on tool_result, SessionStart on session_start, SessionEnd on session_shutdown:
//   notification only; the extension never fails there.
// Once every handler is registered, it writes a marker into the launch's temp dir, which
// launch-spec names under `readiness`. An extension that does not load stops pi altogether
// (tier 1), so hooks never silently go missing.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG = /* hs:config */ null;

const MAX_OUTPUT = 64 * 1024;

// The shim's result: {code, signal, stderr} once it closes, {error} if it cannot start, or
// {timedOut} at its limit, when its whole group is killed.
function runShim(H, hook, payload) {
  return new Promise((resolve) => {
    let child = null;
    let stderr = '';
    let done = false;
    const end = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      end({ timedOut: true });
    }, hook.limit_ms + H.margin_ms);
    try {
      child = spawn(H.node, [H.shim, hook.event, ...hook.args], { stdio: ['pipe', 'ignore', 'pipe'], detached: true });
    } catch (e) {
      end({ error: String(e?.code ?? 'spawn failed') });
      return;
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    child.on('error', (e) => end({ error: String(e?.code ?? 'error') }));
    child.on('close', (code, signal) => end({ code, signal, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

function failure(r) {
  if (r.timedOut) return 'ran past its limit and was stopped';
  if (r.error) return `could not start (${r.error})`;
  if (r.code === null || r.code === undefined) return `died by ${r.signal ?? 'a signal'}`;
  return `exited ${r.code}`;
}

// The spec's SessionStart sources, from pi's reasons; reload and fork have none.
const SOURCE = { startup: 'startup', resume: 'resume', new: 'clear' };

function registerHooks(pi, H) {
  const hooks = H.list.map((h) => ({ ...h, re: h.matcher === null ? null : new RegExp(h.matcher) }));
  const on = (event) => hooks.filter((h) => h.event === event);
  const subject = (h, value) => h.re === null || (typeof value === 'string' && h.re.test(value));
  const where = (ctx) => ({ session_id: ctx?.sessionManager?.getSessionId?.() ?? null, cwd: typeof ctx?.cwd === 'string' ? ctx.cwd : process.cwd() });
  // A gate: every matching hook in order; the first that does not continue decides.
  const gate = async (list, payload) => {
    for (const h of list) {
      let body;
      try {
        body = JSON.stringify(payload);
      } catch (e) {
        return `hs launch extension: ${h.id}: the event could not be handed to the hook (${e?.name ?? 'error'}); failing closed`;
      }
      const r = await runShim(H, h, body);
      if (r.code === 0) continue;
      if (r.code === 2 && r.stderr.trim()) return r.stderr.trim();
      return `hs launch extension: ${h.id}: the hook shim ${failure(r)}; failing closed`;
    }
    return null;
  };
  // Notification: every matching hook runs; nothing it does changes the session.
  const notify = async (list, payload) => {
    for (const h of list) {
      try {
        await runShim(H, h, JSON.stringify(payload));
      } catch {
        // a notification hook that fails changes nothing
      }
    }
  };

  const pre = on('PreToolUse');
  if (pre.length) {
    const guarded = pre.some((h) => h.re !== null);
    pi.on('tool_call', async (event, ctx) => {
      if (guarded && typeof event?.toolName !== 'string') return { block: true, reason: 'hs launch extension: the tool call names no tool, so a guard\'s matcher cannot be tested; failing closed' };
      const reason = await gate(pre.filter((h) => subject(h, event?.toolName)), { ...event, ...where(ctx) });
      return reason === null ? undefined : { block: true, reason };
    });
  }
  const post = on('PostToolUse');
  if (post.length) {
    pi.on('tool_result', async (event, ctx) => {
      await notify(post.filter((h) => subject(h, event?.toolName)), { toolName: event?.toolName, toolCallId: event?.toolCallId, input: event?.input, isError: event?.isError, ...where(ctx) });
    });
  }
  const prompt = on('UserPromptSubmit');
  if (prompt.length) {
    pi.on('input', async (event, ctx) => {
      const reason = await gate(prompt, { text: event?.text, source: event?.source, prompt: event?.text, ...where(ctx) });
      if (reason === null) return { action: 'continue' };
      if (ctx?.hasUI) ctx.ui?.notify?.(reason, 'error');
      return { action: 'handled' };
    });
  }
  const start = on('SessionStart');
  if (start.length) {
    pi.on('session_start', async (event, ctx) => {
      const source = SOURCE[event?.reason] ?? null;
      await notify(start.filter((h) => subject(h, source)), { reason: event?.reason, source, ...where(ctx) });
    });
  }
  const end = on('SessionEnd');
  if (end.length) {
    pi.on('session_shutdown', async (event, ctx) => {
      await notify(end, { reason: event?.reason, ...where(ctx) });
    });
  }
  const stop = on('Stop');
  if (stop.length) {
    let asked = false;
    pi.on('agent_before_settle', async (event, ctx) => {
      const active = asked;
      asked = false;
      let reason = null;
      for (const h of stop) {
        let r;
        try {
          r = await runShim(H, h, JSON.stringify({ stop_hook_active: active, ...where(ctx) }));
        } catch {
          continue;
        }
        if (r.code === 2 && r.stderr.trim()) {
          reason = r.stderr.trim();
          break;
        }
      }
      if (reason === null) return undefined;
      asked = true;
      return { entries: [...(event?.entries ?? []), { type: 'custom_message', customType: 'hs-stop-hook', content: reason, display: false }], continue: true };
    });
  }
}

export default function (pi) {
  if (CONFIG.provider) pi.registerProvider(CONFIG.provider.id, CONFIG.provider.config);
  for (const [name, config] of CONFIG.mcp) pi.registerMcpServer(name, config);
  if (CONFIG.hooks) {
    registerHooks(pi, CONFIG.hooks);
    // Every handler registered: say so, beside this file in the launch's temp dir.
    try {
      writeFileSync(fileURLToPath(new URL(CONFIG.hooks.marker, import.meta.url)), JSON.stringify({ extension: 'hs-launch', hooks: CONFIG.hooks.list.length, pid: process.pid, at: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch {
      // no marker: a caller sees the hooks are not known to be active
    }
  }
}
