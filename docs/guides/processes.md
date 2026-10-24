# Processes: MCP servers, hooks, status lines, skills

Anything a spec runs is a **process**:

```toml
run = { exec = "hooks/guard.sh", args = ["--strict"], cwd = "hooks", env = { MODE = "ci" }, env_refs = { TOKEN = "CI_TOKEN" } }
```

Paths are relative to the item's layer. A plain shell string is allowed as `shell = "…"`, and is
marked non-portable. Every process carries the `runs-code` risk, so each needs a receipt.

**What binds a process.**
- **Its files.** The spec digest covers the sha256 of every file a process names inside its layer
  (`exec`, and each `args` entry that is a file there). An edited script changes the digest, and
  an old receipt no longer fits.
- **Its text only,** for an `exec` found on `PATH` or a shell string. The risk list says so.
- **Launchers that fetch code** (`npx`, `uvx`, `bunx`, `pipx run`) also carry `fetches-code`,
  naming the package. Pin the version to fix what is fetched, though not its content.

**MCP servers:**

```toml
[mcp.db]
exec     = "node"
args     = ["servers/db.mjs"]
env_refs = { DB_PASS = "DB_PASSWORD" }

[mcp.docs]
url        = "https://docs.example/mcp"
bearer_ref = "DOCS_TOKEN"        # a remote server also carries sends-data, with its destination
```

**Hooks:**

```toml
[hook.guard]
event   = "PreToolUse"           # also SessionStart, UserPromptSubmit, PostToolUse, Stop, …
match   = { tool = ["shell"] }   # tool classes: shell, edit, read, fetch, mcp:<server>
run     = { exec = "hooks/guard.sh" }
timeout = 10                     # seconds; hs's shim stops the process at this limit and decides
```

A hook runs through hs's hook shim. The shim hands it one JSON envelope on stdin (`hs`, the
portable part, and `native`, the harness's own payload) and translates its decision:
- exit 0 continues;
- exit 2 blocks, with stderr as the reason;
- `{"decision": "allow" | "deny", "reason"}` on stdout decides explicitly.

On a gating event (`PreToolUse`, `PermissionRequest`, `UserPromptSubmit`), what fails decides
whether the guard fails closed:
- **The hook's process** crashes, is killed, or overruns its `timeout`: the running shim blocks
  the action, on every harness.
- **The shim itself cannot start** (node gone, its copy missing):
  - a hook persisted on Claude Code 2.1.295 or later blocks, through `onFailure: "block"`;
  - at launch on Claude Code, and on Codex, the action goes through.

  `launch-spec` lists this under `unverified`, so it is never taken for a guarantee.

**The status line:**

```toml
[statusline]
run     = { exec = "bin/status.sh" }
refresh = 5
```

**Skills:** `skills/<name>/SKILL.md`, in the Agent Skills format, with `name` equal to the
directory. On Claude Code a launch carries them with `--plugin-dir`. On Codex only the folder
loads them, so deliver them with a plan.

**Persisting processes.** Under `materialize`, a persisted process runs at every start with no
launch receipt, so the plan binds it by copy:
- the one top-level directory of its layer that holds what it names is copied into
  `hs-run/<item>/`, owner-only, and recorded in the ledger;
- the persisted command names the copies;
- this needs `self_contained = true` on the process, the author's word that the directory holds
  all it loads;
- a process that takes a secret (`env_refs`) is not persisted, since a bare start would get an
  empty value; carry it at launch instead.

See [example 06](../../examples/06-processes/).
