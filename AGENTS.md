# Working on harness-skeleton

Conventions for any coding agent (Claude Code, Codex, OpenCode, pi, Gemini, …) and any human
working on this repo, and how to install and deploy what it ships.

## What this repo is

- **harness-skeleton**: a standard for what an agent harness provides and where it keeps it:
  the data folder, instructions, settings, model and endpoint, login, MCP servers, skills,
  plugins, hooks, permissions, status line, agents, sessions.
- **Adapters**, one per harness, that map the skeleton to and from that harness's native
  layout. `hs` (`bin/hs.js`, `src/`) is the reference adapter, being built one milestone at a
  time; its first driver is Claude Code.
- **The session adapters**, `packages/session-adapters/` (`@agent-realm/session-adapters`): one
  reader per harness for the sessions contract v0 (`describe`, `list`, `read`, `derive`), with
  the one `host` and `harness_path` implementation. **Maintained with memhouse**: changes there
  go through the package's maintainer. The package imports nothing from `hs` or memhouse; `hs`
  imports it, through the npm workspace, and never reads a harness store itself.
- **The spec as code**, `packages/skeleton-spec/` (`@agent-realm/skeleton-spec`): spec layers and
  `local.toml` resolved and validated, with the safe file readers. `hs` and the reference harness
  both import it, and it imports nothing from either; hs's `src/spec/` and `src/files.js` re-export
  it.
- **The scripted model**, `packages/scripted-model/` (`@agent-realm/scripted-model`): a model
  endpoint that answers from a script, on loopback only, for deterministic harness tests. The
  conformance checks script a model through it.
- **A conformance suite** that proves an adapter against a real harness: eleven tier 1 checks so
  far, in `conformance/`.

**Status: v0, building.** The design note is
[`docs/design/skeleton-v0.2-2026-10-22.md`](docs/design/skeleton-v0.2-2026-10-22.md), and the build
plan with its milestones is [`docs/design/build-v0-2026-10-22.md`](docs/design/build-v0-2026-10-22.md).

## The dependency rule

```
tools ──depend on──▶ harness-skeleton ◀──implement── adapters ──map to──▶ harnesses
```

- The skeleton depends on nothing. It never names a tool built on it, and never grows a
  special case for one.
- An adapter is the only code that knows a harness's native layout. When a harness changes,
  one adapter breaks, not the tools.
- Harnesses are named freely: they are what adapters map to.

## Rules

1. **The spec comes first.** A change in behaviour changes the spec in the same PR. While the
   skeleton is `v0` the shape may change; from `v1`, changes within a major are additive only.
2. **Every fact about a harness carries a source**: a documentation URL with the date it was
   read, or a local path and the harness version it was observed on. A fact without one is
   not written down.
3. **Reuse before invention.** Instructions are `AGENTS.md`, tools are MCP, skills are the
   `SKILL.md` format. The skeleton adds only what nobody standardized.
4. **Secrets by reference only.** The skeleton and every adapter carry references
   (`keychain:…`, `op://…`, `env:…`), never values. Never read a harness's credential store
   to check it: an adapter may ask whether an item exists, by name, with every byte of output
   discarded, never read what it holds. Never print, log or commit a value.
5. **No silent degrade.** A capability a harness lacks is refused with a reason, never
   approximated.

## Git

- Work on a branch `<agent>/<description>` (or `<name>/<description>` for a human), in a
  worktree outside the checkout, never in a directory inside it.
- Never commit to `main`: changes reach it by pull request, with CI green.
- Delete merged branches with `git branch -d`, never `-D`.
- Review: each pull request gets one automated review, requested once in its body with a note on
  what to check, and never again in fix rounds. A fix round's second look comes from another
  reviewer.

## Testing

- `npm ci --ignore-scripts && npm test` runs the unit tests of `hs` and of every workspace
  package (Node.js 22+, `node:test`; one dependency, `smol-toml`, pinned in
  `package-lock.json`). They build fixture folders in a
  temp directory and stand in a stub script for a harness binary: they never start a real
  harness and never read a real data folder. Keep it that way.
- CI (`.github/workflows/test.yml`) runs `npm ci --ignore-scripts` and `npm test` on Node 22,
  on a GitHub-hosted `ubuntu-latest` runner, for every pull request and every push to `main`. It uses no secrets
  and no self-hosted runner. A milestone merges only with it green.
- Harness facts live in a driver's `descriptor.js`, each with its source, never in logic.
- Conformance runs start real harnesses. They run on disposable benches (a VM made for it, or a
  CI runner), never on a user's workstation and never against a user's real data folder. The
  scripts in `conformance/` refuse to run without `HS_BENCH=1`; see `conformance/README.md`.
- In a throwaway data folder, never log in interactively: route the model through an API
  gateway with a key passed by reference.

## Install and deploy

`hs` and the packages are not published to npm. Use them from a checkout:

```sh
git clone https://github.com/agent-realm/harness-skeleton
cd harness-skeleton
npm ci --ignore-scripts        # one dependency, smol-toml, pinned in package-lock.json
npm test                       # unit tests of hs and every package; starts no harness
node bin/hs.js describe --harness claude-code --pretty
```

- **The CLI:** `bin/hs.js`, or `npm link` for an `hs` on PATH. A tool calls it with one `hs/0.2`
  envelope on stdin, or with flags ([`docs/reference/cli-and-protocol.md`](docs/reference/cli-and-protocol.md)).
- **The packages:** `@agent-realm/session-adapters`, `@agent-realm/skeleton-spec` and
  `@agent-realm/scripted-model` are npm workspaces. Another project depends on them through a
  workspace or a `file:` path to this checkout.
- **Against a real harness:** point `--folder` at a data folder you own. `observe`, `validate`,
  `launch-spec` and the `sessions.*` operations never write it. `plan` writes nothing, and
  `apply` writes only under a receipt. Try writes on a scratch folder first, as the
  [examples](examples/) do.
- **Benches:** to run the conformance suite, see
  [`docs/guides/run-a-conformance-check.md`](docs/guides/run-a-conformance-check.md).

## Where to report

Open an issue on https://github.com/agent-realm/harness-skeleton. Security issues: see
[`SECURITY.md`](SECURITY.md).
