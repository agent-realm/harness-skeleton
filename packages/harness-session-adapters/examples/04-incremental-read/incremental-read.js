// Example 04: read on from a saved position, pass after pass, as a consumer does.
//   node examples/04-incremental-read/incremental-read.js
// One Claude Code transcript (fixture claude-code/features) is played back as a harness writes it:
// part of it, then the rest, then nothing new, then a rewrite. Between passes the consumer keeps
// only what it would persist: each source's position and generation, the derive state, and the
// live keys. Here that is a JSON string; a real consumer writes it to its own storage, never into
// the harness store.

import fs from 'node:fs';
import path from 'node:path';
import { adapterFor } from '@agent-realm/harness-session-adapters';
import { openFixture } from '../fixture-store.js';

const TYPES = ['session', 'message', 'usage', 'link', 'lifecycle'];
const counts = (keys) => TYPES.map((t) => `${t} ${(keys[t] ?? []).length}`).join(', ');

const adapter = adapterFor('claude-code');
const { store, close } = openFixture('claude-code', 'features');
try {
  const [s] = adapter.list(store);
  const session = { ...store, session_id: s.session_id, incarnation: s.incarnation };
  const sourceKey = s.sources[0].source_key; // the session's one transcript
  const file = path.join(store.harness_path, sourceKey);
  const whole = fs.readFileSync(file);
  const lineEnds = [...whole.keys()].filter((i) => whole[i] === 0x0a).map((i) => i + 1);

  // Pass 1: the harness has written 8 lines and half of the 9th.
  const cut = lineEnds[7] + Math.floor((lineEnds[8] - lineEnds[7]) / 2);
  fs.truncateSync(file, cut);
  const r1 = adapter.read(store, session, sourceKey, null, null);
  const d1 = adapter.derive(session, [{ source_key: sourceKey, generation: 1, complete: true, units: r1.units, gone: [] }], null);
  console.log('== pass 1: 8 lines and half of the 9th; no saved position');
  console.log(`read    ${r1.continuity}: ${r1.units.length} unit(s); held back: ${r1.held_back.map((h) => `${h.bytes} bytes at ${h.unit_key}`).join(', ')}`);
  console.log(`derive  state null, complete: ${d1.changed.length} record(s) changed`);
  console.log(`live    ${counts(d1.live)}`);
  let saved = JSON.stringify({ position: r1.position, generation: 1, state: d1.state, live: d1.live });
  console.log(`saved   position at offset ${r1.position.offset}, generation 1, the derive state`);

  // Pass 2: the harness appends the rest of the file, in place.
  fs.appendFileSync(file, whole.subarray(cut));
  let p = JSON.parse(saved);
  const r2 = adapter.read(store, session, sourceKey, p.position, null);
  const d2 = adapter.derive(session, [{ source_key: sourceKey, generation: p.generation, complete: false, units: r2.units, gone: [] }], p.state);
  const added = TYPES.reduce((n, t) => n + d2.live[t].filter((k) => !(p.live[t] ?? []).includes(k)).length, 0);
  console.log('\n== pass 2: the rest of the file appended');
  console.log(`read    ${r2.continuity}: ${r2.units.length} unit(s), the first being the line held back in pass 1 (unit ${r2.units[0].unit_key})`);
  console.log(`derive  saved state, only the new units: ${d2.changed.length} record(s) changed, ${added} of them new keys`);
  console.log(`live    ${counts(d2.live)}`);
  saved = JSON.stringify({ position: r2.position, generation: p.generation, state: d2.state, live: d2.live });

  // Pass 3: nothing new. Nothing to derive.
  p = JSON.parse(saved);
  const r3 = adapter.read(store, session, sourceKey, p.position, null);
  console.log('\n== pass 3: nothing written');
  console.log(`read    ${r3.continuity}: ${r3.units.length} unit(s); no derive`);

  // Pass 4: the harness rewrites the file shorter, through a new file renamed over it (a new
  // inode), as a rewind can. The read says `reset`: the consumer starts a new generation and
  // derives it from empty state, with every unit. Keys live before and now in neither `live` nor
  // `held` are gone, and the consumer tombstones them. A held key keeps its last written version.
  const tmp = `${file}.rewrite`;
  fs.writeFileSync(tmp, whole.subarray(0, lineEnds[4]));
  fs.renameSync(tmp, file);
  const r4 = adapter.read(store, session, sourceKey, p.position, null);
  const d4 = adapter.derive(session, [{ source_key: sourceKey, generation: p.generation + 1, complete: true, units: r4.units, gone: [] }], null);
  const gone = Object.fromEntries(TYPES.map((t) => [t, (p.live[t] ?? []).filter((k) => !d4.live[t].includes(k) && !d4.held[t].includes(k))]));
  console.log('\n== pass 4: the file rewritten with its first 5 lines');
  console.log(`read    ${r4.continuity}: ${r4.units.length} unit(s), from offset ${r4.units[0].unit_key}`);
  console.log(`derive  generation ${p.generation + 1}, state null, complete: ${d4.changed.length} record(s) changed`);
  console.log(`live    ${counts(d4.live)}`);
  console.log(`gone    ${counts(gone)}`);
} finally {
  close();
}
