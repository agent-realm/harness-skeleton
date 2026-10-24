# 06: processes at launch: an MCP server, a hook, a status line

Anything a spec runs is a **process**: `{ exec, args, cwd?, env?, env_refs? }`, with paths
relative to its layer. Every process carries the `runs-code` risk, and each needs the user's
receipt.

```sh
sh examples/06-processes/run.sh
```

- **`validate`** returns the items and the spec digest. The digest covers the sha256 of every
  file a process names inside its layer (`servers/notes.mjs`, `hooks/guard.sh`, `bin/status.sh`),
  so an edited script changes the digest, and an old receipt no longer fits.
- **`launch-spec`** without a receipt is refused as `receipt_required`, listing each process and
  its risk. The script writes a receipt for exactly those items, as a user's tool would after
  showing them.
- **With the receipt,** the launch carries the server in `--mcp-config`, and the hook and the
  status line in the `--settings` overlay. The hook runs through hs's hook shim, which hands it
  one JSON envelope on stdin and translates its decision.

To persist processes into the folder instead, use `plan` under `materialize`, as in
[05](../05-materialize/). Each process is then bound by copy into `hs-run/<item>/`, and needs
`self_contained = true`.

Next: [07-sessions](../07-sessions/).
