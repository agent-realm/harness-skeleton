// Claude Code's hook table: what hs's hook shim needs to speak Claude Code's hook protocol. It lives
// beside the shim's core, so src/shim/ is self-contained: a plan copies this directory into a
// folder's hs-run/hook-shim/ for persisted hooks (design note §7.5), and nothing in it imports
// from outside it. The driver's descriptor imports it as launch.hooks.
//
// Hooks at launch: `hooks.<Event>[] = {matcher, hooks: [{type: "command", command, timeout}]}`
// in the --settings overlay; hooks merge across settings levels, so the folder's own still run
// [CC §11 D-hooks, §2]. The portable and facet events (§5.6) are Claude Code's own names. A
// matcher of names joined by | is exact; anything else is a regex [CC §11]. The tool classes:
// tool names observed in 2.1.307's requests [CC §11 B-hooks]; an MCP tool is
// mcp__<server>__<tool> [CC §8 B-mcp]. The input is JSON on stdin; exit 2 blocks, with stderr
// as the reason; JSON on stdout carries decision "block" or hookSpecificOutput
// (permissionDecision, additionalContext) [CC §11].
// The closing comment of a persisted hook's command (persist below).
const recovery = (event, copy, owner) => `# hs: a persisted ${event} hook (${copy}/); to take it away: hs remove --owner ${owner} on this folder, or delete this entry from settings.json hooks.${event}`;

export const CLAUDE_CODE_HOOKS = Object.freeze({
  settings_key: 'hooks',
  events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'PermissionRequest', 'SubagentStart', 'SubagentStop'],
  tool_events: ['PreToolUse', 'PostToolUse', 'PermissionRequest'],
  // The events whose block refuses an action: a guard there fails closed (§5.6). Stop is not
  // one, since blocking it keeps the agent going.
  gating_events: ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit'],
  // The events where a block takes effect at all; on the others exit 2 only shows stderr
  // [D-hooks §Exit code 2 behavior per event, read 2026-10-22]. PermissionRequest blocks only
  // through its decision object: exit 2 is not honoured there [D-hooks §PermissionRequest
  // decision control].
  blocking_events: ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreCompact'],
  permission_request_deny: (message) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } }),
  // Claude Code cancels a hook that reaches its timeout and goes on, which on PreToolUse lets
  // the call through [D-hooks §Timeouts]. So the shim stops the process itself, SIGKILL, at
  // the hook's limit, and decides; the native timeout is set above it. A limit when the spec
  // gives none: 60 s.
  default_limit: 60,
  timeout_margin: 10,
  // Persisted hooks under materialize (design note §7.5): each is a group in settings.json's
  // hooks.<Event> array, run through the shim copied into hs-run/hook-shim/. A gating hook sets
  // onFailure "block", so a hook that cannot start (node gone, the copy missing) blocks rather
  // than letting the action through: "Can't start" counts as a failure, and "block" does what
  // exit 2 does on that event, except PermissionRequest, which it denies. It needs Claude Code
  // 2.1.295 or later, and has no effect on Stop and SubagentStop [code.claude.com/docs/en/hooks
  // §onFailure, read 2026-10-23].
  persist: {
    shim_tree: 'hs-run/hook-shim',
    shim_entry: 'claude-code.js',
    on_failure: { field: 'onFailure', value: 'block', min_version: '2.1.295' },
    // The comment ending each persisted command: the way out, which Claude Code quotes when the
    // hook cannot start, and the element's identity. A group is hs's for a hook only when it holds
    // one handler whose command ends with this comment, exactly, for that hook's copy in this
    // folder and its event, under any owner name: a mention of another hook's path anywhere earlier
    // in a command never counts, and neither does another folder's comment.
    recovery,
    owns: (v, { copy, event }) => {
      if (v === null || typeof v !== 'object' || !Array.isArray(v.hooks) || v.hooks.length !== 1) return false;
      const command = v.hooks[0]?.command;
      if (typeof command !== 'string') return false;
      const [head, tail] = recovery(event, copy, '\0').split('\0');
      if (!command.endsWith(tail)) return false;
      const at = command.lastIndexOf(head, command.length - tail.length - head.length);
      return at >= 0 && /^[a-z][a-z0-9-]{0,63}$/.test(command.slice(at + head.length, command.length - tail.length));
    },
  },
  classes: { shell: ['Bash'], edit: ['Edit', 'Write', 'NotebookEdit'], read: ['Read'], fetch: ['WebFetch', 'WebSearch'] },
  mcp_prefix: 'mcp__',
  // A matcher of only these characters (and |) is exact; anything else is a regex [CC §11].
  exact: /^[A-Za-z0-9_-]+$/,
});

export default CLAUDE_CODE_HOOKS;
