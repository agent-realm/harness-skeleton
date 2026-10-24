#!/usr/bin/env node
// The hook shim for Codex (design note §5.6): the shared core (./core.js) with Codex's hook
// table. Codex lets a PreToolUse call through when its hook fails, stalls, or exits 2 with an
// empty stderr [CX §11], so the shim stops the process at --timeout and decides, and every block
// carries a reason.

import { CODEX_HOOKS } from './codex-hooks.js';
import { mainIf, parseArgs, shimFor } from './core.js';

export const { toolClass, envelope, block, translate } = shimFor(CODEX_HOOKS);
export { parseArgs };

mainIf(CODEX_HOOKS, import.meta.url);
