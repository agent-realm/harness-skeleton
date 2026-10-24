# harness-skeleton

A standard for what an agent harness provides and where it keeps it, with a reference adapter,
`hs`, that maps it onto Claude Code and Codex.

**Status: v0, building.**
- On Claude Code, `hs` reads data folders, validates specs, launches with a spec carried at
  launch, delivers into folders a tool owns, and reads sessions.
- On Codex it does the same, except that a skill reaches Codex only by delivery into the folder.
- The design is [`docs/design/skeleton-v0.2-2026-10-22.md`](docs/design/skeleton-v0.2-2026-10-22.md).

## What it is

Every harness (Claude Code, Codex, OpenCode, pi) keeps the same kinds of things in its **data
folder**: instructions, settings, model and endpoint, login, MCP servers, skills, plugins, hooks,
permissions, status line, agents and sessions. Each keeps them in its own place, in its own
format.

harness-skeleton describes them once, harness-neutral, as a **spec**: a stack of layers, from
an organisation's down to one machine's `local.toml`. Each harness gets:
- an **adapter**, which maps the spec to and from the harness's native layout;
- a **conformance suite**, which proves the adapter against the real harness.

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

## Where next

- [`docs/tutorials/first-steps.md`](docs/tutorials/first-steps.md): fifteen minutes, from install
  to a delivered and removed spec.
- [`examples/`](examples/): from `describe` to a full spec, each runnable.
- [`docs/`](docs/README.md): the guides, the reference and the design notes.
- [`AGENTS.md`](AGENTS.md): conventions for contributors, and how to install and deploy.
- [`packages/`](packages/):
  - `session-adapters`: session readers for twelve harnesses;
  - `skeleton-spec`: the spec as code;
  - `scripted-model`: a model endpoint that answers from a script, for tests.

## License

Apache License 2.0: see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
