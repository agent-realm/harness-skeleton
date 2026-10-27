import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { adapterFor } from '../src/index.js';
import { DB_REL, HEADERS, composerDataSource, bubblesSource, BUBBLE_KEY_SQL } from '../src/harnesses/cursor/index.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, tmpStore, storeOf, nameLint } from '../conformance/runner.js';
import { prepareStore, sqlGrowthCheck } from '../conformance/sql-store.js';

const adapter = adapterFor('cursor');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cursor');
const CASES = ['lab', 'features'];
const EXEMPT = adapter.describe().redaction.exemptions;
// The features case's chats and bubbles (fixtures/cursor/generate.js).
const uuid = (p8, n) => `${p8}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CID = (n) => uuid(`c0c0a0${String(n).padStart(2, '0')}`, n);
const U = (n) => uuid(n === 1 ? '1508332b' : `b0b0b0${String(n).padStart(2, '0')}`, n);
const CALL = (n, i = 0) => `call-${uuid(n === 1 ? 'fc053ac5' : `ca11ca${String(n).padStart(2, '0')}`, n)}-${i}\nfc_${uuid(`fc0fc0${String(n).padStart(2, '0')}`, n)}_0`;
const A = (uid) => `${uid}:assistant`;
const SENTINEL_BLOB = 'sentinel-blob-key-0a1b2c3d4e5f-not-a-secret';
const SENTINEL_SPEC = 'sentinel-spec-key-5f4e3d2c1b0a-not-a-secret';
const SENTINEL_TEXT = 'sentinel-free-text-7c6b5a493827-not-a-secret';
const SENTINEL_LOGIN = 'sentinel-login-row-0f1e2d3c4b5a-not-a-secret';
// The lab case's main chat and its two turns (fixtures/cursor/generate.js).
const LAB_MAIN = '5a5a0009-0009-4000-8000-000000000009';
const LAB_TURN2 = '5a5a0012-0012-4000-8000-000000000012';
const LAB_TURN3 = '5a5a0029-0029-4000-8000-000000000029';

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
const msgIds = (recs) => ofType(recs, 'message').sort((a, b) => (a.order < b.order ? -1 : 1)).map((m) => m.message_id);
const keyOf = (store, s) => ({ ...store, session_id: s.session_id, incarnation: s.incarnation });
function lastDerive(e, sid) {
  for (const [id, s] of e.sessions) if (id.split('\u0000')[0] === sid) return s.last;
  return null;
}
function viewOf(e, sid) {
  return project(e.views())[sid];
}
// Every unit of a chat's sources, read whole.
function unitsOf(dir, sid) {
  const store = storeOf(adapter, dir);
  const s = adapter.list(store).find((x) => x.session_id === sid);
  return s.sources.map((x) => ({ source_key: x.source_key, generation: 1, complete: true, units: adapter.read(store, keyOf(store, s), x.source_key).units, gone: [] }));
}
// A unit's value with its JSON text columns parsed, so the lint looks inside them.
function deep(v) {
  if (Array.isArray(v)) return v.map(deep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (k === 'value' && typeof x === 'string') {
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
// The KV row's `key` column is a key name, exempt by definition (sessions-model §4.3): the lint
// looks at every other value, the declared exemptions applied.
const VALUE_EXEMPT = EXEMPT.filter((e) => e !== 'key');
const lint = (value, at) => nameLint(value, VALUE_EXEMPT, at);
function unitValue(u) {
  const o = deep(JSON.parse(u.body));
  if (Array.isArray(o.cursorDiskKV)) o.cursorDiskKV = o.cursorDiskKV.map(({ key: _k, ...rest }) => rest);
  if (u.enc === 'row-json') delete o.key;
  return o;
}
// A writer on a case's built database (Cursor, in a test).
const writer = (dir) => new DatabaseSync(path.join(dir, DB_REL));
function exec(dir, sql, ...params) {
  const w = writer(dir);
  try {
    w.prepare(sql).run(...params);
  } finally {
    w.close();
  }
}
function getValue(dir, key) {
  const d = new DatabaseSync(path.join(dir, DB_REL), { readOnly: true });
  try {
    return JSON.parse(Buffer.from(d.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key).value).toString('utf8'));
  } finally {
    d.close();
  }
}
const put = (dir, key, value) => exec(dir, 'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)', key, Buffer.from(JSON.stringify(value)));

// ---- conformance --------------------------------------------------------------------------------

for (const name of CASES) {
  test(`cursor/${name}: the full replay equals the reviewed golden`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), golden(name)));
  });

  test(`cursor/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    for (const steps of [5, 12]) {
      const r = sqlGrowthCheck(adapter, path.join(FIX, name), { steps });
      assert.deepEqual(r.incremental, r.full);
      assert.ok(r.equal, 'content_sha differs between the incremental and the full view');
      assert.deepEqual(r.notUnchanged, []);
    }
  });

  test(`cursor/${name}: keys are stable across a lost state`, () => {
    withStore(name, (dir) => {
      assert.deepEqual(project(fullReplay(adapter, dir).views()), project(fullReplay(adapter, dir).views()));
    });
  });

  test(`cursor/${name}: no string under a secret-looking name in any unit (JSON values included) or record`, () => {
    withStore(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) for (const u of src.units.values()) hits.push(...lint(unitValue(u), `${u.source_key}@${u.unit_key}:`));
        for (const r of s.view.values()) hits.push(...lint(r, `${r.type}:`));
      }
      assert.deepEqual(hits, []);
    });
  });
}

test('cursor: the folded result does not depend on the order sources are given', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    for (const s of adapter.list(store)) {
      const input = unitsOf(dir, s.session_id);
      const a = adapter.derive(keyOf(store, s), input, null);
      const b = adapter.derive(keyOf(store, s), [...input].reverse(), null);
      const sorted = (out) => out.changed.map((r) => JSON.stringify(r)).sort();
      assert.deepEqual(sorted(b), sorted(a));
      assert.deepEqual(b.live, a.live);
      assert.deepEqual(b.held, a.held);
    }
  });
});

