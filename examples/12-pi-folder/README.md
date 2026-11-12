# 12: deliver into a pi folder

Under `materialize`, a plan writes into the agent dir's own files, which a bare `pi` start reads.

```sh
sh examples/12-pi-folder/run.sh
```

- The model, given as `provider/model`, becomes `settings.json`'s `defaultProvider` and
  `defaultModel`, with the user's own `theme` kept.
- The server is bound by copy into `hs-run/` and written as `mcp.json`'s `mcpServers.notes`, with
  `exposure` `direct`, so pi offers its tools by name.
- The skill is a tree under `skills/`.
- A launch skips what the plan installed, and `remove` takes it out again.

The guide: [`docs/guides/pi.md`](../../docs/guides/pi.md). Next: [13-pi-plugin](../13-pi-plugin/).
