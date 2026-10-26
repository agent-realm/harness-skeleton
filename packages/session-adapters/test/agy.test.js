import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { adapterFor } from '../src/index.js';
import { rowJson } from '../src/sqlite.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, tmpStore, storeOf, nameLint, filesOf } from '../conformance/runner.js';
import { prepareStore, sqlGrowthCheck, sqlFilesOf, buildDb } from '../conformance/sql-store.js';
import {
  A, H, O, F, P, C, R, HUB, ID, SIG, FULL_FIND, T0, E, STATUS, SOURCE, TYPE,
  conversation, call, usage, genRow, execRow, enc, anyOf,
} from '../fixtures/agy/generate.js';
import { S, decode } from '../src/harnesses/agy/pb.js';
import { sha256 } from '../src/jcs.js';

const adapter = adapterFor('agy');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agy');
const CASES = ['features', 'fork', 'subagent', 'rewind', 'transcript'];
const EXEMPT = adapter.describe().redaction.exemptions;
const J = 'e96784d2-85ca-49f8-97c0-b271bfad1510';
const HP = '/home/user/.gemini/antigravity-cli';
const steps = (sid) => `conversations/${sid}.db#table:steps`;
const transcript = (sid) => `brain/${sid}/.system_generated/logs/transcript_full.jsonl`;

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
const recsOf = (name, sid) => golden(name)[sid];
const msg = (recs, id) => recs.find((r) => r.type === 'message' && r.message_id === id);
const ofType = (recs, type) => recs.filter((r) => r.type === type);
const messages = (recs) => ofType(recs, 'message').sort((a, b) => (a.order < b.order ? -1 : 1));
function lastDerive(e, sid) {
  for (const [id, s] of e.sessions) if (id.split('\u0000')[0] === sid) return s.last;
  return null;
}
const viewOf = (e, sid) => [...e.views()[sid].values()];

// derive over rows given inline, as the tables' sources would read them (row-json units).
const key = (sid) => ({ host: 'h', harness: 'agy', harness_path: HP, session_id: sid, incarnation: '' });
function rowUnits(sk, table, rows) {
  return rows.map((r) => {
    const body = JSON.stringify(rowJson(r));
    return { source_key: sk, unit_key: `${table}:${r.idx}`, enc: 'row-json', bytes: Buffer.byteLength(body), sha256: '', redacted: false, body };
  });
}
function deriveRows(sid, { rows = [], gens = [], execs = [], refs = [], traj = null } = {}, state = null) {
  const tk = (t) => `conversations/${sid}.db#table:${t}`;
  const input = [
    { source_key: tk('steps'), generation: 1, complete: true, units: rowUnits(tk('steps'), 'steps', rows), gone: [] },
    { source_key: tk('gen_metadata'), generation: 1, complete: true, units: rowUnits(tk('gen_metadata'), 'gen_metadata', gens), gone: [] },
    { source_key: tk('executor_metadata'), generation: 1, complete: true, units: rowUnits(tk('executor_metadata'), 'executor_metadata', execs), gone: [] },
    { source_key: tk('parent_references'), generation: 1, complete: true, units: rowUnits(tk('parent_references'), 'parent_references', refs), gone: [] },
  ];
  if (traj) {
    const body = JSON.stringify({ trajectory_metadata_blob: [rowJson({ id: 'main', data: traj })] });
    input.push({ source_key: tk('trajectory_metadata_blob'), generation: 1, complete: true, units: [{ source_key: tk('trajectory_metadata_blob'), unit_key: tk('trajectory_metadata_blob'), enc: 'rows-json', bytes: body.length, sha256: '', redacted: false, body }], gone: [] });
  }
  return adapter.derive(key(sid), input, state);
}
// derive over transcript lines given inline, as the jsonl source (no DB).
function deriveLines(sid, lines) {
  let off = 0;
  const units = [];
  for (const l of lines) {
    const body = JSON.stringify(l);
    units.push({ source_key: transcript(sid), unit_key: String(off), enc: 'utf8', bytes: Buffer.byteLength(body), sha256: '', redacted: false, body });
    off += Buffer.byteLength(body) + 1;
  }
  return adapter.derive(key(sid), [{ source_key: transcript(sid), generation: 1, complete: true, units, gone: [] }], null);
}

// The features case's steps, rebuilt for inline derives.
const ca = conversation(A);
const at = (s) => T0 + Math.round(s * 1000);
const C1 = call('call_1164701', 'run_command', { CommandLine: 'python3 -m pytest -q', WaitMsBeforeAsync: 5000 });
const U1 = usage(6889, 206, 'urvYaqmoJdCG28oP2-af0AY', { thinking_output_tokens: 179 });
const turn1 = () => [
  ca.user(0, { t: at(0), exec: E(1), id: ID('U1') }, 'Fix the qty bug in cart.py, then run the tests.'),
  ca.planner(1, { t: at(0.1), exec: E(1), id: ID('P1'), gen: 0, usage: U1 }, { thinking: 'Run the tests first.', calls: [C1] }),
  ca.generic(2, { t: at(9.5), exec: E(1), id: ID('G1'), call: C1 }, STATUS.DONE, 'Command exited with code 1.\n\n1 failed, 2 passed'),
  ca.planner(3, { t: at(9.6), exec: E(1), id: ID('P2'), gen: 1, usage: usage(2393, 108, 'r-2') }, { text: 'Fixed.' }),
];

// ---- the conformance checks, per case ----------------------------------------------------------