test('cursor: derive is pure: no file is opened, listed or stat-ed', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const inputs = adapter.list(store).map((s) => ({ key: keyOf(store, s), input: unitsOf(dir, s.session_id) }));
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

// ---- the memhouse normaliser's reviewed cases, as conformance cases --------------------------

test('cursor: one speaker per message: the user bubble, then <bubbleId>:assistant with the children as parts, in header order', () => {
  const recs = golden('features')[CID(1)];
  assert.deepEqual(msgIds(recs), [U(1), A(U(1)), U(2), A(U(2)), U(3), A(U(3))]);
  const a1 = msg(recs, A(U(1)));
  // The annex's case (a captured composer): user, then /s:0, /s:1, /t:<call>, /s:3, /s:4; the /s:n
  // indices skip the slot the tool takes, and the tool is two parts (sessions-model §2.3).
  assert.deepEqual(a1.parts.map((p) => p.part_id), ['s:0', 's:1', `t:${CALL(1)}:call`, `t:${CALL(1)}:result`, 's:3', 's:4']);
  assert.deepEqual(a1.parts.map((p) => p.kind), ['reasoning', 'text', 'tool_call', 'tool_result', 'reasoning', 'text']);
  assert.deepEqual([a1.parent_id, a1.role, a1.source, a1.order], [U(1), 'assistant', 'model', '00000001']);
  assert.deepEqual([msg(recs, U(1)).role, msg(recs, U(1)).parts[0].text], ['user', 'What does total_cents do in cart.py?']);
  assert.equal(a1.parts[0].text, 'Read cart.py first.', 'thinking is capabilityType 30');
});

test('cursor: a tool bubble is a call and its result: a newline call id byte-exact, an error status beside exitCode 1 an error, output from result.output', () => {
  const recs = golden('features')[CID(1)];
  const [call, result] = msg(recs, A(U(2))).parts.filter((p) => p.call_id === CALL(2, 1));
  assert.ok(CALL(2, 1).includes('\n'));
  assert.deepEqual([call.kind, call.name, call.args.command], ['tool_call', 'run_terminal_command_v2', 'python3 -m pytest -q'], 'args from params when rawArgs is empty');
  assert.deepEqual([result.kind, result.is_error, result.status, result.output], ['tool_result', true, 'completed', '/usr/bin/python3: No module named pytest\n']);
  const [read, readRes] = msg(recs, A(U(1))).parts.filter((p) => p.call_id === CALL(1));
  assert.deepEqual(read.args, { path: '/home/user/work/toyshop/toyshop/cart.py' }, 'args from rawArgs when present');
  assert.deepEqual([readRes.is_error, readRes.output, readRes.output_len], [false, '{"totalLinesInFile":8}', 22], 'a result with no output field is kept as stored');
  // The lab rows: exit 1 on a real shell bubble, a cancelled loop with its partial output.
  const lab = golden('lab')[LAB_MAIN];
  const shell = msg(lab, A(LAB_TURN2)).parts.find((p) => p.kind === 'tool_result' && p.output.includes('pytest'));
  assert.deepEqual([shell.is_error, shell.status], [true, 'completed']);
  assert.ok(shell.call_id.includes('\n'));
});

test('cursor: cancelled by the user: the tool keeps its partial output, status cancelled, and the reply is cancelled', () => {
  for (const [recs, uid] of [[golden('features')[CID(1)], U(3)], [golden('lab')[LAB_MAIN], LAB_TURN3]]) {
    const a = msg(recs, A(uid));
    const r = a.parts.find((p) => p.kind === 'tool_result');
    assert.deepEqual([r.status, r.is_error], ['cancelled', null]);
    assert.ok(r.output.startsWith('tick 1\ntick 2\n'));
    assert.equal(a.status, 'cancelled');
  }
  assert.equal(msg(golden('features')[CID(1)], A(U(2))).status, 'complete');
});

test('cursor: tokens: {0,0} is unknown, so no usage record; real counts are summed from the children; model and effort', () => {
  const free = golden('features')[CID(1)];
  assert.deepEqual(ofType(free, 'usage'), [], 'tokenCount {0,0} is not zero usage');
  assert.ok(Object.values(golden('lab')).every((recs) => !ofType(recs, 'usage').length));
  const a1 = msg(free, A(U(1)));
  assert.deepEqual([a1.served_model, a1.effort, a1.requested_model], ['grok-4.6', 'medium', null], 'model from modelInfo, effort from modelConfig.selectedModels[].parameters');
  const paid = ofType(golden('features')[CID(7)], 'usage');
  assert.deepEqual(paid.map((u) => [u.usage_id, u.anchor, u.input, u.output, u.cache_read, u.input_includes_cache, u.output_includes_reasoning, u.granularity, u.model]), [
    [`message:${A(U(71))}#1`, { message_id: A(U(71)) }, 2700, 30, null, null, null, 'per_message', 'grok-4.6'],
  ], 'a lone zero (output 0 on one bubble) is not counted, the sum is');
});

test('cursor: opaque reasoning, a rejected tool, an image by path, rich text, an unlisted bubble, Ask mode', () => {
  const recs = golden('features')[CID(7)];
  const a = msg(recs, A(U(71)));
  assert.deepEqual(a.parts[0], { part_id: 's:0', kind: 'reasoning', opaque: true, signature_len: 312 });
  const denied = a.parts.find((p) => p.kind === 'tool_result');
  assert.deepEqual([denied.status, denied.is_error], ['denied', null]);
  const img = msg(recs, U(71)).parts[1];
  assert.deepEqual([img.kind, img.media_type, img.inline, img.ref], ['attachment', 'image/png', null, '/home/user/work/toyshop/label.png']);
  assert.equal(msg(recs, U(72)).parts[0].text, 'And the price?', 'the text of a rich-text-only prompt');
  assert.ok(!JSON.stringify(recs).includes('not in the header list'), 'a bubble the list does not name is not a message');
  assert.ok(!JSON.stringify(golden('lab')).includes('5a5a002c'), 'the lab bubble left out of its list is dropped too');
  assert.equal(ofType(recs, 'session')[0].mode, 'chat');
});

test('cursor: edit: the user bubble rewritten in place (same id), its children overwritten, later bubbles hard-deleted: later keys gone, no lifecycle record', () => {
  const recs = golden('features')[CID(2)];
  assert.deepEqual(msgIds(recs), [U(1), A(U(1)), U(2), A(U(2))]);
  assert.equal(msg(recs, U(2)).parts[0].text, 'Run the tests with unittest instead.');
  assert.deepEqual(msg(recs, A(U(2))).parts.map((p) => p.part_id), ['s:0', 's:1']);
  assert.deepEqual(ofType(recs, 'lifecycle'), []);
  // Live: the edit reaches the engine as a delta (changed bubbles, `gone` keys), and exactly the
  // vanished keys are tombstoned.
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    assert.ok(msgIds(viewOf(e, CID(1))).includes(U(3)));
    const t = Date.parse(getValue(dir, `bubbleId:${CID(1)}:${U(2)}`).createdAt);
    const ub = getValue(dir, `bubbleId:${CID(1)}:${U(2)}`);
    put(dir, `bubbleId:${CID(1)}:${U(2)}`, { ...ub, text: 'Run the tests with unittest.', richText: '' });
    const s1 = getValue(dir, `bubbleId:${CID(1)}:${U(2)}/s:1`);
    put(dir, `bubbleId:${CID(1)}:${U(2)}/s:1`, { ...s1, text: 'Ran unittest.', createdAt: new Date(t + 9000).toISOString() });
    const cd = getValue(dir, `composerData:${CID(1)}`);
    const keep = cd.fullConversationHeadersOnly.slice(0, cd.fullConversationHeadersOnly.findIndex((h) => h.bubbleId === `${U(2)}/s:1`) + 1);
    for (const h of cd.fullConversationHeadersOnly.slice(keep.length)) exec(dir, 'DELETE FROM cursorDiskKV WHERE key = ?', `bubbleId:${CID(1)}:${h.bubbleId}`);
    put(dir, `composerData:${CID(1)}`, { ...cd, fullConversationHeadersOnly: keep });
    e.pass();
    const log = e.log.find((l) => l.session_id === CID(1) && l.source_key === bubblesSource(CID(1)));
    assert.equal(log.continuity, 'delta');
    const out = lastDerive(e, CID(1));
    assert.deepEqual(out.live.message, [A(U(1)), A(U(2)), U(1), U(2)].sort());
    assert.deepEqual(msgIds(viewOf(e, CID(1))), [U(1), A(U(1)), U(2), A(U(2))]);
    assert.equal(msg(viewOf(e, CID(1)), U(2)).parts[0].text, 'Run the tests with unittest.');
    assert.deepEqual(viewOf(e, CID(1)), project(fullReplay(adapter, dir).views())[CID(1)]);
  });
});

