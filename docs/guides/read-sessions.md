# Read sessions

**Goal:** list a data folder's sessions and read their transcripts, as the session contracts
define them.

`hs` hands these operations to the session adapters package
([`packages/session-adapters/`](../../packages/session-adapters/)), one reader per harness. It
reads no harness store itself.

**List:**

```sh
node bin/hs.js sessions.list --harness claude-code --folder ~/.claude --pretty
```

Each session comes with:
- its key: `host`, `harness`, `harness_path`, `session_id`, `incarnation`;
- an `updated_hint`, which changes whenever the session does;
- `live`;
- its sources: the main transcript, subagents, side files. Each has a `role`, a `mode`
  (`stream` or `snapshot`) and a `position_kind`.

**Read** takes a session key and a source, so it is sent as a JSON envelope:

```json
{"protocol": "hs/0.2", "request_id": "1", "op": "sessions.read",
 "args": {"harness": "claude-code", "harness_path": "/abs/path/claude-data",
          "session": {"host": "…", "harness": "claude-code", "harness_path": "/abs/path/claude-data",
                      "session_id": "…", "incarnation": ""},
          "source_key": "projects/-work-repo/<session>.jsonl"}}
```

```sh
node bin/hs.js < read.json
```

It returns:
- raw `units` from the position you give (`from`), or from the start;
- `continuity`: how the units relate to what you read before: `appended`, `delta`, `snapshot`,
  `unchanged`, or `reset` (read again from the start);
- `gone` and `held_back` units;
- the `position` to read from next time.

**Derive** (`sessions.derive`) turns units into the contract's records: messages and parts,
usage, links. It is pure, and never touches the store.

**Database-file stores** (OpenCode keeps its sessions in SQLite) take `--store <file>`: a name in
the folder, or an absolute path.

All three operations only read. See [example 07](../../examples/07-sessions/).
