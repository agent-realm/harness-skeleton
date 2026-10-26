import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as adapter from '../src/harnesses/devin/index.js';
import { SOURCE, DB_REL } from '../src/harnesses/devin/index.js';
import { uuid, callId } from '../fixtures/devin/generate.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, tmpStore, storeOf, nameLint } from '../conformance/runner.js';
import { prepareStore, sqlGrowthCheck, sqlFilesOf, buildDb } from '../conformance/sql-store.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'devin');
const CASES = ['features'];
const EXEMPT = adapter.describe().redaction.exemptions;
const ID = (name) => uuid(name);

function withStore(name, fn) {
  const dir = tmpStore();
  try {
    prepareStore(path.join(FIX, name), dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const golden = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name, 'expected.json'), 'utf8'));
const ofType = (recs, type) => recs.filter((r) => r.type === type);
const msg = (recs, id) => recs.find((r) => r.type === 'message' && r.message_id === id);
const msgsInOrder = (recs) => ofType(recs, 'message').sort((a, b) => (a.order < b.order ? -1 : 1));
const keyOf = (store, sid) => ({ ...store, session_id: sid, incarnation: '' });
function lastDerive(e, sid) {
  for (const [id, s] of e.sessions) if (id.split('\u0000')[0] === sid) return s.last;
  return null;
}
// The one unit of a session, read whole, as derive input.
function inputOf(dir, sid) {
  const store = storeOf(adapter, dir);
  return [{ source_key: SOURCE, generation: 1, complete: true, units: adapter.read(store, keyOf(store, sid), SOURCE).units, gone: [] }];
}
const deriveDir = (dir, sid, state = null) => adapter.derive(keyOf(storeOf(adapter, dir), sid), inputOf(dir, sid), state);
// A unit's value with its JSON text columns parsed, so the lint looks inside them.
const JSON_COLS = ['chat_message', 'metadata', 'tool_call_update_json'];
function deep(v) {
  if (Array.isArray(v)) return v.map(deep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (JSON_COLS.includes(k) && typeof x === 'string') {
        try {
          return [k, deep(JSON.parse(x))];
        } catch {
          return [k, x];
        }
      }
      return [k, deep(x)];
    }));
  }
  return v;
}
const writer = (dir) => new DatabaseSync(path.join(dir, DB_REL));
const nodeOf = (w, sid, mid) => w.prepare("SELECT node_id FROM message_nodes WHERE session_id = ? AND json_extract(chat_message, '$.message_id') = ? ORDER BY node_id DESC").get(sid, mid).node_id;

// ---- conformance --------------------------------------------------------------------------------

for (const name of CASES) {
  test(`devin/${name}: the full replay equals the reviewed golden`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), golden(name)));
  });

  test(`devin/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    for (const steps of [5, 12, 40]) {
      const r = sqlGrowthCheck(adapter, path.join(FIX, name), { steps });
      assert.deepEqual(r.incremental, r.full);
      assert.ok(r.equal, 'content_sha differs between the incremental and the full view');
      assert.deepEqual(r.notUnchanged, []);
    }
  });

  test(`devin/${name}: keys are stable across a lost state`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), project(fullReplay(adapter, dir).views())));
  });

  test(`devin/${name}: no string under a secret-looking name in any unit (JSON columns included) or record`, () => {
    withStore(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) for (const u of src.units.values()) hits.push(...nameLint(deep(JSON.parse(u.body)), EXEMPT, `${u.source_key}:`));
        for (const r of s.view.values()) hits.push(...nameLint(r, EXEMPT, `${r.type}:`));
      }
      assert.deepEqual(hits, []);
    });
  });
}

test('devin: derive is pure: no file is opened, listed or stat-ed', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const inputs = adapter.list(store).map((s) => ({ key: keyOf(store, s.session_id), input: inputOf(dir, s.session_id) }));
    const names = ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'readSync'];
    const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
    for (const n of names) fs[n] = () => { throw new Error(`derive called fs.${n}`); };
    try {
      for (const { key, input } of inputs) adapter.derive(key, input, null);
    } finally {
      Object.assign(fs, orig);
    }
  });
});

// ---- the memhouse normaliser's reviewed cases, and the annex's (by shape) ------------------------

test('devin: a turn: each message once (twins, prefix copies), context injected, tools as tool messages, reasoning, usage, ts from the message', () => {
  const recs = golden('features')['amber-harbor'];
  assert.deepEqual(msgsInOrder(recs).slice(0, 8).map((m) => m.message_id),
    ['ah:si', 'ah:rules', 'ah:u1', 'ah:skills', 'ah:a1', 'ah:r1', 'ah:r2', 'ah:a2'].map(ID), 'the system prefix and the keepalive are not messages; the copies fold to the originals\' ids');
  const a1 = msg(recs, ID('ah:a1'));
  assert.deepEqual(a1.parts.map((p) => p.kind), ['reasoning', 'text', 'tool_call', 'tool_call']);
  assert.deepEqual([a1.ts, a1.served_model, a1.status, a1.agent_id, a1.on_active_branch], ['2026-10-20T10:00:49.000Z', 'swe-1-6-slow', 'complete', '', true], 'ts is chat_message.metadata.created_at, never the row created_at');
  const u = ofType(recs, 'usage').find((x) => x.anchor.message_id === ID('ah:a1'));
  assert.deepEqual([u.usage_id, u.input, u.output, u.cache_read, u.cache_write, u.input_includes_cache, u.output_includes_reasoning, u.granularity], [`message:${ID('ah:a1')}#1`, 404, 194, 12896, null, null, null, 'per_response']);
  const r1 = msg(recs, ID('ah:r1'));
  assert.deepEqual([r1.role, r1.parts[0].kind, r1.parts[0].call_id, r1.parts[0].status, r1.parts[0].is_error], ['tool', 'tool_result', callId('ah:exec1'), 'completed', false], 'a non-zero exit stays completed');
  assert.ok(r1.parts[0].output.includes('FAILED'));
  const si = msg(recs, ID('ah:si'));
  assert.deepEqual([si.role, si.source, si.to_user, si.to_model], ['system', 'injected', false, true]);
  assert.equal(msg(recs, ID('ah:u1')).source, 'user');
  const s = ofType(recs, 'session')[0];
  assert.deepEqual([s.title, s.cwd, s.created_at, s.incarnation, s.kind, s.reuse, s.ts_source, s.mode], ['Toyshop qty fix', '/home/user/work/toyshop', '2026-10-20T10:00:00.000Z', '', null, 'undetectable', 'reset_on_save', 'smart']);
  assert.equal(s.fingerprint.cmp_shas.length, msgsInOrder(recs).length);
  // linkage.tool native: every call has exactly one result by call_id, and its state row.
  for (const recs2 of Object.values(golden('features'))) {
    const results = ofType(recs2, 'message').flatMap((m) => m.parts.filter((p) => p.kind === 'tool_result'));
    for (const p of ofType(recs2, 'message').flatMap((m) => m.parts.filter((x) => x.kind === 'tool_call'))) assert.ok(results.filter((r) => r.call_id === p.call_id).length <= 1, p.call_id);
  }
});

