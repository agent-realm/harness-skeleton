import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../src/index.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, growthCheck, rewriteCheck, tmpStore, copyTree, storeOf, nameLint } from '../conformance/runner.js';

const adapter = adapterFor('gemini-cli');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gemini-cli');
const CASES = ['features', 'legacy', 'pass3', 'rewind'];
const CTX = 'd04923d38bb0f6017037e74183378ef4';

function withCopy(name, fn) {
  const dir = tmpStore();
  try {
    if (name) copyTree(path.join(FIX, name, 'store'), dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const golden = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name, 'expected.json'), 'utf8'));
const msg = (recs, id) => recs.find((r) => r.type === 'message' && r.message_id === id);
const jsonl = (recs) => recs.map((r) => JSON.stringify(r) + '\n').join('');
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const viewOf = (e, sid) => [...e.sessions.entries()].find(([k]) => k.split('\u0000')[0] === sid)[1];

// Synthetic records in the CLI's shapes (spec §3), for the cases built inline.
const SID = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d';
const REL = `tmp/toy/chats/session-2026-03-01T10-00-${SID.slice(0, 8)}.jsonl`;
const iso = (s) => new Date(Date.UTC(2026, 2, 1, 10, 0, s)).toISOString();
const head = { sessionId: SID, projectHash: '3'.repeat(64), startTime: iso(0), lastUpdated: iso(0), kind: 'main' };
const user = (id, s, text) => ({ id, timestamp: iso(s), type: 'user', content: [{ text }] });
const gemini = (id, s, content, over = {}) => ({ id, timestamp: iso(s), type: 'gemini', content, thoughts: [], tokens: { input: 100, output: 5, cached: 0, thoughts: 0, tool: 0, total: 105 }, model: 'gemini-3.5-flash', ...over });
const fr = (id, output) => ({ functionResponse: { id, name: 'run_shell_command', response: { output } } });

// derive over lines given inline, as one stream source.
function deriveLines(lines, sk = REL) {
  let off = 0;
  const units = [];
  for (const l of lines) {
    const body = JSON.stringify(l);
    units.push({ source_key: sk, unit_key: String(off), enc: 'utf8', bytes: Buffer.byteLength(body), sha256: '', redacted: false, body });
    off += Buffer.byteLength(body) + 1;
  }
  const key = { host: 'h', harness: 'gemini-cli', harness_path: '/home/user/.gemini', session_id: SID, incarnation: '' };
  return adapter.derive(key, [{ source_key: sk, generation: 1, complete: true, units, gone: [] }], null);
}
const msgsOf = (out) => out.changed.filter((r) => r.type === 'message').sort((a, b) => (a.order < b.order ? -1 : 1));

