// What Claude Code makes of each spec item under `materialize` (design note v0.2 §4, §5.12,
// §11), what makes the folder busy, and what in it no ledger owns. Milestone 3 delivers
// `[state] retention_days` and skills; every other kind refuses the plan by item.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RETENTION_DAYS } from '../../defaults.js';
import { digestOf, pidAlive, readLedger } from '../../records.js';
import { digestPath } from '../../spec/layers.js';
import { handlers, treeLink } from '../../native.js';
import { persistedProcess } from '../../persist.js';
import { SHIM_DIR } from '../../shim-dir.js';
import { compareVersions } from '../../version.js';
import { HsError } from '../../protocol.js';
import { LAUNCH_ITEM_KINDS, endpointUnset, launchItems, refuseStoredLogin } from '../../launch-items.js';
import { refuseLoggedIn, storedLogin } from './login.js';
import { layerPath, processRisks, refuseInterpolation, shellQuote } from '../../process.js';
import { hookMatcher } from '../../hooks.js';
import { fileURLToPath } from 'node:url';

// The hook shim Claude Code runs for each hook (§5.6), by its absolute path, under this node.
const HOOK_SHIM = fileURLToPath(new URL('../../shim/claude-code.js', import.meta.url));

import { readDoc } from '../../native.js';
import { readFolderSettings, stateInEffect } from './state.js';

// `.claude.json.lock/` is a directory lock [CC §1, L-fs]. Its staleness rule is undocumented;
// a lock touched in the last minute counts as held (an assumption, named in the build plan).
const LOCK_FRESH_MS = 60_000;

