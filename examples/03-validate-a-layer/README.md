# 03: validate a spec layer

A **spec** is an ordered list of **layers**, lowest first, and `local.toml` is always last. A
layer is a directory: `spec.toml` for every item that is not a file, plus the files (skills,
agents, commands, the processes items run).

```
team/
  spec.toml               [spec] name, version, format; then items
  skills/notes/SKILL.md   a skill
local.toml                this machine: endpoints, bindings of secrets, login, state
```

```sh
sh examples/03-validate-a-layer/run.sh
```

- `validate` resolves the layers, checks them against the standard and against the harness, and
  returns item ids, the layer that set each one, file digests and the spec digest. It never
  returns a value.
- The second run validates `broken/`, whose MCP server takes a secret (`env_refs`) that no layer
  declares under `[refs]`. The problem comes back as `ref_undeclared`, with the item and the
  ref's name.

The full format is in [the spec reference](../../docs/reference/spec-format.md).

Next: [04-launch-overlay](../04-launch-overlay/).
