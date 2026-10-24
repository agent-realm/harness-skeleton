// Launch-time items every driver reads the same way: model roles, the endpoint for the harness's
// wire, and the login mode (design note §5.2). A driver turns them into flags and variables.

import fs from 'node:fs';
import path from 'node:path';
import { HsError } from './protocol.js';
import { readDoc } from './native.js';

export function launchItems(resolved, descriptor) {
  const roles = {};
  const endpoints = {};
  let login = null;
  for (const item of resolved.items) {
    if (item.kind === 'model.roles') roles[item.id.slice('model.roles.'.length)] = item;
    else if (item.kind === 'endpoints') endpoints[item.id.slice('endpoints.'.length)] = item;
    else if (item.id === 'login.mode') login = item;
  }
  const wire = descriptor.launch.wire;
  const endpoint = endpoints[wire] ?? null;
  // A provider that does not offer the harness's wire needs a translating gateway, which is
  // infrastructure the tool or the user provides, never the adapter (§5.2).
  if (Object.keys(endpoints).length && !endpoint) {
    throw new HsError('gateway_required', `${descriptor.name} speaks ${wire}; the spec's endpoints offer ${Object.keys(endpoints).join(', ')}. Add an endpoint for ${wire}, for example a gateway that translates`, [wire]);
  }
  // In a fixed order, so argv does not depend on how the layers spelled them.
  const ordered = Object.fromEntries(ROLE_ORDER.filter((r) => roles[r]).map((r) => [r, roles[r]]));
  return { roles: ordered, endpoint, login };
}

export const ROLE_ORDER = Object.freeze(['primary', 'small', 'subagent', 'effort']);

export const LAUNCH_ITEM_KINDS = new Set(['model.roles', 'endpoints', 'login']);

// An endpoint launch needs a folder with no stored login (§5.2: the endpoint's credential is the
// only login). Checked by name only: the file is never opened.
export function refuseStoredLogin(folder, descriptor) {
  const sl = descriptor.launch.stored_login;
  refuseSettingsCredential(folder, sl?.settings_env);
  for (const f of sl?.files ?? []) {
    let present = false;
    try {
      fs.lstatSync(path.join(folder, f));
      present = true;
    } catch {
      // absent
    }
    if (present) {
      throw new HsError('login_present', `${f} holds a stored login in this folder; an endpoint launch needs a folder with no login, or the login could reach the endpoint. Use a fresh folder`, [f]);
    }
  }
  return sl?.unverified ?? null;
}

// The variables an endpoint launch unsets: every other credential and provider variable, except
// the ones the caller fills from references.
export function endpointUnset(descriptor, filled) {
  return descriptor.launch.endpoint_unset.filter((v) => !filled.includes(v));
}

// A credential variable in the folder's settings `env` outranks the caller's (a settings value
// overwrites the shell value), and a generated overlay cannot override it without writing a value.
// So an endpoint launch is refused while one is there. Key names only: no value is returned or
// shown. A settings file that cannot be read (a link, not JSON) cannot be ruled out, and is refused.
function refuseSettingsCredential(folder, se) {
  if (!se) return;
  const r = readDoc(path.join(folder, se.file));
  if (r.blocked) {
    throw new HsError('login_present', `${se.file} cannot be checked (${r.blocked}); an endpoint launch needs to rule out a credential in its ${se.key}`, [se.file]);
  }
  const env = r.doc?.[se.key];
  if (env === undefined) return;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new HsError('login_present', `${se.file}#${se.key} is not an object; an endpoint launch needs to rule out a credential in it`, [se.file]);
  }
  const found = se.vars.filter((v) => Object.hasOwn(env, v));
  if (found.length) {
    throw new HsError('login_present', `${se.file} sets ${found.join(', ')} in ${se.key}, which would override the endpoint's credential; remove it, or use a fresh folder`, found.map((v) => `${se.file}#${se.key}/${v}`));
  }
}
