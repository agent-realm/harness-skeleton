// Is this folder still logged in to claude.ai? (design note v0.2 §5.2, §7.5). An endpoint launch
// and an endpoint plan are refused while it is: Claude Code's 401 recovery adopts a stored
// accessToken over the env token [CC §7], so a stored grant could reach the endpoint, and the
// plan's clear would erase `oauthAccount`, the one trace in the folder that a login exists.
//
// The stores, by name only: `.credentials.json` (the whole store on Linux), and on macOS the login
// keychain item keyed to the folder [CC §7]. The item's presence is asked by service name, with
// every byte of output discarded: its secret is never read.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readDoc } from '../../native.js';

// `security find-generic-password -s <service>` without -w reads attributes, never the secret;
// stdout and stderr go nowhere. It is called by its absolute path, so nothing on PATH stands in.
// Exit 0: an item exists; 44: none (observed on macOS 26.4.1); anything else: unknown.
// A locked login keychain can make the lookup raise an unlock dialog on the console, which may
// wait on a screen nobody watches (the user may be away from this screen): a lookup gets LOOKUP_MS, and one that
// gives no answer in time is killed and reported as `timeout`. The kill is SIGKILL: spawnSync's
// default SIGTERM can be ignored, and spawnSync then waits for the child past the limit.
export const SECURITY = '/usr/bin/security';
export const LOOKUP_MS = 5_000;
export function keychainItem(service, run = spawnSync, limit = LOOKUP_MS) {
  const p = run(SECURITY, ['find-generic-password', '-s', service], { stdio: 'ignore', timeout: limit, killSignal: 'SIGKILL' });
  if (p.error?.code === 'ETIMEDOUT' || p.signal) return { state: 'unknown', why: 'timeout' };
  if (p.error) return { state: 'unknown', why: p.error.code ?? 'not run' };
  if (p.status === 0) return { state: 'present' };
  if (p.status === 44) return { state: 'absent' };
  return { state: 'unknown', why: `exit ${p.status}` };
}

// A lookup's answer: { state, why? }; a bare state string is accepted too.
const answer = (r) => (typeof r === 'string' ? { state: r } : r ?? { state: 'unknown', why: 'no answer' });

// The keychain service names a login to this folder may have used: the item is keyed to the path
// as spelled when the login was made, so the given spelling and the real one are both asked, and
// the default folder's unsuffixed name too [CC §7, observed].
export function keychainServices(descriptor, folder, given, home) {
  const k = descriptor.launch.stored_login.keychain;
  const named = (p) => `${k.service}-${crypto.createHash('sha256').update(p).digest('hex').slice(0, k.hex)}`;
  const spellings = [...new Set([given, folder].filter((p) => typeof p === 'string' && p !== ''))];
  const out = spellings.map(named);
  let defaultFolder = null;
  try {
    defaultFolder = home ? fs.realpathSync.native(path.join(home, k.default_folder)) : null;
  } catch {
    // no default folder
  }
  if (defaultFolder === folder) out.push(k.service);
  return { services: [...new Set(out)], spellings };
}

// { present: [what shows a login], unverified: [what could not be ruled out] }.
export function storedLogin(folder, descriptor, { platform, keychain = keychainItem, given, home }) {
  const sl = descriptor.launch.stored_login;
  const present = [];
  const unverified = [];
  for (const f of sl.files) {
    try {
      fs.lstatSync(path.join(folder, f));
      present.push(f);
    } catch {
      // absent
    }
  }
  const doc = readDoc(path.join(folder, sl.account_trace.file));
  const traced = doc.doc && Object.hasOwn(doc.doc, sl.account_trace.key);
  const trace = `${sl.account_trace.file}#${sl.account_trace.key}`;
  if (platform === 'darwin') {
    const { services, spellings } = keychainServices(descriptor, folder, given, home);
    const found = [];
    let unknown = null;
    for (const s of services) {
      const r = answer(keychain(s));
      if (r.state === 'present') found.push(s);
      else if (r.state !== 'absent') {
        unknown = r.why ?? 'unknown';
        // No answer in time may mean an unlock dialog is up: asking again would raise another.
        if (r.why === 'timeout') break;
      }
    }
    if (found.length) present.push(...found.map((s) => `keychain item "${s}"`));
    else if (unknown && traced) present.push(`${trace}, with the keychain not answering (${unknown}): the login cannot be ruled out`);
    if (unknown && !found.length) {
      unverified.push(`the login keychain did not answer whether this folder holds a claude.ai login (${unknown}). It may be locked; on a console session the lookup can then raise an unlock dialog, which hs does not wait for${unknown === 'timeout' ? ', and hs asked no further names' : ''}. A folder that was ever logged in must not be used for an endpoint launch`);
    }
    unverified.push(`the keychain item is keyed to the folder path as spelled at login [CC §7]; hs asked for ${spellings.join(' and ')}, and another spelling cannot be ruled out`);
  }
  // On Linux .credentials.json is the whole store [CC §7], so oauthAccount alone is a stale cache.
  return { present, unverified, traced };
}

export function refuseLoggedIn(login) {
  return {
    code: 'login_present',
    message: `this folder holds a claude.ai login (${login.present.join('; ')}); an endpoint launch needs a folder with no login, or the login could reach the endpoint. Use a fresh folder`,
  };
}
