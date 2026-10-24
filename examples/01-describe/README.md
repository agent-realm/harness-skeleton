# 01: describe and detect

The smallest thing `hs` does: say what it speaks, and find a harness.

```sh
sh examples/01-describe/run.sh
```

- `describe --harness claude-code` needs no folder and no binary. It returns:
  - the protocol versions (`hs/0.2`) and the operations this adapter carries;
  - the harness descriptor: where Claude Code keeps what, the path classes, the version ranges;
  - for sessions, the session adapter's own `describe`.
- `detect` runs the harness binary with `--version`, in a scratch environment, and reports the
  version and whether it falls in the `certified` or `compatible` range. Here it runs the
  examples' stand-in (`examples/bin/claude`), which answers `--version` and nothing else.

Next: [02-observe](../02-observe/).
