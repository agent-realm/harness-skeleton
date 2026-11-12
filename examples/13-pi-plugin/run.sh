#!/bin/sh
# Example 13: an Agent Plugins package on pi, translated into a pi package: at launch, then into the
# folder; its data kept when the plugin is removed.
. "$(dirname "$0")/../lib.sh"
HERE=$(cd "$(dirname "$0")" && pwd)

F="$WORK/pi-data"
mkdir -p "$F"
printf '{\n  "packages": [\n    "npm:@example/the-users-own@1.0.0"\n  ]\n}\n' > "$F/settings.json"

echo "== launch-spec: the package runs code (its skill and its server), so it needs a receipt"
hs launch-spec --harness pi --folder "$F" --bin "$BIN/pi" --headless --layer "$HERE/kit" > "$WORK/refused.json" || true
launch_receipt < "$WORK/refused.json" > "$WORK/receipt.json"
hs launch-spec --harness pi --folder "$F" --bin "$BIN/pi" --headless --layer "$HERE/kit" --receipt "$WORK/receipt.json" > "$WORK/launch.json"
json result.launch_items < "$WORK/launch.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>console.log(JSON.parse(s).find((i)=>i.item==="plugin.notes-kit").via))'
TREE=$(json result.files < "$WORK/launch.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>console.log(JSON.parse(s).find((f)=>f.role==="plugin.notes-kit").path))')
echo "the generated package's manifest declares only:"; json pi < "$TREE/package.json"
TEMP=$(json result.temp_dir < "$WORK/launch.json")
[ -n "$TEMP" ] && [ "$TEMP" != "null" ] && rm -rf "$TEMP"

echo "== into the folder: the package under hs-run/, and one member of settings.json packages"
hs plan --harness pi --folder "$F" --bin "$BIN/pi" --layer "$HERE/kit" --owner builder --mode materialize > "$WORK/plan.json"
json result.operations < "$WORK/plan.json" | lines address_id
plan_receipt < "$WORK/plan.json" > "$WORK/plan-receipt.json"
hs apply --harness pi --folder "$F" --bin "$BIN/pi" --plan "$WORK/plan.json" --receipt "$WORK/plan-receipt.json" > /dev/null
cat "$F/settings.json"

echo "== the plugin's server wrote its data; remove keeps it, and says where"
mkdir -p "$F/hs-run/plugin-data/notes-kit/notes"
printf 'a note\n' > "$F/hs-run/plugin-data/notes-kit/notes/first.md"
hs remove --harness pi --folder "$F" --bin "$BIN/pi" --owner builder > "$WORK/removed.json"
json result.notes < "$WORK/removed.json" | lines
echo "settings.json, the user's own member kept:"; cat "$F/settings.json"

echo "== remove --purge-data deletes it as well"
hs plan --harness pi --folder "$F" --bin "$BIN/pi" --layer "$HERE/kit" --owner builder --mode materialize > "$WORK/plan2.json"
plan_receipt < "$WORK/plan2.json" > "$WORK/plan2-receipt.json"
hs apply --harness pi --folder "$F" --bin "$BIN/pi" --plan "$WORK/plan2.json" --receipt "$WORK/plan2-receipt.json" > /dev/null
hs remove --harness pi --folder "$F" --bin "$BIN/pi" --owner builder --purge-data > "$WORK/purged.json"
json result.notes < "$WORK/purged.json" | lines