export function deliverables(resolved, { folder, mode, home, state: stateOpts, descriptor, noPersist = false, platform, keychain, given, version, owner }) {
  // `keep`: addresses the spec still wants that need no write (a --prune never removes them);
  // `refused`: items that cannot be delivered as they are.
  // `launch_only`: [state] items a launch made through launch-spec carries, which nothing persists.
  // `state_addresses`: addresses holding [state] values, which a --prune under overlay never
  // removes (a removal could lower retention, a write overlay never makes).
  const out = { deliverables: [], not_implemented: [], refused: [], keep: [], skipped: [], launch_only: [], reduces_capture: [], overridden_by_managed: [],
    state_addresses: [`settings.json#${descriptor.state.retention_days.native}`] };
  const overlay = mode === 'overlay';
  const state = {};
  const layerDirs = new Map(resolved.layers.map((l) => [l.name, l.local ? path.dirname(l.path) : l.path]));
  // The status line under materialize (§7.5, bind by copy): settings.json#statusLine, and the
  // process's directory copied into hs-run/statusline/ when it names files in its layer. Each is
  // runs-code under the plan's receipt. What cannot be bound is refused with the reason.
  // An MCP server under materialize (§7.5): a user-scope server, .claude.json#mcpServers/<id>, and
  // its bound copy in hs-run/ when it names files in its layer. A server with refs is refused: its
  // ${HS_REF_…} would be filled only by a launch, so a bare start would get an empty secret.
  function mcpServer(item) {
    let p;
    try {
      p = persistedMcp(item, layerDirs.get(item.layer), folder, descriptor, resolved, home);
    } catch (e) {
      if (!(e instanceof HsError)) throw e;
      out.refused.push({ item: item.id, code: e.code, reason: e.message });
      return;
    }
    if (p.tree) {
      out.deliverables.push({
        item: item.id, handler: 'tree', address: { path: p.tree.address }, address_id: p.tree.address,
        source: p.tree.source, source_sha256: digestPath(p.tree.source), source_is_dir: true, risk: p.risk, note: p.notes.join('; '),
      });
    }
    out.deliverables.push({ item: item.id, handler: 'json-key', address: p.address, address_id: `${p.address.file}#${p.address.key}`, value: p.value, risk: p.risk, note: p.notes.join('; ') });
  }

  // A hook under materialize (§7.5): a group of its own in settings.json's hooks.<Event>, an
  // element set without touching the user's groups (json-element). It runs hs's shim from the
  // folder's copy, hs-run/hook-shim/, and its process from its bound copy, hs-run/hook.<id>/, so
  // nothing persisted points into an hs checkout or a layer that may move or change.
  let shimDelivered = false;
  let gateNoted = false;
  function hookDeliverable(item) {
    let p;
    try {
      p = persistedHook(item, layerDirs.get(item.layer), folder, descriptor, { version, owner });
    } catch (e) {
      if (!(e instanceof HsError)) throw e;
      out.refused.push({ item: item.id, code: e.code, reason: e.message });
      return;
    }
    const P = descriptor.launch.hooks.persist;
    if (!shimDelivered) {
      shimDelivered = true;
      out.deliverables.push({
        item: 'hook-shim', handler: 'tree', address: { path: P.shim_tree }, address_id: P.shim_tree,
        source: SHIM_DIR, source_sha256: digestPath(SHIM_DIR), source_is_dir: true, risk: ['runs-code'],
        note: `hs's hook shim, copied so persisted hooks never run it from an hs checkout that may move`,
      });
    }
    if (p.tree) {
      out.deliverables.push({
        item: item.id, handler: 'tree', address: { path: p.tree.address }, address_id: p.tree.address,
        source: p.tree.source, source_sha256: digestPath(p.tree.source), source_is_dir: true, risk: ['runs-code'], note: p.notes.join('; '),
      });
    }
    out.deliverables.push({ item: item.id, handler: 'json-element', address: p.address, address_id: `${p.address.file}#${p.address.key}[${p.address.id}]`, value: p.value, risk: p.risk, note: p.notes.join('; ') });
    if (descriptor.launch.hooks.gating_events.includes(item.value.event) && !gateNoted) {
      gateNoted = true;
      (out.unverified ??= []).push(`a persisted guard fails closed only on a Claude Code that honours ${P.on_failure.field} (${P.on_failure.min_version} and later): hs checked the binary it was given (${version}), but another Claude Code using this folder, such as an IDE's bundled one, is not checked, and below ${P.on_failure.min_version} it ignores the field, so the guard fails open there`);
    }
  }

  function statusLine(item) {
    const run = item.value.run;
    if (run.env !== undefined || run.env_refs !== undefined || run.cwd !== undefined) {
      out.refused.push({ item: item.id, code: 'item_unsupported', reason: `Claude Code's statusLine has no ${run.cwd !== undefined ? 'working directory' : 'environment'} field` });
      return;
    }
    let p;
    try {
      p = persistedProcess(item, run, layerDirs.get(item.layer), folder, descriptor.launch.statusline.persist_root);
    } catch (e) {
      if (!(e instanceof HsError)) throw e;
      out.refused.push({ item: item.id, code: e.code, reason: e.message });
      return;
    }
    if (p.tree) {
      out.deliverables.push({
        item: item.id, handler: 'tree', address: { path: p.tree.address }, address_id: p.tree.address,
        source: p.tree.source, source_sha256: digestPath(p.tree.source), source_is_dir: true, risk: ['runs-code'], note: p.notes.join('; '),
      });
    }
    const value = { type: descriptor.launch.statusline.type, command: p.command, ...(item.value.refresh ? { refreshInterval: item.value.refresh } : {}) };
    const key = descriptor.launch.statusline.settings_key;
    out.deliverables.push({ item: item.id, handler: 'json-key', address: { file: 'settings.json', key }, address_id: `settings.json#${key}`, value, risk: ['runs-code'], note: p.notes.join('; ') });
  }
  for (const item of resolved.items) {
    if (item.kind === 'refs' || item.kind === 'binding') continue; // inputs: refs resolve at launch
    if (LAUNCH_ITEM_KINDS.has(item.kind)) continue; // below
    if (item.kind === 'unknown') out.skipped.push({ item: item.id, reason: 'not a kind this format defines; kept, not delivered' });
    else if (item.kind === 'model.catalog') out.skipped.push({ item: item.id, reason: 'model metadata for harnesses that need it; Claude Code does not' });
    else if (item.kind === 'state') state[item.id.slice('state.'.length)] = item.value;
    // An MCP server reaches a launch through --mcp-config, under a launch receipt (§7.5); this
    // build persists none in the folder.
    else if (item.kind === 'hook') {
      if (overlay) out.launch_only.push({ item: item.id, via: 'launch-spec: --settings hooks, through hs\'s hook shim, under a launch receipt (runs-code); not persisted under overlay' });
      else hookDeliverable(item);
    }
    else if (item.kind === 'statusline') {
      if (overlay) out.launch_only.push({ item: item.id, via: 'launch-spec: --settings statusLine, under a launch receipt (runs-code); not persisted under overlay' });
      else statusLine(item);
    }
    else if (item.kind === 'mcp') {
      if (overlay) out.launch_only.push({ item: item.id, via: `launch-spec: ${descriptor.launch.mcp.flag}, under a launch receipt (${item.value?.url ? 'sends-data' : 'runs-code'}); not persisted under overlay` });
      else mcpServer(item);
    }
    else out.not_implemented.push(item.id);
  }

  // Model roles, the endpoint and the login (§5.2). Roles persist under materialize: `model`, and
  // the role variables in settings.json's env block; a launch carries them in every mode. The
  // endpoint and the login are never persisted: the credential exists only at launch.
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  for (const [role, item] of Object.entries(roles)) {
    const r = descriptor.launch.roles[role];
    out.launch_only.push({ item: item.id, value: item.value, via: r.flag ?? r.env });
    if (mode !== 'materialize') continue;
    const key = r.settings_key ?? `env/${r.env}`;
    out.deliverables.push({ item: item.id, handler: 'json-key', address: { file: 'settings.json', key }, address_id: `settings.json#${key}`, value: item.value, risk: [] });
  }
  if (endpoint) out.launch_only.push({ item: endpoint.id, via: 'launch-spec: the base URL, and the credential reference for the caller to resolve; never written to the folder; refused while the folder holds a stored login' });
  // Endpoint hygiene (§5.2): the cached claude.ai account state goes, a one-way state write; but
  // never from a folder still logged in, where oauthAccount is the trace of a login that could
  // reach the endpoint. That folder is refused.
  if (endpoint) {
    const login = storedLogin(folder, descriptor, { platform, keychain, given, home });
    if (login.present.length) {
      const r = refuseLoggedIn(login);
      out.refused.push({ item: endpoint.id, code: r.code, reason: r.message });
    }
    (out.unverified ??= []).push(...login.unverified);
    const as = descriptor.account_state;
    out.clears = as.keys.map((key) => ({ item: endpoint.id, address: { file: as.file, key }, note: 'cached claude.ai account state, which turns on tools a non-Anthropic backend may reject; cleared, never restored (a login regenerates it)' }));
  }
  if (login) out.launch_only.push({ item: login.id, value: login.value, via: 'launch-spec' });
  for (const f of resolved.files) {
    if (f.kind !== 'skill') {
      out.not_implemented.push(f.id);
      continue;
    }
    if (overlay) {
      // Under overlay a skill reaches the launch through a plugin directory (§7.5): launch-spec
      // carries it, under a launch receipt, since it may run code. Nothing is written here.
      out.launch_only.push({ item: f.id, via: `launch-spec: --plugin-dir, as /${descriptor.launch.plugin.name}:${f.id.slice('skill.'.length)}, under a launch receipt (runs-code)` });
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
      item: f.id, handler: 'tree', address: { path: `skills/${name}` }, address_id: `skills/${name}`,
      source: f.path, source_sha256: f.sha256, source_is_dir: fs.statSync(f.path).isDirectory(), risk: ['runs-code'],
    });
  }
  if (resolved.agents_md.length) out.not_implemented.push('instructions (AGENTS.md)');
  if (resolved.permissions.length) out.not_implemented.push('permissions');

  // [state] (§5.12). retention_days persists as cleanupPeriodDays in the folder's settings.
  const item = descriptor.state.retention_days;
  const folderSettings = readFolderSettings(folder, descriptor, home);
  const folderValue = Number.isInteger(folderSettings.value?.[item.native]) ? folderSettings.value[item.native] : undefined;
  const current = folderValue ?? item.harness_default;
  let value = state.retention_days;
  let isDefault = false;
  // The skeleton default (question 8) is for folders a tool owns: under overlay the folder may
  // be the user's own, and nothing changes there unless the spec asks.
  if (value === undefined && mode === 'materialize') {
    if (folderValue !== undefined && folderValue >= DEFAULT_RETENTION_DAYS) {
      out.skipped.push({ item: 'state.retention_days', reason: `the folder already keeps ${folderValue} days; the skeleton default (${DEFAULT_RETENTION_DAYS}) never lowers it` });
      // Still wanted: a --prune must not take away a default this owner installed earlier.
      out.keep.push(`settings.json#${item.native}`);
    } else {
      value = DEFAULT_RETENTION_DAYS;
      isDefault = true;
    }
  }
  if (value !== undefined) {
    if (value < current) {
      out.reduces_capture.push({ item: 'state.retention_days', from: current, to: value, source: folderValue !== undefined ? 'folder' : 'default' });
    }
    const effect = stateInEffect(folder, descriptor, { ...stateOpts, home }).items.retention_days;
    if (effect.source === 'managed') {
      out.overridden_by_managed.push({ item: 'state.retention_days', managed: effect.value, from: effect.from });
      if (Number.isInteger(effect.value) && effect.value < value) {
        out.reduces_capture.push({ item: 'state.retention_days', from: value, to: effect.value, source: 'managed' });
      }
    }
    const persist = {
      item: 'state.retention_days', handler: 'json-key', address: { file: 'settings.json', key: item.native },
      address_id: `settings.json#${item.native}`, value, risk: [],
      ...(isDefault ? { note: `the skeleton default, ${DEFAULT_RETENTION_DAYS} days: design note §14 question 8, decided by the maintainer` } : {}),
    };
    if (!overlay) {
      out.deliverables.push(persist);
    } else {
      // Under overlay (§5.12) the launch always carries the value (--settings). It is also
      // persisted in the folder, the one write overlay makes, only when it keeps more than the
      // folder keeps now. A folder that already keeps at least as long needs no write. A value
      // the user set by hand that keeps less is replaced, and that one key is adopted: its old
      // value is kept as `previous`, so remove gives it back. A shorter value never outlives the
      // tool's launches; no_persist_state writes nothing. The address stays wanted either way, so
      // a --prune never takes away what an earlier overlay persisted.
      out.launch_only.push({ item: 'state.retention_days', value, via: '--settings cleanupPeriodDays' });
      out.keep.push(persist.address_id);
      if (noPersist) {
        out.reduces_capture.push({ item: 'state.retention_days', notice: 'no_persist_state: retention covers only launches made through launch-spec; a start that bypasses the tool sweeps at the folder\'s own value' });
      } else if (folderValue !== undefined && value <= folderValue) {
        out.skipped.push({ item: 'state.retention_days', reason: value === folderValue
          ? `the folder already keeps ${folderValue} days; nothing is written, and launches carry the same`
          : `${value} days keeps less than the folder's ${folderValue}; under overlay it applies to the tool's launches only` });
      } else if (folderValue === undefined && value < current) {
        out.skipped.push({ item: 'state.retention_days', reason: `${value} days keeps less than the default ${current}; under overlay it applies to the tool's launches only` });
      } else {
        out.deliverables.push({
          ...persist,
          ...(folderValue !== undefined ? { adopt_implicit: true } : {}),
          note: folderValue !== undefined
            ? `persisted under overlay: replaces the folder's own ${folderValue} days, kept as previous, so remove gives it back`
            : 'persisted under overlay: it keeps more than the folder keeps now',
        });
      }
    }
  }
  if (state.sessions === 'none') {
    if (overlay) out.launch_only.push({ item: 'state.sessions', value: 'none', via: 'CLAUDE_CODE_SKIP_PROMPT_HISTORY=1' });
    else out.skipped.push({ item: 'state.sessions', reason: 'launch-only on Claude Code (CLAUDE_CODE_SKIP_PROMPT_HISTORY); launch-spec carries it under overlay' });
  }
  if (state.prompt_history === 'none') {
    out.skipped.push({ item: 'state.prompt_history', reason: descriptor.state.prompt_history.reason });
  }
  return out;
}

