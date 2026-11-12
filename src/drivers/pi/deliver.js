// What pi makes of a spec (design note v0.2 §4, §5), milestone 8.1: launch only. A launch writes
// nothing into the folder. It passes one extension hs generates in its temp dir (-e), which
// registers the endpoint's provider and the spec's MCP servers for the session; the skills with
// --skill; AGENTS.md as a system-prompt append (descriptor, launch).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HsError } from '../../protocol.js';
import { hookMatcher } from '../../hooks.js';
import { LAUNCH_ITEM_KINDS, endpointUnset, launchItems, refuseStoredLogin } from '../../launch-items.js';
import { layerPath, processRisks } from '../../process.js';
import { handlers, readDoc, treeLink } from '../../native.js';
import { persistedProcess } from '../../persist.js';
import { digestOf, readLedger } from '../../records.js';
import { digestPath } from '../../spec/layers.js';
import { extensionSource } from './extension.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHIM = fileURLToPath(new URL('../../shim/pi.js', import.meta.url));

// A plan: under overlay it names what a launch carries; under materialize it writes what can
// persist into the folder's own files and names the rest (the endpoint, the login, AGENTS.md and
// hooks stay launch only).
export function deliverables(resolved, { descriptor, mode, folder }) {
  const L = descriptor.launch;
  const P = descriptor.persist;
  const I = L.interpolation;
  const materialize = mode === 'materialize';
  const out = { deliverables: [], not_implemented: [], refused: [], keep: [], skipped: [], launch_only: [], reduces_capture: [], overridden_by_managed: [] };
  const layerDirs = new Map(resolved.layers.map((l) => [l.name, l.local ? path.dirname(l.path) : l.path]));
  const jsonKey = (item, file, key, value, risk, note) => out.deliverables.push({ item: item.id, handler: 'json-key', address: { file, key }, address_id: `${file}#${key}`, value, risk, ...(note ? { note } : {}) });
  const refusedBy = (item, e) => {
    if (!(e instanceof HsError)) throw e;
    out.refused.push({ item: item.id, code: e.code, reason: e.message });
  };
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  for (const [role, item] of Object.entries(roles)) {
    const r = L.roles[role];
    if (r.unsupported) out.skipped.push({ item: item.id, reason: r.unsupported });
    // With an endpoint the model is the launch's own provider's, which exists only at launch.
    else if (materialize && !endpoint) {
      try {
        refuseText(item.id, 'the model id', item.value, I);
      } catch (e) {
        refusedBy(item, e);
        continue;
      }
      const slash = String(item.value).indexOf('/');
      if (slash <= 0 || slash === String(item.value).length - 1) {
        out.refused.push({ item: item.id, code: 'item_unsupported', reason: `${item.id}: pi keeps a persisted model as defaultProvider and defaultModel [P15:settings]; give it as provider/model` });
        continue;
      }
      jsonKey(item, P.settings_file, P.provider_key, item.value.slice(0, slash), []);
      jsonKey(item, P.settings_file, P.model_key, item.value.slice(slash + 1), []);
    } else out.launch_only.push({ item: item.id, value: item.value, via: `launch-spec: ${r.flag}${materialize ? '; with an endpoint, the model is the launch\'s own provider\'s, which never persists' : ''}` });
  }
  if (endpoint) out.launch_only.push({ item: endpoint.id, via: `launch-spec: provider ${L.endpoint.provider_id}, registered by the launch extension (${L.extension.flag}), and the credential reference for the caller to resolve; never written to the folder` });
  if (login) out.launch_only.push({ item: login.id, value: login.value, via: 'launch-spec' });
  for (const item of resolved.items) {
    if (item.kind === 'refs' || item.kind === 'binding' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
    const s = sorted(item, descriptor);
    if (s.skip) out.skipped.push({ item: item.id, reason: s.skip });
    else if (s.refuse) out.refused.push({ item: item.id, code: 'item_unsupported', reason: s.refuse });
    else if (item.kind === 'mcp') {
      if (!materialize) {
        out.launch_only.push({ item: item.id, via: `launch-spec: registered by the launch extension (${L.extension.flag}), under a launch receipt (${item.value?.url ? 'sends-data' : 'runs-code'})` });
        continue;
      }
      let p;
      try {
        p = persistedMcp(item, layerDirs.get(item.layer), folder, descriptor, resolved);
      } catch (e) {
        refusedBy(item, e);
        continue;
      }
      if (p.tree) {
        out.deliverables.push({
          item: item.id, handler: 'tree', address: { path: p.tree.address }, address_id: p.tree.address,
          source: p.tree.source, source_sha256: digestPath(p.tree.source), source_is_dir: true, risk: p.risk, note: p.notes.join('; '),
        });
      }
      jsonKey(item, P.mcp_file, p.address.key, p.value, p.risk, p.notes.join('; '));
    } else if (item.kind === 'hook') out.launch_only.push({ item: item.id, via: `launch-spec: the launch extension (${L.extension.flag}) runs it on pi's ${L.bridge.on[item.value.event]}, through hs's hook shim, under a launch receipt (runs-code)${materialize ? '; not persisted in this build' : ''}` });
    else out.not_implemented.push(s.label ?? item.id);
  }
  for (const f of resolved.files) {
    if (f.kind !== 'skill') {
      out.not_implemented.push(f.id);
      continue;
    }
    if (!materialize) {
      out.launch_only.push({ item: f.id, via: `launch-spec: ${L.skills.flag}, under a launch receipt (runs-code)` });
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
      note: 'pi reads the skills in its agent dir, skills/ (tier 1, pi-persisted, 1.5.2)',
    });
  }
  if (resolved.agents_md.length) out.launch_only.push({ item: 'instructions (AGENTS.md)', via: `launch-spec: ${L.agents_md.flag}, a system-prompt append; the folder's own context files still load${materialize ? '; not persisted in this build' : ''}` });
  if (resolved.permissions.length) out.refused.push({ item: 'permissions', code: 'item_unsupported', reason: `permissions: ${L.permissions.reason}` });
  return out;
}

