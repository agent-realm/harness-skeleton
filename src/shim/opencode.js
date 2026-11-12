#!/usr/bin/env node
// The hook shim for OpenCode (design note §5.6): the shared core (./core.js) with OpenCode's hook
// table. hs's bridge plugin (./opencode-bridge.js) runs it for each spec hook, with the plugin event
// on stdin, and reads its exit code: 0 continues, 2 blocks with stderr as the reason.

import { OPENCODE_HOOKS } from './opencode-hooks.js';
import { mainIf, parseArgs, shimFor } from './core.js';

export const { toolClass, envelope, block, translate } = shimFor(OPENCODE_HOOKS);
export { parseArgs };

mainIf(OPENCODE_HOOKS, import.meta.url);
