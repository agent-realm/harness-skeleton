# 02: list the sessions in a store

`list(store)` names every session in a harness store, with the sources to read for it.

```sh
node examples/02-list-sessions/list.js                    # claude-code basic
node examples/02-list-sessions/list.js zed features       # [harness] [case]
```

- **The store** is `{host, harness, harness_path}`. `harness_path` is the real path of the data
  folder (or, for OpenCode, the database file), from `harnessPath()`, which resolves symlinks and
  the on-disk case.
- **A session** is keyed by the store plus `session_id` and `incarnation` (empty unless the harness
  can reuse an id and the adapter can tell the lives apart). `live` is `unknown` from every
  adapter in this package today.
- **Its sources** are what `read` takes: a transcript file (`stream`), a whole file or row
  (`snapshot`), or a table read by changed rows (`delta`). A `source_key` is relative to the
  store, except OpenCode's spilled tool outputs, which are absolute; the example shows those
  relative to the scratch directory.
- **`updated_hint`** changes whenever the session does, so a consumer can skip a session that did
  not move. The example does not print it: for a file store it hashes each file's size and
  modification time, which differ from one copy to the next.

`list` writes nothing, and the sessions come sorted by `session_id`.

Next: [03-read-and-derive](../03-read-and-derive/).
