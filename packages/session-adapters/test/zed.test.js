import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { adapterFor } from '../src/index.js';
import { MAIN, THREADS_REL, sidebarKey, sidebarRel } from '../src/harnesses/zed/index.js';
import { sha256 } from '../src/jcs.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, tmpStore, storeOf, nameLint } from '../conformance/runner.js';
import { prepareStore, sqlGrowthCheck, sqlFilesOf, buildDb } from '../conformance/sql-store.js';
import {
  CASES as GENERATED, LAB, T, U, C, R, S, SENTINEL,
  heldThread, cartThread, thread, user, agent, use, res, restoreLabCapture,
} from '../fixtures/zed/generate.js';

const adapter = adapterFor('zed');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'zed');
const CASES = ['lab', 'features', 'restore', 'restore-lab', 'sentinel'];
const EXEMPT = adapter.describe().redaction.exemptions;
const STABLE = sidebarKey('0-stable');
const PREVIEW = sidebarKey('0-preview');

function withStore(name, fn) {
  const dir = tmpStore();
  try {
    if (name) prepareStore(path.join(FIX, name), dir);
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
const A = (uid, n) => `${uid}+${n}`;
function lastDerive(e, sid) {
  for (const [id, s] of e.sessions) if (id.split('\u0000')[0] === sid) return s.last;
  return null;
}
function viewOf(e, sid) {
  return project(e.views())[sid] ?? [];
}
function unitsOf(dir, sid) {
  const store = storeOf(adapter, dir);
  const s = adapter.list(store).find((x) => x.session_id === sid);
  return s.sources.map((x) => ({ source_key: x.source_key, generation: 1, complete: true, units: adapter.read(store, keyOf(store, s), x.source_key).units, gone: [] }));
}
// A writer on a case's built database (Zed, in a test).
const writer = (dir, rel = THREADS_REL) => new DatabaseSync(path.join(dir, rel));
function save(dir, sid, t, { json = false } = {}) {
  const w = writer(dir);
  w.prepare('UPDATE threads SET data = ?, data_type = ?, updated_at = ? WHERE id = ?')
    .run(json ? Buffer.from(JSON.stringify(t)) : zlib.zstdCompressSync(Buffer.from(JSON.stringify(t))), json ? 'json' : 'zstd', '2026-10-21T10:00:00.000000000+00:00', sid);
  w.close();
}
const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exemptRe = EXEMPT.map((e) => new RegExp(`(^|[.:])${e.split('[]').map(escape).join('\\[\\d+\\]')}(\\[\\d+\\])*$`));
const lint = (value, at) => nameLint(value, [], at).filter((h) => !exemptRe.some((re) => re.test(h)));

// ---- conformance --------------------------------------------------------------------------------

for (const name of CASES) {
  test(`zed/${name}: the full replay equals the reviewed golden`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), golden(name)));
  });

  test(`zed/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    for (const steps of [5, 12]) {
      const r = sqlGrowthCheck(adapter, path.join(FIX, name), { steps });
      assert.deepEqual(r.incremental, r.full);
      assert.ok(r.equal, 'content_sha differs between the incremental and the full view');
      assert.deepEqual(r.notUnchanged, []);
    }
  });

  test(`zed/${name}: keys are stable across a lost state`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), project(fullReplay(adapter, dir).views())));
  });

  test(`zed/${name}: no string under a secret-looking name in any unit (the decoded thread included) or record`, () => {
    withStore(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) for (const u of src.units.values()) hits.push(...lint(JSON.parse(u.body), `${u.source_key}:`));
        for (const r of s.view.values()) hits.push(...lint(r, `${r.type}:`));
      }
      assert.deepEqual(hits, []);
    });
  });
}

test('zed: the folded result does not depend on the order sources are given', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    for (const s of adapter.list(store)) {
      const input = unitsOf(dir, s.session_id);
      const a = adapter.derive(keyOf(store, s), input, null);
      const b = adapter.derive(keyOf(store, s), [...input].reverse(), null);
      const sorted = (out) => out.changed.map((r) => JSON.stringify(r)).sort();
      assert.deepEqual(sorted(b), sorted(a));
      assert.deepEqual([b.live, b.held], [a.live, a.held]);
    }
  });
});

test('zed: derive is pure: no file is opened, listed or stat-ed, and zstd is never called', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const inputs = adapter.list(store).map((s) => ({ key: keyOf(store, s), input: unitsOf(dir, s.session_id) }));
    const names = ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'readSync'];
    const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
    const z = zlib.zstdDecompressSync;
    for (const n of names) fs[n] = () => { throw new Error(`derive called fs.${n}`); };
    zlib.zstdDecompressSync = () => { throw new Error('derive decompressed'); };
    try {
      for (const { key, input } of inputs) adapter.derive(key, input, null);
    } finally {
      Object.assign(fs, orig);
      zlib.zstdDecompressSync = z;
    }
  });
});

// ---- the memhouse normaliser's reviewed cases, as conformance cases --------------------------

test('zed/lab: User ids are kept, Agent messages anchored <user id>+n; four ToolUse ids pair with the four tool_results keys (lab cases, unpublished)', () => {
  const child = golden('lab')[LAB.CHILD];
  assert.deepEqual(msgIds(child), [LAB.CHILD_USER, A(LAB.CHILD_USER, 1), A(LAB.CHILD_USER, 2)]);
  const parent = golden('lab')[LAB.PARENT];
  const parts = ofType(parent, 'message').flatMap((m) => m.parts);
  const calls = parts.filter((p) => p.kind === 'tool_call').map((p) => p.call_id);
  const results = parts.filter((p) => p.kind === 'tool_result').map((p) => p.call_id);
  assert.equal(calls.length, 4);
  assert.deepEqual(results, calls, 'one result per call, by ToolUse.id');
  const m = ofType(parent, 'message').find((x) => x.parts.some((p) => p.part_id === '1:call'));
  assert.deepEqual(m.parts.map((p) => p.part_id), ['0', '1:call', '1:result'], 'call and result as <i>:call / <i>:result on the Agent message');
  assert.ok(ofType(parent, 'message').every((x) => x.ts === null), 'no timestamps: ts null');
  assert.deepEqual(ofType(parent, 'message').map((x) => x.order), parent.filter((r) => r.type === 'message').map((_, i) => String(i).padStart(8, '0')), 'order = array position');
  // The failing command (exit 3) is stored is_error false: unreliable, so null (annex §2).
  const exit3 = parts.find((p) => p.kind === 'tool_result' && p.output.includes('failed with exit code 3'));
  assert.deepEqual([exit3.is_error, exit3.status], [null, 'completed']);
  const s = ofType(parent, 'session')[0];
  assert.deepEqual([s.title, s.cwd, s.created_at, s.mode, s.state, s.ts_source], ['inventory thread (renamed)', '/home/user/work/inventory-cli', '2026-10-19T22:23:11.194Z', 'write', 'active', 'none']);
});

// Annex §4 finding 6: Zed's usage is per_session only. `request_token_usage` is a turn's last
// request, part of the cumulative total (annex §2), so a record of its own would count it twice.
test('zed: a thread with both cumulative_token_usage and request_token_usage yields exactly one usage record, per session, with the cumulative values', () => {
  const only = (recs) => ofType(recs, 'usage').map(({ usage_id, anchor, input, output, cache_read, cache_write, reasoning, cost, input_includes_cache, output_includes_reasoning, granularity, model }) => (
    { usage_id, anchor, input, output, cache_read, cache_write, reasoning, cost, input_includes_cache, output_includes_reasoning, granularity, model }));
  const base = { usage_id: 'session#1', anchor: { session: true }, reasoning: null, cost: null, input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_session', model: null };
  // The lab parent (lab cases, unpublished): cumulative input 130,477; the three per-user values (input 12,135) are not records.
  assert.deepEqual(only(golden('lab')[LAB.PARENT]), [{ ...base, input: 130477, output: 1319, cache_read: 73216, cache_write: null }]);
  assert.deepEqual(only(golden('lab')[LAB.CHILD]), [{ ...base, input: 25684, output: 98, cache_read: 9216, cache_write: null }]);
  assert.deepEqual(only(golden('features')[T.CART]), [{ ...base, input: 130477, output: 1319, cache_read: 73216, cache_write: 2048 }]);
  withStore('lab', (dir) => {
    const e = fullReplay(adapter, dir);
    const total = (recs) => recs.filter((r) => r.type === 'usage').reduce((n, u) => n + u.input, 0);
    assert.equal(total(viewOf(e, LAB.PARENT)), 130477, 'a consumer counting each usage once sums the thread total, no more');
    // request_token_usage stays in the raw unit.
    const store = storeOf(adapter, dir);
    const u = adapter.read(store, keyOf(store, adapter.list(store).find((s) => s.session_id === LAB.PARENT)), MAIN).units[0];
    assert.equal(Object.keys(JSON.parse(u.body).data.request_token_usage).length, 3);
  });
});

// Contract decision, to appear in sessions-model v1.x (refines §2.4 "No overlap", whose one Zed
// record assumes a total): where `cumulative_token_usage` is empty, the `request_token_usage`
// entries are the usage. One record per entry, anchored to the User message the entry is keyed
// by, per_turn, both flags null: not a zero record, and not "no usage". A non-empty cumulative
// stays the one per_session total (above).
test('zed: an empty cumulative_token_usage gives one per_turn usage record per request_token_usage entry, anchored to its User message', () => {
  const only = (recs) => ofType(recs, 'usage').map(({ usage_id, anchor, input, output, cache_read, cache_write, reasoning, cost, tool_prompt, input_includes_cache, output_includes_reasoning, granularity, model }) => (
    { usage_id, anchor, input, output, cache_read, cache_write, reasoning, cost, tool_prompt, input_includes_cache, output_includes_reasoning, granularity, model }));
  const turn = (uid, input, output) => ({
    usage_id: `message:${uid}#1`, anchor: { message_id: uid }, input, output, cache_read: null, cache_write: null, reasoning: null, cost: null, tool_prompt: null,
    input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_turn', model: null,
  });
  withStore('features', (dir) => {
    const e = fullReplay(adapter, dir);
    // The held thread: cumulative {} and two entries. U10's turn still runs a call, so its usage is
    // held with the turn's reply (below); U9's is written.
    assert.deepEqual(only(viewOf(e, T.HELD)), [turn(U.U9, 500, 20)]);
    assert.deepEqual(lastDerive(e, T.HELD).held.usage, [`message:${U.U10}#1`]);
    // Threads with neither (cumulative {}, request_token_usage {}): no usage, and no zero record.
    for (const sid of [T.NOTES, T.COMPACT, T.PARENT, T.CHILD]) assert.deepEqual(only(viewOf(e, sid)), [], sid);
    // A non-empty cumulative beside entries: the total only.
    assert.deepEqual(only(viewOf(e, T.CART)).map((u) => [u.usage_id, u.granularity]), [['session#1', 'per_session']]);
  });
  withStore('restore', (dir) => {
    // The last save: R1's entry kept, R4's for the regrown turn; each anchored to a live User message.
    const recs = viewOf(fullReplay(adapter, dir), R.ID);
    const byId = (a, b) => (a.usage_id < b.usage_id ? -1 : 1);
    assert.deepEqual(only(recs).sort(byId), [turn(R.R1, 400, 9), turn(R.R4, 530, 16)].sort(byId));
    for (const u of ofType(recs, 'usage')) assert.ok(msg(recs, u.anchor.message_id), `${u.usage_id} anchors a message of the thread`);
  });
});

