# 03: read and derive one session

The two steps that turn a harness's files into records: `read` returns raw units, and `derive`
turns units into the contract's records.

```sh
node examples/03-read-and-derive/read-and-derive.js                   # claude-code basic
node examples/03-read-and-derive/read-and-derive.js goose features    # [harness] [case]
```

- **`read(store, session, source_key, from, known)`**, here with no position and nothing known,
  returns every unit of the source, with `continuity: 'reset'`. A unit is one line of a stream, a
  whole snapshot, or a row of a table read by delta. A partial last line is `held_back`, never
  returned. One read returns at most 64 MiB and says `more: true`; the script reads on until it
  is done.
- **`derive(session, input, null)`**: a first derive takes every source with `complete: true` and
  no state, and `changed` holds every record of the session. It does no I/O.
- **The output:** `changed` (the records), `live` (every live key), `held` (keys withheld as
  incomplete, such as a reply still being written), the versions, and `checkpoint` (whether the
  new state is safe to persist). `live` and `held` always carry all five record types (`session`,
  `message`, `usage`, `link`, `lifecycle`), each a sorted list, empty where there is nothing.
- **`validateSession`** (`@agent-realm/session-adapters/validate`) checks the records against the
  record shapes of sessions-model §2. None of the fixtures gives a finding.

Then the script prints the parts of the records a reader most often gets wrong:

- **The session's `kind`** is the harness's own session type, and null where the store writes
  none. A sub-agent session is not told by its kind: it has a `subagent` link. Try `zed lab`,
  whose first thread is a sub-agent's: `kind null`, and a `subagent` link stated on the child.
- **Tool results:** `status` says whether the call completed: `completed`, `cancelled` or
  `denied`. `is_error` is the harness store's own flag for a call that completed. It is null where
  the store keeps no flag, where the flag says success beside a shell's non-zero `exit_code`, and
  wherever `status` is `cancelled` or `denied`. It is never worked out from the exit code or the
  output's text. `copilot-cli features` shows copied flags, a null beside exit code 1, and a
  denied call.
- **Usage:** each record's `granularity` (`per_response`, `per_message`, `per_turn` or
  `per_session`) and what its `anchor` names, with the two flags that say what `input` and
  `output` count (null where nothing settles it). The usage records of one session never overlap,
  so a total is their sum. `zed restore` gives `per_turn` records anchored to a `message_id`, and
  `zed lab` one `per_session` total.
- **Links:** how the session relates to another (`subagent`, `fork`, …), and on which side the
  harness store states it.

The script prints the first ten messages with the kinds of their parts, and the first ten tool
results. The text is the fixture's own, synthetic.

Next: [04-incremental-read](../04-incremental-read/).
