// Plugin packages on Claude Code (design note v0.2 §5.7). An Agent Plugins package is translated into
// a plugin in the .claude-plugin layout, which a launch passes with --plugin-dir. validate has
// refused what the translation cannot keep (a version it does not map, ${…} text the format keeps
// literal, a working directory beyond the root); this builds the rest. The rules and their sources
// are in the descriptor (plugins['agent-plugins']); the order here is §5.7's. A package in Claude
// Code's own format, claude-plugin, is carried as it is (nativePlugin).

import fs from 'node:fs';
import path from 'node:path';
import { HsError } from '../../protocol.js';
import { treeLink } from '../../native.js';
import { digestPath } from '../../spec/layers.js';
import { AGENT_PLUGINS, METADATA_FIELDS, PLACEHOLDERS, inRoot, readPackage } from '../../spec/agent-plugins.js';

const [ROOT, DATA] = PLACEHOLDERS;

// The plugin a launch carries for one item: a generated tree for launch-spec (its manifest, its
// .mcp.json, and the package and its skills/ copied from the layer, each checked against its
// digest), the item's launch risks, and how it is carried.
export function translatedPlugin(item, bound, descriptor) {
  const R = descriptor.plugins[AGENT_PLUGINS];
  const T = R.translation;
  const id = item.id.slice('plugin.'.length);
  const link = treeLink(bound.path);
  if (link !== null) throw new HsError('write_refused', `${item.id}: the package holds a symlink (${link}); hs copies no tree with one`, [item.id]);
  const pkg = readPackage(bound.path);
  const root = `${T.root_var}/${T.nest}`;

  // plugin.json becomes the manifest, keeping name and the metadata fields; $schema and
  // extensions are dropped.
  const manifest = { name: pkg.manifest.name };
  for (const k of METADATA_FIELDS) if (Object.hasOwn(pkg.manifest, k)) manifest[k] = pkg.manifest[k];

  // mcp.json becomes .mcp.json without its $schema. The two placeholders become Claude Code's in
  // args and env; each stdio server's env gains PLUGIN_ROOT and PLUGIN_DATA, which the format has the
  // client provide; a ./ command is given under the nested root; and the server starts through the
  // prelude, which changes to the root first.
  const swap = (v) => v.replaceAll(ROOT, root).replaceAll(DATA, T.data_var);
  const servers = {};
  const risks = [];
  let stdio = 0;
  for (const [name, s] of Object.entries(pkg.mcp?.mcpServers ?? {})) {
    if (s.type !== 'stdio') {
      servers[name] = { type: T.types[s.type], url: s.url, ...(s.headers ? { headers: { ...s.headers } } : {}) };
      risks.push({ item: item.id, layer: item.layer, risk: 'sends-data', server: name, destination: s.url });
      continue;
    }
    stdio++;
    const command = s.command.startsWith('./') ? `${root}/${inRoot(s.command)}` : s.command;
    const env = { ...Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, swap(v)])), PLUGIN_ROOT: root, PLUGIN_DATA: T.data_var };
    servers[name] = { type: T.types.stdio, command: T.prelude[0], args: [...T.prelude.slice(1), command, ...(s.args ?? []).map(swap)], env };
  }

  const skills = path.join(bound.path, 'skills');
  const hasSkills = pkg.skills.length > 0;
  const entries = [{ rel: T.nest, source: bound.path, sha256: bound.sha256 }];
  if (hasSkills) entries.push({ rel: 'skills', source: skills, sha256: digestPath(skills) });
  const files = pkg.mcp ? [{ rel: T.mcp_file, content: JSON.stringify({ mcpServers: servers }, null, 2) + '\n' }] : [];
  // Skills may carry scripts the agent is told to run, and a stdio server is code: the package is
  // runs-code, bound by its digest. Each remote server sends data to its destination.
  if (hasSkills || stdio) risks.unshift({ item: item.id, layer: item.layer, risk: 'runs-code', sha256: bound.sha256 });

  const parts = [
    hasSkills ? `skills as /${id}:<skill>` : null,
    Object.keys(servers).length ? `${Object.keys(servers).length} MCP server(s)${stdio ? ', each stdio one started in the plugin root through a /bin/sh prelude (bridged)' : ''}` : null,
  ].filter(Boolean);
  return {
    tree: {
      name: `plugins/${id}`, role: item.id,
      manifest: { rel: T.manifest, content: JSON.stringify(manifest, null, 2) + '\n' },
      files, entries,
    },
    risks,
    via: `${descriptor.launch.plugin.flag}, Agent Plugins ${pkg.version} translated to the .claude-plugin layout, the package nested under ${T.nest}/${parts.length ? `: ${parts.join('; ')}` : ''}`,
  };
}

