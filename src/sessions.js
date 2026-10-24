// The §7.3 shim over the session adapters package (@agent-realm/session-adapters, maintained with
// memhouse). `hs` reads no harness store itself: its `sessions.*` operations pass sessions v1 §2's
// JSON straight through to the package, and map the package's typed errors onto the envelope's.

import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, SessionsError } from '@agent-realm/session-adapters';
import { harnessPath as storePath } from '@agent-realm/session-adapters/harness-path';
import { HsError } from './protocol.js';
import { harnessPath } from './harness-path.js';
import { hostId } from './host.js';

// The read errors the package marks retryable (the sessions contract); the envelope says so in
// `error.retryable`. Only for an operation that reads the store: `derive` is pure, so an error
// there comes from the request's own units and recurs on every resend.
export const RETRYABLE = Object.freeze(['busy', 'inconsistent', 'damaged']);

// A package error keeps its code; anything else is an internal error and is rethrown as is.
// `reads` says whether the operation reads the store (list, read), where a retry can see a store
// that has settled.
export function toHsError(e, { reads = true } = {}) {
  if (e instanceof SessionsError || (e && typeof e.code === 'string' && e.name === 'SessionsError')) {
    const items = Array.isArray(e.items) ? e.items : [];
    return new HsError(e.code, e.message, items, { retryable: reads && RETRYABLE.includes(e.code) });
  }
  return e;
}

function pass(fn, opts) {
  try {
    return fn();
  } catch (e) {
    throw toHsError(e, opts);
  }
}

export function adapterFor(harness) {
  const a = ADAPTERS[harness];
  if (!a) throw new HsError('not_implemented', `no session adapter for ${harness} in @agent-realm/session-adapters yet`, [harness]);
  return a;
}

// Where a harness keeps its session stores: the package's `describe().store_shape` (sessions v1
// §2), `{kind: 'folder'}` or `{kind: 'file', default, names}`. The package owns
// that fact, as it owns the reader; a harness it has no adapter for keeps them in the data folder.
const storeLayout = (harness) => ADAPTERS[harness]?.describe().store_shape ?? { kind: 'folder' };

// The harness store this host and binding give: {host, harness, harness_path} (sessions-model §1).
// hs binds a harness to its data folder, always a directory. For a harness whose stores are files,
// `store` names one: a file name inside the folder, which must stay inside it once every link is
// resolved, or an absolute path, the documented way to name a store elsewhere (an OPENCODE_DB);
// only an absent `store` means the default. Its key is the file's real path, from the package,
// never the folder.
export function storeFor(harness, given, opts = {}, store = undefined) {
  const host = hostId(opts.host).host;
  const folder = harnessPath(given);
  const layout = storeLayout(harness);
  if (layout.kind !== 'file') {
    if (store !== undefined) throw new HsError('bad_request', `${harness} keeps its sessions in the data folder; args.store is for a harness whose stores are files`, ['store']);
    return { host, harness, harness_path: folder };
  }
  const name = store === undefined ? layout.default : store;
  const absolute = typeof name === 'string' && path.isAbsolute(name);
  if (typeof name !== 'string' || name === '' || (!absolute && (name.includes('/') || name.includes('\\') || name === '.' || name === '..'))) {
    throw new HsError('bad_request', 'args.store must be a file name inside the data folder, or an absolute path', ['store']);
  }
  const file = absolute ? name : path.join(folder, name);
  let real;
  try {
    real = storePath(file);
  } catch (e) {
    const err = toHsError(e);
    if (err.code === 'folder_missing') throw new HsError('folder_missing', `no ${harness} store at ${file}`, [file]);
    throw err;
  }
  if (!absolute) {
    const rel = path.relative(folder, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new HsError('bad_request', `the store ${name} resolves outside the data folder, to ${real}; name a store elsewhere by its absolute path`, ['store']);
    }
  }
  if (!fs.statSync(real).isFile()) throw new HsError('bad_request', `a ${harness} store is a database file, not ${real}`, [real]);
  return { host, harness, harness_path: real };
}

const KEY_FIELDS = ['host', 'harness', 'harness_path', 'session_id', 'incarnation'];

// A session key must name this harness store: another host or folder is another session
// (sessions-model §1 rule 1), so it is refused rather than read.
function checkSession(session, store) {
  if (!session || typeof session !== 'object' || KEY_FIELDS.some((k) => !(k in session))) {
    throw new HsError('bad_request', `args.session must be a session key {${KEY_FIELDS.join(', ')}}`);
  }
  for (const k of ['host', 'harness', 'harness_path']) {
    if (session[k] !== store[k]) throw new HsError('session_unknown', `the session's ${k} is not this harness store's; another ${k} is another session`, [k]);
  }
}

export function describeSessions(harness) {
  const a = ADAPTERS[harness];
  return a ? pass(() => a.describe()) : null;
}

export function list(harness, args, opts) {
  const a = adapterFor(harness);
  const store = storeFor(harness, args.harness_path, opts, args.store);
  return { store, sessions: pass(() => a.list(store)) };
}

export function read(harness, args, opts) {
  const a = adapterFor(harness);
  const store = storeFor(harness, args.harness_path, opts, args.store);
  checkSession(args.session, store);
  if (typeof args.source_key !== 'string') throw new HsError('bad_request', 'args.source_key is required');
  return { store, ...pass(() => a.read(store, args.session, args.source_key, args.from ?? null, args.known ?? null)) };
}

// Pure: it never touches the harness store (sessions §2), so it needs no binding.
export function derive(harness, args) {
  const a = adapterFor(harness);
  if (!Array.isArray(args.input)) throw new HsError('bad_request', 'args.input must be a list of source inputs');
  if (!args.session || typeof args.session !== 'object') throw new HsError('bad_request', 'args.session must be a session key');
  return pass(() => a.derive(args.session, args.input, args.state ?? null), { reads: false });
}
