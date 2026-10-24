#!/bin/sh
# Example 07: list a data folder's sessions and read one transcript, without changing anything.
. "$(dirname "$0")/../lib.sh"

# A data folder holding one synthetic session, copied from the session adapters' fixtures.
F="$WORK/claude-data"
mkdir -p "$F"
cp -R "$EXAMPLES/../packages/session-adapters/fixtures/claude-code/basic/store/projects" "$F/"

echo "== sessions.list"
hs sessions.list --harness claude-code --folder "$F" > "$WORK/list.json"
json result.sessions < "$WORK/list.json" | head -24

echo "== sessions.read: the main transcript, from the start"
node -e '
const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result;
const s = l.sessions[0];
const session = { ...l.store, session_id: s.session_id, incarnation: s.incarnation };
const source_key = s.sources.find((x) => x.role === "main").source_key;
console.log(JSON.stringify({ protocol: "hs/0.2", request_id: "read-1", op: "sessions.read",
  args: { harness: "claude-code", harness_path: process.argv[2], session, source_key } }));
' "$WORK/list.json" "$F" > "$WORK/read-request.json"
hs < "$WORK/read-request.json" > "$WORK/read.json"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).result;console.log("continuity:", r.continuity, "units:", r.units.length, "more:", r.more)' "$WORK/read.json"