// A running Claude Code session in this folder, or a fresh .claude.json lock, makes it busy
// (§7.2) [CC §1]. sessions/<pid>.json exists per running process and is removed on exit.
export function liveCheck(folder, home) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(folder, 'sessions'));
  } catch {
    // no live-session registry
  }
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (m && pidAlive(Number(m[1]))) return `a Claude Code session (pid ${m[1]}) is running in this folder`;
  }
  // For the default folder, .claude.json and its lock sit beside it in $HOME [CC §1].
  const locks = [path.join(folder, '.claude.json.lock')];
  try {
    if (home && folder === fs.realpathSync.native(path.join(home, '.claude'))) locks.push(path.join(home, '.claude.json.lock'));
  } catch {
    // no default folder
  }
  for (const lock of locks) {
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs < LOCK_FRESH_MS) return `${lock} is held: Claude Code is writing .claude.json`;
    } catch {
      // no lock
    }
  }
  return null;
}

// What no ledger owns, by native address, names only (§7.1 observe: values redacted).
export function unmanaged(folder, managed, descriptor, home) {
  const owned = new Set(managed.map((m) => m.address));
  const out = [];
  const settings = readFolderSettings(folder, descriptor, home);
  for (const key of Object.keys(settings.value ?? {})) {
    if (!owned.has(`settings.json#${key}`)) out.push({ address: `settings.json#${key}` });
  }
  let skills = [];
  try {
    skills = fs.readdirSync(path.join(folder, 'skills')).sort();
  } catch {
    // no skills
  }
  for (const n of skills) if (!owned.has(`skills/${n}`)) out.push({ address: `skills/${n}` });
  return out;
}