test('devin: every save re-inserts every node: new row ids and row times change nothing, the read is unchanged', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const first = adapter.read(store, keyOf(store, 'amber-harbor'), SOURCE);
    const w = writer(dir);
    const before = w.prepare("SELECT group_concat(row_id) AS r FROM message_nodes WHERE session_id = 'amber-harbor'").get().r;
    w.exec("CREATE TEMP TABLE keep AS SELECT * FROM message_nodes WHERE session_id = 'amber-harbor'; DELETE FROM message_nodes WHERE session_id = 'amber-harbor';"
      + ' INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) SELECT session_id, node_id, parent_node_id, chat_message, created_at + 600, metadata FROM keep ORDER BY node_id DESC;'
      + " UPDATE sessions SET last_activity_at = last_activity_at + 600, metadata = '{\"total_credit_cost\":12,\"total_acu_cost\":0.75}' WHERE id = 'amber-harbor';");
    assert.notEqual(w.prepare("SELECT group_concat(row_id) AS r FROM message_nodes WHERE session_id = 'amber-harbor'").get().r, before);
    w.close();
    assert.equal(adapter.read(store, keyOf(store, 'amber-harbor'), SOURCE, first.position).continuity, 'unchanged');
  });
});

test('devin: tool outcomes: rejected is denied, canceled is cancelled (its reply interrupted), each from the tool node and tool_call_state', () => {
  const recs = golden('features')['amber-harbor'];
  const x3 = msg(recs, ID('ah:x3')).parts[0];
  assert.deepEqual([x3.status, x3.is_error, x3.call_id], ['denied', true, callId('ah:rej')]);
  const x4 = msg(recs, ID('ah:x4')).parts[0];
  assert.deepEqual([x4.status, x4.is_error, x4.output], ['cancelled', true, 'Canceled due to user interrupt']);
  assert.equal(msg(recs, ID('ah:a4')).status, 'interrupted');
  assert.equal(msg(recs, ID('ah:a3')).status, 'complete');
});

test('devin: held: a tail reply with a running call is held with its usage, its finished sibling call is not; the result releases it', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const out = lastDerive(e, 'gentle-harvest');
    assert.deepEqual(out.held.message, [ID('gh:a1')]);
    assert.deepEqual(out.held.usage, [`message:${ID('gh:a1')}#1`]);
    assert.ok(!out.live.message.includes(ID('gh:a1')) && !out.changed.some((r) => r.message_id === ID('gh:a1')));
    assert.ok(out.live.message.includes(ID('gh:r1')), 'the result that arrived is a complete message');
    const w = writer(dir);
    const r1 = nodeOf(w, 'gentle-harvest', ID('gh:r1'));
    const res = { message_id: uuid('gh:r2'), role: 'tool', content: 'Ran 1 test\n\nOK', tool_call_id: callId('gh:slow'), metadata: { created_at: '2026-10-20T11:00:09.000000000Z', telemetry: { source: 'tool_result', operation: 'exec' } } };
    w.prepare('INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, 0)').run('gentle-harvest', 99, r1, JSON.stringify(res));
    w.prepare('UPDATE sessions SET main_chain_id = 99 WHERE id = ?').run('gentle-harvest');
    w.close();
    e.pass();
    const next = lastDerive(e, 'gentle-harvest');
    assert.deepEqual(next.held, { session: [], message: [], usage: [], link: [], lifecycle: [] });
    const m = next.changed.find((r) => r.message_id === ID('gh:a1'));
    assert.equal(m.status, 'complete');
    assert.ok(next.changed.some((r) => r.type === 'usage' && r.anchor.message_id === ID('gh:a1')));
  });
});

test('devin: held: a tail reply with no finish_reason is held; the interrupt notice releases it as interrupted', () => {
  const recs = golden('features');
  assert.ok(!msg(recs['hollow-pine'], ID('hp:a1')), 'held: never in the golden');
  const ft = recs['fern-tundra'];
  assert.deepEqual([msg(ft, ID('ft:a4')).status, msg(ft, ID('ft:a4')).parts.map((p) => p.kind)], ['interrupted', ['reasoning', 'text']], 'the partial text is kept');
  const mk = msg(ft, ID('ft:interrupt'));
  assert.deepEqual([mk.role, mk.source, mk.to_user, mk.parts[0].kind, mk.parts[0].text], ['system', 'system_notice', null, 'notice', '[Response interrupted by user]']);
  withStore('features', (dir) => {
    const out = deriveDir(dir, 'hollow-pine');
    assert.deepEqual(out.held.message, [ID('hp:a1')]);
    assert.deepEqual(out.held.usage, [], 'no metrics yet, no usage');
  });
});

test('devin: a held key keeps its last version: a reply written once and held again is neither rewritten nor tombstoned', () => {
  withStore('features', (dir) => {
    const first = deriveDir(dir, 'amber-harbor');
    assert.ok(first.live.message.includes(ID('ah:a5')));
    // The same reply streaming again (its row loses finish_reason in place).
    const w = writer(dir);
    w.prepare("UPDATE message_nodes SET chat_message = json_set(chat_message, '$.metadata.finish_reason', NULL) WHERE session_id = 'amber-harbor' AND json_extract(chat_message, '$.message_id') = ?").run(ID('ah:a5'));
    w.close();
    const out = deriveDir(dir, 'amber-harbor', first.state);
    assert.deepEqual(out.held.message, [ID('ah:a5')]);
    assert.ok(!out.live.message.includes(ID('ah:a5')) && !out.changed.some((r) => r.message_id === ID('ah:a5')));
    assert.ok(out.state.emitted.message[ID('ah:a5')], 'its last emitted sha stands');
  });
});

