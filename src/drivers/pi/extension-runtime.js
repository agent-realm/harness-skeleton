// The launch extension for pi (design note v0.2 §7.5, milestone 8.1): a module pi loads with -e and
// awaits before startup continues. It registers the endpoint's provider and the spec's MCP servers
// for this session only, so nothing is written into the folder [P15:extensions, P15:custom-provider,
// P15:mcp]. A launch writes this file into its temp dir with its configuration in place of the
// marker below, as JSON of one whole object (src/drivers/pi/extension.js): every spec value is data
// in that object, never code. It imports nothing.

const CONFIG = /* hs:config */ null;

export default function (pi) {
  if (CONFIG.provider) pi.registerProvider(CONFIG.provider.id, CONFIG.provider.config);
  for (const [name, config] of CONFIG.mcp) pi.registerMcpServer(name, config);
}
