import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { adapterFor } from '../src/index.js';
import { SOURCE, DB_REL } from '../src/harnesses/goose/index.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, tmpStore, storeOf, nameLint } from '../conformance/runner.js';
import { prepareStore, sqlGrowthCheck } from '../conformance/sql-store.js';

const adapter = adapterFor('goose');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'goose');
const CASES = ['lab', 'features', 'conformance-goose-sentinel'];
const EXEMPT = adapter.describe().redaction.exemptions;
// The features case's sessions (fixtures/goose/generate.js).
const P = '20261020_5';
const C = '20261020_6';
const S1 = '20261021_1';
const S2 = '20261021_2';
const S3 = '20261021_3';
const S4 = '20261021_4';
const S5 = '20261021_5';
const F = '20261021_8';
const SENTINEL = 'sentinel-0a1b2c3d4e5f-not-a-secret';
const TOKENS = ['toysig-91c2e7a4b05d3f68', 'toyarg-7f3c9e2a51d84b06', 'toyurl-0c8b4e6f2a917d35', 'toyrecipe-5e1a7c903b2f'];

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
const usageOf = (recs, id) => recs.find((r) => r.type === 'usage' && r.usage_id === id);
const keyOf = (store, s) => ({ ...store, session_id: s.session_id, incarnation: s.incarnation });
// The full derive output of one session, as the engine's last pass saw it.
function lastDerive(e, sid) {
  for (const [id, s] of e.sessions) if (id.split('\u0000')[0] === sid) return s.last;
  return null;
}
// Every unit of a session's sources, read whole.
function unitsOf(dir, sid) {
  const store = storeOf(adapter, dir);
  const s = adapter.list(store).find((x) => x.session_id === sid);
  return s.sources.map((x) => ({ source_key: x.source_key, generation: 1, complete: true, units: adapter.read(store, keyOf(store, s), x.source_key).units, gone: [] }));
}
// A unit's value with its JSON text columns parsed, so the lint looks inside them.
const JSON_COLS = ['content_json', 'metadata_json', 'extension_data', 'recipe_json', 'user_recipe_values_json', 'model_config_json', 'system_prompt_extras_json'];
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
const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The declared exemptions, `[]` standing for any index; a list under an exempt name is exempt too.
const exemptRe = EXEMPT.map((e) => new RegExp(`(^|[.:])${e.split('[]').map(escape).join('\\[\\d+\\]')}(\\[\\d+\\])*$`));
const lint = (value, at) => nameLint(value, [], at).filter((h) => !exemptRe.some((re) => re.test(h)));
// A writer on a case's built database (the harness, in a test).
function writer(dir) {
  return new DatabaseSync(path.join(dir, DB_REL));
}

// ---- conformance --------------------------------------------------------------------------------

for (const name of CASES) {
  test(`goose/${name}: the full replay equals the reviewed golden`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), golden(name)));
  });

  test(`goose/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    for (const steps of [5, 12]) {
      const r = sqlGrowthCheck(adapter, path.join(FIX, name), { steps });
      assert.deepEqual(r.incremental, r.full);
      assert.ok(r.equal, 'content_sha differs between the incremental and the full view');
      assert.deepEqual(r.notUnchanged, []);
    }
  });

  test(`goose/${name}: keys are stable across a lost state`, () => {
    withStore(name, (dir) => {
      const a = project(fullReplay(adapter, dir).views());
      const b = project(fullReplay(adapter, dir).views());
      assert.deepEqual(a, b);
    });
  });

  test(`goose/${name}: no string under a secret-looking name in any unit (JSON columns included) or record`, () => {
    withStore(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) for (const u of src.units.values()) hits.push(...lint(deep(JSON.parse(u.body)), `${u.source_key}@${u.unit_key}:`));
        for (const r of s.view.values()) hits.push(...lint(r, `${r.type}:`));
      }
      assert.deepEqual(hits, []);
    });
  });
}

test('goose: the folded result does not depend on the order sources are given', () => {
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

test('goose: derive is pure: no file is opened, listed or stat-ed', () => {
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

test('goose: a turn: native ids, the result row a tool message claimed by call id, reasoning, ledger usage, served and requested model', () => {
  const recs = golden('features')[S1];
  const ids = ofType(recs, 'message').sort((a, b) => (a.order < b.order ? -1 : 1)).map((m) => m.message_id);
  assert.deepEqual(ids.slice(0, 7), ['msg_u1', 'msg_tc1', 'chatcmpl-a1', 'msg_elr', 'msg_el', 'msg_r1', 'chatcmpl-a2'], 'messages.message_id, never messages.id; the stored order, the elicitation response first');
  const a1 = msg(recs, 'chatcmpl-a1');
  assert.deepEqual(a1.parts.map((p) => [p.kind, p.part_id]), [['reasoning', '0'], ['tool_call', '1']]);
  assert.deepEqual([a1.requested_model, a1.served_model, a1.effort, a1.response_id], ['gateway/toy-model-a', 'gateway/toy-model', 'high', 'chatcmpl-a1'], 'served = the ledger row, requested = inference.requestedModel, effort per session');
  assert.deepEqual([a1.parts[1].call_id, a1.parts[1].name, a1.parts[1].server], ['call-1', 'shell', 'developer']);
  const r1 = msg(recs, 'msg_r1');
  assert.deepEqual([r1.role, r1.source, r1.parts[0].kind, r1.parts[0].call_id, r1.parts[0].is_error, r1.parts[0].status], ['tool', null, 'tool_result', 'call-1', true, 'completed'], 'a role-user result row is a tool message');
  const u = usageOf(recs, '14');
  assert.deepEqual([u.anchor, u.input, u.output, u.cache_read, u.input_includes_cache, u.output_includes_reasoning, u.granularity, u.model], [{ message_id: 'chatcmpl-a1' }, 5790, 50, 5120, null, null, 'per_response', 'gateway/toy-model'], 'usage from the ledger row of the same call');
  const tc = msg(recs, 'msg_tc1');
  assert.deepEqual([tc.role, tc.source, tc.to_user], ['user', 'injected', false], 'turn-context: injected, not shown to the user');
  const elr = msg(recs, 'msg_elr');
  assert.deepEqual([elr.role, elr.to_user, elr.parts[0].kind, elr.parts[0].text], ['user', false, 'notice', '[elicitationResponse] accept {"qty":25}']);
  assert.ok(msg(recs, 'msg_el').parts[0].text.startsWith('[elicitation] How many units'));
});

test('goose: parallel MCP calls: results in completion order go to their own calls; an image is an attachment; resource URIs are cut in read', () => {
  const recs = golden('features')[S1];
  const r2 = msg(recs, 'msg_r2');
  const results = r2.parts.filter((p) => p.kind === 'tool_result');
  assert.deepEqual(results.map((p) => [p.call_id, p.is_error]), [['call-label', false], ['call-stock', false], ['call-scan', true]]);
  assert.equal(results[0].output, 'label preview follows\n[resource_link file:///home/user/work/toyshop/label.png]\nSKU-42 wooden train, price 12.50');
  const img = r2.parts.find((p) => p.kind === 'attachment');
  assert.deepEqual([img.part_id, img.media_type, img.bytes_len], ['0:image:1', 'image/png', Buffer.from('PNG-TOY-LABEL-240x120').length]);
  assert.deepEqual(msg(recs, 'chatcmpl-a3').parts.map((p) => [p.call_id, p.server]), [['call-stock', 'python3'], ['call-scan', 'python3'], ['call-label', 'python3']]);
  const rl = msg(recs, 'msg_rl').parts[0];
  assert.equal(rl.output, `[resource_link https://toy-cdn.example]\n[resource <redacted len=${'toy:opaque?token='.length + TOKENS[0].length}>]\n[resource_link C:\\toys\\label.png]\n[resource_link toyshop/label.png]`);
  withStore('features', (dir) => {
    const units = unitsOf(dir, S1).find((x) => x.source_key === SOURCE.messages).units;
    const u = units.find((x) => JSON.parse(x.body).message_id === 'msg_rl');
    assert.equal(u.redacted, true);
    assert.ok(!units.some((x) => x.body.includes(TOKENS[0])), 'a token in a resource URI query never leaves read');
    // Every resource URI is on the declared path: the toy:// one in msg_r2 is cut too; file: stays.
    assert.deepEqual(units.filter((x) => x.redacted).map((x) => JSON.parse(x.body).message_id).sort(), ['msg_r2', 'msg_rl']);
    const r2 = JSON.parse(JSON.parse(units.find((x) => JSON.parse(x.body).message_id === 'msg_r2').body).content_json)[0].toolResult.value.content;
    assert.deepEqual([r2[2].uri, r2[3].resource.uri], ['file:///home/user/work/toyshop/label.png', 'toy://catalog']);
  });
});

