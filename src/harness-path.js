// `harness_path`, from the session adapters package: the bound data
// folder's real path, by sessions-model §1 (absolute, every symlink resolved, the on-disk case, no
// trailing slash), one implementation for every reader and for hs.

import fs from 'node:fs';
import { harnessPath as packageHarnessPath } from '@agent-realm/session-adapters/harness-path';
import { toHsError } from './sessions.js';
import { HsError } from './protocol.js';

// hs binds a harness to its data folder, always a directory. The package also accepts a database
// file, which a session key may use (every OpenCode store, sessions-model §1), but
// the binding never names one: a file given as --folder is refused here, as before.
export function harnessPath(given) {
  let real;
  try {
    real = packageHarnessPath(given);
  } catch (e) {
    throw toHsError(e);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new HsError('bad_request', `data folder is not a directory: ${real}`, [real]);
  }
  return real;
}
