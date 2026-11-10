# Conformance

Checks that prove an adapter against a real harness (design note v0.2 §10). Tier 0 is the unit
test suite (`npm test`); the tiers here start real harnesses.

**They run on benches only:** a disposable VM or a CI runner.
Never on a user's workstation, never against a user's real data folder (AGENTS.md, Testing).
Every script refuses to run unless `HS_BENCH=1` is set, works in a fresh scratch directory with
its own `HOME` and XDG roots, and removes it afterwards (`--keep` keeps it).

| Check | Tier | Script | Last result |
|---|---|---|---|
| Retention holds between launches (§10) | 1 | [`tier1/retention-between-launches.mjs`](tier1/retention-between-launches.mjs) | pass, Claude Code 2.1.307 on a bench, 2026-10-24 ([report](results/claude-code-2.1.307-retention-between-launches-2026-10-24-10_02.json)) |
| The `--settings` overlay's `env` wins per variable over the folder's settings `env`, and an endpoint launch clears ambient credentials (§7.5) | 1 | [`tier1/overlay-env-precedence.mjs`](tier1/overlay-env-precedence.mjs) | pass, Claude Code 2.1.307 on a bench, 2026-10-24 ([report](results/claude-code-2.1.307-overlay-env-precedence-2026-10-24-10_02.json)); the small and subagent role variables not observed by a one-shot start |
| Endpoint hygiene: the cached account state cleared one way and not written back (§5.2, §7.2) | 1 | [`tier1/account-state.mjs`](tier1/account-state.mjs) | pass, Claude Code 2.1.307 on a bench, 2026-10-24 ([report](results/claude-code-2.1.307-account-state-2026-10-24-10_02.json)) |
| A skill at launch, through `--plugin-dir` under a launch receipt (§7.5) | 1 | [`tier1/skills-at-launch.mjs`](tier1/skills-at-launch.mjs) | pass, Claude Code 2.1.307 and 2.1.321 on a bench, 2026-11-09 ([2.1.307](results/claude-code-2.1.307-skills-at-launch-2026-11-09-21_25.json), [2.1.321](results/claude-code-2.1.321-skills-at-launch-2026-11-09-21_26.json)); 2.1.321 lists the skill by name, without its description |
| MCP servers at launch, through `--mcp-config` under a launch receipt (§5.5, §7.5) | 1 | [`tier1/mcp-at-launch.mjs`](tier1/mcp-at-launch.mjs) | pass, Claude Code 2.1.307 on a bench, 2026-10-24 ([report](results/claude-code-2.1.307-mcp-at-launch-2026-10-24-10_02.json)) |
| MCP servers at launch on Codex, through `-c mcp_servers` overrides under a launch receipt, and the shell tool's scrub of the secret variables (§5.3, §5.5, §7.5) | 1 | [`tier1/codex-mcp-at-launch.mjs`](tier1/codex-mcp-at-launch.mjs) | pass, Codex 0.160.0 on a bench, 2026-10-24 ([report](results/codex-0.160.0-mcp-at-launch-2026-10-24-10_03.json)) |
| A skill materialized into `$CODEX_HOME/skills` reaches Codex; fails loudly if Codex stops loading that deprecated root (§7.5) | 1 | [`tier1/codex-skills-materialized.mjs`](tier1/codex-skills-materialized.mjs) | pass, Codex 0.160.0 on a bench, 2026-10-24 ([report](results/codex-0.160.0-skills-materialized-2026-10-24-10_03.json)) |
| Hooks at launch on Codex, through hs's hook shim, trusted by `-c hooks.state` under a launch receipt (§5.6, §7.5) | 1 | [`tier1/codex-hooks-at-launch.mjs`](tier1/codex-hooks-at-launch.mjs) | pass, Codex 0.160.0 on a bench, 2026-10-24 ([report](results/codex-0.160.0-hooks-at-launch-2026-10-24-10_03.json)) |
| MCP servers persisted by a plan under `materialize`, in user scope, a stdio server bound by copy (§5.4, §7.5) | 1 | [`tier1/mcp-persisted.mjs`](tier1/mcp-persisted.mjs) | pass, Claude Code 2.1.307 on a bench, 2026-10-24 ([report](results/claude-code-2.1.307-mcp-persisted-2026-10-24-10_02.json)) |
| Hooks persisted by a plan under `materialize`: `settings.json` elements beside the user's, run from `hs-run` copies, a guard failing closed with `onFailure: "block"` (§5.4, §7.4, §7.5) | 1 | [`tier1/hooks-persisted.mjs`](tier1/hooks-persisted.mjs) | pass, Claude Code 2.1.307 on a bench, 2026-10-24 ([report](results/claude-code-2.1.307-hooks-persisted-2026-10-24-10_02.json)) |
| Hooks at launch, through hs's hook shim under a launch receipt (§5.6, §7.5) | 1 | [`tier1/hooks-at-launch.mjs`](tier1/hooks-at-launch.mjs) | pass, Claude Code 2.1.307 on a bench, 2026-10-24 ([report](results/claude-code-2.1.307-hooks-at-launch-2026-10-24-10_02.json)) |
| An Agent Plugins 1.0.0 package on Claude Code: as published (recorded), and as a plugin item carried by hs's `launch-spec` under a receipt, translated to the `.claude-plugin` layout, nested under `package/`, with the `/bin/sh` working-directory prelude; inert root paths stay inert; the adapter's four refusals (version, invalid skill, literal text, `cwd`); the premises of the nesting, the prelude and the literal-text refusal (§5.7, §10) | 1 | [`tier1/agent-plugins-claude-code.mjs`](tier1/agent-plugins-claude-code.mjs) | pass, Claude Code 2.1.307 and 2.1.321 on a bench, 2026-11-10 ([2.1.307](results/claude-code-2.1.307-agent-plugins-2026-11-10-09_16.json), [2.1.321](results/claude-code-2.1.321-agent-plugins-2026-11-10-09_16.json)) |
| An Agent Plugins 1.0.0 package on Codex, installed as a user installs it: every component, the version refusal, an invalid skill, inert root paths (a root `hooks/` not registered even with hook trust bypassed), literal text (§5.7, §10) | 1 | [`tier1/agent-plugins-codex.mjs`](tier1/agent-plugins-codex.mjs) | pass, Codex 0.160.0 and 0.167.0 on a bench, 2026-11-09 ([0.160.0](results/codex-0.160.0-agent-plugins-2026-11-09-21_26.json), [0.167.0](results/codex-0.167.0-agent-plugins-2026-11-09-21_26.json)) |
| An Agent Plugins 1.0.0 package on Codex from the plugin cache, enabled by one inline `-c plugins` table, with no `config.toml` write: by hand, with a dotted name, and through hs's own plan, apply and `launch-spec` (§5.7, §10) | 1 | [`tier1/agent-plugins-codex-cache.mjs`](tier1/agent-plugins-codex-cache.mjs) | pass, Codex 0.160.0 (all checks) and 0.167.0 (the route; hs plans only inside its range) on a bench, 2026-11-10 ([0.160.0](results/codex-0.160.0-agent-plugins-cache-2026-11-10-09_34.json), [0.167.0](results/codex-0.167.0-agent-plugins-cache-2026-11-10-09_34.json)) |