test('goose: a running call is held with its usage; its result releases it; a later prompt ends it as interrupted', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const out = lastDerive(e, S4);
    assert.deepEqual(out.held.message, ['chatcmpl-t4']);
    assert.deepEqual(out.held.usage, ['33']);
    assert.ok(!out.live.message.includes('chatcmpl-t4') && !out.changed.some((r) => r.message_id === 'chatcmpl-t4'));
    assert.ok(out.live.message.includes('msg_t3'), 'only the waiting message is held, not the rows before it');
    const w = writer(dir);
    const T4 = Date.UTC(2026, 9, 21, 14, 0, 1) / 1000;
    const ins = w.prepare('INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?)');
    // A later row of another kind (a steer) does not end the turn: still held.
    ins.run('steer_0d1e2f30-4a5b-4c6d-8e7f-901a2b3c4d5e', S4, 'user', '[{"type":"text","text":"Only DUCK-07."}]', T4 + 203, '{"userVisible":true,"agentVisible":true,"steer":true}');
    e.pass();
    assert.deepEqual(lastDerive(e, S4).held.message, ['chatcmpl-t4']);
    // Its result lands: released, complete, with its usage.
    ins.run('msg_ts', S4, 'user', JSON.stringify([{ type: 'toolResponse', id: 'call-stock2', toolResult: { status: 'success', value: { content: [{ type: 'text', text: 'DUCK-07 12' }], isError: false } } }]), T4 + 204, '{"userVisible":true,"agentVisible":true}');
    e.pass();
    const next = lastDerive(e, S4);
    assert.deepEqual(next.held, { session: [], message: [], usage: [], link: [], lifecycle: [] });
    const t4 = next.changed.find((r) => r.message_id === 'chatcmpl-t4');
    assert.equal(t4.status, 'complete');
    assert.ok(next.changed.some((r) => r.type === 'usage' && r.usage_id === '33'));
    w.close();
  });
  // A crash (or an ACP fork taken mid-turn) leaves a call with no result; the next prompt ends the turn.
  withStore('features', (dir) => {
    const w = writer(dir);
    const T4 = Date.UTC(2026, 9, 21, 14, 0, 1) / 1000;
    w.prepare('INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run('msg_t5', S4, 'user', '[{"type":"text","text":"Never mind."}]', T4 + 300, '{"userVisible":true,"agentVisible":true}');
    w.close();
    const recs = project(fullReplay(adapter, dir).views())[S4];
    const t4 = msg(recs, 'chatcmpl-t4');
    assert.deepEqual([t4.status, t4.parts[0].kind], ['interrupted', 'tool_call']);
    assert.ok(usageOf(recs, '33'));
  });
});

test('goose: compaction: earlier rows flipped in place are to_model false (keys kept); the summary is a hidden system message; its call is a usage record', () => {
  const recs = golden('features')[S1];
  for (const id of ['msg_u1', 'chatcmpl-a1', 'msg_r2', 'chatcmpl-a5']) assert.deepEqual([msg(recs, id).to_user, msg(recs, id).to_model], [true, false], id);
  const s1 = msg(recs, 'chatcmpl-s1');
  assert.deepEqual([s1.role, s1.source, s1.to_user, s1.to_model, s1.parts[0].kind, s1.parts[0].replaces], ['system', 'automated', false, true, 'summary', { flags: { agentVisible: false } }]);
  assert.ok(!usageOf(recs, 'message:chatcmpl-s1#1'), 'the summary carries no usage');
  const lc = ofType(recs, 'lifecycle').find((r) => r.op === 'compaction');
  assert.deepEqual([lc.lifecycle_id, lc.target, lc.ts, lc.evidence], ['chatcmpl-s1', { range: { from_id: 'msg_u1', through_id: 'msg_c1' } }, '2026-10-21T13:02:05.000Z', 'explicit']);
  assert.deepEqual(usageOf(recs, '20').anchor, { compaction: 'chatcmpl-s1' });
  assert.deepEqual([usageOf(recs, '20').input, usageOf(recs, '20').output], [766, 3043]);
  assert.deepEqual([msg(recs, 'msg_cont').source, msg(recs, 'msg_cont').to_user], ['injected', false]);
  assert.deepEqual([msg(recs, 'msg_cc').role, msg(recs, 'msg_cc').source, msg(recs, 'msg_cc').to_model], ['assistant', 'system_notice', false]);
  // The flip arrives as a delta of the same keys: nothing is tombstoned.
  withStore('features', (dir) => {
    const w = writer(dir);
    w.exec("UPDATE messages SET metadata_json = json_set(metadata_json, '$.agentVisible', json('true')) WHERE session_id = '20261021_1'");
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const before = lastDerive(e, S1).live.message;
    w.exec(`UPDATE messages SET metadata_json = json_set(metadata_json, '$.agentVisible', json('false')) WHERE session_id = '20261021_1' AND created_timestamp < ${Date.UTC(2026, 9, 21, 13, 2, 0) / 1000}`);
    w.close();
    e.pass();
    assert.equal(e.log.find((l) => l.session_id === S1 && l.source_key === SOURCE.messages).continuity, 'delta');
    const out = lastDerive(e, S1);
    assert.deepEqual(out.live.message, before);
    assert.ok(out.changed.filter((r) => r.type === 'message').every((r) => r.to_model === false));
  });
});