test('devin: revert and edit: only main_chain_id moves; the abandoned branch stays with on_active_branch false; no rewind record, nothing tombstoned', () => {
  const recs = golden('features')['brisk-meadow'];
  assert.deepEqual(msgsInOrder(recs).map((m) => [m.message_id, m.on_active_branch]), [
    [ID('bm:si'), true], [ID('bm:u1'), true], [ID('bm:a1'), true],
    [ID('bm:u2'), false], [ID('bm:a2'), false], [ID('bm:r2'), false], [ID('bm:a3'), false],
    [ID('bm:u3'), true], [ID('bm:a4'), true],
  ], 'the abandoned subtree sits after the message it hangs off');
  assert.deepEqual(ofType(recs, 'lifecycle'), [], 'a rewind is implicit (a pointer move)');
  assert.equal(msg(recs, ID('bm:u2')).parent_id, ID('bm:a1'));
  assert.equal(ofType(recs, 'session')[0].fingerprint.cmp_shas.length, 5, 'the fingerprint is the current line only');
  assert.ok(ofType(recs, 'usage').some((u) => u.anchor.message_id === ID('bm:a3')), 'an abandoned reply was billed');
  // Moving the pointer back again: the same keys, flipped, never tombstoned.
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const before = lastDerive(e, 'brisk-meadow').live;
    const w = writer(dir);
    w.prepare('UPDATE sessions SET main_chain_id = ? WHERE id = ?').run(nodeOf(w, 'brisk-meadow', ID('bm:a3')), 'brisk-meadow');
    w.close();
    e.pass();
    assert.equal(e.log.find((l) => l.session_id === 'brisk-meadow').continuity, 'snapshot');
    const out = lastDerive(e, 'brisk-meadow');
    assert.deepEqual(out.live, before);
    assert.deepEqual(out.changed.filter((r) => r.type === 'message' && r.on_active_branch === false).map((r) => r.message_id).sort(), [ID('bm:u3'), ID('bm:a4')].sort());
  });
});

test('devin: compaction: the compactor reply is a summary through the compacted history\'s last message, an explicit record; nothing is replaced', () => {
  const recs = golden('features')['calm-orchard'];
  assert.deepEqual(msgsInOrder(recs).map((m) => m.message_id), ['co:si', 'co:rules', 'co:u1', 'co:a1', 'co:r1', 'co:a2', 'co:summary', 'co:cont', 'co:u2', 'co:a3'].map(ID));
  const sum = msg(recs, ID('co:summary'));
  assert.deepEqual([sum.role, sum.served_model, sum.parts.map((p) => [p.kind, p.replaces])], ['assistant', 'compactor', [['summary', { through_id: ID('co:a2') }]]]);
  const [lc] = ofType(recs, 'lifecycle');
  assert.deepEqual([lc.op, lc.lifecycle_id, lc.target, lc.evidence, lc.ts], ['compaction', ID('co:summary'), { range: { from_id: ID('co:si'), through_id: ID('co:a2') } }, 'explicit', '2026-10-20T10:21:11.000Z']);
  assert.deepEqual([msg(recs, ID('co:cont')).source, msg(recs, ID('co:cont')).to_user], ['injected', false]);
  assert.ok(msgsInOrder(recs).every((m) => m.state === 'current' && m.on_active_branch), 'the compacted messages stay current');
  assert.ok(!msg(recs, ID('co:su')), 'the summarizer\'s own prompt is not a message');
});

test('devin: a sub-agent in the same tree: its chain follows the calling message with agent_id; its task is automated', () => {
  const recs = golden('features')['dusty-lantern'];
  const AG = msg(recs, ID('dl:task')).agent_id;
  assert.deepEqual(msgsInOrder(recs).map((m) => [m.message_id, m.agent_id]), [
    [ID('dl:si'), ''], [ID('dl:u1'), ''], [ID('dl:a1'), ''],
    [ID('dl:task'), AG], [ID('dl:sa1'), AG], [ID('dl:sr1'), AG], [ID('dl:sa2'), AG],
    [ID('dl:res'), ''], [ID('dl:a2'), ''],
  ]);
  assert.match(AG, /^[0-9a-f]{8}$/);
  assert.equal(msg(recs, ID('dl:task')).source, 'automated');
  assert.ok(msg(recs, ID('dl:res')).parts[0].output.startsWith(`Subagent agent_id=${AG}`));
  assert.deepEqual(ofType(recs, 'link'), [], 'in-session sub-agents are not links');
  assert.ok(msgsInOrder(recs).every((m) => m.on_active_branch), 'the sub-agent chain is not an abandoned branch');
});

test('devin: a hidden summary-agent session has kind hidden and automated prompts; an image is an attachment with its caption; typed text is a notice', () => {
  const g = golden('features');
  const ef = g['eager-falcon'];
  assert.deepEqual([ofType(ef, 'session')[0].kind, ofType(ef, 'session')[0].cwd], ['hidden', '/']);
  assert.equal(msg(ef, ID('ef:u1')).source, 'automated');
  const ft = g['fern-tundra'];
  const u1 = msg(ft, ID('ft:u1'));
  assert.deepEqual(u1.parts.map((p) => [p.kind, p.native_type ?? null]), [['text', null], ['notice', 'chisel/acp-content-blocks'], ['attachment', null], ['notice', 'image.caption']]);
  assert.ok(u1.parts[0].text.startsWith('[Image 1: '), 'the text is what the model saw');
  assert.equal(u1.parts[1].text, 'Describe this label image in two sentences. Do not use tools.', 'the notice is what the user typed');
  assert.deepEqual([u1.parts[2].media_type, u1.parts[2].bytes_len, u1.parts[2].ref, Buffer.from(u1.parts[2].inline, 'base64').toString()], ['image/png', 21, null, 'PNG-TOY-LABEL-240x120']);
  const skill = msg(ft, ID('ft:u2'));
  assert.deepEqual([skill.parts[0].text.startsWith('1. Run:'), skill.parts[1].text], [true, '/toy-count ']);
  assert.equal(msg(ft, ID('ft:u3')).parts.length, 1, 'typed as sent: no notice');
  const local = msg(ft, ID('ft:a3'));
  assert.deepEqual([local.status, local.served_model, local.response_id], ['complete', null, null], 'a local command reply is no inference');
  assert.ok(!ofType(ft, 'usage').some((x) => x.anchor.message_id === ID('ft:a3')));
});

