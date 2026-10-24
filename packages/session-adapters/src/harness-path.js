// `harness_path`: the real path of the data folder, or the one database file, a harness is bound to
// (sessions-model §1).
// Absolute, every symlink resolved, each component in the case the filesystem stores, no
// trailing slash, compared as bytes. The native resolver gives the on-disk case on
// case-insensitive APFS and HFS+; `fs.realpathSync` without `.native` keeps the spelling it was
// given, so it is wrong here. An adapter never lowercases or otherwise normalises the path itself.

import fs from 'node:fs';
import path from 'node:path';
import { SessionsError } from './errors.js';

export function harnessPath(given) {
  if (typeof given !== 'string' || given === '') {
    throw new SessionsError('bad_request', 'harness_path is required');
  }
  if (!path.isAbsolute(given)) {
    throw new SessionsError('bad_request', `harness_path must be absolute: ${given}`, [given]);
  }
  let real;
  try {
    real = fs.realpathSync.native(given);
  } catch (e) {
    throw new SessionsError('folder_missing', `harness path not found: ${given} (${e.code})`, [given]);
  }
  // A folder, or a single database file the harness is bound to (OpenCode's channel DBs and
  // OPENCODE_DB: sessions-model §1). Anything else is refused.
  const st = fs.statSync(real);
  if (!st.isDirectory() && !st.isFile()) {
    throw new SessionsError('bad_request', `harness_path is neither a folder nor a file: ${real}`, [real]);
  }
  // A root (`/`, `C:\`) keeps its separator; anything else loses a trailing one.
  return real === path.parse(real).root ? real : real.replace(/[\\/]+$/, '');
}
