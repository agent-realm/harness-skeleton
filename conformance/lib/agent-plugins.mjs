// Agent Plugins packages for the tier 1 checks (design note v0.2 §5.7, §10): built from the
// published 1.0.0 schemas (https://agent-plugins.org/schemas/1.0.0/plugin.schema.json and
// mcp.schema.json), with markers a listener can find in a request. No hs code delivers plugins yet,
// so the checks build by hand what a driver will deliver.

import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = (v, kind) => `https://agent-plugins.org/schemas/${v}/${kind}.schema.json`;

// A minimal stdio MCP server: newline-delimited JSON-RPC, one tool. On start it writes to
// HS_PROBE_OUT what it can tell about its own launch, as booleans, never a value: whether its
// script path reached it absolute (so the placeholder in `args` was expanded), whether the data
// placeholder in `env` was expanded, which plugin variables its environment holds, whether it runs
// in the plugin root, and whether HS_LITERAL (when the package sets it) reached it unexpanded.
export function serverSource(tool, mark) {
  return `import fs from 'node:fs';
import path from 'node:path';
const env = process.env;
fs.writeFileSync(env.HS_PROBE_OUT, JSON.stringify({
  started: true,
  args_expanded: path.isAbsolute(process.argv[1] ?? '') && !String(process.argv[1]).includes('\${'),
  data_expanded: typeof env.HS_DATA_DIR === 'string' && path.isAbsolute(env.HS_DATA_DIR) && !env.HS_DATA_DIR.includes('\${'),
  env_names: ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA'].filter((k) => env[k] !== undefined),
  cwd_is_root: fs.realpathSync(process.cwd()) === fs.realpathSync(path.dirname(process.argv[1] ?? '.')),
  literal_kept: env.HS_LITERAL === undefined ? null : env.HS_LITERAL === '\${HS_BENCH_OTHER}',
}));
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hs-bench', version: '1.0.0' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: ${JSON.stringify(tool)}, description: ${JSON.stringify(`A bench tool. ${mark}`)}, inputSchema: { type: 'object', properties: {} } }] } });
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
`;
}

// One package in the Agent Plugins layout, at `dir`:
//   plugin.json          $schema for `version`, name
//   skills/notes/        a valid skill, its description carrying `marks.skill`
//   skills/no-desc/      (with `marks.invalid`) a skill without the required description; its
//                        body's first paragraph carries the marker, so a harness that loads it
//                        anyway shows it
//   mcp.json             one stdio server, `probe`: command `node`, args ["${PLUGIN_ROOT}/server.mjs"],
//                        env { HS_PROBE_OUT, HS_DATA_DIR = "${PLUGIN_DATA}" }, plus `env` given;
//                        plus any `servers` given (a remote one, say)
// plugin.json carries every metadata field of the format (§5.4), so a translation shows it keeps them.
// Two packages built with the same arguments and different `version`s differ only in the two
// `$schema` values.
//   server.mjs
export function writePackage(dir, { name, version = '1.0.0', marks, tool, probeOut, env = {}, servers = {} }) {
  fs.mkdirSync(path.join(dir, 'skills', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ $schema: SCHEMA(version, 'plugin'), name, version: '1.0.0', description: 'A tier 1 bench package.', author: { name: 'bench', url: 'https://example.com' }, homepage: 'https://example.com/plugin', repository: 'https://example.com/plugin.git', license: 'Apache-2.0', keywords: ['bench'] }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'skills', 'notes', 'SKILL.md'), `---\nname: notes\ndescription: Take bench notes. ${marks.skill}\n---\nWrite the notes.\n`);
  if (marks.invalid) {
    fs.mkdirSync(path.join(dir, 'skills', 'no-desc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'no-desc', 'SKILL.md'), `---\nname: no-desc\n---\nA skill without a description. ${marks.invalid}\n`);
  }
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
    $schema: SCHEMA(version, 'mcp'),
    mcpServers: { probe: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server.mjs'], env: { HS_PROBE_OUT: probeOut, HS_DATA_DIR: '${PLUGIN_DATA}', ...env } }, ...servers },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'server.mjs'), serverSource(tool, marks.tool));
  return dir;
}

// What the server wrote when it started, or null when it never started.
export function probe(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// The literal-text control (design note v0.2 §10): text the format never expands, in a stdio
// server's env and in a remote server's header, with the variable it names set in the harness's
// environment to OTHER_VALUE. A listener with LITERAL_MARKERS shows which form reached it.
export const OTHER = 'HS_BENCH_OTHER';
export const OTHER_VALUE = 'hs-bench-other-set-9f4c';
export const LITERAL_MARKERS = ['${HS_BENCH_OTHER}', OTHER_VALUE];
export const literalOpts = (remoteUrl) => ({
  env: { HS_LITERAL: '${HS_BENCH_OTHER}' },
  servers: { remote: { type: 'streamable-http', url: remoteUrl, headers: { 'X-HS-Literal': '${HS_BENCH_OTHER}' } } },
});