test('devin: a session saved before its first turn is its session record alone', () => {
  const recs = golden('features')['idle-quarry'];
  assert.deepEqual(recs.map((r) => r.type), ['session']);
  assert.deepEqual([recs[0].title, recs[0].mode, recs[0].fingerprint], [null, null, { cmp_shas: [] }]);
});

// ---- torn reads, list and read ------------------------------------------------------------------

// sessions v1.x (#6), §2 `read` errors, `inconsistent`: only the main line itself (its head and the
// parent links along it) tears a Devin read. A subagent_heads row naming a node the read does not
// hold tears nothing: derive leaves that sub-agent chain out, and a later read that holds the node
// derives it as a new rev.
test('devin: a dangling sub-agent head is no torn read: derive leaves its chain out, and a later read that holds the node derives it', () => {
  // A head row naming a node never written: read succeeds, and the records are the session's own.
  withStore('features', (dir) => {
    const before = deriveDir(dir, 'brisk-meadow');
    const w = writer(dir);
    w.prepare("INSERT INTO subagent_heads (session_id, agent_id, chain_node_id, updated_at) VALUES ('brisk-meadow', 'deadbeef', 999, 0)").run();
    w.close();
    const after = deriveDir(dir, 'brisk-meadow');
    assert.deepEqual([after.changed, after.live, after.held], [before.changed, before.live, before.held]);
  });
  // dusty-lantern while its sub-agent runs: the store as it stands once the head row has moved to
  // the sub-agent's last reply (the generator's statements up to that write), read whole, and the
  // same store torn, the head's node (both streaming twins of that reply) not yet written, or an
  // earlier node of the chain missing.
  const [db] = sqlFilesOf(path.join(FIX, 'features'));
  const moves = db.ops.map((o, i) => [o, i]).filter(([o]) => /^INSERT OR REPLACE INTO subagent_heads/.test(o.sql) && o.params[0] === 'dusty-lantern');
  assert.equal(moves.length, 3, 'the head row moves three times');
  const upto = moves[2][1] + 1;
  const chain = ['dl:task', 'dl:sa1', 'dl:sr1', 'dl:sa2'].map(ID);
  const fromChain = (r) => (r.type === 'message' && chain.includes(r.message_id)) || (r.type === 'usage' && chain.includes(r.anchor?.message_id));
  const key = (r) => `${r.type}\u0000${r.type === 'message' ? r.message_id : r.type === 'usage' ? r.usage_id : r.type === 'session' ? '' : JSON.stringify(r)}`;
  const sid = 'dusty-lantern';
  const byMid = "FROM message_nodes WHERE session_id = 'dusty-lantern' AND json_extract(chat_message, '$.message_id') = ?";
  for (const [what, mid] of [['the head\'s node', ID('dl:sa2')], ['a node of its chain', ID('dl:sr1')]]) {
    const dir = tmpStore();
    try {
      buildDb(dir, db, upto);
      const full = deriveDir(dir, sid);
      let w = writer(dir);
      const rows = w.prepare(`SELECT * ${byMid}`).all(mid);
      assert.ok(rows.length > 0, what);
      w.prepare(`DELETE ${byMid}`).run(mid);
      w.close();
      const t = deriveDir(dir, sid);
      assert.deepEqual(t.changed.filter(fromChain).map(key), [], `${what}: no record from the sub-agent chain`);
      assert.deepEqual(t.changed, full.changed.filter((r) => !fromChain(r)), `${what}: the rest of the session as the whole read gives it`);
      assert.deepEqual(t.held, full.held, what);
      // The later read holds the node again: derived from the torn read's state, it folds to the
      // whole read's derive, and what changed is the new rev.
      w = writer(dir);
      const cols = Object.keys(rows[0]);
      const ins = w.prepare(`INSERT INTO message_nodes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const r of rows) ins.run(...cols.map((c) => r[c]));
      w.close();
      const later = deriveDir(dir, sid, t.state);
      assert.deepEqual(later.live, full.live, what);
      const seen = new Map(t.changed.map((r) => [key(r), r.content_sha]));
      assert.deepEqual(later.changed.map(key).sort(), full.changed.filter((r) => seen.get(key(r)) !== r.content_sha).map(key).sort(), what);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// sessions v1.x (#6), §2 `inconsistent`, with sessions §2 `held`: a read with a dangling head that
// follows a whole read must not tombstone what the whole read wrote. A key that was live before
// and is left out now is held: its last written version stands. The next read that holds the head
// releases it, unchanged.
test('devin: derived from a whole read\'s state, a dangling head holds the keys it leaves out; none is tombstoned, and the next whole read releases them', () => {
  const [db] = sqlFilesOf(path.join(FIX, 'features'));
  const moves = db.ops.map((o, i) => [o, i]).filter(([o]) => /^INSERT OR REPLACE INTO subagent_heads/.test(o.sql) && o.params[0] === 'dusty-lantern');
  const upto = moves[2][1] + 1;
  const sid = 'dusty-lantern';
  const byMid = "FROM message_nodes WHERE session_id = 'dusty-lantern' AND json_extract(chat_message, '$.message_id') = ?";
  const types = ['session', 'message', 'usage', 'link', 'lifecycle'];
  for (const mid of [ID('dl:sa2'), ID('dl:sr1')]) {
    const dir = tmpStore();
    try {
      buildDb(dir, db, upto);
      const whole = deriveDir(dir, sid);
      // While the sub-agent runs and its head resolves: the line, its task and the streaming twins'
      // siblings (abandoned-branch records until the result names the chain).
      assert.deepEqual([whole.live.message.length, whole.live.usage.length], [5, 2], 'the whole read');
      let w = writer(dir);
      const rows = w.prepare(`SELECT * ${byMid}`).all(mid);
      w.prepare(`DELETE ${byMid}`).run(mid);
      w.close();
      const t = deriveDir(dir, sid, whole.state);
      assert.deepEqual([t.live.message.length, t.live.usage.length], [2, 0], 'the dangling read leaves the sub-agent\'s records out');
      for (const type of types) {
        const left = whole.live[type].filter((k) => !t.live[type].includes(k));
        assert.deepEqual(left.filter((k) => !t.held[type].includes(k)), [], `${type}: a key the whole read wrote is in live or held, never tombstoned`);
        assert.deepEqual(t.held[type].filter((k) => t.live[type].includes(k)), [], `${type}: a held key is not also live`);
      }
      assert.deepEqual([t.held.message.length - whole.held.message.length, t.held.usage.length - whole.held.usage.length], [3, 2], 'three messages and two usage records held');
      assert.deepEqual(t.changed, [], 'nothing is rewritten');
      // The head's node arrives: released, unchanged.
      w = writer(dir);
      const cols = Object.keys(rows[0]);
      const ins = w.prepare(`INSERT INTO message_nodes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const r of rows) ins.run(...cols.map((c) => r[c]));
      w.close();
      const later = deriveDir(dir, sid, t.state);
      assert.deepEqual([later.live, later.held, later.changed], [whole.live, whole.held, []], 'released, as the whole read wrote them');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// sessions v1.x (#6), §2 `inconsistent`: while a head dangles, derive leaves out only what that
// head would have reached: nodes no valid head reaches, in no tree that holds a main-line node.
// An off-line tree that exists without the dangling head keeps its normal treatment. amber-harbor
// is the mode-switch shape: the line runs through prefix copies (`compact/prior_node_ids`), and the
// old root keeps the originals. A turn abandoned in the old root before the switch is the control:
// it is an abandoned branch with or without a dangling head elsewhere.
test('devin: a dangling sub-agent head leaves a mode switch\'s old root alone: the session derives the same records with and without it', () => {
  const sid = 'amber-harbor';
  const dangle = (dir) => {
    const w = writer(dir);
    w.prepare("INSERT INTO subagent_heads (session_id, agent_id, chain_node_id, updated_at) VALUES (?, 'deadbeef', 999, 0)").run(sid);
    w.close();
  };
  const same = (a, b, what) => assert.deepEqual([a.changed, a.live, a.held], [b.changed, b.live, b.held], what);
  // The fixture as it is.
  withStore('features', (dir) => {
    const whole = deriveDir(dir, sid);
    dangle(dir);
    same(deriveDir(dir, sid), whole, 'the prefix-copy fixture');
  });
  // The same session with a turn abandoned in the old root (a revert before the mode switch copied
  // the chain): two nodes under the original of ah:u1, shaped as the session's own prompt and reply.
  withStore('features', (dir) => {
    const w = writer(dir);
    const orig = w.prepare("SELECT node_id FROM message_nodes WHERE session_id = ? AND json_extract(chat_message, '$.message_id') = ? ORDER BY node_id").get(sid, ID('ah:u1')).node_id;
    const copy = nodeOf(w, sid, ID('ah:u1'));
    assert.ok(orig < copy, 'the original sits in the old root, the copy on the line');
    const max = w.prepare('SELECT max(node_id) AS m FROM message_nodes WHERE session_id = ?').get(sid).m;
    const like = "INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) SELECT session_id, ?, ?, json_set(chat_message, '$.message_id', ?, '$.content', ?), created_at, NULL FROM message_nodes WHERE session_id = ? AND node_id = ?";
    w.prepare(like).run(max + 1, orig, ID('ah:old-u'), 'Fix it some other way.', sid, orig);
    w.prepare(like).run(max + 2, max + 1, ID('ah:old-a'), 'Reverted before the switch.', sid, nodeOf(w, sid, ID('ah:a2')));
    w.close();
    const whole = deriveDir(dir, sid);
    const old = whole.changed.filter((r) => r.type === 'message' && [ID('ah:old-u'), ID('ah:old-a')].includes(r.message_id));
    assert.deepEqual(old.map((m) => [m.message_id, m.on_active_branch]), [[ID('ah:old-u'), false], [ID('ah:old-a'), false]], 'the old root\'s abandoned turn is an abandoned branch');
    assert.ok(whole.live.usage.includes(`message:${ID('ah:old-a')}#1`), 'with its usage');
    dangle(dir);
    same(deriveDir(dir, sid), whole, 'the old root\'s abandoned turn with a dangling head elsewhere');
  });
});

// sessions v1.x (#6), §2 `inconsistent`: only the main line itself tears a Devin read, its head and
// the parent links along it (after a compaction or a mode switch, the re-rooted copies are that
// line). A loop anywhere is no committed tree: damaged.
test('devin: a torn main line is inconsistent, never an empty or shorter session: its head, a parent link along it; a loop is damaged', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const del = (sid, mid) => (w) => w.prepare('DELETE FROM message_nodes WHERE session_id = ? AND node_id = ?').run(sid, nodeOf(w, sid, ID(mid)));
    const cases = [
      ['amber-harbor', (w) => w.prepare("UPDATE sessions SET main_chain_id = 999 WHERE id = 'amber-harbor'").run()],
      ['brisk-meadow', del('brisk-meadow', 'bm:u3')],
      ['calm-orchard', del('calm-orchard', 'co:rules')], // the re-rooted copy the line runs through
    ];
    for (const [sid, tear] of cases) {
      const w = writer(dir);
      tear(w);
      w.close();
      assert.throws(() => adapter.read(store, keyOf(store, sid), SOURCE), { code: 'inconsistent' }, sid);
    }
    const w = writer(dir);
    w.prepare("UPDATE message_nodes SET parent_node_id = node_id WHERE session_id = 'hollow-pine' AND node_id = 0").run();
    // A loop in a sub-agent chain the main line only names.
    w.prepare("UPDATE message_nodes SET parent_node_id = node_id WHERE session_id = 'dusty-lantern' AND node_id = ?").run(nodeOf(w, 'dusty-lantern', ID('dl:sr1')));
    w.close();
    assert.throws(() => adapter.read(store, keyOf(store, 'hollow-pine'), SOURCE), { code: 'damaged' });
    assert.throws(() => adapter.read(store, keyOf(store, 'dusty-lantern'), SOURCE), { code: 'damaged' });
  });
});

// sessions v1.x (#6), §2 `inconsistent`: a node the main line only names (a compacted history's
// prior nodes, a sub-agent chain a tool result names) that the read lacks tears nothing. derive
// leaves out what it would have reached, the raw unit keeps the naming row, and a later read that
// holds the node derives it. Each case removes the named node itself or an earlier node of its chain
// (every row with that message id, so both streaming twins), from the fixture as it stands.
function namedNodeMissing(sid, mid, leftOut) {
  const byMid = 'FROM message_nodes WHERE session_id = ? AND json_extract(chat_message, \'$.message_id\') = ?';
  const isLeftOut = (r) => (r.type === 'message' && leftOut.includes(r.message_id)) || (r.type === 'usage' && leftOut.includes(r.anchor?.message_id)) || r.type === 'lifecycle';
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const whole = deriveDir(dir, sid);
    let w = writer(dir);
    const rows = w.prepare(`SELECT * ${byMid}`).all(sid, mid);
    assert.ok(rows.length > 0, mid);
    w.prepare(`DELETE ${byMid}`).run(sid, mid);
    w.close();
    // read: no error, and the raw unit keeps the naming row.
    const units = adapter.read(store, keyOf(store, sid), SOURCE).units;
    assert.equal(units.length, 1);
    // From an empty state: the main line, and nothing of the left-out piece, not even as an
    // abandoned branch.
    const t = deriveDir(dir, sid);
    assert.deepEqual(t.changed.filter(isLeftOut).map((r) => [r.type, r.message_id ?? r.usage_id ?? r.lifecycle_id]), [], 'nothing of what the named node would have reached');
    assert.ok(t.changed.filter((r) => r.type === 'message').every((m) => m.on_active_branch), 'nothing reads as an abandoned branch');
    const line = whole.changed.filter((r) => r.type === 'message' && !isLeftOut(r)).map((r) => r.message_id).sort();
    assert.deepEqual(t.live.message, line, 'the main line, whole');
    assert.deepEqual(t.held, whole.held);
    // From the whole read's state: what the whole read wrote of the piece is held, never tombstoned;
    // what remains is only revised (an order or a fingerprint that moved), never new.
    const tw = deriveDir(dir, sid, whole.state);
    for (const type of ['session', 'message', 'usage', 'link', 'lifecycle']) {
      const wrote = whole.live[type].filter((k) => !tw.live[type].includes(k));
      assert.deepEqual(wrote.filter((k) => !tw.held[type].includes(k)), [], `${type}: in live or held`);
    }
    assert.deepEqual(tw.held.message, whole.changed.filter((r) => r.type === 'message' && isLeftOut(r)).map((r) => r.message_id).sort(), 'the left-out messages are held');
    assert.ok(tw.changed.every((r) => !isLeftOut(r) && whole.state.emitted[r.type][recordKeyOf(r)] != null), 'a revision of a key the whole read wrote');
    // The later read holds the node again: from either state, it folds to the whole read.
    w = writer(dir);
    const cols = Object.keys(rows[0]);
    const ins = w.prepare(`INSERT INTO message_nodes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    for (const r of rows) ins.run(...cols.map((c) => r[c]));
    w.close();
    for (const [from, state] of [['the empty-state derive', t.state], ['the whole-state derive', tw.state]]) {
      const later = deriveDir(dir, sid, state);
      assert.deepEqual([later.live, later.held], [whole.live, whole.held], from);
      assert.deepEqual(later.state.emitted, whole.state.emitted, `${from}: every key at the whole read's version`);
    }
  });
}
const recordKeyOf = (r) => (r.type === 'session' ? '' : r.type === 'message' ? r.message_id : r.type === 'usage' ? r.usage_id : r.type === 'lifecycle' ? r.lifecycle_id : null);