// What a plan persists for one MCP server: mcp.json's mcpServers.<id>, and the bound copy in hs-run/
// of a stdio server that names files in its layer. Refused, with the reason: refs (a bare start
// would get an empty secret), a working directory (not carried by this build under materialize),
// spec text pi would expand or run, an SSE server.
function persistedMcp(item, dir, folder, descriptor, resolved) {
  const P = descriptor.persist;
  const M = descriptor.launch.mcp;
  const I = descriptor.launch.interpolation;
  const v = item.value;
  const id = item.id.slice('mcp.'.length);
  if (!M.id.test(id)) throw new HsError('item_unsupported', `${item.id}: this build names a pi server by its id, letters, digits, _ and - only`, [item.id]);
  if (v.env_refs || v.header_refs || v.bearer_ref) {
    throw new HsError('item_unsupported', `${item.id}: a persisted server cannot carry a ref: its \${HS_REF_…} would be filled only by a launch through hs, so a bare start would get an empty secret; deliver it at launch, or persist a server without refs`, [item.id]);
  }
  if (v.cwd !== undefined) throw new HsError('item_unsupported', `${item.id}: a persisted server's working directory is not carried in this build; deliver it at launch`, [item.id]);
  const key = `${P.mcp_key}/${id}`;
  const exposure = v.exposure ?? M.default_exposure;
  if (v.url) {
    if ((v.type ?? 'http') !== 'http') throw new HsError('item_unsupported', `${item.id}: pi supports streamable HTTP, not ${v.type} [P15:mcp]`, [item.id]);
    refuseText(item.id, 'url', v.url, I);
    for (const [h, x] of Object.entries(v.headers ?? {})) {
      refuseText(item.id, `the header name ${JSON.stringify(h)}`, h, I);
      refuseText(item.id, `headers.${h}`, x, I);
    }
    return { address: { file: P.mcp_file, key }, value: { url: v.url, ...(v.headers ? { headers: { ...v.headers } } : {}), exposure }, tree: null, risk: ['sends-data'], notes: [`sends data to ${v.url}`] };
  }
  for (const [name, x] of Object.entries(v.env ?? {})) {
    refuseText(item.id, `the env name ${JSON.stringify(name)}`, name, I);
    refuseText(item.id, `env.${name}`, x, I);
  }
  const p = persistedProcess(item, v, dir, folder, P.root);
  refuseTilde(item.id, 'the command', p.argv[0], I);
  p.argv.slice(1).forEach((a, i) => refuseTilde(item.id, `argument ${i + 1}`, a, I));
  const value = { command: p.argv[0], args: p.argv.slice(1), ...(v.env ? { env: { ...v.env } } : {}), exposure };
  const risk = [...new Set(processRisks(item, v, resolved).map((r) => r.risk))];
  return { address: { file: P.mcp_file, key }, value, tree: p.tree, risk, notes: p.notes };
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
  if (item.kind === 'hook') return hookRoute(item, descriptor);
  if (item.kind === 'plugin') return { label: `${item.id} (format ${item.value?.format})` };
  return {};
}