test('zed: statuses: is_error true kept, false is null; Zed\'s canned results are cancelled and denied', () => {
  const recs = golden('features')[T.CART];
  assert.deepEqual(msgIds(recs), [U.U0, U.U1, A(U.U1, 1), U.U2, A(U.U2, 1), A(U.U2, 2), A(U.U2, 3), A(U.U2, 4), U.U3, A(U.U3, 1), A(U.U3, 2)]);
  const res3 = msg(recs, A(U.U3, 1)).parts.filter((p) => p.kind === 'tool_result');
  assert.deepEqual(res3.map((p) => [p.call_id, p.is_error, p.status]), [[C.WAIT, true, 'cancelled'], [C.CLEAN, true, 'denied']]);
  const read = msg(recs, A(U.U2, 1)).parts.find((p) => p.kind === 'tool_call');
  assert.deepEqual([read.name, read.args], ['read_file', { path: 'toyshop/cart.py' }], 'input {type: json, value} unwrapped');
  assert.deepEqual([msg(recs, A(U.U1, 1)).requested_model, msg(recs, A(U.U1, 1)).effort], ['gateway/toy-model-a', 'high'], 'model and effort per thread');
  assert.ok(!ofType(recs, 'message').some((m) => m.parts.some((p) => p.kind === 'tool_result' && p.is_error === false)), 'false never kept');
});

