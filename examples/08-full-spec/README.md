# 08: a full spec

Two layers and `local.toml`, with every kind of item this build carries except an endpoint
(below says why):

```
base/                 the organisation's layer
  spec.toml           model roles, a declared secret, two MCP servers, a hook, a status line
  servers/ hooks/ bin/ the processes those items run
  skills/review/      a skill
team/                 the team's layer, above it
  spec.toml           its own primary model; [remove] takes mcp.notes out of base
  skills/notes/       another skill
local.toml            this machine: the secret's reference, retention, and an endpoint, commented out
```

```sh
sh examples/08-full-spec/run.sh
```

- **Layers merge per kind.** The team's `model.roles.primary` wins over the base's, and
  `[remove]` deletes an item from the layers below. `validate` reports the layer that set every
  item, and the items removed.
- **Secrets are references.** `local.toml` binds `DOCS_TOKEN` to `env:DOCS_TOKEN`.
  `launch-spec` returns `env_from_refs`, a map from variable to reference, for the caller to
  resolve at launch. `hs` never resolves or prints a value.
- **The endpoint is left out.** Before an endpoint launch, `hs` checks that the folder holds no
  stored login. On macOS that check asks the login keychain whether an item exists, by name only,
  and a locked keychain may answer with a dialog. So the example keeps to what runs the same on
  any machine. `local.toml` shows the endpoint's form in a comment.
- **One receipt for the launch.** The refusal lists every item that runs code or sends data,
  with the destination of each remote server. The receipt allows exactly those.

The format of each item is in [the spec reference](../../docs/reference/spec-format.md), and the
design behind it in [the design note](../../docs/design/skeleton-v0.2-2026-10-22.md) §5.
