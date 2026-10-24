# First steps

In a quarter of an hour you will:
- read what `hs` and a harness offer;
- look inside a data folder;
- validate a spec layer;
- deliver it into a scratch folder, and take it out again.

Nothing here touches your own harness or its data: every step uses a scratch folder and the
stand-in harness binaries in `examples/bin/`.

## 1. Install

Node.js 22 or later. From a checkout:

```sh
npm ci --ignore-scripts
node bin/hs.js describe --harness claude-code --pretty | head -30
```

`hs` has one dependency, `smol-toml`, pinned in `package-lock.json`. Below, `hs` means
`node bin/hs.js`:

```sh
alias hs='node bin/hs.js'
```

## 2. Find a harness

```sh
hs detect --harness claude-code --bin examples/bin/claude --pretty
```

`detect` runs the binary with `--version` in a scratch environment and reports the version and
its range. A version in the `certified` range runs everything. In the `compatible` range writes
run with a warning, and outside both, writes are refused. With a real `claude` on your PATH,
leave out `--bin`.

## 3. Look inside a data folder

A **data folder** is where a harness keeps its user-scope configuration and state: for Claude
Code, the directory `CLAUDE_CONFIG_DIR` names (`~/.claude` by default). Make a scratch one:

```sh
mkdir -p /tmp/hs-tour/claude-data/skills/demo
echo '{"theme": "dark"}' > /tmp/hs-tour/claude-data/settings.json
printf -- '---\nname: demo\ndescription: A demo.\n---\nSay hello.\n' > /tmp/hs-tour/claude-data/skills/demo/SKILL.md
hs observe --harness claude-code --folder /tmp/hs-tour/claude-data --state --pretty
```

`observe --state` lists every path by class (`config`, `sessions`, `history`, `credentials`, …),
and the transcript retention in effect with its source. It writes nothing. You may point it at
your real folder: it only reads.

## 4. Validate a layer

A **spec** is a stack of **layers**, lowest first, and `local.toml` is always last.
`examples/03-validate-a-layer/team/` is one layer: a `spec.toml` that sets the primary model,
and one skill.

```sh
hs validate --harness claude-code \
  --layer examples/03-validate-a-layer/team --local examples/03-validate-a-layer/local.toml --pretty
```

`valid: true`, the items with the layer that set each one, the skill's digest and the spec's
digest. A problem would come back with a code (see [errors](../reference/errors.md)).

## 5. Deliver it, and take it out

Under the `materialize` mode, `hs` writes the spec into a folder a tool owns. First a plan:

```sh
hs plan --harness claude-code --folder /tmp/hs-tour/claude-data --bin examples/bin/claude \
  --layer examples/03-validate-a-layer/team --local examples/03-validate-a-layer/local.toml \
  --owner tour > /tmp/hs-tour/plan.json
```

The plan lists operations: `settings.json#model`, `settings.json#cleanupPeriodDays` and the tree
`skills/notes`. The skill is tagged `runs-code`, so it needs your approval: a **receipt** naming
the plan's digest and the operations you allow. Read the digest and the risky operations' ids
from the plan (`result.digest`, `result.operations[].id` where `risk` is not empty), then:

```sh
cat > /tmp/hs-tour/receipt.json <<'EOF'
{"format": "hs-receipt/0.2", "plan_digest": "sha256:<the plan's digest>", "allows": ["op-2"], "by": "me"}
EOF
hs apply --harness claude-code --folder /tmp/hs-tour/claude-data --bin examples/bin/claude \
  --plan /tmp/hs-tour/plan.json --receipt /tmp/hs-tour/receipt.json
cat /tmp/hs-tour/claude-data/settings.json
```

Your `theme` is still there, beside the two keys the plan added, and `skills/notes` now exists.
Take it all out again:

```sh
hs remove --harness claude-code --folder /tmp/hs-tour/claude-data --bin examples/bin/claude --owner tour
cat /tmp/hs-tour/claude-data/settings.json
rm -rf /tmp/hs-tour
```

[Example 05](../../examples/05-materialize/) does the same in one script, reading the digest
for you.

## Where next

- [Launch with an overlay](../guides/launch-with-an-overlay.md), which writes nothing into the folder.
- [Write a spec](../guides/write-a-spec.md) with MCP servers, hooks and secrets.
- The [examples](../../examples/), up to a full spec.
