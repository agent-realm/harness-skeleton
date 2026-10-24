#!/bin/sh
# Example 02: read a data folder without changing it.
. "$(dirname "$0")/../lib.sh"

# A small Claude Code data folder of our own: settings, one skill, one transcript.
F="$WORK/claude-data"
mkdir -p "$F/skills/demo" "$F/projects/-work-repo"
printf '{"model": "sonnet"}\n' > "$F/settings.json"
printf -- '---\nname: demo\ndescription: A demo skill.\n---\nSay hello.\n' > "$F/skills/demo/SKILL.md"
printf '{"type":"user"}\n' > "$F/projects/-work-repo/0000.jsonl"

echo "== observe --state: every path by class, and the retention in effect with its source"
hs observe --harness claude-code --folder "$F" --state > "$WORK/observe.json"
json result.inventory.classes.config < "$WORK/observe.json" | head -20
echo "..."
json result.state < "$WORK/observe.json"