// sessions-model v1.x proposal (#6), §2.3 (`tool_result.is_error`): `is_error` describes a call that
// completed. A declined call (`denied`), Ctrl-C during a shell call and a cancelled approval
// (`cancelled`) did not: their is_error is null, though goose stores `isError: true` on each, and
// the status carries the fact. A call that completed keeps `isError` (the positive control).
test('goose: is_error is null where the call did not complete: declined, Ctrl-C, a cancelled approval; a completed call keeps isError', () => {
  withStore('features', (dir) => {
    const views = project(fullReplay(adapter, dir).views());
    const results = (sid) => Object.fromEntries(ofType(views[sid], 'message').flatMap((m) => m.parts).filter((p) => p.kind === 'tool_result').map((p) => [p.call_id, [p.status, p.is_error, p.exit_code]]));
    const s2 = results(S2);
    assert.deepEqual([s2['call-rm'], s2['call-sleep'], s2['call-rm2']], [['denied', null, null], ['cancelled', null, null], ['cancelled', null, null]]);
    const s1 = results(S1);
    assert.deepEqual([s1['call-1'], s1['call-label'], s1['call-scan']], [['completed', true, 1], ['completed', false, null], ['completed', true, null]], 'isError true beside exit 1; no isError (false, as goose reads it); isError true');
  });
});

// sessions-model v1.x proposal (#6), §2.3 (`tool_result.is_error`): a flag that says success beside a
// shell's non-zero exit_code is unreliable for that result, so its is_error is null; the other
// results keep `isError`. Never derived from exit_code: `isError: true` beside exit 1 stays true.
// A result without `isError` has MCP's default, false (§2.3: a flag the harness store leaves out
// where its protocol defines a default has that default): false beside exit 0, null beside exit 1.
test('goose: is_error: isError false, or none, beside a non-zero structuredContent.exit_code is null; isError true beside it stays true', () => {
  withStore('features', (dir) => {
    const resultOf = () => ofType(project(fullReplay(adapter, dir).views())[S1], 'message').flatMap((m) => m.parts)
      .filter((p) => p.kind === 'tool_result' && p.call_id === 'call-1').map((p) => [p.status, p.is_error, p.exit_code]);
    assert.deepEqual(resultOf(), [['completed', true, 1]], 'isError true beside exit 1: the flag says failure');
    // Edited in this copy: call-1's result says isError false, then carries no isError.
    const edit = (fn) => {
      const w = writer(dir);
      for (const row of w.prepare("SELECT id, content_json FROM messages WHERE session_id = ? AND content_json LIKE '%\"toolResponse\"%' AND content_json LIKE '%\"call-1\"%'").all(S1)) {
        const content = JSON.parse(row.content_json);
        for (const p of content) if (p.type === 'toolResponse' && p.id === 'call-1') fn(p.toolResult.value);
        w.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(JSON.stringify(content), row.id);
      }
      w.close();
    };
    edit((v) => { v.isError = false; });
    assert.deepEqual(resultOf(), [['completed', null, 1]], 'isError false beside exit 1: unreliable for this result');
    edit((v) => { delete v.isError; });
    assert.deepEqual(resultOf(), [['completed', null, 1]], 'no isError beside exit 1');
    edit((v) => { v.structuredContent.exit_code = 0; });
    assert.deepEqual(resultOf(), [['completed', false, 0]], 'no isError, exit 0');
  });
});

test('goose: statuses: a declined call is denied, Ctrl-C and a cancelled approval are cancelled; errors, a cut reply, the output-token limit', () => {
  const recs = golden('features')[S2];
  const result = (call) => ofType(recs, 'message').flatMap((m) => m.parts).find((p) => p.kind === 'tool_result' && p.call_id === call);
  assert.deepEqual([result('call-rm').status, result('call-rm').is_error], ['denied', null]);
  assert.equal(result('call-sleep').status, 'cancelled', 'Ctrl-C during a shell call: (no output), no exit code');
  assert.equal(result('call-rm2').status, 'cancelled', 'Cancel in the approval prompt: interrupted before completing');
  const conf = msg(recs, 'msg_conf');
  assert.deepEqual([conf.role, conf.source, conf.to_user, conf.parts[0].text], ['assistant', 'system_notice', true, '[toolConfirmation] shell {"command":"rm README.md"}']);
  const err = msg(recs, 'msg_err');
  assert.deepEqual([err.status, err.parts[0].kind, err.parts[0].error_kind, err.requested_model], ['error', 'error', 'other', null]);
  const part = msg(recs, 'chatcmpl-part');
  assert.deepEqual([part.status, part.requested_model, part.served_model], ['interrupted', 'gateway/toy-model-a', null], 'a reply cut by Ctrl-C has no usage and no ledger row');
  assert.ok(!ofType(recs, 'usage').some((u) => u.anchor.message_id === 'chatcmpl-part'));
  const otl = msg(recs, 'chatcmpl-otl');
  assert.deepEqual([otl.status, otl.parts, otl.served_model], ['interrupted', [], 'gateway/toy-model']);
  assert.equal(usageOf(recs, '26').input, 3953, 'an empty reply keeps its usage');
});

test('goose: session record: title, created (UTC), archived (RFC 3339 ns) with its lifecycle record, kind, mode; goose-written user turns', () => {
  const recs = golden('features')[S3];
  const s = ofType(recs, 'session')[0];
  assert.deepEqual([s.title, s.title_set_by, s.cwd, s.created_at, s.updated_at, s.state, s.kind, s.mode, s.reuse, s.ts_source, s.incarnation],
    ['gs3-effort', 'user', '/home/user/work/toyshop', '2026-10-21T13:16:32.000Z', null, 'archived', 'user', 'smart_approve', 'undetectable', 'seconds', '2026-10-21 13:16:32']);
  const a = ofType(recs, 'lifecycle')[0];
  assert.deepEqual([a.op, a.target, a.ts, a.evidence], ['archive', { session: true }, '2026-10-21T13:42:16.664Z', 'explicit']);
  assert.deepEqual([msg(recs, 'msg_g1').source, msg(recs, 'msg_g1').to_user], ['automated', false], 'a goal kick-off is a goose-written user turn');
  assert.equal(msg(recs, 'msg_g2').source, 'automated');
  assert.equal(msg(recs, 'msg_replay').source, 'automated', 'the compaction replay of the prompt');
  assert.deepEqual([msg(recs, 'steer_f446f645-132f-466d-bd9c-1966ddcccd88').source, msg(recs, 'steer_f446f645-132f-466d-bd9c-1966ddcccd88').to_user], ['steering', true]);
  // Unarchived: archived_at NULL again; the record goes and the state is active.
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const w = writer(dir);
    w.prepare('UPDATE sessions SET archived_at = NULL WHERE id = ?').run(S3);
    w.close();
    e.pass();
    const out = lastDerive(e, S3);
    assert.deepEqual(out.live.lifecycle, []);
    assert.equal(out.changed.find((r) => r.type === 'session').state, 'active');
  });
});