test('zed: reasoning: Thinking text, signature-only and RedactedThinking opaque; reasoning_details only without Thinking; a Mention and an Image', () => {
  const recs = golden('features')[T.NOTES];
  const r = (n) => msg(recs, A(U.U4, n)).parts.filter((p) => p.kind === 'reasoning').map((p) => [p.part_id, p.text ?? null, !!p.opaque]);
  assert.deepEqual(r(1), [['0', null, true], ['1', null, true]]);
  assert.deepEqual(r(2), [['reasoning_details', 'Provider-side reasoning.', false]]);
  assert.deepEqual(r(3), [['reasoning_details', null, true]], 'encrypted details: opaque');
  assert.deepEqual(r(4), [['0', 'Own thinking.', false]], 'no duplicate from reasoning_details');
  assert.ok(!JSON.stringify(recs).includes('c2lnbmF0dXJl') && !JSON.stringify(recs).includes('b3BhcXVl'), 'signatures and encrypted reasoning reach no record');
  const u = msg(recs, U.U4).parts;
  assert.deepEqual([u[1].kind, u[1].source, u[1].text], ['text', 'injected', '# Notes\nPrices are in cents.\n'], 'a Mention: the context the model got');
  assert.deepEqual([u[2].kind, u[2].media_type, u[2].bytes_len, u[2].ref], ['attachment', 'image/png', 'PNG-TOY-LABEL-240x120'.length, null]);
  assert.deepEqual(msg(recs, A(U.U4, 5)).parts[1], { part_id: '1', kind: 'notice', text: '{"Hologram":{"frames":3}}', level: null, native_type: 'Hologram' }, 'an unknown content item is a notice, never dropped');
});

test('zed: Resume and Compaction (source-read, UNVERIFIED): anchored and counted; a compaction is a lifecycle record plus a system summary', () => {
  const recs = golden('features')[T.COMPACT];
  assert.deepEqual(msgIds(recs), [U.U5, A(U.U5, 1), A(U.U5, 2), A(U.U5, 3), A(U.U5, 4), U.U6, A(U.U6, 1), A(U.U6, 2), A(U.U6, 3)]);
  const resume = msg(recs, A(U.U5, 2));
  assert.deepEqual([resume.role, resume.source, resume.parts[0].kind, resume.parts[0].native_type], ['user', 'automated', 'notice', 'Resume']);
  const sum = msg(recs, A(U.U5, 4));
  assert.deepEqual([sum.role, sum.parts[0].kind, sum.parts[0].text, sum.parts[0].replaces], ['system', 'summary', 'Refactored cart.py in two steps.', { through_id: A(U.U5, 3) }]);
  const lc = ofType(recs, 'lifecycle');
  assert.deepEqual(lc.map((x) => [x.lifecycle_id, x.op, x.target, x.at, x.evidence]), [
    [`${MAIN}@${MAIN}#1`, 'compaction', { range: { from_id: U.U5, through_id: A(U.U5, 3) } }, A(U.U5, 4), 'explicit'],
    [`${MAIN}@${MAIN}#2`, 'compaction', { range: { from_id: U.U5, through_id: U.U6 } }, A(U.U6, 1), 'explicit'],
  ]);
  assert.equal(msg(recs, A(U.U6, 1)).parts[0].text, null, 'a provider-native summary has no readable text');
  assert.ok(!JSON.stringify(recs.filter((x) => x.type !== 'message' || x.message_id !== A(U.U6, 2))).includes('b3BhcXVl'));
  // Every replaced message is still there (compaction is not deletion).
  for (const id of [U.U5, A(U.U5, 1), A(U.U5, 2), A(U.U5, 3)]) assert.ok(msg(recs, id));
  assert.equal(msg(recs, A(U.U6, 2)).parts[0].native_type, 'SomethingNew', 'an unknown message kind is a notice, counted');
});

test('zed: sub-agents: the child states its parent; the parent\'s spawn_agent result states the child at that call', () => {
  const child = golden('features')[T.CHILD];
  const cl = ofType(child, 'link');
  assert.deepEqual(cl.map((l) => [l.kind, l.stated_on, l.origin, l.at, l.evidence]), [['subagent', 'child', { harness: 'zed', session_id: T.PARENT }, '', 'explicit']]);
  assert.equal(ofType(child, 'session')[0].kind, 'subagent');
  const parent = golden('features')[T.PARENT];
  assert.deepEqual(ofType(parent, 'link').map((l) => [l.stated_on, l.child, l.at]), [['origin', { harness: 'zed', session_id: T.CHILD }, C.SPAWN]]);
  // The lab child states its parent through subagent_context and the row's parent_id: one link.
  assert.equal(ofType(golden('lab')[LAB.CHILD], 'link').length, 1);
  assert.equal(ofType(golden('lab')[LAB.PARENT], 'link').length, 0, 'the lab parent has no spawn_agent call');
});

