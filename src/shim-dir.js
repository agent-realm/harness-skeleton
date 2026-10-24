// hs's hook shim, self-contained (src/shim/): the one source outside a plan's layers, copied into
// a folder's hs-run/hook-shim/ for persisted hooks (design note §7.5).

import { fileURLToPath } from 'node:url';

export const SHIM_DIR = fileURLToPath(new URL('./shim', import.meta.url));
