# 01: describe one adapter

The smallest thing an adapter does: say what it reads and how. `describe()` takes nothing. It
opens no store and touches no file.

```sh
node examples/01-describe/describe.js             # Claude Code
node examples/01-describe/describe.js opencode    # any of the twelve harness ids
```

- **Versions:** `adapter_ver` moves when the records for the same units change, or `read`'s split
  or redaction does; `state_ver` when the shape of the derive state does; and `model_version`
  names the record shape (`sessions-model/1`). What each bump asks of a consumer is in
  [the adapter interface](../../docs/adapter-interface.md#versions).
- **`store_shape`:** what `harness_path` names: a data folder, or (OpenCode) one database file.
- **Sources:** each kind of file or table the adapter reads, with its `role`, its `mode` (`stream`,
  `snapshot` or `delta`) and how a position into it is kept.
- **Redaction:** the paths whose values `read` replaces with `<redacted len=N>` before a unit
  leaves the adapter.
- **Facets:** how each lifecycle operation (rewind, edit, compaction, …) shows in the store:
  `explicit` (a record says so), `implicit` (inferred from what changed) or `invisible` (the store
  does not show it). And how hook events join a session.

The last block lists every adapter in the package with its versions.

Next: [02-list-sessions](../02-list-sessions/).
