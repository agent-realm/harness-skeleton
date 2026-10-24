// CommonJS consumers load this ES module package with require(). Node loads an ES module graph
// synchronously from require() (require(esm), on by default from Node 22.12) as long as no module
// in the graph has a top-level await. This keeps it so, on the Node running the tests. The test
// runner globs `test/*.test.js` only, so the CommonJS side runs in a child process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESSES = ['agy', 'claude-code', 'codex', 'copilot-cli', 'cursor', 'cursor-agent', 'devin', 'gemini-cli', 'goose', 'opencode', 'vscode', 'zed'];

test('CommonJS: a require of the package entry loads all twelve adapters', () => {
  const script = [
    "const m = require('@agent-realm/session-adapters');",
    'const out = {};',
    'for (const [h, a] of Object.entries(m.ADAPTERS)) {',
    "  for (const f of ['describe', 'list', 'read', 'derive']) if (typeof a[f] !== 'function') throw new Error(h + ' has no ' + f);",
    '  out[h] = a.describe().harness;',
    '}',
    "for (const f of ['adapterFor', 'unitsFromBytes', 'host', 'harnessPath']) if (typeof m[f] !== 'function') throw new Error('no export ' + f);",
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=commonjs', '-e', script], { cwd: PKG, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(out), Object.fromEntries(HARNESSES.map((h) => [h, h])));
});