test('devin: a compacted history the read does not hold whole is no torn read: derive leaves it out and holds what it wrote of it; a later read derives it', () => {
  const history = ['co:u1', 'co:a1', 'co:r1', 'co:a2', 'co:summary'].map(ID);
  for (const mid of ['co:a2', 'co:r1']) namedNodeMissing('calm-orchard', ID(mid), history);
});

test('devin: a sub-agent chain a tool result names that the read does not hold whole is no torn read: derive leaves it out and holds what it wrote of it; a later read derives it', () => {
  const chain = ['dl:task', 'dl:sa1', 'dl:sr1', 'dl:sa2'].map(ID);
  for (const mid of ['dl:sa2', 'dl:sr1']) namedNodeMissing('dusty-lantern', ID(mid), chain);
});

test('devin: list names every sessions row, hidden ones too, with its one source; the hint moves with this session only', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const sessions = adapter.list(store);
    assert.deepEqual(sessions.map((s) => s.session_id), ['amber-harbor', 'brisk-meadow', 'calm-orchard', 'dusty-lantern', 'eager-falcon', 'fern-tundra', 'gentle-harvest', 'hollow-pine', 'idle-quarry']);
    assert.deepEqual(adapter.list(store), sessions, 'list is stable');
    const s = sessions[0];
    assert.deepEqual([s.incarnation, s.live, s.sources], ['', 'unknown', [{ source_key: 'sessions.db#table:message_nodes', role: 'main', mode: 'snapshot', position_kind: 'snapshot' }]]);
    const hint = (sid) => adapter.list(store).find((x) => x.session_id === sid).updated_hint;
    const w = writer(dir);
    // Devin is running: a WAL writer that has not checkpointed. Its rows are read.
    w.exec('PRAGMA wal_autocheckpoint = 0');
    const h0 = hint('amber-harbor');
    const h2 = hint('gentle-harvest');
    w.prepare("UPDATE sessions SET last_activity_at = last_activity_at + 1, metadata = '{\"total_credit_cost\":3}' WHERE id = 'amber-harbor'").run();
    assert.equal(hint('amber-harbor'), h0, 'volatile columns do not move the hint');
    w.prepare('INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, 98, NULL, ?, 0)').run('gentle-harvest', JSON.stringify({ message_id: uuid('gh:loose'), role: 'user', content: 'More.', metadata: {} }));
    assert.ok(fs.existsSync(path.join(dir, `${DB_REL}-wal`)));
    assert.equal(hint('amber-harbor'), h0, 'a write to another session leaves this hint');
    assert.notEqual(hint('gentle-harvest'), h2, 'a new node');
    assert.ok(adapter.read(store, keyOf(store, 'gentle-harvest'), SOURCE).units[0].body.includes(uuid('gh:loose')), 'a WAL-only row is read');
    const steps = [
      ["UPDATE sessions SET main_chain_id = 1 WHERE id = 'amber-harbor'", 'a revert'],
      ["UPDATE sessions SET title = 'renamed' WHERE id = 'amber-harbor'", 'a rename'],
      ["UPDATE sessions SET hidden = 1 WHERE id = 'amber-harbor'", 'hidden'],
      ["UPDATE tool_call_state SET tool_call_update_json = '{\"status\":\"failed\"}' WHERE session_id = 'amber-harbor' AND tool_call_id = (SELECT min(tool_call_id) FROM tool_call_state WHERE session_id = 'amber-harbor')", 'a final status rewritten in place'],
      ["INSERT INTO subagent_heads (session_id, agent_id, chain_node_id, updated_at) VALUES ('amber-harbor', 'a1b2c3d4', 1, 0)", 'a sub-agent head'],
      ["UPDATE message_nodes SET chat_message = json_set(chat_message, '$.content', 'edited') WHERE session_id = 'amber-harbor' AND node_id = 2", 'a node edited in place'],
    ];
    let prev = hint('amber-harbor');
    for (const [sql, why] of steps) {
      w.exec(sql);
      const h = hint('amber-harbor');
      assert.notEqual(h, prev, why);
      prev = h;
    }
    w.close();
  });
});