test('goose: sub-agents: the child states its parent, the parent the child it was delivered; the delegated prompt is automated', () => {
  const g = golden('features');
  const childLink = ofType(g[C], 'link')[0];
  assert.deepEqual([childLink.kind, childLink.stated_on, childLink.origin, childLink.at, childLink.evidence], ['subagent', 'child', { harness: 'goose', session_id: P }, '', 'explicit']);
  assert.equal(ofType(g[C], 'session')[0].kind, 'sub_agent');
  assert.equal(ofType(g[C], 'message').find((m) => m.order === '00000000').source, 'automated');
  assert.equal(msg(g[C], 'chatcmpl-fo').parts[0].server, null, 'no extension named: no server');
  const parentLink = ofType(g[P], 'link')[0];
  assert.deepEqual([parentLink.stated_on, parentLink.child, parentLink.at], ['origin', { harness: 'goose', session_id: C }, '']);
  assert.deepEqual([msg(g[P], 'msg_done').source, msg(g[P], 'msg_done').to_user], ['injected', false]);
  assert.deepEqual([msg(g[P], 'chatcmpl-del').parts[0].server, usageOf(g[P], '12').cost], ['summon', 0.000160716], 'a priced ledger row keeps its cost');
  // The lab capture: a sub-agent session with its parent.
  assert.deepEqual(ofType(golden('lab')['20261019_2'], 'link')[0].origin, { harness: 'goose', session_id: '20261019_1' });
});

test('goose: redaction: the extension env sentinel is <redacted len=34> on its path and nowhere else; the free-text sentinel stays (§4.6)', () => {
  assert.equal(Buffer.byteLength(SENTINEL, 'utf8'), 34);
  withStore('conformance-goose-sentinel', (dir) => {
    for (const sid of ['20261021_9', '20261021_10']) {
      const input = unitsOf(dir, sid);
      const sess = input.find((x) => x.source_key === SOURCE.session).units[0];
      assert.equal(sess.redacted, true);
      assert.ok(!sess.body.includes(SENTINEL));
      const row = JSON.parse(sess.body).sessions[0];
      const ext = JSON.parse(row.extension_data)['enabled_extensions.v0'].extensions;
      assert.deepEqual(ext.find((x) => x.name === 'rf4sentinel').envs, { RF4_SENTINEL_TOKEN: '<redacted len=34>' }, 'the value is the marker; the key name stays');
      assert.equal(ext.find((x) => x.name === 'rf4sentinel').cmd, '/bin/true');
      assert.equal(ext.length, 9, 'every extension kept, in the stored order');
    }
    const recs = project(fullReplay(adapter, dir).views());
    assert.ok(!JSON.stringify(recs['20261021_9']).includes(SENTINEL));
    // The sentinel capture's free-text message and its echo: out of reach of field paths.
    assert.ok(msg(recs['20261021_10'], 'msg_4529c054-7cae-44c7-89b0-07890b209751').parts[0].text.includes(SENTINEL));
    assert.ok(msg(recs['20261021_10'], 'chatcmpl-FixtureFixt00068').parts[0].text.includes(SENTINEL));
    const msgUnits = unitsOf(dir, '20261021_10').find((x) => x.source_key === SOURCE.messages).units;
    assert.ok(msgUnits.every((u) => !u.redacted) && msgUnits.some((u) => u.body.includes(SENTINEL)));
    assert.equal(usageOf(recs['20261021_10'], '142').input, 3968, 'usage counters survive');
  });
});

test('goose: redaction: extension args, headers, URLs, a cmd with its args, unknown fields, recipe values; nothing else changes', () => {
  withStore('features', (dir) => {
    const input = unitsOf(dir, S5);
    const body = input.find((x) => x.source_key === SOURCE.session).units[0].body;
    for (const t of TOKENS) assert.ok(!body.includes(t), `${t.slice(0, 8)}… is not in the unit`);
    const row = JSON.parse(body).sessions[0];
    const ext = JSON.parse(row.extension_data)['enabled_extensions.v0'].extensions;
    const x = (n) => ext.find((e) => e.name === n);
    assert.deepEqual(x('toyhttp').headers, { 'X-Toy-Header': '<redacted len=16>' });
    assert.equal(x('toyhttp').uri, 'http://localhost', 'a URL keeps scheme://host only');
    assert.deepEqual(x('toyargs').args, ['<redacted len=2>', '<redacted len=7>', `<redacted len=${'--token='.length + TOKENS[1].length}>`], 'every args element');
    assert.deepEqual([x('toyargs').cmd, x('toyargs').env_keys], ['npx', ['TOY_SHOP_KEY']], 'a plain command and env var NAMES stay');
    assert.equal(x('toysse').uri, 'https://toy-mcp.example');
    assert.match(x('toycmd').cmd, /^<redacted len=\d+>$/, 'a cmd with its args folded in is redacted whole');
    assert.match(x('toypy').code, /^<redacted len=\d+>$/, 'a field not known to be harmless is redacted');
    assert.deepEqual(ext.map((e) => e.name), ['developer', 'toyhttp', 'toyargs', 'toysse', 'toycmd', 'toypy', 'summon'], 'the stored order');
    const recipe = JSON.parse(row.recipe_json);
    assert.deepEqual([recipe.extensions[0].envs, recipe.parameters[0].default, recipe.sub_recipes[0].values, recipe.parameters[0].key],
      [{ TOY_LEVEL: '<redacted len=7>' }, `<redacted len=${TOKENS[3].length}>`, { shop_key: `<redacted len=${TOKENS[3].length}>` }, 'shop_key']);
    assert.deepEqual(JSON.parse(row.user_recipe_values_json), { shop_key: `<redacted len=${TOKENS[3].length}>`, shelf: '<redacted len=3>' }, 'every recipe value, keys kept');
    // A session with nothing on a declared path is returned byte for byte, and not marked.
    const plain = unitsOf(dir, S2).find((x2) => x2.source_key === SOURCE.session).units[0];
    assert.equal(plain.redacted, false);
    const recs = project(fullReplay(adapter, dir).views());
    for (const t of TOKENS) assert.ok(!JSON.stringify(recs).includes(t));
    // An extension_data that does not parse cannot be walked: withheld whole.
    const w = writer(dir);
    w.prepare('UPDATE sessions SET extension_data = ? WHERE id = ?').run(`{"enabled_extensions.v0": "${TOKENS[1]}`, S5);
    w.close();
    const bad = JSON.parse(unitsOf(dir, S5).find((x2) => x2.source_key === SOURCE.session).units[0].body).sessions[0];
    assert.match(bad.extension_data, /^<redacted len=\d+>$/);
  });
});

