// A consumer persists derive's `state` as JSON and hands it back on the next pass (sessions v1 §2, `derive`),
// so the state must survive a JSON round trip unchanged: no undefined, no NaN or Infinity, no Map,
// Set, Buffer or Date, no object without Object.prototype. Checked after a full replay of every
// fixture case of every adapter, as is the shape of derive's `held`: the same five record types as
// `live`, each a list of keys (sessions v1 §2; docs/adapter-interface.md, "derive output").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../src/index.js';
import { fullReplay, tmpStore } from '../conformance/runner.js';
import { prepareStore, caseHarnessPath } from '../conformance/sql-store.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const TYPES = ['lifecycle', 'link', 'message', 'session', 'usage'];

// fn(case, session id, engine session) for every session of a full replay of every fixture case.
function eachSession(h, fn) {
  let sessions = 0;
  for (const c of fs.readdirSync(path.join(FIX, h), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const dir = tmpStore('sa-state-');
    try {
      const caseDir = path.join(FIX, h, c);
      prepareStore(caseDir, dir);
      const e = fullReplay(ADAPTERS[h], caseHarnessPath(caseDir, dir));
      for (const [id, s] of e.sessions) {
        fn(c, id, s);
        sessions += 1;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.ok(sessions > 0, `${h}: the fixtures hold sessions`);
}

for (const h of Object.keys(ADAPTERS).sort()) {
  test(`${h}: after a full replay of every fixture case, each session's derive state is plain JSON`, () => {
    eachSession(h, (c, id, s) => {
      assert.ok(s.state && typeof s.state === 'object', `${h}/${c} ${id}: a state`);
      assert.deepStrictEqual(s.state, JSON.parse(JSON.stringify(s.state)), `${h}/${c} ${id}`);
    });
  });

  test(`${h}: after a full replay of every fixture case, each session's derive held has live's five lists`, () => {
    eachSession(h, (c, id, s) => {
      const at = `${h}/${c} ${id}`;
      assert.deepEqual(Object.keys(s.last.live).sort(), TYPES, `${at}: live`);
      assert.deepEqual(Object.keys(s.last.held).sort(), TYPES, `${at}: held`);
      for (const t of TYPES) assert.ok(Array.isArray(s.last.held[t]) && s.last.held[t].every((k) => typeof k === 'string'), `${at}: held.${t}`);
    });
  });
}