test('devin: read: one rows-json unit without row_id and the row created_at; reset, then unchanged, then snapshot', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const key = keyOf(store, 'brisk-meadow');
    const r1 = adapter.read(store, key, SOURCE);
    assert.equal(r1.continuity, 'reset');
    assert.equal(r1.units.length, 1);
    const u = r1.units[0];
    assert.deepEqual([u.source_key, u.unit_key, u.enc, u.redacted], [SOURCE, SOURCE, 'rows-json', false]);
    const body = JSON.parse(u.body);
    assert.deepEqual(Object.keys(body).sort(), ['message_nodes', 'sessions', 'subagent_heads', 'tool_call_state']);
    assert.deepEqual(Object.keys(body.message_nodes[0]).sort(), ['chat_message', 'metadata', 'node_id', 'parent_node_id'], 'no row_id, no row created_at');
    assert.deepEqual(Object.keys(body.sessions[0]).sort(), ['agent_mode', 'backend_type', 'created_at', 'hidden', 'id', 'main_chain_id', 'model', 'title', 'working_directory', 'workspace_dirs']);
    assert.deepEqual(Object.keys(body.tool_call_state[0]).sort(), ['tool_call_id', 'tool_call_update_json'], 'the initial ACP event is not read');
    assert.deepEqual(body.message_nodes.map((n) => n.node_id), [...body.message_nodes.map((n) => n.node_id)].sort((a, b) => a - b), 'nodes in node_id order');
    assert.deepEqual(r1.position, { sha256: u.sha256 });
    assert.equal(adapter.read(store, key, SOURCE, r1.position).continuity, 'unchanged');
    const w = writer(dir);
    w.prepare("UPDATE sessions SET title = 'renamed' WHERE id = 'brisk-meadow'").run();
    w.close();
    const r2 = adapter.read(store, key, SOURCE, r1.position);
    assert.equal(r2.continuity, 'snapshot');
    assert.equal(r2.units.length, 1);
  });
});

