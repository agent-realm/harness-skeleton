# How it works

This page shows the parts and how they fit, in five diagrams, then what is built today. The
[design note](../design/skeleton-v0.2-2026-10-22.md) says why each part is the way it is, and the
[guides](../README.md#guides) do one task each.

## Two directions

![Your tool hands hs a spec, the user approves with a receipt, and hs delivers configuration to the harness at launch or into its config files. In the other direction hs reads the folder's state and sessions, and never writes them.](../diagrams/overview.svg)

Everything `hs` does moves one of two ways:

- **Configuration goes in.** Your tool writes a spec. `hs` validates it, plans the change, and
  delivers it: at launch, as arguments, environment and files in a temp dir, or into the data
  folder's config files. A write happens only under a receipt the user gave for that exact plan
  or launch.
- **State comes out.** The harness writes its sessions, history, credentials and caches. `hs`
  reads them (`observe --state`, `sessions.*`) and never writes them. A plan step that would touch
  such a path is refused as `state_write_refused`.

The spec is the truth for what it manages, and the data folder is the truth for everything else.
A key the spec does not manage is never touched, and a key it does manage that changed in the
folder is reported as drift.

## The spec

A spec is a list of layers, lowest first: an organisation's, a team's, any others, and always
`local.toml` last. Each layer is a directory with a `spec.toml` and the files beside it (skills,
agents, commands, hook scripts).

- **`local.toml` belongs to one machine.** Endpoints, the bindings of secret references, the login
  and the `[state]` items live only there, and are never adopted from a layer written elsewhere.
- **Every item keeps its provenance**, the layer that set it, and the resolved spec has one digest.
  Plans and receipts bind to that digest, so a changed layer needs a new approval.
- **Secrets are references** (`env:NAME`, `keychain:…`), never values. `hs` never resolves one:
  `launch-spec` names the variable each reference goes into, and the caller resolves it at start.

Guides: [write a spec](../guides/write-a-spec.md). Reference: [spec format](../reference/spec-format.md).

## Delivery modes

![overlay carries the spec at launch and writes nothing into the folder; materialize regenerates the managed files of a folder the tool owns; reconcile, designed and not built yet, merges managed keys into the user's own folder. No mode writes state.](../diagrams/delivery-modes.svg)

A mode decides who owns the folder and what is written into it.

- **`overlay`** is preferred, because it writes nothing into the folder. It works on any folder,
  the user's own included. An item the harness cannot take at launch falls back to `materialize`
  when the tool owns the folder, and is refused otherwise; the plan says which.
- **`materialize`** is for a folder a tool creates and owns. Managed files are regenerated before
  each launch, so drift lasts until the next launch, and is reported.
- **`reconcile`** is for the user's own folder: a three-way merge of the spec, what is in the
  folder, and what was last delivered. It is designed, not built.

Guides: [launch with an overlay](../guides/launch-with-an-overlay.md),
[deliver to a folder](../guides/deliver-to-a-folder.md).

## Plans and receipts

![Spec layers are validated and planned without writing anything. The user approves the plan with a receipt bound to its digest, and apply writes under a lock with a journal. Refusals come with a code.](../diagrams/plan-and-receipt.svg)

- **A plan is data.** It lists its operations with their risk tags (`runs-code`, `sends-data`), what
  it skips and why, and what would keep less history than the harness keeps now. A caller cannot
  put a native command into it. Its digest covers all of it.
- **The receipt is the user's.** It names the digest it approves. `apply` refuses a plan that no
  longer matches the folder (`plan_stale`), a plan whose content does not match its digest
  (`plan_tampered`), and a folder another writer holds (`folder_busy`).
- **A launch has its own receipt.** A launch that runs code (a hook, an MCP server, a skill, the
  status line) or sends data (a remote MCP server) needs the user's receipt for that launch's
  digest, or `launch-spec` answers `receipt_required`.
- **Interrupted writes finish.** `apply` journals each step. After a crash, `recover` finishes the
  apply, and every other apply refuses until it has.

Reference: [errors](../reference/errors.md), every code and what to do about it.

## Sessions

![hs lists, reads and derives sessions through the session adapters package, which reads twelve harnesses' stores without writing them. derive is pure. The consumer keeps cursors and revisions, and passes the position back on the next read.](../diagrams/sessions.svg)

Two contracts define sessions, both kept in the
[sessions-model](https://github.com/agent-realm/sessions-model) repository: the **sessions-model**
contract for the records and their keys, and the **sessions** contract for the four operations.
`hs` answers the operations through
[`@agent-realm/harness-session-adapters`](../../packages/harness-session-adapters/), and reads no harness store
itself.

- **`sessions.read` never writes.** It takes no lock, opens SQLite stores read-only, and may run
  while the harness writes. It returns raw units from a position, with a `continuity`:
  `appended`, `delta`, `reset`, `snapshot` or `unchanged`.
- **`sessions.derive` is pure.** Units and the last state in, changed records out. Replaying from
  empty gives the same records as any incremental path.
- **The consumer keeps the state of reading**: cursors, generations, each record's `rev`, and
  its archive of raw units. A database for those records is mapped by
  [harness-sessions-sql](https://github.com/agent-realm/harness-sessions-sql).

The package reads twelve harnesses: Claude Code, Codex, Copilot CLI, Gemini CLI, VS Code, Goose,
OpenCode, Antigravity, Cursor IDE, cursor-agent, Zed and Devin Local. `hs` answers `sessions.*`
for any of them, with or without a driver.

Guide: [read sessions](../guides/read-sessions.md).

## Conformance

![Tier 0 unit tests run on every pull request with a stub harness. Tier 1 starts a real harness on a disposable bench, with a scripted model, and writes a report per check. A planned reference harness will produce every session feature on purpose. No version is certified yet.](../diagrams/conformance.svg)

A claim about a harness is proven by a run, or labelled untested.

- **Tier 0** is `npm test`: every pull request, Node 22 and 24, with a stub script in place of the
  harness binary. It never starts a harness and never reads a real data folder.
- **Tier 1** starts a real harness on a disposable bench only (`HS_BENCH=1`), in a scratch `HOME`.
  A check that needs a model gets
  [`@agent-realm/scripted-model`](../../packages/scripted-model/), on loopback. Each check writes a
  JSON report into [`conformance/results/`](../../conformance/results/).
- **Tiers 2 and 3**, a scripted conversation and a real model, are in the design (§10). The
  acceptance scenario, next in the build plan, runs a real model through a gateway.
- **Certification** of a version range needs the whole profile's checks and the acceptance
  scenario. None is certified yet, so `describe` reports versions as compatible, not certified.
- **The reference harness** is planned: a small agent loop whose own store is sessions-model
  records, so that every record type and link kind has a producer for the fixtures
  ([design](../design/reference-harness-2026-10-23.md)). It is a test subject, not a product.

Guide: [run a conformance check](../guides/run-a-conformance-check.md).

## What is built today

| | Claude Code | Codex | OpenCode, pi |
|---|---|---|---|
| Read the folder: `describe`, `observe --state` | yes | yes | designed |
| Drift: `observe` | yes | not yet | designed |
| At launch: `launch-spec` (`overlay`) | model roles, endpoint, login, MCP servers, hooks, status line, skills | model roles, endpoint, login, MCP servers, hooks | designed |
| Into a folder the tool owns: `apply` (`materialize`) | model roles, MCP servers, hooks, status line, skills, retention | skills | designed |
| Sessions: `sessions.*` | yes | yes | OpenCode yes, pi no |

- A Codex skill is refused at launch, because Codex has no skill root a launch can add. Deliver it
  into the folder instead. Codex has no custom status line.
- Instructions (`AGENTS.md`), agents, commands, permissions and plugins are designed and not
  delivered yet. `reconcile` is designed for every harness.
- The [build plan](../design/build-v0-2026-10-22.md) lists every milestone with its status.

## What it is not

- **Not a harness.** It runs no agent loop for users. It configures harnesses and reads what they
  keep. The one loop planned here is the reference harness, which exists to be tested against.
- **Not an orchestrator.** It does not run sessions: `launch-spec` returns the arguments and
  environment, and the caller starts the harness.
- **Not a translation that guesses.** A capability a harness lacks is refused with a reason, or
  marked `lossy` with what is dropped. It is never approximated.
- **Not a database layout.** Captured sessions go into tables through harness-sessions-sql.
