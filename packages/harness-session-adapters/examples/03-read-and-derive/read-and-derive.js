// Example 03: read one session's sources from the start, and derive its records.
//   node examples/03-read-and-derive/read-and-derive.js [harness] [case]   (default: claude-code basic)
// The first session of the case is read. The store is a fixture case in a scratch directory.

import { adapterFor } from '@agent-realm/harness-session-adapters';
import { validateSession } from '@agent-realm/harness-session-adapters/validate';
import { fixtureArgs, openFixture, shown } from '../fixture-store.js';

// One source, read to its end. A read returns at most 64 MiB and says `more: true`; the next read,
// from the position it returned, goes on.
function readToEnd(adapter, store, session, sourceKey, from, known) {
  const r = adapter.read(store, session, sourceKey, from, known);
  while (r.more) {
    const next = adapter.read(store, session, sourceKey, r.position, null);
    r.units.push(...next.units);
    r.position = next.position;
    r.held_back = next.held_back;
    r.more = next.more;
  }
  return r;
}

const { harness, caseName } = fixtureArgs();
const adapter = adapterFor(harness);
const { store, dir, close } = openFixture(harness, caseName);
try {
  const [s] = adapter.list(store);
  // The full session key: the store, the session id and its incarnation.
  const session = { ...store, session_id: s.session_id, incarnation: s.incarnation };
  console.log(`== ${harness}/${caseName}: session ${s.session_id}`);

  // read: every source from the start (no position, nothing known). A first read is a `reset`:
  // every unit of the source. A partial last line is held back, never returned.
  const input = [];
  for (const src of s.sources) {
    const r = readToEnd(adapter, store, session, src.source_key, null, null);
    console.log(`read ${shown(src.source_key, dir)}: ${r.continuity}, ${r.units.length} unit(s), ${r.held_back.length} held back`);
    input.push({ source_key: src.source_key, generation: 1, complete: true, units: r.units, gone: [] });
  }

  // derive: pure, no I/O. On a first derive the state is null and every source is complete, so
  // `changed` holds every record of the session.
  const out = adapter.derive(session, input, null);
  console.log(`\n== derive: adapter_ver ${out.adapter_ver}, ${out.model_version}, state_ver ${out.state_ver}, checkpoint ${out.checkpoint}`);
  const types = ['session', 'message', 'usage', 'link', 'lifecycle'];
  const count = (type) => out.changed.filter((r) => r.type === type).length;
  console.log(`changed  ${types.map((t) => `${t} ${count(t)}`).join(', ')}`);
  // `live` and `held` always carry all five record types, each a sorted list of keys.
  console.log(`live     ${types.map((t) => `${t} ${out.live[t].length}`).join(', ')}`);
  console.log(`held     ${types.map((t) => `${t} ${out.held[t].length}`).join(', ')}`);

  // `kind` is the harness's own session type, null where the store writes none. A sub-agent
  // session is told by its `subagent` link, not by its kind.
  const rec = out.changed.find((r) => r.type === 'session');
  console.log(`\n== the session record\ntitle ${JSON.stringify(rec.title)}, client ${rec.client}, harness_version ${rec.harness_version}, cwd ${rec.cwd}, kind ${rec.kind}`);

  // Messages in `order`, each with its parts' kinds and the start of its first text.
  const messages = out.changed.filter((r) => r.type === 'message').sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  console.log(`\n== the first messages, of ${messages.length}`);
  for (const m of messages.slice(0, 10)) {
    const kinds = m.parts.map((p) => (p.kind === 'tool_call' ? `tool_call(${p.name})` : p.kind)).join(' ');
    const text = m.parts.find((p) => typeof p.text === 'string')?.text ?? '';
    const who = m.agent_id ? `${m.role} [agent ${m.agent_id}]` : m.role;
    console.log(`${who.padEnd(10)} ${kinds.padEnd(28)} ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)}`);
  }

  // Tool results: `status` says whether the call completed; `is_error` is the harness store's own
  // flag for a call that completed, and null where the store keeps none, where it says success
  // beside a non-zero `exit_code`, and wherever `status` is cancelled or denied.
  const results = messages.flatMap((m) => m.parts.filter((p) => p.kind === 'tool_result'));
  console.log(`\n== tool results: status, is_error, exit_code, of ${results.length}`);
  for (const p of results.slice(0, 10)) {
    console.log(`${String(p.status).padEnd(10)} ${String(p.is_error).padEnd(6)} ${String(p.exit_code).padEnd(5)} ${p.call_id}`);
  }

  // Usage: each record's granularity and the kind of thing it is anchored to, and the two flags
  // that say what `input` and `output` count (null where nothing settles it). The usage records of
  // one session never overlap, so a total is their sum.
  const usage = out.changed.filter((r) => r.type === 'usage');
  const byShape = {};
  for (const u of usage) {
    const x = (byShape[`${u.granularity} ${Object.keys(u.anchor).join('+')}`] ??= { n: 0, input: 0, output: 0, cache: new Set(), reasoning: new Set() });
    x.n += 1;
    x.input += u.input ?? 0;
    x.output += u.output ?? 0;
    x.cache.add(String(u.input_includes_cache));
    x.reasoning.add(String(u.output_includes_reasoning));
  }
  console.log(`\n== usage: granularity and anchor, of ${usage.length}`);
  for (const [shape, x] of Object.entries(byShape).sort()) {
    console.log(`${shape.padEnd(26)} ${x.n} record(s), input ${x.input}, output ${x.output}; input_includes_cache ${[...x.cache].join('/')}, output_includes_reasoning ${[...x.reasoning].join('/')}`);
  }

  // Links: how this session relates to another, from the side that states it.
  const links = out.changed.filter((r) => r.type === 'link');
  console.log(`\n== links, of ${links.length}`);
  for (const l of links) {
    const other = l.stated_on === 'child' ? l.origin : l.child;
    console.log(`${l.kind.padEnd(10)} stated on the ${l.stated_on}, the other side ${other.harness} ${other.session_id}`);
  }

  // validateSession checks the records against the contract's record shapes. A writer can run it
  // before it writes; a finding with `warning: true` names a registry value it does not know.
  const findings = validateSession(out.changed, { harness, sessionId: s.session_id });
  console.log(`\n== validateSession: ${findings.length} finding(s)`);
  for (const f of findings) console.log(`${f.at}: ${f.problem}${f.warning ? ' (warning)' : ''}`);
} finally {
  close();
}
