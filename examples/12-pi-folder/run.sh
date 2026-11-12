#!/bin/sh
# Example 12: deliver a spec into a pi folder a tool owns, launch over it, then take it out.
. "$(dirname "$0")/../lib.sh"
HERE=$(cd "$(dirname "$0")" && pwd)

F="$WORK/pi-data"
mkdir -p "$F"
printf '{\n  "theme": "dark"\n}\n' > "$F/settings.json"

echo "== plan under materialize: the operations, each with its risk"
hs plan --harness pi --folder "$F" --bin "$BIN/pi" --layer "$HERE/kit" --owner builder --mode materialize > "$WORK/plan.json"
json result.operations < "$WORK/plan.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{for(const o of JSON.parse(s))console.log(o.id, o.action, o.address_id, o.risk.join(",")||"-")})'

echo "== apply, under the user's receipt"
plan_receipt < "$WORK/plan.json" > "$WORK/receipt.json"
hs apply --harness pi --folder "$F" --bin "$BIN/pi" --plan "$WORK/plan.json" --receipt "$WORK/receipt.json" > /dev/null
echo "settings.json now, the user's key kept:"; cat "$F/settings.json"
echo "mcp.json's servers:"; json mcpServers < "$F/mcp.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{for(const [k,v] of Object.entries(JSON.parse(s)))console.log("-", k, "exposure", v.exposure)})'
echo "skills:"; ls "$F/skills"

echo "== a launch for the same spec skips what the plan installed"
hs launch-spec --harness pi --folder "$F" --bin "$BIN/pi" --headless --layer "$HERE/kit" > "$WORK/launch.json"
json result.skipped < "$WORK/launch.json" | lines item

echo "== remove: the owner's items go, and the user's own key stays"
hs remove --harness pi --folder "$F" --bin "$BIN/pi" --owner builder > /dev/null
cat "$F/settings.json"
