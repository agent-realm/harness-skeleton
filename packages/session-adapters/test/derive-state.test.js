// A consumer persists derive's `state` as JSON and hands it back on the next pass (sessions v1 §2, `derive`),
// so the state must survive a JSON round trip unchanged: no undefined, no NaN or Infinity, no Map,
// Set, Buffer or Date, no object without Object.prototype. Checked after a full replay of every
// fixture case of every adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../src/index.js';
import { fullReplay, tmpStore } from '../conformance/runner.js';
import { prepareStore, caseHarnessPath } from '../conformance/sql-store.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

for (const h of Object.keys(ADAPTERS).sort()) {
  test(`${h}: after a full replay of every fixture case, each session's derive state is plain JSON`, () => {
    let sessions = 0;
    for (const c of fs.readdirSync(path.join(FIX, h), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      const dir = tmpStore('sa-state-');
      try {
        const caseDir = path.join(FIX, h, c);
        prepareStore(caseDir, dir);
        const e = fullReplay(ADAPTERS[h], caseHarnessPath(caseDir, dir));
        for (const [id, s] of e.sessions) {
          assert.ok(s.state && typeof s.state === 'object', `${h}/${c} ${id}: a state`);
          assert.deepStrictEqual(s.state, JSON.parse(JSON.stringify(s.state)), `${h}/${c} ${id}`);
          sessions += 1;
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.ok(sessions > 0, `${h}: the fixtures hold sessions`);
  });
}
