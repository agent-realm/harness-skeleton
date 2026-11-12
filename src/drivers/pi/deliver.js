// What pi makes of a spec (design note v0.2 §4, §5), milestone 8.1: launch only. A launch writes
// nothing into the folder. It passes one extension hs generates in its temp dir (-e), which
// registers the endpoint's provider and the spec's MCP servers for the session; the skills with
// --skill; AGENTS.md as a system-prompt append (descriptor, launch).

import fs from 'node:fs';
import path from 'node:path';
import { HsError } from '../../protocol.js';
import { LAUNCH_ITEM_KINDS, endpointUnset, launchItems, refuseStoredLogin } from '../../launch-items.js';
import { layerPath, processRisks } from '../../process.js';
import { readDoc, treeLink } from '../../native.js';
import { extensionSource } from './extension.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A plan under overlay names what a launch carries.
export function deliverables(resolved, { descriptor }) {
  const L = descriptor.launch;
  const out = { deliverables: [], not_implemented: [], refused: [], keep: [], skipped: [], launch_only: [], reduces_capture: [], overridden_by_managed: [] };
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  for (const [role, item] of Object.entries(roles)) {
    const r = L.roles[role];
    if (r.unsupported) out.skipped.push({ item: item.id, reason: r.unsupported });
    else out.launch_only.push({ item: item.id, value: item.value, via: `launch-spec: ${r.flag}` });
  }
  if (endpoint) out.launch_only.push({ item: endpoint.id, via: `launch-spec: provider ${L.endpoint.provider_id}, registered by the launch extension (${L.extension.flag}), and the credential reference for the caller to resolve; never written to the folder` });
  if (login) out.launch_only.push({ item: login.id, value: login.value, via: 'launch-spec' });
  for (const item of resolved.items) {
    if (item.kind === 'refs' || item.kind === 'binding' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
    const s = sorted(item, descriptor);
    if (s.skip) out.skipped.push({ item: item.id, reason: s.skip });
    else if (s.refuse) out.refused.push({ item: item.id, code: 'item_unsupported', reason: s.refuse });
    else if (item.kind === 'mcp') out.launch_only.push({ item: item.id, via: `launch-spec: registered by the launch extension (${L.extension.flag}), under a launch receipt (${item.value?.url ? 'sends-data' : 'runs-code'})` });
    else out.not_implemented.push(s.label ?? item.id);
  }
  for (const f of resolved.files) {
    if (f.kind === 'skill') out.launch_only.push({ item: f.id, via: `launch-spec: ${L.skills.flag}, under a launch receipt (runs-code)` });
    else out.not_implemented.push(f.id);
  }
  if (resolved.agents_md.length) out.launch_only.push({ item: 'instructions (AGENTS.md)', via: `launch-spec: ${L.agents_md.flag}, a system-prompt append; the folder's own context files still load` });
  if (resolved.permissions.length) out.refused.push({ item: 'permissions', code: 'item_unsupported', reason: `permissions: ${L.permissions.reason}` });
  return out;
}

// How one non-launch item is handled, the same in a plan and at launch.
function sorted(item, descriptor) {
  const L = descriptor.launch;
  if (item.kind === 'unknown') return { skip: 'not a kind this format defines; kept, not delivered' };
  if (item.kind === 'model.catalog') return { skip: 'model metadata; the launch registers its own provider\'s models' };
  if (item.kind === 'state') return { skip: descriptor.state[item.id.slice('state.'.length)]?.reason ?? 'not expressible on pi' };
  if (item.kind === 'statusline') {
    // §5.10: an unsupported if-supported item is skipped and named; a required one refuses.
    if (item.value?.require === 'required') return { refuse: `statusline is required, and ${L.statusline.reason}` };
    return { skip: L.statusline.reason };
  }
  if (item.kind === 'hook') return { label: `${item.id} (${L.hooks.reason})` };
  if (item.kind === 'plugin') return { label: `${item.id} (format ${item.value?.format})` };
  return {};
}

// pi keeps no lock hs could ask, and this build writes nothing into its folder.
export function liveCheck() {
  return null;
}

// pi runs a leading `!command` and expands `$NAME` and `${NAME}` in the fields the launch
// extension fills (descriptor, launch.interpolation). Spec text bound for them is refused before
// the launch adds its own variables; the finished configuration is walked again, keys and values,
// with only the launch's own names allowed.
const runsOrReads = (s) => typeof s === 'string' && (s.includes('$') || s.trimStart().startsWith('!'));
function refuseText(id, where, s, I) {
  if (runsOrReads(s)) throw new HsError('interpolation_refused', `${id}: ${where} holds $ or a leading !, which pi would expand from its environment or run as a command; ${I.reason}`, [id]);
}
function refuseTilde(id, where, s, I) {
  if (typeof s === 'string' && s.startsWith('~')) throw new HsError('item_unsupported', `${id}: ${where} starts with ~, and ${I.tilde}; give the path in full`, [id]);
}
function walk(v, fn) {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) v.forEach((x) => walk(x, fn));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      fn(k);
      walk(x, fn);
    }
  }
}

