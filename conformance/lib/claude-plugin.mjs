// A package in Claude Code's own plugin format, the .claude-plugin layout [CC §10], for the tier 1
// checks (design note v0.2 §5.7, §10), with markers a listener can find in a request and probes that
// show which of its components ran. Laid out as the manifest reference's standard layout gives it
// (https://code.claude.com/docs/en/plugins/manifest-reference, fetched 2026-11-12):
//   .claude-plugin/plugin.json   name, version, description (left out with `noManifest`)
//   skills/notes/                a skill, its description carrying `marks.skill`
//   commands/hs-bench-hello.md   a command, its description carrying `marks.command`
//   hooks/hooks.json             a SessionStart hook that creates `hookProbe`
//   .mcp.json                    one stdio server, `probe`, started from ${CLAUDE_PLUGIN_ROOT}, with
//                                PLUGIN_ROOT and PLUGIN_DATA set to the plugin's own variables, so
//                                the server can tell whether it runs from the plugin root
//   bin/hs-probe, server.mjs     the server: a /bin/sh wrapper that execs this Node, and the script

import fs from 'node:fs';
import path from 'node:path';
import { serverSource } from './agent-plugins.mjs';

// `manifest` adds fields to plugin.json (`defaultEnabled: false`, say).
export function writeNativePackage(dir, { name, marks, tool, probeOut, hookProbe, noManifest = false, manifest = {} }) {
  const put = (rel, content, mode) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n', mode ? { mode } : undefined);
  };
  if (!noManifest) put('.claude-plugin/plugin.json', { name, version: '1.0.0', description: 'A tier 1 bench plugin in Claude Code\'s own format.', ...manifest });
  put('skills/notes/SKILL.md', `---\nname: notes\ndescription: Take bench notes. ${marks.skill}\n---\nWrite the notes.\n`);
  put('commands/hs-bench-hello.md', `---\ndescription: A bench command. ${marks.command}\n---\nSay hello.\n`);
  put('hooks/hooks.json', { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${hookProbe}'` }] }] } });
  put('.mcp.json', { mcpServers: { probe: {
    command: '${CLAUDE_PLUGIN_ROOT}/bin/hs-probe',
    args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'],
    env: { HS_PROBE_OUT: probeOut, HS_DATA_DIR: '${CLAUDE_PLUGIN_DATA}', PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}', PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' },
  } } });
  put('server.mjs', serverSource(tool, marks.tool));
  put('bin/hs-probe', `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, 0o755);
  return dir;
}
