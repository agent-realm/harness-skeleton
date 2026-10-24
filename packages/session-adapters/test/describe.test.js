// Every adapter's describe() states what its harness_path names (sessions-model §1), so a consumer
// such as hs reads it instead of keeping its own table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
test('describe: every adapter states what its harness_path names', async () => {
  const { ADAPTERS } = await import('../src/index.js');
  for (const [h, a] of Object.entries(ADAPTERS)) {
    let d;
    try {
      d = a.describe();
    } catch {
      continue; // a placeholder still being written
    }
    assert.ok(d.store_shape && ['folder', 'file'].includes(d.store_shape.kind), `${h}: describe().store_shape`);
    if (d.store_shape.kind === 'file') assert.ok(typeof d.store_shape.default === 'string' && Array.isArray(d.store_shape.names), h);
  }
  assert.deepEqual(ADAPTERS.opencode.describe().store_shape, { kind: 'file', default: 'opencode.db', names: ['opencode.db', 'opencode-<channel>.db'] });
});

// describe() and derive must agree on the versions a consumer persists by (docs/adapter-interface.md
// "Versions"): a state_ver bump in derive that describe misses would hide a needed refold.
test('describe: every adapter states the adapter_ver, model_version and state_ver its derive returns', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { ADAPTERS } = await import('../src/index.js');
  const { tmpStore, copyTree, fullReplay } = await import('../conformance/runner.js');
  const { prepareStore, caseHarnessPath } = await import('../conformance/sql-store.js');
  const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
  for (const [h, adapter] of Object.entries(ADAPTERS)) {
    const d = adapter.describe();
    const c = fs.readdirSync(path.join(FIX, h)).find((x) => fs.existsSync(path.join(FIX, h, x, 'expected.json')));
    const caseDir = path.join(FIX, h, c);
    const store = tmpStore('describe-');
    try {
      if (fs.existsSync(path.join(caseDir, 'store-sql'))) prepareStore(caseDir, store);
      else copyTree(path.join(caseDir, 'store'), store);
      const e = fullReplay(adapter, caseHarnessPath(caseDir, store));
      const outs = [...e.sessions.values()].map((s) => s.last).filter(Boolean);
      assert.ok(outs.length > 0, `${h}/${c} derives a session`);
      for (const o of outs) assert.deepEqual([o.adapter_ver, o.model_version, o.state_ver], [d.adapter_ver, d.model_version, d.state_ver], h);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  }
});
