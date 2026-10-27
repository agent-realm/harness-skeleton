// Shared by the examples: one of this package's fixture cases, as a harness store in a scratch
// directory. The plain files of the case are copied, and its databases (`store-sql/`) are built
// from their schema and statements by the conformance suite's builder. The fixture itself is never
// written, and nothing outside the scratch directory is.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, harnessPath } from '@agent-realm/harness-session-adapters';
import { hostFromMachineId } from '@agent-realm/harness-session-adapters/host';
import { prepareStore, caseHarnessPath } from '../conformance/sql-store.js';

export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

// A real consumer calls host() once and keeps its `host`. The examples derive it from a synthetic
// machine id instead, so that what they print is the same on every machine.
export const HOST = hostFromMachineId('00000000000040008000000000000001');

// The fixture cases of one harness: every directory with a reviewed golden, sorted.
export function fixtureCases(harness) {
  const dir = path.join(FIXTURES, harness);
  return fs.readdirSync(dir)
    .filter((c) => fs.existsSync(path.join(dir, c, 'expected.json')))
    .sort();
}

// The harness and the fixture case an example was asked for on its command line, `[harness]
// [case]`, or the defaults. An unknown harness or case ends the example with the choices.
export function fixtureArgs(argv = process.argv.slice(2), { harness = 'claude-code', caseName } = {}) {
  const h = argv[0] ?? harness;
  if (!ADAPTERS[h]) {
    console.error(`no adapter for ${h}: one of ${Object.keys(ADAPTERS).join(', ')}`);
    process.exit(2);
  }
  const cases = fixtureCases(h);
  const c = argv[1] ?? (h === harness && caseName ? caseName : cases[0]);
  if (!cases.includes(c)) {
    console.error(`no fixture case ${h}/${c}: one of ${cases.join(', ')}`);
    process.exit(2);
  }
  return { harness: h, caseName: c };
}

// A fixture case as a store: `{store, dir, close}`. `store` is the `{host, harness, harness_path}`
// every operation takes; `dir` the scratch directory; `close()` removes it.
export function openFixture(harness, caseName) {
  const caseDir = path.join(FIXTURES, harness, caseName);
  if (!fs.existsSync(path.join(caseDir, 'expected.json'))) {
    throw new Error(`no fixture case ${harness}/${caseName}: try one of ${fixtureCases(harness).join(', ')}`);
  }
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-example-')));
  try {
    prepareStore(caseDir, dir);
    // The data folder, or for OpenCode the database file inside it (the case's binding.json).
    const store = { host: HOST, harness, harness_path: harnessPath(caseHarnessPath(caseDir, dir)) };
    return { store, dir, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

// A source_key as the examples print it. Most are relative to the store already; a few (OpenCode's
// spilled outputs) are absolute, and are shown relative to the scratch directory instead.
export function shown(sourceKey, dir) {
  return path.isAbsolute(sourceKey) ? path.relative(dir, sourceKey) : sourceKey;
}
