# Launch with an overlay

**Goal:** start a harness with a spec carried at launch. Nothing is written into its data
folder, so the folder may be the user's own.

![overlay carries the spec at launch and writes nothing into the data folder; materialize writes the managed files of a folder the tool owns; reconcile is designed, not built. No mode writes state.](../diagrams/delivery-modes.svg)

```sh
node bin/hs.js launch-spec --harness claude-code --folder ./claude-data \
  --layer ./team --local ./local.toml --pretty
```

`launch-spec` returns:
- **`argv`**, a prefix: you append your own arguments, such as a prompt for a headless run;
- **`env_set`** and **`env_unset`**;
- **overlay files** in a temp directory, which the notes tell you to remove after the launch;
- **`env_from_refs`**: each variable a secret goes into, with its reference. You resolve each
  reference into its variable when you start the process, for example with a wrapper that reads
  `env:NAME` or your keychain. `hs` never resolves or prints a value.

**Receipts.** An item that runs code (a skill, a hook, an MCP server, a status line) or sends data
(a remote MCP server) needs the user's approval for this exact launch. Without one,
`launch-spec` is refused as `receipt_required`. The error's items carry the `launch_digest` and
each risky item. Write a receipt for that digest:

```json
{"format": "hs-receipt/0.2", "launch_digest": "sha256:…", "allows": ["skill.notes", "mcp.docs"], "by": "user"}
```

and pass it with `--receipt receipt.json`. The digest covers the spec (every file a process
names included), the folder's version of the harness, and what the launch hands it. Change any of
them and the receipt no longer fits.

**Per harness:**
- **Claude Code:** `--settings` for the overlay (hooks, the status line, retention),
  `--plugin-dir` for skills, `--mcp-config` for servers, `--model` for the role, and
  `CLAUDE_CONFIG_DIR` for the folder.
- **Codex:** `-c` overrides for MCP servers and hooks, with a `-c hooks.state` table that trusts
  the launch's own hooks for this launch only. Codex has no skill root a launch can add, so a
  skill on Codex is refused at launch; deliver it into the folder instead
  ([deliver to a folder](deliver-to-a-folder.md)).

An item the plan already installed in the folder, at this content, is skipped, so it never runs
twice.

**Endpoints.** With `[endpoints.<wire>]` in `local.toml`, the launch points the harness at that
endpoint, carries its credential by reference, and unsets every other credential variable. A
folder that holds a stored login is refused as `login_present`, since the login could reach the
endpoint.

See [example 04](../../examples/04-launch-overlay/) and [example 06](../../examples/06-processes/).