for (const name of CASES) {
  test(`agy/${name}: the full replay equals the reviewed golden`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), golden(name)));
  });

  test(`agy/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    const r = sqlGrowthCheck(adapter, path.join(FIX, name), { steps: 12 });
    assert.deepEqual(r.incremental, r.full);
    assert.ok(r.equal, 'the incremental and the full view differ');
    assert.deepEqual(r.notUnchanged, []);
  });

  test(`agy/${name}: keys are stable across a lost state`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), project(fullReplay(adapter, dir).views())));
  });

  test(`agy/${name}: no string under a secret-looking name in any unit or record`, () => {
    withStore(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) {
          for (const u of src.units.values()) {
            let o = null;
            try {
              o = JSON.parse(u.body);
            } catch {
              continue; // a .pbtxt annotation, an output.txt
            }
            hits.push(...nameLint(o, EXEMPT, `${u.source_key}@${u.unit_key}:`));
          }
        }
        for (const r of s.view.values()) hits.push(...nameLint(r, EXEMPT, `${r.type}:`));
      }
      assert.deepEqual(hits, []);
    });
  });
}

test('agy: the folded result does not depend on the order sources are given', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    for (const s of adapter.list(store)) {
      const k = { ...store, session_id: s.session_id, incarnation: '' };
      const input = s.sources.map((x) => ({ source_key: x.source_key, generation: 1, complete: true, units: adapter.read(store, k, x.source_key).units, gone: [] }));
      const a = adapter.derive(k, input, null);
      const b = adapter.derive(k, [...input].reverse(), null);
      const sorted = (out) => out.changed.map((r) => JSON.stringify(r)).sort();
      assert.deepEqual(sorted(b), sorted(a));
      assert.deepEqual(b.live, a.live);
      assert.deepEqual(b.held, a.held);
    }
  });
});

// ---- the lab cases (unpublished) ---------------------------------------------------------------

test('agy: lab case: planner tool_calls[0].id call_1164688 pairs with the GENERIC step that carries it', () => {
  const recs = recsOf('features', A);
  const calls = messages(recs).flatMap((m) => m.parts.filter((p) => p.kind === 'tool_call' && p.call_id === 'call_1164688').map((p) => [m.role, p.name]));
  const results = messages(recs).flatMap((m) => m.parts.filter((p) => p.kind === 'tool_result' && p.call_id === 'call_1164688').map((p) => [m.role, m.message_id]));
  assert.deepEqual(calls, [['assistant', 'finish']]);
  assert.deepEqual(results, [['tool', ID('G8')]]);
});

test('agy: lab case: a fork links to its origin at the fork point; the copied rows keep their content ids, marked', () => {
  const recs = recsOf('fork', F);
  const [link] = ofType(recs, 'link');
  assert.deepEqual([link.kind, link.stated_on, link.origin, link.child.session_id, link.at, link.evidence], ['fork', 'child', { harness: 'agy', session_id: O }, F, ID('OP3'), 'explicit']);
  assert.deepEqual(link.inherits, { through_message_id: ID('OP3'), ids_preserved: true, marked: true, usage_copied: true });
  assert.ok(msg(recs, 'd73f3a6b86234161ae0beecfccd94d99'), 'the copied step keeps model_api_content_id d73f3a6b…');
  assert.deepEqual(messages(recs).map((m) => m.message_id), messages(recsOf('fork', O)).map((m) => m.message_id).concat([ID('FU'), ID('FP')]));
  assert.deepEqual(ofType(recs, 'lifecycle').map((r) => [r.op, r.at]), [['fork', ID('OP3')]]);
  assert.deepEqual(ofType(recsOf('fork', O), 'link'), [], 'the origin states nothing');
});

test('agy: fork-retract: step_index 38 after 43 retracts lines 0-1; the folded order is 38..45', () => {
  const recs = recsOf('transcript', F);
  const text = fs.readFileSync(path.join(FIX, 'transcript', 'store', transcript(F)), 'utf8');
  const si = new Map();
  let off = 0;
  for (const l of text.split('\n').slice(0, -1)) {
    si.set(`@${off}`, JSON.parse(l).step_index);
    off += Buffer.byteLength(l) + 1;
  }
  const ms = messages(recs);
  assert.deepEqual(ms.filter((m) => m.state === 'retracted').map((m) => si.get(m.message_id)), [42, 43]);
  assert.deepEqual(ms.filter((m) => m.state === 'current').map((m) => si.get(m.message_id)), [38, 39, 40, 41, 42, 43, 44, 45]);
  const rw = ofType(recs, 'lifecycle').find((r) => r.op === 'rewind');
  assert.deepEqual([rw.target, rw.at, rw.evidence], [{ range: { from_id: '@0', through_id: ms[1].message_id } }, null, 'explicit']);
  assert.equal(rw.lifecycle_id, `${transcript(F)}@${ms[2].message_id.slice(1)}#1`, 'keyed on the line that rewound');
  // The CHECKPOINT (41) is a summary whose compaction covers the current messages before it.
  const cp = ms.find((m) => si.get(m.message_id) === 41);
  assert.deepEqual([cp.role, cp.parts[0].kind, cp.parts[0].replaces], ['system', 'summary', 'unknown']);
  const comp = ofType(recs, 'lifecycle').find((r) => r.op === 'compaction');
  assert.deepEqual(comp.target, { range: { from_id: ms[2].message_id, through_id: ms[4].message_id } });
});

test('agy: lab case: a CHECKPOINT is a summary replacing through included_step_index_end, and a compaction record', () => {
  const recs = recsOf('features', A);
  const ck = msg(recs, ID('CK1'));
  assert.deepEqual([ck.role, ck.source, ck.parts[0].kind, ck.parts[0].replaces], ['system', 'system_notice', 'summary', { through_index: 15 }]);
  const lc = ofType(recs, 'lifecycle').find((r) => r.op === 'compaction');
  assert.deepEqual([lc.lifecycle_id, lc.target, lc.ts], [ID('CK1'), { range: { from_id: ID('U1'), through_id: ID('U4') } }, ck.ts]);
  // Its own usage: in retry_infos and in its generation (the compaction call).
  const u = ofType(recs, 'usage').find((x) => x.usage_id === 'X4bXasqpCPmAxs0PwuyouA8');
  assert.deepEqual([u.input, u.output, u.cache_read, ck.response_id], [2633, 788, 23126, 'X4bXasqpCPmAxs0PwuyouA8']);
});

