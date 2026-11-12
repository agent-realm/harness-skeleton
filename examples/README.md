# Examples

From the smallest to a full spec. Each directory has a README and a `run.sh`:

```sh
sh examples/01-describe/run.sh
```

Every script works in a fresh scratch directory (or `$WORK` when set) and uses the stand-in
harness binaries in [`bin/`](bin/) (Claude Code, Codex, OpenCode and pi), which answer `--version` and nothing else. So no example
starts a real harness, and none reads or writes a real data folder. `npm test` runs them all
(`test/examples.test.js`).

| Example | Shows |
|---|---|
| [01-describe](01-describe/) | what the adapter speaks and carries; finding a harness and its version |
| [02-observe](02-observe/) | reading a data folder: its paths by class, the retention in effect and its source |
| [03-validate-a-layer](03-validate-a-layer/) | a spec layer and `local.toml`, resolved and validated; a problem reported |
| [04-launch-overlay](04-launch-overlay/) | a launch that carries the spec, writing nothing into the folder; a launch receipt |
| [05-materialize](05-materialize/) | plan, receipt, apply and remove in a folder a tool owns; the user's own keys kept |
| [06-processes](06-processes/) | an MCP server, a hook and a status line at launch, under one receipt |
| [07-sessions](07-sessions/) | listing a folder's sessions and reading a transcript |
| [08-full-spec](08-full-spec/) | two layers and `local.toml` with every kind of item: merges, removals, secrets as references |
| [09-opencode-launch](09-opencode-launch/) | OpenCode at launch: the endpoint, a skill and `AGENTS.md` in its inline layer; strict isolation |
| [10-opencode-folder](10-opencode-folder/) | plan, apply and remove in an OpenCode folder; a launch that skips what a plan installed |
| [11-pi-launch](11-pi-launch/) | pi at launch through one generated extension; the session's directory with `--cwd`; strict isolation and its refusal |
| [12-pi-folder](12-pi-folder/) | plan, apply and remove in a pi folder: `settings.json`, `mcp.json`, `skills/` |
| [13-pi-plugin](13-pi-plugin/) | an Agent Plugins package on pi, translated into a pi package; its data kept on remove |

The commands are `node bin/hs.js <op> …` from the repository root; the scripts wrap that as `hs`.