test('goose: redaction: an extension config outside an `extensions` list (a top-level array, a nested map) is redacted as an extension', () => {
  const TOK = 'sentinel-goose-ext-cmd-not-a-secret';
  const cfg = { name: 'pkg', cmd: `sh -c ${TOK}`, args: ['--token', TOK] };
  withStore('features', (dir) => {
    const w = writer(dir);
    w.prepare('UPDATE sessions SET extension_data = ?, recipe_json = ? WHERE id = ?').run(JSON.stringify([cfg]), JSON.stringify({ mcp: { pkg: cfg } }), S2);
    w.close();
    const input = unitsOf(dir, S2);
    for (const src of input) for (const u of src.units) assert.ok(!u.body.includes(TOK), `the sentinel is not in ${src.source_key}@${u.unit_key}`);
    const sess = input.find((x) => x.source_key === SOURCE.session).units[0];
    assert.equal(sess.redacted, true);
    const row = JSON.parse(sess.body).sessions[0];
    const [ext] = JSON.parse(row.extension_data);
    assert.equal(ext.name, 'pkg', 'the name stays');
    assert.match(ext.cmd, /^<redacted len=\d+>$/, 'a cmd with its args folded in is redacted whole');
    assert.deepEqual(ext.args, ['<redacted len=7>', `<redacted len=${TOK.length}>`], 'every args element');
    assert.match(JSON.parse(row.recipe_json).mcp.pkg.cmd, /^<redacted len=\d+>$/);
    assert.ok(!JSON.stringify(project(fullReplay(adapter, dir).views())).includes(TOK));
  });
});

test('goose: copied usage: a fork copy with metadata.usage and no ledger row is billed where it was made', () => {
  const recs = golden('features')[F];
  for (const id of ['chatcmpl-a1', 'chatcmpl-a2']) {
    assert.ok(!ofType(recs, 'usage').some((u) => u.anchor.message_id === id), `${id}: no usage on the copy`);
    assert.deepEqual([msg(recs, id).status, msg(recs, id).requested_model, msg(recs, id).served_model], ['complete', 'gateway/toy-model-a', null]);
  }
  assert.equal(usageOf(recs, '29').input, 6100, 'the session\'s own call keeps its ledger usage');
  // The rule's one outside input is the first-ledger unit: with none (an older goose with no
  // ledger), or one after the copies (an upgraded store), metadata.usage is the usage.
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.session_id === F);
    const input = unitsOf(dir, F);
    const withFirst = (rows) => input.map((x) => (x.source_key !== SOURCE.first ? x : { ...x, units: [{ ...x.units[0], body: JSON.stringify({ usage_ledger: rows }) }] }));
    const usages = (out) => out.changed.filter((r) => r.type === 'usage').map((r) => r.usage_id).sort();
    assert.deepEqual(usages(adapter.derive(keyOf(store, s), input, null)), ['29']);
    assert.deepEqual(usages(adapter.derive(keyOf(store, s), withFirst([]), null)), ['29', 'message:chatcmpl-a1#1', 'message:chatcmpl-a2#1']);
    const later = Date.UTC(2026, 9, 21, 13, 0, 9) / 1000 + 100;
    assert.deepEqual(usages(adapter.derive(keyOf(store, s), withFirst([{ created_timestamp: later }]), null)), ['29', 'message:chatcmpl-a1#1', 'message:chatcmpl-a2#1']);
  });
});

test('goose: a truncate deletes rows: delta with gone, the vanished keys go; the ledger rows it leaves are session usage records', () => {
  const recs = golden('features')[S4];
  assert.deepEqual(ofType(recs, 'message').map((m) => m.message_id).sort(), ['chatcmpl-t1', 'msg_t1', 'msg_t3']);
  assert.deepEqual(['31', '32'].map((id) => [usageOf(recs, id).anchor, usageOf(recs, id).input]), [[{ session: true }, 4100], [{ session: true }, 4200]]);
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const w = writer(dir);
    w.prepare('DELETE FROM messages WHERE session_id = ? AND message_id = ?').run(S4, 'msg_t3');
    w.close();
    e.pass();
    const l = e.log.find((x) => x.session_id === S4 && x.source_key === SOURCE.messages);
    assert.equal(l.continuity, 'delta');
    assert.ok(!lastDerive(e, S4).live.message.includes('msg_t3'));
    assert.deepEqual(project(e.views())[S4], project(fullReplay(adapter, dir).views())[S4]);
  });
});

test('goose: --edit re-mints rowids: the same keys and records; an id reused after a delete is a new incarnation', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const before = project(fullReplay(adapter, dir).views());
    const w = writer(dir);
    w.exec(`CREATE TEMP TABLE keep AS SELECT * FROM messages WHERE session_id = '${S2}';
      DELETE FROM messages WHERE session_id = '${S2}';
      INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, timestamp, tokens, metadata_json)
        SELECT message_id, session_id, role, content_json, created_timestamp, timestamp, tokens, metadata_json FROM keep ORDER BY id;`);
    assert.deepEqual(project(fullReplay(adapter, dir).views())[S2], before[S2], 'keys are message_id, never messages.id');
    // Delete 20261021_2 and create it again (the max N is reused): a new incarnation.
    const old = adapter.list(store).find((s) => s.session_id === S2);
    w.exec(`DELETE FROM messages WHERE session_id = '${S2}'; DELETE FROM usage_ledger WHERE session_id = '${S2}'; DELETE FROM sessions WHERE id = '${S2}';`);
    w.prepare("INSERT INTO sessions (id, name, working_dir, created_at) VALUES (?, 'second life', '/home/user/work/toyshop', '2026-10-21 16:00:00')").run(S2);
    w.close();
    const now = adapter.list(store).find((s) => s.session_id === S2);
    assert.deepEqual([old.incarnation, now.incarnation], ['2026-10-21 13:19:58', '2026-10-21 16:00:00']);
    assert.throws(() => adapter.read(store, keyOf(store, old), SOURCE.messages), { code: 'incarnation_gone' });
    assert.equal(adapter.read(store, keyOf(store, now), SOURCE.messages).units.length, 0);
  });
});