test('cursor: held: a reply still generating, a tool still running, a listed bubble not stored yet; only that message waits', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const g = lastDerive(e, CID(8));
    assert.deepEqual(g.held.message, [A(U(2))], 'streaming: composerData status generating');
    assert.deepEqual(g.held.usage, [`message:${A(U(2))}#1`]);
    assert.ok(g.live.message.includes(U(2)) && !g.live.message.includes(A(U(2))), 'the prompt is written, its reply waits');
    assert.ok(!g.changed.some((r) => r.message_id === A(U(2))));
    assert.deepEqual(lastDerive(e, CID(9)).held.message, [A(U(2))], 'a tool still running in the last turn');
    const torn = lastDerive(e, CID(12));
    assert.deepEqual(torn.held.message, [A(U(1))], 'a listed child not stored');
    assert.deepEqual(torn.live.message, [U(1)]);
    // The lab: the main chat lists a user bubble the capture lacks; only it waits.
    assert.deepEqual(golden('lab')[LAB_MAIN].filter((r) => r.message_id === LAB_TURN2), []);
    // The torn chat's bubble lands: released, complete.
    const t1 = getValue(dir, `bubbleId:${CID(1)}:${U(1)}/s:3`);
    put(dir, `bubbleId:${CID(12)}:${U(1)}/s:3`, t1);
    e.pass();
    const next = lastDerive(e, CID(12));
    assert.deepEqual(next.held.message, []);
    assert.equal(next.changed.find((r) => r.message_id === A(U(1))).parts.length, 6);
  });
  // A tool left running in a turn a later prompt has ended is written, interrupted, with its call only.
  const recs = golden('features')[CID(10)];
  const a2 = msg(recs, A(U(2)));
  assert.deepEqual([a2.status, a2.parts.map((p) => p.kind)], ['interrupted', ['reasoning', 'text', 'tool_call']]);
});

test('cursor: held again: a reply regenerated after an edit keeps its last version, then returns complete', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const before = msg(viewOf(e, CID(1)), A(U(3)));
    assert.ok(before);
    // The user edits turn 3 and Cursor regenerates it: the bubbles rewritten as text arrives.
    const ub = getValue(dir, `bubbleId:${CID(1)}:${U(3)}`);
    put(dir, `bubbleId:${CID(1)}:${U(3)}`, { ...ub, text: 'Run: seq 1 3' });
    const s1 = getValue(dir, `bubbleId:${CID(1)}:${U(3)}/s:1`);
    put(dir, `bubbleId:${CID(1)}:${U(3)}/s:1`, { ...s1, text: 'Runn' });
    const cd = getValue(dir, `composerData:${CID(1)}`);
    put(dir, `composerData:${CID(1)}`, { ...cd, status: 'generating', generatingBubbleIds: [U(3)] });
    e.pass();
    const mid = lastDerive(e, CID(1));
    assert.deepEqual(mid.held.message, [A(U(3))]);
    assert.ok(!mid.live.message.includes(A(U(3))) && !mid.changed.some((r) => r.message_id === A(U(3))));
    assert.deepEqual(msg(viewOf(e, CID(1)), A(U(3))), before, 'the consumer keeps the last version');
    put(dir, `bubbleId:${CID(1)}:${U(3)}/s:1`, { ...s1, text: 'Ran seq 1 3.' });
    put(dir, `composerData:${CID(1)}`, { ...cd, status: 'completed', generatingBubbleIds: [] });
    e.pass();
    const done = lastDerive(e, CID(1));
    assert.deepEqual(done.held.message, []);
    assert.ok(done.live.message.includes(A(U(3))));
    assert.ok(done.changed.find((r) => r.message_id === A(U(3))).parts.some((p) => p.text === 'Ran seq 1 3.'));
  });
});

