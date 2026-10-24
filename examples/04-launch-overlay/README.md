# 04: a launch with an overlay

`launch-spec` turns a spec into a launch: the argv, the environment to set and to unset, and
overlay files in a temp directory. Nothing is written into the data folder. The caller runs the
argv, appending its own arguments.

```sh
sh examples/04-launch-overlay/run.sh
```

- The layer from [03](../03-validate-a-layer/) carries a skill. A skill can run code, so the
  first `launch-spec` is refused as `receipt_required`, with the launch's digest and the items
  that need allowing.
- A **receipt** is the user's approval: `{"format": "hs-receipt/0.2", "launch_digest", "allows",
  "by"}`. It binds that exact launch: change a file of the skill and the digest changes, and the
  receipt no longer fits.
- With the receipt, `launch-spec` answers. On Claude Code: `--settings` names the overlay file,
  `--plugin-dir` carries the skill, `--model` the role, and `CLAUDE_CONFIG_DIR` the folder. The
  notes say which temp directory to remove after the launch.

Next: [05-materialize](../05-materialize/).
