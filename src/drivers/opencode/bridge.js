// The hooks bridge's source for one launch (design note §5.6, §8): the bridge runtime
// (src/shim/opencode-bridge.js) with the launch's configuration written in place of its marker. The
// configuration names the node that runs the shim, the shim, and each hook: its id, event, the plugin
// hook it rides on, its matcher (an anchored regex, or null for every tool), the shim's arguments and
// the limit. JSON is a JavaScript expression, so nothing in it is code.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HsError } from '../../protocol.js';

const RUNTIME = fileURLToPath(new URL('../../shim/opencode-bridge.js', import.meta.url));
export const SHIM = fileURLToPath(new URL('../../shim/opencode.js', import.meta.url));
const MARKER = '/* hs:config */ null';

export function bridgeSource({ id, node, shim, margin_ms, hooks }) {
  const text = fs.readFileSync(RUNTIME, 'utf8');
  if (text.split(MARKER).length !== 2) throw new HsError('internal', 'the bridge runtime does not hold its configuration marker exactly once', []);
  // A function, so no `$` in a path or matcher is read as a replacement pattern.
  return text.replace(MARKER, () => JSON.stringify({ id, node, shim, margin_ms, hooks }));
}
