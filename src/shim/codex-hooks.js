// Codex's hook table: what hs's hook shim needs to speak Codex's hook protocol. It lives
// beside the shim's core, so src/shim/ is self-contained: a plan copies this directory into a
// folder's hs-run/hook-shim/ for persisted hooks (design note §7.5), and nothing in it imports
// from outside it. The driver's descriptor imports it as launch.hooks.
//
// Hooks at launch [CX §11; source at rust-v0.160.0, read 2026-10-22, the task's
// codex-hooks-source note]. `-c hooks.<Event>=[{matcher, hooks: [{type: "command", command,
// timeout}]}]` loads as the SessionFlags layer, whose hooks need trust like the user's: its key
// source is `/<session-flags>/config.toml` (hooks/src/engine/discovery.rs synthetic_layer_path),
// and trust state is read from the user and session-flag layers only, later layers winning per
// field (hooks/src/config_rules.rs). So one `-c hooks.state={…}` table names each handler's
// `trusted_hash` for this launch; a second `-c hooks.state` would replace the first
// (config/src/overrides.rs). Never --dangerously-bypass-hook-trust: it trusts every hook.
// The key: `<source>:<event label>:<group>:<handler>`, indexes from 0 (hooks/src/lib.rs
// hook_key). The hash: sha256 of the canonical JSON (keys sorted, compact) of `{event_name:
// <label>, matcher (matcher events only), hooks: [the one normalized handler]}`, the handler
// `{type, command, timeout, async}` with unset fields left out (discovery.rs hook_hash,
// config/src/fingerprint.rs version_for_toml).
// Codex runs the command as `<zsh|bash|sh> -c <command>` with its full environment, not the
// shell policy (hooks/src/engine/command_runner.rs). PreToolUse lets the call through on a
// spawn error, a timeout, an exit other than 0 and 2, a signal, exit 2 with an empty stderr, or
// stdout that is JSON and does not parse (hooks/src/events/pre_tool_use.rs), so the shim
// decides each of those itself. A bare `allow` on PreToolUse is a failed hook: Codex takes allow
// only with updatedInput, which rewrites the call. Output fields are deny_unknown_fields, and
// additionalContext exists only on the context events (hooks/src/schema.rs).
export const CODEX_HOOKS = Object.freeze({
  config_key: 'hooks',
  state_key: 'hooks.state',
  trust_gate: 'codex hook trust (the /hooks review)',
  key_source: '/<session-flags>/config.toml',
  events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'PermissionRequest', 'SubagentStart', 'SubagentStop'],
  labels: { SessionStart: 'session_start', SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt_submit', PreToolUse: 'pre_tool_use', PostToolUse: 'post_tool_use', Stop: 'stop', PreCompact: 'pre_compact', PostCompact: 'post_compact', PermissionRequest: 'permission_request', SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop' },
  // The events whose matcher counts, in matching and in the hash (events/common.rs).
  matcher_events: ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact'],
  tool_events: ['PreToolUse', 'PostToolUse', 'PermissionRequest'],
  gating_events: ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit'],
  blocking_events: ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreCompact'],
  context_events: ['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'SubagentStart'],
  // Output whose trimmed start is { or [ is taken as JSON, and a hook whose JSON does not parse
  // is a failed hook, which lets a PreToolUse call through (engine/output_parser.rs
  // looks_like_json, events/pre_tool_use.rs).
  json_looking: true,
  // Exit 2 with stderr denies a PermissionRequest too, so no decision object is needed.
  permission_request_deny: null,
  default_limit: 60,
  timeout_margin: 10,
  // SessionEnd hooks are capped at 3 s (discovery.rs normalize_command_hook): the shim's limit
  // stays a second under it.
  capped: { SessionEnd: 3 },
  // The shell tool and the patch tool report these names; a patch's paths are in its headers
  // (core/src/tools/handlers/unified_exec/exec_command.rs, apply_patch.rs, tools/hook_names.rs).
  classes: { shell: ['Bash'], edit: ['apply_patch'] },
  unsupported_classes: {
    read: 'Codex has no file-read tool; reads go through the shell, so a read hook would never fire',
    fetch: 'Codex\'s web search is hosted, with no local call, so a fetch hook would never fire',
  },
  patch_tools: ['apply_patch'],
  patch_headers: ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: '],
  mcp_prefix: 'mcp__',
  exact: /^[A-Za-z0-9_]+$/,
  may_allow: 'Codex takes allow on PreToolUse only with updatedInput, which rewrites the call\'s input; a bare allow is a failed hook [CX §11]',
});

export default CODEX_HOOKS;
