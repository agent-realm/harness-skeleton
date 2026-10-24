#!/usr/bin/env node
// The hook shim for Claude Code (design note §5.6): the shared core (./core.js) with Claude
// Code's hook table. On PermissionRequest exit 2 is not honoured, so a block there is the decision
// object {behavior: "deny"}, on exit 0 [D-hooks]. Claude Code cancels a hook at its timeout and
// goes on, so the shim stops the process itself at --timeout and decides.

import { CLAUDE_CODE_HOOKS } from './claude-code-hooks.js';
import { mainIf, parseArgs, shimFor } from './core.js';

export const { toolClass, envelope, block, translate } = shimFor(CLAUDE_CODE_HOOKS);
export { parseArgs };

mainIf(CLAUDE_CODE_HOOKS, import.meta.url);
