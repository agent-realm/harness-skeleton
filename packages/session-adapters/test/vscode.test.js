import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../src/index.js';
import { jcs } from '../src/jcs.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, growthCheck, rewriteCheck, tmpStore, copyTree, storeOf, nameLint } from '../conformance/runner.js';

const adapter = adapterFor('vscode');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'vscode');
const CASES = ['lab', 'features'];
const SID_A = '0a0a0a0a-0000-4000-8000-00000000000a';

function withCopy(name, fn) {
  const dir = tmpStore();
  try {
    copyTree(path.join(FIX, name, 'store'), dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const golden = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name, 'expected.json'), 'utf8'));
const mainOf = (dir, sid) => adapter.list(storeOf(adapter, dir)).find((s) => s.session_id === sid).sources.find((x) => x.role === 'main').source_key;
const msg = (recs, id) => recs.find((r) => r.type === 'message' && r.message_id === id);

for (const name of CASES) {
  test(`vscode/${name}: the full replay equals the reviewed golden`, () => {
    withCopy(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), golden(name)));
  });

  test(`vscode/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    const r = growthCheck(adapter, path.join(FIX, name, 'store'), { steps: 31 });
    assert.deepEqual(r.incremental, r.full);
    assert.ok(r.equal, 'content_sha differs between the incremental and the full view');
    assert.deepEqual(r.notUnchanged, []);
  });

  test(`vscode/${name}: keys are stable across a lost state`, () => {
    withCopy(name, (dir) => {
      const a = project(fullReplay(adapter, dir).views());
      const b = project(fullReplay(adapter, dir).views());
      assert.deepEqual(a, b);
    });
  });

  test(`vscode/${name}: no string under a secret-looking name in any unit or record, outside the declared exemptions`, () => {
    const exempt = adapter.describe().redaction.exemptions;
    withCopy(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) for (const u of src.units.values()) hits.push(...nameLint(JSON.parse(u.body), exempt, `${u.unit_key}:`));
        for (const r of s.view.values()) hits.push(...nameLint(r, exempt, `${r.type}:`));
      }
      assert.deepEqual(hits, []);
    });
  });
}

test('vscode: a rewrite of the change log (new inode, shorter) is a reset, and vanished keys go', () => {
  const rel = withCopy('features', (dir) => mainOf(dir, SID_A));
  const r = rewriteCheck(adapter, path.join(FIX, 'features', 'store'), rel, 5);
  assert.equal(r.continuity, 'reset');
  assert.ok(r.equal);
});

test('vscode: a kind 2 with i arrives appended; the cut requests stay, retracted, with a rewind record; nothing is tombstoned', () => {
  withCopy('features', (dir) => {
    const rel = mainOf(dir, SID_A);
    const file = path.join(dir, rel);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const cut = lines.findIndex((l) => { const o = JSON.parse(l); return o.kind === 2 && o.i === 8; });
    fs.writeFileSync(file, lines.slice(0, cut).map((l) => l + '\n').join(''));
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const before = e.views()[SID_A];
    fs.appendFileSync(file, lines[cut] + '\n');
    e.pass();
    assert.equal(e.log.find((l) => l.source_key === rel).continuity, 'appended');
    const after = e.views()[SID_A];
    for (const k of before.keys()) assert.ok(after.has(k), `${k.replace('\u0000', ' ')} is still there`);
    const recs = [...after.values()];
    const retracted = recs.filter((r) => r.type === 'message' && r.state === 'retracted').map((r) => r.message_id);
    assert.equal(retracted.length, 2);
    const lc = recs.filter((r) => r.type === 'lifecycle' && r.op === 'rewind');
    assert.equal(lc.length, 1);
    assert.equal(lc[0].lifecycle_id, `${rel}@${lines.slice(0, cut).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)}#1`);
    assert.deepEqual([lc[0].target.range.from_id, lc[0].target.range.through_id], retracted.sort());
  });
});

