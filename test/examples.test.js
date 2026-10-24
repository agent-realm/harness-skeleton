// The examples (examples/*/run.sh) run as documented: each in a scratch directory, against the
// stand-in harness binaries in examples/bin, so no real harness starts and no real data folder
// is read or written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from './fixtures.js';

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));
const examples = fs.readdirSync(EXAMPLES).filter((d) => /^\d\d-/.test(d)).sort();

test('every example has a README and a run.sh, numbered from 01 without gaps', () => {
  assert.ok(examples.length >= 8);
  examples.forEach((d, i) => {
    assert.equal(d.slice(0, 2), String(i + 1).padStart(2, '0'), d);
    for (const f of ['README.md', 'run.sh']) assert.ok(fs.existsSync(path.join(EXAMPLES, d, f)), `${d}/${f}`);
  });
  const index = fs.readFileSync(path.join(EXAMPLES, 'README.md'), 'utf8');
  for (const d of examples) assert.ok(index.includes(`(${d}/)`), `examples/README.md lists ${d}`);
});

for (const d of examples) {
  test(`example ${d} runs and exits 0`, () => {
    const work = tmpdir('hs-example-test-');
    try {
      const r = spawnSync('sh', [path.join(EXAMPLES, d, 'run.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: work, TMPDIR: work, WORK: path.join(work, 'work') } });
      assert.equal(r.status, 0, `${d}:\n${r.stdout}\n${r.stderr}`);
      assert.equal(r.stderr, '', `${d} wrote to stderr:\n${r.stderr}`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}