// A package in Claude Code's own format (§5.7): the plugin a launch carries is the package itself,
// copied whole and checked against its digest, with no manifest of hs's making. validate has checked
// its name and refused the fields that would bring in what the spec does not bind. What it holds runs
// as Claude Code runs a plugin, which hs does not inspect: the package is runs-code, bound by its
// digest.
export function nativePlugin(item, bound, descriptor) {
  const R = descriptor.plugins[item.value.format];
  const link = treeLink(bound.path);
  if (link !== null) throw new HsError('write_refused', `${item.id}: the package holds a symlink (${link}); hs copies no tree with one`, [item.id]);
  return {
    tree: { name: `plugins/${item.id.slice('plugin.'.length)}`, role: item.id, files: [], entries: [{ rel: '.', source: bound.path, sha256: bound.sha256 }] },
    risks: [{ item: item.id, layer: item.layer, risk: 'runs-code', sha256: bound.sha256 }],
    via: `${descriptor.launch.plugin.flag}, the package ${R.delivered_whole}`,
  };
}

// The plugin a launch carries for one item, by its format.
export function launchPlugin(item, bound, descriptor) {
  return item.value.format === AGENT_PLUGINS ? translatedPlugin(item, bound, descriptor) : nativePlugin(item, bound, descriptor);
}

// What a plan persists for one plugin item under materialize (§7.5): the marketplace as a generated
// tree, hs-run/plugin.<name>/, holding its manifest and the plugin under plugin/ (translated, or the
// package itself), and the two settings.json keys that make a bare start register it and load the
// plugin. The tree's files come from the plan; the package (and a translation's skills/) is copied
// from the layer.
export function persistedPlugin(item, bound, folder, descriptor) {
  const R = descriptor.plugins[item.value.format];
  const P = R.persist;
  const id = item.id.slice('plugin.'.length);
  const t = launchPlugin(item, bound, descriptor);
  const marketplace = `${P.marketplace_prefix}${id}`;
  const address = `${P.root}/${item.id}`;
  const generated = {
    files: [
      { rel: P.marketplace_manifest, content: JSON.stringify({ name: marketplace, owner: { name: 'harness-skeleton' }, plugins: [{ name: id, source: `./${P.plugin_dir}` }] }, null, 2) + '\n' },
      ...(t.tree.manifest ? [{ rel: `${P.plugin_dir}/${t.tree.manifest.rel}`, content: t.tree.manifest.content }] : []),
      ...t.tree.files.map((f) => ({ rel: `${P.plugin_dir}/${f.rel}`, content: f.content })),
    ],
    entries: t.tree.entries.map((e) => ({ rel: e.rel === '.' ? P.plugin_dir : `${P.plugin_dir}/${e.rel}`, source: e.source, sha256: e.sha256 })),
  };
  const risk = [...new Set(t.risks.map((r) => r.risk))];
  return {
    address, generated: { generated }, marketplace, risk,
    keys: [
      { file: 'settings.json', key: `${P.marketplaces_key}/${marketplace}`, value: { source: { source: P.source_type, path: path.join(folder, address) } } },
      { file: 'settings.json', key: `${P.enabled_key}/${id}@${marketplace}`, value: true },
    ],
    via: t.via.replace(descriptor.launch.plugin.flag, `a directory marketplace, ${marketplace}, in ${address}`),
  };
}