test('goose: ids: a NULL message_id is anchored on the previous native id; a repeated message id and a repeated call id are `<id>+n`', () => {
  const sk = SOURCE.messages;
  const row = (id, mid, role, t, content, meta = {}) => ({ source_key: sk, unit_key: `messages:${id}`, enc: 'row-json', body: JSON.stringify({ id, message_id: mid, role, created_timestamp: t, content_json: JSON.stringify(content), metadata_json: JSON.stringify({ userVisible: true, agentVisible: true, ...meta }) }) });
  const call = (id) => ({ type: 'toolRequest', id, toolCall: { status: 'success', value: { name: 'shell', arguments: {} } } });
  const result = (id, text) => ({ type: 'toolResponse', id, toolResult: { status: 'success', value: { content: [{ type: 'text', text }] } } });
  const inf = { inference: { provider: 'openai', requestedModel: 'm' } };
  const units = [
    row(1, 'msg_a', 'user', 10, [{ type: 'text', text: 'one' }]),
    row(2, null, 'assistant', 11, [call('call_0')], inf),
    row(3, null, 'user', 12, [result('call_0', 'first')]),
    row(4, 'msg_a', 'user', 13, [{ type: 'text', text: 'one again' }]),
    row(5, 'chatcmpl-x', 'assistant', 14, [call('call_0')], inf),
    row(6, 'msg_r', 'user', 15, [result('call_0', 'second')]),
  ];
  const session = { host: 'h', harness: 'goose', harness_path: '/x', session_id: '20261022_1', incarnation: '2026-10-22 00:00:00' };
  const sessUnit = { source_key: SOURCE.session, unit_key: SOURCE.session, enc: 'rows-json', body: JSON.stringify({ sessions: [{ id: '20261022_1', name: '', working_dir: '/w', created_at: '2026-10-22 00:00:00', session_type: 'user' }] }) };
  const out = adapter.derive(session, [{ source_key: SOURCE.session, generation: 1, complete: true, units: [sessUnit], gone: [] }, { source_key: sk, generation: 1, complete: true, units, gone: [] }], null);
  const msgs = out.changed.filter((r) => r.type === 'message').sort((a, b) => (a.order < b.order ? -1 : 1));
  assert.deepEqual(msgs.map((m) => m.message_id), ['msg_a', 'msg_a+1', 'msg_a+2', 'msg_a+3', 'chatcmpl-x', 'msg_r']);
  assert.deepEqual(msgs.flatMap((m) => m.parts).map((p) => [p.kind, p.call_id]), [['text', undefined], ['tool_call', 'call_0'], ['tool_result', 'call_0'], ['text', undefined], ['tool_call', 'call_0+1'], ['tool_result', 'call_0+1']]);
  assert.equal(msgs[5].parts[0].output, 'second');
});

// sessions-model §1 rule 4: an anchored key names a position after its anchor. A reply truncated
// and regrown under the same anchor takes the same key, revised; it is never two messages.
test('goose: anchored ids: a reply regrown under its surviving anchor keeps its `<id>+n` key, revised, never two messages', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const reply = (text) => {
      const w = writer(dir);
      w.prepare("INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, timestamp, tokens, metadata_json) VALUES (NULL, ?, 'assistant', ?, 1761040000, 1761040000, NULL, ?)")
        .run(S4, JSON.stringify([{ type: 'text', text }]), JSON.stringify({ userVisible: true, agentVisible: true }));
      w.close();
    };
    const anchored = () => ofType([...e.views()[S4].values()], 'message').filter((m) => m.message_id.includes('+'));
    reply('the first try');
    e.pass();
    const [first] = anchored();
    assert.ok(first && anchored().length === 1, 'one anchored reply');
    const count = ofType([...e.views()[S4].values()], 'message').length;
    // Truncate the reply and regrow it: the anchor survives, so the key does too.
    const w = writer(dir);
    w.prepare('DELETE FROM messages WHERE session_id = ? AND message_id IS NULL').run(S4);
    w.close();
    reply('the second try');
    e.pass();
    const [second] = anchored();
    assert.equal(anchored().length, 1);
    assert.equal(second.message_id, first.message_id);
    assert.notEqual(second.cmp_sha, first.cmp_sha);
    assert.notEqual(second.content_sha, first.content_sha);
    assert.deepEqual(second.parts.map((p) => p.text), ['the second try']);
    assert.equal(ofType([...e.views()[S4].values()], 'message').length, count, 'revised, not added');
    assert.deepEqual(project(e.views())[S4], project(fullReplay(adapter, dir).views())[S4]);
  });
});

test('goose: anchored ids: a reply regrown under a new anchor gets a new key; the cut reply\'s key and its anchor are gone', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const turn = (uid, prompt, answer) => {
      const w = writer(dir);
      const ins = w.prepare('INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, timestamp, tokens, metadata_json) VALUES (?, ?, ?, ?, 1761040000, 1761040000, NULL, ?)');
      const meta = JSON.stringify({ userVisible: true, agentVisible: true });
      ins.run(uid, S4, 'user', JSON.stringify([{ type: 'text', text: prompt }]), meta);
      ins.run(null, S4, 'assistant', JSON.stringify([{ type: 'text', text: answer }]), meta);
      w.close();
    };
    const ids = () => ofType([...e.views()[S4].values()], 'message').map((m) => m.message_id);
    turn('msg_anchor_a', 'first prompt', 'first answer');
    e.pass();
    assert.ok(ids().includes('msg_anchor_a+1'));
    const count = ids().length;
    // Truncate the turn, user message included, and regrow it: the anchor is new, so the key is.
    const w = writer(dir);
    w.prepare("DELETE FROM messages WHERE session_id = ? AND (message_id = 'msg_anchor_a' OR message_id IS NULL)").run(S4);
    w.close();
    turn('msg_anchor_b', 'second prompt', 'second answer');
    e.pass();
    const now = ids();
    assert.ok(!now.includes('msg_anchor_a') && !now.includes('msg_anchor_a+1'), 'the cut keys are gone');
    assert.ok(now.includes('msg_anchor_b') && now.includes('msg_anchor_b+1'));
    assert.equal(now.length, count);
    assert.deepEqual(project(e.views())[S4], project(fullReplay(adapter, dir).views())[S4]);
  });
});

// ---- list and read --------------------------------------------------------------------------------

