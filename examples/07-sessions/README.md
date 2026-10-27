# 07: list and read sessions

`hs` reads a harness's sessions through the session adapters package
([`packages/harness-session-adapters/`](../../packages/harness-session-adapters/)), one reader per harness, as the
`sessions` contract defines them.

```sh
sh examples/07-sessions/run.sh
```

- **`sessions.list`** returns each session in the folder's store, with its key (`host`,
  `harness`, `harness_path`, `session_id`, `incarnation`) and its sources: the main transcript
  and, here, one subagent's.
- **`sessions.read`** takes a session key and a source, and returns raw units from a position,
  with `continuity` (here `reset`: read from the start) and the position to read on from next
  time. It has no CLI flags for its arguments, so the script sends the request as one JSON
  envelope on stdin: `hs < request.json`.
- **`sessions.derive`** turns raw units into the contract's records. It is pure: it never
  touches the store.

The session in this example is a synthetic fixture. Pointed at a real data folder, these
operations read only.

Next: [08-full-spec](../08-full-spec/).