test('vscode: the reply still being written is held, never live; a reply held again keeps its last version, and returns when complete', () => {
  // The fixture's last request is pending: its reply, usage and compaction keys are held.
  withCopy('features', (dir) => {
    const e = fullReplay(adapter, dir);
    const out = e.sessions.get(`${SID_A}\u0000`).last;
    const t11 = [...e.views()[SID_A].values()].find((r) => r.type === 'message' && r.parts[0] && r.parts[0].text === 'Summarise the session.');
    const reply = out.held.message;
    assert.equal(reply.length, 1);
    assert.ok(!out.live.message.includes(reply[0]));
    assert.ok(!out.changed.some((r) => r.type === 'message' && r.message_id === reply[0]));
    assert.deepEqual(out.held.usage, [`response:${reply[0]}#1`]);
    assert.ok(out.live.message.includes(t11.message_id), 'the user message is complete');
  });

  // A reply written, then re-appended under its id still pending, then completed.
  const dir = tmpStore();
  try {
    const sid = '0f0f0f0f-0000-4000-8000-00000000000f';
    const file = path.join(dir, 'User', 'globalStorage', 'emptyWindowChatSessions', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const done = { requestId: 'request_held_1', responseId: 'response_held_1', timestamp: 1767693600000, message: { text: 'Count the files.' }, response: [{ value: 'Two files.' }], result: { metadata: { resolvedModel: 'gpt-6-luna' } }, modelState: { value: 1 }, promptTokens: 10, completionTokens: 3 };
    const open = { ...done, response: [{ value: 'Thr' }], modelState: { value: 0 } };
    delete open.result;
    const write = (...ops) => fs.appendFileSync(file, ops.map((o) => JSON.stringify(o) + '\n').join(''));
    write({ kind: 0, v: { version: 3, creationDate: 1767693599000, sessionId: sid, requests: [] } }, { kind: 2, k: ['requests'], v: [done] });
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const first = e.views()[sid].get('message\u0000response_held_1');
    assert.equal(first.parts[0].text, 'Two files.');
    write({ kind: 2, k: ['requests'], v: [open], i: 0 });
    e.pass();
    const out = [...e.sessions.values()][0].last;
    assert.deepEqual(out.held.message, ['response_held_1']);
    assert.ok(!out.live.message.includes('response_held_1'));
    assert.ok(!out.changed.some((r) => r.message_id === 'response_held_1'));
    assert.equal(e.views()[sid].get('message\u0000response_held_1').content_sha, first.content_sha, 'the consumer keeps the last version');
    assert.ok(!out.changed.some((r) => r.type === 'lifecycle'), 'an in-place update is no retraction');
    write({ kind: 1, k: ['requests', 0, 'response'], v: [{ value: 'Three files.' }] }, { kind: 1, k: ['requests', 0, 'modelState'], v: { value: 1 } });
    e.pass();
    const back = [...e.sessions.values()][0].last;
    assert.ok(back.live.message.includes('response_held_1'));
    assert.equal(back.changed.find((r) => r.message_id === 'response_held_1').parts[0].text, 'Three files.');
    assert.deepEqual(back.held.message, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vscode: redaction: selectedModel.metadata.auth never leaves read, whichever op set it; N is the value\'s byte length', () => {
  withCopy('features', (dir) => {
    const e = fullReplay(adapter, dir);
    const units = [...e.sessions.values()].flatMap((s) => [...s.sources.values()].flatMap((src) => [...src.units.values()]));
    for (const u of units) assert.ok(!u.body.includes('sentinel'), `${u.source_key}@${u.unit_key} carries no auth value`);
    for (const s of e.sessions.values()) for (const r of s.view.values()) assert.ok(!JSON.stringify(r).includes('sentinel'));
    const auth = { providerLabel: 'toy-provider', accountLabel: 'toy-account-sentinel-5e1f' };
    const objMarker = `<redacted len=${Buffer.byteLength(jcs(auth))}>`;
    const strMarker = `<redacted len=${Buffer.byteLength('toy-account-sentinel-9a2b')}>`;
    const main = units.filter((u) => u.source_key.endsWith(`${SID_A}.jsonl`)).sort((a, b) => Number(a.unit_key) - Number(b.unit_key));
    const ops = main.map((u) => JSON.parse(u.body));
    assert.equal(ops[0].v.inputState.selectedModel.metadata.auth, objMarker, 'kind 0: the object, by its canonical JSON');
    assert.equal(ops[2].v.metadata.auth, strMarker, 'kind 1 at …selectedModel: a string inside v');
    const direct = ops.findIndex((o) => o.kind === 1 && o.k.join('.') === 'inputState.selectedModel.metadata.auth');
    assert.equal(ops[direct].v, strMarker, 'kind 1 whose k ends at auth: v itself');
    assert.deepEqual([main[0].redacted, main[1].redacted, main[2].redacted, main[direct].redacted], [true, false, true, true]);
    // A complete line that does not parse is one marker, never its bytes.
    const torn = main.find((u) => typeof JSON.parse(u.body) === 'string');
    assert.match(JSON.parse(torn.body), /^<redacted len=\d+>$/);
    assert.equal(torn.redacted, true);
    // The legacy .json snapshot is redacted the same way.
    const legacy = units.find((u) => u.source_key.endsWith('0b0b0b0b-0000-4000-8000-00000000000b.json'));
    assert.equal(JSON.parse(legacy.body).inputState.selectedModel.metadata.auth, objMarker);
  });
  // A value that is already a marker (the lab capture's) is left as it is.
  withCopy('lab', (dir) => {
    const e = fullReplay(adapter, dir);
    const units = [...e.sessions.values()].flatMap((s) => [...s.sources.values()].flatMap((src) => [...src.units.values()]));
    assert.ok(units.every((u) => u.redacted === false));
    assert.ok(units.some((u) => u.body.includes('"auth":"<redacted len=64>"')));
  });
});

test('vscode: a JSON snapshot that does not parse is held back, never returned', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.sources.some((y) => y.source_key.endsWith('.json') && y.role === 'main' && y.source_key.includes('emptyWindow')));
    const key = { ...store, session_id: s.session_id, incarnation: '' };
    const sk = s.sources[0].source_key;
    const whole = adapter.read(store, key, sk, null);
    assert.equal(whole.continuity, 'reset');
    const file = path.join(dir, sk);
    fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 100));
    const torn = adapter.read(store, key, sk, null);
    assert.deepEqual([torn.continuity, torn.units, torn.position], ['reset', [], null]);
    assert.equal(torn.held_back.length, 1);
    const after = adapter.read(store, key, sk, whole.position);
    assert.deepEqual([after.continuity, after.units, after.position], ['unchanged', [], whole.position]);
  });
});