test('goose: list names every sessions row, its incarnation and its four sources; the hint moves with this session only', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const sessions = adapter.list(store);
    assert.deepEqual(sessions.map((s) => s.session_id), ['20261020_14', P, C, S1, S2, S3, S4, S5, '20261021_6', F]);
    assert.deepEqual(adapter.list(store), sessions, 'list is stable');
    const s1 = sessions.find((s) => s.session_id === S1);
    assert.deepEqual([s1.incarnation, s1.live], ['2026-10-21 12:59:58', 'unknown']);
    assert.deepEqual(s1.sources.map((x) => [x.source_key, x.role, x.mode, x.position_kind]), [
      ['sessions/sessions.db#table:messages', 'main', 'delta', 'rowid'],
      ['sessions/sessions.db#table:sessions', 'side', 'snapshot', 'snapshot'],
      ['sessions/sessions.db#table:usage_ledger', 'side', 'delta', 'rowid'],
      ['sessions/sessions.db#table:usage_ledger@first', 'side', 'snapshot', 'snapshot'],
    ]);
    const hint = (sid) => adapter.list(store).find((s) => s.session_id === sid).updated_hint;
    const w = writer(dir);
    // Goose is running: a WAL writer that has not checkpointed. Its rows are read.
    w.exec('PRAGMA wal_autocheckpoint = 0');
    const h0 = hint(S1);
    const h2 = hint(S2);
    w.prepare("INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES ('msg_more', ?, 'user', '[{\"type\":\"text\",\"text\":\"More.\"}]', 1793019900, '{}')").run(S2);
    assert.ok(fs.existsSync(path.join(dir, `${DB_REL}-wal`)));
    assert.equal(hint(S1), h0, 'a write to another session leaves this hint');
    assert.notEqual(hint(S2), h2, 'a new message');
    assert.ok(adapter.read(store, keyOf(store, sessions.find((s) => s.session_id === S2)), SOURCE.messages).units.some((u) => u.body.includes('msg_more')), 'a WAL-only row is read');
    const steps = [
      ["UPDATE messages SET metadata_json = json_set(metadata_json, '$.agentVisible', json('true')) WHERE message_id = 'msg_u1' AND session_id = '20261021_1'", 'an agentVisible flip in place'],
      ["INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens) VALUES ('20261021_1', 1793019905, 'm', 1, 1)", 'a ledger row landing after its message'],
      ["UPDATE sessions SET name = 'renamed' WHERE id = '20261021_1'", 'a rename'],
    ];
    let prev = h0;
    for (const [sql, why] of steps) {
      w.exec(sql);
      const h = hint(S1);
      assert.notEqual(h, prev, why);
      prev = h;
    }
    w.close();
  });
});

test('goose: read: delta sources diff against known (unchanged, then a changed and a gone unit); snapshots compare by sha', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.session_id === S2);
    const key = keyOf(store, s);
    const r1 = adapter.read(store, key, SOURCE.messages);
    assert.equal(r1.continuity, 'reset');
    assert.ok(r1.units.every((u) => u.enc === 'row-json' && /^messages:\d+$/.test(u.unit_key)));
    const known = Object.fromEntries(r1.units.map((u) => [u.unit_key, u.sha256]));
    assert.equal(adapter.read(store, key, SOURCE.messages, r1.position, known).continuity, 'unchanged');
    const sn = adapter.read(store, key, SOURCE.session);
    assert.equal(sn.units[0].enc, 'rows-json');
    assert.equal(adapter.read(store, key, SOURCE.session, sn.position).continuity, 'unchanged');
    const w = writer(dir);
    w.exec(`UPDATE messages SET content_json = '[{"type":"text","text":"Delete README.md now."}]' WHERE message_id = 'msg_p1'; DELETE FROM messages WHERE message_id = 'msg_p5';`);
    w.exec(`UPDATE sessions SET goose_mode = 'chat' WHERE id = '${S2}'`);
    w.close();
    const r2 = adapter.read(store, key, SOURCE.messages, r1.position, known);
    assert.equal(r2.continuity, 'delta');
    assert.deepEqual(r2.units.map((u) => JSON.parse(u.body).message_id), ['msg_p1']);
    assert.equal(r2.gone.length, 1);
    assert.equal(adapter.read(store, key, SOURCE.session, sn.position).continuity, 'snapshot');
  });
});

test('goose: a WAL store with no -wal is read immutable: list and read create nothing beside the database', () => {
  withStore('features', (dir) => {
    const folder = path.join(dir, 'sessions');
    const before = fs.readdirSync(folder).sort();
    assert.deepEqual(before, ['sessions.db']);
    project(fullReplay(adapter, dir).views());
    assert.deepEqual(fs.readdirSync(folder).sort(), before);
  });
});

test('goose: a locked store (goose mid-save) is busy in list and read, never fewer rows; once free, the same records', () => {
  withStore('conformance-goose-sentinel', (dir) => {
    const file = path.join(dir, DB_REL);
    const w = writer(dir);
    w.exec('PRAGMA journal_mode = DELETE'); // a rollback-journal copy: a write lock there blocks readers
    const store = storeOf(adapter, dir);
    const full = project(fullReplay(adapter, dir).views());
    const s = adapter.list(store)[0];
    w.exec('BEGIN EXCLUSIVE');
    try {
      assert.throws(() => adapter.list(store), { code: 'busy' });
      assert.throws(() => adapter.read(store, keyOf(store, s), SOURCE.messages), { code: 'busy' });
    } finally {
      w.exec('ROLLBACK');
      w.close();
    }
    assert.ok(fs.existsSync(file));
    assert.deepEqual(project(fullReplay(adapter, dir).views()), full);
  });
});

