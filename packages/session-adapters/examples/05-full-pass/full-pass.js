// Example 05: a first full pass over every fixture case of every harness, as a consumer's first
// capture: list, read every source to its end, derive, validate, and write every record as one
// line of JSON.
//   node examples/05-full-pass/full-pass.js [records.jsonl]
// With a path, the records go there as JSON Lines (the file is replaced). Without one, only the
// summary is printed. The summary holds nothing that depends on the machine it runs on.

import fs from 'node:fs';
import { ADAPTERS, SessionsError } from '@agent-realm/session-adapters';
import { validateSession } from '@agent-realm/session-adapters/validate';
import { fixtureCases, openFixture } from '../fixture-store.js';

// One source, read to its end: a read returns at most 64 MiB and says `more: true`.
function readToEnd(adapter, store, session, sourceKey) {
  const r = adapter.read(store, session, sourceKey, null, null);
  while (r.more) {
    const next = adapter.read(store, session, sourceKey, r.position, null);
    r.units.push(...next.units);
    r.position = next.position;
    r.more = next.more;
  }
  return r;
}

const outFile = process.argv[2];
const out = outFile ? fs.openSync(outFile, 'w') : null;
const totals = { cases: 0, sessions: 0, records: 0, findings: 0, errors: 0 };
try {
  console.log(`${'harness'.padEnd(13)} ${'case'.padEnd(27)} ${'sessions'.padStart(8)} ${'records'.padStart(8)}  findings`);
  for (const [harness, adapter] of Object.entries(ADAPTERS)) {
    for (const caseName of fixtureCases(harness)) {
      const { store, close } = openFixture(harness, caseName);
      const row = { sessions: 0, records: 0, findings: 0, errors: [] };
      try {
        for (const s of adapter.list(store)) {
          const session = { ...store, session_id: s.session_id, incarnation: s.incarnation };
          try {
            const input = s.sources.map((src) => ({
              source_key: src.source_key, generation: 1, complete: true, units: readToEnd(adapter, store, session, src.source_key).units, gone: [],
            }));
            const d = adapter.derive(session, input, null);
            // A finding that is not a warning means a record breaks the contract's shapes: a
            // writer would stop here rather than store it.
            row.findings += validateSession(d.changed, { harness, sessionId: s.session_id }).filter((f) => !f.warning).length;
            if (out !== null) for (const r of d.changed) fs.writeSync(out, `${JSON.stringify(r)}\n`);
            row.records += d.changed.length;
            row.sessions += 1;
          } catch (e) {
            // busy, inconsistent and damaged are retryable: a consumer leaves the session for its
            // next pass. Any other error is a bug here, and stops the example.
            if (!(e instanceof SessionsError)) throw e;
            row.errors.push(`${s.session_id}: ${e.code}`);
          }
        }
      } finally {
        close();
      }
      const errors = row.errors.length ? `  errors: ${row.errors.join(', ')}` : '';
      console.log(`${harness.padEnd(13)} ${caseName.padEnd(27)} ${String(row.sessions).padStart(8)} ${String(row.records).padStart(8)}  ${row.findings}${errors}`);
      totals.cases += 1;
      totals.sessions += row.sessions;
      totals.records += row.records;
      totals.findings += row.findings;
      totals.errors += row.errors.length;
    }
  }
} finally {
  if (out !== null) fs.closeSync(out);
}
console.log(`\n${totals.cases} cases, ${totals.sessions} sessions, ${totals.records} records, ${totals.findings} findings, ${totals.errors} errors`);
if (outFile) console.log(`${totals.records} records written as JSON Lines`);
if (totals.findings || totals.errors) process.exitCode = 1;