// sessions-model §1 rule 4: an anchored key names a position after its anchor. A reply regenerated
// under its surviving user bubble takes the same key, revised; it is never two messages.
test('cursor: anchored ids: a reply regenerated under its surviving user bubble keeps `<bubbleId>:assistant`, revised, never two messages', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const reply = () => [...e.views()[CID(1)].values()].filter((r) => r.type === 'message' && r.message_id.startsWith(`${U(3)}:`));
    const [before] = reply();
    const count = msgIds(viewOf(e, CID(1))).length;
    const s1 = getValue(dir, `bubbleId:${CID(1)}:${U(3)}/s:1`);
    put(dir, `bubbleId:${CID(1)}:${U(3)}/s:1`, { ...s1, text: 'Regenerated: 1 2 3.' });
    e.pass();
    const after = reply();
    assert.equal(after.length, 1);
    assert.equal(after[0].message_id, A(U(3)));
    assert.equal(before.message_id, A(U(3)));
    assert.notEqual(after[0].cmp_sha, before.cmp_sha);
    assert.notEqual(after[0].content_sha, before.content_sha);
    assert.ok(after[0].parts.some((p) => p.text === 'Regenerated: 1 2 3.'));
    assert.equal(msgIds(viewOf(e, CID(1))).length, count, 'revised, not added');
    assert.deepEqual(viewOf(e, CID(1)), project(fullReplay(adapter, dir).views())[CID(1)]);
  });
});

test('cursor: anchored ids: a reply regrown under a new user bubble gets a new key; the cut bubble\'s keys are gone', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const before = msgIds(viewOf(e, CID(1)));
    assert.ok(before.includes(A(U(3))));
    // Turn 3 cut and sent again: Cursor writes a new user bubble, so a new anchor.
    const NEW = uuid('e0e0e0e0', 3);
    const swap = (v) => JSON.parse(JSON.stringify(v).replaceAll(U(3), NEW));
    const cd = getValue(dir, `composerData:${CID(1)}`);
    for (const h of cd.fullConversationHeadersOnly.filter((x) => x.bubbleId.split('/')[0] === U(3))) {
      const v = getValue(dir, `bubbleId:${CID(1)}:${h.bubbleId}`);
      exec(dir, 'DELETE FROM cursorDiskKV WHERE key = ?', `bubbleId:${CID(1)}:${h.bubbleId}`);
      if (v) put(dir, `bubbleId:${CID(1)}:${h.bubbleId.replace(U(3), NEW)}`, swap(v));
    }
    put(dir, `composerData:${CID(1)}`, swap(cd));
    e.pass();
    const now = msgIds(viewOf(e, CID(1)));
    assert.ok(!now.includes(U(3)) && !now.includes(A(U(3))), 'the cut keys are gone');
    assert.ok(now.includes(NEW) && now.includes(A(NEW)));
    assert.equal(now.length, before.length);
    assert.deepEqual(viewOf(e, CID(1)), project(fullReplay(adapter, dir).views())[CID(1)]);
  });
});

test('cursor: fork: a new composer with identical bubble ids and times, no parent field: no link; archived as a flag with no time', () => {
  const g = golden('features');
  const fork = g[CID(3)];
  assert.deepEqual(msgIds(fork), [U(1), A(U(1))], 'copied bubbles keep their ids');
  assert.deepEqual(ofType(fork, 'link'), [], 'no explicit link: the engine infers forks');
  assert.deepEqual(msg(fork, U(1)).cmp_sha, msg(g[CID(1)], U(1)).cmp_sha);
  assert.ok(msg(fork, U(1)).ts < ofType(fork, 'session')[0].created_at, 'copied bubbles keep the origin times (lab cases, unpublished)');
  const s = ofType(fork, 'session')[0];
  assert.deepEqual([s.title, s.state], ['(1) Toy cart qty fix', 'archived']);
  assert.deepEqual(ofType(fork, 'lifecycle').map((r) => [r.op, r.target, r.ts, r.evidence]), [['archive', { session: true }, null, 'explicit']]);
  assert.equal(ofType(golden('lab')['f01e1200-000d-4000-8000-00000000000d'], 'session')[0].state, 'archived', 'the lab fork, archived');
});

test('cursor: sub-agents: the parent names them (origin side, deduped, in stored order); the child\'s kind is null and it states no link', () => {
  const g = golden('features');
  assert.deepEqual(ofType(g[CID(4)], 'link').map((l) => [l.kind, l.stated_on, l.child.session_id, l.origin.session_id, l.at, l.evidence]), [
    ['subagent', 'origin', CID(5), CID(4), '', 'explicit'],
    ['subagent', 'origin', CID(13), CID(4), '', 'explicit'],
  ]);
  assert.deepEqual([ofType(g[CID(5)], 'session')[0].kind, ofType(g[CID(5)], 'link')], [null, []]);
  assert.ok(!g[CID(13)], 'the second child was never stored: only the statement exists');
});

// sessions-model v1.3, §2.1 (`kind`, the native session type): a flag is not a kind. The
// header's `isSubagent` leaves `kind` null, and the sub-agent is told by its `subagent` link: for
// Cursor, the parent's origin-side link (a child names no parent).
test('cursor: kind is null for every session, a header with isSubagent 1 included; the parent\'s subagent link names that chat', () => {
  for (const name of CASES) {
    withStore(name, (dir) => {
      const views = project(fullReplay(adapter, dir).views());
      for (const [sid, recs] of Object.entries(views)) assert.equal(ofType(recs, 'session')[0].kind, null, `${name} ${sid}`);
      if (name !== 'features') return;
      const db = new DatabaseSync(path.join(dir, DB_REL), { readOnly: true });
      const flagged = db.prepare('SELECT composerId FROM composerHeaders WHERE isSubagent = 1').all().map((r) => r.composerId);
      db.close();
      assert.deepEqual(flagged, [CID(5)], 'the store flags the child');
      const links = Object.values(views).flat().filter((r) => r.type === 'link' && r.kind === 'subagent' && r.child.session_id === CID(5));
      assert.deepEqual(links.map((l) => [l.stated_on, l.origin.session_id, l.evidence]), [['origin', CID(4), 'explicit']]);
    });
  }
});

test('cursor: older format: bubbles inline in composerData.conversation; a standalone assistant bubble keeps its own id', () => {
  const recs = golden('features')[CID(6)];
  const a = msg(recs, uuid('a0a0a062', 62));
  assert.deepEqual(msgIds(recs), [U(61), a.message_id]);
  assert.deepEqual(a.parts.map((p) => p.kind), ['reasoning', 'text']);
  assert.deepEqual(ofType(recs, 'usage').map((u) => [u.input, u.output]), [[900, 12]]);
});

