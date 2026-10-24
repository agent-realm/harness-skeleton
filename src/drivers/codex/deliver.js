// What Codex makes of a spec (design note v0.2 §4, §5.12). This build writes nothing into a Codex
// folder: its config.toml is the user's TOML, and editing one key while keeping the rest of the
// file as written is later work. So Codex delivery is overlay only, and its [state] items reach
// launches through launch-spec.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCH_ITEM_KINDS } from '../../launch-items.js';
import { HsError } from '../../protocol.js';
import { endpointUnset, launchItems, refuseStoredLogin } from '../../launch-items.js';
import { layerPath, processRisks, refuseInterpolation, shellQuote } from '../../process.js';
import { hookMatcher } from '../../hooks.js';
import { readToml } from '../../files.js';
import { readFolderFile } from '../../folder-config.js';
import { readLedger } from '../../records.js';
import { treeLink } from '../../native.js';
import { digestPath } from '../../spec/layers.js';

const HOOK_SHIM = fileURLToPath(new URL('../../shim/codex.js', import.meta.url));

const NO_TOML_WRITE = 'Codex config.toml is not written in this build, so the value covers only launches made through launch-spec';

// What a plan delivers on Codex. Under `overlay` nothing is written. Under `materialize` only skills
// are, as trees under skills/ (milestone 6a.10); every other item is what it is under overlay,
// since config.toml is never written.
export function deliverables(resolved, { mode, descriptor }) {
  const out = { deliverables: [], not_implemented: [], refused: [], keep: [], skipped: [], launch_only: [], reduces_capture: [], overridden_by_managed: [] };
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  for (const [role, item] of Object.entries(roles)) {
    const r = descriptor.launch.roles[role];
    if (r.unsupported) out.skipped.push({ item: item.id, reason: r.unsupported });
    else out.launch_only.push({ item: item.id, value: item.value, via: r.flag ?? `-c ${r.config_key}` });
  }
  if (endpoint) out.launch_only.push({ item: endpoint.id, via: 'launch-spec: a provider of its own, and the credential reference for the caller to resolve; never written to the folder; refused while the folder holds a stored login' });
  if (login) out.launch_only.push({ item: login.id, value: login.value, via: 'launch-spec' });
  for (const item of resolved.items) {
    if (item.kind === 'refs' || item.kind === 'binding' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
    if (item.kind === 'unknown') out.skipped.push({ item: item.id, reason: 'not a kind this format defines; kept, not delivered' });
    else if (item.kind === 'model.catalog') out.skipped.push({ item: item.id, reason: 'model metadata for harnesses that need it; Codex reads its own catalog [CX §5]' });
    else if (item.id === 'state.retention_days') out.skipped.push({ item: item.id, reason: descriptor.state.retention_days.reason });
    else if (item.id === 'state.prompt_history') {
      out.launch_only.push({ item: item.id, value: item.value, via: `-c ${descriptor.launch.state.prompt_history.config_key}` });
      out.reduces_capture.push({ item: item.id, notice: NO_TOML_WRITE });
    } else if (item.id === 'state.sessions') {
      if (item.value === 'none') out.launch_only.push({ item: item.id, value: 'none', via: 'codex exec --ephemeral (headless launches only)' });
    } else if (item.kind === 'mcp') {
      out.launch_only.push({ item: item.id, via: `launch-spec: -c ${descriptor.launch.mcp.config_key}, under a launch receipt (${item.value?.url ? 'sends-data' : 'runs-code'}); not persisted in this build` });
    } else if (item.kind === 'hook') {
      out.launch_only.push({ item: item.id, via: 'launch-spec: -c hooks, through hs\'s hook shim, trusted for the launch by -c hooks.state, under a launch receipt (runs-code); not persisted in this build' });
    } else if (item.kind === 'statusline') {
      // §5.10: an unsupported if-supported item is skipped and named; a required one refuses.
      if (item.value?.require === 'required') throw new HsError('item_unsupported', `statusline is required, and ${descriptor.launch.statusline.reason}`, [item.id]);
      out.skipped.push({ item: item.id, reason: descriptor.launch.statusline.reason });
    } else out.not_implemented.push(item.id);
  }
  const SK = descriptor.launch.skills;
  for (const f of resolved.files) {
    if (f.kind !== 'skill') {
      out.not_implemented.push(f.id);
      continue;
    }
    // Under overlay nothing is written, and no launch can carry a skill on Codex (the descriptor's
    // skills): refused with the reason.
    if (mode !== 'materialize') {
      out.refused.push({ item: f.id, code: 'item_unsupported', reason: `under overlay nothing is written, and ${SK.reason}` });
      continue;
    }
    const name = f.id.slice('skill.'.length);
    const link = fs.statSync(f.path).isDirectory() ? treeLink(f.path) : null;
    if (link !== null) {
      out.refused.push({ item: f.id, code: 'write_refused', reason: `the skill holds a symlink (${link}); hs installs no tree with one` });
      continue;
    }
    // A skill can carry scripts the agent is told to run, so it is `runs-code` and needs the
    // receipt's consent (§3 principle 6).
    out.deliverables.push({
      item: f.id, handler: 'tree', address: { path: `${SK.dir}/${name}` }, address_id: `${SK.dir}/${name}`,
      source: f.path, source_sha256: f.sha256, source_is_dir: fs.statSync(f.path).isDirectory(), risk: ['runs-code'],
      note: `Codex loads $CODEX_HOME/${SK.dir}, a location it marks deprecated [CX §9]`,
    });
  }
  if (resolved.agents_md.length) out.not_implemented.push('instructions (AGENTS.md)');
  if (resolved.permissions.length) out.not_implemented.push('permissions');
  return out;
}

// Codex keeps no lock on its folder, and a plan writes only trees under skills/, which a running
// Codex reads at a session's start and never writes (it writes skills/.system, its bundled skills,
// which no address can be); the tree handler stages and renames each tree into place.
export function liveCheck() {
  return null;
}

// What a launch carries on Codex (§4, §5.2, §7.1 launch-spec): `-c history.persistence=…` for
// prompt history, `--ephemeral` for no session on a headless run [CX §16, §17], the model roles,
// and the endpoint as a provider of its own [CX §6], whose key the caller resolves into the
// variable the provider names (env_from_refs).
//
// A TOML basic string (TOML v1.0.0, "Basic strings"): `"` and `\` escaped, and every control
// character, U+0000 to U+001F and U+007F, as \uXXXX; JSON leaves DEL raw, which TOML forbids. A
// lone surrogate is not a Unicode scalar value, so no TOML string holds it: refused, never replaced.
export function tomlString(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 0xd800 && c <= 0xdfff) throw new HsError('bad_request', `a value holds a lone surrogate (U+${c.toString(16).toUpperCase()}), which a TOML string cannot hold`);
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}
// For the -c values below: a string, or an array of strings.
const toml = (v) => (Array.isArray(v) ? `[${v.map(tomlString).join(',')}]` : tomlString(v));
// A TOML inline table of strings, keys quoted: {"X-Key" = "v"}.
const tomlTable = (t) => `{${Object.entries(t).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(', ')}}`;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A TOML value from strings, whole numbers, booleans, arrays and tables (inline, keys quoted).
function tomlValue(v) {
  if (typeof v === 'string') return tomlString(v);
  if (Number.isInteger(v) || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${tomlString(k)} = ${tomlValue(x)}`).join(', ')}}`;
}
// A hook's trusted_hash as Codex 0.160.0 computes it: sha256 over the canonical JSON (keys sorted
// at every depth, no spaces) of its normalized identity [CX §11, the descriptor's hooks].
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
export const hookHash = (identity) => `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex')}`;

export function launchParts(resolved, { headless, descriptor, folder }) {
  const L = descriptor.launch;
  const out = { items: [], skipped: [], not_implemented: [], files: [], trees: [], risks: [], env: {}, env_from_refs: {}, unset: [], notes: [], unverified: [] };
  const flags = [];
  let ephemeral = false;
  for (const item of resolved.items) {
    // MCP servers are carried below, under the launch receipt.
    if (item.kind === 'refs' || item.kind === 'binding' || item.kind === 'mcp' || item.kind === 'hook' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
    if (item.kind === 'unknown') {
      out.skipped.push({ item: item.id, reason: 'not a kind this format defines; kept, not delivered' });
    } else if (item.kind === 'model.catalog') {
      out.skipped.push({ item: item.id, reason: 'model metadata for harnesses that need it; Codex reads its own catalog [CX §5]' });
    } else if (item.id === 'state.retention_days') {
      out.skipped.push({ item: item.id, reason: descriptor.state.retention_days.reason });
    } else if (item.id === 'state.prompt_history') {
      const native = L.state.prompt_history.values[item.value];
      flags.push('-c', `${L.state.prompt_history.config_key}=${toml(native)}`);
      out.items.push({ item: item.id, value: item.value, via: `-c ${L.state.prompt_history.config_key}=${toml(native)}` });
    } else if (item.id === 'state.sessions') {
      if (item.value !== 'none') continue;
      if (headless) {
        ephemeral = true;
        out.items.push({ item: item.id, value: 'none', via: L.state.sessions_none.headless_argv.join(' ') });
      } else {
        out.skipped.push({ item: item.id, reason: 'Codex has no switch that keeps an interactive session from being recorded; --ephemeral is headless only [CX §16]' });
      }
    } else if (item.kind === 'statusline') {
      if (item.value?.require === 'required') throw new HsError('item_unsupported', `statusline is required, and ${descriptor.launch.statusline.reason}`, [item.id]);
      out.skipped.push({ item: item.id, reason: descriptor.launch.statusline.reason });
    } else {
      out.not_implemented.push(item.id);
    }
  }
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  for (const [role, item] of Object.entries(roles)) {
    const r = L.roles[role];
    if (r.unsupported) {
      out.skipped.push({ item: item.id, reason: r.unsupported });
      continue;
    }
    if (r.flag) flags.push(r.flag, item.value);
    if (r.config_key) flags.push('-c', `${r.config_key}=${toml(item.value)}`);
    out.items.push({ item: item.id, value: item.value, via: r.flag ?? `-c ${r.config_key}` });
  }
  if (endpoint) {
    const id = L.endpoint.provider_id;
    const key = L.endpoint.key_env;
    const auth = endpoint.value.auth ?? 'bearer';
    const provider = auth === 'bearer'
      ? `{name=${toml(id)}, base_url=${toml(endpoint.value.base_url)}, env_key=${toml(key)}, wire_api="responses"}`
      : `{name=${toml(id)}, base_url=${toml(endpoint.value.base_url)}, env_http_headers={"x-api-key"=${toml(key)}}, wire_api="responses"}`;
    flags.push('-c', `model_provider=${toml(id)}`, '-c', `model_providers.${id}=${provider}`);
    const unverified = refuseStoredLogin(folder, descriptor);
    if (unverified) out.unverified.push(unverified);
    out.env_from_refs[key] = endpoint.value.credential;
    out.unset.push(...endpointUnset(descriptor, [key]));
    out.items.push({ item: endpoint.id, via: `-c model_provider and model_providers.${id}, and ${key} from the credential reference, which the caller resolves; the other key variables unset` });
  }
  if (login) out.items.push({ item: login.id, value: login.value, via: endpoint ? 'the endpoint is the only login' : 'the folder\'s own login store' });

  // MCP servers at launch (§5.5, §7.5): `-c mcp_servers.<id>.<key>` overrides, one per field.
  // Secrets reach a server by variable name only: a ref becomes a derived variable the caller fills
  // from the reference (env_from_refs). Each server is a launch risk, as on Claude Code.
  const M = L.mcp;
  const bindings = new Map(resolved.items.filter((i) => i.kind === 'binding').map((b) => [b.id.slice('binding.'.length), b.value]));
  const vars = new Map();
  const unsetting = new Set([...descriptor.binding.env_unset, ...out.unset, L.endpoint.key_env]);
  const claim = (name, ref) => {
    if (unsetting.has(name)) throw new HsError('bad_request', `${name} is a variable this launch unsets or uses itself; a ref cannot be passed to an MCP server under it`, [name]);
    if (vars.has(name) && vars.get(name) !== ref) throw new HsError('bad_request', `refs ${vars.get(name)} and ${ref} both need the variable ${name}; rename one`, [ref]);
    vars.set(name, ref);
    out.env_from_refs[name] = bindings.get(ref);
    return name;
  };
  const derived = (ref) => claim(M.ref_prefix + ref.toUpperCase().replace(/[^A-Z0-9]/g, '_'), ref);
  const layerDirs = new Map(resolved.layers.map((l) => [l.name, l.local ? path.dirname(l.path) : l.path]));
  const servers = resolved.items.filter((i) => i.kind === 'mcp');
  let folderServers = {};
  if (servers.length) {
    // A -c override merges into a server of the same id key by key, so the launch would run one
    // that neither the folder nor the spec describes.
    const f = readFolderFile(folder, descriptor.layers.folder, descriptor, readToml);
    const why = f.error ?? f.refused;
    if (why) throw new HsError('bad_request', `${f.file}: ${why}; whether it defines a server under a spec server's id cannot be told`, servers.map((i) => i.id));
    const t = f.value?.[M.config_key];
    if (t && typeof t === 'object') folderServers = t;
    out.unverified.push(M.unverified);
  }
  for (const item of servers) {
    try {
      mcpServer(item);
    } catch (e) {
      if (e instanceof HsError && e.items.length === 0) throw new HsError(e.code, `${item.id}: ${e.message}`, [item.id]);
      throw e;
    }
  }
  function mcpServer(item) {
    const v = item.value;
    const id = item.id.slice('mcp.'.length);
    if (!M.id.test(id)) throw new HsError('item_unsupported', `${item.id}: Codex addresses a server as -c ${M.config_key}.<id>, so its id is letters, digits, _ and - only`, [item.id]);
    if (Object.hasOwn(folderServers, id)) throw new HsError('bad_request', `${item.id}: the folder's config.toml defines ${M.config_key}.${id}, and a -c override would merge into it key by key; rename the spec's server`, [item.id]);
    if (v.exposure !== undefined && v.exposure !== 'direct') out.skipped.push({ item: `${item.id}.exposure`, reason: `exposure ${v.exposure} is not carried in this build; the server is exposed directly` });
    const set = (key, value) => flags.push('-c', `${M.config_key}.${id}.${key}=${value}`);
    if (v.url) {
      if ((v.type ?? 'http') !== 'http') throw new HsError('item_unsupported', `${item.id}: Codex has no ${v.type} transport; it speaks stdio and streamable HTTP [CX §8]`, [item.id]);
      set('url', toml(v.url));
      if (v.headers) set('http_headers', tomlTable(v.headers));
      if (v.header_refs) set('env_http_headers', tomlTable(Object.fromEntries(Object.entries(v.header_refs).map(([h, ref]) => [h, derived(ref)]))));
      if (v.bearer_ref) set('bearer_token_env_var', toml(derived(v.bearer_ref)));
      out.risks.push({ item: item.id, layer: item.layer, risk: 'sends-data', destination: v.url });
      out.items.push({ item: item.id, via: `-c ${M.config_key}.${id}, a streamable HTTP server` });
      return;
    }
    // A name under the derived prefix would let one export overwrite a variable a later export
    // reads, so the prelude would hand a server another ref's value.
    for (const name of [...Object.keys(v.env ?? {}), ...Object.keys(v.env_refs ?? {})]) {
      if (name.toUpperCase().startsWith(M.ref_prefix)) throw new HsError('bad_request', `${item.id}: ${name} is under ${M.ref_prefix}, the prefix hs keeps for the variables that carry refs`, [item.id]);
    }
    const dir = layerDirs.get(item.layer);
    const inLayer = (x) => layerPath(x, dir, item.id);
    const target = v.shell !== undefined ? ['/bin/sh', '-c', v.shell] : [inLayer(v.exec), ...(v.args ?? []).map(inLayer)];
    if (v.env_refs) {
      // A ref travels in Codex's environment under its derived name, which Codex's default
      // shell_environment_policy keeps from the shell tool [CX §12], and env_vars forwards it to
      // the server [CX §8]. A /bin/sh prelude renames it to the name the server reads and execs the
      // server in its place, so the server's own name never enters Codex's environment.
      const pairs = Object.entries(v.env_refs).map(([name, ref]) => {
        if (!ENV_NAME.test(name)) throw new HsError('item_unsupported', `${item.id}: env_refs name ${JSON.stringify(name)} is not a shell variable name`, [item.id]);
        return [name, derived(ref)];
      });
      const forwarded = [...new Set(pairs.map(([, d]) => d))];
      // Every export before any unset: two names may read the same ref.
      const prelude = `${pairs.map(([name, d]) => `export ${name}="$${d}"; `).join('')}unset ${forwarded.join(' ')}; exec "$0" "$@"`;
      set('command', toml('/bin/sh'));
      set('args', toml(['-c', prelude, ...target]));
      set('env_vars', toml(forwarded));
    } else {
      set('command', toml(target[0]));
      set('args', toml(target.slice(1)));
    }
    if (v.env) set('env', tomlTable(v.env));
    if (v.cwd !== undefined) set('cwd', toml(inLayer(v.cwd)));
    out.risks.push(...processRisks(item, v, resolved));
    out.items.push({ item: item.id, via: `-c ${M.config_key}.${id}, a stdio server${v.shell !== undefined ? ' (a shell string, non-portable)' : ''}${v.env_refs ? ', its refs renamed by a /bin/sh prelude' : ''}` });
  }

  // Hooks at launch (§5.6, §7.5): `-c hooks.<Event>` arrays, one group of one handler per hook,
  // each a command that runs hs's hook shim, which hands the process the envelope and decides
  // when it fails. Codex runs a hook from these flags only once trusted, so one
  // `-c hooks.state` table carries each handler's trusted_hash for this launch, under the launch
  // receipt; the user's own hooks and trust are left as they are. Each hook runs code.
  const HK = L.hooks;
  const groups = {};
  const trust = {};
  for (const hk of resolved.items.filter((i) => i.kind === 'hook')) {
    try {
      codexHook(hk);
    } catch (e) {
      if (e instanceof HsError && e.items.length === 0) throw new HsError(e.code, `${hk.id}: ${e.message}`, [hk.id]);
      throw e;
    }
  }
  function codexHook(hk) {
    const v = hk.value;
    const run = v.run;
    if (v.may_allow === true) throw new HsError('item_unsupported', `${hk.id}: may_allow: ${HK.may_allow}`, [hk.id]);
    for (const c of v.match?.tool ?? []) {
      if (HK.unsupported_classes[c]) throw new HsError('item_unsupported', `${hk.id}: tool class ${c}: ${HK.unsupported_classes[c]}`, [hk.id]);
    }
    // The shim stops the process at its limit and decides; Codex's own timeout sits above it.
    const cap = HK.capped[v.event];
    const limit = v.timeout ?? (cap ? cap - 1 : HK.default_limit);
    if (cap && limit > cap - 1) throw new HsError('item_unsupported', `${hk.id}: Codex caps ${v.event} hooks at ${cap} s, so a limit above ${cap - 1} s cannot be kept`, [hk.id]);
    const dir = layerDirs.get(hk.layer);
    const shimArgs = [process.execPath, HOOK_SHIM, v.event, '--timeout', String(limit)];
    if (run.cwd !== undefined) shimArgs.push('--cwd', layerPath(run.cwd, dir, hk.id));
    for (const [k, x] of Object.entries(run.env ?? {})) shimArgs.push('--env', `${k}=${x}`);
    for (const [k, ref] of Object.entries(run.env_refs ?? {})) shimArgs.push('--env-ref', `${k}=${derived(ref)}`);
    const proc = run.shell !== undefined ? ['/bin/sh', '-c', run.shell] : [layerPath(run.exec, dir, hk.id), ...(run.args ?? []).map((a) => layerPath(a, dir, hk.id))];
    const handler = { type: 'command', command: shellQuote([...shimArgs, '--', ...proc]), timeout: cap ?? limit + HK.timeout_margin };
    // Codex substitutes ${key} in a hook command (discovery.rs), so nothing it could expand goes out.
    refuseInterpolation(hk.id, handler.command);
    const matcher = HK.matcher_events.includes(v.event) ? hookMatcher(HK, v) : null;
    const list = (groups[v.event] ??= []);
    list.push({ ...(matcher !== null ? { matcher } : {}), hooks: [handler] });
    const label = HK.labels[v.event];
    const key = `${HK.key_source}:${label}:${list.length - 1}:0`;
    const hash = hookHash({ event_name: label, ...(matcher !== null ? { matcher } : {}), hooks: [{ ...handler, async: false }] });
    trust[key] = { trusted_hash: hash };
    // Whether a block from this hook takes effect at all; the receipt says so.
    const blocks = HK.blocking_events.includes(v.event);
    const [codeRisk, ...more] = processRisks(hk, run, resolved);
    // The launch passes Codex's own hook review for this handler, bound to its key and hash (§7.5).
    out.risks.push({ ...codeRisk, blocks }, ...more, { item: hk.id, layer: hk.layer, risk: 'trust', gate: HK.trust_gate, key, hash });
    out.items.push({ item: hk.id, via: `-c ${HK.config_key}.${v.event}${matcher !== null ? ` (${matcher})` : ''}, through hs's hook shim, trusted for this launch${blocks ? '' : `; ${v.event} cannot block on Codex, so a deny there is shown, not enforced`}` });
  }
  for (const [event, list] of Object.entries(groups)) flags.push('-c', `${HK.config_key}.${event}=${tomlValue(list)}`);
  if (Object.keys(trust).length) {
    flags.push('-c', `${HK.state_key}=${tomlValue(trust)}`);
    out.unverified.push('the hook shim decides for a hook that fails or stalls, but if the shim itself cannot start (node gone), Codex lets a PreToolUse call through [CX §11]');
    out.unverified.push('trusted_hash is computed by hs as Codex 0.160.x computes it; a Codex that hashes otherwise skips these hooks, silently under codex exec, so a guard would not run [CX §11]');
  }

  // Every variable that carries a secret is named to match *KEY*, *SECRET* or *TOKEN*. Codex keeps
  // those from the shell tool only while shell_environment_policy.ignore_default_excludes is
  // false, and defaults it to true. A launch that puts a secret in Codex's environment forces it
  // false; the flag outranks the folder, a profile and a project. `exclude` is never written:
  // a -c write would replace the user's own list.
  const S = L.scrub;
  if (Object.keys(out.env_from_refs).length) {
    for (const name of Object.keys(out.env_from_refs)) {
      if (!S.patterns.some((p) => name.toUpperCase().includes(p))) throw new HsError('internal', `${name} carries a secret but matches none of the default excludes`, [name]);
    }
    flags.push('-c', `${S.config_key}=false`);
    out.notes.push(S.note);
    out.unverified.push(S.unverified);
  }

  // A skill cannot reach a Codex launch (the descriptor's skills). One a plan installed in the
  // folder, at this content, is there already, and the plan's receipt covered it: skipped. Any other
  // is refused with the reason, never dropped. A copy edited in place to match an edited layer is
  // not what any receipt allowed.
  const ledger = readLedger(folder);
  const missing = [];
  for (const f of resolved.files.filter((x) => x.kind === 'skill')) {
    const rel = `${L.skills.dir}/${f.id.slice('skill.'.length)}`;
    const entry = ledger.addresses[rel];
    const planned = entry ? Object.values(entry.owners).some((o) => o.installed === f.sha256) : false;
    const installed = path.join(folder, rel);
    if (planned && fs.existsSync(installed) && digestPath(installed) === f.sha256) out.skipped.push({ item: f.id, reason: `installed in the folder by a plan, at this content (${rel}); the plan's receipt covered it` });
    else missing.push(f.id);
  }
  if (missing.length && !L.skills.at_launch) throw new HsError('item_unsupported', `${missing.join(', ')}: ${L.skills.reason}`, missing);
  for (const f of resolved.files) if (f.kind !== 'skill') out.not_implemented.push(f.id);
  if (resolved.agents_md.length) out.not_implemented.push('instructions (AGENTS.md)');
  if (resolved.permissions.length) out.not_implemented.push('permissions');
  out.argv = () => (headless ? [...L.headless.argv, ...flags, ...(ephemeral ? L.state.sessions_none.headless_argv : [])] : flags);
  return out;
}
