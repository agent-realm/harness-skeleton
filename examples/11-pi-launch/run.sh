#!/bin/sh
# Example 11: pi at launch: the endpoint, a skill, AGENTS.md and a hook, through one generated
# extension; the session kept in the folder for the directory pi runs in; then strict isolation.
. "$(dirname "$0")/../lib.sh"
HERE=$(cd "$(dirname "$0")" && pwd)

F="$WORK/pi-data"
mkdir -p "$F"
PROJECT="$WORK/project"
mkdir -p "$PROJECT"

echo "== describe: what reaches a launch that the spec did not name, and what closes it"
hs describe --harness pi > "$WORK/describe.json"
json result.known_limits < "$WORK/describe.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{for(const k of JSON.parse(s))console.log("-", k.path, k.strict ? "(strict closes it)" : k.closed_by ? "(closed by launch-spec --cwd)" : "")})'

echo "== launch-spec with --cwd: the skill and the hook run code, so it needs a receipt"
hs launch-spec --harness pi --folder "$F" --bin "$BIN/pi" --headless --cwd "$PROJECT" \
  --layer "$HERE/kit" --local "$HERE/local.toml" > "$WORK/refused.json" || true
json error.code < "$WORK/refused.json"
launch_receipt < "$WORK/refused.json" > "$WORK/receipt.json"
hs launch-spec --harness pi --folder "$F" --bin "$BIN/pi" --headless --cwd "$PROJECT" \
  --layer "$HERE/kit" --local "$HERE/local.toml" --receipt "$WORK/receipt.json" > "$WORK/launch.json"
echo "argv flags:"; json result.argv < "$WORK/launch.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>console.log(JSON.parse(s).filter((a)=>a.startsWith("-")).join(" ")))'
echo "what each item rides on:"; json result.launch_items < "$WORK/launch.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{for(const i of JSON.parse(s))console.log("-", i.item)})'
json result.readiness < "$WORK/launch.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{for(const r of JSON.parse(s))console.log(`the ${r.what} are active once ${require("node:path").basename(r.path)} exists in the temp dir`)})'
TEMP=$(json result.temp_dir < "$WORK/launch.json")
[ -n "$TEMP" ] && [ "$TEMP" != "null" ] && rm -rf "$TEMP"

echo "== the same spec with strict isolation"
hs launch-spec --harness pi --folder "$F" --bin "$BIN/pi" --headless --cwd "$PROJECT" \
  --layer "$HERE/kit" --layer "$HERE/strict" --local "$HERE/local.toml" > "$WORK/refused-strict.json" || true
launch_receipt < "$WORK/refused-strict.json" > "$WORK/receipt-strict.json"
hs launch-spec --harness pi --folder "$F" --bin "$BIN/pi" --headless --cwd "$PROJECT" \
  --layer "$HERE/kit" --layer "$HERE/strict" --local "$HERE/local.toml" --receipt "$WORK/receipt-strict.json" > "$WORK/strict.json"
echo "argv flags:"; json result.argv < "$WORK/strict.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>console.log(JSON.parse(s).filter((a)=>a.startsWith("--no-")).join(" ")))'
TEMP=$(json result.temp_dir < "$WORK/strict.json")
[ -n "$TEMP" ] && [ "$TEMP" != "null" ] && rm -rf "$TEMP"

echo "== strict refuses a folder holding what no switch keeps out, naming it"
printf 'A system prompt of the folder'"'"'s own.\n' > "$F/SYSTEM.md"
hs launch-spec --harness pi --folder "$F" --bin "$BIN/pi" --headless \
  --layer "$HERE/kit" --layer "$HERE/strict" --local "$HERE/local.toml" > "$WORK/unmet.json" || true
json error.code < "$WORK/unmet.json"
json error.items < "$WORK/unmet.json" | lines
rm "$F/SYSTEM.md"
echo "== the folder is still empty: a launch writes nothing into it"; ls -A "$F"