test('goose: damaged: a corrupt page, a row whose JSON does not parse, a file that is no database; only a missing table reads as empty', () => {
  withStore('conformance-goose-sentinel', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.session_id === '20261021_10');
    const key = keyOf(store, s);
    for (const col of ['content_json', 'metadata_json']) {
      const w = writer(dir);
      const orig = w.prepare(`SELECT ${col} AS v FROM messages WHERE id = 511`).get().v;
      w.prepare(`UPDATE messages SET ${col} = ? WHERE id = 511`).run('[{"type":"text","text":"cut');
      w.close();
      assert.throws(() => adapter.read(store, key, SOURCE.messages), { code: 'damaged' }, `unparseable ${col}`);
      const w2 = writer(dir);
      w2.prepare(`UPDATE messages SET ${col} = ? WHERE id = 511`).run(orig);
      w2.close();
    }
    assert.equal(adapter.read(store, key, SOURCE.messages).units.length, 2);
    // Overwrite the header of the messages table's first page: its page type and cell count are garbage.
    const w = writer(dir);
    w.exec('PRAGMA journal_mode = DELETE');
    const { root } = w.prepare("SELECT rootpage AS root FROM sqlite_master WHERE name = 'messages'").get();
    const size = Number(w.prepare('PRAGMA page_size').get().page_size);
    w.close();
    const fd = fs.openSync(path.join(dir, DB_REL), 'r+');
    fs.writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (root - 1) * size);
    fs.closeSync(fd);
    assert.throws(() => adapter.read(store, key, SOURCE.messages), { code: 'damaged' });
    // Not a database at all: damaged, never an empty store.
    fs.writeFileSync(path.join(dir, DB_REL), Buffer.alloc(8192, 0x41));
    assert.throws(() => adapter.list(store), { code: 'damaged' });
  });
  // A database with no sessions table, and no database: no sessions.
  const dir = tmpStore();
  try {
    const store = storeOf(adapter, dir);
    assert.deepEqual(adapter.list(store), []);
    fs.mkdirSync(path.join(dir, 'sessions'));
    const b = new DatabaseSync(path.join(dir, DB_REL));
    b.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
    b.close();
    assert.deepEqual(adapter.list(store), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('goose: errors: an unknown session, an unknown source, a deleted session', () => {
  withStore('conformance-goose-sentinel', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store)[0];
    const key = keyOf(store, s);
    assert.throws(() => adapter.read(store, { ...key, session_id: '20990101_1' }, SOURCE.messages), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, 'sessions/sessions.db#table:threads'), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key, 'sessions/sessions.db'), { code: 'source_unknown' });
    const w = writer(dir);
    w.exec(`DELETE FROM messages WHERE session_id = '${s.session_id}'; DELETE FROM usage_ledger WHERE session_id = '${s.session_id}'; DELETE FROM sessions WHERE id = '${s.session_id}';`);
    w.close();
    assert.ok(!adapter.list(store).some((x) => x.session_id === s.session_id));
    assert.throws(() => adapter.read(store, key, SOURCE.messages), { code: 'session_unknown' });
    fs.rmSync(path.join(dir, 'sessions'), { recursive: true });
    assert.deepEqual(adapter.list(store), []);
    assert.throws(() => adapter.read(store, key, SOURCE.session), { code: 'session_unknown' });
  });
});

test('goose: a symlinked database or sessions folder is neither listed nor read', () => {
  withStore('conformance-goose-sentinel', (real) => {
    for (const link of ['file', 'folder']) {
      const dir = tmpStore();
      try {
        const store = storeOf(adapter, dir);
        if (link === 'file') {
          fs.mkdirSync(path.join(dir, 'sessions'));
          fs.symlinkSync(path.join(real, DB_REL), path.join(dir, DB_REL));
        } else {
          fs.symlinkSync(path.join(real, 'sessions'), path.join(dir, 'sessions'));
        }
        assert.deepEqual(adapter.list(store), []);
        const key = { ...store, session_id: '20261021_9', incarnation: '2026-10-21 22:44:00' };
        assert.throws(() => adapter.read(store, key, SOURCE.messages), (e) => e.code === 'session_unknown' || e.code === 'source_unknown');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

test('goose: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'goose');
  assert.equal(d.model_version, 'sessions-model/1');
  assert.equal(d.facets.reuse, 'undetectable');
  assert.deepEqual(d.sources.map((x) => x.pattern).sort(), Object.values(SOURCE).sort());
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
  for (const recs of CASES.flatMap((c) => Object.values(golden(c)))) {
    const results = ofType(recs, 'message').flatMap((m) => m.parts.filter((p) => p.kind === 'tool_result'));
    for (const p of ofType(recs, 'message').flatMap((m) => m.parts.filter((x) => x.kind === 'tool_call'))) {
      assert.ok(results.filter((r) => r.call_id === p.call_id).length <= 1, p.call_id);
    }
  }
  // Every session kind the store keeps is listed (spec §3).
  assert.deepEqual([...new Set(ofType(all, 'session').map((s) => s.kind))].sort(), ['acp', 'sub_agent', 'terminal', 'user']);
});

test('goose: a tool_result carries the stored structuredContent.exit_code; a result without one has none', () => {
  withStore('features', (dir) => {
    const parts = Object.values(project(fullReplay(adapter, dir).views())).flat()
      .filter((r) => r.type === 'message').flatMap((m) => m.parts).filter((p) => p.kind === 'tool_result');
    // call-1: `structuredContent: { stdout, stderr, exit_code: 1 }`, the text saying so separately.
    const failed = parts.filter((p) => p.call_id === 'call-1');
    assert.ok(failed.length > 0);
    for (const p of failed) assert.equal(p.exit_code, 1);
    assert.ok(parts.some((p) => p.call_id !== 'call-1' && p.exit_code === null));
  });
});

test('goose: speaker split: a row holding a tool result and text gives its message and an `<id>:tool` message', () => {
  const sk = SOURCE.messages;
  const row = (id, mid, role, t, content, meta = {}) => ({ source_key: sk, unit_key: `messages:${id}`, enc: 'row-json', body: JSON.stringify({ id, message_id: mid, role, created_timestamp: t, content_json: JSON.stringify(content), metadata_json: JSON.stringify({ userVisible: true, agentVisible: true, ...meta }) }) });
  const inf = { inference: { provider: 'openai', requestedModel: 'm' } };
  const units = [
    row(1, 'msg_u', 'user', 10, [{ type: 'text', text: 'Run the tests.' }]),
    row(2, 'chatcmpl-a', 'assistant', 11, [{ type: 'toolRequest', id: 'call_0', toolCall: { status: 'success', value: { name: 'shell', arguments: {} } } }], inf),
    // One role-user row with both: goose's result for call_0, and the user's next words.
    row(3, 'msg_mixed', 'user', 12, [{ type: 'toolResponse', id: 'call_0', toolResult: { status: 'success', value: { content: [{ type: 'text', text: '3 passed' }] } } }, { type: 'text', text: 'Now the linter.' }]),
  ];
  const session = { host: 'h', harness: 'goose', harness_path: '/x', session_id: '20261022_2', incarnation: '2026-10-22 00:00:00' };
  const sessUnit = { source_key: SOURCE.session, unit_key: SOURCE.session, enc: 'rows-json', body: JSON.stringify({ sessions: [{ id: '20261022_2', name: '', working_dir: '/w', created_at: '2026-10-22 00:00:00', session_type: 'user' }] }) };
  const out = adapter.derive(session, [{ source_key: SOURCE.session, generation: 1, complete: true, units: [sessUnit], gone: [] }, { source_key: sk, generation: 1, complete: true, units, gone: [] }], null);
  const msgs = out.changed.filter((r) => r.type === 'message');
  const user = msgs.find((m) => m.message_id === 'msg_mixed');
  const tool = msgs.find((m) => m.message_id === 'msg_mixed:tool');
  assert.deepEqual([user.role, user.source, user.parts.map((p) => [p.kind, p.text])], ['user', 'user', [['text', 'Now the linter.']]]);
  assert.deepEqual([tool.role, tool.parts.map((p) => [p.kind, p.call_id, p.output])], ['tool', [['tool_result', 'call_0', '3 passed']]]);
  assert.ok(user.order < tool.order);
});