test('devin: an older store without tool_call_state and subagent_heads lists and reads; a store with no sessions table has no sessions', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const full = project(fullReplay(adapter, dir).views())['brisk-meadow'];
    const w = writer(dir);
    w.exec('DROP TABLE subagent_heads; DROP TABLE tool_call_state;');
    w.close();
    const recs = project(fullReplay(adapter, dir).views())['brisk-meadow'];
    assert.deepEqual(ofType(recs, 'message').map((m) => m.message_id), ofType(full, 'message').map((m) => m.message_id));
    assert.equal(JSON.parse(adapter.read(store, keyOf(store, 'brisk-meadow'), SOURCE).units[0].body).tool_call_state.length, 0);
  });
  const dir = tmpStore();
  try {
    const store = storeOf(adapter, dir);
    assert.deepEqual(adapter.list(store), [], 'no database');
    const b = new DatabaseSync(path.join(dir, DB_REL));
    b.exec('CREATE TABLE app_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
    b.close();
    assert.deepEqual(adapter.list(store), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('devin: list and read create nothing beside a WAL-mode store', () => {
  withStore('features', (dir) => {
    const before = fs.readdirSync(dir).sort();
    assert.deepEqual(before, ['sessions.db']);
    project(fullReplay(adapter, dir).views());
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  });
});

test('devin: a locked store is busy, a damaged one or a row that does not parse is damaged; never fewer messages', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const key = keyOf(store, 'amber-harbor');
    const full = project(fullReplay(adapter, dir).views());
    const w = writer(dir);
    w.exec('PRAGMA journal_mode = DELETE'); // a rollback-journal copy: a write lock there blocks readers
    w.exec('BEGIN EXCLUSIVE');
    try {
      assert.throws(() => adapter.list(store), { code: 'busy' });
      assert.throws(() => adapter.read(store, key, SOURCE), { code: 'busy' });
    } finally {
      w.exec('ROLLBACK');
    }
    assert.deepEqual(project(fullReplay(adapter, dir).views()), full, 'released: the same records');
    // A chat_message, a node metadata or a final status that does not parse: never a dropped node.
    const orig = w.prepare("SELECT chat_message AS v FROM message_nodes WHERE session_id = 'amber-harbor' AND node_id = 2").get().v;
    w.exec("UPDATE message_nodes SET chat_message = '{\"message_id\":' WHERE session_id = 'amber-harbor' AND node_id = 2");
    assert.throws(() => adapter.read(store, key, SOURCE), (e) => e.code === 'damaged' && /node 2/.test(e.message));
    w.prepare("UPDATE message_nodes SET chat_message = ? WHERE session_id = 'amber-harbor' AND node_id = 2").run(orig);
    w.exec("UPDATE message_nodes SET metadata = '{' WHERE session_id = 'amber-harbor' AND node_id = 4");
    assert.throws(() => adapter.read(store, key, SOURCE), { code: 'damaged' });
    w.exec("UPDATE message_nodes SET metadata = NULL WHERE session_id = 'amber-harbor' AND node_id = 4");
    w.exec("UPDATE tool_call_state SET tool_call_update_json = '[1' WHERE session_id = 'amber-harbor'");
    assert.throws(() => adapter.read(store, key, SOURCE), { code: 'damaged' });
    const size = Number(w.prepare('PRAGMA page_size').get().page_size);
    const { root } = w.prepare("SELECT rootpage AS root FROM sqlite_master WHERE name = 'message_nodes'").get();
    w.close();
    // Overwrite the header of the message_nodes table's root page.
    const fd = fs.openSync(path.join(dir, DB_REL), 'r+');
    fs.writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (root - 1) * size);
    fs.closeSync(fd);
    assert.throws(() => adapter.read(store, key, SOURCE), { code: 'damaged' });
    fs.writeFileSync(path.join(dir, DB_REL), Buffer.alloc(8192, 0x41));
    assert.throws(() => adapter.list(store), { code: 'damaged' }, 'not a database at all: damaged, never an empty store');
  });
});

