# Run a conformance check

**Goal:** prove the adapter against a real harness. The unit tests (`npm test`) never start a
harness. Tier 1 checks do, so they run on a **disposable bench** only: a VM made for it, or a CI
runner. Never run one on a workstation, and never against a real data folder.

Every check:
- refuses to run without `HS_BENCH=1`;
- works in a fresh scratch directory with its own `HOME` and XDG roots, and removes it after
  (`--keep` keeps it);
- uses only dummy credentials: the model is a local listener or the scripted model
  ([`packages/scripted-model/`](../../packages/scripted-model/)) on `127.0.0.1`, never a real
  provider.

**On a bench VM:**

```sh
BENCH=my-bench-vm
B=$(ssh $BENCH 'mktemp -d /tmp/hs-bench-XXXX')
rsync -a --exclude .git ./ $BENCH:$B/repo/
ssh $BENCH "cd $B/repo && npm ci --ignore-scripts && npm install --prefix $B/cc @anthropic-ai/claude-code@2.1.307"
ssh $BENCH "cd $B/repo && HS_BENCH=1 node conformance/tier1/<check>.mjs --claude $B/cc/node_modules/.bin/claude \
  --hs-rev $(git rev-parse --short HEAD) > $B/report.json"
scp $BENCH:$B/report.json conformance/results/claude-code-2.1.307-<check>-<YYYY-MM-DD-HH_MM>.json
ssh $BENCH "rm -rf $B"
```

The Codex checks take `--codex <path>` (`npm install @openai/codex@<version>`) instead of
`--claude`.

**The report** records the harness version, Node, the OS, the hs commit (`--hs-rev`, since the
bench copy has no `.git`) and each check's result. Name it by its run's time in UTC, the report's
`at` field. Its verdict:

| Verdict | Exit |
|---|---|
| `pass` | 0 |
| `fail` | 1 |
| `inconclusive`: a positive control did not show the effect | 3 |
| the check could not run | 4 |

[`conformance/README.md`](../../conformance/README.md) lists every check and its last result.
