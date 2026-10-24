#!/bin/sh
# Example 04: a launch that carries the spec, writing nothing into the data folder.
. "$(dirname "$0")/../lib.sh"
TEAM=$(cd "$(dirname "$0")/../03-validate-a-layer" && pwd)

F="$WORK/claude-data"
mkdir -p "$F"
printf '{}\n' > "$F/settings.json"

echo "== launch-spec without a receipt: the skill can run code, so it is refused"
hs launch-spec --harness claude-code --folder "$F" --bin "$BIN/claude" \
  --layer "$TEAM/team" --local "$TEAM/local.toml" > "$WORK/refused.json" || true
json error.code < "$WORK/refused.json"
DIGEST=$(json error.items < "$WORK/refused.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>console.log(JSON.parse(s)[0].launch_digest))')

echo "== the user allows it: a receipt for that launch digest, naming the item"
printf '{"format":"hs-receipt/0.2","launch_digest":"%s","allows":["skill.notes"],"by":"user"}\n' "$DIGEST" > "$WORK/receipt.json"
hs launch-spec --harness claude-code --folder "$F" --bin "$BIN/claude" \
  --layer "$TEAM/team" --local "$TEAM/local.toml" --receipt "$WORK/receipt.json" > "$WORK/launch.json"
echo "argv:";      json result.argv < "$WORK/launch.json"
echo "env_set:";   json result.env_set < "$WORK/launch.json"
echo "env_unset:"; json result.env_unset < "$WORK/launch.json"

# The overlay's temp directory is the caller's to remove once the launch ends.
TEMP=$(json result.temp_dir < "$WORK/launch.json")
[ -n "$TEMP" ] && [ "$TEMP" != "null" ] && rm -rf "$TEMP"
echo "== the folder is unchanged:"; ls -A "$F"
