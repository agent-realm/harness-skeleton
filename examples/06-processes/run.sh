#!/bin/sh
# Example 06: processes (an MCP server, a hook, a status line) at launch, under one receipt.
. "$(dirname "$0")/../lib.sh"
HERE=$(cd "$(dirname "$0")" && pwd)

F="$WORK/claude-data"
mkdir -p "$F"
printf '{}\n' > "$F/settings.json"
: > "$WORK/local.toml"

echo "== validate: the items, and the digest that covers every file a process names"
hs validate --harness claude-code --layer "$HERE/tools" --local "$WORK/local.toml" > "$WORK/valid.json"
json result.items < "$WORK/valid.json"
json result.digest < "$WORK/valid.json"

echo "== launch-spec: each process runs code, and the refusal lists what to allow"
hs launch-spec --harness claude-code --folder "$F" --bin "$BIN/claude" \
  --layer "$HERE/tools" --local "$WORK/local.toml" > "$WORK/refused.json" || true
json error.items < "$WORK/refused.json" > "$WORK/needs.json"
node -e 'const n=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0];for(const r of n.risks)console.log(r.item, r.risk);require("fs").writeFileSync(process.argv[2],JSON.stringify({format:"hs-receipt/0.2",launch_digest:n.launch_digest,allows:[...new Set(n.risks.map((r)=>r.item))],by:"user"}))' "$WORK/needs.json" "$WORK/receipt.json"

echo "== with the receipt: the overlay files"
hs launch-spec --harness claude-code --folder "$F" --bin "$BIN/claude" \
  --layer "$HERE/tools" --local "$WORK/local.toml" --receipt "$WORK/receipt.json" > "$WORK/launch.json"
json result.argv < "$WORK/launch.json"
json result.launch_items < "$WORK/launch.json"
TEMP=$(json result.temp_dir < "$WORK/launch.json")
[ -n "$TEMP" ] && [ "$TEMP" != "null" ] && rm -rf "$TEMP"
