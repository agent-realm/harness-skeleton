// What OpenCode makes of a spec (design note v0.2 §4, §5). A launch carries an inline config layer
// (OPENCODE_CONFIG_CONTENT) that names its skills, AGENTS.md and hooks bridge in its temp dir by
// path, and passes --standalone, so a background service running in the folder never supplies the
// config (milestone 7.1). It never sets OPENCODE_CONFIG_DIR, which would replace the folder's own
// config directory (descriptor, launch). Under materialize (7.2) a plan writes into the folder's own config directory,
// config/opencode/: opencode.json's `model` and `mcp.servers.<id>` keys, one by one, the bound
// copies of stdio servers into hs-run/, and the skills into its skills/ (descriptor, persist).

import fs from 'node:fs';
import path from 'node:path';
import { isolationLaunch, isolationPlan } from '../../isolation.js';
import { HsError } from '../../protocol.js';
import { hookMatcher } from '../../hooks.js';
import { SHIM, bridgeSource } from './bridge.js';
import { LAUNCH_ITEM_KINDS, endpointUnset, launchItems, refuseStoredLogin } from '../../launch-items.js';
import { layerPath, processRisks } from '../../process.js';
import { handlers, readDoc, treeLink } from '../../native.js';
import { persistedProcess } from '../../persist.js';
import { readLedger, digestOf } from '../../records.js';
import { digestPath } from '../../spec/layers.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A plan: under overlay it names what a launch carries; under materialize it writes what can
// persist and names the rest (the endpoint, the login and AGENTS.md stay launch only).
export function deliverables(resolved, { descriptor, mode, folder, home, platform }) {
  const L = descriptor.launch;
  const P = descriptor.persist;
  const materialize = mode === 'materialize';
  const out = { deliverables: [], not_implemented: [], refused: [], keep: [], skipped: [], launch_only: [], reduces_capture: [], overridden_by_managed: [] };
  // Isolation (§8): first, so a strict plan this driver cannot keep is refused as isolation_unmet.
  const iso = isolationPlan(resolved, descriptor, { home, platform });
  if (iso.skipped) out.skipped.push(iso.skipped);
  if (iso.refused) out.refused.unshift(iso.refused);
  if (iso.launch_only) out.launch_only.push(iso.launch_only);
  const layerDirs = new Map(resolved.layers.map((l) => [l.name, l.local ? path.dirname(l.path) : l.path]));
  // An opencode.jsonc in the folder outranks the opencode.json hs writes (descriptor, persist).
  const jsonc = materialize && fs.existsSync(path.join(folder, P.jsonc_file));
  const jsonKey = (item, key, value, risk, note) => {
    if (jsonc) {
      out.refused.push({ item: item.id, code: 'item_unsupported', reason: `${item.id}: ${P.jsonc_reason}` });
      return false;
    }
    out.deliverables.push({ item: item.id, handler: 'json-key', address: { file: P.config_file, key }, address_id: `${P.config_file}#${key}`, value, risk, ...(note ? { note } : {}) });
    return true;
  };
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  for (const [role, item] of Object.entries(roles)) {
    const r = L.roles[role];
    if (r.unsupported) out.skipped.push({ item: item.id, reason: r.unsupported });
    // With an endpoint the model is the launch's own provider's, which exists only at launch.
    else if (materialize && !endpoint) {
      try {
        refuseSpecText(item);
      } catch (e) {
        out.refused.push({ item: item.id, code: e.code, reason: e.message });
        continue;
      }
      if (!String(item.value).includes('/')) out.refused.push({ item: item.id, code: 'item_unsupported', reason: `${item.id}: OpenCode names a model as provider/model [OC §5]; a persisted model must name its provider` });
      else jsonKey(item, P.model_key, item.value, []);
    } else out.launch_only.push({ item: item.id, value: item.value, via: `launch-spec: ${r.flag}${materialize ? '; with an endpoint, the model names the launch\'s own provider, which never persists' : ''}` });
  }
  if (endpoint) out.launch_only.push({ item: endpoint.id, via: `launch-spec: a provider of its own in ${L.config_content_env}, and the credential reference for the caller to resolve; never written to the folder` });
  if (login) out.launch_only.push({ item: login.id, value: login.value, via: 'launch-spec' });
  for (const item of resolved.items) {
    if (item.kind === 'refs' || item.kind === 'binding' || item.kind === 'isolation' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
    const s = sorted(item, descriptor);
    if (s.skip) out.skipped.push({ item: item.id, reason: s.skip });
    else if (s.refuse) out.refused.push({ item: item.id, code: 'item_unsupported', reason: s.refuse });
    else if (item.kind === 'mcp') {
      if (!materialize) {
        out.launch_only.push({ item: item.id, via: `launch-spec: ${L.mcp.config_key}.${L.mcp.servers_key} in ${L.config_content_env}, under a launch receipt (${item.value?.url ? 'sends-data' : 'runs-code'})` });
        continue;
      }
      let p;
      try {
        p = persistedMcp(item, layerDirs.get(item.layer), folder, descriptor, resolved);
      } catch (e) {
        if (!(e instanceof HsError)) throw e;
        out.refused.push({ item: item.id, code: e.code, reason: e.message });
        continue;
      }
      if (jsonc) {
        jsonKey(item);
        continue;
      }
      if (p.tree) {
        out.deliverables.push({
          item: item.id, handler: 'tree', address: { path: p.tree.address }, address_id: p.tree.address,
          source: p.tree.source, source_sha256: digestPath(p.tree.source), source_is_dir: true, risk: p.risk, note: p.notes.join('; '),
        });
      }
      jsonKey(item, p.address.key, p.value, p.risk, p.notes.join('; '));
    } else if (item.kind === 'hook') {
      out.launch_only.push({ item: item.id, via: `launch-spec: the hooks bridge plugin, <temp>/${L.bridge.dir} in ${L.config_content_env}'s ${L.bridge.config_key} (tool.${L.bridge.on[item.value.event]}), through hs's hook shim, under a launch receipt (runs-code)${materialize ? '; not persisted in this build' : ''}` });
    } else out.not_implemented.push(s.label ?? item.id);
  }
  for (const f of resolved.files) {
    if (f.kind !== 'skill') {
      out.not_implemented.push(f.id);
      continue;
    }
    if (!materialize) {
      out.launch_only.push({ item: f.id, via: `launch-spec: <temp>/${L.skills.tree} in ${L.config_content_env}'s ${L.skills.config_key}, under a launch receipt (runs-code)` });
      continue;
    }
    const link = fs.statSync(f.path).isDirectory() ? treeLink(f.path) : null;
    if (link !== null) {
      out.refused.push({ item: f.id, code: 'write_refused', reason: `the skill holds a symlink (${link}); hs installs no tree with one` });
      continue;
    }
    // A skill can carry scripts the agent is told to run: runs-code, under the plan's receipt.
    const address = `${P.skills_dir}/${f.id.slice('skill.'.length)}`;
    out.deliverables.push({
      item: f.id, handler: 'tree', address: { path: address }, address_id: address,
      source: f.path, source_sha256: f.sha256, source_is_dir: fs.statSync(f.path).isDirectory(), risk: ['runs-code'],
      note: 'OpenCode reads the skills in its global config directory, config/opencode/skills/ [D2:skills]',
    });
  }
  if (resolved.agents_md.length) out.launch_only.push({ item: 'instructions (AGENTS.md)', via: `launch-spec: <temp>/${L.agents_md.file} in ${L.config_content_env}'s ${L.agents_md.config_key}, beside the folder's own AGENTS.md${materialize ? '; not persisted in this build' : ''}` });
  if (resolved.permissions.length) out.not_implemented.push('permissions');
  return out;
}

// What a plan persists for one MCP server (§7.5, as on Claude Code): opencode.json's
// mcp.servers.<id>, and the bound copy in hs-run/ of a stdio server that names files in its layer.
// Refused, with the reason: refs (a bare start would get an empty secret), a working directory (not
// carried by this build under materialize), a non-direct exposure, {env:} or {file:} text, an SSE
// server.
function persistedMcp(item, dir, folder, descriptor, resolved) {
  const P = descriptor.persist;
  const M = descriptor.launch.mcp;
  const v = item.value;
  const id = item.id.slice('mcp.'.length);
  refuseSpecText(item);
  if (!M.id.test(id)) throw new HsError('item_unsupported', `${item.id}: this build names an OpenCode server by its id, letters, digits, _ and - only`, [item.id]);
  if (v.env_refs || v.header_refs || v.bearer_ref) {
    throw new HsError('item_unsupported', `${item.id}: a persisted server cannot carry a ref: its {env:HS_REF_…} would be filled only by a launch through hs, so a bare start would get an empty secret; deliver it at launch, or persist a server without refs`, [item.id]);
  }
  if (v.cwd !== undefined) throw new HsError('item_unsupported', `${item.id}: a persisted server's working directory is not carried in this build; deliver it at launch`, [item.id]);
  if (v.exposure !== undefined && v.exposure !== 'direct') throw new HsError('item_unsupported', `${item.id}: exposure ${v.exposure} is not carried in this build`, [item.id]);
  const key = `${P.mcp_key}/${id}`;
  if (v.url) {
    if ((v.type ?? 'http') !== 'http') throw new HsError('item_unsupported', `${item.id}: a ${v.type} server is not measured on OpenCode; this build carries streamable HTTP`, [item.id]);
    const value = { type: 'remote', url: v.url, ...(v.headers ? { headers: { ...v.headers } } : {}), oauth: false };
    refuseSubstitution(item.id, value, new Set());
    return { address: { file: P.config_file, key }, value, tree: null, risk: ['sends-data'], notes: [`sends data to ${v.url}`] };
  }
  const p = persistedProcess(item, v, dir, folder, P.root);
  const value = { type: 'local', command: p.argv, ...(v.env ? { environment: { ...v.env } } : {}) };
  refuseSubstitution(item.id, value, new Set());
  const risk = [...new Set(processRisks(item, v, resolved).map((r) => r.risk))];
  return { address: { file: P.config_file, key }, value, tree: p.tree, risk, notes: p.notes };
}

// Whether the ledger holds `addr` at `want`, and the folder too.
function held(folder, addr, want, current) {
  const entry = readLedger(folder).addresses[addr];
  return entry !== undefined && Object.values(entry.owners).some((o) => o.installed === want) && current === want;
}

// Whether a plan installed an MCP server in the folder at exactly what the spec says now.
function installedMcp(item, dir, folder, descriptor, resolved) {
  let p;
  try {
    p = persistedMcp(item, dir, folder, descriptor, resolved);
  } catch {
    return false;
  }
  if (!held(folder, `${p.address.file}#${p.address.key}`, digestOf(p.value), handlers['json-key'].current(folder, descriptor, p.address).digest)) return false;
  if (!p.tree) return true;
  return held(folder, p.tree.address, digestPath(p.tree.source), handlers.tree.current(folder, descriptor, { path: p.tree.address }).digest);
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
  if (item.kind === 'hook') return hookRoute(item, descriptor);
  if (item.kind === 'plugin') return { label: `${item.id} (format ${item.value?.format})` };
  return {};
}

// A hook's route (§5.6, §5.10): the plugin hook it rides on, or why it has none, skipped when
// if-supported and refused when required (the default for hooks). A hook that rides refuses what
// the bridge cannot carry: an allow, and an MCP server match (descriptor, launch.bridge).
function hookRoute(item, descriptor) {
  const B = descriptor.launch.bridge;
  const v = item.value;
  const on = B.on[v.event];
  if (!on) {
    const reason = `${v.event}: ${B.events_refused[v.event] ?? B.no_hook}`;
    return v.require === 'if-supported' ? { skip: reason } : { refuse: `${item.id}: ${reason}` };
  }
  if (v.may_allow === true) return { refuse: `${item.id}: may_allow: ${B.may_allow}` };
  const mcp = (v.match?.tool ?? []).find((c) => c.startsWith('mcp:'));
  if (mcp) return { refuse: `${item.id}: tool class ${mcp}: ${B.mcp_match}` };
  return { on };
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

export function launchParts(resolved, { headless, descriptor, folder, home, platform }) {
  const L = descriptor.launch;
  const out = { items: [], skipped: [], not_implemented: [], files: [], trees: [], risks: [], env: { ...L.always_env }, env_from_refs: {}, unset: [], notes: [], unverified: [], envFrom: {}, pathEnv: {} };
  // Isolation (§8): a strict launch this driver cannot keep is refused before anything else.
  const iso = isolationLaunch(resolved, descriptor, { home, platform });
  if (iso.skipped) out.skipped.push(iso.skipped);
  if (iso.item) out.items.push(iso.item);
  if (iso.note) out.notes.push(iso.note);
  const strict = Boolean(iso.item);
  const config = {};
  const flags = [];
  for (const item of resolved.items) {
    if (item.kind === 'refs' || item.kind === 'binding' || item.kind === 'isolation' || item.kind === 'mcp' || item.kind === 'hook' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
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
    // The launch names its provider and model: no model catalog fetch (descriptor, no_catalog_env).
    out.env[L.no_catalog_env] = '1';
    out.items.push({ item: endpoint.id, via: `${L.config_content_env}: providers.${E.provider_id} (${E.package}), and ${E.key_env} from the credential reference, which the caller resolves; the other key variables unset; ${L.no_catalog_env}, so the launch fetches no model catalog` });
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
  // The variable a ref reaches OpenCode's environment in, which the caller fills (env_from_refs).
  const refVar = (ref, id) => {
    const name = M.ref_prefix + ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (unsetting.has(name)) throw new HsError('bad_request', `${id}: ${name} is a variable this launch unsets or uses itself`, [id]);
    if (vars.has(name) && vars.get(name) !== ref) throw new HsError('bad_request', `refs ${vars.get(name)} and ${ref} both need the variable ${name}; rename one`, [ref]);
    vars.set(name, ref);
    out.env_from_refs[name] = bindings.get(ref);
    return name;
  };
  const derived = (ref, id) => {
    const placeholder = `{env:${refVar(ref, id)}}`;
    own.add(placeholder);
    return placeholder;
  };
  const layerDirs = new Map(resolved.layers.map((l) => [l.name, l.local ? path.dirname(l.path) : l.path]));
  const servers = {};
  // The folder's own servers: the inline layer deep-merges into a server of the same name there
  // [D2:config], so the launch would run one neither the folder nor the spec describes. Refused,
  // unless a plan installed it at this content, when the launch skips it (the plan's receipt covered
  // it).
  const P = descriptor.persist;
  const mcpItems = resolved.items.filter((i) => i.kind === 'mcp');
  let folderServers = null;
  const folderServer = (id) => {
    if (folderServers === null) {
      folderServers = {};
      for (const f of [P.config_file, P.jsonc_file]) {
        const r = readDoc(path.join(folder, f));
        if (r.blocked) throw new HsError('bad_request', `${f}: ${r.blocked}; whether it defines a server under a spec server's name cannot be told`, mcpItems.map((i) => i.id));
        const t = r.doc?.mcp?.servers;
        if (t && typeof t === 'object') for (const k of Object.keys(t)) folderServers[k] = f;
      }
    }
    return Object.hasOwn(folderServers, id) ? folderServers[id] : null;
  };
  for (const item of mcpItems) {
    const v = item.value;
    const id = item.id.slice('mcp.'.length);
    // Under strict the folder's config/opencode/ is not read, so the launch carries the server itself.
    if (!strict && installedMcp(item, layerDirs.get(item.layer), folder, descriptor, resolved)) {
      out.skipped.push({ item: item.id, reason: `installed in the folder by a plan, at this content (${P.config_file}#${P.mcp_key}/${id}); the plan's receipt covered it` });
      continue;
    }
    const there = M.id.test(id) && !strict ? folderServer(id) : null;
    if (there) throw new HsError('item_unsupported', `${item.id}: the folder's ${there} defines ${M.config_key}.${M.servers_key}.${id}, and the launch's would merge into it key by key; plan and apply it, rename the spec's server, or remove the folder's`, [item.id]);
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

  // Hooks (§5.6): hs's bridge plugin in the config directory's plugins/, which runs hs's hook shim
  // for each hook on the plugin hook its event rides on (descriptor, launch.bridge). The process's
  // layer paths are absolute; env and env_refs reach it through the shim, a ref by its variable in
  // OpenCode's environment, which the plugin's spawn inherits. Each hook runs code.
  const HK = L.hooks;
  const B = L.bridge;
  const bridged = [];
  for (const hk of resolved.items.filter((i) => i.kind === 'hook')) {
    const r = hookRoute(hk, descriptor);
    if (r.skip) {
      out.skipped.push({ item: hk.id, reason: r.skip });
      continue;
    }
    if (r.refuse) throw new HsError('item_unsupported', r.refuse, [hk.id]);
    const v = hk.value;
    const run = v.run;
    const dir = layerDirs.get(hk.layer);
    const limit = v.timeout ?? HK.default_limit;
    const args = ['--timeout', String(limit)];
    if (run.cwd !== undefined) args.push('--cwd', layerPath(run.cwd, dir, hk.id));
    for (const [k, x] of Object.entries(run.env ?? {})) args.push('--env', `${k}=${x}`);
    for (const [k, ref] of Object.entries(run.env_refs ?? {})) {
      if (!ENV_NAME.test(k)) throw new HsError('item_unsupported', `${hk.id}: env_refs name ${JSON.stringify(k)} is not a variable name`, [hk.id]);
      args.push('--env-ref', `${k}=${refVar(ref, hk.id)}`);
    }
    const proc = run.shell !== undefined ? ['/bin/sh', '-c', run.shell] : [layerPath(run.exec, dir, hk.id), ...(run.args ?? []).map((a) => layerPath(a, dir, hk.id))];
    const matcher = hookMatcher(HK, v);
    bridged.push({ id: hk.id, event: v.event, on: r.on, matcher, args: [...args, '--', ...proc], limit_ms: limit * 1000 });
    const blocks = HK.blocking_events.includes(v.event);
    const [codeRisk, ...more] = processRisks(hk, run, resolved);
    out.risks.push({ ...codeRisk, blocks }, ...more);
    out.items.push({ item: hk.id, via: `<temp>/${B.dir} in ${L.config_content_env}'s ${B.config_key} (tool.${r.on}${matcher !== null ? `, ${matcher}` : ''}), through hs's hook shim${blocks ? '' : `; ${v.event} cannot block on OpenCode, so a deny there changes nothing`}` });
  }
  // The plugin is a directory of its own in the temp dir; the marker sits beside it, one level up
  // from its entry.
  if (bridged.length) {
    const marker = '../'.repeat(B.entry.split('/').length) + B.marker;
    const content = bridgeSource({ id: B.id, node: process.execPath, shim: SHIM, margin_ms: HK.timeout_margin * 1000, marker, hooks: bridged });
    out.trees.push({ name: B.dir, role: 'hooks_plugin', files: [{ rel: B.entry, content }], entries: [] });
    out.readiness = [{ what: 'hooks', rel: B.marker, means: B.marker_means }];
    out.notes.push(B.fail_closed, B.load, B.context, B.mcp_class);
  }

  // Skills and instructions, in the launch's temp dir and named in the inline layer (descriptor,
  // launch.skills, launch.agents_md). A skill may carry scripts the agent is told to run, so it is
  // runs-code.
  const entries = [];
  for (const f of resolved.files) {
    if (f.kind !== 'skill') {
      out.not_implemented.push(f.id);
      continue;
    }
    const name = f.id.slice('skill.'.length);
    // A skill a plan installed in the folder at this content is read from there; the plan's receipt
    // covered it. A copy edited in place to match an edited layer is not what any receipt allowed.
    const rel = `${P.skills_dir}/${name}`;
    const installed = path.join(folder, rel);
    if (!strict && held(folder, rel, f.sha256, fs.existsSync(installed) ? digestPath(installed) : null)) {
      out.skipped.push({ item: f.id, reason: `installed in the folder by a plan, at this content (${rel}); the plan's receipt covered it` });
      continue;
    }
    if (!strict && fs.existsSync(installed)) out.unverified.push(`${f.id}: the folder's ${rel} holds a skill of the same name; which of the two OpenCode loads is not measured`);
    const link = fs.statSync(f.path).isDirectory() ? treeLink(f.path) : null;
    if (link !== null) throw new HsError('write_refused', `${f.id} holds a symlink (${link}); hs copies no tree with one`, [f.id]);
    entries.push({ rel: name, source: f.path, sha256: f.sha256 });
    out.risks.push({ item: f.id, layer: f.layer, risk: 'runs-code', sha256: f.sha256 });
    out.items.push({ item: f.id, via: `<temp>/${L.skills.tree}/${name}, in ${L.config_content_env}'s ${L.skills.config_key}` });
  }
  if (entries.length) out.trees.push({ name: L.skills.tree, role: L.skills.tree, files: [], entries });
  // AGENTS.md, concatenated in layer order, each part headed by its layer's name (§5.1).
  if (resolved.agents_md.length) {
    out.files.push({ name: L.agents_md.file, role: L.agents_md.role, content: resolved.agents_md.map((a) => `# ${a.layer}\n\n${a.text.replace(/\n*$/, '\n')}`).join('\n') });
    out.items.push({ item: 'instructions (AGENTS.md)', via: `<temp>/${L.agents_md.file}, in ${L.config_content_env}'s ${L.agents_md.config_key}, beside the folder's own AGENTS.md` });
  }
  if (resolved.permissions.length) out.not_implemented.push('permissions');

  // Strict (descriptor, isolation.strict): the project walk off; skill permissions that deny every
  // skill but the spec's, the last match winning; and a config directory of the launch's own, which
  // replaces the folder's config/opencode/.
  if (strict) {
    const S = descriptor.isolation.strict;
    Object.assign(out.env, S.env);
    config.permissions = [
      { action: S.skill_permission, resource: '*', effect: 'deny' },
      ...entries.map((e) => ({ action: S.skill_permission, resource: e.rel, effect: 'allow' })),
    ];
    out.trees.push({ name: S.config_dir.tree, role: S.config_dir.tree, files: [{ rel: S.config_dir.file, content: S.config_dir.content }], entries: [] });
    out.pathEnv[S.config_dir.env] = S.config_dir.tree;
  }

  // The inline layer, with each generated path in it (launch.js digests them as <role>). A temp path
  // that OpenCode would read as a substitution is refused, as spec text is.
  const carriers = [[L.skills.config_key, L.skills.tree, entries.length], [L.agents_md.config_key, L.agents_md.role, resolved.agents_md.length], [B.config_key, 'hooks_plugin', bridged.length]]
    .filter(([, , n]) => n > 0);
  if (Object.keys(config).length || carriers.length) {
    refuseSubstitution('the launch', config, own);
    out.envFrom[L.config_content_env] = (paths) => {
      const named = Object.fromEntries(carriers.map(([key, role]) => [key, [paths[role]]]));
      refuseSubstitution('the temp dir', named, new Set());
      return JSON.stringify({ ...config, ...named });
    };
  }
  out.notes.push(`${L.standalone} on every launch: a run in a folder whose background service is up would otherwise run on that service's config, not this launch's`);
  if (!headless) out.unverified.push('the interactive launch is not measured; tier 1 runs OpenCode headless (opencode run)');
  out.argv = () => [...(headless ? L.headless.argv : L.interactive.argv), ...flags];
  return out;
}