test('cursor: session record: title, cwd, created, mode; volatile fields stay out; a draft is a session with no messages', () => {
  const s = ofType(golden('features')[CID(1)], 'session')[0];
  assert.deepEqual([s.title, s.cwd, s.created_at, s.updated_at, s.mode, s.state, s.reuse, s.ts_source, s.incarnation],
    ['Toy cart qty fix', '/home/user/work/toyshop', '2026-10-20T12:32:52.400Z', null, 'agent', 'active', 'impossible', 'event', '']);
  assert.equal(s.fingerprint.cmp_shas.length, 6);
  const draft = golden('features')[CID(11)];
  assert.deepEqual(draft.map((r) => r.type), ['session']);
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const key = keyOf(store, adapter.list(store).find((x) => x.session_id === CID(1)));
    const cd = adapter.read(store, key, composerDataSource(CID(1)));
    const hd = adapter.read(store, key, HEADERS);
    // A view, a gauge tick and a height hint move nothing; a rename moves the snapshots only.
    const v = getValue(dir, `composerData:${CID(1)}`);
    put(dir, `composerData:${CID(1)}`, {
      ...v, lastUpdatedAt: 1, lastReadAtMs: 2, contextTokensUsed: 3, contextUsagePercent: 4, conversationState: '~x', latestChatGenerationUUID: 'g2',
      fullConversationHeadersOnly: v.fullConversationHeadersOnly.map((h) => ({ ...h, contentHeightHint: 132 })),
    });
    exec(dir, "UPDATE composerHeaders SET recency = recency + 5, lastUpdatedAt = lastUpdatedAt + 5, checkpointAt = 9, value = json_set(value, '$.lastUpdatedAt', 7, '$.hasUnreadMessages', json('true')) WHERE composerId = ?", CID(1));
    assert.equal(adapter.read(store, key, composerDataSource(CID(1)), cd.position).continuity, 'unchanged');
    assert.equal(adapter.read(store, key, HEADERS, hd.position).continuity, 'unchanged');
    put(dir, `composerData:${CID(1)}`, { ...v, name: 'cart work renamed' });
    exec(dir, "UPDATE composerHeaders SET value = json_set(value, '$.name', 'cart work renamed') WHERE composerId = ?", CID(1));
    assert.equal(adapter.read(store, key, composerDataSource(CID(1)), cd.position).continuity, 'snapshot');
    assert.equal(adapter.read(store, key, HEADERS, hd.position).continuity, 'snapshot');
    const recs = project(fullReplay(adapter, dir).views())[CID(1)];
    assert.equal(ofType(recs, 'session')[0].title, 'cart work renamed');
    assert.deepEqual(ofType(recs, 'message'), ofType(golden('features')[CID(1)], 'message'), 'messages unchanged by a rename');
  });
});

test('cursor: redaction: the composer\'s two keys are replaced in read; the login row is never read; free text keeps its sentinel', () => {
  withStore('features', (dir) => {
    const e = fullReplay(adapter, dir);
    const units = [...e.sessions.values()].flatMap((s) => [...s.sources.values()].flatMap((src) => [...src.units.values()]));
    const all = JSON.stringify(units) + JSON.stringify(project(e.views()));
    for (const s of [SENTINEL_BLOB, SENTINEL_SPEC, SENTINEL_LOGIN]) assert.ok(!all.includes(s), 'a secret value left read');
    const cd = units.find((u) => u.source_key === composerDataSource(CID(1)));
    assert.equal(cd.redacted, true);
    const v = JSON.parse(JSON.parse(cd.body).cursorDiskKV[0].value);
    assert.deepEqual([v.blobEncryptionKey, v.speculativeSummarizationEncryptionKey], [`<redacted len=${SENTINEL_BLOB.length}>`, `<redacted len=${SENTINEL_SPEC.length}>`]);
    assert.ok(units.filter((u) => u.source_key !== composerDataSource(CID(1)) && u.source_key.includes('#kv:composerData:') && u.unit_key).every((u) => !u.body.includes(SENTINEL_BLOB)));
    assert.ok(JSON.stringify(project(e.views())[CID(7)]).includes(SENTINEL_TEXT), 'free text is out of reach (sessions-model §4.6)');
  });
  // The lab rows were captured with the markers already in place: nothing more to replace.
  withStore('lab', (dir) => {
    const u = unitsOf(dir, LAB_MAIN).find((x) => x.source_key === composerDataSource(LAB_MAIN)).units[0];
    assert.equal(u.redacted, false);
    assert.match(JSON.parse(JSON.parse(u.body).cursorDiskKV[0].value).blobEncryptionKey, /^<redacted len=44>$/);
  });
});

// ---- list and read --------------------------------------------------------------------------------

test('cursor: list names every composerHeaders row and its three sources; the hint moves with this chat only', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const sessions = adapter.list(store);
    assert.deepEqual(sessions.map((s) => s.session_id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(CID));
    assert.deepEqual(adapter.list(store), sessions, 'list is stable');
    const s1 = sessions[0];
    assert.deepEqual([s1.incarnation, s1.live], ['', 'unknown']);
    assert.deepEqual(s1.sources.map((x) => [x.source_key, x.role, x.mode, x.position_kind]), [
      [`User/globalStorage/state.vscdb#kv:bubbleId:${CID(1)}:`, 'main', 'delta', 'kv'],
      [`User/globalStorage/state.vscdb#kv:composerData:${CID(1)}`, 'main', 'snapshot', 'snapshot'],
      ['User/globalStorage/state.vscdb#table:composerHeaders', 'side', 'snapshot', 'snapshot'],
    ]);
    const hint = (sid) => adapter.list(store).find((s) => s.session_id === sid).updated_hint;
    const h1 = hint(CID(1));
    const h2 = hint(CID(2));
    exec(dir, 'UPDATE composerHeaders SET recency = recency + 5000');
    exec(dir, 'UPDATE composerHeaders SET lastUpdatedAt = lastUpdatedAt + 5000 WHERE composerId = ?', CID(2));
    put(dir, `bubbleId:${CID(2)}:new`, { type: 2 });
    assert.equal(hint(CID(1)), h1, 'a write to another chat in the shared database leaves this hint');
    assert.notEqual(hint(CID(2)), h2);
    const key = `bubbleId:${CID(1)}:${U(1)}/t:${CALL(1)}`;
    const tb = getValue(dir, key);
    const steps = [
      [() => exec(dir, 'UPDATE composerHeaders SET lastUpdatedAt = lastUpdatedAt + 7000 WHERE composerId = ?', CID(1)), 'lastUpdatedAt'],
      [() => put(dir, key, { ...tb, toolFormerData: { ...tb.toolFormerData, result: '{"totalLinesInFile":9}' } }), 'a late tool result in an existing bubble'],
      [() => put(dir, key, { ...tb, toolFormerData: { ...tb.toolFormerData, result: '{"totalLinesInFile":9}' } }), 'a same-bytes rewrite (the upsert gives a new rowid)'],
      [() => exec(dir, "UPDATE composerHeaders SET value = json_set(value, '$.name', 'Renamed') WHERE composerId = ?", CID(1)), 'a rename, no lastUpdatedAt bump'],
      [() => put(dir, `composerData:${CID(1)}`, { ...getValue(dir, `composerData:${CID(1)}`), subagentComposerIds: [CID(5)] }), 'a composerData-only change'],
    ];
    let prev = hint(CID(1));
    assert.equal(prev, h1);
    for (const [step, why] of steps) {
      step();
      const h = hint(CID(1));
      assert.notEqual(h, prev, why);
      prev = h;
    }
  });
  // The bubble range is a search on the covering key index, no table row read.
  withStore('features', (dir) => {
    const d = new DatabaseSync(path.join(dir, DB_REL), { readOnly: true });
    const plan = d.prepare(`EXPLAIN QUERY PLAN ${BUBBLE_KEY_SQL}`).all('bubbleId:x:', 'bubbleId:x;').map((r) => r.detail).join(' | ');
    d.close();
    assert.match(plan, /SEARCH cursorDiskKV USING COVERING INDEX \S+ \(key>\? AND key<\?\)/);
  });
});