test('zed: an open call in the last turn is held; the result releases it; held again, the view keeps its last version', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    let out = lastDerive(e, T.HELD);
    assert.deepEqual(out.held.message, [A(U.U10, 1)]);
    // The running turn's usage (cumulative {}, so its request_token_usage entry is a record) is
    // held with its reply.
    const u10 = `message:${U.U10}#1`;
    const usage = (id) => ofType(viewOf(e, T.HELD), 'usage').find((u) => u.usage_id === id);
    assert.deepEqual(out.held.usage, [u10]);
    assert.ok(!out.live.usage.includes(u10) && !out.changed.some((r) => r.usage_id === u10));
    assert.ok(!out.live.message.includes(A(U.U10, 1)) && !out.changed.some((r) => r.message_id === A(U.U10, 1)));
    // An earlier turn's unanswered call is interrupted, not held.
    assert.equal(msg(viewOf(e, T.HELD), A(U.U9, 1)).status, 'interrupted');
    save(dir, T.HELD, heldThread({ done: true }));
    e.pass();
    out = lastDerive(e, T.HELD);
    assert.deepEqual([out.held.message, out.held.usage], [[], []]);
    assert.ok(out.live.message.includes(A(U.U10, 1)) && out.live.message.includes(A(U.U10, 2)));
    assert.deepEqual([usage(u10).input, usage(u10).output, usage(u10).granularity], [700, 12, 'per_turn'], 'released with the turn');
    const done = msg(viewOf(e, T.HELD), A(U.U10, 1));
    const doneUsage = usage(u10);
    assert.equal(done.parts.find((p) => p.kind === 'tool_result').output, '```\n3 passed\n```');
    // Zed regenerating the reply: the call open again. Held, and the consumer keeps the done version.
    save(dir, T.HELD, heldThread());
    e.pass();
    out = lastDerive(e, T.HELD);
    assert.deepEqual(out.held.message, [A(U.U10, 1)]);
    assert.ok(!out.changed.some((r) => r.message_id === A(U.U10, 1)));
    assert.deepEqual(msg(viewOf(e, T.HELD), A(U.U10, 1)), done);
    assert.deepEqual(out.held.usage, [u10]);
    assert.deepEqual(usage(u10), doneUsage, 'the turn\'s usage keeps its done version too');
    assert.ok(!msg(viewOf(e, T.HELD), A(U.U10, 2)), 'the later reply of the regenerated turn is gone');
    // A ToolUse whose input is still streaming is held even with a result.
    const streaming = thread('t', [user(U.U9, 'Read.'), agent([use(C.LOOK, 'read_file', { path: 'toy' }, { is_input_complete: false })], res(C.LOOK, 'read_file', ''))]);
    save(dir, T.HELD, streaming);
    e.pass();
    assert.deepEqual(lastDerive(e, T.HELD).held.message, [A(U.U9, 1)]);
  });
});

// ---- the controls of sessions v1 for a snapshot source -------------------------------------------

