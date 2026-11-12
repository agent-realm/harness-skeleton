// pi's hook table: what hs's hook shim needs to read the payload the launch extension hands it, and
// what the driver needs to match tools. It lives beside the shim's core, so src/shim/ is
// self-contained, and nothing in it imports from outside it. The driver's descriptor imports it as
// launch.hooks.
//
// pi has no command hooks: its hooks are extension handlers [P15:extensions]. hs's launch extension
// runs this shim for each spec hook, with the pi event as the native payload and what the event
// lacks added: `session_id` (ctx.sessionManager.getSessionId()), `cwd` (ctx.cwd), and on input the
// prompt, on session_start the spec's source. tool_call and tool_result carry `toolName`,
// `toolCallId` and `input` [P15:extensions]. Two events can refuse: tool_call, by returning
// {block, reason} (a handler that throws blocks too), and input, by returning {action: "handled"},
// which skips the agent; agent_before_settle can ask for one continuation, which is what a Stop
// hook's block means. No handler takes context, so the shim delivers none.
export const PI_HOOKS = Object.freeze({
  events: ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop'],
  tool_events: ['PreToolUse', 'PostToolUse'],
  gating_events: ['PreToolUse', 'UserPromptSubmit'],
  blocking_events: ['PreToolUse', 'UserPromptSubmit', 'Stop'],
  context_events: [],
  // The extension reads only the shim's exit code and stderr, never its stdout as JSON.
  json_looking: false,
  permission_request_deny: null,
  default_limit: 60,
  // The extension stops the shim itself this long after the hook's limit, and blocks.
  timeout_margin: 5,
  fields: { tool_name: 'toolName', tool_input: 'input' },
  // pi's built-in tools: read, bash, edit, write, grep, find, ls [P15:cli]. It has no web tool.
  classes: { shell: ['bash'], edit: ['edit', 'write'], read: ['read'] },
  unsupported_classes: {
    fetch: 'pi has no built-in fetch tool, so a fetch hook would never fire [P15:cli]',
  },
  // An MCP tool is mcp__<server>__<tool> [P15:mcp; tier 1].
  mcp_prefix: 'mcp__',
  // The extension matches with a regex, always anchored.
  exact: /(?!)/,
});

export default PI_HOOKS;
