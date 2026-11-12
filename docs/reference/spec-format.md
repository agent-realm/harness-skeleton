# The spec format (0.2)

The normative text is the design note's [§5](../design/skeleton-v0.2-2026-10-22.md). This page
is the summary.

## Layers

```
<layer>/
  spec.toml                every item that is not a file; starts with [spec]
  AGENTS.md                instructions
  skills/<name>/SKILL.md   skills, with their files
  agents/<name>.md         subagents
  commands/<name>.md       prompt templates
  hooks/, bin/, …          the processes items run
local.toml                 the install-local layer, always last
```

```toml
[spec]
name    = "team"      # unique in the stack
version = "1.4.0"     # the content's version
format  = "0.2"
```

## Items in `spec.toml`

| Kind | Form | Merge |
|---|---|---|
| model roles | `[model.roles] primary, small, subagent, effort` | last layer wins |
| model metadata | `[model.catalog."<model>"] context, output` | last layer wins |
| secrets, declared | `[refs.<NAME>] description` | by name |
| MCP server, local | `[mcp.<id>] exec, args, cwd, env, env_refs, exposure` | by id, whole item |
| MCP server, remote | `[mcp.<id>] url, type ("http"/"sse"), headers, header_refs, bearer_ref` | by id, whole item |
| hook | `[hook.<id>] event, match, run, timeout, require, may_allow` | by id, whole item |
| status line | `[statusline] run, refresh, require` | last layer wins |
| plugin | `[plugin."<name>"] source, format` | by name, whole item |
| environment | `[env] NAME = "value"` | by name |
| permissions | `[[permissions.rule]]` entries | appended |
| removal | `[remove] items = ["mcp.legacy", "skill.old"]` | deletes from lower layers |

A **process** (`exec`, or `run = { … }` for hooks and the status line) is
`{ exec, args, cwd, env, env_refs }` or `{ shell }`, with paths relative to its layer;
`self_contained = true` lets a plan persist it by copy.

## Files

- **`AGENTS.md`:** plain markdown, concatenated in layer order. No `@path` imports and no block
  HTML comments, since some harnesses expand or strip them.
- **Skills:** the Agent Skills format; `name` equals the directory. Names starting with `.`, and
  names a harness keeps for itself, are refused.
- **Agents:** `agents/<name>.md` with frontmatter `name`, `description`, `model`, `tools`.
- **Commands:** `commands/<name>.md` with frontmatter `description`, `argument-hint`; the body
  takes `$ARGUMENTS` and `$1`..`$9`.

## Plugins

A plugin item names a package in the [Agent Plugins 1.0.0](https://agent-plugins.org/specification)
format: a directory with a `plugin.json`, and optionally `skills/` and `mcp.json`.

```toml
[plugin."notes-kit"]                    # the package's name, from its plugin.json
source = "plugins/notes-kit"            # a directory in this layer, relative to it
format = "agent-plugins"
```

- **The id is the package's name.** A different id is refused as `plugin_name_mismatch`.
- **Quote a dotted name.** The format allows dots, and TOML reads an unquoted dot as a step:
  `[plugin.notes.kit]` is the item `plugin.notes` holding a table `kit`, and it fails validation.
  Write `[plugin."notes.kit"]`.
- **`source`** is a directory inside the layer, reached without a symlink. The spec digest binds
  its content, so any edit to the package needs a new receipt.
- **validate** checks the package as the format defines it, and refuses what the target harness
  cannot keep: a `$schema` version it does not map, a skill the Agent Skills specification
  rejects, and on Claude Code, `${…}` text the format keeps literal or a stdio server's `cwd`
  other than the plugin root. On Codex it refuses a package holding `.codex-plugin/`, which Codex
  acts on, and a plan names `extensions["com.openai"]` as harness-specific. The codes are in
  [the errors reference](errors.md).
- **A tombstone** `[remove] items = ["plugin.notes"]` removes that plugin only, never
  `plugin."notes.kit"`; `items = ["plugin"]` removes every plugin.
- **Delivered** on Claude Code, translated to its own plugin layout: at launch, one
  `--plugin-dir` per package, under a launch receipt; under `materialize`, a directory marketplace
  in `hs-run/` and two `settings.json` keys, so a bare start loads it. On Codex, under `materialize`: a plan
  installs the package in Codex's plugin cache, and each launch through `launch-spec` enables it.
  `config.toml` is never written, so a bare `codex` start does not load it. Elsewhere (`overlay` on
  Codex, `claude-plugin` on Codex) a plugin item is refused, by name. On Codex, `claude-plugin` is
  refused with the reason: from a package in Codex's cache only the skills load (its stdio servers do
  not start, its commands are not migrated, its hooks wait for trust); use the Agent Plugins format.

