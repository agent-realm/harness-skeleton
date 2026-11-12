# 11: pi at launch, the session's directory, and strict isolation

A pi data folder is its one agent dir, `PI_CODING_AGENT_DIR`. `launch-spec` writes nothing into it:
the endpoint's provider, the MCP servers and the hooks go into one extension hs generates in the
launch's temp dir, passed with `-e`.

```sh
sh examples/11-pi-launch/run.sh
```

- `describe` lists the known limits, and what closes each: strict isolation, or `--cwd`.
- The layer holds a skill, an `AGENTS.md` and a `PreToolUse` guard. The skill and the hook run code,
  so the launch asks for a receipt.
- With the receipt, the argv carries the extension (`-e`), the skill (`--skill`) and `AGENTS.md`
  (`--append-system-prompt`). `launch-spec` was given `--cwd`, the directory pi will run in, so the
  argv also has `--session-dir`: pi's own place for that directory's sessions in the folder. A
  project's `.pi/settings.json` then cannot move the session out of the folder.
- The hooks are active once the extension writes its readiness file: a caller that needs its guards
  waits for it.
- With `isolation = "strict"` the argv gains `--no-skills`, `--no-context-files` and
  `--no-approve`. The spec's own skill and `AGENTS.md` still reach the agent.
- Strict refuses a folder that holds what no switch keeps out, such as a `SYSTEM.md`, naming it.

The guide: [`docs/guides/pi.md`](../../docs/guides/pi.md). Next: [12-pi-folder](../12-pi-folder/).