test('agy: a generation spanning a planner and a CHECKPOINT (neither with its own usage) is billed once, on its first step', () => {
  // No response_id: the usage is keyed by its message, so a second billing is not folded away.
  const UG = usage(4321, 87, undefined);
  const gen = { idx: 0, data: enc({ chat_model: { model: 1417, usage: UG, response_model: 'gemini-4-argon' }, step_indices: [1, 2], execution_id: E(1) }, S.GenMeta) };
  const rows = [
    ca.user(0, { t: at(0), exec: E(1), id: ID('UG1') }, '/compact'),
    ca.planner(1, { t: at(0.1), exec: E(1), id: ID('PG1'), gen: 0 }, { text: 'Compacting.' }),
    ca.checkpoint(2, { t: at(0.2), exec: E(1), id: ID('CKG1'), gen: 0 }, { session_summary: 'Compacted.', included_step_index_end: 1 }),
  ];
  const out = deriveRows(A, { rows, gens: [gen], execs: [execRow(0, E(1), 2)] });
  assert.ok(out.changed.some((r) => r.type === 'message' && r.message_id === ID('CKG1')), 'the checkpoint is written');
  const billed = ofType(out.changed, 'usage').filter((r) => r.input === 4321 && r.output === 87);
  assert.equal(billed.length, 1, "the generation's usage is one record");
  assert.deepEqual(billed[0].anchor, { message_id: ID('PG1') }, 'on the planner, the generation\'s first step');
});

test('agy: lab case: a CANCELED result is cancelled; a denied one is an error with its details', () => {
  const recs = recsOf('features', A);
  const canceled = msg(recs, ID('G9'));
  assert.deepEqual([canceled.status, canceled.parts[0].status, canceled.parts[0].is_error], ['cancelled', 'cancelled', false]);
  const denied = msg(recs, ID('G2'));
  assert.deepEqual([denied.status, denied.parts[0].status, denied.parts[0].is_error], ['error', 'denied', true]);
  assert.match(denied.parts[0].output, /user denied permission to run command/);
});

// ---- the memhouse normaliser's reviewed cases ------------------------------------------------

test('agy: a turn: content ids, a call and its result, reasoning, usage and the served model', () => {
  const recs = recsOf('features', A);
  assert.deepEqual(messages(recs).slice(0, 6).map((m) => [m.message_id, m.role]), [
    [ID('U1'), 'user'], [ID('SYS1'), 'system'], [ID('EPH1'), 'system'], [ID('P1'), 'assistant'], [ID('G1'), 'tool'], [ID('P2'), 'assistant'],
  ], 'one message per step, in idx order; a GENERIC result is its own tool message');
  const p1 = msg(recs, ID('P1'));
  assert.deepEqual(p1.parts.map((p) => p.kind), ['reasoning', 'tool_call']);
  assert.deepEqual([p1.served_model, p1.requested_model, p1.effort, p1.response_id], ['gemini-4-argon', 'MODEL_PLACEHOLDER_M417', null, 'urvYaqmoJdCG28oP2-af0AY']);
  const u1 = ofType(recs, 'usage').find((u) => u.usage_id === p1.response_id);
  assert.deepEqual([u1.input, u1.output, u1.reasoning, u1.cache_read, u1.input_includes_cache, u1.output_includes_reasoning, u1.granularity, u1.anchor], [6889, 206, 179, null, null, null, 'per_response', { response_id: p1.response_id }], 'an unset counter is null, not 0');
  const g1 = msg(recs, ID('G1'));
  assert.deepEqual([g1.parts[0].call_id, g1.parts[0].is_error, g1.parts[0].status, g1.parts[0].output.split('\n')[0]], ['call_1164701', null, 'completed', 'Command exited with code 1.'], 'DONE beside exit 1 is no flag');
  assert.deepEqual([ID('SYS1'), ID('EPH1'), ID('U1'), ID('P1')].map((id) => msg(recs, id).source), ['injected', 'injected', 'user', 'model']);
  assert.ok(!JSON.stringify(golden('features')).includes(SIG), 'no signature bytes reach a record');
  const p12 = msg(recs, ID('P12'));
  assert.deepEqual(p12.parts[0], { part_id: '0', kind: 'reasoning', opaque: true, signature_len: SIG.length }, 'redacted thinking is opaque, with its signature length');
});

test('agy: an image a tool read is an attachment; MCP servers; a cut result refers to its output.txt', () => {
  const recs = recsOf('features', A);
  assert.deepEqual(msg(recs, ID('G3')).parts[1], { part_id: '1', kind: 'attachment', media_type: 'image/png', inline: Buffer.from('PNG!').toString('base64'), bytes_len: 4 });
  const servers = Object.fromEntries(msg(recs, ID('P7')).parts.map((p) => [p.call_id, p.server]));
  assert.deepEqual(servers, { call_mcp_1: 'toybox', call_run_1: null, call_mcp_2: 'legacy-box' }, 'from the result\'s McpServerToolCall step, and from a nested legacy MCP_TOOL step');
  const cut = msg(recs, ID('G4')).parts[0];
  // The reference describes the output.txt unit as read emitted it: its sha256 and length.
  const full = Buffer.from(FULL_FIND, 'utf8');
  assert.deepEqual([cut.output_ref, cut.truncated], [{ ref: `brain/${A}/.system_generated/steps/18/output.txt`, sha256: sha256(full), bytes: full.length }, true]);
  assert.ok(Buffer.byteLength(FULL_FIND) > cut.output_len);
  const whole = msg(recs, ID('G5')).parts[0];
  assert.ok(!('output_ref' in whole) && whole.truncated === null, 'an output.txt no longer than the step text is no spill');
});

test('agy: a tool_result carries its RunCommand exit_code; a stored unknown is null', () => {
  // features: G1's payload stores exit_code 1; G7's RunCommand finished DONE with none, which is
  // how proto3 stores 0; G3 (view_file) has no RunCommand payload.
  const recs = recsOf('features', A);
  assert.deepEqual([ID('G1'), ID('G7'), ID('G3')].map((id) => msg(recs, id).parts[0].exit_code), [1, 0, null]);
  // Inline: the result text names no code, so the 3 can only come from the payload.
  const exitOf = (payload, status = STATUS.DONE) => {
    const rows = turn1();
    rows[2] = ca.generic(2, { t: at(9.5), exec: E(1), id: ID('G1'), call: C1 }, status, 'done', { result: { payload: anyOf('RunCommand', payload) } });
    return deriveRows(A, { rows, execs: [execRow(0, E(1), 3)] }).changed.find((r) => r.message_id === ID('G1')).parts[0].exit_code;
  };
  assert.equal(exitOf({ exit_code: 3 }), 3);
  assert.equal(exitOf({ exit_code: 3, exit_code_unknown: true }), null, 'exit_code_unknown means null');
  assert.equal(exitOf({ timed_out: true }), null, 'a timed-out command stored no code: none');
  assert.equal(exitOf({}, STATUS.ERROR), null, 'a command that did not finish stored no code: none');
});

