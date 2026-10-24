#!/bin/sh
# Example 03: a spec layer and the install-local layer, resolved and validated.
. "$(dirname "$0")/../lib.sh"
HERE=$(cd "$(dirname "$0")" && pwd)

echo "== validate: a team layer and this machine's local.toml"
hs validate --harness claude-code --layer "$HERE/team" --local "$HERE/local.toml" > "$WORK/valid.json"
json result.valid < "$WORK/valid.json"
json result.items < "$WORK/valid.json"
json result.files < "$WORK/valid.json"

echo "== validate a layer whose server uses a secret no layer declares"
hs validate --harness claude-code --layer "$HERE/broken" --local "$HERE/local.toml" > "$WORK/broken.json" || true
json result.problems < "$WORK/broken.json"