// What a launch carries on Claude Code (§4, §5.2, §7.1 launch-spec): [state] retention in a
// --settings file, no transcripts through the environment, the model roles, and the endpoint,
// whose credential is a reference the caller resolves (env_from_refs). Other kinds reach a launch
// in later milestones.
// Whether the folder is Claude Code's default one, ~/.claude, by real path.
function isDefaultFolder(folder, descriptor, home = os.homedir()) {
  const def = descriptor.binding.default_folder.replace(/^~(?=\/)/, home);
  try {
    return fs.realpathSync.native(def) === folder;
  } catch {
    return false;
  }
}

// What a plan persists for one MCP server (§7.5): its address in .claude.json, the server object,
// the bound copy (or null), the plan's risk kinds and the notes. Refused, with the reason, for
// what cannot be persisted: refs, a working directory, a non-direct exposure.
function persistedMcp(item, dir, folder, descriptor, resolved, home) {
  const v = item.value;
  const name = item.id.slice('mcp.'.length);
  const M = descriptor.launch.mcp;
  // The asymmetry [CC §1]: in the default folder, a bare `claude` (CLAUDE_CONFIG_DIR unset) reads
  // user-scope servers from ~/.claude.json beside it, outside the folder, which hs never writes.
  // A server written into the folder's own .claude.json would show as installed and never load.
  if (isDefaultFolder(folder, descriptor, home)) {
    throw new HsError('item_unsupported', `${item.id}: this is Claude Code's default folder, where a bare claude reads user-scope MCP servers from ~/.claude.json beside it, outside the folder, which hs never writes; a server persisted in the folder would never load there. Deliver it at launch, or use a folder named by CLAUDE_CONFIG_DIR`, [item.id]);
  }
  const address = { file: M.persist.file, key: `${M.persist.key}/${name}` };
  const scope = `a project or local server named ${name} wins over this user-scope one [CC §8]`;
  if (v.env_refs || v.header_refs || v.bearer_ref) {
    throw new HsError('item_unsupported', `${item.id}: a persisted server cannot carry a ref: its \${HS_REF_…} would be filled only by a launch through hs, so a bare start would get an empty secret; deliver it at launch, or persist a server without refs`, [item.id]);
  }
  if (v.cwd !== undefined) throw new HsError('item_unsupported', `${item.id}: Claude Code's server fields have no working directory`, [item.id]);
  if (v.exposure !== undefined && v.exposure !== 'direct') throw new HsError('item_unsupported', `${item.id}: exposure ${v.exposure} is not carried in this build`, [item.id]);
  if (v.url) {
    return { address, value: { type: v.type ?? 'http', url: v.url, ...(v.headers ? { headers: { ...v.headers } } : {}) }, tree: null, risk: ['sends-data'], notes: [`sends data to ${v.url}`, scope] };
  }
  const p = persistedProcess(item, v, dir, folder, M.persist.root);
  const risk = [...new Set(processRisks(item, v, resolved).map((r) => r.risk))];
  return { address, value: { type: 'stdio', command: p.argv[0], args: p.argv.slice(1), ...(v.env ? { env: { ...v.env } } : {}) }, tree: p.tree, risk, notes: [...p.notes, scope] };
}

// Whether a plan installed an MCP server in the folder at exactly what the spec says now.
function installedMcp(item, dir, folder, descriptor, resolved, home) {
  let p;
  try {
    p = persistedMcp(item, dir, folder, descriptor, resolved, home);
  } catch {
    return false;
  }
  const ledger = readLedger(folder);
  const held = (addr, want, current) => {
    const entry = ledger.addresses[addr];
    return entry !== undefined && Object.values(entry.owners).some((o) => o.installed === want) && current === want;
  };
  const want = digestOf(p.value);
  if (!held(`${p.address.file}#${p.address.key}`, want, handlers['json-key'].current(folder, descriptor, p.address).digest)) return false;
  if (!p.tree) return true;
  const tree = digestPath(p.tree.source);
  return held(p.tree.address, tree, handlers.tree.current(folder, descriptor, { path: p.tree.address }).digest);
}