// sessions-model v1.x (#6), §2.3 (`tool_result.is_error`): the step's status is the harness store's
// flag, ERROR true and DONE false. A DONE beside a run_command's non-zero exit_code is unreliable
// for that result, so its is_error is null. Never derived from exit_code or the text.
test('agy: is_error is the step status: DONE beside a non-zero exit is null, DONE is false, ERROR is true', () => {
  const resultOf = (payload, status = STATUS.DONE) => {
    const rows = turn1();
    rows[2] = ca.generic(2, { t: at(9.5), exec: E(1), id: ID('G1'), call: C1 }, status, 'done', { result: { payload: anyOf('RunCommand', payload) } });
    const p = deriveRows(A, { rows, execs: [execRow(0, E(1), 3)] }).changed.find((r) => r.message_id === ID('G1')).parts[0];
    return [p.is_error, p.exit_code];
  };
  assert.deepEqual(resultOf({ exit_code: 3 }), [null, 3], 'DONE beside exit 3: unreliable for this result');
  assert.deepEqual(resultOf({}), [false, 0], 'DONE, exit 0 (proto3 stores no 0)');
  assert.deepEqual(resultOf({ exit_code: 3, exit_code_unknown: true }), [false, null], 'DONE, the exit code unknown');
  assert.deepEqual(resultOf({ exit_code: 3 }, STATUS.ERROR), [true, 3], 'ERROR beside exit 3: the flag says failure');
  // features, a full replay: G1 (DONE, exit 1), G7 (DONE, exit 0), G2 (ERROR, denied).
  withStore('features', (dir) => {
    const recs = project(fullReplay(adapter, dir).views())[A];
    assert.deepEqual([ID('G1'), ID('G7'), ID('G2')].map((id) => [msg(recs, id).parts[0].is_error, msg(recs, id).parts[0].exit_code]), [[null, 1], [false, 0], [true, null]]);
  });
});

test('agy: automated turns (a task done, a SYSTEM user input), a hidden restart notice', () => {
  const recs = recsOf('features', A);
  assert.deepEqual([ID('TASK'), ID('RESTART'), ID('SYSUSER')].map((id) => msg(recs, id).source), ['automated', 'injected', 'automated']);
  const r = msg(recs, ID('RESTART'));
  assert.deepEqual([r.to_user, r.to_model], [false, true]);
  assert.deepEqual([msg(recs, ID('U1')).to_user, msg(recs, ID('U1')).to_model], [null, null]);
});

test('agy: without gen_metadata the served model is the enum name, kept verbatim', () => {
  const out = deriveRows(A, { rows: turn1(), execs: [execRow(0, E(1), 3)] });
  const p1 = out.changed.find((r) => r.type === 'message' && r.message_id === ID('P1'));
  assert.deepEqual([p1.served_model, p1.requested_model], ['MODEL_PLACEHOLDER_M417', 'MODEL_PLACEHOLDER_M417']);
  const withGen = deriveRows(A, { rows: turn1(), gens: [genRow(0, 1, E(1), U1)], execs: [execRow(0, E(1), 3)] });
  assert.equal(withGen.changed.find((r) => r.message_id === ID('P1')).served_model, 'gemini-4-argon');
});

// ---- held -------------------------------------------------------------------------------------

test('agy: a running tool holds its planner and itself, not the steps after them; its end releases both', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const out = lastDerive(e, H);
    assert.deepEqual(out.held.message, [ID('HG'), ID('HP')].sort());
    assert.deepEqual(out.held.usage, ['resp-held-01']);
    assert.deepEqual(out.live.message, [ID('HU'), ID('HE')].sort(), 'the hook notice written meanwhile is not held (memhouse held everything after)');
    // The tool finishes and the turn ends: an in-place update and an executor row.
    const h = conversation(H);
    const CH = call('call_held_1', 'run_command', { CommandLine: 'ls' });
    const db = new DatabaseSync(path.join(dir, `conversations/${H}.db`));
    const done = h.generic(2, { t: T0 + 3601000, exec: E(20), id: ID('HG'), call: CH }, STATUS.DONE, 'cart.py');
    db.prepare('UPDATE steps SET status = ?, step_payload = ?, metadata = ? WHERE idx = 2').run(done.status, done.step_payload, done.metadata);
    const x = execRow(0, E(20), 3);
    db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(x.idx, x.data);
    db.close();
    e.pass();
    const next = lastDerive(e, H);
    assert.deepEqual(next.held.message, []);
    assert.deepEqual(e.log.filter((l) => l.session_id === H && l.continuity !== 'unchanged').map((l) => [l.source_key.split('#')[1], l.continuity]), [['table:executor_metadata', 'delta'], ['table:steps', 'delta']]);
    const changed = next.changed.filter((r) => r.type === 'message').map((r) => [r.message_id, r.status]);
    assert.deepEqual(changed.sort(), [[ID('HG'), 'complete'], [ID('HP'), 'complete']].sort());
    assert.ok(next.changed.some((r) => r.type === 'usage' && r.usage_id === 'resp-held-01'));
  });
});

test('agy: a background task: written as it stands when its turn ends, revised when it finishes', () => {
  const caseDir = path.join(FIX, 'features');
  const db = sqlFilesOf(caseDir).find((d) => d.rel === `conversations/${A}.db`);
  // The statement that marks step 24 DONE: everything before it is the store while the task runs.
  const upto = db.ops.findIndex((o) => o.sql.startsWith('UPDATE steps') && o.params[o.params.length - 1] === 24);
  assert.ok(upto > 0);
  withStore('features', (dir) => {
    buildDb(dir, db, upto);
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const running = viewOf(e, A).find((r) => r.type === 'message' && r.message_id === ID('G7'));
    assert.deepEqual([running.status, running.parts[0].status, running.parts[0].is_error, running.parts[0].output], ['streaming', null, null, null]);
    assert.equal(viewOf(e, A).find((r) => r.message_id === ID('P9')).status, 'complete', 'its planner is released at the turn end');
    buildDb(dir, db);
    e.pass();
    const done = viewOf(e, A).find((r) => r.type === 'message' && r.message_id === ID('G7'));
    assert.deepEqual([done.status, done.parts[0].status, done.parts[0].is_error], ['complete', 'completed', false]);
  });
});

