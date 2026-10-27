# 05: a full pass over every harness

A consumer's first capture, over every fixture case of all twelve harnesses: list each store,
read every source to its end, derive every session, validate its records, and write them out as
JSON Lines.

```sh
node examples/05-full-pass/full-pass.js                          # the summary only
node examples/05-full-pass/full-pass.js "$(mktemp -d)/records.jsonl"
```

- **One row per fixture case:** its sessions, the records derived, and the `validateSession`
  findings that are not warnings. All are 0. The last line sums them: 46 cases, 124 sessions,
  1255 records, the same records the reviewed goldens (`fixtures/*/*/expected.json`) hold.
- **The JSON Lines file** has one record per line, sealed as `derive` returns it, with its full
  session key. Its `harness_path` names the scratch copy of the case, which is gone once the case
  is done.
- **Errors:** `busy`, `inconsistent` and `damaged` are retryable. A consumer leaves that session
  for its next pass, and the script lists it in the row. Any other error stops the script. The
  exit code is 1 when there is a finding or an error.
- **Database stores** (Goose, OpenCode, agy, Cursor, cursor-agent, Zed, Devin) are built from the
  fixtures' text form first (`conformance/sql-store.js`). Every adapter opens them read-only.

This is a first pass only. A long-running consumer keeps each source's position and the derive
state between passes, as [04-incremental-read](../04-incremental-read/) shows, and
`conformance/engine.js` is a minimal consumer that does both.
