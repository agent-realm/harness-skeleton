import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { adapterFor } from '../src/index.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, growthCheck, rewriteCheck, tmpStore, copyTree, storeOf, nameLint } from '../conformance/runner.js';

const adapter = adapterFor('copilot-cli');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'copilot-cli');
const CASES = ['basic', 'pass2', 'features', 'vscode-host', 'rewind', 'conformance-copilot-reuse'];
const EXEMPT = adapter.describe().redaction.exemptions;

// The features case's sessions (fixtures/copilot-cli/generate.js).
const A = 'a0a0a0a0-0000-4000-8000-000000000001';
const C1 = 'c1c1c1c1-0000-4000-8000-000000000002';
const C2 = 'c2c2c2c2-0000-4000-8000-000000000003';
const H = 'b0b0b0b0-0000-4000-8000-000000000004';
const R = 'd0d0d0d0-0000-4000-8000-000000000005';
const REUSE = 'ffe00cf7-7ac7-475d-afc2-ff0b68b29fa9';
const events = (sid) => `session-state/${sid}/events.jsonl`;

function withCopy(name, fn, sub = 'store') {
  const dir = tmpStore();
  try {
    copyTree(path.join(FIX, name, sub), dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const golden = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name, 'expected.json'), 'utf8'));
const messages = (recs) => recs.filter((r) => r.type === 'message');
const ofType = (recs, type) => recs.filter((r) => r.type === type);
// The full derive output of one session, as the engine's last pass saw it.
function lastDerive(e, sid) {
  for (const [id, s] of e.sessions) if (id.split('\u0000')[0] === sid) return s.last;
  return null;
}