test('agy: a reply still generating is held while its turn runs; left open after a later turn, it is interrupted', () => {
  const rows = turn1();
  const generating = [...rows.slice(0, 3), ca.planner(3, { t: at(9.6), exec: E(1), id: ID('P2'), gen: 1 }, { text: 'Fix', status: STATUS.GENERATING })];
  const held = deriveRows(A, { rows: generating });
  assert.deepEqual(held.held.message, [ID('P2')]);
  assert.ok(!held.live.message.includes(ID('P2')));
  // The tool still running, the turn open: the planner and the tool are held.
  const running = [...rows.slice(0, 2), ca.generic(2, { t: at(9.5), exec: E(1), id: ID('G1'), call: C1 }, STATUS.RUNNING, '')];
  assert.deepEqual(deriveRows(A, { rows: running }).held.message, [ID('G1'), ID('P1')].sort());
  // A crash left the reply GENERATING, and the user went on: the next turn releases it as interrupted.
  const later = [...generating, ca.user(4, { t: at(60), exec: E(2), id: ID('U2') }, 'Next.')];
  const out = deriveRows(A, { rows: later });
  assert.deepEqual(out.held.message, []);
  assert.equal(out.changed.find((r) => r.message_id === ID('P2')).status, 'interrupted');
  // A planner whose call has no result when its turn ends: interrupted.
  const missing = deriveRows(A, { rows: rows.slice(0, 2), execs: [execRow(0, E(1), 1)] });
  assert.equal(missing.changed.find((r) => r.message_id === ID('P1')).status, 'interrupted');
});

test('agy: a held key keeps its last version: neither rewritten nor tombstoned', () => {
  const rows = turn1();
  const first = deriveRows(A, { rows, execs: [execRow(0, E(1), 3)] });
  assert.ok(first.live.message.includes(ID('P2')));
  // The same step regenerating (an in-place update to GENERATING within a new, open turn).
  const again = [...rows.slice(0, 3), ca.planner(3, { t: at(9.6), exec: E(9), id: ID('P2'), gen: 1 }, { text: 'Fix', status: STATUS.GENERATING })];
  const out = deriveRows(A, { rows: again }, first.state);
  assert.deepEqual(out.held.message, [ID('P2')]);
  assert.ok(!out.live.message.includes(ID('P2')) && !out.changed.some((r) => r.message_id === ID('P2')));
  assert.ok(out.state.emitted.message[ID('P2')], 'its last emitted sha stands');
});

// ---- rewind, fork and sub-agents ---------------------------------------------------------------

test('agy: a DB rewind: deleted rows and a reused idx reach read as a delta; rewound ids go, kept ids stay', () => {
  const caseDir = path.join(FIX, 'rewind');
  const db = sqlFilesOf(caseDir).find((d) => d.rel === `conversations/${R}.db`);
  const upto = db.ops.findIndex((o) => o.sql.startsWith('DELETE FROM steps'));
  withStore('rewind', (dir) => {
    buildDb(dir, db, upto);
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const before = messages(viewOf(e, R)).map((m) => m.message_id);
    assert.deepEqual(before, ['RU1', 'RP1', 'RU2', 'RP2', 'RG', 'RP3', 'RU3', 'RP4'].map(ID));
    buildDb(dir, db);
    e.pass();
    assert.equal(e.log.find((l) => l.source_key === steps(R)).continuity, 'delta');
    const after = messages(viewOf(e, R)).map((m) => m.message_id);
    assert.deepEqual(after, ['RU1', 'RP1', 'RU2b', 'RP2b'].map(ID), 'identity is the content id, never the reused idx');
    assert.deepEqual(project(e.views()), project(fullReplay(adapter, dir).views()));
    const rw = ofType(viewOf(e, R), 'lifecycle');
    assert.deepEqual(rw.map((r) => [r.op, r.target, r.at]), [['rewind', { session: true }, ID('RP1')]], 'the transcript gives the rewind; at = the last kept message');
  });
});

test('agy: read of a delta source: reset, then unchanged, then the changed and gone keys only', () => {
  const caseDir = path.join(FIX, 'rewind');
  const db = sqlFilesOf(caseDir).find((d) => d.rel === `conversations/${R}.db`);
  const upto = db.ops.findIndex((o) => o.sql.startsWith('DELETE FROM steps'));
  withStore('rewind', (dir) => {
    buildDb(dir, db, upto);
    const store = storeOf(adapter, dir);
    const k = { ...store, session_id: R, incarnation: '' };
    const r1 = adapter.read(store, k, steps(R));
    assert.equal(r1.continuity, 'reset');
    assert.deepEqual(r1.units.map((u) => [u.unit_key, u.enc]), [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [`steps:${i}`, 'row-json']));
    const known = Object.fromEntries(r1.units.map((u) => [u.unit_key, u.sha256]));
    assert.equal(adapter.read(store, k, steps(R), r1.position, known).continuity, 'unchanged');
    buildDb(dir, db);
    const r2 = adapter.read(store, k, steps(R), r1.position, known);
    assert.deepEqual([r2.continuity, r2.units.map((u) => u.unit_key), r2.gone], ['delta', ['steps:2', 'steps:3'], ['steps:4', 'steps:5', 'steps:6', 'steps:7']]);
  });
});

test('agy: a sub-agent is linked from both sides, at the parent\'s invoke_subagent call', () => {
  const parent = ofType(recsOf('subagent', P), 'link');
  assert.deepEqual(parent.map((l) => [l.kind, l.stated_on, l.child.session_id, l.origin.session_id, l.at]), [['subagent', 'origin', C, P, 'call_1677305']], 'one statement, though the result names the child twice');
  const child = ofType(recsOf('subagent', C), 'link');
  assert.deepEqual(child.map((l) => [l.kind, l.stated_on, l.child.session_id, l.origin.session_id, l.at]), [['subagent', 'child', C, P, 'call_1677305']]);
  assert.equal(msg(recsOf('subagent', C), ID('CS1')).source, 'automated', 'the parent\'s prompt starts a turn for the agent');
  assert.equal(msg(recsOf('subagent', P), ID('PMSG')).source, 'automated', 'and so does the child\'s report');
  // Without the trajectory metadata, the summaries row alone is enough; with neither, no link.
  const noTraj = recsOf('transcript', C);
  assert.deepEqual(ofType(noTraj, 'link').map((l) => [l.kind, l.origin.session_id, l.at]), [['subagent', P, '']]);
});