### Claude Code's own format

On Claude Code a plugin item may also name a package in Claude Code's own plugin layout
([the manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)):

```toml
[plugin."deploy-kit"]                   # the name in .claude-plugin/plugin.json, if it has one
source = "plugins/deploy-kit"
format = "claude-plugin"
```

- **Delivered whole**, the package being the plugin: at launch, one `--plugin-dir`; under
  `materialize`, the plugin of the same directory marketplace in `hs-run/`. What it holds runs as
  Claude Code runs a plugin: its hooks do not go through hs's hook shim, and `bin/` joins the Bash
  tool's `PATH`. So the package is always `runs-code`, bound by its digest.
- **The manifest is optional.** Without one, the plugin takes the item's name. With one, its `name`
  must be the item's. A manifest may set `defaultEnabled: false`: a launch turns the plugin on for
  its session, and so it does for any plugin it carries whose name the folder's `settings.json`
  turns off (`"<name>@inline": false`).
- **validate refuses** the manifest fields that would bring in what the spec neither names nor binds,
  as `plugin_field_unsupported`: `dependencies` (other plugins Claude Code would enable), `userConfig`
  (values Claude Code asks the user for, credentials among them) and `channels`, while they hold
  anything, and an `mcpServers` entry naming an MCP bundle (`.mcpb`, `.dxt`, or a URL). An MCP
  server that needs a secret is an `mcp` item with references.
- `claude plugin validate` remains Claude Code's own check of the rest of the package.

## `local.toml`

```toml
[refs]                                   # each declared secret, bound to a reference
DOCS_TOKEN = "env:DOCS_TOKEN"            # env:, keychain:, op://, age:, file:/

[endpoints.anthropic-messages]           # one per wire: anthropic-messages, openai-chat, openai-responses
base_url   = "https://gateway.example/anthropic"
credential = "env:GATEWAY_KEY"
auth       = "bearer"                    # or "x-api-key"

[login]
mode = "endpoint"                        # or "isolated": the harness's own login store

[state]
retention_days = 9999                    # how long the harness keeps transcripts
```

`[state]` items belong in `local.toml` only: they are this machine's choice, not a team's.
Values are never secrets, and a binding that is not a reference is refused.

## What this build carries

On Claude Code:
- **at launch:** model roles, endpoints and the login mode, retention, MCP servers, hooks, the
  status line, skills, and plugin packages (Agent Plugins and `claude-plugin`);
- **under `materialize`:** model roles, retention, MCP servers, hooks, the status line,
  skills, and plugin packages (Agent Plugins and `claude-plugin`). Endpoints and the login mode stay launch-only: a credential exists only at launch, so
  a bare start never reaches the endpoint.

On Codex:
- **at launch:** model roles, endpoints, MCP servers and hooks, and the Agent Plugins packages a
  plan installed;
- **under `materialize`:** skills and Agent Plugins packages.

On OpenCode (2.x, launch only):
- **at launch:** the primary model, the endpoint and the login mode, MCP servers, skills and
  `AGENTS.md`, every launch with `--standalone`;
- **under `materialize`:** the primary model (with no endpoint), MCP servers without refs, and skills,
  into the folder's `config/opencode/`; refused while an `opencode.jsonc` there outranks
  `opencode.json`.

The other kinds (`AGENTS.md`, permissions, agents, commands, `env`, `runtime`) validate, and a
plan or a launch refuses them as `not_implemented`, by name, rather than leave them out silently.
A plugin item outside the routes above is refused by name too: as `not_implemented` where this
build does not carry it (a format no route maps), and as `item_unsupported` where the harness
cannot (`claude-plugin` on Codex; on Codex under `overlay`, or at launch before a plan installed
it; on Claude Code, at launch while the folder holds the plugin at other content).

## Risks

Each item a plan or a launch carries may be tagged:

| Risk | Meaning |
|---|---|
| `runs-code` | a process, a skill, a hook |
| `fetches-code` | a launcher such as `npx` that downloads code when it starts |
| `sends-data` | a remote MCP server or an endpoint: data goes to a destination |
| `grants-permission` | a hook that may allow tool calls without a prompt |
| `trust` | an item that passes a harness's trust gate |
| `clears-state` | a one-way clear of cached state |

A risky item needs the user's receipt.