// The synthetic case (fixtures/zed/generate.js says which of its behaviours restore-lab observed).
test('zed/restore: an appended turn keeps every earlier key unchanged (positive control); a checkpoint restore drops exactly the cut keys (negative control)', () => {
  const dir = tmpStore();
  try {
    const [db] = sqlFilesOf(path.join(FIX, 'restore'));
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    buildDb(dir, db, 1);
    e.pass();
    const v1 = lastDerive(e, R.ID).live;
    assert.deepEqual(v1.message, [R.R1, A(R.R1, 1), R.R2, A(R.R2, 1), A(R.R2, 2)].sort());
    // cumulative_token_usage is {} in every save: one per_turn record per request_token_usage entry.
    const ukey = (uid) => `message:${uid}#1`;
    assert.deepEqual(v1.usage, [ukey(R.R1), ukey(R.R2)].sort());
    // v2: a turn appended in place.
    buildDb(dir, db, 2);
    e.pass();
    let out = lastDerive(e, R.ID);
    assert.deepEqual(e.log.find((l) => l.session_id === R.ID).continuity, 'snapshot');
    for (const k of v1.message) assert.ok(out.live.message.includes(k), `${k} kept`);
    assert.deepEqual(out.changed.filter((r) => r.type === 'message').map((r) => r.message_id).sort(), [R.R3, A(R.R3, 1), A(R.R3, 2)].sort(), 'only the new messages changed');
    for (const k of v1.usage) assert.ok(out.live.usage.includes(k), `${k} kept`);
    assert.deepEqual(out.changed.filter((r) => r.type === 'usage').map((r) => r.usage_id), [ukey(R.R3)], 'only the new turn\'s usage changed');
    // v3: restore to before R2, regrown under a new User id. The cut keys vanish; no lifecycle record.
    buildDb(dir, db, 3);
    e.pass();
    out = lastDerive(e, R.ID);
    assert.deepEqual(out.live.message, [R.R1, A(R.R1, 1), R.R4, A(R.R4, 1)].sort());
    assert.deepEqual(out.live.lifecycle, [], 'the store keeps no trace of the restore');
    // The cut turns' entries are gone from request_token_usage, so their usage keys vanish too.
    assert.deepEqual(out.live.usage, [ukey(R.R1), ukey(R.R4)].sort());
    assert.deepEqual(out.changed.filter((r) => r.type === 'usage').map((r) => r.usage_id), [ukey(R.R4)], 'the kept usage is unchanged');
    const ids = msgIds(viewOf(e, R.ID));
    for (const gone of [R.R2, A(R.R2, 1), A(R.R2, 2), R.R3, A(R.R3, 1), A(R.R3, 2)]) assert.ok(!ids.includes(gone), `${gone} tombstoned`);
    assert.deepEqual(out.changed.filter((r) => r.type === 'message').map((r) => r.message_id).sort(), [R.R4, A(R.R4, 1)].sort(), 'the kept messages are unchanged');
    // A rename: the summary, in place.
    buildDb(dir, db, 4);
    e.pass();
    out = lastDerive(e, R.ID);
    assert.deepEqual(out.changed.map((r) => [r.type, r.title]), [['session', 'Cart qty check (renamed)']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// sessions-model conformance, "Anchored ids", on a capture (Zed 1.24.3, restore-lab): a checkpoint
// truncate and regrow gives the new assistant messages new keys.
test('zed/restore-lab (capture): the regrown Agent messages get keys no pre-restore message had, at reused positions; the restore leaves nothing live; usage follows cumulative_token_usage', () => {
  const dir = tmpStore();
  try {
    const caps = restoreLabCapture();
    const sid = caps[0].threads[0].id;
    const userAt = (cap) => cap.threads[0].data.messages.flatMap((m, i) => (m.User ? [[i, m.User.id]] : []));
    const [[, U1], [, U2]] = userAt(caps[0]);
    const [[, U3]] = userAt(caps[2]);
    assert.deepEqual([userAt(caps[0]).map(([i]) => i), userAt(caps[1]), userAt(caps[2]).map(([i]) => i)], [[0, 7], [], [0]], 'the capture: User messages at 0 and 7; none; a new one at 0');
    const dbs = sqlFilesOf(path.join(FIX, 'restore-lab'));
    const threadsDb = dbs.find((d) => d.rel === THREADS_REL);
    for (const d of dbs) if (d !== threadsDb) buildDb(dir, d);
    const store = storeOf(adapter, dir);
    const e = new MiniEngine(adapter, store);
    const states = [];
    for (const upto of [1, 2, 3]) {
      buildDb(dir, threadsDb, upto);
      e.pass();
      const view = viewOf(e, sid);
      states.push({ out: lastDerive(e, sid), msgs: ofType(view, 'message'), usage: ofType(view, 'usage'), hint: adapter.list(store)[0].updated_hint });
    }
    const [s1, s2, s3] = states;
    // After the regrow: the Agent messages sit at positions the first state used, under keys it never had.
    const before = new Set(s1.out.live.message);
    const agents = s3.msgs.filter((m) => m.role === 'assistant');
    assert.equal(agents.length, 3);
    for (const m of agents) assert.ok(!before.has(m.message_id), `${m.message_id} never was a pre-restore key`);
    const at = (msgs) => new Map(msgs.map((m) => [m.order, m.message_id]));
    const [o1, o3] = [at(s1.msgs), at(s3.msgs)];
    for (const pos of ['00000001', '00000002', '00000003']) {
      assert.ok(o1.has(pos) && o3.has(pos), `position ${pos} reused`);
      assert.notEqual(o3.get(pos), o1.get(pos));
    }
    assert.deepEqual(s1.out.live.message, [U1, ...[1, 2, 3, 4, 5, 6].map((n) => A(U1, n)), U2, ...[1, 2, 3].map((n) => A(U2, n))].sort());
    assert.deepEqual(s3.out.live.message, [U3, A(U3, 1), A(U3, 2), A(U3, 3)]);
    // After the restore on the first User message: it went too, and nothing of the first state is live.
    assert.deepEqual([s2.out.live.message, s2.msgs], [[], []]);
    assert.notEqual(s2.hint, s1.hint, 'the restore left updated_at; the hint still moves, with the blob');
    // Usage: one per-session record, the cumulative total in every state; the restore does not reduce it.
    assert.deepEqual(states.map((s) => s.usage.map((u) => [u.usage_id, u.granularity, u.input, u.output, u.cache_read])),
      caps.map((c) => {
        const u = c.threads[0].data.cumulative_token_usage;
        return [['session#1', 'per_session', u.input_tokens, u.output_tokens, u.cache_read_input_tokens]];
      }));
    assert.deepEqual(states.map((s) => s.usage[0].input), [129315, 129315, 171750]);
    assert.ok(!s2.out.changed.some((r) => r.type === 'usage'));
    // No lifecycle record at any point: the store keeps no trace of the restore.
    for (const s of states) assert.deepEqual(s.out.live.lifecycle, []);
    // The sidebar row is keyed by a 16-byte thread_id of its own, and matched by session_id.
    assert.notEqual(caps[0].sidebar_threads[0].thread_id, sid.replaceAll('-', ''));
    assert.deepEqual(adapter.list(store)[0].sources.map((x) => x.source_key), [MAIN, STABLE]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zed: archive: a flag per channel, one lifecycle record per channel saying so; clearing it removes the record', () => {
  withStore('features', (dir) => {
    const recs = golden('features')[T.CART];
    assert.deepEqual(ofType(recs, 'lifecycle').map((l) => [l.lifecycle_id, l.op, l.target, l.ts]), [[`${STABLE}@${STABLE}#1`, 'archive', { session: true }, null]]);
    assert.equal(ofType(recs, 'session')[0].state, 'archived');
    assert.equal(ofType(golden('features')[T.NOTES], 'session')[0].state, 'active', 'a sidebar row with archived 0');
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const w = writer(dir, sidebarRel('0-stable'));
    w.prepare('UPDATE sidebar_threads SET archived = 0 WHERE session_id = ?').run(T.CART);
    w.close();
    e.pass();
    const out = lastDerive(e, T.CART);
    assert.deepEqual(out.live.lifecycle, []);
    assert.deepEqual(out.changed.map((r) => [r.type, r.state]), [['session', 'active']], 'only the session record moved');
    assert.deepEqual(e.log.filter((l) => l.session_id === T.CART).map((l) => [l.source_key, l.continuity]), [[MAIN, 'unchanged'], [PREVIEW, 'unchanged'], [STABLE, 'snapshot']]);
  });
});

test('zed: session record: title from the row, cwd the first folder in stored order, created from the row, mode the profile', () => {
  const s = ofType(golden('features')[T.CART], 'session')[0];
  assert.deepEqual([s.title, s.title_set_by, s.cwd, s.created_at, s.updated_at, s.mode, s.reuse, s.harness_version], [
    'Toy cart qty fix (renamed)', 'unknown', '/home/user/work/toyshop', '2026-10-21T09:00:00.123Z', null, 'write', 'impossible', null]);
  assert.equal(s.fingerprint.cmp_shas.length, ofType(golden('features')[T.CART], 'message').length);
});

// ---- list and read --------------------------------------------------------------------------------

test('zed: list names every 0.3.0 thread with its sources (one per channel with a row); a legacy thread is not listed; the hint moves with this thread only', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const sessions = adapter.list(store);
    assert.deepEqual(sessions.map((s) => s.session_id), [T.CART, T.NOTES, T.COMPACT, T.PARENT, T.CHILD, T.HELD], 'the legacy agent-1 thread is not listed');
    assert.deepEqual(adapter.list(store), sessions, 'list is stable');
    const cart = sessions.find((s) => s.session_id === T.CART);
    assert.deepEqual([cart.incarnation, cart.live], ['', 'unknown']);
    assert.deepEqual(cart.sources.map((x) => [x.source_key, x.role, x.mode, x.position_kind]), [
      [MAIN, 'main', 'snapshot', 'snapshot'],
      [PREVIEW, 'side', 'snapshot', 'snapshot'],
      [STABLE, 'side', 'snapshot', 'snapshot'],
    ]);
    assert.deepEqual(sessions.find((s) => s.session_id === T.HELD).sources.map((x) => x.source_key), [MAIN]);
    const hint = (sid) => adapter.list(store).find((s) => s.session_id === sid).updated_hint;
    const h0 = hint(T.CART);
    const steps = [
      [() => save(dir, T.NOTES, cartThread()), 'another thread saved', false],
      [() => { const w = writer(dir); w.prepare('UPDATE threads SET summary = ? WHERE id = ?').run('Toy cart (2)', T.CART); w.close(); }, 'a rename, updated_at unmoved', true],
      [() => { const w = writer(dir, sidebarRel('0-preview')); w.prepare('UPDATE sidebar_threads SET archived = 1 WHERE session_id = ?').run(T.CART); w.close(); }, 'archived in a channel', true],
      [() => save(dir, T.CART, cartThread()), 'a save of this thread', true],
    ];
    let prev = h0;
    for (const [act, why, moves] of steps) {
      act();
      const h = hint(T.CART);
      if (moves) assert.notEqual(h, prev, why);
      else assert.equal(h, prev, why);
      prev = h;
    }
  });
});

test('zed: read: the thread row as one row-json unit, data decoded, orig_sha256 the stored blob\'s; unchanged by sha, then snapshot; the sidebar projected', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.session_id === T.CART);
    const key = keyOf(store, s);
    const r1 = adapter.read(store, key, MAIN);
    assert.equal(r1.continuity, 'reset');
    const [u] = r1.units;
    assert.deepEqual([u.unit_key, u.enc, u.redacted], [MAIN, 'row-json', false]);
    const body = JSON.parse(u.body);
    assert.deepEqual(Object.keys(body).sort(), ['created_at', 'data', 'data_type', 'folder_paths', 'folder_paths_order', 'id', 'orig_sha256', 'parent_id', 'summary', 'updated_at']);
    assert.equal(body.data.messages.length, cartThread().messages.length);
    const w = writer(dir);
    const stored = w.prepare('SELECT data FROM threads WHERE id = ?').get(T.CART).data;
    w.close();
    assert.equal(body.orig_sha256, sha256(Buffer.from(stored)));
    assert.equal(adapter.read(store, key, MAIN, r1.position).continuity, 'unchanged');
    save(dir, T.CART, thread('x', [...cartThread().messages, user(U.U0, 'More.')]));
    const r2 = adapter.read(store, key, MAIN, r1.position);
    assert.equal(r2.continuity, 'snapshot');
    assert.equal(r2.units.length, 1);
    const sb = adapter.read(store, key, STABLE);
    assert.equal(sb.units[0].enc, 'rows-json');
    assert.deepEqual(JSON.parse(sb.units[0].body), { sidebar_threads: [{ archived: 1, session_id: T.CART }] }, 'only what derive reads');
    assert.equal(adapter.read(store, key, STABLE, sb.position).continuity, 'unchanged');
    // A plain-JSON blob (data_type json) reads the same way.
    const notes = adapter.read(store, keyOf(store, adapter.list(store).find((x) => x.session_id === T.NOTES)), MAIN).units[0];
    assert.equal(JSON.parse(notes.body).data_type, 'json');
  });
});