// A hook's route (§5.6, §5.10): the pi event it rides on, or why it has none, skipped when
// if-supported and refused when required (the default for hooks). A hook that rides refuses what
// the extension cannot carry: an allow, and a tool class pi has no tool for.
function hookRoute(item, descriptor) {
  const B = descriptor.launch.bridge;
  const HK = descriptor.launch.hooks;
  const v = item.value;
  const on = B.on[v.event];
  if (!on) {
    const reason = `${v.event}: ${B.events_refused[v.event] ?? B.no_hook}`;
    return v.require === 'if-supported' ? { skip: reason } : { refuse: `${item.id}: ${reason}` };
  }
  if (v.may_allow === true) return { refuse: `${item.id}: may_allow: ${B.may_allow}` };
  const cls = (v.match?.tool ?? []).find((c) => HK.unsupported_classes[c]);
  if (cls) return { refuse: `${item.id}: tool class ${cls}: ${HK.unsupported_classes[cls]}` };
  return { on };
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
    if (item.kind === 'refs' || item.kind === 'binding' || item.kind === 'mcp' || item.kind === 'hook' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
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
  // The variable a ref reaches pi's environment in, which the caller fills (env_from_refs).
  const refVar = (ref, id) => {
    const name = M.ref_prefix + ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (unsetting.has(name)) throw new HsError('bad_request', `${id}: ${name} is a variable this launch unsets or uses itself`, [id]);
    if (vars.has(name) && vars.get(name) !== ref) throw new HsError('bad_request', `refs ${vars.get(name)} and ${ref} both need the variable ${name}; rename one`, [ref]);
    vars.set(name, ref);
    out.env_from_refs[name] = bindings.get(ref);
    return name;
  };
  const derived = (ref, id) => {
    const placeholder = `\${${refVar(ref, id)}}`;
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
    // A plan put it in the folder's mcp.json at this content: a start reads it there, and the
    // plan's receipt covered it. Registering it again would be overruled by the file anyway.
    if (installedMcp(item, layerDirs.get(item.layer), folder, descriptor, resolved)) {
      out.skipped.push({ item: item.id, reason: `installed in the folder by a plan, at this content (${descriptor.persist.mcp_file}#${descriptor.persist.mcp_key}/${id}); the plan's receipt covered it` });
      continue;
    }
    if (folderServer(id)) throw new HsError('item_unsupported', `${item.id}: ${M.same_name}; plan and apply it, rename the spec's server, or remove the folder's`, [item.id]);
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

  // Hooks (§5.6): the launch extension runs hs's hook shim for each hook on the pi event its event
  // rides on (descriptor, launch.bridge). The process's layer paths are absolute; env and env_refs
  // reach it through the shim, a ref by its variable in pi's environment, which the extension's
  // spawn inherits. Each hook runs code.
  const HK = L.hooks;
  const B = L.bridge;
  const hooks = [];
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
    hooks.push({ id: hk.id, event: v.event, matcher, args: [...args, '--', ...proc], limit_ms: limit * 1000 });
    const blocks = HK.blocking_events.includes(v.event);
    const [codeRisk, ...more] = processRisks(hk, run, resolved);
    out.risks.push({ ...codeRisk, blocks }, ...more);
    out.items.push({ item: hk.id, via: `the launch extension, on pi's ${r.on}${matcher !== null ? ` (${matcher})` : ''}, through hs's hook shim${blocks ? '' : `; ${v.event} cannot block on pi, so a deny there changes nothing`}` });
    if ((v.match?.tool ?? []).some((c) => c.startsWith('mcp:'))) out.unverified.push(`${hk.id}: ${B.mcp_codemode}`);
  }
  if (hooks.length) {
    out.notes.push(B.fail_closed, B.load, B.context, ...(hooks.some((h) => h.event === 'Stop') ? [B.stop] : []));
    out.readiness = [{ what: 'hooks', rel: B.marker, means: B.marker_means }];
  }

  // The launch extension, when there is anything to register. Its configuration is walked once
  // more: every string with a $ is one of the launch's own, and none starts with !. A server's
  // command and arguments are left out of the walk: pi passes them as written (tier 1), so a shell
  // string's own $1 stays the shell's; their leading ~ was refused above.
  const extension = provider || servers.length || hooks.length;
  if (extension) {
    const config = {
      provider, mcp: servers,
      hooks: hooks.length ? { node: process.execPath, shim: SHIM, margin_ms: HK.timeout_margin * 1000, marker: `./${B.marker}`, list: hooks } : null,
    };
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
    // A skill a plan installed in the folder at this content is read from there; the plan's receipt
    // covered it.
    const rel = `${descriptor.persist.skills_dir}/${name}`;
    const installed = path.join(folder, rel);
    if (held(folder, rel, f.sha256, fs.existsSync(installed) ? digestPath(installed) : null)) {
      out.skipped.push({ item: f.id, reason: `installed in the folder by a plan, at this content (${rel}); the plan's receipt covered it` });
      continue;
    }
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
    ...(extension ? [L.extension.flag, paths[L.extension.role]] : []),
    ...skills.flatMap((n) => [L.skills.flag, path.join(paths[L.skills.tree], n)]),
    ...(resolved.agents_md.length ? [L.agents_md.flag, paths[L.agents_md.role]] : []),
  ];
  return out;
}