test('vscode: the lab cases of the annex', () => {
  const g = golden('lab');
  // 65a4e98a: a kind 0 of 5 requests, then a kind 2 with i=4: 5 current requests, the 5th
  // request replaced; the replaced one is retracted; one rewind record.
  const fork = g['65a4e98a-a792-4f21-8b88-91971aa08c28'];
  const users = fork.filter((r) => r.type === 'message' && r.role === 'user').sort((a, b) => (a.order < b.order ? -1 : 1));
  assert.deepEqual(users.filter((r) => r.state === 'current').map((r) => r.message_id).slice(-1), ['request_5e1f0000-0000-4000-8000-000000000147']);
  assert.equal(users.filter((r) => r.state === 'current').length, 5);
  assert.equal(users.filter((r) => r.state === 'retracted').length, 1);
  assert.deepEqual(fork.filter((r) => r.type === 'lifecycle').map((r) => r.op), ['rewind']);
  // The fork's first request: a bare uuid, ts = creationDate + 1 ms; no link is stated.
  const first = msg(fork, '5e1f0000-0000-4000-8000-000000000081');
  assert.equal(first.ts, new Date(1792502040550).toISOString());
  assert.ok(!Object.values(g).flat().some((r) => r.type === 'link'));
  // Its usage: completionTokens 1258 (not outputTokens 102), promptTokens 20822; the model Auto
  // resolved, not copilot/auto.
  const u = fork.find((r) => r.type === 'usage' && r.anchor.response_id === '5e1f0000-0000-4000-8000-000000000082');
  assert.deepEqual([u.input, u.output, u.model, u.input_includes_cache, u.output_includes_reasoning, u.granularity], [20822, 1258, 'mai-code-1.1-flash', null, null, 'per_turn']);
  const reply = msg(fork, '5e1f0000-0000-4000-8000-000000000082');
  assert.deepEqual([reply.requested_model, reply.served_model], ['copilot/auto', 'mai-code-1.1-flash']);
  // toolInvocationSerialized call_hqy7: one tool_call and its tool_result.
  assert.deepEqual(reply.parts.filter((p) => p.call_id === 'call_fixture0094xxxxxxxxxxxxx').map((p) => [p.part_id, p.kind]), [['4:call', 'tool_call'], ['4:result', 'tool_result']]);
  // An empty thinking part with an id: reasoning, opaque.
  assert.ok(reply.parts.some((p) => p.kind === 'reasoning' && p.opaque === true && !('text' in p)));
  // f0da568c: no request in kind 0, a customTitle, then a kind 2 without i: exactly one request.
  const one = g['f0da568c-8ed3-4480-b0b4-787ca035cc3c'];
  assert.deepEqual(one.filter((r) => r.type === 'message' && r.role === 'user').map((r) => r.message_id), ['request_5e1f0000-0000-4000-8000-000000000152']);
  assert.equal(one.find((r) => r.type === 'session').title, 'vscode copilot response');
});

