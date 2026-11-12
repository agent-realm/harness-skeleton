# pi

What `hs` does with pi, and how to use it: the data folder, a launch, a folder a tool owns, hooks,
plugins, strict isolation, the session's directory and the known limits. The design note's section
7.5 has the full mapping with its sources; the runnable examples are
[11](../../examples/11-pi-launch/), [12](../../examples/12-pi-folder/) and
[13](../../examples/13-pi-plugin/).

**Versions:** the 1.5 line, from 1.5.2 up to 1.6, widened one minor at a time with a tier 1 run.
The 0.x line is out of range. `hs detect --harness pi` says which version a binary is.

## The data folder

A pi data folder is its one agent dir, `PI_CODING_AGENT_DIR`: settings, logins, MCP servers,
instructions, resources and sessions. A launch sets it, and unsets `PI_CODING_AGENT_SESSION_DIR`,
`PI_PACKAGE_DIR` and `PI_SELF_UPDATE_COMMAND`.

```sh
node bin/hs.js describe --harness pi --pretty
node bin/hs.js observe --harness pi --folder ./pi-data --state --cwd ./project --pretty
```

With `--cwd`, `observe --state` also says whether a trusted project `.pi/` is in that directory, and
whether the project's `.pi/settings.json` sets `sessionDir`. It never shows a path.

## At launch

```sh
node bin/hs.js launch-spec --harness pi --folder ./pi-data --layer ./team --local ./local.toml \
  --cwd ./project --headless --pretty
```

A launch writes nothing into the folder. It carries:

- **One extension** hs generates in the launch's temp dir, passed with `-e`. It registers:
  - the endpoint's provider, `hs`, its key read from a variable the caller fills from the reference;
  - the MCP servers, `exposure` direct unless the spec gives another;
  - the hooks.
- **Skills** with `--skill`, and **`AGENTS.md`** with `--append-system-prompt`, a system-prompt
  append. The folder's own context files still load.
- `--provider hs --model <model>` with an endpoint, and `--mode json` headless. With an endpoint,
  `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK` and `PI_TELEMETRY=0` keep pi's own network off.
- **The session's directory** when `launch-spec` is given `--cwd`, the directory pi will run in:
  `--session-dir`, pi's own place for that directory's sessions in the folder. The result names the
  `cwd` the argv is bound to. Run pi there.

pi runs a leading `!command` and expands `$NAME` in a provider's key and headers and in an MCP
server's env and headers. So spec text with `$` or a leading `!` is refused in every field that
reaches them, and so is a leading `~` in a server's command, arguments or working directory. Also
refused:
- a server named like one the folder's `mcp.json` defines;
- an SSE server;
- permissions (pi has none) and a required status line;
- an endpoint launch while the folder holds a login.

## Into a folder a tool owns

A plan writes into the agent dir, which a bare `pi` start reads:
- `mcp.json`'s `mcpServers.<id>`, key by key, a stdio server bound by copy into `hs-run/`;
- each skill as a tree under `skills/`;
- for a model given as `provider/model` with no endpoint, `settings.json`'s `defaultProvider` and
  `defaultModel`, with the user's own keys kept.

The endpoint, the login, `AGENTS.md` and hooks stay launch only. A plan refuses a server with refs or
a working directory, a model with no provider, and the same text a launch refuses. A launch skips
what a plan installed at this content.

## Hooks

The launch extension runs hs's hook shim on the pi event each spec event rides on:
- `PreToolUse` on `tool_call`, `UserPromptSubmit` on `input` and `Stop` on `agent_before_settle`.
  These three can block, and they fail closed on every shim failure. A `Stop` hook that blocks asks
  pi for one more run, with `stop_hook_active` set; there is no cap, so a Stop hook should let the
  session end when `stop_hook_active` is true.
- `PostToolUse` on `tool_result`, `SessionStart` on `session_start` and `SessionEnd` on
  `session_shutdown`. These notify only.
- The other events are refused by name, or skipped when `require = "if-supported"`. A match on the
  `fetch` tool class is always refused.

The extension writes a readiness file once its hooks are registered, and `launch-spec` names it under
`readiness`. A caller that needs its guards waits for that file.

## Plugins

An [Agent Plugins](https://agent-plugins.org/specification) package is translated into a pi
package. The package's manifest declares only the package's skills and one extension hs generates to
register its MCP servers, and the package itself is copied whole under `package/`. Nothing else in it
loads.
- **At launch**, the generated package is passed with `-e`.
- **Under `materialize`**, it is `hs-run/plugin.<name>/`, and a plan adds one member to
  `settings.json`'s `packages`, keeping every other member as it was.
- **Its servers** get `PLUGIN_ROOT` and `PLUGIN_DATA`. Under a plan the data lives in
  `hs-run/plugin-data/<name>/`. `remove` keeps it and says where, and `remove --purge-data` deletes
  it as well.

`validate` refuses a package whose text pi would change: `$` or a leading `!` in a server's env,
headers or url, or a leading `~` in its command, arguments or working directory. `claude-plugin`
packages are refused on pi: use the Agent Plugins format.

## Strict isolation

With `isolation = "strict"` at the top of a layer, only the instructions and skills the spec names
reach the agent. The launch passes `--no-skills`, `--no-context-files` and `--no-approve`. The spec's
own skills, its `AGENTS.md`, and what a plan of the spec installed still reach. The switches keep the
folder's own context files and skills out too.

The project's own `AGENTS.md` is not added back: name the project's instructions in the spec if the
agent should follow them. A strict launch is refused, naming each path, while the folder holds what
no switch keeps out:
- a `SYSTEM.md` or `APPEND_SYSTEM.md`;
- an entry in `extensions/`, or an `extensions` or `packages` list in `settings.json` (a member a
  plan of the spec installed is allowed);
- an `mcp.json` server that no plan of the spec installed.

## Known limits

`describe` lists them, each with what closes it:
- `~/.agents/skills`, read from `$HOME` (strict closes it);
- `AGENTS.md` and `CLAUDE.md` in the working directory and every parent (strict closes them);
- the project's `.pi/`, trust-gated: a launch leaves the decision to pi (strict closes it);
- a project's `.pi/settings.json` `sessionDir`, which pi reads before it resolves trust. `launch-spec
  --cwd` closes it.

## Sessions

The session adapters have no pi reader yet, so `sessions.*` does not answer for pi.