test('devin: errors: an unknown session, an unknown source, an incarnation Devin never gives, a deleted session', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const key = keyOf(store, 'hollow-pine');
    assert.throws(() => adapter.read(store, { ...key, session_id: 'no-such-slug' }, SOURCE), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, 'sessions.db#table:sessions'), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key, 'sessions.db'), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, { ...key, incarnation: '1792491036' }, SOURCE), { code: 'session_unknown' });
    const w = writer(dir);
    w.exec("DELETE FROM message_nodes WHERE session_id = 'hollow-pine'; DELETE FROM tool_call_state WHERE session_id = 'hollow-pine'; DELETE FROM sessions WHERE id = 'hollow-pine';");
    w.close();
    assert.ok(!adapter.list(store).some((x) => x.session_id === 'hollow-pine'));
    assert.throws(() => adapter.read(store, key, SOURCE), { code: 'session_unknown' });
  });
});

test('devin: a symlinked database is neither listed nor read', () => {
  withStore('features', (real) => {
    const dir = tmpStore();
    try {
      const store = storeOf(adapter, dir);
      fs.symlinkSync(path.join(real, DB_REL), path.join(dir, DB_REL));
      assert.deepEqual(adapter.list(store), []);
      assert.throws(() => adapter.read(store, keyOf(store, 'amber-harbor'), SOURCE), (e) => e.code === 'session_unknown' || e.code === 'source_unknown');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('devin: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'devin');
  assert.equal(d.model_version, 'sessions-model/1');
  assert.deepEqual(d.store_shape, { kind: 'folder' });
  assert.equal(d.facets.reuse, 'undetectable');
  assert.deepEqual(d.sources.map((x) => x.pattern), [SOURCE]);
  for (const op of ['rewind', 'edit', 'compaction', 'delete', 'archive', 'unarchive', 'rename', 'pin', 'unpin', 'fork', 'clear']) {
    assert.ok(['explicit', 'implicit', 'invisible'].includes(d.facets.lifecycle[op]), op);
  }
  for (const k of ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation']) assert.ok(['explicit', 'inferable', 'none'].includes(d.facets.linkage[k]), k);
  const all = CASES.flatMap((c) => Object.values(golden(c)).flat());
  const ops = new Set(ofType(all, 'lifecycle').map((r) => r.op));
  for (const [op, v] of Object.entries(d.facets.lifecycle)) if (v === 'explicit') assert.ok(ops.has(op), `explicit ${op} has no fixture record`);
  assert.deepEqual([...ops], ['compaction'], 'no rewind or edit record: those are implicit');
  const kinds = new Set(ofType(all, 'link').map((r) => r.kind));
  for (const [k, v] of Object.entries(d.facets.linkage)) if (v === 'explicit') assert.ok(kinds.has(k), `explicit ${k} link has no fixture record`);
  assert.ok(all.some((r) => r.type === 'message' && r.on_active_branch === false), 'the implicit rewind shows as on_active_branch false');
});

test('devin: the fixtures carry no captured id: every message, request and call id is the generator\'s', () => {
  const ops = fs.readFileSync(path.join(FIX, 'features', 'store-sql', `${DB_REL}.ops.jsonl`), 'utf8');
  const calls = new Set(ops.match(/call_[0-9a-f]{24}/g));
  const known = new Set();
  for (const line of fs.readFileSync(path.join(FIX, 'generate.js'), 'utf8').matchAll(/callId\('([^']+)'\)/g)) known.add(callId(line[1]));
  assert.deepEqual([...calls].filter((c) => !known.has(c)), []);
  assert.ok(calls.size >= 10);
});

test('devin: a tool_result carries the tool node\'s chisel/terminal_output exit code; a result without one has none', () => {
  withStore('features', (dir) => {
    const views = project(fullReplay(adapter, dir).views());
    const result = (sid, name) => msg(views[sid], ID(name)).parts[0];
    // `chisel/terminal_output.exit.exit_code`, kept apart from the content text ("Exit code: 1").
    assert.deepEqual([result('amber-harbor', 'ah:r1').exit_code, result('calm-orchard', 'co:r1').exit_code], [1, 0]);
    assert.equal(result('amber-harbor', 'ah:r2').exit_code, null, 'a read result keeps no exit code');
    assert.equal(result('amber-harbor', 'ah:x3').exit_code, null, 'a rejected command never ran');
  });
});
