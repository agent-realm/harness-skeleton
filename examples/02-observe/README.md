# 02: observe a data folder

`observe` reads a data folder and reports what is in it. It never changes the folder.

```sh
sh examples/02-observe/run.sh
```

The script builds a small Claude Code data folder in a scratch directory, then runs
`hs observe --harness claude-code --folder <folder> --state`:

- **The state inventory:** every path in the folder by class: `config`, `sessions`, `history`,
  `credentials`, `cache`, `runtime`, `logs`, `skeleton`, or `unknown`. A credentials file is
  listed, never read.
- **The value in effect** for each `[state]` item, such as the transcript retention, with its
  source: the folder, a managed policy, or the harness default.
- **The store key** (`host`, `harness`, `harness_path`) that names this folder's sessions.

Point `--folder` at your own data folder only to read it: `observe` writes nothing there.

Next: [03-validate-a-layer](../03-validate-a-layer/).
