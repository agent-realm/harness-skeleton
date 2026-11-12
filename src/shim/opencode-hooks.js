// OpenCode's hook table: what hs's hook shim needs to read the payload the hooks bridge hands it, and
// what the driver needs to match tools. It lives beside the shim's core, so src/shim/ is
// self-contained, and nothing in it imports from outside it. The driver's descriptor imports it as
// launch.hooks.
//
// OpenCode 2.x has no command hooks: its hooks are plugin functions [D2:plugins]. hs's bridge
// (./opencode-bridge.js) is a plugin that runs this shim for each spec hook, with the event of
// ctx.tool.hook("execute.before" | "execute.after") as the native payload, `directory` added (the
// event names no working directory; ctx.location.directory does [tier 1, opencode-bridge]). The event
// carries `tool` (the tool's effective name), `sessionID`, `agent`, `messageID`, `id` (the call) and
// `input` [G2:packages/plugin/src/promise/tool.ts, packages/core/src/tool.ts beforeExecute].
// Only execute.before can refuse: a throw there rejects the call before it runs, and its message
// reaches the model [G2:packages/core/src/plugin/hooks.ts; tier 1]. So PreToolUse is the one gating
// and blocking event, and PostToolUse (execute.after) never blocks, as on Claude Code. No hook takes
// context, so the shim delivers none.
export const OPENCODE_HOOKS = Object.freeze({
  events: ['PreToolUse', 'PostToolUse'],
  tool_events: ['PreToolUse', 'PostToolUse'],
  gating_events: ['PreToolUse'],
  blocking_events: ['PreToolUse'],
  context_events: [],
  // The bridge reads only the shim's exit code and stderr, never its stdout as JSON.
  json_looking: false,
  permission_request_deny: null,
  default_limit: 60,
  // The bridge stops the shim itself this long after the hook's limit, and blocks.
  timeout_margin: 5,
  fields: { session_id: 'sessionID', tool_name: 'tool', tool_input: 'input', cwd: 'directory' },
  // Built-in tool names and inputs in 2.2.7: shell {command, workdir}; edit {path, oldString,
  // newString}; write {path, content}; patch {patchText}; read {path}; webfetch {url}; websearch
  // {query} [G2:packages/core/src/tool/plugin/*.ts].
  classes: { shell: ['shell'], edit: ['edit', 'write', 'patch'], read: ['read'], fetch: ['webfetch', 'websearch'] },
  unsupported_classes: {},
  // The patch tool's paths are in its headers, as Codex's apply_patch [G2:packages/util/src/patch.ts].
  patch_tools: ['patch'],
  patch_field: 'patchText',
  patch_headers: ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: '],
  // An MCP tool is <server>_<tool>, each part with every character outside [A-Za-z0-9_-] made _
  // [G2:packages/core/src/tool/runtime.ts effectiveName; tier 1]: no form a server name cannot take.
  mcp_prefix: null,
  // The bridge matches a tool name with a regex, always anchored.
  exact: /(?!)/,
});

export default OPENCODE_HOOKS;