// ---- the transcript alone ---------------------------------------------------------------------

const jl = (o) => o;
const req = (s) => `<USER_REQUEST>\n${s}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-20T15:17:59+00:00.\n</ADDITIONAL_METADATA>`;
const isoAt = (s) => new Date(T0 + s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

test('agy: transcript only: @<offset> ids, tools by position, the request wrapper as a notice, usage per planner', () => {
  const recs = recsOf('transcript', J);
  const [u, p, g] = messages(recs);
  assert.deepEqual([u.message_id, u.parts.map((x) => x.kind), u.parts[0].text], ['@0', ['text', 'notice'], 'Name two classic wooden toys.']);
  assert.deepEqual(p.parts.map((x) => [x.kind, x.call_id ?? null]), [['reasoning', null], ['tool_call', `@${p.message_id}:0`]], 'call id: @ + the call\'s message id + : + index');
  assert.deepEqual([g.role, g.parts[0].call_id, g.parts[0].status], ['tool', `@${p.message_id}:0`, 'completed']);
  const us = ofType(recs, 'usage');
  assert.deepEqual(us.map((x) => [x.usage_id, x.input, x.output, x.cache_read]), [[`message:${p.message_id}#1`, 6692, 209, null]]);
});

test('agy: transcript only: a planner whose tool still runs at the tail is held; a RUNNING tail is held', () => {
  const lines = [
    jl({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: isoAt(0), content: req('Run the tests.') }),
    jl({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: isoAt(1), input_tokens: 10, output_tokens: 2, tool_calls: [{ name: 'run_command', args: { CommandLine: 'pytest' } }] }),
  ];
  const a = deriveLines(J, lines);
  assert.deepEqual(a.held.message, ['@' + Buffer.byteLength(JSON.stringify(lines[0]) + '\n')]);
  assert.equal(a.held.usage.length, 1);
  const running = [...lines, jl({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: isoAt(2), content: '' })];
  const b = deriveLines(J, running);
  assert.equal(b.held.message.length, 2, 'the RUNNING tail and its planner');
  // A notice after it: the RUNNING line is no longer the tail, and is written as it stands (agy
  // never updates it). Its planner waits until the turn closes: a later planner or user line.
  const notice = jl({ step_index: 3, source: 'SYSTEM_SDK', type: 'EPHEMERAL_MESSAGE', status: 'DONE', created_at: isoAt(3), content: 'hook: running.' });
  const c = deriveLines(J, [...running, notice]);
  assert.deepEqual(c.held.message, a.held.message);
  const g = c.changed.find((r) => r.type === 'message' && r.role === 'tool');
  assert.deepEqual([g.status, g.parts[0].status, g.parts[0].output], ['streaming', null, null]);
  const d = deriveLines(J, [...running, notice, jl({ step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: isoAt(9), content: req('Next.') })]);
  assert.deepEqual(d.held.message, []);
  assert.equal(d.changed.find((r) => r.message_id === a.held.message[0]).status, 'complete');
});

test('agy: read of the transcript: a partial last line is held back until whole, then appended', () => {
  withStore('transcript', (dir) => {
    const store = storeOf(adapter, dir);
    const k = { ...store, session_id: J, incarnation: '' };
    const r1 = adapter.read(store, k, transcript(J));
    assert.equal(r1.units.length, 3);
    fs.appendFileSync(path.join(dir, transcript(J)), '{"step_index":3,"ty');
    const r2 = adapter.read(store, k, transcript(J), r1.position);
    assert.deepEqual([r2.continuity, r2.units.length, r2.held_back.length], ['unchanged', 0, 1]);
    fs.appendFileSync(path.join(dir, transcript(J)), 'pe":"USER_INPUT","status":"DONE","content":"again"}\n');
    const r3 = adapter.read(store, k, transcript(J), r2.position);
    assert.deepEqual([r3.continuity, r3.units.length], ['appended', 1]);
  });
});

// ---- list and read ----------------------------------------------------------------------------

test('agy: list names each conversation DB and each DB-less transcript, with its sources', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    fs.mkdirSync(path.join(dir, 'brain', '11111111-1111-4111-8111-111111111111'), { recursive: true }); // no transcript: no session
    const sessions = adapter.list(store);
    assert.deepEqual(sessions.map((s) => s.session_id), [A, H].sort(), 'the hub row and a brain dir with no transcript are no sessions');
    assert.ok(!sessions.some((s) => s.session_id === HUB));
    const a = sessions.find((s) => s.session_id === A);
    assert.deepEqual([a.incarnation, a.live], ['', 'unknown']);
    assert.deepEqual(a.sources.map((s) => [s.source_key, s.role, s.mode, s.position_kind]), [
      [`brain/${A}/.system_generated/steps/18/output.txt`, 'side', 'snapshot', 'snapshot'],
      [`brain/${A}/.system_generated/steps/19/output.txt`, 'side', 'snapshot', 'snapshot'],
      ['conversation_summaries.db#table:conversation_summaries', 'side', 'snapshot', 'snapshot'],
      [`conversations/${A}.db#table:executor_metadata`, 'side', 'delta', 'rowid'],
      [`conversations/${A}.db#table:gen_metadata`, 'side', 'delta', 'rowid'],
      [`conversations/${A}.db#table:parent_references`, 'side', 'delta', 'rowid'],
      [`conversations/${A}.db#table:steps`, 'main', 'delta', 'rowid'],
      [`conversations/${A}.db#table:trajectory_metadata_blob`, 'side', 'snapshot', 'snapshot'],
    ]);
    assert.deepEqual(sessions.find((s) => s.session_id === H).sources.map((s) => s.source_key).filter((k) => !k.includes('#')), [`annotations/${H}.pbtxt`]);
    // The hint: stable; another conversation's summaries churn leaves it; this one's title moves it.
    assert.deepEqual(adapter.list(store), sessions);
    const w = (sql, ...a) => {
      const d = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
      d.prepare(sql).run(...a);
      d.close();
    };
    w("UPDATE conversation_summaries SET step_count = 99, last_modified_time = '2026-10-21 15:00:00+00:00' WHERE conversation_id = ?", A);
    w("UPDATE conversation_summaries SET title = 'renamed' WHERE conversation_id = ?", HUB);
    assert.deepEqual(adapter.list(store), sessions, 'counters and another conversation\'s row do not move a hint');
    w("UPDATE conversation_summaries SET title = 'Qty fix, renamed' WHERE conversation_id = ?", A);
    const renamed = adapter.list(store);
    assert.notEqual(renamed.find((s) => s.session_id === A).updated_hint, a.updated_hint);
    assert.equal(renamed.find((s) => s.session_id === H).updated_hint, sessions.find((s) => s.session_id === H).updated_hint);
  });
  withStore('transcript', (dir) => {
    const sessions = adapter.list(storeOf(adapter, dir));
    assert.deepEqual(sessions.map((s) => s.session_id), [F, C, J].sort());
    for (const s of sessions) assert.deepEqual(s.sources.find((x) => x.source_key === transcript(s.session_id)).role, 'main', 'no DB: the transcript is main');
  });
});