test('zed: redaction: the sentinel on remote_url, diff and draft_prompt is <redacted len=N> in read; the free-text sentinel stays (§4.6)', () => {
  withStore('sentinel', (dir) => {
    const store = storeOf(adapter, dir);
    const [s] = adapter.list(store);
    const u = adapter.read(store, keyOf(store, s), MAIN).units[0];
    assert.equal(u.redacted, true);
    const t = JSON.parse(u.body).data;
    const g = t.initial_project_snapshot.worktree_snapshots[0].git_state;
    const url = `https://toy:${SENTINEL}@example.com/toyshop.git`;
    const diff = `diff --git a/.env b/.env\n+TOY_TOKEN=${SENTINEL}\n`;
    const draft = JSON.stringify([{ text: `use ${SENTINEL} next`, type: 'text' }]);
    assert.deepEqual([g.remote_url, g.diff, t.draft_prompt], [`<redacted len=${url.length}>`, `<redacted len=${diff.length}>`, `<redacted len=${draft.length}>`]);
    assert.equal(g.head_sha, '5a1e0000000000000000000000000000000000c0', 'nothing else on the snapshot changes');
    const others = { ...t, messages: [] };
    assert.ok(!JSON.stringify(others).includes(SENTINEL), 'the sentinel is on no declared path of the unit');
    assert.ok(JSON.stringify(t.messages).includes(SENTINEL), 'free text keeps it');
    const recs = golden('sentinel')[S.ID];
    assert.deepEqual(recs.filter((r) => JSON.stringify(r).includes(SENTINEL)).map((r) => r.message_id), [S.U1], 'only the prompt that holds it as free text');
    assert.equal(ofType(recs, 'usage').length, 0);
  });
});

