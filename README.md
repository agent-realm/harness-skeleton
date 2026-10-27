# harness-skeleton

A standard for what an agent harness provides and where it keeps it, with a reference adapter,
`hs`, that maps it onto Claude Code and Codex.

**Define once. Translate per harness. Preserve native state. Refuse what doesn't fit.**

![Your tool hands hs a spec, the user approves with a receipt, and hs delivers configuration to the harness at launch or into its config files. In the other direction hs reads the folder's state and sessions, and never writes them. Claude Code and Codex have drivers; OpenCode and pi are designed.](docs/diagrams/overview.svg)

**Status: v0, building.** `hs` configures Claude Code and Codex, and reads sessions from twelve
harnesses. [What is built today](#what-is-built-today) has the detail, and the design is
[`docs/design/skeleton-v0.2-2026-10-22.md`](docs/design/skeleton-v0.2-2026-10-22.md).

## What it is

Every harness (Claude Code, Codex, OpenCode, pi) keeps the same kinds of things in its **data
folder**: instructions, settings, model and endpoint, login, MCP servers, skills, plugins, hooks,
permissions, status line, agents and sessions. Each keeps them in its own place, in its own
format.

harness-skeleton describes them once, harness-neutral, as a **spec**: a stack of layers, from
an organisation's down to one machine's `local.toml`. Each harness gets:
- an **adapter**, which maps the spec to and from the harness's native layout;
- a **conformance suite**, which proves the adapter against the real harness.

Two directions, kept apart:
- **Configuration goes in**, at launch or into the folder's config files, and only after the
  user approves the exact plan.
- **State comes out**: sessions, history, the state inventory, drift. The harness writes its
  state; `hs` only reads it.

[How it works](docs/concepts/how-it-works.md) shows each part in a diagram.

## Why

A tool that manages harness environments (a builder of isolated configs, a status line host, a
fleet launcher) is today written against one harness and rewritten for the next. Harness vendors
will not adopt a common layout, so the common layout has to be a translation. Tools are written
against the skeleton once, and work on every harness with an adapter. Where a harness lacks a
capability, the tool gets a clear refusal, never an approximation.

## How

```sh
npm ci --ignore-scripts
node bin/hs.js describe --harness claude-code --pretty
node bin/hs.js observe  --harness claude-code --folder ~/.claude --state --pretty     # reads only
node bin/hs.js validate --harness claude-code --layer ./team --local ./local.toml --pretty
sh examples/05-materialize/run.sh                                                    # in a scratch folder
```

Every write is planned first, and approved by the **user**, the person the harness runs for.
That approval is a receipt bound to the plan's digest. Secrets are references
(`env:NAME`, `keychain:…`), never values, and `hs` never resolves one.

## What is built today

| | Claude Code | Codex | OpenCode, pi |
|---|---|---|---|
| Read the folder: `describe`, `observe --state` | yes | yes | designed |
| Drift: `observe` | yes | not yet | designed |
| At launch: `launch-spec` (`overlay`) | model roles, endpoint, login, MCP servers, hooks, status line, skills | model roles, endpoint, login, MCP servers, hooks | designed |
| Into a folder the tool owns: `apply` (`materialize`) | model roles, MCP servers, hooks, status line, skills, retention | skills | designed |
| Sessions: `sessions.*` | yes | yes | OpenCode yes, pi no |

Instructions (`AGENTS.md`), agents, commands, permissions and plugins are designed and not
delivered yet, and so is the `reconcile` mode for the user's own folder. Eleven conformance
checks pass on real harnesses; no version range is certified yet.

## What it is not

- **Not a harness or an agent loop.** It configures harnesses and reads what they keep. The one
  loop planned in this repository is a [reference harness](docs/design/reference-harness-2026-10-23.md)
  for conformance fixtures, not a product.
- **Not an orchestrator.** `launch-spec` returns the arguments and environment, and the caller
  starts the harness.
- **Not a database layout.** Captured sessions go into tables through
  [sessions-sql](https://github.com/agent-realm/sessions-sql).

## Where next

- [`docs/tutorials/first-steps.md`](docs/tutorials/first-steps.md): fifteen minutes, from install
  to a delivered and removed spec.
- [`docs/concepts/how-it-works.md`](docs/concepts/how-it-works.md): the parts and how they fit, in
  five diagrams.
- [`examples/`](examples/): from `describe` to a full spec, each runnable.
- [`docs/`](docs/README.md): the guides, the reference and the design notes.
- [`AGENTS.md`](AGENTS.md): conventions for contributors, and how to install and deploy.
- [`packages/`](packages/):
  - `session-adapters`: session readers for twelve harnesses;
  - `skeleton-spec`: the spec as code;
  - `scripted-model`: a model endpoint that answers from a script, for tests.

## License

Apache License 2.0: see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
