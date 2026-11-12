#!/bin/sh
# Example 10: deliver a spec into an OpenCode folder a tool owns, launch over it, then take it out.
. "$(dirname "$0")/../lib.sh"
HERE=$(cd "$(dirname "$0")" && pwd)

F="$WORK/opencode-data"
mkdir -p "$F/config/opencode" "$F/data" "$F/cache" "$F/state"
printf '{\n  "theme": "dark"\n}\n' > "$F/config/opencode/opencode.json"

echo "== plan under materialize: the operations, each with its risk"
hs plan --harness opencode --folder "$F" --bin "$BIN/opencode" --layer "$HERE/kit" --owner builder --mode materialize > "$WORK/plan.json"
json result.operations < "$WORK/plan.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{for(const o of JSON.parse(s))console.log(o.id, o.action, o.address_id, o.risk.join(",")||"-")})'

echo "== apply, under the user's receipt"
plan_receipt < "$WORK/plan.json" > "$WORK/receipt.json"
hs apply --harness opencode --folder "$F" --bin "$BIN/opencode" --plan "$WORK/plan.json" --receipt "$WORK/receipt.json" > /dev/null
echo "config/opencode/opencode.json now, the user's key kept:"; cat "$F/config/opencode/opencode.json"
echo "skills:"; ls "$F/config/opencode/skills"
echo "the server's bound copy:"; ls "$F/hs-run"

echo "== a launch for the same spec skips what the plan installed"
hs launch-spec --harness opencode --folder "$F" --bin "$BIN/opencode" --headless --layer "$HERE/kit" > "$WORK/launch.json"
json result.skipped < "$WORK/launch.json" | lines item

echo "== remove: the owner's items go, and the user's own key stays"
hs remove --harness opencode --folder "$F" --bin "$BIN/opencode" --owner builder > /dev/null
cat "$F/config/opencode/opencode.json"
