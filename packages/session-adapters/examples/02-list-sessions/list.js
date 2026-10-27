// Example 02: list the sessions in a harness store, and each session's sources.
//   node examples/02-list-sessions/list.js [harness] [case]   (default: claude-code basic)
// The store is one of this package's fixture cases, copied into a scratch directory.

import { adapterFor } from '@agent-realm/session-adapters';
import { fixtureArgs, openFixture, shown } from '../fixture-store.js';

const { harness, caseName } = fixtureArgs();
const adapter = adapterFor(harness);
const { store, dir, close } = openFixture(harness, caseName);
try {
  // list(store) reads the store and writes nothing. Sessions come sorted by session_id.
  const sessions = adapter.list(store);
  console.log(`${harness}/${caseName}: ${sessions.length} session(s)`);
  for (const s of sessions) {
    // A session's key is the store plus these two. `updated_hint` changes whenever the session
    // does, so a consumer can skip a session whose hint has not moved since its last pass. It is
    // not printed: for a file store it hashes each file's size and modification time, so it
    // differs from one copy of the fixture to the next.
    console.log(`\n== session ${s.session_id}  incarnation ${JSON.stringify(s.incarnation)}  live ${s.live}`);
    for (const src of s.sources) {
      console.log(`${src.role.padEnd(8)} ${src.mode.padEnd(9)} ${src.position_kind.padEnd(16)} ${shown(src.source_key, dir)}`);
    }
  }
} finally {
  close();
}