test('vscode: the features golden holds the normaliser\'s reviewed behaviour', () => {
  const s = golden('features')[SID_A];
  const sess = s.find((r) => r.type === 'session');
  assert.deepEqual([sess.title, sess.cwd, sess.engine, sess.client, sess.harness_version, sess.incarnation], ['toyshop renamed', '/home/user/work/toy shop', 'local', 'vscode', '0.70.0', '']);
  const msgs = s.filter((r) => r.type === 'message').sort((a, b) => (a.order < b.order ? -1 : 1));
  // One speaker per message; part ids are response[] indices; text runs merge across an inline reference.
  const r1 = msgs[1];
  assert.deepEqual(r1.parts.map((p) => p.kind), ['text', 'reasoning', 'tool_call', 'tool_result', 'text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'notice', 'text']);
  assert.equal(r1.parts[4].text, 'The total ignores qty in `Cart.total_cents()`; running the tests.');
  const res = (id) => r1.parts.find((p) => p.kind === 'tool_result' && p.call_id === id);
  const call = (id) => r1.parts.find((p) => p.kind === 'tool_call' && p.call_id === id);
  assert.equal(res('call_A').output, 'class Cart:\n    def total_cents(self):\n        return sum(i.price for i in self.items)\n', 'prompt-tsx flattened');
  assert.equal(res('call_B').output, '1 failed in 0.01s', 'the result the model saw wins over the terminal view');
  assert.deepEqual([call('call_C').name, res('call_C').is_error], ['multi_replace_string_in_file', true], 'model-facing name; resultError is an error');
  assert.deepEqual([call('call_M').server, call('call_A').server], ['toybox', null]);
  // A sub-agent's calls are their own speaker, anchored on the reply.
  const sub = msgs.find((m) => m.agent_id === 'call_S');
  assert.match(sub.message_id, /\+1$/);
  // A missing responseId: `<requestId>:response`, usage anchored on it.
  const noResp = msgs.find((m) => m.message_id.endsWith(':response'));
  assert.ok(s.some((r) => r.type === 'usage' && r.anchor.message_id === noResp.message_id));
  // Statuses: error, interrupted (a later request follows), cancelled with a denied tool.
  assert.deepEqual(['error', 'interrupted', 'cancelled'].map((st) => msgs.filter((m) => m.status === st).length), [1, 1, 1]);
  assert.equal(msgs.find((m) => m.status === 'cancelled').parts.find((p) => p.kind === 'tool_result').status, 'denied');
  assert.equal(msgs.find((m) => m.status === 'cancelled').served_model, 'mai-code-1.1-flash', 'from the autoModeResolution part');
  // The same id re-appended by a splice is updated in place: output 99, current, no second rewind.
  assert.ok(s.some((r) => r.type === 'usage' && r.output === 99));
  assert.equal(s.filter((r) => r.type === 'lifecycle' && r.op === 'rewind').length, 1);
  // UI state and votes change no record: requests 0's messages are as first written.
  assert.ok(!('vote' in msgs[0]));
});

test('vscode: a terminal tool_result carries the stored terminalCommandState.exitCode; none is null', () => {
  withCopy('features', (dir) => {
    const parts = Object.values(fullReplay(adapter, dir).views()).flatMap((v) => [...v.values()]).filter((r) => r.type === 'message').flatMap((m) => m.parts);
    const exit = (id) => [...new Set(parts.filter((p) => p.kind === 'tool_result' && p.call_id.startsWith(id)).map((p) => p.exit_code))];
    // call_B: `terminalCommandState: {exitCode: 1}`; the output the model saw names no code.
    assert.deepEqual(exit('call_B'), [1]);
    // call_A reads a file (no terminal); call_D, a denied terminal command, never ran.
    assert.deepEqual([exit('call_A'), exit('call_D')], [[null], [null]]);
  });
});

// sessions-model v1.x (#6), §2.3 (`tool_result.is_error`): the invocation's own flag. A
// `resultError` is true and a done invocation false; a done invocation beside a terminal's non-zero
// exit_code is unreliable for that result, so its is_error is null. Never derived from exit_code.
test('vscode: is_error is the stored flag: done beside a non-zero terminal exit is null, done is false, a resultError is true', () => {
  withCopy('features', (dir) => {
    const resultsOf = () => {
      const out = {};
      for (const [sid, recs] of Object.entries(project(fullReplay(adapter, dir).views()))) {
        for (const p of recs.filter((r) => r.type === 'message').flatMap((m) => m.parts)) if (p.kind === 'tool_result') out[`${sid.slice(0, 8)}:${p.call_id}`] = [p.is_error, p.exit_code, p.status];
      }
      return out;
    };
    const r = resultsOf();
    assert.deepEqual([r['0a0a0a0a:call_B'], r['0d0d0d0d:call_B']], [[null, 1, 'completed'], [null, 1, 'completed']], 'done beside exit 1 (and its fork copy): unreliable for this result');
    assert.deepEqual([r['0a0a0a0a:call_A'], r['0a0a0a0a:call_M']], [[false, null, 'completed'], [false, null, 'completed']], 'done, no terminal');
    assert.deepEqual([r['0a0a0a0a:call_C'], r['0a0a0a0a:call_D']], [[true, null, 'completed'], [null, null, 'denied']], 'resultError; a denial (no call that completed)');
    // Edited in this copy: the terminal exits 0 (done: false).
    const file = path.join(dir, mainOf(dir, SID_A));
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.split('"terminalCommandState":{"exitCode":1').length, 2, 'one terminal state to edit');
    fs.writeFileSync(file, text.replace('"terminalCommandState":{"exitCode":1', '"terminalCommandState":{"exitCode":0'));
    assert.deepEqual(resultsOf()['0a0a0a0a:call_B'], [false, 0, 'completed'], 'done, exit 0');
  });
});

// sessions-model v1.x (#6), §2.3 (`tool_result.is_error`): `is_error` describes a call that
// completed. A denial (`isConfirmed` 0: `denied`) and a skip (5: `cancelled`) did not: their
// is_error is null, a `resultError` beside them included, and the status carries the fact. A call
// that completed keeps the flag (the positive control: a `resultError` true, done false).
test('vscode: is_error is null where the call did not complete: a denial or a skip; the status carries the fact', () => {
  withCopy('features', (dir) => {
    const resultsOf = () => Object.fromEntries(project(fullReplay(adapter, dir).views())[SID_A].filter((r) => r.type === 'message')
      .flatMap((m) => m.parts).filter((p) => p.kind === 'tool_result').map((p) => [p.call_id, [p.status, p.is_error]]));
    const r = resultsOf();
    assert.deepEqual(r.call_D, ['denied', null], 'the fixture\'s denial');
    assert.deepEqual([r.call_C, r.call_A], [['completed', true], ['completed', false]], 'the positive control: a resultError; done');
    // Edited in this copy: call_A is skipped, and call_C (its resultError kept) is denied.
    const file = path.join(dir, mainOf(dir, SID_A));
    let text = fs.readFileSync(file, 'utf8');
    for (const [id, type] of [['call_A', 5], ['call_C', 0]]) {
      const before = `"isConfirmed":{"type":1},"isComplete":true,"source":{"type":"internal","label":"Built-In"},"toolCallId":"${id}"`;
      assert.equal(text.split(before).length, 2, id);
      text = text.replace(before, before.replace('"type":1', `"type":${type}`));
    }
    fs.writeFileSync(file, text);
    const e = resultsOf();
    assert.deepEqual([e.call_A, e.call_C], [['cancelled', null], ['denied', null]]);
  });
});

test('vscode: the order sources are folded in changes nothing', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.sources.length === 3);
    const key = { ...store, session_id: s.session_id, incarnation: '' };
    const input = s.sources.map((src) => ({ source_key: src.source_key, generation: 1, complete: true, units: adapter.read(store, key, src.source_key, null).units, gone: [] }));
    const run = (inp) => {
      const out = adapter.derive(key, inp, null);
      return { changed: out.changed.map((r) => r.content_sha).sort(), live: out.live, held: out.held };
    };
    const a = run(input);
    assert.deepEqual(run([...input].reverse()), a);
    // One source per derive call, in either order, gives the same records too.
    const step = (inp) => inp.reduce((st, x) => adapter.derive(key, [{ ...x, complete: false }], st).state, null);
    const viaSteps = (inp) => {
      const st = step(inp);
      return Object.fromEntries(Object.entries(st.emitted).map(([t, ks]) => [t, Object.entries(ks).sort()]));
    };
    assert.deepEqual(viaSteps([...input].reverse()), viaSteps(input));
    assert.deepEqual(viaSteps(input).message.map(([k]) => k), a.live.message);
  });
});