// What a plan persists for one hook (§7.5): the group in settings.json's hooks.<Event>, the bound
// copy of its process (or null), the plan's risk kinds and the notes. Refused, with the reason:
// refs (a bare start would get an empty secret), a working directory outside the bound copy, a
// gating hook on a Claude Code older than onFailure needs, and a folder path with a line break or
// control character in it, which would end the command's closing comment early. The command runs
// `node`, the interpreter hs runs under unless given (installedHook gives the one the folder's
// group names), and the plan's note names it.
function persistedHook(item, dir, folder, descriptor, { version, owner, gate = true, node = process.execPath }) {
  const HK = descriptor.launch.hooks;
  const P = HK.persist;
  const v = item.value;
  const run = v.run;
  if (run.env_refs) throw new HsError('item_unsupported', `${item.id}: a persisted hook cannot carry a ref: its variable would be filled only by a launch through hs, so a bare start would get an empty secret; deliver it at launch, or persist a hook without refs`, [item.id]);
  const gating = HK.gating_events.includes(v.event);
  if (gate && gating && (!version || compareVersions(version, P.on_failure.min_version) < 0)) {
    throw new HsError('item_unsupported', `${item.id}: a persisted ${v.event} hook is a guard, and it fails closed only with ${P.on_failure.field}: "${P.on_failure.value}", which Claude Code ${P.on_failure.min_version} and later honour; this folder's Claude Code is ${version ?? 'of an unknown version'}. Deliver it at launch, or upgrade`, [item.id]);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(folder)) throw new HsError('item_unsupported', `${item.id}: this folder's path holds a line break or a control character, which would end the comment closing a persisted hook's command and run the rest of it; deliver it at launch, or use another folder`, [item.id]);
  const p = persistedProcess(item, run, dir, folder, 'hs-run');
  const shim = path.join(folder, P.shim_tree, P.shim_entry);
  const limit = v.timeout ?? HK.default_limit;
  const args = [node, shim, v.event, ...(v.may_allow === true ? ['--may-allow'] : []), '--timeout', String(limit)];
  if (run.cwd !== undefined) {
    const abs = layerPath(run.cwd, dir, item.id);
    if (p.tree && (abs === p.tree.source || abs.startsWith(p.tree.source + path.sep))) args.push('--cwd', path.join(folder, p.tree.address, path.relative(p.tree.source, abs)));
    else if (path.isAbsolute(run.cwd)) args.push('--cwd', run.cwd);
    else throw new HsError('item_unsupported', `${item.id}: a persisted hook's cwd must lie in the directory it runs from (copied into the folder), or be an absolute path`, [item.id]);
  }
  for (const [k, x] of Object.entries(run.env ?? {})) args.push('--env', `${k}=${x}`);
  // The way out, in the command itself: Claude Code quotes a hook's command when it cannot start
  // it, so a guard that blocks every action still names how to take it away. It is also how the
  // element is told as ours (the hook table's persist.owns), for this copy in this folder.
  const copy = path.join(folder, 'hs-run', item.id);
  const recovery = P.recovery(v.event, copy, owner ?? 'owner');
  const command = `${shellQuote([...args, '--', ...p.argv])} ${recovery}`;
  refuseInterpolation(item.id, command);
  const handler = { type: 'command', command, timeout: limit + HK.timeout_margin, ...(gating ? { [P.on_failure.field]: P.on_failure.value } : {}) };
  const matcher = hookMatcher(HK, v);
  const value = { ...(matcher !== null ? { matcher } : {}), hooks: [handler] };
  const risk = ['runs-code', ...(v.may_allow === true ? ['grants-permission'] : [])];
  const notes = [
    ...p.notes,
    ...(gating ? [`a guard: ${P.on_failure.field} "${P.on_failure.value}", so if it cannot start it blocks every matching action, and the command names how to take it away`] : []),
    `bound to the node at ${node}: if that node is removed or moved (a version manager's upgrade, say), ${gating ? 'every matching action in this folder is blocked' : 'the hook does not run'} until a plan is applied again`,
  ];
  return { address: { file: 'settings.json', key: `${HK.settings_key}/${v.event}`, id: item.id }, value, tree: p.tree, risk, notes };
}

// Whether a plan installed a hook in the folder at exactly what the spec says now: the group, its
// bound copy (if any) and the shim's copy, as the ledger recorded them. Returns the node the
// folder's group runs under, or null when it is not installed.
// The group is computed for each owner the ledger records at that address (the recovery comment
// names the plan's owner), with the node the folder's group names: hs running under another node
// is drift for plan to show, not a reason to carry the hook again at launch and run it twice. The
// version gate was the plan's to apply.
function installedHook(item, dir, folder, descriptor) {
  const ledger = readLedger(folder);
  const HK = descriptor.launch.hooks;
  const address = { file: 'settings.json', key: `${HK.settings_key}/${item.value.event}`, id: item.id };
  const owners = Object.keys(ledger.addresses[`${address.file}#${address.key}[${address.id}]`]?.owners ?? {});
  const cur = handlers['json-element'].current(folder, descriptor, address);
  const node = cur.present ? firstWord(cur.value.hooks[0].command) : null;
  if (!node) return null;
  for (const owner of owners) {
    let p;
    try {
      p = persistedHook(item, dir, folder, descriptor, { owner, gate: false, node });
    } catch {
      return null;
    }
    if (heldAt(ledger, folder, descriptor, p)) return node;
  }
  return null;
}

// The first word of a command shellQuote wrote: bare, or single-quoted with '\\'' for a quote.
function firstWord(command) {
  let out = '';
  let i = 0;
  while (i < command.length && command[i] !== ' ') {
    if (command[i] === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      out += command.slice(i + 1, end);
      i = end + 1;
    } else if (command.startsWith("\\'", i)) {
      out += "'";
      i += 2;
    } else {
      out += command[i++];
    }
  }
  return out || null;
}

function heldAt(ledger, folder, descriptor, p) {
  const held = (addr, want, current) => {
    const entry = ledger.addresses[addr];
    return entry !== undefined && Object.values(entry.owners).some((o) => o.installed === want) && current === want;
  };
  if (!held(`${p.address.file}#${p.address.key}[${p.address.id}]`, digestOf(p.value), handlers['json-element'].current(folder, descriptor, p.address).digest)) return false;
  const P = descriptor.launch.hooks.persist;
  if (!held(P.shim_tree, digestPath(SHIM_DIR), handlers.tree.current(folder, descriptor, { path: P.shim_tree }).digest)) return false;
  if (!p.tree) return true;
  return held(p.tree.address, digestPath(p.tree.source), handlers.tree.current(folder, descriptor, { path: p.tree.address }).digest);
}

// Whether a plan installed the status line in the folder at exactly what the spec says now: the
// settings key with this value, and its bound copy (if any) at this content, both as the ledger
// recorded them. Anything else is carried at launch, under the launch receipt.
function installedStatusLine(sl, dir, folder, descriptor) {
  let p;
  try {
    p = persistedProcess(sl, sl.value.run, dir, folder, descriptor.launch.statusline.persist_root);
  } catch {
    return false;
  }
  const ledger = readLedger(folder);
  const key = { file: 'settings.json', key: descriptor.launch.statusline.settings_key };
  const value = { type: descriptor.launch.statusline.type, command: p.command, ...(sl.value.refresh ? { refreshInterval: sl.value.refresh } : {}) };
  const held = (addr, want, current) => {
    const entry = ledger.addresses[addr];
    return entry !== undefined && Object.values(entry.owners).some((o) => o.installed === want) && current === want;
  };
  if (!held(`settings.json#${key.key}`, digestOf(value), handlers['json-key'].current(folder, descriptor, key).digest)) return false;
  if (!p.tree) return true;
  const want = digestPath(p.tree.source);
  return held(p.tree.address, want, handlers.tree.current(folder, descriptor, { path: p.tree.address }).digest);
}

