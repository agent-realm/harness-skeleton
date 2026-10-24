#!/bin/sh
# Example 01: what an adapter says about itself and a harness, before touching any folder.
. "$(dirname "$0")/../lib.sh"

echo "== describe: the protocol, the operations, the harness descriptor"
hs describe --harness claude-code | json result.operations

echo "== detect: is the harness there, which version, inside which range"
hs detect --harness claude-code --bin "$BIN/claude" | json result
