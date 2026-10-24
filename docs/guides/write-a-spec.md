# Write a spec

**Goal:** describe a harness environment once, in the skeleton's shape, and check it.

A spec is an ordered list of layers, lowest first. `local.toml`, this machine's own layer, is
always last:

```
org/           a layer: spec.toml plus files
  spec.toml
  skills/review/SKILL.md
team/          a layer above it
  spec.toml
local.toml     this machine: endpoints, secret bindings, login, state
```

Each `spec.toml` starts with its header:

```toml
[spec]
name    = "team"
version = "1.4.0"      # the content's own version
format  = "0.2"        # the spec format
```

Then items: model roles, MCP servers, hooks, the status line, secrets declared by name, and
more ([the spec reference](../reference/spec-format.md) lists every kind). Files sit beside it:
`AGENTS.md`, `skills/<name>/SKILL.md`, `agents/<name>.md`, `commands/<name>.md`, and the
scripts the processes run.

**Merging is per kind:**
- a scalar (a model role, the status line): the last layer wins;
- a keyed item (`mcp.<id>`, `hook.<id>`): the last layer replaces the whole item;
- a file item: the later layer's file wins by name;
- `AGENTS.md`: concatenated in layer order;
- `[remove] items = ["mcp.legacy"]` takes an item out of the layers below.

**Secrets are references.** A layer declares what it needs, by name:

```toml
[refs.DOCS_TOKEN]
description = "token for the docs MCP server"

[mcp.docs]
url        = "https://docs.example/mcp"
bearer_ref = "DOCS_TOKEN"
```

and `local.toml` binds it to a reference, never a value:

```toml
[refs]
DOCS_TOKEN = "env:DOCS_TOKEN"     # or keychain:<name>, op://…, age:…, file:/…
```

**Check it:**

```sh
node bin/hs.js validate --harness claude-code --layer ./org --layer ./team --local ./local.toml --pretty
```

`validate` returns:
- `valid`;
- the items, each with the layer that set it;
- the file digests and the spec digest;
- `removed` and `replaced`;
- `problems`, each with a code, a severity, the item and the layer.

It never returns a value. A value in `local.toml` that is not a reference fails as
`ref_not_reference` and is not echoed: it may be a pasted secret.

See [example 08](../../examples/08-full-spec/) for two layers with every kind of item.