test('zed: threads.db (rollback journal) and the WAL channel DBs are read creating nothing beside them', () => {
  withStore('features', (dir) => {
    const ls = () => ['threads', 'db/0-stable', 'db/0-preview'].map((d) => fs.readdirSync(path.join(dir, d)).sort());
    const before = ls();
    assert.deepEqual(before, [['threads.db'], ['db.sqlite'], ['db.sqlite']]);
    assert.equal(fs.readFileSync(path.join(dir, THREADS_REL))[18], 1, 'threads.db keeps a rollback journal');
    assert.equal(fs.readFileSync(path.join(dir, sidebarRel('0-stable')))[18], 2, 'the channel DB is in WAL mode');
    project(fullReplay(adapter, dir).views());
    assert.deepEqual(ls(), before);
  });
});

test('zed: Zed saving (a write lock on threads.db) is busy in list and read, never fewer threads; once free, the same records', () => {
  withStore('lab', (dir) => {
    const store = storeOf(adapter, dir);
    const full = project(fullReplay(adapter, dir).views());
    const s = adapter.list(store)[0];
    const w = writer(dir);
    w.exec('BEGIN EXCLUSIVE');
    try {
      assert.throws(() => adapter.list(store), { code: 'busy' });
      assert.throws(() => adapter.read(store, keyOf(store, s), MAIN), { code: 'busy' });
    } finally {
      w.exec('ROLLBACK');
      w.close();
    }
    assert.deepEqual(project(fullReplay(adapter, dir).views()), full);
  });
});

test('zed: a channel DB with a -wal but no -shm is busy in list and in its read, never an absent archive flag', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const key = keyOf(store, adapter.list(store).find((x) => x.session_id === T.CART));
    const wal = path.join(dir, `${sidebarRel('0-stable')}-wal`);
    fs.writeFileSync(wal, '');
    try {
      assert.throws(() => adapter.list(store), { code: 'busy' });
      assert.throws(() => adapter.read(store, key, STABLE), { code: 'busy' });
      assert.equal(adapter.read(store, key, MAIN).units.length, 1, 'the thread itself still reads');
      assert.ok(!fs.existsSync(`${path.join(dir, sidebarRel('0-stable'))}-shm`), 'no -shm created');
    } finally {
      fs.rmSync(wal);
    }
    assert.equal(ofType(project(fullReplay(adapter, dir).views())[T.CART], 'session')[0].state, 'archived');
  });
});

test('zed: damaged: an undecodable blob is listed and reads damaged; a corrupt page or a file that is no database fails list', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const key = keyOf(store, adapter.list(store).find((x) => x.session_id === T.COMPACT));
    for (const [data, type] of [[Buffer.from('not zstd at all'), 'zstd'], [Buffer.from('{"messages": [cut'), 'json'], [Buffer.from('{"title":"no messages"}'), 'json'], [zlib.zstdCompressSync(Buffer.from('{}')), 'lz4']]) {
      const w = writer(dir);
      w.prepare('UPDATE threads SET data = ?, data_type = ? WHERE id = ?').run(data, type, T.COMPACT);
      w.close();
      assert.ok(adapter.list(store).some((x) => x.session_id === T.COMPACT), `listed (${type})`);
      assert.throws(() => adapter.read(store, key, MAIN), { code: 'damaged' }, `${type}: ${data}`);
    }
    // Overwrite the header of the threads table's first page.
    const w = writer(dir);
    const { root } = w.prepare("SELECT rootpage AS root FROM sqlite_master WHERE name = 'threads'").get();
    const size = Number(w.prepare('PRAGMA page_size').get().page_size);
    w.close();
    const fd = fs.openSync(path.join(dir, THREADS_REL), 'r+');
    fs.writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (root - 1) * size);
    fs.closeSync(fd);
    assert.throws(() => adapter.list(store), { code: 'damaged' });
    fs.writeFileSync(path.join(dir, THREADS_REL), Buffer.alloc(8192, 0x41));
    assert.throws(() => adapter.list(store), { code: 'damaged' });
  });
  // No threads.db, and one without the threads table: no sessions.
  withStore(null, (dir) => {
    const store = storeOf(adapter, dir);
    assert.deepEqual(adapter.list(store), []);
    fs.mkdirSync(path.join(dir, 'threads'));
    const b = new DatabaseSync(path.join(dir, THREADS_REL));
    b.exec('CREATE TABLE migrations (domain TEXT, step INTEGER)');
    b.close();
    assert.deepEqual(adapter.list(store), []);
  });
});