test('vscode: one id in both formats reads the change log; a mid-file kind 0 drops what came before', () => {
  const g = golden('features');
  const c = g['0c0c0c0c-0000-4000-8000-00000000000c'].filter((r) => r.type === 'message' && r.role === 'user');
  assert.deepEqual(c.map((r) => r.parts[0].text).sort(), ['A question in the change log.', 'A second question.']);
  const e = g['0e0e0e0e-0000-4000-8000-00000000000e'].filter((r) => r.type === 'message');
  assert.deepEqual(e.map((r) => [r.role, r.state]), [['user', 'current'], ['assistant', 'current']]);
  assert.equal(e.find((r) => r.role === 'user').parts[0].text, 'After the reload.');
  assert.ok(!g['0e0e0e0e-0000-4000-8000-00000000000e'].some((r) => r.type === 'lifecycle'));
  // The fork's leading cmp_shas match its origin's: what a consumer nominates it by.
  const fp = (sid) => g[sid].find((r) => r.type === 'session').fingerprint.cmp_shas;
  assert.deepEqual(fp('0d0d0d0d-0000-4000-8000-00000000000d'), fp(SID_A).slice(0, 4));
});

test('vscode: list names every chat file of the user-data folder; workspace.json is a side source', () => {
  withCopy('features', (dir) => {
    const sessions = adapter.list(storeOf(adapter, dir));
    assert.equal(sessions.length, 5);
    for (const s of sessions) {
      assert.equal(s.incarnation, '');
      assert.equal(s.live, 'unknown');
      for (const x of s.sources) {
        const want = x.role === 'side' ? ['snapshot', 'snapshot'] : x.source_key.endsWith('.jsonl') ? ['stream', 'byte_offset'] : ['snapshot', 'snapshot'];
        assert.deepEqual([x.mode, x.position_kind], want, x.source_key);
      }
    }
    const c = sessions.find((s) => s.session_id.startsWith('0c0c'));
    assert.deepEqual(c.sources.map((x) => [x.role, path.posix.basename(x.source_key)]), [['main', `${c.session_id}.json`], ['main', `${c.session_id}.jsonl`], ['side', 'workspace.json']]);
    const b = sessions.find((s) => s.session_id.startsWith('0b0b'));
    assert.deepEqual(b.sources.map((x) => x.role), ['main'], 'an empty window has no workspace.json');
    // The hint moves when a source grows.
    const main = path.join(dir, c.sources[1].source_key);
    fs.appendFileSync(main, '\n');
    assert.notEqual(adapter.list(storeOf(adapter, dir)).find((s) => s.session_id === c.session_id).updated_hint, c.updated_hint);
  });
  withCopy('lab', (dir) => assert.deepEqual(adapter.list(storeOf(adapter, path.join(dir, 'missing'))), []));
});