The two Agent Plugins checks build their packages with `lib/agent-plugins.mjs`. Checks after the first two share `lib/bench.mjs`: the guard, the scratch roots, local listeners,
the scripted model (`model()`, from [`@agent-realm/scripted-model`](../packages/scripted-model/README.md))
for a check that needs the model to answer, and launches in a process group of their own.

## Running a tier 1 check on a bench

`BENCH` is the ssh name of a disposable VM. The harness under test is installed into a scratch
directory there, so the VM's own installs and data are never touched, and no rollback is needed:

```sh
BENCH=my-bench-vm
B=$(ssh $BENCH 'mktemp -d /tmp/hs-bench-XXXX')
rsync -a --exclude .git ./ $BENCH:$B/repo/
ssh $BENCH "mkdir -p $B/cc $B/npmhome $B/npmcache; env -i PATH=\$PATH HOME=$B/npmhome npm_config_cache=$B/npmcache \
  npm install --no-audit --no-fund --prefix $B/cc @anthropic-ai/claude-code@2.1.307"
ssh $BENCH "cd $B/repo && env -i PATH=\$PATH HOME=$B/npmhome npm_config_cache=$B/npmcache npm ci --ignore-scripts"   # the workspace packages the checks import
ssh $BENCH "cd $B/repo && env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HS_BENCH=1 \
  node conformance/tier1/<check>.mjs --claude $B/cc/node_modules/.bin/claude --hs-rev $(git rev-parse HEAD) > $B/report.json"
scp $BENCH:$B/report.json conformance/results/<harness>-<version>-<check>-<YYYY-MM-DD-HH_MM>.json
ssh $BENCH "rm -rf $B"
```

No model is reached: the harness is pointed at a dead local port, at a local listener of the
check's own that records requests and answers 400, or at the scripted model on `127.0.0.1`, which
answers from the check's script, with a dummy key, and every login variable is unset. The
listeners and the scripted model record names only, never a prompt, a tool's output or a
credential's value. Each launch runs in a process group of its own, which is killed and waited for before the
scratch directory goes. A report's verdict is `pass`, `fail`, or `inconclusive` when a positive
control did not show the effect (exit 0, 1, 3; 4 when the check could not run). The bench copy
carries no `.git`, so the hs commit is passed with `--hs-rev` and recorded in the report. A report
is named by the time of its run in UTC, its `at` field.
