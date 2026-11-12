// The hooks bridge for OpenCode 2.x (design note §5.6, §8): a plugin in the shape `Plugin.define`
// takes, `{ id, setup(ctx) }`, as a plain module with no import but node: ones, so OpenCode installs
// nothing to load it [tier 1, opencode-bridge]. A launch writes this file into its config directory's
// plugins/, with the launch's configuration in place of the marker below
// (src/drivers/opencode/bridge.js). For each spec hook it runs hs's hook shim (./opencode.js), with
// the plugin event and the session's directory on stdin, and reads the shim's exit code.
//
// - PreToolUse is ctx.tool.hook("execute.before"), the one plugin hook whose rejection refuses
//   anything: a throw rejects the call before it runs, and its message reaches the model
//   [G2:packages/core/src/plugin/hooks.ts, packages/plugin/src/promise/adapter.ts; tier 1]. The
//   shim's exit 0 continues; its exit 2 blocks, its stderr the reason. Anything else fails closed,
//   as a failed guard does on the other drivers: another exit, a signal, a shim that cannot start,
//   a payload that cannot be sent, or a shim still running at the hook's limit plus the margin, when
//   its process group is killed and the call blocked at once (a descendant holding the pipes must
//   not hold the call).
// - PostToolUse is ctx.tool.hook("execute.after"), which cannot refuse: a rejection there is a
//   defect, not a refusal. So the bridge never rejects there, whatever the shim does.
//
// The shim runs in a process group of its own (detached), so the group kill reaches it and what it
// started, never OpenCode.
//
// Once its hooks are registered, setup() writes a marker file into the launch's temp dir
// (CONFIG.marker, relative to this file), which launch-spec names under `readiness`: a bridge that
// OpenCode skips writes none, so a caller can tell guards that never loaded from guards that did.
// A tool call that names no tool fails closed when a guard has a matcher, since the matcher cannot
// be tested.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG = /* hs:config */ null;

const MAX_OUTPUT = 64 * 1024;

// The shim's result: {code, signal, stderr} once it closes, {error} if it cannot start, or
// {timedOut} at its limit.
function runShim(hook, payload) {
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
    }, hook.limit_ms + CONFIG.margin_ms);
    try {
      child = spawn(CONFIG.node, [CONFIG.shim, hook.event, ...hook.args], { stdio: ['pipe', 'ignore', 'pipe'], detached: true });
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

// Why a shim result is no decision, for the fail-closed reason.
function failure(r) {
  if (r.timedOut) return 'ran past its limit and was stopped';
  if (r.error) return `could not start (${r.error})`;
  if (r.code === null || r.code === undefined) return `died by ${r.signal ?? 'a signal'}`;
  return `exited ${r.code}`;
}

export default {
  id: CONFIG.id,
  async setup(ctx) {
    const directory = typeof ctx?.location?.directory === 'string' ? ctx.location.directory : process.cwd();
    const hooks = CONFIG.hooks.map((h) => ({ ...h, re: h.matcher === null ? null : new RegExp(h.matcher) }));
    const matching = (on, event) => hooks.filter((h) => h.on === on && (h.re === null || (typeof event?.tool === 'string' && h.re.test(event.tool))));
    const payload = (event) => JSON.stringify({ ...event, directory });

    const guarded = hooks.some((h) => h.on === 'execute.before' && h.re !== null);
    if (hooks.some((h) => h.on === 'execute.before')) {
      await ctx.tool.hook('execute.before', async (event) => {
        if (guarded && typeof event?.tool !== 'string') throw new Error('hs hooks bridge: the tool call names no tool, so a guard\'s matcher cannot be tested; failing closed');
        for (const h of matching('execute.before', event)) {
          let body;
          try {
            body = payload(event);
          } catch (e) {
            throw new Error(`hs hooks bridge: ${h.id}: the tool call could not be handed to the hook (${e?.name ?? 'error'}); failing closed`);
          }
          const r = await runShim(h, body);
          if (r.code === 0) continue;
          if (r.code === 2 && r.stderr.trim()) throw new Error(r.stderr.trim());
          throw new Error(`hs hooks bridge: ${h.id}: the hook shim ${failure(r)}; failing closed`);
        }
      });
    }
    if (hooks.some((h) => h.on === 'execute.after')) {
      await ctx.tool.hook('execute.after', async (event) => {
        for (const h of matching('execute.after', event)) {
          try {
            await runShim(h, payload(event));
          } catch {
            // execute.after cannot refuse; a hook that fails there changes nothing
          }
        }
      });
    }
    // Every hook is registered: say so. A marker that cannot be written is a bridge not known to
    // have loaded, which is what a caller then sees.
    if (typeof CONFIG.marker === 'string') try {
      writeFileSync(fileURLToPath(new URL(CONFIG.marker, import.meta.url)), JSON.stringify({ plugin: CONFIG.id, hooks: CONFIG.hooks.length, pid: process.pid, at: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch {
      // no marker
    }
  },
};