test('zed: errors: an unknown session or source, a legacy thread, a channel with no DB, a deleted thread', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const key = keyOf(store, adapter.list(store).find((x) => x.session_id === T.CART));
    assert.throws(() => adapter.read(store, { ...key, session_id: '5a1e0000-0000-4000-8000-0000000000ff' }, MAIN), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, { ...key, session_id: T.LEGACY }, MAIN), { code: 'session_unknown' }, 'a legacy thread is not read');
    assert.throws(() => adapter.read(store, key, THREADS_REL), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key, 'threads/threads.db#table:messages'), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key, sidebarKey('0-nightly')), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key, 'db/../threads/db.sqlite#table:sidebar_threads'), { code: 'source_unknown' });
    const w = writer(dir);
    w.prepare('DELETE FROM threads WHERE id = ?').run(T.CART);
    w.close();
    assert.ok(!adapter.list(store).some((x) => x.session_id === T.CART));
    assert.throws(() => adapter.read(store, key, MAIN), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, STABLE), { code: 'session_unknown' });
    fs.rmSync(path.join(dir, 'threads'), { recursive: true });
    assert.deepEqual(adapter.list(store), []);
    assert.throws(() => adapter.read(store, keyOf(store, { session_id: T.NOTES, incarnation: '' }), MAIN), { code: 'session_unknown' });
  });
});

test('zed: a symlinked threads.db, threads folder, db folder, channel folder or channel DB is neither listed nor read', () => {
  withStore('features', (real) => {
    const links = [
      ['threads.db', THREADS_REL, 'file'],
      ['threads folder', 'threads', 'dir'],
      ['db folder', 'db', 'dir'],
      ['channel folder', 'db/0-stable', 'dir'],
      ['channel DB', sidebarRel('0-stable'), 'file'],
    ];
    for (const [what, rel] of links) {
      const dir = tmpStore();
      try {
        fs.cpSync(real, dir, { recursive: true });
        fs.rmSync(path.join(dir, rel), { recursive: true });
        fs.symlinkSync(path.join(real, rel), path.join(dir, rel));
        const store = storeOf(adapter, dir);
        const key = keyOf(store, { session_id: T.CART, incarnation: '' });
        const listed = adapter.list(store);
        if (rel.startsWith('threads')) {
          assert.deepEqual(listed, [], what);
          assert.throws(() => adapter.read(store, key, MAIN), (e) => e.code === 'session_unknown' || e.code === 'source_unknown', what);
        } else {
          const cart = listed.find((s) => s.session_id === T.CART);
          assert.ok(!cart.sources.some((x) => x.source_key === STABLE), `${what}: no source through the link`);
          assert.throws(() => adapter.read(store, key, STABLE), { code: 'source_unknown' }, what);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// ---- describe ------------------------------------------------------------------------------------

test('zed: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.deepEqual([d.harness, d.model_version, d.facets.reuse, d.ts_source, d.store_shape], ['zed', 'sessions-model/1', 'impossible', 'none', { kind: 'folder' }]);
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
  // linkage.tool native: every result pairs with exactly one call, by call_id.
  for (const recs of CASES.flatMap((c) => Object.values(golden(c)))) {
    const parts = ofType(recs, 'message').flatMap((m) => m.parts);
    for (const r of parts.filter((p) => p.kind === 'tool_result')) assert.equal(parts.filter((p) => p.kind === 'tool_call' && p.call_id === r.call_id).length, 1, r.call_id);
  }
  const paths = d.redaction.paths.filter((p) => p.opened).map((p) => p.path);
  assert.deepEqual(paths, ['data.initial_project_snapshot.worktree_snapshots[].git_state.remote_url', 'data.initial_project_snapshot.worktree_snapshots[].git_state.diff', 'data.draft_prompt']);
});

// ---- the fixtures ----------------------------------------------------------------------------------

// A blob parameter as text: its zstd frame decoded, else its bytes.
function blobText(b64) {
  const buf = Buffer.from(b64, 'base64');
  try {
    return zlib.zstdDecompressSync(buf).toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
}
const norm = (ops) => ops.map((o) => ({ ...o, params: (o.params ?? []).map((p) => (p && typeof p.$b64 === 'string' ? { text: blobText(p.$b64) } : p)) }));

test('zed fixtures: generate.js reproduces every case (blobs compared decoded: zstd bytes vary with the library)', () => {
  for (const name of CASES) {
    const built = GENERATED[name]();
    const files = sqlFilesOf(path.join(FIX, name));
    assert.deepEqual(files.map((f) => f.rel).sort(), Object.keys(built).sort(), name);
    for (const f of files) {
      assert.equal(f.schema, built[f.rel].schema, `${name}/${f.rel} schema`);
      assert.deepEqual(norm(f.ops), norm(built[f.rel].ops), `${name}/${f.rel} ops`);
    }
  }
});

test('zed fixtures: the decoded blobs leak nothing a real machine would, and carry only synthetic tool call ids', () => {
  const bad = [];
  for (const name of CASES) {
    for (const f of sqlFilesOf(path.join(FIX, name))) {
      for (const op of f.ops) {
        for (const p of op.params ?? []) {
          if (!p || typeof p.$b64 !== 'string') continue;
          const text = blobText(p.$b64);
          for (const m of text.matchAll(/(?:\/home\/|\/Users\/)([A-Za-z0-9._-]+)/g)) if (m[1] !== 'user') bad.push(`${name}: home of ${m[1].slice(0, 1)}…`);
          for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) if (!/^(127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(m[0])) bad.push(`${name}: an address`);
          for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!/@example\.com$/.test(m[0])) bad.push(`${name}: a mail address`);
          for (const m of text.matchAll(/chatcmpl-[A-Za-z0-9-]+|toolu_[A-Za-z0-9_]+|\b(?:msg|call|req|resp)_[A-Za-z0-9]{8,}/g)) {
            if (!/^(chatcmpl-tool-0{11}[0-9a-f]{5}|toolu_toy_\d{18})$/.test(m[0])) bad.push(`${name}: a provider id ${m[0].slice(0, 12)}…`);
          }
        }
      }
    }
  }
  assert.deepEqual(bad, []);
});