for (const name of CASES) {
  test(`gemini-cli/${name}: the full replay equals the reviewed golden`, () => {
    withCopy(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), golden(name)));
  });

  test(`gemini-cli/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    const r = growthCheck(adapter, path.join(FIX, name, 'store'), { steps: 31 });
    assert.deepEqual(r.incremental, r.full);
    assert.ok(r.equal, 'content_sha differs between the incremental and the full view');
    assert.deepEqual(r.notUnchanged, []);
  });

  test(`gemini-cli/${name}: keys are stable across a lost state`, () => {
    withCopy(name, (dir) => {
      const a = project(fullReplay(adapter, dir).views());
      const b = project(fullReplay(adapter, dir).views());
      assert.deepEqual(a, b);
    });
  });

  test(`gemini-cli/${name}: no string under a secret-looking name in any unit or record`, () => {
    withCopy(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) {
          for (const u of src.units.values()) {
            let o = null;
            try { o = JSON.parse(u.body); } catch { continue; } // `.project_root` is a plain path
            hits.push(...nameLint(o, [], `${u.unit_key}:`));
          }
        }
        for (const r of s.view.values()) hits.push(...nameLint(r, [], `${r.type}:`));
      }
      assert.deepEqual(hits, []);
    });
  });
}

test('gemini-cli: lab cases: 56749748 rewind, twin errors, pass3 patch, one call, injected context, tokens', () => {
  // session-2026-10-19T22-18-56749748.jsonl: `$rewindTo c55b4303` retracts c55b4303 itself, 063cc7c1
  // and a65b8017; the rewind record's point is the last message kept (a4c79de5).
  const [rw] = Object.values(golden('rewind'));
  const st = (id) => msg(rw, id).state;
  for (const id of ['c55b4303-1790-44a6-9da6-30f464ebf577', '063cc7c1-e204-495c-930d-17cfbbf044aa', 'a65b8017-5286-412a-9896-4e099df9caa5']) assert.equal(st(id), 'retracted');
  const rewind = rw.find((r) => r.type === 'lifecycle' && r.op === 'rewind');
  assert.deepEqual([rewind.target, rewind.at], [{ range: { from_id: 'c55b4303-1790-44a6-9da6-30f464ebf577', through_id: 'a65b8017-5286-412a-9896-4e099df9caa5' } }, 'a4c79de5-f3fc-4cb6-b61d-02973e2a7b84']);
  // Two identical errors under two ids stay two messages (a negative fold case).
  const e1 = msg(rw, 'c55b4303-1790-44a6-9da6-30f464ebf577');
  const e2 = msg(rw, '25d03591-8348-48bf-8c4b-829821389f00');
  assert.ok(e1 && e2 && e1.cmp_sha === e2.cmp_sha);
  assert.deepEqual(rw.filter((r) => r.type === 'message' && r.state === 'current').map((r) => r.message_id).sort(),
    [CTX, '87df5137-53a1-445c-979d-a8a6c4f5a9a6', 'a4c79de5-f3fc-4cb6-b61d-02973e2a7b84', '20bc6d51-8575-4eb6-9f19-c87ee78d2ef9', 'f513fae5-8e19-4b14-b6f6-a96ef504782b'].sort());
  // B's update re-sends the same text as parts: no edit record names it.
  assert.ok(!rw.some((r) => r.type === 'lifecycle' && r.target.message_id === 'a4c79de5-f3fc-4cb6-b61d-02973e2a7b84'));

  const [p3] = Object.values(golden('pass3'));
  // 08-patch: three removeIds retracted, each with an edit record; 55cc788a's text revised.
  const removed = ['beb7df0b-d0bc-42fa-9c90-24eccf88c683', 'c77ab2e9-bca4-4c56-b79d-cbb56439eea8', '224ba9ff-ab86-49d0-8f58-dcb36cc321cf'];
  for (const id of removed) assert.equal(msg(p3, id).state, 'retracted');
  assert.deepEqual(p3.filter((r) => r.type === 'lifecycle').map((r) => [r.op, r.target.message_id]),
    [...removed, '55cc788a-54de-4def-a348-3eff79e80783'].map((id) => ['edit', id]));
  assert.equal(msg(p3, '55cc788a-54de-4def-a348-3eff79e80783').parts[0].text, 'Synthetic reply 9');
  // 04 + 05: toolCalls[0].id = functionResponse.id; one call, and the echo is no message.
  const call = 'read_file__read_file_1792613364141_0';
  const parts = p3.filter((r) => r.type === 'message').flatMap((m) => m.parts);
  assert.deepEqual(parts.filter((p) => p.call_id === call).map((p) => [p.part_id, p.kind]), [[`${call}:call`, 'tool_call'], [`${call}:result`, 'tool_result']]);
  assert.equal(msg(p3, '13d972b3-827d-4009-9ffe-1e2fb7c71f83'), undefined);
  // 02: the fixed id is the injected session context.
  assert.deepEqual([msg(p3, CTX).source, msg(p3, CTX).to_user, msg(p3, CTX).to_model], ['injected', false, true]);
  // 03: total = input + output; a stored zero is null.
  const u = p3.find((r) => r.type === 'usage' && r.usage_id === '23efd3c8-f4e1-4052-8424-0d63358bf9ef');
  assert.deepEqual([u.input, u.output, u.cache_read, u.reasoning, u.input_includes_cache, u.output_includes_reasoning, u.granularity], [10313, 1, null, null, true, false, 'per_response']);
});

test('gemini-cli: thought summaries stay when the history sync rewrote content as API parts, unless content carries a thought part', () => {
  withCopy('features', (dir) => {
    const recs = Object.values(project(fullReplay(adapter, dir).views())).flat();
    // D2: content rewritten as text + functionCall, no thought part: the summary is the reasoning.
    const d2 = msg(recs, '00000000-0000-4000-9000-000000000002');
    assert.deepEqual(d2.parts.map((p) => [p.kind, p.text ?? null]), [
      ['reasoning', '**Checking the suite** Run pytest before touching the cart.'], ['text', 'Running the tests.'], ['tool_call', null], ['tool_result', null],
    ]);
    // D4: content carries a thought part: it is the reasoning, and the summary is not added twice.
    const d4 = msg(recs, '00000000-0000-4000-9000-000000000004');
    assert.deepEqual(d4.parts.map((p) => [p.kind, p.text]), [['reasoning', 'The suite passes.'], ['text', 'All green.']]);
  });
});

// A gemini record's `model` is the model the CLI named in its own request, never the response's
// `modelVersion` (google-gemini/gemini-cli at 363a131: packages/core/src/core/geminiChat.ts:1239-1240
// and 1767-1768, packages/core/src/services/chatRecordingService.ts:1099). sessions-model §2.4 makes
// usage `model` the served model, so a record gives `requested_model` and no usage `model`.
test('gemini-cli: a record\'s model is the requested model: the message\'s requested_model, never the usage record\'s served model', () => {
  const out = deriveLines([head, user('u1', 1, 'hello'), gemini('g1', 2, 'Hi there.')]);
  const m = out.changed.find((r) => r.type === 'message' && r.message_id === 'g1');
  assert.deepEqual([m.requested_model, m.served_model], ['gemini-3.5-flash', null]);
  const u = out.changed.find((r) => r.type === 'usage' && r.usage_id === 'g1');
  assert.deepEqual([u.input, u.output, u.model], [100, 5, null]);
  // Every usage record of every golden: no served model, since the store keeps none.
  for (const name of CASES) {
    for (const recs of Object.values(golden(name))) {
      for (const r of recs.filter((x) => x.type === 'usage')) assert.equal(r.model, null, `${name} ${r.usage_id}`);
    }
  }
});

test('gemini-cli: a tool turn: thoughts, the reply, call and result parts, error and cancelled calls; the echo is no message', () => {
  const recs = Object.values(golden('features')).flat();
  const g1 = msg(recs, '00000000-0000-4000-8000-000000000002');
  assert.deepEqual(g1.parts.map((p) => p.kind), ['reasoning', 'text', 'tool_call', 'tool_result']);
  assert.equal(g1.parts[0].text, '**Reading the cart** The total ignores qty; check total_cents first.');
  assert.ok(g1.parts[3].output.includes('i.price_cents * i.qty'), 'a $patch toolCalls result update');
  const g2 = msg(recs, '00000000-0000-4000-8000-000000000004');
  assert.deepEqual(g2.parts.filter((p) => p.kind === 'tool_result').map((p) => [p.is_error, p.status, p.output]),
    [[true, 'completed', 'Command exited with code 1: 1 failed'], [false, 'cancelled', 'User cancelled the edit.']]);
  for (const echo of ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000016']) assert.equal(msg(recs, echo), undefined);
  // A call that never finished, once something follows: written, interrupted, no result part.
  const g9 = msg(recs, '00000000-0000-4000-8000-000000000017');
  assert.deepEqual([g9.status, g9.parts.map((p) => p.kind)], ['interrupted', ['tool_call']]);
  // A result whose call no gemini record holds is a tool message; with a prompt, two speakers.
  assert.equal(msg(recs, '00000000-0000-4000-8000-000000000008').role, 'tool');
  assert.deepEqual([msg(recs, '00000000-0000-4000-8000-000000000009').role, msg(recs, '00000000-0000-4000-8000-000000000009+1').role], ['user', 'tool']);
  // Hook output is injected with source hook.
  assert.deepEqual([msg(recs, '00000000-0000-4000-8000-000000000012').source, msg(recs, '00000000-0000-4000-8000-000000000012').to_user], ['hook', false]);
});

test('gemini-cli: every tool_call with a result pairs with exactly one tool_result by call_id', () => {
  for (const name of CASES) {
    const parts = Object.values(golden(name)).flat().filter((r) => r.type === 'message').flatMap((m) => m.parts);
    for (const c of parts.filter((p) => p.kind === 'tool_call')) {
      assert.ok(parts.filter((p) => p.kind === 'tool_result' && p.call_id === c.call_id).length <= 1, c.call_id);
    }
    for (const r of parts.filter((p) => p.kind === 'tool_result')) {
      assert.ok(parts.filter((p) => p.kind === 'tool_call' && p.call_id === r.call_id).length <= 1, r.call_id);
    }
  }
});

test('gemini-cli: a rewrite of the chat file (new inode, shorter) is a reset, and vanished keys go', () => {
  const store = path.join(FIX, 'features', 'store');
  const rel = withCopy('features', (dir) => adapter.list(storeOf(adapter, dir)).find((s) => s.session_id.startsWith('7f3e9a10-')).sources[0].source_key);
  const r = rewriteCheck(adapter, store, rel, 12);
  assert.equal(r.continuity, 'reset');
  assert.ok(r.equal);
});

test('gemini-cli: an append-only retraction ($rewindTo) stays appended: retracted, a lifecycle record, nothing tombstoned', () => {
  withCopy('rewind', (dir) => {
    const store = storeOf(adapter, dir);
    const rel = adapter.list(store)[0].sources[0].source_key;
    const file = path.join(dir, rel);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const at = lines.findIndex((l) => l.startsWith('{"$rewindTo"'));
    fs.writeFileSync(file, lines.slice(0, at).map((l) => l + '\n').join(''));
    const e = new MiniEngine(adapter, store);
    e.pass();
    const before = new Set(viewOf(e, '56749748-df8f-4fdb-b00c-06c15b4d775f').view.keys());
    assert.equal(msg([...viewOf(e, '56749748-df8f-4fdb-b00c-06c15b4d775f').view.values()], 'c55b4303-1790-44a6-9da6-30f464ebf577').state, 'current');
    fs.appendFileSync(file, lines.slice(at).map((l) => l + '\n').join(''));
    e.pass();
    assert.deepEqual(e.log.map((l) => l.continuity), ['appended']);
    const view = viewOf(e, '56749748-df8f-4fdb-b00c-06c15b4d775f').view;
    for (const k of before) assert.ok(view.has(k), `${k} is not tombstoned`);
    const recs = [...view.values()];
    assert.equal(msg(recs, 'c55b4303-1790-44a6-9da6-30f464ebf577').state, 'retracted');
    assert.ok(recs.some((r) => r.type === 'lifecycle' && r.op === 'rewind'));
    assert.deepEqual(project(e.views()), golden('rewind'));
  });
});

test('gemini-cli: volatile $set (lastUpdated, memoryScratchpad, sessionId) changes no record', () => {
  withCopy('pass3', (dir) => {
    const store = storeOf(adapter, dir);
    const e = new MiniEngine(adapter, store);
    e.pass();
    const before = project(e.views());
    const rel = adapter.list(store)[0].sources[0].source_key;
    fs.appendFileSync(path.join(dir, rel), jsonl([{ $set: { lastUpdated: iso(99) } }, { $set: { memoryScratchpad: { version: 2 } } }, { $set: { sessionId: 'bcda44a6-7aee-4ac4-aede-10eb47e79153' } }]));
    e.pass();
    assert.deepEqual(e.log.filter((l) => l.source_key === rel).map((l) => l.continuity), ['appended']);
    const s = [...e.sessions.values()][0];
    assert.deepEqual(s.last.changed, []);
    assert.deepEqual(project(e.views()), before);
  });
});

test('gemini-cli: held: a waiting tail reply, a reply re-held with a running call, then complete', () => {
  withCopy(null, (dir) => {
    const store = storeOf(adapter, dir);
    const e = new MiniEngine(adapter, store);
    const file = path.join(dir, REL);
    const G = '00000000-0000-4000-8000-0000000000aa';
    const C = 'run_shell_command__run_shell_command_1772359205000_0';
    const recs = () => [...viewOf(e, SID).view.values()];
    // The stream ended with tool calls only: no text, no calls yet. Held, and its usage with it.
    write(dir, REL, jsonl([head, user('u1', 1, 'run the tests'), gemini(G, 2, '')]));
    e.pass();
    assert.deepEqual([viewOf(e, SID).last.held.message, viewOf(e, SID).last.held.usage], [[G], [G]]);
    assert.equal(msg(recs(), G), undefined);
    assert.ok(!viewOf(e, SID).last.live.message.includes(G));
    // Rewritten (last wins) with a text reply: written.
    fs.appendFileSync(file, jsonl([gemini(G, 2, 'Running them now.')]));
    e.pass();
    assert.deepEqual(msg(recs(), G).parts.map((p) => p.kind), ['text']);
    const first = msg(recs(), G);
    // Rewritten again with a call still running: held again; the consumer keeps the last version.
    fs.appendFileSync(file, jsonl([gemini(G, 2, 'Running them now.', { toolCalls: [{ id: C, name: 'run_shell_command', args: { command: 'pytest' }, result: null, status: 'executing' }] })]));
    e.pass();
    const out = viewOf(e, SID).last;
    assert.deepEqual(out.held.message, [G]);
    assert.ok(!out.live.message.includes(G) && !out.changed.some((r) => r.message_id === G));
    assert.deepEqual(msg(recs(), G), first, 'the held key keeps its last written version');
    // The call completes: back in changed and live.
    fs.appendFileSync(file, jsonl([gemini(G, 2, 'Running them now.', { toolCalls: [{ id: C, name: 'run_shell_command', args: { command: 'pytest' }, result: [fr(C, '3 passed')], status: 'success' }] })]));
    e.pass();
    const done = viewOf(e, SID).last;
    assert.deepEqual(done.held.message, []);
    assert.ok(done.live.message.includes(G) && done.changed.some((r) => r.message_id === G));
    assert.deepEqual(msg(recs(), G).parts.map((p) => p.kind), ['text', 'tool_call', 'tool_result']);
    // The features fixture ends on a waiting reply: held, never written.
    const f = withCopy('features', (d) => viewOf(fullReplay(adapter, d), '7f3e9a10-5c2d-4b8e-9f01-2a3b4c5d6e7f').last);
    assert.deepEqual([f.held.message, f.held.usage], [['00000000-0000-4000-8000-000000000023'], ['00000000-0000-4000-8000-000000000023']]);
  });
});

test('gemini-cli: a partial last line is held back, and returned whole once complete', () => {
  withCopy(null, (dir) => {
    const store = storeOf(adapter, dir);
    const line = JSON.stringify(user('u2', 3, 'second prompt'));
    write(dir, REL, jsonl([head, user('u1', 1, 'first prompt')]) + line.slice(0, 20));
    const key = { ...store, session_id: SID, incarnation: '' };
    const r1 = adapter.read(store, key, REL, null, null);
    assert.equal(r1.units.length, 2);
    assert.equal(r1.held_back.length, 1);
    fs.appendFileSync(path.join(dir, REL), line.slice(20) + '\n');
    const r2 = adapter.read(store, key, REL, r1.position, null);
    assert.equal(r2.continuity, 'appended');
    assert.deepEqual(r2.units.map((u) => u.body), [line]);
  });
});

test('gemini-cli: fold ops: orderIds, a $rewindTo the fold does not hold, a legacy $set.messages', () => {
  const base = [head, user('a', 1, 'one'), gemini('b', 2, 'two'), user('c', 3, 'three')];
  // orderIds (source-only) moves the listed messages to the end, in that order.
  const moved = msgsOf(deriveLines([...base, { $patch: { orderIds: ['a', 'b'] } }])).map((m) => m.message_id);
  assert.deepEqual(moved, ['c', 'a', 'b']);
  // An unknown $rewindTo retracts every message, as the CLI's rewindTo() does; no message is kept.
  const out = deriveLines([...base, { $rewindTo: 'not-in-this-session' }]);
  assert.ok(msgsOf(out).every((m) => m.state === 'retracted'));
  const rw = out.changed.find((r) => r.type === 'lifecycle');
  assert.deepEqual([rw.op, rw.target, rw.at], ['rewind', { range: { from_id: 'a', through_id: 'c' } }, null]);
  // A legacy $set.messages snapshot drops what it leaves out (no retraction, no lifecycle record).
  const snap = deriveLines([...base, { $set: { messages: [user('a', 1, 'one'), user('d', 4, 'four')] } }]);
  assert.deepEqual(msgsOf(snap).map((m) => [m.message_id, m.state]), [['a', 'current'], ['d', 'current']]);
  assert.ok(!snap.changed.some((r) => r.type === 'lifecycle'));
  // A record id written again replaces the record and keeps its first position.
  const again = msgsOf(deriveLines([...base, gemini('b', 2, 'two, rewritten')]));
  assert.deepEqual(again.map((m) => m.message_id), ['a', 'b', 'c']);
  assert.equal(again[1].parts[0].text, 'two, rewritten');
});

test('gemini-cli: derive is pure: no file is opened, listed or stat-ed', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const inputs = adapter.list(store).map((s) => ({
      key: { ...store, session_id: s.session_id, incarnation: '' },
      input: s.sources.map((x) => ({ source_key: x.source_key, generation: 1, complete: true, units: adapter.read(store, { ...store, session_id: s.session_id, incarnation: '' }, x.source_key).units, gone: [] })),
    }));
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

test('gemini-cli: checkpoints, logs.json, projects.json and rewrite backups are never opened', () => {
  withCopy('pass3', (dir) => {
    const opened = [];
    const orig = { openSync: fs.openSync, readFileSync: fs.readFileSync };
    fs.openSync = function (p, ...rest) { opened.push(String(p)); return orig.openSync.call(fs, p, ...rest); };
    fs.readFileSync = function (p, ...rest) { opened.push(String(p)); return orig.readFileSync.call(fs, p, ...rest); };
    let e;
    try {
      e = fullReplay(adapter, dir);
    } finally {
      Object.assign(fs, orig);
    }
    const rels = [...new Set(opened.map((p) => path.relative(dir, p)))].sort();
    assert.deepEqual(rels, ['tmp/toyshop-1/.project_root', 'tmp/toyshop-1/chats/session-2026-10-21T19-56-bcda44a6.jsonl']);
    const units = [...e.sessions.values()].flatMap((s) => [...s.sources.values()].flatMap((x) => [...x.units.values()]));
    assert.ok(!units.some((u) => u.body.includes('authType')));
  });
});

test('gemini-cli: list names every chat file by its header sessionId; sub-agents are sessions; .project_root is a side source', () => {
  withCopy('features', (dir) => {
    const sessions = adapter.list(storeOf(adapter, dir));
    assert.deepEqual(sessions.map((s) => s.session_id), ['5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e', '6e7f8091-a2b3-4c4d-9e5f-6a7b8c9d0e1f', '7f3e9a10-5c2d-4b8e-9f01-2a3b4c5d6e7f', 'a7c3e9f0-1b2c-4d3e-8f4a-5b6c7d8e9f01']);
    for (const s of sessions) {
      assert.deepEqual([s.incarnation, s.live], ['', 'unknown']);
      assert.deepEqual(s.sources.map((x) => [x.role, x.mode, x.position_kind]), [['main', 'stream', 'byte_offset'], ['side', 'snapshot', 'snapshot']]);
      assert.equal(s.sources[1].source_key, 'tmp/toyshop/.project_root');
    }
    assert.equal(sessions[3].sources[0].source_key, 'tmp/toyshop/chats/7f3e9a10-5c2d-4b8e-9f01-2a3b4c5d6e7f/a7c3e9f0-1b2c-4d3e-8f4a-5b6c7d8e9f01.jsonl');
    // The hint moves when a source grows.
    fs.appendFileSync(path.join(dir, sessions[0].sources[0].source_key), '\n');
    assert.notEqual(adapter.list(storeOf(adapter, dir))[0].updated_hint, sessions[0].updated_hint);
  });
  withCopy('legacy', (dir) => {
    const sessions = adapter.list(storeOf(adapter, dir));
    // A .jsonl beats the .json it was migrated from; a first line that is no header, and a header
    // line still being written, are no session.
    assert.deepEqual(sessions.map((s) => [s.session_id, s.sources[0].source_key.split('/').pop(), s.sources[0].mode]), [
      ['c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f', 'session-2025-09-01T10-00-c1d2e3f4.json', 'snapshot'],
      ['d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60', 'session-2025-09-02T11-00-d2e3f4a5.jsonl', 'stream'],
    ]);
  });
  withCopy(null, (dir) => assert.deepEqual(adapter.list(storeOf(adapter, dir)), []));
});

test('gemini-cli: a legacy .json migrated to .jsonl: the session keeps its keys and continues', () => {
  withCopy('legacy', (dir) => {
    const store = storeOf(adapter, dir);
    const jl = 'tmp/old-proj/chats/session-2025-09-02T11-00-d2e3f4a5.jsonl';
    const text = fs.readFileSync(path.join(dir, jl));
    fs.rmSync(path.join(dir, jl));
    const e = new MiniEngine(adapter, store);
    e.pass();
    const sid = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60';
    const before = [...viewOf(e, sid).view.values()].filter((r) => r.type === 'message').map((r) => r.message_id).sort();
    assert.equal(before.length, 2);
    fs.writeFileSync(path.join(dir, jl), text);
    e.pass();
    assert.deepEqual([...viewOf(e, sid).sources.keys()].sort(), ['tmp/old-proj/.project_root', jl]);
    const after = [...viewOf(e, sid).view.values()].filter((r) => r.type === 'message').map((r) => r.message_id);
    for (const id of before) assert.ok(after.includes(id), `${id} keeps its key`);
    assert.equal(after.length, 3);
    assert.deepEqual(project(e.views()), golden('legacy'));
  });
});

test('gemini-cli: a legacy .json still being written is held back; the last snapshot stands', () => {
  withCopy('legacy', (dir) => {
    const store = storeOf(adapter, dir);
    const rel = 'tmp/old-proj/chats/session-2025-09-01T10-00-c1d2e3f4.json';
    const key = { ...store, session_id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f', incarnation: '' };
    const whole = fs.readFileSync(path.join(dir, rel), 'utf8');
    const r1 = adapter.read(store, key, rel, null, null);
    assert.deepEqual([r1.continuity, r1.units.length], ['reset', 1]);
    fs.writeFileSync(path.join(dir, rel), whole.slice(0, whole.length / 2));
    const r2 = adapter.read(store, key, rel, r1.position, null);
    assert.deepEqual([r2.continuity, r2.units.length, r2.held_back.length, r2.position], ['unchanged', 0, 1, r1.position]);
    fs.writeFileSync(path.join(dir, rel), whole.replace('It prints a greeting.', 'It prints a greeting twice.'));
    const r3 = adapter.read(store, key, rel, r1.position, null);
    assert.deepEqual([r3.continuity, r3.units.length], ['snapshot', 1]);
  });
});

test('gemini-cli: cwd: the session context, then header directories, then .project_root; never projects.json', () => {
  withCopy(null, (dir) => {
    const store = storeOf(adapter, dir);
    write(dir, 'projects.json', JSON.stringify({ projects: { '/home/user/work/from-index': 'toy' } }));
    write(dir, REL, jsonl([head, user('u1', 1, 'hello')]));
    const cwd = () => {
      const e = fullReplay(adapter, dir);
      return [...viewOf(e, SID).view.values()].find((r) => r.type === 'session').cwd;
    };
    assert.equal(cwd(), null, 'no record names one, and projects.json is not read');
    write(dir, 'tmp/toy/.project_root', '/home/user/work/toy\n');
    assert.equal(cwd(), '/home/user/work/toy');
    write(dir, REL, jsonl([{ ...head, directories: ['/home/user/work/dirs'] }, user('u1', 1, 'hello')]));
    assert.equal(cwd(), '/home/user/work/dirs');
    // A changed .project_root reaches the consumer as a snapshot of the side source.
    write(dir, REL, jsonl([head, user('u1', 1, 'hello')]));
    const e = new MiniEngine(adapter, store);
    e.pass();
    write(dir, 'tmp/toy/.project_root', '/home/user/work/toy-moved\n');
    e.pass();
    assert.deepEqual(e.log.map((l) => l.continuity), ['unchanged', 'snapshot']);
    assert.equal([...viewOf(e, SID).view.values()].find((r) => r.type === 'session').cwd, '/home/user/work/toy-moved');
  });
});

test('gemini-cli: errors: an unknown session, an unknown source, another session\'s source, a deleted session', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const [a, b] = adapter.list(store);
    const key = { ...store, session_id: a.session_id, incarnation: '' };
    assert.throws(() => adapter.read(store, { ...key, session_id: '11111111-1111-4111-8111-111111111111' }, a.sources[0].source_key), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, 'tmp/toyshop/chats/session-none.jsonl'), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key, b.sources[0].source_key), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key, 'tmp/toyshop/checkpoint-x.json'), { code: 'source_unknown' });
    // A deleted session (`--delete-session` removes the chat file): list omits it, read says so.
    fs.rmSync(path.join(dir, a.sources[0].source_key));
    assert.ok(!adapter.list(store).some((s) => s.session_id === a.session_id));
    assert.throws(() => adapter.read(store, key, a.sources[0].source_key), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, a.sources[1].source_key), { code: 'session_unknown' });
  });
});

test('gemini-cli: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'gemini-cli');
  assert.equal(d.model_version, 'sessions-model/1');
  for (const op of ['rewind', 'edit', 'compaction', 'delete', 'archive', 'unarchive', 'rename', 'pin', 'unpin', 'fork', 'clear']) {
    assert.ok(['explicit', 'implicit', 'invisible'].includes(d.facets.lifecycle[op]), op);
  }
  for (const k of ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation']) {
    assert.ok(['explicit', 'inferable', 'none'].includes(d.facets.linkage[k]), k);
  }
  assert.ok(['native', 'positional', 'none'].includes(d.facets.linkage.tool));
  assert.ok(['exact', 'partial'].includes(d.facets.list) && ['exact', 'lossy'].includes(d.facets.read));
  assert.equal(d.facets.reuse, 'impossible');
  assert.ok(['yes', 'derived', 'no'].includes(d.facets.join.hook));
  const recs = CASES.flatMap((c) => Object.values(golden(c)).flat());
  const ops = new Set(recs.filter((r) => r.type === 'lifecycle').map((r) => r.op));
  for (const [op, v] of Object.entries(d.facets.lifecycle)) if (v === 'explicit') assert.ok(ops.has(op), `explicit ${op} has no fixture record`);
  const links = recs.filter((r) => r.type === 'link');
  for (const k of ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation']) {
    if (d.facets.linkage[k] !== 'explicit') continue;
    assert.ok(links.some((l) => l.kind === k && l.stated_on === 'child'), `explicit ${k}: no child-side fixture record`);
    assert.ok(links.some((l) => l.kind === k && l.stated_on === 'origin'), `explicit ${k}: no origin-side fixture record`);
  }
  // Every retraction leaves its targets in the records, retracted (sessions-model §2.6 (a)).
  for (const lc of recs.filter((r) => r.type === 'lifecycle' && r.op === 'rewind')) {
    const m = recs.find((r) => r.type === 'message' && r.session_id === lc.session_id && r.message_id === lc.target.range.from_id);
    assert.ok(m, `${lc.lifecycle_id}: its target is still a record`);
  }
  // The one declared secret path sits in a file the adapter never opens.
  assert.deepEqual(d.redaction.paths.map((p) => [p.path, p.opened]), [['authType', false]]);
});
