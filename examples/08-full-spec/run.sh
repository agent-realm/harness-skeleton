#!/bin/sh
# Example 08: two layers and local.toml with every kind of item, validated, then launched.
. "$(dirname "$0")/../lib.sh"
HERE=$(cd "$(dirname "$0")" && pwd)
L="--layer $HERE/base --layer $HERE/team --local $HERE/local.toml"

F="$WORK/claude-data"
mkdir -p "$F"
printf '{}\n' > "$F/settings.json"

echo "== validate: which layer set each item"
hs validate --harness claude-code $L > "$WORK/valid.json"
json result.items < "$WORK/valid.json"
json result.removed < "$WORK/valid.json"

echo "== launch-spec: refused until a receipt allows what runs code or sends data"
hs launch-spec --harness claude-code --folder "$F" --bin "$BIN/claude" $L > "$WORK/refused.json" || true
json error.items < "$WORK/refused.json" > "$WORK/needs.json"
node -e 'const n=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0];for(const r of n.risks)console.log(r.item, r.risk, r.destination ?? "");require("fs").writeFileSync(process.argv[2],JSON.stringify({format:"hs-receipt/0.2",launch_digest:n.launch_digest,allows:[...new Set(n.risks.map((r)=>r.item))],by:"user"}))' "$WORK/needs.json" "$WORK/receipt.json"

echo "== with the receipt"
hs launch-spec --harness claude-code --folder "$F" --bin "$BIN/claude" $L --receipt "$WORK/receipt.json" > "$WORK/launch.json"
echo "argv:"; json result.argv < "$WORK/launch.json"
echo "references the caller resolves into the environment (never values):"
json result.env_from_refs < "$WORK/launch.json"
TEMP=$(json result.temp_dir < "$WORK/launch.json")
[ -n "$TEMP" ] && [ "$TEMP" != "null" ] && rm -rf "$TEMP"
