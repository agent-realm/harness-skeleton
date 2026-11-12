# 09: OpenCode at launch, and strict isolation

An OpenCode 2.x data folder is its four XDG roots: `config/`, `data/`, `cache/` and `state/`.
`launch-spec` binds them, and carries the spec in an inline config layer, writing nothing into the
folder.

```sh
sh examples/09-opencode-launch/run.sh
```

- `describe` names the folder's layout and the **known limits**: what reaches a launch that the
  spec never named, such as `~/.agents/skills` or an `AGENTS.md` in a parent of the working
  directory.
- The layer `kit/` holds a skill and an `AGENTS.md`, and `local.toml` an endpoint whose key is a
  reference (`env:GATEWAY_KEY`). A skill can run code, so the first `launch-spec` asks for a
  receipt.
- With the receipt, the argv is `opencode run --standalone`, and the inline layer
  (`OPENCODE_CONFIG_CONTENT`) names the endpoint's provider, the skills and the instructions, each by
  path in the launch's temp dir. The key comes back as a reference, for the caller to fill.
- The layer `strict/` adds `isolation = "strict"`. The launch then turns off OpenCode's project
  walk, denies every skill but the spec's, and gives OpenCode an empty config directory of its own,
  so the folder's `AGENTS.md` and skills stay out too.

On a machine with an OpenCode system or managed config directory, the strict launch is refused as
`isolation_unmet`, naming that directory: no switch keeps it out.

The guide: [`docs/guides/opencode.md`](../../docs/guides/opencode.md). Next:
[10-opencode-folder](../10-opencode-folder/).