test('vscode: the client is the user-data folder\'s name', () => {
  const key = (hp) => ({ host: 'h', harness: 'vscode', harness_path: hp, session_id: 's', incarnation: '' });
  const client = (hp) => adapter.derive(key(hp), [], null).changed.find((r) => r.type === 'session').client;
  assert.deepEqual(['/home/user/.config/Code', '/home/user/.config/Code - Insiders', 'C:\\Users\\user\\AppData\\Roaming\\VSCodium', '/home/user/.config/Other'].map(client),
    ['vscode', 'vscode-insiders', 'vscodium', 'vscode']);
});

test('vscode: errors: an unknown session, an unknown source, a path for an id, a deleted session', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.session_id === SID_A);
    const key = { ...store, session_id: s.session_id, incarnation: '' };
    assert.throws(() => adapter.read(store, { ...key, session_id: '11111111-1111-4111-8111-111111111111' }, s.sources[0].source_key), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, { ...key, session_id: '../x' }, s.sources[0].source_key), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, 'User/workspaceStorage/x/chatSessions/none.jsonl'), { code: 'source_unknown' });
    fs.rmSync(path.join(dir, s.sources[0].source_key));
    assert.ok(!adapter.list(store).some((x) => x.session_id === SID_A));
    assert.throws(() => adapter.read(store, key, s.sources[0].source_key), { code: 'session_unknown' });
  });
});