test('agy: list and read create nothing beside a WAL-mode store', () => {
  withStore('features', (dir) => {
    const snap = () => filesOf(dir);
    const before = snap();
    const e = fullReplay(adapter, dir);
    assert.ok(e.sessions.size === 2);
    assert.deepEqual(snap(), before);
  });
});

test('agy: read keeps of a generation only what derive reads; the summaries row without its counters', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const k = { ...store, session_id: A, incarnation: '' };
    const gen = adapter.read(store, k, `conversations/${A}.db#table:gen_metadata`);
    assert.equal(gen.units.length, 14);
    for (const u of gen.units) {
      const row = JSON.parse(u.body);
      const bytes = Buffer.from(row.data, 'base64');
      assert.ok(!bytes.includes('system prompt trimmed') && !bytes.includes('planner config') && !bytes.includes('sessionID'), 'the prompt, the planner config and the response header are gone');
      assert.deepEqual(Object.keys(row).sort(), ['data', 'idx']);
    }
    const sum = adapter.read(store, k, 'conversation_summaries.db#table:conversation_summaries');
    const body = JSON.parse(sum.units[0].body);
    assert.equal(sum.units[0].enc, 'rows-json');
    assert.deepEqual(Object.keys(body.conversation_summaries[0]).sort(), ['agent_name', 'app_data_dir', 'conversation_id', 'parent_conversation_id', 'title', 'workspace_uris']);
    const st = adapter.read(store, k, steps(A));
    assert.ok(JSON.parse(st.units[0].body).step_payload, 'a step row is whole, its blobs in base64');
  });
});

test('agy: errors: an unknown session, an unknown source, a deleted session', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const k = { ...store, session_id: A, incarnation: '' };
    assert.throws(() => adapter.read(store, { ...k, session_id: '11111111-1111-4111-8111-111111111111' }, steps(A)), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, { ...k, session_id: 'not-a-uuid' }, steps(A)), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, k, `conversations/${A}.db#table:battle_mode_infos`), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, k, steps(H)), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, k, transcript(A)), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, k, `brain/${A}/.system_generated/steps/7/output.txt`), { code: 'source_unknown' });
    // Delete removes the DB and the brain dir (spec §6): list omits it, read says session_unknown.
    fs.rmSync(path.join(dir, `conversations/${A}.db`));
    fs.rmSync(path.join(dir, 'brain', A), { recursive: true });
    assert.deepEqual(adapter.list(store).map((s) => s.session_id), [H]);
    assert.throws(() => adapter.read(store, k, steps(A)), { code: 'session_unknown' });
  });
});

test('agy: a locked store is busy, a damaged one or an undecodable step is damaged; never fewer steps', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const k = { ...store, session_id: A, incarnation: '' };
    const file = path.join(dir, `conversations/${A}.db`);
    const sums = path.join(dir, 'conversation_summaries.db');
    const full = adapter.read(store, k, steps(A)).units.length;
    // A rollback-journal copy, so that an exclusive lock blocks readers.
    for (const f of [file, sums]) {
      const d = new DatabaseSync(f);
      d.exec('PRAGMA journal_mode = DELETE');
      d.close();
    }
    for (const [f, check] of [[file, () => adapter.read(store, k, steps(A))], [sums, () => adapter.list(store)]]) {
      const locker = new DatabaseSync(f);
      locker.exec('BEGIN EXCLUSIVE');
      try {
        assert.throws(check, { code: 'busy' });
      } finally {
        locker.exec('ROLLBACK');
        locker.close();
      }
    }
    assert.equal(adapter.read(store, k, steps(A)).units.length, full, 'and reads in full once the lock is gone');
    // Damaged pages: every b-tree page header after the schema page.
    const corrupt = (f) => {
      const buf = fs.readFileSync(f);
      const ps = buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16);
      for (let off = ps; off + 16 <= buf.length; off += ps) buf.fill(0xa5, off, off + 16);
      fs.writeFileSync(f, buf);
    };
    fs.copyFileSync(file, `${file}.bak`);
    corrupt(file);
    assert.throws(() => adapter.read(store, k, steps(A)), { code: 'damaged' });
    fs.copyFileSync(`${file}.bak`, file);
    fs.rmSync(`${file}.bak`);
    fs.copyFileSync(sums, `${sums}.bak`);
    corrupt(sums);
    assert.throws(() => adapter.list(store), { code: 'damaged' });
    fs.copyFileSync(`${sums}.bak`, sums);
    fs.rmSync(`${sums}.bak`);
    // A committed step whose payload or metadata does not decode: never skipped, never renamed.
    for (const col of ['step_payload', 'metadata']) {
      const d = new DatabaseSync(file);
      const old = d.prepare(`SELECT ${col} AS v FROM steps WHERE idx = 6`).get().v;
      d.prepare(`UPDATE steps SET ${col} = ? WHERE idx = 6`).run(Buffer.from([0x0a, 0x7f, 0x01]));
      d.close();
      assert.throws(() => adapter.read(store, k, steps(A)), (e) => e.code === 'damaged' && /step 6/.test(e.message), col);
      const d2 = new DatabaseSync(file);
      d2.prepare(`UPDATE steps SET ${col} = ? WHERE idx = 6`).run(old);
      d2.close();
    }
    assert.equal(adapter.read(store, k, steps(A)).units.length, full);
  });
});