test('cursor: list: an install without composerHeaders rows falls back to the composerData keys', () => {
  withStore('features', (dir) => {
    exec(dir, 'DROP TABLE composerHeaders');
    const store = storeOf(adapter, dir);
    const sessions = adapter.list(store);
    assert.deepEqual(sessions.map((s) => s.session_id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map(CID), 'the draft had no composerData row');
    const recs = project(fullReplay(adapter, dir).views());
    assert.equal(ofType(recs[CID(1)], 'session')[0].title, 'Toy cart qty fix');
    assert.deepEqual(msgIds(recs[CID(1)]), msgIds(golden('features')[CID(1)]));
    assert.equal(ofType(recs[CID(3)], 'session')[0].state, 'active', 'the archive flag lives in the header row');
  });
});

test('cursor: read: the bubble range diffs against known (unchanged, then a changed and a gone unit); snapshots compare by sha', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const key = keyOf(store, adapter.list(store).find((x) => x.session_id === CID(7)));
    const r1 = adapter.read(store, key, bubblesSource(CID(7)));
    assert.equal(r1.continuity, 'reset');
    assert.ok(r1.units.every((u) => u.enc === 'row-json' && u.unit_key.startsWith(`bubbleId:${CID(7)}:`)));
    assert.equal(r1.units.length, 7, 'every bubble of the range, listed or not');
    assert.ok(r1.units.some((u) => u.unit_key.includes('\n')), 'a key holding a newline is a unit key as stored');
    const known = Object.fromEntries(r1.units.map((u) => [u.unit_key, u.sha256]));
    assert.equal(adapter.read(store, key, bubblesSource(CID(7)), r1.position, known).continuity, 'unchanged');
    const sn = adapter.read(store, key, composerDataSource(CID(7)));
    assert.deepEqual([sn.continuity, sn.units[0].enc, sn.units[0].unit_key], ['reset', 'rows-json', composerDataSource(CID(7))]);
    assert.equal(adapter.read(store, key, composerDataSource(CID(7)), sn.position).continuity, 'unchanged');
    const k = `bubbleId:${CID(7)}:${U(72)}/s:0`;
    put(dir, k, { ...getValue(dir, k), text: '2.50, tax included.' });
    exec(dir, 'DELETE FROM cursorDiskKV WHERE key = ?', `bubbleId:${CID(7)}:${uuid('deadbeef', 70)}`);
    const r2 = adapter.read(store, key, bubblesSource(CID(7)), r1.position, known);
    assert.equal(r2.continuity, 'delta');
    assert.deepEqual(r2.units.map((u) => u.unit_key), [k]);
    assert.deepEqual(r2.gone, [`bubbleId:${CID(7)}:${uuid('deadbeef', 70)}`]);
    assert.equal(adapter.read(store, key, bubblesSource(CID(7)), r1.position, null).continuity, 'delta', 'from without known: still a diff, of every unit');
  });
});

test('cursor: a WAL store with no -wal is read immutable: list and read create nothing beside the database', () => {
  withStore('features', (dir) => {
    const folder = path.join(dir, 'User', 'globalStorage');
    const before = fs.readdirSync(folder).sort();
    assert.deepEqual(before, ['state.vscdb']);
    project(fullReplay(adapter, dir).views());
    assert.deepEqual(fs.readdirSync(folder).sort(), before);
  });
});

test('cursor: a WAL-only row (Cursor running, no checkpoint) is read', () => {
  withStore('features', (dir) => {
    const w = writer(dir);
    try {
      w.exec('PRAGMA wal_autocheckpoint = 0');
      w.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(`bubbleId:${CID(7)}:wal-only`, '{"type":2}');
      assert.ok(fs.existsSync(path.join(dir, `${DB_REL}-wal`)));
      const store = storeOf(adapter, dir);
      const key = keyOf(store, adapter.list(store).find((x) => x.session_id === CID(7)));
      assert.ok(adapter.read(store, key, bubblesSource(CID(7))).units.some((u) => u.unit_key.endsWith(':wal-only')));
    } finally {
      w.close();
    }
  });
});

test('cursor: a locked store (Cursor mid-save) is busy in list and read, never fewer rows; once free, the same records', () => {
  withStore('features', (dir) => {
    const w = writer(dir);
    w.exec('PRAGMA journal_mode = DELETE'); // a rollback-journal copy: a write lock there blocks readers
    const store = storeOf(adapter, dir);
    const full = project(fullReplay(adapter, dir).views());
    const s = adapter.list(store)[0];
    w.exec('BEGIN EXCLUSIVE');
    try {
      assert.throws(() => adapter.list(store), { code: 'busy' });
      assert.throws(() => adapter.read(store, keyOf(store, s), bubblesSource(s.session_id)), { code: 'busy' });
    } finally {
      w.exec('ROLLBACK');
      w.close();
    }
    assert.deepEqual(project(fullReplay(adapter, dir).views()), full);
  });
});