export function launchParts(resolved, { headless, descriptor, folder }) {
  const L = descriptor.launch;
  const I = L.interpolation;
  const out = { items: [], skipped: [], not_implemented: [], files: [], trees: [], risks: [], env: {}, env_from_refs: {}, unset: [], notes: [], unverified: [] };
  for (const item of resolved.items) {
    if (item.kind === 'refs' || item.kind === 'binding' || item.kind === 'mcp' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
    const s = sorted(item, descriptor);
    if (s.skip) out.skipped.push({ item: item.id, reason: s.skip });
    else if (s.refuse) throw new HsError('item_unsupported', s.refuse, [item.id]);
    else out.not_implemented.push(s.label ?? item.id);
  }
  if (resolved.permissions.length) throw new HsError('item_unsupported', `permissions: ${L.permissions.reason}`, ['permissions']);

  // Model roles and the endpoint (§5.2). With an endpoint the launch names its provider; the model
  // is one of that provider's.
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  const E = L.endpoint;
  const flags = [];
  const models = [];
  for (const [role, item] of Object.entries(roles)) {
    const r = L.roles[role];
    if (r.unsupported) {
      out.skipped.push({ item: item.id, reason: r.unsupported });
      continue;
    }
    refuseText(item.id, 'the model id', item.value, I);
    if (endpoint) models.push(item.value);
    flags.push(r.flag, item.value);
    out.items.push({ item: item.id, value: item.value, via: `${r.flag} ${item.value}` });
  }
  const own = new Set();
  let provider = null;
  if (endpoint) {
    const auth = endpoint.value.auth ?? 'bearer';
    if (!E.auth.includes(auth)) throw new HsError('item_unsupported', `${endpoint.id}: the ${E.api} runtime sends the key as ${E.auth.join(' or ')} [${E.cite}]; this endpoint asks for ${auth}`, [endpoint.id]);
    refuseText(endpoint.id, 'base_url', endpoint.value.base_url, I);
    const unverified = refuseStoredLogin(folder, descriptor);
    if (unverified) out.unverified.push(unverified);
    const apiKey = `$${E.key_env}`;
    own.add(apiKey);
    provider = {
      id: E.provider_id,
      config: {
        name: 'harness-skeleton endpoint', baseUrl: endpoint.value.base_url, apiKey, api: E.api,
        models: models.map((m) => ({ type: 'chat', id: m, name: m, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 })),
      },
    };
    out.env_from_refs[E.key_env] = endpoint.value.credential;
    out.unset.push(...endpointUnset(descriptor, [E.key_env]));
    Object.assign(out.env, L.endpoint_env);
    out.items.push({ item: endpoint.id, via: `${E.provider_flag} ${E.provider_id}: a provider the launch extension registers (${E.api}, ${endpoint.value.base_url}), its key from ${E.key_env}, which the caller fills from the credential reference; the other key variables unset; ${Object.keys(L.endpoint_env).join(', ')}, so pi's own network stays off` });
  }
  if (login) out.items.push({ item: login.id, value: login.value, via: endpoint ? 'the endpoint is the only login' : 'the folder\'s own login store' });

  // MCP servers (§5.5): registered by the launch extension, with an exposure always given (with
  // none only codemode is offered). A ref reaches a server as ${HS_REF_<ref>} in its env or headers,
  // which the caller fills from the reference (env_from_refs).
  const M = L.mcp;
  const bindings = new Map(resolved.items.filter((i) => i.kind === 'binding').map((b) => [b.id.slice('binding.'.length), b.value]));
  const unsetting = new Set([...descriptor.binding.env_unset, ...out.unset, E.key_env, ...Object.keys(L.endpoint_env)]);
  const vars = new Map();
  const derived = (ref, id) => {
    const name = M.ref_prefix + ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (unsetting.has(name)) throw new HsError('bad_request', `${id}: ${name} is a variable this launch unsets or uses itself`, [id]);
    if (vars.has(name) && vars.get(name) !== ref) throw new HsError('bad_request', `refs ${vars.get(name)} and ${ref} both need the variable ${name}; rename one`, [ref]);
    vars.set(name, ref);
    out.env_from_refs[name] = bindings.get(ref);
    const placeholder = `\${${name}}`;
    own.add(placeholder);
    return placeholder;
  };
  const layerDirs = new Map(resolved.layers.map((l) => [l.name, l.local ? path.dirname(l.path) : l.path]));
  const mcpItems = resolved.items.filter((i) => i.kind === 'mcp');
  let folderServers = null;
  const folderServer = (id) => {
    if (folderServers === null) {
      const r = readDoc(path.join(folder, M.folder_file));
      if (r.blocked) throw new HsError('bad_request', `${M.folder_file}: ${r.blocked}; whether it defines a server under a spec server's name cannot be told`, mcpItems.map((i) => i.id));
      const t = r.doc?.mcpServers;
      folderServers = new Set(t && typeof t === 'object' ? Object.keys(t) : []);
    }
    return folderServers.has(id);
  };
  const servers = [];
  for (const item of mcpItems) {
    const v = item.value;
    const id = item.id.slice('mcp.'.length);
    if (!M.id.test(id)) throw new HsError('item_unsupported', `${item.id}: this build names a pi server by its id, letters, digits, _ and - only`, [item.id]);
    if (folderServer(id)) throw new HsError('item_unsupported', `${item.id}: ${M.same_name}; rename the spec's server, or remove the folder's`, [item.id]);
    const exposure = v.exposure ?? M.default_exposure;
    if (v.url) {
      if ((v.type ?? 'http') !== 'http') throw new HsError('item_unsupported', `${item.id}: pi supports streamable HTTP, not ${v.type} [P15:mcp]`, [item.id]);
      refuseText(item.id, 'url', v.url, I);
      for (const [h, x] of Object.entries(v.headers ?? {})) {
        refuseText(item.id, `the header name ${JSON.stringify(h)}`, h, I);
        refuseText(item.id, `headers.${h}`, x, I);
      }
      for (const h of Object.keys(v.header_refs ?? {})) refuseText(item.id, `the header name ${JSON.stringify(h)}`, h, I);
      const headers = { ...(v.headers ?? {}) };
      for (const [h, ref] of Object.entries(v.header_refs ?? {})) headers[h] = derived(ref, item.id);
      if (v.bearer_ref) {
        const b = `Bearer ${derived(v.bearer_ref, item.id)}`;
        own.add(b);
        headers.Authorization = b;
      }
      servers.push([id, { url: v.url, ...(Object.keys(headers).length ? { headers } : {}), exposure }]);
      out.risks.push({ item: item.id, layer: item.layer, risk: 'sends-data', destination: v.url });
      out.items.push({ item: item.id, via: `the launch extension registers a remote server, exposure ${exposure}` });
      continue;
    }
    const dir = layerDirs.get(item.layer);
    const inLayer = (x) => layerPath(x, dir, item.id);
    const argv = v.shell !== undefined ? ['/bin/sh', '-c', v.shell] : [inLayer(v.exec), ...(v.args ?? []).map(inLayer)];
    refuseTilde(item.id, 'the command', argv[0], I);
    argv.slice(1).forEach((a, i) => refuseTilde(item.id, `argument ${i + 1}`, a, I));
    const cwd = v.cwd !== undefined ? inLayer(v.cwd) : undefined;
    refuseTilde(item.id, 'cwd', cwd, I);
    const env = {};
    for (const [name, x] of Object.entries(v.env ?? {})) {
      refuseText(item.id, `the env name ${JSON.stringify(name)}`, name, I);
      refuseText(item.id, `env.${name}`, x, I);
      env[name] = x;
    }
    for (const [name, ref] of Object.entries(v.env_refs ?? {})) {
      if (!ENV_NAME.test(name)) throw new HsError('item_unsupported', `${item.id}: env_refs name ${JSON.stringify(name)} is not a variable name`, [item.id]);
      env[name] = derived(ref, item.id);
    }
    servers.push([id, { command: argv[0], args: argv.slice(1), ...(Object.keys(env).length ? { env } : {}), ...(cwd !== undefined ? { cwd } : {}), exposure }]);
    out.risks.push(...processRisks(item, v, resolved));
    out.items.push({ item: item.id, via: `the launch extension registers a stdio server${v.shell !== undefined ? ' (a shell string, non-portable)' : ''}, exposure ${exposure}` });
  }
  if (servers.length) out.unverified.push(M.unverified);

  // The launch extension, when there is anything to register. Its configuration is walked once
  // more: every string with a $ is one of the launch's own, and none starts with !. A server's
  // command and arguments are left out of the walk: pi passes them as written (tier 1), so a shell
  // string's own $1 stays the shell's; their leading ~ was refused above.
  if (provider || servers.length) {
    const config = { provider, mcp: servers };
    walk({ provider, mcp: servers.map(([n, { command, args, ...rest }]) => [n, rest]) }, (s) => {
      if ((s.includes('$') && !own.has(s)) || s.trimStart().startsWith('!')) throw new HsError('interpolation_refused', `the launch: a value would reach pi holding $ or a leading !; ${I.reason}`, []);
    });
    out.files.push({ name: L.extension.file, role: L.extension.role, content: extensionSource(config) });
  }

  // Skills: one --skill per skill, copied into the temp dir. A skill may carry scripts the agent is
  // told to run, so it is runs-code.
  const entries = [];
  for (const f of resolved.files) {
    if (f.kind !== 'skill') {
      out.not_implemented.push(f.id);
      continue;
    }
    const name = f.id.slice('skill.'.length);
    const link = fs.statSync(f.path).isDirectory() ? treeLink(f.path) : null;
    if (link !== null) throw new HsError('write_refused', `${f.id} holds a symlink (${link}); hs copies no tree with one`, [f.id]);
    if (fs.existsSync(path.join(folder, 'skills', name))) out.unverified.push(`${f.id}: the folder's skills/${name} holds a skill of the same name; pi keeps the first it finds [PI §9], and which one that is at launch is not measured`);
    entries.push({ rel: name, source: f.path, sha256: f.sha256 });
    out.risks.push({ item: f.id, layer: f.layer, risk: 'runs-code', sha256: f.sha256 });
    out.items.push({ item: f.id, via: `${L.skills.flag} <temp>/${L.skills.tree}/${name}` });
  }
  if (entries.length) out.trees.push({ name: L.skills.tree, role: L.skills.tree, files: [], entries });

  // AGENTS.md, concatenated in layer order, each part headed by its layer's name (§5.1), passed as
  // a system-prompt append.
  if (resolved.agents_md.length) {
    out.files.push({ name: L.agents_md.file, role: L.agents_md.role, content: resolved.agents_md.map((a) => `# ${a.layer}\n\n${a.text.replace(/\n*$/, '\n')}`).join('\n') });
    out.items.push({ item: 'instructions (AGENTS.md)', via: `${L.agents_md.flag}: a system-prompt append, not a context file; the folder's own context files still load` });
  }

  if (!headless) out.unverified.push('the interactive launch is not measured; tier 1 runs pi in JSON mode');
  const skills = entries.map((e) => e.rel);
  out.argv = (paths) => [
    ...(headless ? L.headless.argv : L.interactive.argv),
    ...(provider ? [E.provider_flag, E.provider_id] : []),
    ...flags,
    ...(provider || servers.length ? [L.extension.flag, paths[L.extension.role]] : []),
    ...skills.flatMap((n) => [L.skills.flag, path.join(paths[L.skills.tree], n)]),
    ...(resolved.agents_md.length ? [L.agents_md.flag, paths[L.agents_md.role]] : []),
  ];
  return out;
}
