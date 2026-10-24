// Writes expected.json for every fixture case of one harness from a full replay:
//   node conformance/golden.js <harness>
// A golden is reviewed by hand before it is committed; the test then holds the adapter to it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../src/index.js';
import { fullReplay, project, tmpStore } from './runner.js';
import { prepareStore, caseHarnessPath } from './sql-store.js';

const harness = process.argv[2];
const adapter = adapterFor(harness);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', harness);
for (const c of fs.readdirSync(root, { withFileTypes: true })) {
  if (!c.isDirectory()) continue;
  const dir = tmpStore();
  try {
    prepareStore(path.join(root, c.name), dir);
    const out = project(fullReplay(adapter, caseHarnessPath(path.join(root, c.name), dir)).views());
    fs.writeFileSync(path.join(root, c.name, 'expected.json'), JSON.stringify(out, null, 2) + '\n');
    console.log(`${harness}/${c.name}: ${Object.values(out).reduce((n, r) => n + r.length, 0)} records`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
