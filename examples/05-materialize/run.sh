#!/bin/sh
# Example 05: deliver the spec into a data folder a tool owns, then take it out again.
. "$(dirname "$0")/../lib.sh"
TEAM=$(cd "$(dirname "$0")/../03-validate-a-layer" && pwd)

F="$WORK/claude-data"
mkdir -p "$F"
printf '{\n  "theme": "dark"\n}\n' > "$F/settings.json"

echo "== plan: the operations, each with its risk"
hs plan --harness claude-code --folder "$F" --bin "$BIN/claude" \
  --layer "$TEAM/team" --local "$TEAM/local.toml" --owner builder > "$WORK/plan.json"
json result.operations < "$WORK/plan.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{for(const o of JSON.parse(s))console.log(o.id, o.action, o.address_id, o.risk.join(",")||"-")})'

echo "== the user allows the risky operations: a receipt for the plan's digest"
DIGEST=$(json result.digest < "$WORK/plan.json")
RISKY=$(json result.operations < "$WORK/plan.json" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>console.log(JSON.stringify(JSON.parse(s).filter((o)=>o.risk.length).map((o)=>o.id))))')
printf '{"format":"hs-receipt/0.2","plan_digest":"%s","allows":%s,"by":"user"}\n' "$DIGEST" "$RISKY" > "$WORK/receipt.json"

echo "== apply"
hs apply --harness claude-code --folder "$F" --bin "$BIN/claude" --plan "$WORK/plan.json" --receipt "$WORK/receipt.json" > "$WORK/apply.json"
json result.operations < "$WORK/apply.json"
echo "settings.json now:"; cat "$F/settings.json"
echo "skills:"; ls "$F/skills"

echo "== a second plan has nothing to do"
hs plan --harness claude-code --folder "$F" --bin "$BIN/claude" \
  --layer "$TEAM/team" --local "$TEAM/local.toml" --owner builder | json result.unchanged

echo "== remove: the owner's items go, and the user's own key stays"
hs remove --harness claude-code --folder "$F" --bin "$BIN/claude" --owner builder > /dev/null
cat "$F/settings.json"
