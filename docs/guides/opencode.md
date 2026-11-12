# OpenCode

What `hs` does with OpenCode, and how to use it: the data folder, a launch, a folder a tool owns,
hooks, strict isolation and the known limits. The design note's section 7.5 has the full mapping
with its sources; the runnable examples are [09](../../examples/09-opencode-launch/) and
[10](../../examples/10-opencode-folder/).

**Versions:** the 2.x line, from 2.2.7 up to 2.3. The 1.x line is out of range: its `run` has no
`--standalone`. `hs detect --harness opencode` says which version a binary is.

## The data folder

An OpenCode data folder is its four XDG roots, side by side:

```text
opencode-data/
  config/   XDG_CONFIG_HOME   config/opencode/: opencode.json, skills/, AGENTS.md
  data/     XDG_DATA_HOME     the session database and the login store
  cache/    XDG_CACHE_HOME
  state/    XDG_STATE_HOME
```

A launch sets the four variables to the folder, and unsets the ones that would add a config layer
or move a store from the host shell: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
`OPENCODE_CONFIG_CONTENT`, `OPENCODE_PERMISSION`, `OPENCODE_DB` and `OPENCODE_AUTH_CONTENT`.

```sh
node bin/hs.js describe --harness opencode --pretty
node bin/hs.js observe --harness opencode --folder ./opencode-data --state --pretty
```

## At launch

```sh
node bin/hs.js launch-spec --harness opencode --folder ./opencode-data \
  --layer ./team --local ./local.toml --headless --pretty
```

A launch writes nothing into the folder. It carries:

- `--standalone` on every launch, headless (`opencode run --standalone --format json`) or not. A run
  without it would attach to the folder's background service and use that service's config, not the
  launch's.
- An inline config layer, `OPENCODE_CONFIG_CONTENT`. It holds:
  - the endpoint as a provider of its own, `hs`, with the key in a variable the caller fills from
    the reference;
  - the MCP servers under `mcp.servers`;
  - the launch's skills, `AGENTS.md` and hooks bridge, each named by its path in the launch's temp
    dir.

  The folder's own skills and `AGENTS.md` still load beside them.
- `-m hs/<model>` with an endpoint, or the model as given (`provider/model`) without one.
- `OPENCODE_DISABLE_CLAUDE_CODE=1`, which closes the `.claude` skill roots; with an endpoint, also
  `OPENCODE_DISABLE_MODELS_FETCH=1`, so the launch fetches no model catalog and contacts only what
  the spec names.

A launch never sets `OPENCODE_CONFIG_DIR`. In 2.x it would replace the folder's `config/opencode/`
rather than add to it, and with it what a plan installed there. Strict isolation (below) is the one
case that sets it, on purpose.

It is refused, with the reason:
- text OpenCode would substitute (`{env:…}`, `{file:…}`) in the model, the endpoint or an MCP
  server, keys included;
- a server named like one the folder's config defines;
- an endpoint launch while the folder holds a 1.x login store;
- permissions, agents, commands and plugins, which are not in this build. The status line has no
  OpenCode slot.

## Into a folder a tool owns

```sh
node bin/hs.js plan --harness opencode --folder ./opencode-data --layer ./team --owner builder --mode materialize > plan.json
node bin/hs.js apply --harness opencode --folder ./opencode-data --plan plan.json --receipt receipt.json
```

A plan writes into `config/opencode/`, which a bare `opencode` start reads:
- `opencode.json`'s `model` and `mcp.servers.<id>`, key by key, with the user's own keys kept. A
  stdio server is bound by copy into `hs-run/`.
- Each skill as a tree under `config/opencode/skills/`.

The endpoint, the login, `AGENTS.md` and hooks stay launch only.

A plan refuses:
- an `opencode.jsonc` in the folder, which outranks `opencode.json`;
- a server with refs, or with a working directory;
- a model with no provider.

A launch skips what a plan installed at this content. A running background service picks up a
change without a restart.

## Hooks

OpenCode 2.x has plugin functions, not command hooks. hs's bridge plugin runs the hook shim for each
spec hook:
- **`PreToolUse`** rides `tool.execute.before`, the one plugin hook that can refuse. It fails closed
  on every shim failure: another exit, a signal, a shim that cannot start, or a shim still running at
  its limit.
- **`PostToolUse`** rides `tool.execute.after`, and cannot block.
- **Every other event is refused by name**, or skipped when `require = "if-supported"`.
  `may_allow` and an `mcp:` match are always refused.

The bridge writes a readiness file once its hooks are registered, and `launch-spec` names it under
`readiness`. A caller that needs its guards waits for that file. If the plugin fails to load, OpenCode
starts without it and the file never appears.

## Strict isolation

With `isolation = "strict"` at the top of a layer, only the instructions and skills the spec names
reach the agent:
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` turns the project walk off;
- skill permissions in the inline layer deny every skill but the spec's;
- `OPENCODE_CONFIG_DIR` is an empty directory of the launch's own, so the folder's `config/opencode/`
  is not read. The launch then carries what a plan installed itself, under the launch receipt.

The project's own `AGENTS.md` is not added back: name the project's instructions in the spec if the
agent should follow them. A system or managed config directory has no switch, so a strict launch is
refused while one exists.

## Known limits

`describe` lists them, and `observe --state` reports each one whose path exists:
- `~/.agents/skills`, a skill root read from `$HOME` (strict closes it);
- `AGENTS.md` in the working directory and its parents, up to `$HOME` (strict closes it);
- `.agents/`, `.claude/` and `.opencode/` in the working directory and its parents (strict closes them);
- `~/.opencode/`, which OpenCode reads as a config directory and writes a `.gitignore` into.

## Sessions

`sessions.list`, `sessions.read` and `sessions.derive` read the folder's session database, through
the session adapters ([read-sessions.md](read-sessions.md)).
