# Read a store

**Goal:** list the sessions in a harness store, read their raw units, derive the records, and
read them right.

Run everything here from `packages/session-adapters/`, on Node.js 22.15 or later. The package
has no dependencies, so there is nothing to install. The commands run the
[examples](../examples/README.md) against the package's synthetic fixtures, each copied into a
scratch directory first, so they never touch a real harness store.

## 1. Choose an adapter

There is one adapter per harness, by its harness id. `describe()` says what it reads, and opens
nothing:

```sh
node examples/01-describe/describe.js codex
```

It prints the versions, the sources (each with its `mode`: `stream`, `snapshot` or `delta`), the
redaction paths and the facets. [The adapter interface](adapter-interface.md) defines each field.

## 2. Name the store

Every operation takes the store, `{host, harness, harness_path}`:

```js
import { adapterFor, host, harnessPath } from '@agent-realm/session-adapters';

const adapter = adapterFor('claude-code');
const store = { host: host().host, harness: 'claude-code', harness_path: harnessPath('/home/user/.claude') };
```

- **`host()`** derives the host from the machine id, never from the host name. Where no machine
  id is readable, it keeps a random id in `~/.local/state/sessions-model/host-id` (or under
  `$XDG_STATE_HOME`; `%LOCALAPPDATA%` on Windows) and returns it as `r-<id>`.
- **`harnessPath()`** returns the real path: absolute, every symlink resolved, each component in
  its on-disk case. It names the data folder, or for OpenCode the database file
  (`describe().store_shape`).

The examples use a fixed `host` instead, so that their output is the same on every machine.

## 3. List the sessions

```sh
node examples/02-list-sessions/list.js
```

```
claude-code/basic: 1 session(s)

== session a08ff49b-6f77-4263-a271-6c43069c43a8  incarnation ""  live unknown
main     stream    byte_offset      projects/-work-proj-alpha/a08ff49b-6f77-4263-a271-6c43069c43a8.jsonl
agent    stream    byte_offset      projects/-work-proj-alpha/a08ff49b-6f77-4263-a271-6c43069c43a8/subagents/agent-a8f55846977144902.jsonl
```

`list(store)` gives each session's id and `incarnation`, which with the store make its key, an
`updated_hint` that changes whenever the session does, and its sources. Try a database store too:
`node examples/02-list-sessions/list.js goose features`.

## 4. Read and derive one session

```sh
node examples/03-read-and-derive/read-and-derive.js
```

The script reads every source of the first session from the start, then derives once:

```js
const session = { ...store, session_id: s.session_id, incarnation: s.incarnation };
const input = s.sources.map((src) => {
  const r = adapter.read(store, session, src.source_key, null, null); // no position, nothing known
  return { source_key: src.source_key, generation: 1, complete: true, units: r.units, gone: [] };
});
const { changed, live, held, state } = adapter.derive(session, input, null);
```

```
== derive: adapter_ver 0.2.1, sessions-model/1, state_ver 2, checkpoint true
changed  session 1, message 25, usage 9, link 0, lifecycle 1
live     session 1, message 25, usage 9, link 0, lifecycle 1
held     session 0, message 0, usage 0, link 0, lifecycle 0
```

- **`read`** returns raw units: one per line of a stream, one per snapshot, one per changed row of
  a delta source. Values on the redaction paths are already replaced. A partial last line is
  `held_back`. One read returns at most 64 MiB and says `more: true`; read on from the position it
  returned.
- **`derive`** is pure. On a first derive (`state` null, every source `complete: true`), `changed`
  holds every record: the session, its messages and their parts, usage, links and lifecycle
  events. `live` lists every live key, and `held` the keys withheld as incomplete, which you
  neither write nor delete. Both always carry all five record types, each a sorted list, empty
  where there is nothing.
- **`validateSession(changed, {harness, sessionId})`**, from `@agent-realm/session-adapters/validate`,
  checks the records against the contract's shapes before you write them.

## 5. Read the records right

Four fields are easy to misread. The same script prints each.

