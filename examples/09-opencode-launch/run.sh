#!/bin/sh
# Example 09: OpenCode at launch: the endpoint, a skill and AGENTS.md; then the same spec with
# strict isolation. Nothing is written into the data folder.
. "$(dirname "$0")/../lib.sh"
HERE=$(cd "$(dirname "$0")" && pwd)

# An OpenCode data folder holds its four XDG roots.
F="$WORK/opencode-data"
mkdir -p "$F/config" "$F/data" "$F/cache" "$F/state"

echo "== describe: the folder's roots, and what reaches a launch that the spec did not name"
hs describe --harness opencode > "$WORK/describe.json"
json result.binding.folder_layout < "$WORK/describe.json"
json result.known_limits < "$WORK/describe.json" | lines path

echo "== launch-spec: the skill can run code, so it needs a receipt"
hs launch-spec --harness opencode --folder "$F" --bin "$BIN/opencode" --headless \
  --layer "$HERE/kit" --local "$HERE/local.toml" > "$WORK/refused.json" || true
json error.code < "$WORK/refused.json"
launch_receipt < "$WORK/refused.json" > "$WORK/receipt.json"
hs launch-spec --harness opencode --folder "$F" --bin "$BIN/opencode" --headless \
  --layer "$HERE/kit" --local "$HERE/local.toml" --receipt "$WORK/receipt.json" > "$WORK/launch.json"
echo "argv:"; json result.argv < "$WORK/launch.json" | lines
echo "the inline config layer names:"; json result.env_set.OPENCODE_CONFIG_CONTENT < "$WORK/launch.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>console.log(Object.keys(JSON.parse(s)).join(", ")))'
echo "the key, by reference, for the caller to fill:"; json result.env_from_refs < "$WORK/launch.json"
TEMP=$(json result.temp_dir < "$WORK/launch.json")
[ -n "$TEMP" ] && [ "$TEMP" != "null" ] && rm -rf "$TEMP"

echo "== the same spec with strict isolation: only what it names reaches the agent"
hs launch-spec --harness opencode --folder "$F" --bin "$BIN/opencode" --headless \
  --layer "$HERE/kit" --layer "$HERE/strict" --local "$HERE/local.toml" > "$WORK/refused-strict.json" || true
launch_receipt < "$WORK/refused-strict.json" > "$WORK/receipt-strict.json"
hs launch-spec --harness opencode --folder "$F" --bin "$BIN/opencode" --headless \
  --layer "$HERE/kit" --layer "$HERE/strict" --local "$HERE/local.toml" --receipt "$WORK/receipt-strict.json" > "$WORK/strict.json"
echo "OPENCODE_DISABLE_PROJECT_CONFIG=$(json result.env_set.OPENCODE_DISABLE_PROJECT_CONFIG < "$WORK/strict.json")"
echo "skill permissions:"; json result.env_set.OPENCODE_CONFIG_CONTENT < "$WORK/strict.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{for(const p of JSON.parse(s).permissions)console.log(" ", p.effect, p.resource)})'
json result.launch_items < "$WORK/strict.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>console.log("isolation:", JSON.parse(s).find((i)=>i.item==="isolation").via))'
TEMP=$(json result.temp_dir < "$WORK/strict.json")
[ -n "$TEMP" ] && [ "$TEMP" != "null" ] && rm -rf "$TEMP"

echo "== the folder is unchanged:"; ls -A "$F"