test('cursor: damaged: a stored bubble, composerData or header value that does not parse; a corrupt page; a file that is no database', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const key = keyOf(store, adapter.list(store).find((x) => x.session_id === CID(7)));
    const cases = [
      [`bubbleId:${CID(7)}:${U(71)}/s:2`, bubblesSource(CID(7)), 'a half-written bubble'],
      [`composerData:${CID(7)}`, composerDataSource(CID(7)), 'a half-written composerData row'],
    ];
    for (const [k, src, why] of cases) {
      const keep = getValue(dir, k);
      exec(dir, 'INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)', k, '{"_v":3,"type":2,"te');
      assert.throws(() => adapter.read(store, key, src), { code: 'damaged' }, why);
      put(dir, k, keep);
    }
    const r = new DatabaseSync(path.join(dir, DB_REL), { readOnly: true });
    const hv = r.prepare('SELECT value FROM composerHeaders WHERE composerId = ?').get(CID(7)).value;
    r.close();
    exec(dir, 'UPDATE composerHeaders SET value = ? WHERE composerId = ?', '{"type":"head","na', CID(7));
    assert.throws(() => adapter.read(store, key, HEADERS), { code: 'damaged' }, 'a half-written header value');
    exec(dir, 'UPDATE composerHeaders SET value = ? WHERE composerId = ?', hv, CID(7));
    assert.equal(adapter.read(store, key, HEADERS).units.length, 1);
    // Overwrite the b-tree header of every page after the schema page.
    const w = writer(dir);
    w.exec('PRAGMA journal_mode = DELETE');
    w.close();
    const file = path.join(dir, DB_REL);
    const buf = fs.readFileSync(file);
    const ps = buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16);
    for (let off = ps; off + 16 <= buf.length; off += ps) buf.fill(0xa5, off, off + 16);
    fs.writeFileSync(file, buf);
    assert.throws(() => adapter.read(store, key, bubblesSource(CID(7))), { code: 'damaged' });
    fs.writeFileSync(file, Buffer.alloc(8192, 0x41));
    assert.throws(() => adapter.list(store), { code: 'damaged' });
  });
});

test('cursor: inconsistent: bubbles stored but no composerData row (the order unknown); a chat with neither is an empty one', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const sessions = adapter.list(store);
    const key = keyOf(store, sessions.find((x) => x.session_id === CID(7)));
    exec(dir, 'DELETE FROM cursorDiskKV WHERE key = ?', `composerData:${CID(7)}`);
    assert.throws(() => adapter.read(store, key, composerDataSource(CID(7))), { code: 'inconsistent' });
    const draft = keyOf(store, sessions.find((x) => x.session_id === CID(11)));
    const r = adapter.read(store, draft, composerDataSource(CID(11)));
    assert.deepEqual(JSON.parse(r.units[0].body), { cursorDiskKV: [] });
    assert.deepEqual(adapter.read(store, draft, bubblesSource(CID(11))).units, []);
  });
});

test('cursor: errors: an unknown chat, another chat\'s source, an unknown source, a deleted chat, no database', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.session_id === CID(4));
    const key = keyOf(store, s);
    assert.throws(() => adapter.read(store, { ...key, session_id: uuid('99999999', 9) }, HEADERS), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, bubblesSource(CID(1))), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key, `${DB_REL}#table:ItemTable`), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key, `${DB_REL}#kv:agentKv:blob:`), { code: 'source_unknown' });
    exec(dir, 'DELETE FROM composerHeaders WHERE composerId = ?', CID(4));
    assert.ok(!adapter.list(store).some((x) => x.session_id === CID(4)));
    assert.throws(() => adapter.read(store, key, composerDataSource(CID(4))), { code: 'session_unknown' }, 'membership is the header row, not composerData');
    fs.rmSync(path.join(dir, 'User'), { recursive: true });
    assert.deepEqual(adapter.list(store), []);
    assert.throws(() => adapter.read(store, key, HEADERS), { code: 'session_unknown' });
  });
});