export function launchParts(resolved, { headless, descriptor, folder, platform, keychain, given, home }) {
  const L = descriptor.launch;
  const out = { items: [], skipped: [], not_implemented: [], files: [], trees: [], risks: [], env: {}, env_from_refs: {}, unset: [], notes: [], unverified: [] };
  const settings = {};
  const settingsEnv = {};
  const flags = [];
  let sessionsNone = false;
  for (const item of resolved.items) {
    // MCP servers are carried below, under the launch receipt.
    if (item.kind === 'refs' || item.kind === 'binding' || item.kind === 'mcp' || item.kind === 'statusline' || item.kind === 'hook' || LAUNCH_ITEM_KINDS.has(item.kind)) continue;
    if (item.kind === 'unknown') {
      out.skipped.push({ item: item.id, reason: 'not a kind this format defines; kept, not delivered' });
    } else if (item.kind === 'model.catalog') {
      out.skipped.push({ item: item.id, reason: 'model metadata for harnesses that need it; Claude Code does not' });
    } else if (item.id === 'state.retention_days') {
      settings[L.state.retention_days.settings_key] = item.value;
      out.items.push({ item: item.id, value: item.value, via: `--settings ${L.state.retention_days.settings_key}` });
    } else if (item.id === 'state.sessions') {
      if (item.value === 'none') {
        sessionsNone = true;
        Object.assign(out.env, L.state.sessions_none.env);
        out.items.push({ item: item.id, value: 'none', via: Object.keys(L.state.sessions_none.env).join(', ') + (headless ? ` and ${L.state.sessions_none.headless_argv.join(' ')}` : '') });
      }
    } else if (item.id === 'state.prompt_history') {
      if (item.value === 'none') out.skipped.push({ item: item.id, reason: descriptor.state.prompt_history.reason });
    } else {
      out.not_implemented.push(item.id);
    }
  }
  const { roles, endpoint, login } = launchItems(resolved, descriptor);
  for (const [role, item] of Object.entries(roles)) {
    const r = L.roles[role];
    if (r.flag) flags.push(r.flag, item.value);
    if (r.env) out.env[r.env] = item.value;
    out.items.push({ item: item.id, value: item.value, via: r.flag ?? r.env });
  }
  if (endpoint) {
    const authVar = L.endpoint.auth[endpoint.value.auth ?? 'bearer'];
    const unverified = refuseStoredLogin(folder, descriptor);
    const login = storedLogin(folder, descriptor, { platform, keychain, given, home });
    if (login.present.length) {
      const r = refuseLoggedIn(login);
      throw new HsError(r.code, r.message, login.present);
    }
    out.unverified.push(...login.unverified);
    out.env[L.endpoint.base_url_env] = endpoint.value.base_url;
    out.env_from_refs[authVar] = endpoint.value.credential;
    out.unset.push(...endpointUnset(descriptor, [authVar]));
    out.items.push({ item: endpoint.id, via: `${L.endpoint.base_url_env}, and ${authVar} from the credential reference, which the caller resolves; every other credential and provider variable unset` });
    if (unverified) out.unverified.push(unverified);
    out.unverified.push(L.stored_login.settings_unverified);
    for (const v of L.cancel_switches) settingsEnv[v] = '';
    const left = accountState(folder, descriptor);
    if (left) out.notes.push(left);
  }
  if (login) out.items.push({ item: login.id, value: login.value, via: endpoint ? 'the endpoint is the only login' : 'the folder\'s own login store' });
  // MCP servers at launch (§5.5, §7.5): one mcp.json in the temp dir, through --mcp-config. Each is
  // a launch risk: a server hs starts runs code (bound by the files it names in its layer, else by
  // its text), and one started through a package launcher also fetches code; a remote server sends
  // data to its destination. A ref becomes ${HS_REF_<ref>} in the file and a variable the caller
  // fills from the reference.
  const M = L.mcp;
  const bindings = new Map(resolved.items.filter((i) => i.kind === 'binding').map((b) => [b.id.slice('binding.'.length), b.value]));
  const refVars = new Map();
  const refVar = (ref) => {
    const v = M.ref_prefix + ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (refVars.has(v) && refVars.get(v) !== ref) throw new HsError('bad_request', `refs ${refVars.get(v)} and ${ref} both become ${v}; rename one`, [ref]);
    refVars.set(v, ref);
    out.env_from_refs[v] = bindings.get(ref);
    return `\${${v}}`;
  };
  const layerDirs = new Map(resolved.layers.map((l) => [l.name, l.local ? path.dirname(l.path) : l.path]));
  const servers = {};
  for (const item of resolved.items.filter((i) => i.kind === 'mcp')) {
    const v = item.value;
    const name = item.id.slice('mcp.'.length);
    // A plan put it in the folder at this content: the folder's user scope carries it, and the
    // plan's receipt covered it. Carrying it again in --mcp-config would deliver it both ways,
    // and where --mcp-config ranks against user scope is undocumented [CC §8].
    if (installedMcp(item, layerDirs.get(item.layer), folder, descriptor, resolved, home)) {
      out.skipped.push({ item: item.id, reason: `installed in the folder by a plan, at this content (${L.mcp.persist.file}#${L.mcp.persist.key}/${name}${L.mcp.persist.root ? ', and its bound copy if any' : ''}); the plan's receipt covered it` });
      continue;
    }
    if (v.cwd !== undefined) {
      out.not_implemented.push(`${item.id}.cwd (Claude Code's server fields have no working directory)`);
      continue;
    }
    if (v.exposure !== undefined && v.exposure !== 'direct') out.skipped.push({ item: `${item.id}.exposure`, reason: `exposure ${v.exposure} is not carried in this build; the server is exposed directly` });
    if (v.url) {
      const headers = { ...(v.headers ?? {}) };
      for (const [h, ref] of Object.entries(v.header_refs ?? {})) headers[h] = refVar(ref);
      if (v.bearer_ref) headers.Authorization = `Bearer ${refVar(v.bearer_ref)}`;
      servers[name] = { type: v.type ?? 'http', url: v.url, ...(Object.keys(headers).length ? { headers } : {}) };
      out.risks.push({ item: item.id, layer: item.layer, risk: 'sends-data', destination: v.url });
      out.items.push({ item: item.id, via: `${M.flag}, a ${v.type ?? 'http'} server` });
      continue;
    }
    // A path in the server's layer is given absolutely, never through a symlink (src/process.js).
    const dir = layerDirs.get(item.layer);
    const inLayer = (x) => layerPath(x, dir, item.id);
    const env = { ...(v.env ?? {}) };
    for (const [k, ref] of Object.entries(v.env_refs ?? {})) env[k] = refVar(ref);
    const command = v.shell !== undefined ? '/bin/sh' : inLayer(v.exec);
    const args = v.shell !== undefined ? ['-c', v.shell] : (v.args ?? []).map(inLayer);
    servers[name] = { type: 'stdio', command, args, ...(Object.keys(env).length ? { env } : {}) };
    out.risks.push(...processRisks(item, v, resolved));
    out.items.push({ item: item.id, via: `${M.flag}, a stdio server${v.shell !== undefined ? ' (a shell string, non-portable)' : ''}` });
  }
  if (Object.keys(servers).length) {
    out.files.push({ name: M.file, role: 'mcp', content: JSON.stringify({ mcpServers: servers }, null, 2) + '\n' });
    out.unverified.push(`a server named like one the folder or the project already has may lose to it: where ${M.flag} ranks among the scopes is not documented [CC §8]`);
  }

  // The status line at launch (§5.9, §7.5): a command in the --settings overlay. Its process is
  // quoted into one command string, its layer paths absolute (never through a symlink); a shell
  // string is the command as written. It runs code, so it needs the launch receipt.
  const sl = resolved.items.find((i) => i.kind === 'statusline');
  if (sl) {
    const run = sl.value.run;
    if (run.env !== undefined || run.env_refs !== undefined) {
      out.not_implemented.push(`${sl.id}.run env (Claude Code's statusLine has no environment field)`);
    } else if (run.cwd !== undefined) {
      // No silent degrade: a working directory the command would not get is refused, as for MCP.
      out.not_implemented.push(`${sl.id}.run cwd (Claude Code's statusLine has no working directory field)`);
    } else if (installedStatusLine(sl, layerDirs.get(sl.layer), folder, descriptor)) {
      // A plan put it in the folder, at this content: the folder's settings carry it, and the
      // plan's receipt covered it, so the launch does not carry it again.
      out.skipped.push({ item: sl.id, reason: 'installed in the folder by a plan, at this content (settings.json#statusLine and its bound copy); the plan\'s receipt covered it' });
    } else {
      const dir = layerDirs.get(sl.layer);
      const command = run.shell ?? shellQuote([layerPath(run.exec, dir, sl.id), ...(run.args ?? []).map((a) => layerPath(a, dir, sl.id))]);
      refuseInterpolation(sl.id, command);
      settings[L.statusline.settings_key] = { type: L.statusline.type, command, ...(sl.value.refresh ? { refreshInterval: sl.value.refresh } : {}) };
      out.risks.push(...processRisks(sl, run, resolved));
      out.items.push({ item: sl.id, via: `--settings ${L.statusline.settings_key}${run.shell !== undefined ? ' (a shell string, non-portable)' : ''}` });
    }
  }

  // Hooks at launch (§5.6, §7.5): one handler per hook in the --settings overlay's hooks, each a
  // command that runs hs's hook shim, which hands the process the envelope and translates its
  // decision. The process's layer paths are absolute (never through a symlink); env and env_refs
  // reach it through the shim, a ref by its derived variable, so no value or ${…} is in the
  // command. Each hook runs code, so each needs the launch receipt.
  const HK = L.hooks;
  const hooks = {};
  for (const hk of resolved.items.filter((i) => i.kind === 'hook')) {
    const v = hk.value;
    const run = v.run;
    const dir = layerDirs.get(hk.layer);
    // A plan put it in the folder at this content: the folder's settings run it, and the plan's
    // receipt covered it. Carrying it again would run it twice.
    const node = installedHook(hk, dir, folder, descriptor);
    if (node) {
      out.skipped.push({ item: hk.id, reason: 'installed in the folder by a plan, at this content (settings.json hooks, its bound copy and the shim\'s copy); the plan\'s receipt covered it' });
      // The folder's group runs under the node it names; with that node gone it cannot start.
      if (!fs.existsSync(node)) out.notes.push(`${hk.id}: the folder's persisted hook runs under the node at ${node}, which is missing, so ${HK.gating_events.includes(v.event) ? 'every matching action is blocked' : 'it does not run'} until a plan is applied again (hs plan, then hs apply)`);
      continue;
    }
    // The shim stops the process at its limit and decides; Claude Code's own timeout sits above.
    const limit = v.timeout ?? HK.default_limit;
    const shimArgs = [process.execPath, HOOK_SHIM, v.event, ...(v.may_allow === true ? ['--may-allow'] : []), '--timeout', String(limit)];
    if (run.cwd !== undefined) shimArgs.push('--cwd', layerPath(run.cwd, dir, hk.id));
    for (const [k, x] of Object.entries(run.env ?? {})) shimArgs.push('--env', `${k}=${x}`);
    for (const [k, ref] of Object.entries(run.env_refs ?? {})) shimArgs.push('--env-ref', `${k}=${refVar(ref).slice(2, -1)}`);
    const proc = run.shell !== undefined ? ['/bin/sh', '-c', run.shell] : [layerPath(run.exec, dir, hk.id), ...(run.args ?? []).map((a) => layerPath(a, dir, hk.id))];
    const handler = { type: 'command', command: shellQuote([...shimArgs, '--', ...proc]), timeout: limit + HK.timeout_margin };
    refuseInterpolation(hk.id, handler.command);
    const matcher = hookMatcher(HK, v);
    (hooks[v.event] ??= []).push({ ...(matcher !== null ? { matcher } : {}), hooks: [handler] });
    // Whether a block from this hook takes effect at all: on SessionStart and the like it only
    // shows stderr [D-hooks]. The receipt says so, so a deny there is never taken for a gate.
    const blocks = HK.blocking_events.includes(v.event);
    const [codeRisk, ...more] = processRisks(hk, run, resolved);
    out.risks.push({ ...codeRisk, blocks }, ...more);
    // An allow from this hook skips the permission prompt for every tool its matcher names: as
    // much as bypassPermissions there. The receipt names it (§7.5).
    if (v.may_allow === true) {
      out.risks.push({ item: hk.id, layer: hk.layer, risk: 'grants-permission', event: v.event, tools: v.match?.tool ?? ['*'], matcher: matcher ?? '*' });
    }
    out.items.push({ item: hk.id, via: `--settings ${HK.settings_key}.${v.event}${matcher !== null ? ` (${matcher})` : ''}, through hs's hook shim${blocks ? '' : `; ${v.event} cannot block on Claude Code, so a deny there is shown, not enforced`}` });
  }
  if (Object.keys(hooks).length) {
    settings[HK.settings_key] = hooks;
    out.unverified.push('the hook shim decides for a hook that fails or stalls, but if the shim itself cannot start (node gone), Claude Code treats that as a non-blocking error; its own onFailure: "block" (2.1.295 and later) is not set by this build');
  }

  // Skills at launch (§7.5): one plugin directory in the launch's temp dir, with a manifest naming
  // it, and each skill copied in from its layer. A skill may carry scripts the agent is told to
  // run, so each is `runs-code` and needs the launch receipt. One a plan already installed in the
  // folder, at the same content, is there already; the plan's receipt covered it.
  const P = L.plugin;
  const ledger = readLedger(folder);
  const entries = [];
  for (const f of resolved.files) {
    if (f.kind !== 'skill') {
      out.not_implemented.push(f.id);
      continue;
    }
    const name = f.id.slice('skill.'.length);
    const installed = path.join(folder, P.skills_dir, name);
    // Skipped only where the folder's copy is what a plan installed, and that is this content: a
    // copy edited in place to match an edited layer is not what any receipt allowed.
    const entry = ledger.addresses[`${P.skills_dir}/${name}`];
    const planned = entry ? Object.values(entry.owners).some((o) => o.installed === f.sha256) : false;
    if (planned && fs.existsSync(installed) && digestPath(installed) === f.sha256) {
      out.skipped.push({ item: f.id, reason: `installed in the folder by a plan, at this content (${P.skills_dir}/${name}); the plan's receipt covered it` });
      continue;
    }
    const link = fs.statSync(f.path).isDirectory() ? treeLink(f.path) : null;
    if (link !== null) throw new HsError('write_refused', `${f.id} holds a symlink (${link}); hs copies no tree with one`, [f.id]);
    entries.push({ rel: `${P.skills_dir}/${name}`, source: f.path, sha256: f.sha256 });
    out.risks.push({ item: f.id, layer: f.layer, risk: 'runs-code', sha256: f.sha256 });
    out.items.push({ item: f.id, via: `${P.flag}, as /${P.name}:${name}` });
  }
  if (entries.length) {
    out.trees.push({ name: 'plugin', role: 'plugin', manifest: { rel: P.manifest, content: JSON.stringify({ name: P.name, description: 'skills carried at launch by harness-skeleton' }, null, 2) + '\n' }, entries });
    out.notes.push(`skills at launch are namespaced: /${P.name}:<name>, where a materialized folder has /<name> [CC §9]`);
  }
  if (resolved.agents_md.length) out.not_implemented.push('instructions (AGENTS.md)');
  if (resolved.permissions.length) out.not_implemented.push('permissions');
  // A settings `env` value overwrites the shell value [CC §19], so a variable the folder's settings
  // set would beat env_set. The overlay is the command-line level, above the folder's settings
  // [CC §2]: it carries every variable this launch sets, and env_set keeps them for the shell.
  Object.assign(settingsEnv, out.env);
  if (Object.keys(settingsEnv).length) settings.env = settingsEnv;
  if (Object.keys(settings).length) out.files.push({ name: 'settings.json', role: 'settings', content: JSON.stringify(settings, null, 2) + '\n' });
  out.argv = (paths) => [
    ...(paths.settings ? [L.settings_flag, paths.settings] : []),
    ...(paths.plugin ? [P.flag, paths.plugin] : []),
    ...(paths.mcp ? [M.flag, paths.mcp] : []),
    ...flags,
    ...(headless ? L.headless.argv : []),
    ...(headless && sessionsNone ? L.state.sessions_none.headless_argv : []),
  ];
  return out;
}

// The cached account state an endpoint launch would start with, by key name, as a note: a plan
// for the spec clears it (§5.2). Nothing is read but the key names.
function accountState(folder, descriptor) {
  const as = descriptor.account_state;
  const r = readDoc(path.join(folder, as.file));
  if (r.blocked) return `${as.file} cannot be read (${r.blocked}), so whether it holds cached claude.ai account state is unknown; a non-Anthropic backend may reject the tools that state turns on`;
  const present = as.keys.filter((k) => r.doc && Object.hasOwn(r.doc, k));
  if (!present.length) return null;
  return `${as.file} holds cached claude.ai account state (${present.join(', ')}), which turns on tools a non-Anthropic backend may reject; plan and apply this spec to clear it`;
}
