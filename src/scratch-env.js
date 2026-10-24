// The environment a harness binary is run under when the adapter probes it (`detect`):
// HOME, the four XDG roots, TMPDIR and the harness's own binding variable all point into a
// fresh scratch directory, so a probe can never write into a real data folder. OpenCode, for
// one, creates directories on `--version` (2026-10-04). The variables are checked before
// every spawn, and nothing is inherited except PATH.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HsError } from './protocol.js';

export const SCRATCH_VARS = Object.freeze(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']);

// `root`, when given, is a temp root the caller has already checked (launch-spec: outside the
// data folder); otherwise the process's temp dir.
export function makeScratch(prefix = 'hs-scratch-', root = os.tmpdir()) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(root, prefix)));
}

export function scratchEnv(scratch, { bindingVar, extra = {} } = {}) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(scratch, 'home'),
    XDG_CONFIG_HOME: path.join(scratch, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(scratch, 'xdg', 'data'),
    XDG_CACHE_HOME: path.join(scratch, 'xdg', 'cache'),
    XDG_STATE_HOME: path.join(scratch, 'xdg', 'state'),
    TMPDIR: path.join(scratch, 'tmp'),
    ...extra,
  };
  if (bindingVar) env[bindingVar] = path.join(scratch, 'data-folder');
  for (const v of [...SCRATCH_VARS, ...(bindingVar ? [bindingVar] : [])]) fs.mkdirSync(env[v], { recursive: true });
  return env;
}

export function assertScratch(env, scratch, bindingVar) {
  const vars = [...SCRATCH_VARS, ...(bindingVar ? [bindingVar] : [])];
  const outside = vars.filter((v) => typeof env[v] !== 'string' || !env[v].startsWith(scratch + path.sep));
  if (outside.length) {
    throw new HsError('internal', `refusing to run a harness binary: ${outside.join(', ')} not inside the scratch directory`, outside);
  }
}
