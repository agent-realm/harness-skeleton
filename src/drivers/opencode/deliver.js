// What OpenCode makes of a spec (design note v0.2 §4, §5). This build writes nothing into an
// OpenCode folder (milestone 7.1): delivery is overlay only, and every item reaches a launch through
// launch-spec. A launch carries an inline config layer (OPENCODE_CONFIG_CONTENT) and a config
// directory in its temp dir (OPENCODE_CONFIG_DIR), and passes --standalone, so a background service
// running in the folder never supplies the config (descriptor, launch.standalone).

import fs from 'node:fs';
import path from 'node:path';
import { HsError } from '../../protocol.js';
import { LAUNCH_ITEM_KINDS, endpointUnset, launchItems, refuseStoredLogin } from '../../launch-items.js';
import { layerPath, processRisks } from '../../process.js';
import { treeLink } from '../../native.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The items a launch carries, as a plan names them under overlay.
export function deliverables(resolved, { descriptor }) {
  const L = descriptor.launch;
  const out = { deliverables: [], not_implemented: [], refused: [], keep: [], skipped: [], launch_only: [], reduces_capture: [], overridden_by_managed: [] };
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  for (const [role, item] of Object.entries(roles)) {
    const r = L.roles[role];
    if (r.unsupported) out.skipped.push({ item: item.id, reason: r.unsupported });
    else out.launch_only.push({ item: item.id, value: item.value, via: `launch-spec: ${r.flag}` });
  }
  if (endpoint) out.launch_only.push({ item: endpoint.id, via: `launch-spec: a provider of its own in ${L.config_content_env}, and the credential reference for the caller to resolve; never written to the folder` });
  if (login) out.launch_only.push({ item: login.id, value: login.value, via: 'launch-spec' });
  for (const item of resolved.items) {
    if (item.kind === 'refs' || item.kind === 'binding' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
    const s = sorted(item, descriptor);
    if (s.skip) out.skipped.push({ item: item.id, reason: s.skip });
    else if (s.refuse) out.refused.push({ item: item.id, code: 'item_unsupported', reason: s.refuse });
    else if (item.kind === 'mcp') out.launch_only.push({ item: item.id, via: `launch-spec: ${L.mcp.config_key}.${L.mcp.servers_key} in ${L.config_content_env}, under a launch receipt (${item.value?.url ? 'sends-data' : 'runs-code'})` });
    else out.not_implemented.push(s.label ?? item.id);
  }
  for (const f of resolved.files) {
    if (f.kind === 'skill') out.launch_only.push({ item: f.id, via: `launch-spec: ${L.config_dir_env}/${L.skills.dir}, under a launch receipt (runs-code)` });
    else out.not_implemented.push(f.id);
  }
  if (resolved.agents_md.length) out.launch_only.push({ item: 'instructions (AGENTS.md)', via: `launch-spec: ${L.config_dir_env}/${L.agents_md}, which replaces the folder's global AGENTS.md` });
  if (resolved.permissions.length) out.not_implemented.push('permissions');
  return out;
}

// How one non-launch item is handled, the same in a plan and at launch: skipped with a reason,
// refused, or not in this build.
function sorted(item, descriptor) {
  const L = descriptor.launch;
  if (item.kind === 'unknown') return { skip: 'not a kind this format defines; kept, not delivered' };
  if (item.kind === 'model.catalog') return { skip: 'model metadata; OpenCode reads its models from the provider entry the launch builds' };
  if (item.kind === 'state') return { skip: descriptor.state[item.id.slice('state.'.length)]?.reason ?? 'not expressible on OpenCode' };
  if (item.kind === 'statusline') {
    // §5.10: an unsupported if-supported item is skipped and named; a required one refuses.
    if (item.value?.require === 'required') return { refuse: `statusline is required, and ${L.statusline.reason}` };
    return { skip: L.statusline.reason };
  }
  if (item.kind === 'hook') return { label: `${item.id} (${L.hooks.reason})` };
  if (item.kind === 'plugin') return { label: `${item.id} (format ${item.value?.format})` };
  return {};
}

// OpenCode keeps no lock hs could ask, and this build writes nothing into its folder.
export function liveCheck() {
  return null;
}

// OpenCode substitutes {env:VAR} and {file:path} in the config text before it parses it, keys
// included (descriptor, launch.mcp). So no string or key the spec provides may hold either, checked
// before the launch puts in placeholders of its own: a spec value that spelled one of them would be
// filled from a reference the receipt shows going elsewhere (§5.3). The final config is then walked,
// keys and values, with only the launch's own placeholders allowed.
const SUBSTITUTION = /\{(env|file):/;
const refused = (id) => new HsError('interpolation_refused', `${id}: holds {env:…} or {file:…}, which OpenCode substitutes in its config text, keys included, so it could read what the receipt did not bind`, [id]);
function walkStrings(v, fn) {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    fn(k);
    walkStrings(x, fn);
  }
}
function refuseSpecText(item) {
  walkStrings(item.value, (s) => {
    if (SUBSTITUTION.test(s)) throw refused(item.id);
  });
}
function refuseSubstitution(id, value, own) {
  walkStrings(value, (str) => {
    let s = str;
    for (const o of own) s = s.split(o).join('');
    if (SUBSTITUTION.test(s)) throw refused(id);
  });
}

export function launchParts(resolved, { headless, descriptor, folder }) {
  const L = descriptor.launch;
  const out = { items: [], skipped: [], not_implemented: [], files: [], trees: [], risks: [], env: { ...L.always_env }, env_from_refs: {}, unset: [], notes: [], unverified: [], pathEnv: {} };
  const config = {};
  const flags = [];
  for (const item of resolved.items) {
    if (item.kind === 'refs' || item.kind === 'binding' || item.kind === 'mcp' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
    const s = sorted(item, descriptor);
    if (s.skip) out.skipped.push({ item: item.id, reason: s.skip });
    else if (s.refuse) throw new HsError('item_unsupported', s.refuse, [item.id]);
    else out.not_implemented.push(s.label ?? item.id);
  }

  // Model roles and the endpoint (§5.2). With an endpoint the model is the provider's own,
  // `<provider>/<model>`; without one it is passed as given, OpenCode's `provider/model` form.
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  for (const item of [...Object.values(roles), ...(endpoint ? [endpoint] : []), ...resolved.items.filter((i) => i.kind === 'mcp')]) refuseSpecText(item);
  const E = L.endpoint;
  const models = [];
  for (const [role, item] of Object.entries(roles)) {
    const r = L.roles[role];
    if (r.unsupported) {
      out.skipped.push({ item: item.id, reason: r.unsupported });
      continue;
    }
    const value = endpoint ? `${E.provider_id}/${item.value}` : item.value;
    if (endpoint) models.push(item.value);
    flags.push(r.flag, value);
    out.items.push({ item: item.id, value: item.value, via: `${r.flag} ${value}` });
  }
  if (endpoint) {
    const auth = endpoint.value.auth ?? 'bearer';
    if (!E.auth.includes(auth)) throw new HsError('item_unsupported', `${endpoint.id}: the ${L.wire} runtime sends the key as ${E.auth.join(' or ')} [${E.cite}]; this endpoint asks for ${auth}`, [endpoint.id]);
    config.providers = { [E.provider_id]: {
      name: 'harness-skeleton endpoint', env: [E.key_env], package: E.package, settings: { baseURL: endpoint.value.base_url },
      models: Object.fromEntries(models.map((m) => [m, { name: m }])),
    } };
    const unverified = refuseStoredLogin(folder, descriptor);
    if (unverified) out.unverified.push(unverified);
    out.env_from_refs[E.key_env] = endpoint.value.credential;
    out.unset.push(...endpointUnset(descriptor, [E.key_env]));
    out.items.push({ item: endpoint.id, via: `${L.config_content_env}: providers.${E.provider_id} (${E.package}), and ${E.key_env} from the credential reference, which the caller resolves; the other key variables unset` });
  }
  if (login) out.items.push({ item: login.id, value: login.value, via: endpoint ? 'the endpoint is the only login' : 'the folder\'s own login store' });

  // MCP servers (§5.5): `mcp.servers.<name>` in the inline layer. A ref reaches a server as
  // {env:HS_REF_<ref>}, which the caller fills from the reference (env_from_refs). Each server is a
  // launch risk, as on the other drivers.
  const M = L.mcp;
  const bindings = new Map(resolved.items.filter((i) => i.kind === 'binding').map((b) => [b.id.slice('binding.'.length), b.value]));
  const own = new Set();
  const unsetting = new Set([...descriptor.binding.env_unset, ...out.unset, E.key_env, ...Object.keys(L.always_env)]);
  const vars = new Map();
  const derived = (ref, id) => {
    const name = M.ref_prefix + ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (unsetting.has(name)) throw new HsError('bad_request', `${id}: ${name} is a variable this launch unsets or uses itself`, [id]);
    if (vars.has(name) && vars.get(name) !== ref) throw new HsError('bad_request', `refs ${vars.get(name)} and ${ref} both need the variable ${name}; rename one`, [ref]);
    vars.set(name, ref);
    out.env_from_refs[name] = bindings.get(ref);
    const placeholder = `{env:${name}}`;
    own.add(placeholder);
    return placeholder;
  };
  const layerDirs = new Map(resolved.layers.map((l) => [l.name, l.local ? path.dirname(l.path) : l.path]));
  const servers = {};
  for (const item of resolved.items.filter((i) => i.kind === 'mcp')) {
    const v = item.value;
    const id = item.id.slice('mcp.'.length);
    if (!M.id.test(id)) throw new HsError('item_unsupported', `${item.id}: this build names an OpenCode server by its id, letters, digits, _ and - only`, [item.id]);
    if (v.exposure !== undefined && v.exposure !== 'direct') out.skipped.push({ item: `${item.id}.exposure`, reason: `exposure ${v.exposure} is not carried in this build` });
    if (v.url) {
      if ((v.type ?? 'http') !== 'http') throw new HsError('item_unsupported', `${item.id}: a ${v.type} server is not measured on OpenCode; this build carries streamable HTTP`, [item.id]);
      const headers = { ...(v.headers ?? {}) };
      for (const [h, ref] of Object.entries(v.header_refs ?? {})) headers[h] = derived(ref, item.id);
      if (v.bearer_ref) headers.Authorization = `Bearer ${derived(v.bearer_ref, item.id)}`;
      servers[id] = { type: 'remote', url: v.url, ...(Object.keys(headers).length ? { headers } : {}), oauth: false };
      out.risks.push({ item: item.id, layer: item.layer, risk: 'sends-data', destination: v.url });
      out.items.push({ item: item.id, via: `${M.config_key}.${M.servers_key}.${id}, a remote server` });
      continue;
    }
    const dir = layerDirs.get(item.layer);
    const inLayer = (x) => layerPath(x, dir, item.id);
    const command = v.shell !== undefined ? ['/bin/sh', '-c', v.shell] : [inLayer(v.exec), ...(v.args ?? []).map(inLayer)];
    const environment = { ...(v.env ?? {}) };
    for (const [name, ref] of Object.entries(v.env_refs ?? {})) {
      if (!ENV_NAME.test(name)) throw new HsError('item_unsupported', `${item.id}: env_refs name ${JSON.stringify(name)} is not a variable name`, [item.id]);
      environment[name] = derived(ref, item.id);
    }
    servers[id] = { type: 'local', command, ...(Object.keys(environment).length ? { environment } : {}), ...(v.cwd !== undefined ? { cwd: inLayer(v.cwd) } : {}) };
    out.risks.push(...processRisks(item, v, resolved));
    out.items.push({ item: item.id, via: `${M.config_key}.${M.servers_key}.${id}, a local server${v.shell !== undefined ? ' (a shell string, non-portable)' : ''}` });
  }
  if (Object.keys(servers).length) {
    config[M.config_key] = { [M.servers_key]: servers };
    out.unverified.push(M.unverified);
  }

  // Skills and instructions: a config directory in the launch's temp dir (descriptor, launch.skills,
  // launch.agents_md). A skill may carry scripts the agent is told to run, so it is runs-code.
  const entries = [];
  for (const f of resolved.files) {
    if (f.kind !== 'skill') {
      out.not_implemented.push(f.id);
      continue;
    }
    const name = f.id.slice('skill.'.length);
    const link = fs.statSync(f.path).isDirectory() ? treeLink(f.path) : null;
    if (link !== null) throw new HsError('write_refused', `${f.id} holds a symlink (${link}); hs copies no tree with one`, [f.id]);
    entries.push({ rel: `${L.skills.dir}/${name}`, source: f.path, sha256: f.sha256 });
    out.risks.push({ item: f.id, layer: f.layer, risk: 'runs-code', sha256: f.sha256 });
    out.items.push({ item: f.id, via: `${L.config_dir_env}/${L.skills.dir}/${name}` });
  }
  // AGENTS.md, concatenated in layer order, each part headed by its layer's name (§5.1).
  const files = resolved.agents_md.length
    ? [{ rel: L.agents_md, content: resolved.agents_md.map((a) => `# ${a.layer}\n\n${a.text.replace(/\n*$/, '\n')}`).join('\n') }]
    : [];
  if (files.length) out.items.push({ item: 'instructions (AGENTS.md)', via: `${L.config_dir_env}/${L.agents_md}, which replaces the folder's global AGENTS.md` });
  if (entries.length || files.length) {
    out.trees.push({ name: 'config-dir', role: 'config_dir', files, entries });
    out.pathEnv[L.config_dir_env] = 'config_dir';
  }
  if (resolved.permissions.length) out.not_implemented.push('permissions');

  if (Object.keys(config).length) {
    refuseSubstitution('the launch', config, own);
    out.env[L.config_content_env] = JSON.stringify(config);
  }
  out.notes.push(`${L.standalone} on every launch: a run in a folder whose background service is up would otherwise run on that service's config, not this launch's`);
  if (!headless) out.unverified.push('the interactive launch is not measured; tier 1 runs OpenCode headless (opencode run)');
  out.argv = () => [...(headless ? L.headless.argv : L.interactive.argv), ...flags];
  return out;
}