for (const name of CASES) {
  test(`copilot-cli/${name}: the full replay equals the reviewed golden`, () => {
    withCopy(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), golden(name)));
  });

  test(`copilot-cli/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    const r = growthCheck(adapter, path.join(FIX, name, 'store'), { steps: 31 });
    assert.deepEqual(r.incremental, r.full);
    assert.ok(r.equal, 'content_sha differs between the incremental and the full view');
    assert.deepEqual(r.notUnchanged, []);
  });

  test(`copilot-cli/${name}: keys are stable across a lost state`, () => {
    withCopy(name, (dir) => {
      const a = project(fullReplay(adapter, dir).views());
      const b = project(fullReplay(adapter, dir).views());
      assert.deepEqual(a, b);
    });
  });

  test(`copilot-cli/${name}: no string under a secret-looking name in any unit or record`, () => {
    withCopy(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) {
          for (const u of src.units.values()) {
            // workspace.yaml is no JSON: its top-level keys are the native names.
            const v = u.source_key.endsWith('.yaml') ? Object.fromEntries(u.body.split('\n').map((l) => l.split(': ')).filter((x) => x.length > 1)) : JSON.parse(u.body);
            hits.push(...nameLint(v, EXEMPT, `${u.source_key}@${u.unit_key}:`));
          }
        }
        for (const r of s.view.values()) hits.push(...nameLint(r, EXEMPT, `${r.type}:`));
      }
      assert.deepEqual(hits, []);
    });
  });
}

test('copilot-cli: the folded result does not depend on the order sources are given', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    for (const s of adapter.list(store)) {
      const key = { ...store, session_id: s.session_id, incarnation: s.incarnation };
      const input = s.sources.map((x) => ({ source_key: x.source_key, generation: 1, complete: true, units: adapter.read(store, key, x.source_key).units, gone: [] }));
      const a = adapter.derive(key, input, null);
      const b = adapter.derive(key, [...input].reverse(), null);
      const sorted = (out) => out.changed.map((r) => JSON.stringify(r)).sort();
      assert.deepEqual(sorted(b), sorted(a));
      assert.deepEqual(b.live, a.live);
      assert.deepEqual(b.held, a.held);
    }
  });
});

// ---- the memhouse normaliser's reviewed cases, as conformance cases --------------------------

test('copilot-cli: a tool call and its result pair by toolCallId; usage, served model and effort by apiCallId', () => {
  const recs = golden('features')[A];
  const calls = messages(recs).flatMap((x) => x.parts.filter((p) => p.kind === 'tool_call'));
  for (const r of messages(recs).flatMap((x) => x.parts.filter((p) => p.kind === 'tool_result'))) {
    assert.equal(calls.filter((c) => c.call_id === r.call_id).length, 1, r.call_id);
  }
  // A shell that exited 1 under success true has no reliable flag (null; exit_code says it); a denied
  // call is denied; a failing call is an error.
  const result = (call) => messages(recs).find((x) => x.role === 'tool' && x.parts[0].call_id === call).parts[0];
  assert.deepEqual([result('chatcmpl-tool-feat-test').is_error, result('chatcmpl-tool-feat-test').exit_code, result('chatcmpl-tool-feat-test').status], [null, 1, 'completed']);
  assert.deepEqual([result('chatcmpl-tool-feat-pip').is_error, result('chatcmpl-tool-feat-pip').status], [true, 'denied']);
  assert.deepEqual([result('chatcmpl-tool-feat-ask').is_error, result('chatcmpl-tool-feat-ask').status], [true, 'completed']);
  assert.equal(result('chatcmpl-tool-feat-mcp').is_error, false);
  // The assistant message that asked for the task: reasoning, then the call; usage in its own record.
  const task = messages(recs).find((x) => x.parts.some((p) => p.call_id === 'chatcmpl-tool-feat-task' && p.kind === 'tool_call'));
  assert.deepEqual(task.parts.map((p) => p.kind), ['reasoning', 'tool_call']);
  assert.equal(task.response_id, 'api-feat-1');
  const u = ofType(recs, 'usage').find((x) => x.usage_id === 'api-feat-1');
  assert.deepEqual([u.input, u.output, u.reasoning, u.input_includes_cache, u.output_includes_reasoning, u.granularity], [1200, 30, 5, null, null, 'per_response']);
  assert.deepEqual(u.anchor, { response_id: 'api-feat-1' });
  // A sub-agent's reply takes its effort from its usage_record.
  const sub = messages(recs).find((x) => x.response_id === 'api-feat-2');
  assert.equal(sub.effort, 'low');
  // VS Code's agent host: requested is the message's model id, served is what the usage names.
  const vs = golden('vscode-host')['92b4b5fb-3d26-4492-9722-6d6e3bcaf8aa'];
  const a = messages(vs).find((x) => x.role === 'assistant');
  assert.deepEqual([a.requested_model, a.served_model, a.effort], ['gpt-6-luna', 'GPT-6 Luna', 'medium']);
  assert.deepEqual(a.parts.filter((p) => p.kind === 'reasoning').map((p) => !!p.opaque), [false, true], 'reasoning text, then the encrypted reasoning as opaque');
});

test('copilot-cli: cost is Copilot\'s credit count as stored, and a BYOK zero is null', () => {
  for (const u of ofType(golden('features')[A], 'usage')) assert.equal(u.cost, null, u.usage_id);
  const vs = ofType(golden('vscode-host')['92b4b5fb-3d26-4492-9722-6d6e3bcaf8aa'], 'usage');
  assert.deepEqual(vs.map((u) => u.cost), [1]);
});

test('copilot-cli: a reply cut off by the output cap leaves a usage record and no message', () => {
  const recs = golden('features')[A];
  const u = ofType(recs, 'usage').find((x) => x.usage_id === 'api-feat-11');
  assert.equal(u.output, 16384);
  assert.ok(!messages(recs).some((m) => m.response_id === 'api-feat-11'));
});

test('copilot-cli: session record: title, cwd, version, incarnation, client from workspace.yaml', () => {
  withCopy('features', (dir) => {
    const listed = adapter.list(storeOf(adapter, dir)).find((s) => s.session_id === A);
    assert.equal(listed.incarnation, fs.readFileSync(path.join(dir, events(A)), 'utf8').split('\n')[0].match(/"id":"([^"]+)"/)[1]);
  });
  const s = golden('features')[A].find((r) => r.type === 'session');
  assert.deepEqual([s.title, s.title_set_by, s.cwd, s.last_cwd, s.harness_version, s.client, s.mode, s.reuse],
    ['toyshop features', 'user', '/home/user/work/toyshop', '/home/user/work/toyshop/toyshop', '1.0.101', 'copilot-cli', 'plan', 'detected']);
  const vs = golden('vscode-host')['92b4b5fb-3d26-4492-9722-6d6e3bcaf8aa'].find((r) => r.type === 'session');
  assert.equal(vs.client, 'vscode', 'a VS Code-hosted session is harness copilot-cli, client vscode');
  const noWs = golden('pass2')['1c5a3d81-1fd7-4fe1-b497-10f1a281b323'].find((r) => r.type === 'session');
  assert.deepEqual([noWs.title, noWs.client], [null, null]);
});

test('copilot-cli: a sub-agent stays in the session with agent_id; its prompt is automated; image and summary parts', () => {
  const recs = golden('features')[A];
  const AG = '5ab0a6e0-0000-4000-8000-0000000000a6';
  const sub = messages(recs).filter((m) => m.agent_id === AG);
  assert.deepEqual(sub.map((m) => m.role).sort(), ['assistant', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(sub.find((m) => m.role === 'user').source, 'automated');
  assert.ok(messages(recs).filter((m) => m.role === 'user' && m.agent_id === '').every((m) => m.source === 'user'));
  assert.ok(!ofType(recs, 'link').some((l) => l.kind === 'subagent'), 'no subagent link: it lives in this file');
  const img = messages(recs).flatMap((m) => m.parts).find((p) => p.kind === 'attachment');
  assert.deepEqual([img.media_type, img.bytes_len, typeof img.inline], ['image/png', 29, 'string']);
  const sum = messages(recs).flatMap((m) => m.parts).find((p) => p.kind === 'summary');
  assert.deepEqual(sum.replaces, { count: 12 });
  // Compaction is not deletion: every message before the summary is still there.
  const before = messages(recs).filter((m) => m.order < messages(recs).find((x) => x.parts[0].kind === 'summary').order);
  assert.equal(before.length, 25);
  const cu = ofType(recs, 'usage').find((u) => u.anchor.compaction);
  assert.deepEqual([cu.input, cu.output, cu.cache_read, cu.granularity], [2100, 120, 1800, 'per_response']);
});

test('copilot-cli: an MCP call names its server; a notification is its text or a type/status line, never the native record', () => {
  const recs = golden('features')[A];
  const call = messages(recs).flatMap((m) => m.parts).find((p) => p.kind === 'tool_call' && p.call_id === 'chatcmpl-tool-feat-mcp');
  assert.deepEqual([call.name, call.server], ['skustock-sku_stock', 'skustock']);
  const notices = messages(recs).filter((m) => m.parts.some((p) => p.kind === 'notice')).map((m) => m.parts[0].text);
  assert.equal(notices.length, 2, 'a notification with neither text nor a type makes no record');
  assert.equal(notices[1], 'shell_completed ok');
  assert.ok(!JSON.stringify(recs).includes('a raw field that is no conversation'));
});

test('copilot-cli: an interrupted call: its message is released interrupted at the turn end, the finished call keeps its result', () => {
  const recs = golden('features')[A];
  const m = messages(recs).find((x) => x.response_id === 'api-feat-10');
  assert.equal(m.status, 'interrupted');
  const results = messages(recs).filter((x) => x.role === 'tool').map((x) => x.parts[0].call_id);
  assert.ok(results.includes('chatcmpl-tool-feat-a'));
  assert.ok(!results.includes('chatcmpl-tool-feat-b'));
});

// ---- held ---------------------------------------------------------------------------------------

test('copilot-cli: a running tool holds only its own message; its completion returns it in changed and live', () => {
  withCopy('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const out = lastDerive(e, H);
    const waiting = 'b0000000-0000-4000-8000-000000000005';
    assert.deepEqual(out.held.message, [waiting]);
    assert.ok(!out.live.message.includes(waiting));
    assert.ok(!out.changed.some((r) => r.type === 'message' && r.message_id === waiting));
    // A sub-agent wrote meanwhile: its messages are not held (memhouse held everything after).
    assert.equal(messages([...e.views()[H].values()]).filter((m) => m.agent_id !== '').length, 2);
    assert.equal(ofType([...e.views()[H].values()], 'usage').length, 2, 'the waiting reply\'s usage is written');

    const t = Date.UTC(2026, 9, 21, 14, 0, 30);
    const line = (n, type, data) => JSON.stringify({ type, data, id: `b0000000-0000-4000-8000-0000000001${n}`, timestamp: new Date(t + Number(n) * 1000).toISOString(), parentId: null });
    fs.appendFileSync(path.join(dir, events(H)), [
      line('01', 'tool.execution_complete', { toolCallId: 'chatcmpl-tool-Fixt00016', success: true, result: { content: 'It holds cart.py.' } }),
      line('02', 'assistant.turn_end', { turnId: '0' }),
    ].map((l) => l + '\n').join(''));
    e.pass();
    assert.deepEqual(e.log.filter((l) => l.session_id === H).map((l) => l.continuity), ['appended']);
    const next = lastDerive(e, H);
    assert.deepEqual(next.held.message, []);
    assert.ok(next.live.message.includes(waiting));
    const rel = next.changed.find((r) => r.type === 'message' && r.message_id === waiting);
    assert.deepEqual([rel.status, rel.parts.map((p) => p.kind)], ['complete', ['tool_call']]);
  });
});

// ---- lifecycle, reset and links -----------------------------------------------------------------

test('copilot-cli: a rewind (new inode, shorter file, appended session.info{rewind}) is a reset: a lifecycle record, and exactly the vanished keys go', () => {
  const dir = tmpStore();
  try {
    copyTree(path.join(FIX, 'rewind', 'before'), dir);
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const before = project(e.views())[R];
    const file = path.join(dir, events(R));
    fs.copyFileSync(path.join(FIX, 'rewind', 'store', events(R)), `${file}.rewind`);
    fs.renameSync(`${file}.rewind`, file);
    assert.ok(fs.statSync(file).size < fs.statSync(path.join(FIX, 'rewind', 'before', events(R))).size, 'the rewrite is shorter');
    e.pass();
    assert.equal(e.log.find((l) => l.source_key === events(R)).continuity, 'reset');
    const after = project(e.views())[R];
    assert.deepEqual(after, golden('rewind')[R]);
    assert.deepEqual(ofType(after, 'lifecycle').map((r) => [r.op, r.evidence]), [['rewind', 'explicit']]);
    // One incarnation: the rewrite keeps line 1.
    assert.equal(adapter.list(storeOf(adapter, dir))[0].incarnation, 'd0000000-0000-4000-8000-000000000001');
    const k = (r) => `${r.type}:${r.message_id ?? r.usage_id ?? r.lifecycle_id ?? ''}`;
    const kept = new Map(after.map((r) => [k(r), r]));
    const gone = before.filter((r) => !kept.has(k(r))).map(k).sort();
    assert.deepEqual(gone, [
      'message:d0000000-0000-4000-8000-000000000009', 'message:d0000000-0000-4000-8000-000000000012',
      'message:d0000000-0000-4000-8000-000000000014', 'message:d0000000-0000-4000-8000-000000000018',
      'usage:api-rw-2', 'usage:api-rw-3',
    ]);
    // A kept message is unchanged.
    for (const r of before) if (r.type === 'message' && kept.has(k(r))) assert.deepEqual(kept.get(k(r)), r);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copilot-cli: any shorter rewrite of events.jsonl is a reset, and the re-derive equals a full replay', () => {
  const r = rewriteCheck(adapter, path.join(FIX, 'basic', 'store'), events('8259ca5e-606a-43e3-8753-6d6b97ebb992'), 12);
  assert.equal(r.continuity, 'reset');
  assert.ok(r.equal);
});

test('copilot-cli: forks: the origin states each child, the child states its origin, a copied marker states nothing', () => {
  const g = golden('features');
  const origin = ofType(g[A], 'link');
  assert.deepEqual(origin.map((l) => [l.kind, l.stated_on, l.child.session_id, l.origin.session_id, l.at, l.evidence]).sort(), [
    ['fork', 'origin', C1, A, '', 'explicit'],
    ['fork', 'origin', C2, A, '', 'explicit'],
  ]);
  assert.equal(ofType(g[A], 'lifecycle').filter((r) => r.op === 'fork').length, 2, 'two forks in a row: two records');
  // The child copied the origin's first fork marker (naming C1), which is the origin's history.
  const child = ofType(g[C2], 'link');
  assert.deepEqual(child.map((l) => [l.kind, l.stated_on, l.child.session_id, l.origin.session_id]), [['fork', 'child', C2, A]]);
  assert.deepEqual(ofType(g[C2], 'lifecycle').filter((r) => r.op === 'fork').map((r) => r.lifecycle_id), ['c2000000-0000-4000-8000-000000000002']);
  assert.deepEqual(child[0].inherits, { through_message_id: null, ids_preserved: true, marked: false, usage_copied: true });
  // Copied events keep their ids, usage_records included: the consumer bills them once.
  const ids = (recs, type) => new Set(ofType(recs, type).map((r) => r.message_id ?? r.usage_id));
  for (const id of ids(g[A], 'message')) assert.ok(ids(g[C2], 'message').has(id), id);
  assert.equal([...ids(g[A], 'usage')].filter((id) => ids(g[C2], 'usage').has(id)).length, 12);
  // VS Code's agent host names the child and the event it forked before.
  const vs = ofType(golden('vscode-host')['92b4b5fb-3d26-4492-9722-6d6e3bcaf8aa'], 'link');
  assert.deepEqual(vs.map((l) => [l.stated_on, l.child.session_id]), [['origin', 'd1753871-734e-4ca5-8026-75182b7e3002']]);
});

test('copilot-cli: a reused --session-id is a new incarnation; the old one reads incarnation_gone', () => {
  const dir = tmpStore();
  try {
    copyTree(path.join(FIX, 'conformance-copilot-reuse', 'first'), dir);
    const store = storeOf(adapter, dir);
    const e = new MiniEngine(adapter, store);
    e.pass();
    const [first] = adapter.list(store);
    assert.equal(first.incarnation, '068bddb5-a920-46c5-a6e8-f950d2fa9084');
    // Deleted, then the id was used again: a fresh directory and file.
    fs.rmSync(path.join(dir, 'session-state', REUSE), { recursive: true });
    copyTree(path.join(FIX, 'conformance-copilot-reuse', 'store'), dir);
    const [second] = adapter.list(store);
    assert.equal(second.incarnation, '80797e76-f7a4-4f25-b73e-272e54d1e5b7');
    const key = { ...store, session_id: REUSE, incarnation: first.incarnation };
    assert.throws(() => adapter.read(store, key, events(REUSE)), { code: 'incarnation_gone' });
    assert.throws(() => adapter.read(store, key, events(REUSE), e.sessions.values().next().value.sources.get(events(REUSE)).position), { code: 'incarnation_gone' });
    e.pass();
    assert.deepEqual([...e.sessions.keys()], [`${REUSE}\u0000${second.incarnation}`]);
    assert.deepEqual(project(e.views()), golden('conformance-copilot-reuse'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- list, read, errors -------------------------------------------------------------------------

test('copilot-cli: list names each session directory with a born events.jsonl, and its workspace.yaml when there is one', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const sessions = adapter.list(store);
    assert.deepEqual(sessions.map((s) => s.session_id), [A, H, C2].sort());
    for (const s of sessions) {
      assert.equal(s.live, 'unknown');
      assert.deepEqual(s.sources[0], { source_key: events(s.session_id), role: 'main', mode: 'stream', position_kind: 'byte_offset' });
    }
    assert.deepEqual(sessions.find((s) => s.session_id === A).sources[1], { source_key: `session-state/${A}/workspace.yaml`, role: 'side', mode: 'snapshot', position_kind: 'snapshot' });
    assert.equal(sessions.find((s) => s.session_id === H).sources.length, 1);
    // Not sessions: a lock directory, a directory with no events.jsonl, a line 1 still partial,
    // a line 1 that is no session.start.
    const mk = (sid, text) => {
      fs.mkdirSync(path.join(dir, 'session-state', sid), { recursive: true });
      if (text !== null) fs.writeFileSync(path.join(dir, events(sid)), text);
    };
    fs.mkdirSync(path.join(dir, 'session-state', '.session-operation-locks'), { recursive: true });
    mk('11111111-1111-4111-8111-000000000001', null);
    mk('11111111-1111-4111-8111-000000000002', '{"type":"session.start","data":{},"id":"x');
    mk('11111111-1111-4111-8111-000000000003', '{"type":"user.message","data":{},"id":"x"}\n');
    assert.deepEqual(adapter.list(store).map((s) => s.session_id), [A, H, C2].sort());
    // The hint moves when a source grows.
    const before = sessions.find((s) => s.session_id === H).updated_hint;
    fs.appendFileSync(path.join(dir, events(H)), '\n');
    assert.notEqual(adapter.list(store).find((s) => s.session_id === H).updated_hint, before);
  });
});

test('copilot-cli: read: appended gives exactly the new lines; a partial last line is held back until whole; then unchanged', () => {
  withCopy('basic', (dir) => {
    const store = storeOf(adapter, dir);
    const [s] = adapter.list(store);
    const key = { ...store, session_id: s.session_id, incarnation: s.incarnation };
    const sk = events(s.session_id);
    const r1 = adapter.read(store, key, sk);
    assert.equal(r1.continuity, 'reset');
    assert.equal(r1.units.length, 45);
    const line = '{"type":"abort","data":{"reason":"user_abort"},"id":"0a000000-0000-4000-8000-000000000099","timestamp":"2026-10-19T23:00:00.000Z","parentId":null}';
    fs.appendFileSync(path.join(dir, sk), line.slice(0, 40));
    const r2 = adapter.read(store, key, sk, r1.position);
    assert.equal(r2.continuity, 'unchanged');
    assert.equal(r2.held_back.length, 1);
    fs.appendFileSync(path.join(dir, sk), line.slice(40) + '\n');
    const r3 = adapter.read(store, key, sk, r2.position);
    assert.equal(r3.continuity, 'appended');
    assert.deepEqual(r3.units.map((u) => u.body), [line]);
    assert.equal(adapter.read(store, key, sk, r3.position).continuity, 'unchanged');
    // workspace.yaml is a snapshot: whole when its sha moves.
    const wk = `session-state/${s.session_id}/workspace.yaml`;
    const w1 = adapter.read(store, key, wk);
    assert.equal(w1.units.length, 1);
    assert.equal(adapter.read(store, key, wk, w1.position).continuity, 'unchanged');
    fs.appendFileSync(path.join(dir, wk), 'user_named: true\n');
    assert.equal(adapter.read(store, key, wk, w1.position).continuity, 'snapshot');
  });
});

test('copilot-cli: errors: an unknown session, an unknown source, a deleted session', () => {
  withCopy('basic', (dir) => {
    const store = storeOf(adapter, dir);
    const [s] = adapter.list(store);
    const key = { ...store, session_id: s.session_id, incarnation: s.incarnation };
    assert.throws(() => adapter.read(store, { ...key, session_id: '11111111-1111-4111-8111-111111111111' }, events('11111111-1111-4111-8111-111111111111')), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, { ...key, session_id: '../x' }, 'session-state/../x/events.jsonl'), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, `session-state/${s.session_id}/plan.md`), { code: 'source_unknown' });
    fs.rmSync(path.join(dir, `session-state/${s.session_id}/workspace.yaml`));
    assert.throws(() => adapter.read(store, key, `session-state/${s.session_id}/workspace.yaml`), { code: 'source_unknown' });
    // `/session delete`: the directory goes; list omits it and read says session_unknown.
    fs.rmSync(path.join(dir, 'session-state', s.session_id), { recursive: true });
    assert.deepEqual(adapter.list(store), []);
    assert.throws(() => adapter.read(store, key, events(s.session_id)), { code: 'session_unknown' });
  });
});

test('copilot-cli: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'copilot-cli');
  assert.equal(d.model_version, 'sessions-model/1');
  assert.equal(d.facets.reuse, 'detected');
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
  // linkage.tool native: in every session, a call has at most one result, by call_id.
  for (const c of CASES) {
    for (const recs of Object.values(golden(c))) {
      const results = messages(recs).flatMap((m) => m.parts.filter((p) => p.kind === 'tool_result'));
      for (const p of messages(recs).flatMap((m) => m.parts.filter((x) => x.kind === 'tool_call'))) {
        assert.ok(results.filter((r) => r.call_id === p.call_id).length <= 1, p.call_id);
      }
    }
  }
});

test('copilot-cli: a tool_result carries the stored shellExecution.exitCode; a non-shell tool has none', () => {
  withCopy('features', (dir) => {
    const parts = messages(project(fullReplay(adapter, dir).views())[A]).flatMap((m) => m.parts).filter((p) => p.kind === 'tool_result');
    const byCall = Object.fromEntries(parts.map((p) => [p.call_id, p]));
    // `shellExecution: { exitCode: 1 }` beside the result text: the code is the field, not the text.
    assert.equal(byCall['chatcmpl-tool-feat-test'].exit_code, 1);
    assert.equal(byCall['chatcmpl-tool-feat-mcp'].exit_code, null);
  });
});

// sessions-model v1.x (#6), §2.3 (tool_result `is_error`): `is_error` copies the stored `success`
// flag. A flag that says success beside a shell's non-zero `exit_code` is unreliable for that
// result (Copilot CLI and Codex store `success: true` so): that result's `is_error` is null,
// `exit_code` carries the failure, and the other results keep the flag. It is never derived from
// the exit code or the text.
test('copilot-cli: is_error copies success; success true with a non-zero shell exit is null, and exit_code carries the failure', () => {
  const resultsOf = (dir, sid) => Object.fromEntries(messages(project(fullReplay(adapter, dir).views())[sid])
    .flatMap((m) => m.parts).filter((p) => p.kind === 'tool_result').map((p) => [p.call_id, [p.is_error, p.exit_code]]));
  withCopy('features', (dir) => {
    const r = resultsOf(dir, A);
    assert.deepEqual(r['chatcmpl-tool-feat-ls'], [false, 0], 'success true, exit 0');
    assert.deepEqual(r['chatcmpl-tool-feat-view'], [false, null], 'success true, no shell');
    assert.deepEqual(r['chatcmpl-tool-feat-mcp'], [false, null], 'success true, no shell');
    assert.deepEqual(r['chatcmpl-tool-feat-test'], [null, 1], 'success true, exit 1: the flag is contradicted');
    assert.deepEqual(r['chatcmpl-tool-feat-pip'], [true, null], 'success false (denied)');
    assert.deepEqual(r['chatcmpl-tool-feat-ask'], [true, null], 'success false');
    // A result whose event carries no `success` at all (the line edited in this copy): no flag, null.
    const file = path.join(dir, events(A));
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.includes('"tool.execution_complete"') && l.includes('chatcmpl-tool-feat-mcp'));
    lines[i] = lines[i].replace('"success":true,', '');
    fs.writeFileSync(file, lines.join('\n'));
    assert.deepEqual(resultsOf(dir, A)['chatcmpl-tool-feat-mcp'], [null, null], 'no success flag');
  });
  withCopy('basic', (dir) => {
    const r = resultsOf(dir, '8259ca5e-606a-43e3-8753-6d6b97ebb992');
    assert.deepEqual([r['chatcmpl-tool-FixtureFixt00024'], r['chatcmpl-tool-FixtureFixt00026']], [[null, 1], [null, 1]], 'success true, exit 1');
    assert.deepEqual([r['chatcmpl-tool-FixtureFixt00022'], r['chatcmpl-tool-FixtureFixt00027']], [[false, null], [false, null]]);
  });
});

test('copilot-cli: list omits a deleted session though session-store.db keeps its rows as orphans', () => {
  withCopy('basic', (dir) => {
    const store = storeOf(adapter, dir);
    const [s] = adapter.list(store);
    const key = { ...store, session_id: s.session_id, incarnation: s.incarnation };
    // Copilot's index beside session-state (spec §8): `/session delete` leaves its rows behind, and
    // it may hold rows for sessions this folder never had. Its columns, as the spec lists them.
    const ghost = '22222222-2222-4222-8222-222222222222';
    const db = new DatabaseSync(path.join(dir, 'session-store.db'));
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);'
      + ' CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);');
    for (const id of [s.session_id, ghost]) {
      db.prepare('INSERT INTO sessions (id, cwd, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, '/home/user/work/toyshop', 'toy', '2026-10-19T23:00:00.000Z', '2026-10-19T23:00:00.000Z');
      db.prepare('INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, 0, ?, ?, ?)').run(id, 'hi', 'hello', '2026-10-19T23:00:00.000Z');
    }
    db.close();
    assert.deepEqual(adapter.list(store).map((x) => x.session_id), [s.session_id], 'an index row with no session directory is no session');
    // `/session delete`: the directory goes, the index rows stay.
    fs.rmSync(path.join(dir, 'session-state', s.session_id), { recursive: true });
    assert.deepEqual(adapter.list(store), []);
    assert.throws(() => adapter.read(store, key, events(s.session_id)), { code: 'session_unknown' });
  });
});
