// `host`, from the session adapters package: one implementation of
// sessions-model/host/v0 for memhouse, hs and the adapters, which the contract's known-answer
// vectors test. hs covers macOS and Linux only (design note §2), so it refuses Windows before
// asking the package, which defines Windows too.

import { host as packageHost, hostFromMachineId, HOST_SALT } from '@agent-realm/harness-session-adapters/host';
import { HsError } from './protocol.js';
import { toHsError } from './sessions.js';

export { hostFromMachineId, HOST_SALT };

export const HOST_PLATFORMS = Object.freeze(['darwin', 'linux']);

export function hostId(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (!HOST_PLATFORMS.includes(platform)) {
    throw new HsError('platform_unsupported', `host is derived on ${HOST_PLATFORMS.join(' and ')} only, not ${platform}`, [platform]);
  }
  try {
    return packageHost({ ...opts, platform });
  } catch (e) {
    throw toHsError(e);
  }
}
