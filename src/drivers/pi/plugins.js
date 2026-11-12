// Agent Plugins packages on pi (design note v0.2 §5.7, milestone 8.4). pi reads no Agent Plugins
// package; its own bundle is the pi package, so a package is translated into one (descriptor,
// plugins['agent-plugins']):
//   package.json   a `pi` manifest declaring only ./package/skills and the extension below, and
//                  nothing else, so the package's own conventional directories stay inert
//   hs-plugin.js   the extension that registers the package's MCP servers (plugin-runtime.js, its
//                  configuration JSON.stringify of one whole object)
//   package/       the package, copied whole and checked against its digest
// At launch the tree goes into the temp dir, passed with -e; under materialize it is hs-run/
// plugin.<name>/, named in settings.json `packages`. validate has refused what pi would not keep as
// the format says ($ or a leading ! in env, headers or url; a leading ~ in command, args or cwd).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HsError } from '../../protocol.js';
import { generatedDigest, handlers, treeLink } from '../../native.js';
import { digestOf, readLedger } from '../../records.js';
import { AGENT_PLUGINS, PLACEHOLDERS, cwdPlace, inRoot, readPackage } from '../../spec/agent-plugins.js';

const RUNTIME = fileURLToPath(new URL('./plugin-runtime.js', import.meta.url));
const MARKER = '/* hs:config */ null';
const [ROOT, DATA] = PLACEHOLDERS;

// The extension's source: the runtime with the configuration written in place of its marker, by a
// function, so no `$` in a value is read as a replacement pattern. JSON is a JavaScript expression,
// so nothing in it is code.
function extensionSource(config) {
  const text = fs.readFileSync(RUNTIME, 'utf8');
  if (text.split(MARKER).length !== 2) throw new HsError('internal', 'the plugin runtime does not hold its configuration marker exactly once', []);
  return text.replace(MARKER, () => JSON.stringify(config));
}

// The generated pi package for one item: its files, its one entry (the package), its risks, the
// server ids it registers, and how it is carried.
export function translatedPackage(item, bound, descriptor) {
  const R = descriptor.plugins[AGENT_PLUGINS];
  const T = R.translation;
  const name = item.id.slice('plugin.'.length);
  const link = treeLink(bound.path);
  if (link !== null) throw new HsError('write_refused', `${item.id}: the package holds a symlink (${link}); hs copies no tree with one`, [item.id]);
  const pkg = readPackage(bound.path);
  const servers = [];
  const risks = [];
  for (const [server, s] of Object.entries(pkg.mcp?.mcpServers ?? {})) {
    const id = T.server_id(name, server);
    if (!descriptor.launch.mcp.id.test(id)) throw new HsError('item_unsupported', `${item.id}: server ${JSON.stringify(server)}: pi names a server by letters, digits, _ and -, and ${JSON.stringify(id)} is not such a name`, [item.id]);
    if (T.unsupported_types[s.type]) throw new HsError('item_unsupported', `${item.id}: server ${JSON.stringify(server)}: ${T.unsupported_types[s.type]}`, [item.id]);
    if (s.type === 'stdio') {
      const rel = s.command.startsWith('./') ? inRoot(s.command) : null;
      servers.push({ id, type: 'stdio', command: rel === null ? s.command : { rel }, args: s.args ?? [], env: s.env ?? {}, cwd: cwdPlace(s.cwd) });
    } else {
      servers.push({ id, type: 'http', url: s.url, ...(s.headers ? { headers: { ...s.headers } } : {}) });
      risks.push({ item: item.id, layer: item.layer, risk: 'sends-data', server, destination: s.url });
    }
  }
  const hasSkills = pkg.skills.length > 0;
  const stdio = servers.filter((s) => s.type === 'stdio').length;
  // Skills may carry scripts the agent is told to run, and a stdio server is code: the package is
  // runs-code, bound by its digest. Each remote server sends data to its destination.
  if (hasSkills || stdio) risks.unshift({ item: item.id, layer: item.layer, risk: 'runs-code', sha256: bound.sha256 });
  const manifest = {
    name: `hs-plugin-${name}`, version: '0.0.0', private: true,
    pi: { skills: hasSkills ? [`./${T.nest}/skills`] : [], extensions: servers.length ? [`./${T.extension}`] : [], prompts: [], themes: [] },
  };
  const files = [{ rel: T.manifest, content: JSON.stringify(manifest, null, 2) + '\n' }];
  if (servers.length) {
    files.push({ rel: T.extension, content: extensionSource({ name, nest: T.nest, data_dir: T.data_dir, root_var: ROOT, data_var: DATA, exposure: T.exposure, servers }) });
  }
  const parts = [hasSkills ? `${pkg.skills.length} skill(s)` : null, servers.length ? `${servers.length} MCP server(s), as ${servers.map((s) => s.id).join(', ')}` : null].filter(Boolean);
  return {
    tree: { name: `${T.tree_prefix}${name}`, role: item.id, files, entries: [{ rel: T.nest, source: bound.path, sha256: bound.sha256 }] },
    risks, servers: servers.map((s) => s.id), stdio,
    via: `Agent Plugins ${pkg.version} translated into a pi package, the package nested under ${T.nest}/, only its skills and hs's extension declared${parts.length ? `: ${parts.join('; ')}` : ''}`,
  };
}

// Where a plan puts the item: the generated tree under hs-run/, and its member of settings.json
// `packages`, the exact string naming the tree relative to the folder.
export function persistedPackage(item, bound, folder, descriptor) {
  const R = descriptor.plugins[AGENT_PLUGINS];
  const t = translatedPackage(item, bound, descriptor);
  const address = `${descriptor.persist.root}/${t.tree.name}`;
  return {
    ...t, address,
    generated: { generated: { files: t.tree.files, entries: t.tree.entries } },
    element: { file: descriptor.persist.settings_file, key: R.persist.packages_key, id: t.tree.name, value: `./${address}` },
    data: path.join(folder, descriptor.persist.root, R.translation.data_dir, item.id.slice('plugin.'.length)),
  };
}

// Whether a plan installed the item at exactly what the spec says now: the tree and the member, as
// the ledger recorded them.
export function installedPackage(item, bound, folder, descriptor) {
  let p;
  try {
    p = persistedPackage(item, bound, folder, descriptor);
  } catch {
    return false;
  }
  const ledger = readLedger(folder);
  const held = (addr, want, current) => {
    const entry = ledger.addresses[addr];
    return entry !== undefined && Object.values(entry.owners).some((o) => o.installed === want) && current === want;
  };
  const e = p.element;
  const cur = handlers['json-element'].current(folder, descriptor, { file: e.file, key: e.key, id: e.id });
  return held(p.address, generatedDigest(p.generated), handlers.tree.current(folder, descriptor, { path: p.address }).digest)
    && held(`${e.file}#${e.key}[${e.id}]`, digestOf(e.value), cur.digest);
}

// Where the folder holds the item at other content, or null: a ledger entry for its tree, its tree
// there, or its member in settings.json `packages`.
export function heldElsewhere(item, bound, folder, descriptor) {
  let p;
  try {
    p = persistedPackage(item, bound, folder, descriptor);
  } catch {
    return null;
  }
  if (readLedger(folder).addresses[p.address] || fs.existsSync(path.join(folder, p.address))) return p.address;
  const e = p.element;
  const cur = handlers['json-element'].current(folder, descriptor, { file: e.file, key: e.key, id: e.id });
  if (cur.blocked) return `${e.file}#${e.key} (${cur.blocked})`;
  return cur.present ? `${e.file}#${e.key} (${e.value})` : null;
}
