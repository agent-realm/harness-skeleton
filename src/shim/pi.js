#!/usr/bin/env node
// The hook shim for pi (design note §5.6): the shared core (./core.js) with pi's hook table. hs's
// launch extension (src/drivers/pi/extension-runtime.js) runs it for each spec hook, with the pi
// event on stdin, and reads its exit code: 0 continues, 2 blocks with stderr as the reason.

import { PI_HOOKS } from './pi-hooks.js';
import { mainIf, parseArgs, shimFor } from './core.js';

export const { toolClass, envelope, block, translate } = shimFor(PI_HOOKS);
export { parseArgs };

mainIf(PI_HOOKS, import.meta.url);
