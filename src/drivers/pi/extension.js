// The launch extension's source for one launch (design note §7.5): the runtime
// (./extension-runtime.js) with the launch's configuration written in place of its marker, as
// JSON.stringify of one whole object. JSON is a JavaScript expression, so no spec value in it, a
// quote, a backtick, `${`, `*/` or a line break included, is ever code.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HsError } from '../../protocol.js';

const RUNTIME = fileURLToPath(new URL('./extension-runtime.js', import.meta.url));
const MARKER = '/* hs:config */ null';

// `config`: { provider: {id, config} | null, mcp: [[name, config], ...] }.
export function extensionSource(config) {
  const text = fs.readFileSync(RUNTIME, 'utf8');
  if (text.split(MARKER).length !== 2) throw new HsError('internal', 'the pi launch extension runtime does not hold its configuration marker exactly once', []);
  // A function, so no `$` in a value is read as a replacement pattern.
  return text.replace(MARKER, () => JSON.stringify(config));
}
