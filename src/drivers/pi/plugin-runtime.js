// The extension hs generates for one Agent Plugins package translated into a pi package (design note
// v0.2 §5.7; src/drivers/pi/plugins.js), with the package's configuration written in place of the
// marker below. It registers the package's MCP servers for the session. The plugin root and data
// directory are worked out from where this file sits, so the same file serves a launch (the temp
// dir) and a plan (hs-run/): the root is <here>/package, the data <here>/../plugin-data/<name>.
//
// The configuration names each server as validate accepted it: a stdio server's command (as given,
// or { rel } under the root for a ./ path), args and env with the two placeholders still in them,
// and its working directory as { base, rel }; a remote server's url and headers.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = /* hs:config */ null;

export default function (pi) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, CONFIG.nest);
  const data = path.join(here, '..', CONFIG.data_dir, CONFIG.name);
  // pi expands $ and runs a leading ! in a server's env: a path holding either is never handed to it
  // (launch-spec and plan refuse such a place before this runs).
  if ([root, data].some((p) => p.includes('$') || p.trimStart().startsWith('!'))) {
    throw new Error(`harness-skeleton: plugin ${CONFIG.name}: its path holds $ or a leading !, which pi would expand or run; its servers are not registered`);
  }
  const swap = (v) => v.split(CONFIG.root_var).join(root).split(CONFIG.data_var).join(data);
  if (CONFIG.servers.some((s) => s.type === 'stdio')) mkdirSync(data, { recursive: true, mode: 0o700 });
  for (const s of CONFIG.servers) {
    if (s.type !== 'stdio') {
      pi.registerMcpServer(s.id, { url: s.url, ...(s.headers ? { headers: s.headers } : {}), exposure: CONFIG.exposure });
      continue;
    }
    const command = typeof s.command === 'string' ? s.command : path.join(root, s.command.rel);
    const env = { ...Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, swap(v)])), PLUGIN_ROOT: root, PLUGIN_DATA: data };
    const cwd = path.join(s.cwd.base === 'data' ? data : root, s.cwd.rel);
    pi.registerMcpServer(s.id, { command, args: s.args.map(swap), env, cwd, exposure: CONFIG.exposure });
  }
}