test('agy: a symlinked conversation DB is neither listed nor read', () => {
  withStore('fork', (dir) => {
    const store = storeOf(adapter, dir);
    const outside = tmpStore('sa-outside-');
    try {
      const sid = '22222222-2222-4222-8222-222222222222';
      fs.copyFileSync(path.join(dir, `conversations/${O}.db`), path.join(outside, 'x.db'));
      fs.symlinkSync(path.join(outside, 'x.db'), path.join(dir, `conversations/${sid}.db`));
      assert.deepEqual(adapter.list(store).map((s) => s.session_id), [O, F].sort());
      assert.throws(() => adapter.read(store, { ...store, session_id: sid, incarnation: '' }, steps(sid)), (e) => e.code === 'session_unknown' || e.code === 'source_unknown');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('agy: a file part\'s URI: http(s) cut to scheme://host, data: and host-less URIs one marker; file:, paths and drive paths kept', () => {
  const SECRET = 'X-Amz-Signature=SENTINEL0123456789';
  const media = [
    { mime_type: 'image/png', uri: `https://cdn.example.com/u/label.png?${SECRET}` },
    { mime_type: 'image/png', uri: `${'file:///home/user/work/toy%20shop'}/label.png` },
    { mime_type: 'image/png', uri: '/home/user/work/label.png' },
    { mime_type: 'image/png', uri: 'C:\\Users\\user\\label.png' },
    { mime_type: 'text/plain', uri: `mcp-resource:toybox/${SECRET}` },
  ];
  const dataUri = `data:image/png;base64,${Buffer.from('PNG!').toString('base64')}`;
  const rows = [ca.user(0, { t: at(0), exec: E(1), id: ID('U1') }, 'Describe these.', { media, images: [{ mime_type: 'image/png', uri: dataUri }] })];
  const out = deriveRows(A, { rows });
  const m = out.changed.find((r) => r.type === 'message');
  assert.deepEqual(m.parts.filter((p) => p.kind === 'attachment').map((p) => p.ref), [
    `<redacted len=${Buffer.byteLength(dataUri)}>`,
    'https://cdn.example.com', 'file:///home/user/work/toy%20shop/label.png', '/home/user/work/label.png', 'C:\\Users\\user\\label.png',
    `<redacted len=${Buffer.byteLength(media[4].uri)}>`,
  ]);
  assert.ok(!JSON.stringify(out.changed).includes('SENTINEL0123456789'));
});

// ---- describe, and the fixtures' protobuf blobs --------------------------------------------------

test('agy: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'agy');
  assert.equal(d.model_version, 'sessions-model/1');
  assert.equal(d.facets.reuse, 'impossible');
  for (const op of ['rewind', 'edit', 'compaction', 'delete', 'archive', 'unarchive', 'rename', 'pin', 'unpin', 'fork', 'clear']) {
    assert.ok(['explicit', 'implicit', 'invisible'].includes(d.facets.lifecycle[op]), op);
  }
  for (const k of ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation']) assert.ok(['explicit', 'inferable', 'none'].includes(d.facets.linkage[k]), k);
  const all = CASES.flatMap((c) => Object.values(golden(c)).flat());
  const ops = new Set(ofType(all, 'lifecycle').map((r) => r.op));
  for (const [op, v] of Object.entries(d.facets.lifecycle)) if (v === 'explicit') assert.ok(ops.has(op), `explicit ${op} has no fixture record`);
  const kinds = new Set(ofType(all, 'link').map((r) => r.kind));
  for (const [k, v] of Object.entries(d.facets.linkage)) if (v === 'explicit') assert.ok(kinds.has(k), `explicit ${k} link has no fixture record`);
  const summaries = all.filter((r) => r.type === 'message').flatMap((m) => m.parts).filter((p) => p.kind === 'summary');
  assert.ok(summaries.some((p) => p.replaces && p.replaces.through_index !== undefined), 'linkage.compaction {through_index}');
  // linkage.tool native: with a DB, every result's call_id names one call in the session.
  for (const c of ['features', 'fork', 'subagent', 'rewind']) {
    for (const recs of Object.values(golden(c))) {
      const callIds = messages(recs).flatMap((m) => m.parts.filter((p) => p.kind === 'tool_call').map((p) => p.call_id));
      for (const r of messages(recs).flatMap((m) => m.parts.filter((p) => p.kind === 'tool_result'))) assert.equal(callIds.filter((x) => x === r.call_id).length, 1, r.call_id);
    }
  }
});

test('agy: the fixtures\' protobuf blobs, decoded, leak nothing a real machine would', () => {
  const bad = [];
  for (const rel of filesOf(FIX).filter((f) => f.endsWith('.ops.jsonl'))) {
    for (const line of fs.readFileSync(path.join(FIX, rel), 'utf8').split('\n').filter(Boolean)) {
      for (const p of JSON.parse(line).params ?? []) {
        if (!p || typeof p !== 'object' || typeof p.$b64 !== 'string') continue;
        const text = Buffer.from(p.$b64, 'base64').toString('latin1');
        for (const m of text.matchAll(/(?:\/home\/|\/Users\/|C:\\\\?Users\\\\?)([A-Za-z0-9._-]+)/g)) if (m[1] !== 'user') bad.push(`${rel}: home path`);
        for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) if (!/^(127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(m[0])) bad.push(`${rel}: ${m[0]}`);
        for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!/@example\.(com|org|net)$/.test(m[0])) bad.push(`${rel}: mail`);
      }
    }
  }
  assert.deepEqual(bad, []);
  // And the decoder reads what the encoder wrote: a step's content id, its user text.
  const d = sqlFilesOf(path.join(FIX, 'features')).find((x) => x.rel === `conversations/${A}.db`);
  const first = d.ops.find((o) => o.sql.startsWith('INSERT INTO steps'));
  const step = decode(Buffer.from(first.params[7].$b64, 'base64'), S.Step);
  assert.deepEqual([step.type, step.metadata.model_api_content_id, step.metadata.source, step.user_input.user_response], [TYPE.USER_INPUT, ID('U1'), SOURCE.USER_EXPLICIT, 'Fix the qty bug in cart.py, then run the tests.']);
});
