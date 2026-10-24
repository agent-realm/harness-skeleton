# The `hs` command and the `hs/0.2` protocol

## Two ways to call

```sh
hs < request.json                     # one hs/0.2 envelope on stdin, one response on stdout
hs <op> --harness <h> [options]       # the same request, built from flags
```

(`hs` is `node bin/hs.js`.) Exit status: 0 for an ok response, 1 for an error response, 2 for a
usage error.

## Flags

| Flag | Becomes | Used by |
|---|---|---|
| `--harness <h>` | `args.harness` (`claude-code`, `codex`, or a harness with a session adapter) | all |
| `--folder <path>` | `args.harness_path`, made absolute | all but `describe` |
| `--bin <path>` | `args.bin`: the harness binary to run `--version` on | `detect`, `plan`, `apply`, `launch-spec` |
| `--state` | `args.state` | `observe` |
| `--cwd <dir>` | `args.cwd`: the working directory whose layers to read | `observe --state` |
| `--layer <dir>` (repeatable, lowest first) | `args.layers` | `validate`, `plan`, `launch-spec` |
| `--local <file>` | `args.local`: `local.toml` | `validate`, `plan`, `launch-spec` |
| `--owner <name>` | `args.owner` (`[a-z][a-z0-9-]*`) | `plan`, `remove` |
| `--mode <mode>` | `args.mode`: `materialize` (default) or `overlay` | `plan` |
| `--prune` | plan the removal of items the spec no longer has | `plan` |
| `--adopt` | record an unowned item under this owner | `plan` |
| `--strict-version` | refuse writes outside the certified range | `plan`, `apply` |
| `--no-persist-state` | leave `[state]` out of an overlay plan | `plan --mode overlay` |
| `--plan <file>` | `args.plan` (a plan, or the response `hs plan` printed) | `apply` |
| `--receipt <file>` | `args.receipt` | `apply`, `launch-spec` |
| `--item <id>` (repeatable) | `args.items`: remove only these | `remove` |
| `--headless` | the launch's headless result semantics | `launch-spec` |
| `--store <file>` | `args.store`: a database-file store | `sessions.*` |
| `--pretty` | indent the response | all |

## The envelope

```json
{"protocol": "hs/0.2", "request_id": "1", "op": "describe", "args": {"harness": "claude-code"}}
```

A response is `{"protocol", "request_id", "ok": true, "result"}`, or
`{"protocol", "request_id", "ok": false, "error": {"code", "message", "items", "retryable"}}`.
`retryable` is true when the same request may succeed if sent again unchanged. The protocol takes
absolute paths only; the flags make them absolute.

## Operations

| Op | Does | Writes |
|---|---|---|
| `describe` | protocol versions, operations, the harness descriptor (binding, path classes, version ranges), the session adapter's own description | nothing |
| `detect` | whether the harness is present, its version, its range | nothing |
| `validate` | the resolved spec against the standard and the harness: items and their layers, digests, problems | nothing |
| `observe` | with `--state`: the state inventory and the values in effect; without: drift in a delivered folder | nothing |
| `plan` | declarative operations with risks and preconditions, or `unchanged` | nothing |
| `apply` | a plan under a receipt, journaled | config paths and `.harness-skeleton/` |
| `recover` | finishes an interrupted apply from its journal | config paths and `.harness-skeleton/` |
| `remove` | one owner's items, where still as installed | config paths and `.harness-skeleton/` |
| `launch-spec` | argv, environment, overlay files and references for a launch | a temp directory, never the folder |
| `sessions.list` | the store's sessions, with keys and sources | nothing |
| `sessions.read` | raw units of one source from a position | nothing |
| `sessions.derive` | records from units; pure | nothing |

The design note's [§7](../design/skeleton-v0.2-2026-10-22.md) defines each operation fully.