// The shared case table (test/symlinks.test.js) covers a linked chat file and a linked
// workspaceStorage/<ws> folder; this covers the folders and the side source it does not.
test('vscode: a symlinked chatSessions or empty-window folder, or workspace.json, is neither listed nor read', () => {
  withCopy('lab', (dir) => {
    const store = storeOf(adapter, dir);
    const before = adapter.list(store);
    const outside = tmpStore('sa-outside-');
    try {
      const sid = '22222222-2222-4222-8222-222222222222';
      const body = JSON.stringify({ kind: 0, v: { creationDate: 1767693599000, sessionId: sid, requests: [] } }) + '\n';
      fs.writeFileSync(path.join(outside, 'workspace.json'), JSON.stringify({ folder: 'file:///home/user/elsewhere' }));
      fs.mkdirSync(path.join(outside, 'chatSessions'));
      fs.writeFileSync(path.join(outside, 'chatSessions', `${sid}.jsonl`), body);
      // A linked empty-window folder; a real workspace folder whose chatSessions folder and
      // workspace.json are links.
      fs.mkdirSync(path.join(dir, 'User', 'globalStorage'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'chatSessions'), path.join(dir, 'User', 'globalStorage', 'emptyWindowChatSessions'));
      const ws = path.join(dir, 'User', 'workspaceStorage', 'real-ws');
      fs.mkdirSync(ws);
      fs.symlinkSync(path.join(outside, 'chatSessions'), path.join(ws, 'chatSessions'));
      fs.symlinkSync(path.join(outside, 'workspace.json'), path.join(ws, 'workspace.json'));
      // A real chat file beside a linked workspace.json: listed, without the side source.
      const ws2 = path.join(dir, 'User', 'workspaceStorage', 'real-ws-2');
      fs.mkdirSync(path.join(ws2, 'chatSessions'), { recursive: true });
      const own = '33333333-3333-4333-8333-333333333333';
      fs.writeFileSync(path.join(ws2, 'chatSessions', `${own}.jsonl`), body.replace(sid, own));
      fs.symlinkSync(path.join(outside, 'workspace.json'), path.join(ws2, 'workspace.json'));

      const after = adapter.list(store);
      assert.deepEqual(after.map((x) => x.session_id), [...before.map((x) => x.session_id), own].sort());
      assert.deepEqual(after.find((x) => x.session_id === own).sources.map((x) => x.role), ['main']);
      const key = { ...store, session_id: sid, incarnation: '' };
      const refused = (e) => e.code === 'session_unknown' || e.code === 'source_unknown';
      for (const rel of [
        `User/globalStorage/emptyWindowChatSessions/${sid}.jsonl`,
        `User/workspaceStorage/real-ws/chatSessions/${sid}.jsonl`,
      ]) assert.throws(() => adapter.read(store, key, rel), refused, rel);
      assert.throws(() => adapter.read(store, { ...key, session_id: own }, 'User/workspaceStorage/real-ws-2/workspace.json'), refused);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('vscode: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'vscode');
  assert.equal(d.model_version, 'sessions-model/1');
  for (const op of ['rewind', 'edit', 'compaction', 'delete', 'archive', 'unarchive', 'rename', 'pin', 'unpin', 'fork', 'clear']) {
    assert.ok(['explicit', 'implicit', 'invisible'].includes(d.facets.lifecycle[op]), op);
  }
  for (const k of ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation']) {
    assert.ok(['explicit', 'inferable', 'none'].includes(d.facets.linkage[k]), k);
  }
  const explicit = Object.entries(d.facets.lifecycle).filter(([, v]) => v === 'explicit').map(([k]) => k);
  for (const name of CASES) {
    const ops = new Set(Object.values(golden(name)).flat().filter((r) => r.type === 'lifecycle').map((r) => r.op));
    for (const op of explicit) if (name === 'features' || op !== 'compaction') assert.ok(ops.has(op), `${name}: explicit ${op} has no fixture record`);
  }
  // linkage.tool native: within a session, every tool_result pairs with exactly one tool_call.
  for (const name of CASES) {
    for (const recs of Object.values(golden(name))) {
      const parts = recs.filter((r) => r.type === 'message').flatMap((m) => m.parts);
      for (const r of parts.filter((p) => p.kind === 'tool_result')) {
        assert.equal(parts.filter((p) => p.kind === 'tool_call' && p.call_id === r.call_id).length, 1, r.call_id);
      }
    }
  }
  // The one declared secret path (sessions-model §4.1), on each chat file `read` redacts, in the
  // shape docs/adapter-interface.md fixes: [{source, path, opened}].
  const chat = d.sources.filter((s) => s.role === 'main').map((s) => s.pattern);
  assert.equal(chat.length, 4);
  assert.deepEqual(d.redaction.paths, chat.map((source) => ({ source, path: '**.selectedModel.metadata.auth', opened: true })));
});

test('vscode: redaction: a value below selectedModel.metadata.auth (auth.token) is redacted too', () => {
  const dir = tmpStore();
  try {
    copyTree(path.join(FIX, 'features', 'store'), dir);
    const store = storeOf(adapter, dir);
    const [s] = adapter.list(store);
    const main = s.sources.find((x) => x.role === 'main' && x.source_key.endsWith('.jsonl'));
    fs.appendFileSync(path.join(dir, main.source_key), JSON.stringify({ kind: 1, k: ['inputState', 'selectedModel', 'metadata', 'auth', 'token'], v: 'sentinel-below-auth' }) + '\n');
    const r = adapter.read(store, { ...store, session_id: s.session_id, incarnation: s.incarnation }, main.source_key, null, null);
    const last = r.units[r.units.length - 1];
    assert.ok(!r.units.some((u) => u.body.includes('sentinel-below-auth')));
    assert.equal(last.redacted, true);
    assert.equal(JSON.parse(last.body).v, `<redacted len=${Buffer.byteLength('sentinel-below-auth')}>`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vscode: speaker split: one request gives a user message keyed by its requestId and an assistant message keyed by its responseId', () => {
  withCopy('features', (dir) => {
    const recs = [...fullReplay(adapter, dir).views()[SID_A].values()];
    // features, request 0: requestId request_…004, responseId response_…005, one native request.
    const user = msg(recs, 'request_00000000-0000-4000-8000-000000000004');
    const reply = msg(recs, 'response_00000000-0000-4000-8000-000000000005');
    assert.deepEqual([user.role, user.source, user.parts.map((p) => p.kind)], ['user', 'user', ['text']]);
    assert.equal(user.parts[0].text, 'Fix the qty bug in cart.py, then run python3 -m pytest -q.');
    assert.deepEqual([reply.role, reply.source, reply.parent_id, reply.response_id], ['assistant', 'model', user.message_id, reply.message_id]);
    assert.ok(reply.parts.length > 0 && !reply.parts.some((p) => p.text === user.parts[0].text), 'the prompt is the user\'s message only');
    assert.ok(user.order < reply.order);
  });
});

test('vscode: compaction is not deletion: every message derived before the /compact request stays, current', () => {
  withCopy('features', (dir) => {
    const rel = mainOf(dir, SID_A);
    const file = path.join(dir, rel);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const at = lines.findIndex((l) => l.includes('"text":"/compact"'));
    assert.ok(at > 0);
    fs.writeFileSync(file, lines.slice(0, at).map((l) => l + '\n').join(''));
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const before = [...e.views()[SID_A].values()].filter((r) => r.type === 'message');
    assert.ok(before.length >= 8);
    fs.appendFileSync(file, lines.slice(at).map((l) => l + '\n').join(''));
    e.pass();
    const view = e.views()[SID_A];
    const summary = [...view.values()].find((r) => r.type === 'message' && r.parts.some((p) => p.kind === 'summary'));
    assert.ok(summary && [...view.values()].some((r) => r.type === 'lifecycle' && r.op === 'compaction' && r.lifecycle_id === summary.message_id));
    for (const m of before) {
      const now = view.get(`message\u0000${m.message_id}`);
      assert.ok(now, `${m.message_id} is still present`);
      assert.equal(now.state, 'current', m.message_id);
    }
  });
});