test('cursor: a symlinked database, globalStorage folder or User folder is neither listed nor read', () => {
  withStore('features', (real) => {
    for (const link of ['file', 'globalStorage', 'User']) {
      const dir = tmpStore();
      try {
        const store = storeOf(adapter, dir);
        if (link === 'file') {
          fs.mkdirSync(path.join(dir, 'User', 'globalStorage'), { recursive: true });
          fs.symlinkSync(path.join(real, DB_REL), path.join(dir, DB_REL));
        } else if (link === 'globalStorage') {
          fs.mkdirSync(path.join(dir, 'User'));
          fs.symlinkSync(path.join(real, 'User', 'globalStorage'), path.join(dir, 'User', 'globalStorage'));
        } else {
          fs.symlinkSync(path.join(real, 'User'), path.join(dir, 'User'));
        }
        assert.deepEqual(adapter.list(store), [], link);
        const key = { ...store, session_id: CID(1), incarnation: '' };
        assert.throws(() => adapter.read(store, key, HEADERS), (e) => e.code === 'session_unknown' || e.code === 'source_unknown', link);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

test('cursor: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'cursor');
  assert.equal(d.model_version, 'sessions-model/1');
  assert.deepEqual(d.store_shape, { kind: 'folder' });
  assert.equal(d.facets.reuse, 'impossible');
  assert.deepEqual(d.sources.map((x) => x.pattern).sort(), [bubblesSource('<cid>'), composerDataSource('<cid>'), HEADERS].sort());
  for (const op of ['rewind', 'edit', 'compaction', 'delete', 'archive', 'unarchive', 'rename', 'pin', 'unpin', 'fork', 'clear']) {
    assert.ok(['explicit', 'implicit', 'invisible'].includes(d.facets.lifecycle[op]), op);
  }
  for (const k of ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation']) {
    assert.ok(['explicit', 'inferable', 'none'].includes(d.facets.linkage[k]), k);
  }
  const all = CASES.flatMap((c) => Object.values(golden(c)).flat());
  const ops = new Set(ofType(all, 'lifecycle').map((r) => r.op));
  for (const [op, v] of Object.entries(d.facets.lifecycle)) if (v === 'explicit') assert.ok(ops.has(op), `explicit ${op} has no fixture record`);
  const kinds = new Set(ofType(all, 'link').map((r) => r.kind));
  for (const [k, v] of Object.entries(d.facets.linkage)) if (v === 'explicit') assert.ok(kinds.has(k), `explicit ${k} link has no fixture record`);
  // linkage.tool native: in every chat, a call has exactly one result at most, by call_id.
  for (const recs of CASES.flatMap((c) => Object.values(golden(c)))) {
    const results = ofType(recs, 'message').flatMap((m) => m.parts.filter((p) => p.kind === 'tool_result'));
    for (const p of ofType(recs, 'message').flatMap((m) => m.parts.filter((x) => x.kind === 'tool_call'))) {
      assert.ok(results.filter((r) => r.call_id === p.call_id).length <= 1, p.call_id);
    }
  }
});

// sessions-model v1.3, §2.3 (`tool_result.is_error`): the harness store's own flag, an `error`
// status (the tool's or `additionalData`'s) true and `completed` false. A `completed` beside a
// shell's non-zero exit_code is unreliable for that result, so its is_error is null. Never derived
// from exit_code: an exit code without an error status is no error.
test('cursor: is_error is the stored status: completed beside a non-zero exit is null, an error status is true, never from the exit code', () => {
  withStore('features', (dir) => {
    const key = `bubbleId:${CID(1)}:${U(2)}/t:${CALL(2, 1)}`;
    const resultOf = () => {
      const p = ofType(project(fullReplay(adapter, dir).views())[CID(1)], 'message').flatMap((m) => m.parts).find((x) => x.kind === 'tool_result' && x.call_id === CALL(2, 1));
      return [p.is_error, p.exit_code, p.status];
    };
    const edit = (fn) => {
      const v = getValue(dir, key);
      fn(v.toolFormerData);
      exec(dir, 'UPDATE cursorDiskKV SET value = ? WHERE key = ?', Buffer.from(JSON.stringify(v)), key);
    };
    assert.deepEqual(resultOf(), [true, 1, 'completed'], 'additionalData.status error beside exit 1: the flag says failure');
    // Edited in this copy: no error status, so `completed` beside exit 1 (null), then exit 0 (false);
    // the tool's own `error` status (true); and a cancel beside exit 1 (null: no call that completed).
    edit((t) => { t.additionalData = { startedAtMs: t.additionalData.startedAtMs }; });
    assert.deepEqual(resultOf(), [null, 1, 'completed'], 'completed beside exit 1: unreliable for this result');
    edit((t) => { t.result = t.result.replace('"exitCode":1', '"exitCode":0'); });
    assert.deepEqual(resultOf(), [false, 0, 'completed'], 'completed, exit 0');
    edit((t) => { t.status = 'error'; t.result = t.result.replace('"exitCode":0', '"exitCode":1'); });
    assert.deepEqual(resultOf(), [true, 1, 'completed'], 'an error status');
    edit((t) => { t.status = 'cancelled'; });
    assert.deepEqual(resultOf(), [null, 1, 'cancelled'], 'cancelled beside exit 1');
  });
});

// sessions-model v1.3, §2.3 (`tool_result.is_error`): `is_error` describes a call that
// completed. A denial (`rejected`, or a result that says `rejected`) is `denied`, and a cancel or
// an abort is `cancelled`: their is_error is null, and the status carries the fact, whatever an
// error status beside it says. A call that completed keeps the flag (the positive control).
test('cursor: is_error is null where the call did not complete: a denial, a cancel or an abort; the status carries the fact', () => {
  const resultsOf = (dir, sid, uid) => msg(project(fullReplay(adapter, dir).views())[sid], A(uid)).parts.filter((p) => p.kind === 'tool_result').map((p) => [p.status, p.is_error]);
  withStore('features', (dir) => {
    assert.deepEqual(resultsOf(dir, CID(1), U(3)), [['cancelled', null]], 'cancelled by the user');
    assert.deepEqual(resultsOf(dir, CID(7), U(71)), [['denied', null]], 'a rejected tool');
    const key = `bubbleId:${CID(1)}:${U(2)}/t:${CALL(2, 1)}`;
    const resultOf = () => {
      const p = msg(project(fullReplay(adapter, dir).views())[CID(1)], A(U(2))).parts.find((x) => x.kind === 'tool_result' && x.call_id === CALL(2, 1));
      return [p.status, p.is_error];
    };
    const edit = (fn) => {
      const v = getValue(dir, key);
      fn(v.toolFormerData);
      exec(dir, 'UPDATE cursorDiskKV SET value = ? WHERE key = ?', Buffer.from(JSON.stringify(v)), key);
    };
    // The positive control: the fixture's error status, then a plain completed.
    assert.deepEqual(resultOf(), ['completed', true], 'additionalData.status error: the flag');
    // Edited in this copy, each beside additionalData.status error.
    edit((t) => { t.status = 'aborted'; });
    assert.deepEqual(resultOf(), ['cancelled', null], 'aborted');
    edit((t) => { t.status = 'rejected'; });
    assert.deepEqual(resultOf(), ['denied', null], 'rejected');
    edit((t) => { t.status = 'completed'; t.result = JSON.stringify({ ...JSON.parse(t.result), rejected: true }); });
    assert.deepEqual(resultOf(), ['denied', null], 'a result that says rejected');
    edit((t) => { t.result = JSON.stringify({ ...JSON.parse(t.result), rejected: false }); t.additionalData = { startedAtMs: t.additionalData.startedAtMs }; t.result = t.result.replace('"exitCode":1', '"exitCode":0'); });
    assert.deepEqual(resultOf(), ['completed', false], 'completed, exit 0: the flag');
  });
  withStore('lab', (dir) => {
    assert.deepEqual(resultsOf(dir, LAB_MAIN, LAB_TURN3), [['cancelled', null]], 'the lab\'s cancelled loop');
  });
});

test('cursor: a tool_result carries the stored result.exitCode; a result without one has none', () => {
  for (const name of CASES) {
    withStore(name, (dir) => {
      const views = project(fullReplay(adapter, dir).views());
      const results = (sid) => ofType(views[sid], 'message').flatMap((m) => m.parts).filter((p) => p.kind === 'tool_result');
      if (name === 'features') {
        // `result: {"output": "...No module named pytest\n", "exitCode": 1}`: the code, never the text.
        const byCall = Object.fromEntries(results(CID(1)).map((p) => [p.call_id, p]));
        assert.equal(byCall[CALL(2, 1)].exit_code, 1);
        assert.equal(byCall[CALL(1)].exit_code, null, 'a read result keeps no exit code');
      } else {
        const shell = results(LAB_MAIN).find((p) => p.output.includes('pytest'));
        assert.equal(shell.exit_code, 1);
        assert.ok(results(LAB_MAIN).some((p) => p.exit_code === null));
      }
    });
  }
});
