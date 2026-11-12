# 10: deliver into an OpenCode folder

Under `materialize`, a plan writes into the folder's own config directory, `config/opencode/`,
which a bare `opencode` start reads.

```sh
sh examples/10-opencode-folder/run.sh
```

- The plan has four operations: `opencode.json`'s `model`, the server's bound copy in `hs-run/`,
  its key under `mcp.servers`, and the skill under `skills/`. Each that runs code needs the
  receipt.
- `apply` edits `opencode.json` key by key, so the user's own `theme` stays as it was.
- A launch for the same spec skips what the plan installed at this content: the receipt already
  covered it.
- `remove` takes the owner's items out and leaves the user's key.

The guide: [`docs/guides/opencode.md`](../../docs/guides/opencode.md). Next:
[11-pi-launch](../11-pi-launch/).
