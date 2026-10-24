// @agent-realm/skeleton-spec stays self-contained: hs and the reference harness both import it,
// and it imports nothing from either (the reference-harness design note, question 5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as spec from '@agent-realm/skeleton-spec';
import { readToml } from '@agent-realm/skeleton-spec/files';
import { processProblems } from '@agent-realm/skeleton-spec/process';

const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const own = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));

test('the exports: resolve, validate, the process checks and the readers', () => {
  for (const name of ['resolve', 'readLayer', 'validate', 'validateLayers', 'skillName', 'processProblems']) {
    assert.equal(typeof spec[name], 'function', name);
  }
  assert.ok(Array.isArray(spec.HOOK_EVENTS));
  assert.equal(typeof readToml, 'function');
  assert.equal(spec.processProblems, processProblems);
  assert.deepEqual(processProblems('mcp.x', { exec: 'node', args: ['${HOME}'] }).map((p) => p.code), ['interpolation_refused']);
});

test('every import is a node: builtin, a path inside the package, or one of its own dependencies; never hs', () => {
  const allowed = new Set(Object.keys(own.dependencies ?? {}));
  const files = fs.readdirSync(path.join(pkg, 'src')).filter((n) => n.endsWith('.js')).map((n) => path.join(pkg, 'src', n));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const m of text.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./')) {
        assert.ok(path.resolve(path.dirname(file), spec).startsWith(path.join(pkg, 'src') + path.sep), `${file}: ${spec} leaves the package`);
        continue;
      }
      assert.ok(allowed.has(spec), `${path.basename(file)}: ${spec} is not a dependency of the package`);
    }
  }
});
