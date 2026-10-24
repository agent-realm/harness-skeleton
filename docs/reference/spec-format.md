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
  status line and skills;
- **under `materialize`:** model roles, retention, MCP servers, hooks, the status line and
  skills. Endpoints and the login mode stay launch-only: a credential exists only at launch, so
  a bare start never reaches the endpoint.

On Codex:
- **at launch:** model roles, endpoints, MCP servers and hooks;
- **under `materialize`:** skills.

The other kinds (`AGENTS.md`, permissions, agents, commands, plugins, `env`, `runtime`) validate,
and a plan or a launch refuses them as `not_implemented`, by name, rather than leave them out
silently.

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