**Tool results.** `status` says whether the call completed: `completed`, `cancelled` or `denied`.
`is_error` is the harness store's own flag for a call that completed, copied, never worked out
from the exit code or the output's text. It is null where the store keeps no flag, where the flag
says success beside a shell's non-zero `exit_code`, and wherever `status` is `cancelled` or
`denied` (sessions-model v1.3, §2.3). To know whether a shell failed, read
`exit_code`.

```sh
node examples/03-read-and-derive/read-and-derive.js copilot-cli features
```

```
== tool results: status, is_error, exit_code, of 8
completed  false  0     chatcmpl-tool-feat-ls
completed  false  null  chatcmpl-tool-feat-view
completed  false  null  chatcmpl-tool-feat-task
completed  null   1     chatcmpl-tool-feat-test
completed  false  null  chatcmpl-tool-feat-mcp
denied     null   null  chatcmpl-tool-feat-pip
completed  true   null  chatcmpl-tool-feat-ask
completed  false  0     chatcmpl-tool-feat-a
```

**The session's `kind`** is the harness's own session type, and null where the store writes none
(sessions-model v1.3, §2.1). A sub-agent session is told by its `subagent` link, not
by its kind.

**Usage.** Each usage record has a `granularity` (`per_response`, `per_message`, `per_turn` or
`per_session`) and an `anchor` naming what it counts for. The usage records of one session never
overlap, so a session's total is their sum. `input_includes_cache` and
`output_includes_reasoning` say what `input` and `output` count, and are null where nothing settles
it.

```sh
node examples/03-read-and-derive/read-and-derive.js zed lab
```

```
== the session record
title "Reading package.json bin name", client zed, harness_version null, cwd /home/user/work/inventory-cli, kind null

== usage: granularity and anchor, of 1
per_session session        1 record(s), input 25684, output 98; input_includes_cache null, output_includes_reasoning null

== links, of 1
subagent   stated on the child, the other side zed 89a7f120-e9ac-4ed6-9738-070990d1e4db
```

That thread is a sub-agent's: `kind` null, and a `subagent` link stated on the child. Zed gives
one `per_session` total from a thread's cumulative usage, and `per_turn` records anchored to a
`message_id` where that total is empty (`zed restore`).

**Links** say how two sessions relate (`subagent`, `fork`, …) and on which side the harness store
states it: `stated_on` is `child` or `origin`.

## 6. Read on from where you stopped

```sh
node examples/04-incremental-read/incremental-read.js
```

Between passes, keep per source its `position` (opaque: store it whole) and a generation, and per
session the derive `state` and the live keys. Next time, pass the position as `from`, and for a
delta source pass `known`, the `{unit_key: sha256}` of the units you hold. Then act on
`continuity`:

| `continuity` | What the units are | What you do |
|---|---|---|
| `reset` | every unit of the source, again | start a new generation; derive the session from `state` null with every unit of every source, `complete: true` |
| `appended` | only the new units of a stream | derive them with the saved `state`, `complete: false` |
| `delta` | the changed rows; vanished keys in `gone` | derive them, with `gone`, `complete: false` |
| `snapshot` | the whole new snapshot | derive it, `complete: false` |
| `unchanged` | none | nothing |

After a derive, a key that is in neither `live` nor `held` any more has gone from the store:
delete it. A held key keeps its last written version.

## 7. Errors

Every operation throws `SessionsError` with a `code`:
- `busy`, `inconsistent` and `damaged` are retryable: leave the session for the next pass. One
  that outlasts your retry budget while `updated_hint` is unchanged is reported; see
  [the adapter interface](adapter-interface.md#retryable-errors-what-a-consumer-does);
- `session_unknown`, `incarnation_gone` and `source_unknown` mean the session or source is not
  there (any more): list again;
- `harness_unknown`, `bad_request`, `folder_missing`, `host_unreadable` and `platform_unsupported`
  are not retryable: the call, the path or the machine needs fixing.

## A full pass

```sh
node examples/05-full-pass/full-pass.js "$(mktemp -d)/records.jsonl"
```

lists, reads, derives and validates every fixture case of every harness, and writes the records
as JSON Lines. Its last lines:

```
46 cases, 125 sessions, 1258 records, 0 findings, 0 errors
1258 records written as JSON Lines
```

`conformance/engine.js` is a minimal consumer that keeps positions, generations and state between
passes; the conformance suite runs every adapter through it.
