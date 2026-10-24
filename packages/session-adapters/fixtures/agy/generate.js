// Writes the synthetic agy fixture stores: generated text only.
//   node fixtures/agy/generate.js
//
// A conversation DB is text here (conformance/sql-store.js): `store-sql/<rel>.schema.sql` holds the
// DDL agy 1.4.4 writes (gorm-style, from memhouse's normaliser test, which built its stores
// with the real DDL), and `store-sql/<rel>.ops.jsonl` the statements, in the order agy runs them:
// a step inserted while it runs and updated in place when it finishes, a rewind's DELETEs. Every
// protobuf blob is built here, from a readable field tree, by the encoder below (ported from
// memhouse's normaliser test), with the field numbers of the adapter's schemas
// (src/harnesses/agy/pb.js, checked against the 1.4.4 descriptors). Fields the adapter does not
// read
// are written raw (`_raw`), so the decoder is seen skipping them.
//
// The step shapes follow the scrubbed lab captures (the fixture captures,
// synthetic, captured on a test VM), and the cases port the reviewed behaviour of
// memhouse's normaliser test.
//
// Cases written here:
//   features   one session per behaviour the adapter claims: hook messages, reasoning, tool calls
//              and their results (run, denied, image, MCP, a nested legacy step, a spilled output,
//              a background task, canceled), usage and served models, a compaction, an automated
//              turn, a hidden restart notice; and a session whose last turn still runs (held), with
//              an archived, pinned annotation.
//   fork       an origin and its fork: copied rows keep their content ids and the origin's cascade.
//   subagent   a parent and its research sub-agent, linked from both sides.
//   rewind     a DB rewind: rows deleted, idx reused, and the transcript's lower step_index.
//   transcript the summaries DB only. Its `store/` holds three brain transcripts with no DB, copied
//              from the scrubbed lab captures
//              (a fork's transcript after a rewind, a compaction and a resume,
//              and a transcript sample), not written here.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { S } from '../../src/harnesses/agy/pb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- the protobuf encoder ---------------------------------------------------------------------

function varintBytes(v) {
  let x = BigInt.asUintN(64, BigInt(v));
  const out = [];
  do {
    let b = Number(x & 0x7fn);
    x >>= 7n;
    if (x) b |= 0x80;
    out.push(b);
  } while (x);
  return Buffer.from(out);
}
const tag = (no, wt) => varintBytes(no * 8 + wt);
const lenField = (no, buf) => Buffer.concat([tag(no, 2), varintBytes(buf.length), buf]);
const PACKABLE = new Set(['u', 'i', 'e', 'bool']);
const TS = { 1: ['seconds', 'i'], 2: ['nanos', 'i'] };
function encScalar(no, type, v) {
  switch (type) {
    case 's': return lenField(no, Buffer.from(String(v), 'utf8'));
    case 'b': return lenField(no, Buffer.from(v));
    case 'len': return lenField(no, Buffer.alloc(v, 0x5a));
    case 'u': case 'i': case 'e': return Buffer.concat([tag(no, 0), varintBytes(v)]);
    case 'bool': return Buffer.concat([tag(no, 0), varintBytes(v ? 1 : 0)]);
    case 'f': {
      const b = Buffer.alloc(4);
      b.writeFloatLE(v);
      return Buffer.concat([tag(no, 5), b]);
    }
    // A Timestamp from epoch ms, with sub-millisecond nanos as agy stores them.
    case 'ts': return lenField(no, enc({ seconds: Math.floor(v / 1000), nanos: (v % 1000) * 1e6 + 123456 }, TS));
    default: return lenField(no, enc(v, type));
  }
}

// A field tree -> protobuf bytes. `_raw: [[no, bytes | string]]` appends length-delimited fields
// the schema does not name (fields the adapter never reads).
export function enc(obj, schema) {
  const parts = [];
  for (const [no, [name, type, rep]] of Object.entries(schema)) {
    const v = obj[name];
    if (v == null) continue;
    if (rep && PACKABLE.has(type)) {
      parts.push(lenField(Number(no), Buffer.concat(v.map(varintBytes))));
      continue;
    }
    for (const x of rep ? v : [v]) parts.push(encScalar(Number(no), type, x));
  }
  for (const [no, b] of obj._raw || []) parts.push(lenField(no, Buffer.from(b)));
  return Buffer.concat(parts);
}

export const anyOf = (name, value, prefix = 'exa.cortex.core.tools') => ({ type_url: `type.googleapis.com/${prefix}.${name}`, value: enc(value, S[name]) });

// ---- the store's shapes -----------------------------------------------------------------------

export const TYPE = { USER_INPUT: 14, PLANNER: 15, GENERIC: 132, SYSTEM: 101, EPHEMERAL: 90, CHECKPOINT: 23 };
export const STATUS = { PENDING: 1, RUNNING: 2, DONE: 3, CANCELED: 6, ERROR: 7, GENERATING: 8, WAITING: 9 };
export const SOURCE = { MODEL: 2, USER_EXPLICIT: 4, SYSTEM: 5, SYSTEM_SDK: 6 };
export const SIG = 'SIGNATURE-SENTINEL-NEVER-IN-A-RECORD';
const HEADER = { 1: ['key', 's'], 2: ['value', 's'] };

export const cid = (t) => crypto.createHash('md5').update(t).digest('hex'); // 32-hex, like model_api_content_id
export const T0 = Date.UTC(2026, 9, 21, 13, 15, 29);
export const CWD = '/home/user/work/ag3/toyshop';
export const CWD_URI = `file://${CWD}`;

export const usage = (input, output, rid, more = {}) => ({
  model: 1417, input_tokens: input, output_tokens: output, response_id: rid, ...more,
  _raw: [[6, Buffer.from([0x18])], [8, enc({ key: 'sessionID', value: '-3750763034362895579' }, HEADER)]],
});
export const call = (id, name, args) => ({ id, name, arguments_json: JSON.stringify(args), _raw: [[7, Buffer.from(SIG)]] });

// One `steps` row: the Step payload, plus the side columns agy denormalises out of it.
// `m`: {t, exec, id, source, call, usage, gen, stepIndex, cascade, traj, retry}.
export function stepRow(idx, type, status, m, payload = {}) {
  const meta = {
    created_at: m.t, source: m.source ?? SOURCE.MODEL, execution_id: m.exec, tool_call: m.call, model_usage: m.usage,
    generator_model: m.usage || m.call ? 1417 : undefined, model_api_content_id: m.id, retry_infos: m.retry,
    source_trajectory_step_info: { trajectory_id: m.traj, step_index: m.stepIndex ?? idx, metadata_index: m.gen, cascade_id: m.cascade },
    _raw: [[26, Buffer.from('internal_metadata: status transitions')]],
  };
  const step = { type, status, metadata: meta, ...payload, _raw: [[133, Buffer.from('permissions')]] };
  const r = (payload.generic && payload.generic.result) || {};
  return {
    idx, step_type: type, status,
    metadata: enc(meta, S.Meta),
    error_details: payload.error ? enc(payload.error, S.ErrorDetails) : null,
    task_details: payload.task_details ? enc(payload.task_details, S.TaskDetails) : null,
    render_info: r.step_render_info ? enc(r.step_render_info, S.RenderInfo) : null,
    step_payload: enc(step, S.Step),
  };
}

// A conversation's step writers, all sharing its cascade id and trajectory id.
export function conversation(sid) {
  const traj = crypto.createHash('sha256').update(`traj:${sid}`).digest('hex').replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*/, '$1-$2-4$3-8$4-$5');
  const m = (x) => ({ cascade: sid, traj, ...x });
  return {
    sid,
    traj,
    user: (idx, x, text, extra = {}) => stepRow(idx, TYPE.USER_INPUT, STATUS.DONE, m({ source: SOURCE.USER_EXPLICIT, ...x }), {
      user_input: { user_response: text, items: [{ text }], ...extra, _raw: [[12, Buffer.from('CascadeConfig trimmed')]] },
    }),
    planner: (idx, x, { text, thinking, redacted, calls, status = STATUS.DONE }) => stepRow(idx, TYPE.PLANNER, status, m(x), {
      planner_response: {
        response: text, modified_response: text, thinking, thinking_redacted: redacted, tool_calls: calls, message_id: `bot-${x.id}`,
        _raw: thinking || redacted ? [[14, Buffer.from(SIG)]] : [],
      },
    }),
    generic: (idx, x, status, result, extra = {}) => stepRow(idx, TYPE.GENERIC, status, m(x), {
      generic: { result: { result, ...extra.result } },
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.task_details ? { task_details: extra.task_details } : {}),
    }),
    system: (idx, x, sm) => stepRow(idx, TYPE.SYSTEM, STATUS.DONE, m({ source: SOURCE.SYSTEM_SDK, ...x }), { system_message: sm }),
    ephemeral: (idx, x, content) => stepRow(idx, TYPE.EPHEMERAL, STATUS.DONE, m({ source: SOURCE.SYSTEM_SDK, ...x }), { ephemeral_message: { content } }),
    checkpoint: (idx, x, cp) => stepRow(idx, TYPE.CHECKPOINT, STATUS.DONE, m({ source: SOURCE.SYSTEM, ...x }), {
      checkpoint: { ...cp, _raw: [[26, Buffer.from('accumulated_sections')]] },
    }),
  };
}

export const genRow = (idx, stepIdx, exec, u, more = {}) => ({
  idx,
  data: enc({
    chat_model: {
      model: 1417, usage: u, response_model: 'gemini-4-argon', model_display_name: 'Gemini 4 Argon (High)', ...more,
      _raw: [[1, Buffer.from('system prompt trimmed')], [2, Buffer.from('message prompts trimmed')]],
    },
    step_indices: [stepIdx], execution_id: exec,
    _raw: [[3, Buffer.from('planner config trimmed')]],
  }, S.GenMeta),
});
export const execRow = (idx, exec, lastIdx, reason = 4) => ({ idx, data: enc({ termination_reason: reason, last_step_idx: lastIdx, execution_id: exec, _raw: [[10, Buffer.from('cascade config trimmed')]] }, S.ExecMeta) });
export const trajBlob = (t, extra = {}) => enc({
  workspaces: [{ workspace_folder_absolute_uri: CWD_URI, git_root_absolute_uri: CWD_URI, branch_name: 'main' }],
  created_at: t, workspace_uris: [CWD_URI], project_id: 'default-cli-project', ...extra,
}, S.TrajMeta);

// The DDL of a conversation DB and of conversation_summaries.db, agy 1.4.4 (gorm-style).
export const CONV_DDL = [
  'PRAGMA journal_mode=WAL;',
  'CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`));',
  'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));',
  'CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));',
  'CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));',
  'CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));',
  'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`));',
  'CREATE TABLE `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));',
].join('\n') + '\n';
export const SUMMARIES_DDL = [
  'PRAGMA journal_mode=WAL;',
  'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,`group_id` text NOT NULL DEFAULT "",PRIMARY KEY (`conversation_id`));',
].join('\n') + '\n';

const b64 = (buf) => (buf == null ? null : { $b64: Buffer.from(buf).toString('base64') });
const STEP_COLS = ['step_type', 'status', 'metadata', 'error_details', 'task_details', 'render_info', 'step_payload'];

// The statements of one conversation DB, in agy's order.
export function convOps(c, t) {
  const ops = [];
  const add = (sql, params = []) => ops.push({ sql, params });
  const row = (r) => [r.step_type, r.status, b64(r.metadata), b64(r.error_details), b64(r.task_details), b64(r.render_info), b64(r.step_payload)];
  add('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 4, 17)', [c.traj, c.sid]);
  return {
    ops,
    traj: (blob) => add("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)", [b64(blob)]),
    insert: (r) => add(`INSERT INTO steps (idx, ${STEP_COLS.join(', ')}, has_subtrajectory, step_format) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`, [r.idx, ...row(r)]),
    // A step rewritten in place: a status change, a result arriving (spec §2).
    update: (r) => add(`UPDATE steps SET ${STEP_COLS.map((k) => `${k} = ?`).join(', ')} WHERE idx = ?`, [...row(r), r.idx]),
    gen: (g) => add('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)', [g.idx, b64(g.data), g.data.length]),
    exec: (e) => add('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)', [e.idx, b64(e.data)]),
    ref: (idx, data) => add('INSERT INTO parent_references (idx, data) VALUES (?, ?)', [idx, b64(data)]),
    sql: add,
    t,
  };
}

// A summaries row with agy's defaults; `step_count` and `last_modified_time` churn on every step.
export function summaryInsert(id, { title = '', preview = '', parent = '', agent = '', depth = 0, app = 'antigravity-cli', ws = [CWD_URI], steps = 0, at = '2026-10-21 13:15:29.839665704+00:00' } = {}) {
  return {
    sql: 'INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id, agent_name, parent_conversation_id, nesting_depth, last_user_input_time, app_data_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [id, title, preview, steps, at, JSON.stringify(ws), 'CASCADE_RUN_STATUS_IDLE', 'default-cli-project', agent, parent, depth, '0001-01-01 00:00:00+00:00', app],
  };
}
const churn = (id, steps, at) => ({ sql: 'UPDATE conversation_summaries SET step_count = ?, last_modified_time = ? WHERE conversation_id = ?', params: [steps, at, id] });

export const E = (n) => `3eacf7cb-2e3b-4667-b1ed-${String(n).padStart(12, '0')}`;

// ---- the cases --------------------------------------------------------------------------------

export const A = '63e1ede9-38a7-420a-a1da-f43eabc90713';
export const H = 'c3d1e2f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
export const O = '28d30145-9faf-4ea5-94d7-a38b5cc017fa';
export const F = 'fc9eefd9-68ac-4eb7-8acc-d9bcbac38b3d';
export const P = 'ebeea198-9280-4218-ba35-7614e0749736';
export const C = '9df49d75-5429-4f24-aafb-1dd7442838e0';
export const R = '5d0c1f9e-2b3a-4c8d-9e7f-6a5b4c3d2e1f';
export const HUB = 'd6c6acc5-0000-4000-8000-000000000001';

export const ID = (k) => cid(`${k}`);
export const FULL_FIND = `Command exited with code 0.\n\nCommand output:\n${'./toyshop/cart.py\n./toyshop/shelf.py\n./tests/test_cart.py\n./tests/test_shelf.py\n'.repeat(160)}`;
export const SHOWN_FIND = `${FULL_FIND.slice(0, 400)}\nThe tool's output was truncated due to being too long. You can find the full output in a file at file:///home/user/.gemini/antigravity-cli/brain/${A}/.system_generated/steps/18/output.txt`;

function features() {
  const c = conversation(A);
  const o = convOps(c);
  const t = (s) => T0 + Math.round(s * 1000);
  o.traj(trajBlob(T0 - 13000, { root_conversation_id: A }));
  const C1 = call('call_1164701', 'run_command', { CommandLine: 'python3 -m pytest -q', WaitMsBeforeAsync: 5000 });
  const C2 = call('call_322814', 'run_command', { CommandLine: 'rm -rf tests/__pycache__' });
  const C3 = call('toolu_vrtx_FixtureFixtureFixtu00015', 'read_file', { Path: `${CWD}/label.png` });
  const CM = call('call_mcp_1', 'toybox_search', { q: 'robot' });
  const CR = call('call_run_1', 'run_command', { CommandLine: 'find . -name "*.py"' });
  const CL = call('call_mcp_2', 'toybox_list', {});
  const CB = call('call_65144', 'run_command', { CommandLine: 'sleep 25 && node src/cli.js list --json', WaitMsBeforeAsync: 500 });
  const CF = call('call_1164688', 'finish', { toys: ['Rocking horse', 'Spinning top'] });
  const CS = call('call_213908', 'run_command', { CommandLine: 'sleep 90 && echo slept', WaitMsBeforeAsync: 10000 });
  const g = (idx, step, exec, u) => o.gen(genRow(idx, step, exec, u));

  // Turn 1: a prompt, two hook messages, a reasoning reply that runs pytest, the answer.
  o.insert(c.user(0, { t: t(0), exec: E(1), id: ID('U1') }, 'Fix the qty bug in cart.py, then run the tests.'));
  o.insert(c.system(1, { t: t(0.1), exec: E(1), id: ID('SYS1') }, { message: 'The following system message was injected by a SessionStart hook:\ntoyshop hook: session started.', event_type: 'hook_json_SessionStart' }));
  o.insert(c.ephemeral(2, { t: t(0.107), exec: E(1), id: ID('EPH1') }, 'toyshop hook: remember the qty bug in cart.'));
  o.insert(c.planner(3, { t: t(0.11), exec: E(1), id: ID('P1'), gen: 0 }, { thinking: 'Run the tests first.', status: STATUS.GENERATING }));
  const U1 = usage(6889, 206, 'urvYaqmoJdCG28oP2-af0AY', { thinking_output_tokens: 179, response_output_tokens: 27 });
  o.update(c.planner(3, { t: t(0.11), exec: E(1), id: ID('P1'), gen: 0, usage: U1 }, { thinking: 'Run the tests first.', calls: [C1] }));
  g(0, 3, E(1), U1);
  o.insert(c.generic(4, { t: t(9.5), exec: E(1), id: ID('G1'), call: C1 }, STATUS.RUNNING, ''));
  o.update(c.generic(4, { t: t(9.5), exec: E(1), id: ID('G1'), call: C1 }, STATUS.DONE, 'Command exited with code 1.\n\n1 failed, 2 passed', { result: { payload: anyOf('RunCommand', { exit_code: 1 }) } }));
  const U2 = usage(2393, 108, '8rrYavX9B-CFvdIP95SEsQU', { cache_read_tokens: 4331 });
  o.insert(c.planner(5, { t: t(9.6), exec: E(1), id: ID('P2'), gen: 1, usage: U2 }, { text: 'The total ignores qty; fixed it and the tests pass.' }));
  g(1, 5, E(1), U2);
  o.exec(execRow(0, E(1), 5));

  // Turn 2: a denied command.
  o.insert(c.user(6, { t: t(60), exec: E(2), id: ID('U2') }, 'Remove the tests/__pycache__ directory.'));
  const U3 = usage(6380, 67, 'resp-feat-07');
  o.insert(c.planner(7, { t: t(60.1), exec: E(2), id: ID('P3'), gen: 2, usage: U3 }, { calls: [C2] }));
  g(2, 7, E(2), U3);
  const denied = 'permission check failed for unsandboxed "rm -rf tests/__pycache__": user denied permission to run command:\nrm -rf tests/__pycache__\nDo not attempt to circumvent this denial by rephrasing the command, using alternative tools/scripts (e.g. python, sh, curl), or accessing the same target resource. Proceed without performing this action.';
  o.insert(c.generic(8, { t: t(61), exec: E(2), id: ID('G2'), call: C2 }, STATUS.WAITING, ''));
  o.update(c.generic(8, { t: t(61), exec: E(2), id: ID('G2'), call: C2 }, STATUS.ERROR, '', { error: { short_error: denied, full_error: denied } }));
  const U4 = usage(6500, 12, 'resp-feat-09');
  o.insert(c.planner(9, { t: t(62), exec: E(2), id: ID('P4'), gen: 3, usage: U4 }, { text: 'Skipped: permission was denied.' }));
  g(3, 9, E(2), U4);
  o.exec(execRow(1, E(2), 9));

  // Turn 3: a tool that reads an image.
  o.insert(c.user(10, { t: t(120), exec: E(3), id: ID('U3') }, 'Describe this image in one sentence: @[label.png]'));
  const U5 = usage(7000, 30, 'resp-feat-11');
  o.insert(c.planner(11, { t: t(120.1), exec: E(3), id: ID('P5'), gen: 4, usage: U5 }, { calls: [C3] }));
  g(4, 11, E(3), U5);
  o.insert(c.generic(12, { t: t(121), exec: E(3), id: ID('G3'), call: C3 }, STATUS.DONE, 'Showing binary file of type image/png', { result: { media: [{ mime_type: 'image/png', inline_data: Buffer.from('PNG!') }] } }));
  const U6 = usage(7400, 9, 'resp-feat-13');
  o.insert(c.planner(13, { t: t(122), exec: E(3), id: ID('P6'), gen: 5, usage: U6 }, { text: 'A price label reading 2.50.' }));
  g(5, 13, E(3), U6);
  o.exec(execRow(2, E(3), 13));

  // Turn 4: /compact. The checkpoint's usage sits in retry_infos and in its generation.
  o.insert(c.user(14, { t: t(180), exec: E(4), id: ID('U4') }, '/compact'));
  const UC = usage(2633, 788, 'X4bXasqpCPmAxs0PwuyouA8', { cache_read_tokens: 23126 });
  o.insert(c.checkpoint(15, { t: t(180.1), exec: E(4), id: ID('CK1'), gen: 6, retry: [{ usage: UC }] }, { session_summary: 'Fixed qty; tests pass; rm was denied; the label reads 2.50.', included_step_index_end: 15 }));
  g(6, 15, E(4), UC);
  o.exec(execRow(3, E(4), 15));

  // Turn 5: an MCP tool, a nested legacy step naming its server, a result agy cut (output.txt).
  o.insert(c.user(16, { t: t(240), exec: E(5), id: ID('U5') }, 'Search the toybox catalogue for robots, list its shelves, and find every python file.'));
  const U7 = usage(8100, 64, 'resp-feat-17');
  o.insert(c.planner(17, { t: t(240.1), exec: E(5), id: ID('P7'), gen: 7, usage: U7 }, { calls: [CM, CR, CL] }));
  g(7, 17, E(5), U7);
  o.insert(c.generic(18, { t: t(241), exec: E(5), id: ID('G4'), call: CR }, STATUS.DONE, SHOWN_FIND, { result: { full_output_uri: `file:///home/user/.gemini/antigravity-cli/brain/${A}/.system_generated/steps/18/output.txt`, payload: anyOf('RunCommand', {}) } }));
  o.insert(c.generic(19, { t: t(242), exec: E(5), id: ID('G5'), call: CM }, STATUS.DONE, 'three robots', { result: { full_output_uri: `file:///home/user/.gemini/antigravity-cli/brain/${A}/.system_generated/steps/19/output.txt`, tool_call_step: { mcp_server_tool_call: { name: 'search', server_name: 'toybox' } } } }));
  const nested = { type_url: 'type.googleapis.com/gemini_coder.Step', value: enc({ type: 38, mcp_tool: { server_name: 'legacy-box' } }, S.Step) };
  o.insert(c.generic(20, { t: t(243), exec: E(5), id: ID('G6'), call: CL }, STATUS.DONE, 'two shelves', { result: { payload: nested } }));
  const U8 = usage(8600, 25, 'resp-feat-21');
  o.insert(c.planner(21, { t: t(244), exec: E(5), id: ID('P8'), gen: 8, usage: U8 }, { text: 'Three robots on two shelves, and four python files.' }));
  g(8, 21, E(5), U8);
  o.exec(execRow(4, E(5), 21));

  // Turn 6: a background task; the turn ends while it runs. Turn 7: it finishes, and its
  // notification starts a turn for the agent.
  o.insert(c.user(22, { t: t(300), exec: E(6), id: ID('U6') }, 'Run the slow listing in the background.'));
  const U9 = usage(8800, 40, 'resp-feat-23');
  o.insert(c.planner(23, { t: t(300.1), exec: E(6), id: ID('P9'), gen: 9, usage: U9 }, { calls: [CB] }));
  g(9, 23, E(6), U9);
  const task = { id: `${A}/task-24`, description: 'sleep 25 && node src/cli.js list --json', title: 'Run delayed CLI JSON list' };
  o.insert(c.generic(24, { t: t(301), exec: E(6), id: ID('G7'), call: CB }, STATUS.RUNNING, '', { task_details: task }));
  const U10 = usage(9000, 12, 'resp-feat-25');
  o.insert(c.planner(25, { t: t(302), exec: E(6), id: ID('P10'), gen: 10, usage: U10 }, { text: 'Started it in the background.' }));
  g(10, 25, E(6), U10);
  o.exec(execRow(5, E(6), 25));
  o.update(c.generic(24, { t: t(301), exec: E(6), id: ID('G7'), call: CB }, STATUS.DONE, 'Command exited with code 0.\n\nCommand output:\n[]', { task_details: task, result: { payload: anyOf('RunCommand', {}) } }));
  o.insert(c.system(26, { t: t(330), exec: E(7), id: ID('TASK'), source: SOURCE.SYSTEM }, {
    message: `[Message] timestamp=2026-10-21T13:20:59Z sender=${A}/task-24 priority=MESSAGE_PRIORITY_HIGH content=Task finished`,
    event_type: 'task_notification', agent_message: { sender: `${A}/task-24`, recipient: A, content: 'Task finished' },
  }));
  const U11 = usage(9100, 14, 'resp-feat-27');
  o.insert(c.planner(27, { t: t(331), exec: E(7), id: ID('P11'), gen: 11, usage: U11 }, { text: 'The listing finished: no toys yet.' }));
  g(11, 27, E(7), U11);
  o.exec(execRow(6, E(7), 27));

  // Turn 8: after a resume, a hidden restart notice; a SYSTEM user input; redacted reasoning and
  // the
  // `finish` tool of --json-schema (lab case: call_1164688).
  o.insert(c.system(28, { t: t(400), exec: E(8), id: ID('RESTART'), source: SOURCE.SYSTEM }, {
    message: '[Message] timestamp=2026-10-21T13:22:09Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.',
    render_info: { hidden: true }, agent_message: { sender: 'system', recipient: A, content: '[Notice] All your subagents and background tasks have been stopped due to server restart.', hide_from_user: true },
  }));
  o.insert(c.user(29, { t: t(400.1), exec: E(8), id: ID('SYSUSER'), source: SOURCE.SYSTEM }, 'Continue with the goal.'));
  const U12 = usage(6692, 209, 'resp-feat-30', { thinking_output_tokens: 181, response_output_tokens: 28 });
  o.insert(c.planner(30, { t: t(401), exec: E(8), id: ID('P12'), gen: 12, usage: U12 }, { redacted: true, calls: [CF] }));
  g(12, 30, E(8), U12);
  o.insert(c.generic(31, { t: t(406), exec: E(8), id: ID('G8'), call: CF }, STATUS.DONE, 'Task is complete. Summarize what you did and do not call any more tools.'));
  o.exec(execRow(7, E(8), 31));

  // Turn 9: a command the user interrupted: CANCELED, no result, the turn ends.
  o.insert(c.user(32, { t: t(500), exec: E(9), id: ID('U9') }, 'Sleep 90 seconds, then say done.'));
  const U13 = usage(9300, 20, 'resp-feat-33');
  o.insert(c.planner(33, { t: t(500.1), exec: E(9), id: ID('P13'), gen: 13, usage: U13 }, { calls: [CS] }));
  g(13, 33, E(9), U13);
  o.insert(c.generic(34, { t: t(501), exec: E(9), id: ID('G9'), call: CS }, STATUS.RUNNING, ''));
  o.update(c.generic(34, { t: t(501), exec: E(9), id: ID('G9'), call: CS }, STATUS.CANCELED, ''));
  o.exec(execRow(8, E(9), 34, 2));

  // H: its last turn still runs (no executor row): the planner waits on its tool. A hook notice
  // written meanwhile is not held.
  const h = conversation(H);
  const oh = convOps(h);
  const th = (s) => T0 + 3600000 + Math.round(s * 1000);
  oh.traj(trajBlob(th(-5), { root_conversation_id: H, workspaces: [{ workspace_folder_absolute_uri: 'file:///home/user/work/ag3/inventory-cli', branch_name: 'main' }], workspace_uris: ['file:///home/user/work/ag3/inventory-cli'] }));
  const CH = call('call_held_1', 'run_command', { CommandLine: 'ls' });
  oh.insert(h.user(0, { t: th(0), exec: E(20), id: ID('HU') }, 'List the files, please.'));
  const UH = usage(5000, 30, 'resp-held-01');
  oh.insert(h.planner(1, { t: th(0.1), exec: E(20), id: ID('HP'), gen: 0, usage: UH }, { calls: [CH] }));
  oh.gen(genRow(0, 1, E(20), UH));
  oh.insert(h.generic(2, { t: th(1), exec: E(20), id: ID('HG'), call: CH }, STATUS.RUNNING, ''));
  oh.insert(h.ephemeral(3, { t: th(2), exec: E(20), id: ID('HE') }, 'toyshop hook: the listing is running.'));

  const sums = [
    summaryInsert(A, { title: 'Floating qty fix', preview: 'Fix the qty bug in cart.py, then run the tests.', steps: 1 }),
    summaryInsert(HUB, { title: 'A hub conversation', app: 'antigravity', ws: [] }),
    churn(A, 16, '2026-10-21 13:18:29.839665704+00:00'),
    churn(A, 35, '2026-10-21 13:23:30.139665704+00:00'),
  ];
  return {
    dbs: { [`conversations/${A}.db`]: [CONV_DDL, o.ops], [`conversations/${H}.db`]: [CONV_DDL, oh.ops], 'conversation_summaries.db': [SUMMARIES_DDL, sums] },
    files: {
      [`brain/${A}/.system_generated/steps/18/output.txt`]: FULL_FIND,
      // Not a spill: the step holds the whole text (an output.txt no longer than it).
      [`brain/${A}/.system_generated/steps/19/output.txt`]: 'three robots',
      [`annotations/${H}.pbtxt`]: 'title:"Inventory \\303\\266 check"\narchived:true\npinned:true\n',
    },
  };
}

function fork() {
  const co = conversation(O);
  const oo = convOps(co);
  const t = (s) => Date.UTC(2026, 9, 20, 15, 1, 45) + Math.round(s * 1000);
  oo.traj(trajBlob(t(-10), { root_conversation_id: O, workspaces: [{ workspace_folder_absolute_uri: 'file:///home/user/work/ag2/toyshop', branch_name: 'main' }], workspace_uris: ['file:///home/user/work/ag2/toyshop'] }));
  const CLS = call('call_183812', 'run_command', { CommandLine: 'ls -la', WaitMsBeforeAsync: 5000 });
  const steps = [
    co.user(0, { t: t(0), exec: E(31), id: 'd73f3a6b86234161ae0beecfccd94d99' }, 'What is in toyshop/? Briefly describe the cart module and the tests.'),
    co.planner(1, { t: t(5), exec: E(31), id: ID('OP1'), gen: 0, usage: usage(6100, 40, 'resp-orig-01') }, { calls: [CLS] }),
    co.generic(2, { t: t(6), exec: E(31), id: '04978e7d52ed47febf62f8115f161f35', call: CLS }, STATUS.DONE, 'Command exited with code 0.\n\nCommand output:\ntotal 36\ndrwxrwxr-x 6 user user 4096 Oct 20 14:24 .\n-rw-rw-r-- 1 user user  812 Oct 20 14:24 cart.py\ndrwxrwxr-x 2 user user 4096 Oct 20 14:24 tests', { result: { payload: anyOf('RunCommand', {}) } }),
    co.planner(3, { t: t(9), exec: E(31), id: ID('OP2'), gen: 1, usage: usage(6400, 52, 'resp-orig-03') }, { text: 'toyshop/ holds cart.py (a Cart whose total ignores qty) and tests/test_cart.py (three tests).' }),
    co.user(4, { t: t(60), exec: E(32), id: ID('OU2') }, 'Which test checks the quantity?'),
    co.planner(5, { t: t(62), exec: E(32), id: ID('OP3'), gen: 2, usage: usage(6600, 18, 'resp-orig-05') }, { text: 'test_total_uses_qty, in tests/test_cart.py.' }),
  ];
  const gens = [genRow(0, 1, E(31), usage(6100, 40, 'resp-orig-01')), genRow(1, 3, E(31), usage(6400, 52, 'resp-orig-03')), genRow(2, 5, E(32), usage(6600, 18, 'resp-orig-05'))];
  const execs = [execRow(0, E(31), 3), execRow(1, E(32), 5)];
  for (const s of steps.slice(0, 4)) oo.insert(s);
  oo.gen(gens[0]);
  oo.gen(gens[1]);
  oo.exec(execs[0]);
  for (const s of steps.slice(4)) oo.insert(s);
  oo.gen(gens[2]);
  oo.exec(execs[1]);

  // The fork copies the origin's rows verbatim (their cascade_id stays the origin's, spec §5), then
  // goes on with its own. parent_references names the origin and the fork point.
  const cf = conversation(F);
  const of = convOps(cf);
  of.traj(trajBlob(t(600), { root_conversation_id: F, workspaces: [{ workspace_folder_absolute_uri: 'file:///home/user/work/ag2/toyshop', branch_name: 'main' }], workspace_uris: ['file:///home/user/work/ag2/toyshop'] }));
  of.ref(0, enc({ trajectory_id: co.traj, step_index: 5, trajectory_type: 4, step_type: 15, reference_type: 2, conversation_id: O }, S.TrajRef));
  for (const s of steps) of.insert(s);
  for (const g of gens) of.gen(g);
  for (const e of execs) of.exec(e);
  of.insert(cf.user(6, { t: t(612), exec: E(33), id: ID('FU') }, 'In the fork: reply with just the word forked.'));
  const UF = usage(66485, 6, 'resp-fork-07');
  of.insert(cf.planner(7, { t: t(612.5), exec: E(33), id: ID('FP'), gen: 3, usage: UF }, { text: 'Synthe' }));
  of.gen(genRow(3, 7, E(33), UF));
  of.exec(execRow(2, E(33), 7));

  const sums = [
    summaryInsert(O, { title: 'Toyshop tour', preview: 'What is in toyshop/? Briefly describe the cart module and the tests.', ws: ['file:///home/user/work/ag2/toyshop'], steps: 6 }),
    // A fork's summaries row names no parent (spec §3).
    summaryInsert(F, { preview: 'What is in toyshop/? Briefly describe the cart module and the tests.', ws: ['file:///home/user/work/ag2/toyshop'], steps: 8 }),
  ];
  return { dbs: { [`conversations/${O}.db`]: [CONV_DDL, oo.ops], [`conversations/${F}.db`]: [CONV_DDL, of.ops], 'conversation_summaries.db': [SUMMARIES_DDL, sums] }, files: {} };
}

function subagent() {
  const t = (s) => Date.UTC(2026, 9, 21, 13, 5, 0) + Math.round(s * 1000);
  const cp = conversation(P);
  const op = convOps(cp);
  op.traj(trajBlob(t(-5), { root_conversation_id: P }));
  const INV = call('call_1677305', 'invoke_subagent', { Prompt: 'Find which test in `tests/` checks item quantity.', Role: 'Test Researcher', TypeName: 'research' });
  const SEND = call('call_1675669', 'send_message', { Message: '`test_total_uses_qty` in `tests/test_cart.py` (lines 4-7)', Recipient: P });
  op.insert(cp.user(0, { t: t(0), exec: E(40), id: ID('PU') }, 'Delegate finding the qty test to a research subagent.'));
  const UP = usage(6000, 40, 'resp-par-01');
  op.insert(cp.planner(1, { t: t(1), exec: E(40), id: ID('PP1'), gen: 0, usage: UP }, { calls: [INV] }));
  op.gen(genRow(0, 1, E(40), UP));
  op.insert(cp.generic(2, { t: t(29), exec: E(40), id: ID('PG'), call: INV }, STATUS.DONE, `Created the following subagent:\n{"conversationId": "${C}"}`, { result: { payload: anyOf('InvokeSubagent', { results: [{ conversation_id: C }, { conversation_id: C }] }) } }));
  const UP2 = usage(6200, 22, 'resp-par-03');
  op.insert(cp.planner(3, { t: t(30), exec: E(40), id: ID('PP2'), gen: 1, usage: UP2 }, { text: 'A research subagent is looking for it.' }));
  op.gen(genRow(1, 3, E(40), UP2));
  op.exec(execRow(0, E(40), 3));
  op.insert(cp.system(4, { t: t(78), exec: E(41), id: ID('PMSG'), source: SOURCE.SYSTEM }, {
    message: `[Message] timestamp=2026-10-21T13:06:18Z sender=${C} priority=MESSAGE_PRIORITY_NORMAL content=\`test_total_uses_qty\` in \`tests/test_cart.py\` (lines 4-7)`,
    event_type: 'agent_message',
    agent_message: { id: 'msg-2', sender: C, recipient: P, content: '`test_total_uses_qty` in `tests/test_cart.py` (lines 4-7)', source_metadata: { tool: { conversation_id: C, step_index: 3, tool_call: SEND } } },
  }));
  const UP3 = usage(6900, 31, 'resp-par-05');
  op.insert(cp.planner(5, { t: t(80), exec: E(41), id: ID('PP3'), gen: 2, usage: UP3 }, { text: 'The qty test is test_total_uses_qty in tests/test_cart.py, lines 4-7.' }));
  op.gen(genRow(2, 5, E(41), UP3));
  op.exec(execRow(1, E(41), 5));

  // The child: its own cascade, whose trajectory metadata names the parent (spec §5). The prompt
  // it receives carries the parent's invoke_subagent call.
  const cc = conversation(C);
  const oc = convOps(cc);
  oc.traj(trajBlob(t(2), { root_conversation_id: P, parent_conversation_id: P, nesting_depth: 1 }));
  oc.insert(cc.system(0, { t: t(2), exec: E(42), id: ID('CS0') }, { message: 'The following system message was injected by a SessionStart hook:\ntoyshop hook: session started.', event_type: 'hook_json_SessionStart' }));
  oc.insert(cc.system(1, { t: t(2.1), exec: E(42), id: ID('CS1'), source: SOURCE.SYSTEM }, {
    message: `[Message] timestamp=2026-10-21T13:05:02Z sender=${P} priority=MESSAGE_PRIORITY_NORMAL content=Find which test in \`tests/\` checks item quantity.`,
    event_type: 'agent_message',
    agent_message: { id: 'msg-1', sender: P, recipient: C, content: 'Find which test in `tests/` checks item quantity.', source_metadata: { tool: { conversation_id: P, step_index: 1, tool_call: INV } } },
  }));
  const UC1 = usage(2393, 108, 'resp-child-02', { cache_read_tokens: 4331 });
  oc.insert(cc.planner(2, { t: t(70), exec: E(42), id: ID('CP1'), gen: 0, usage: UC1 }, { calls: [SEND] }));
  oc.gen(genRow(0, 2, E(42), UC1));
  oc.insert(cc.generic(3, { t: t(76), exec: E(42), id: ID('CG'), call: SEND }, STATUS.DONE, `Message sent to "${P}".`));
  const UC2 = usage(2271, 37, 'resp-child-04', { cache_read_tokens: 4675 });
  oc.insert(cc.planner(4, { t: t(78), exec: E(42), id: ID('CP2'), gen: 1, usage: UC2 }, { text: 'Synthetic reply df556e. synthetic reply text for the toy shop fixture synthet' }));
  oc.gen(genRow(1, 4, E(42), UC2));
  oc.exec(execRow(0, E(42), 4));

  const sums = [
    summaryInsert(P, { title: 'Delegated qty test', preview: 'Delegate finding the qty test to a research subagent.', steps: 6 }),
    summaryInsert(C, { agent: 'research', parent: P, depth: 1, steps: 5 }),
  ];
  return { dbs: { [`conversations/${P}.db`]: [CONV_DDL, op.ops], [`conversations/${C}.db`]: [CONV_DDL, oc.ops], 'conversation_summaries.db': [SUMMARIES_DDL, sums] }, files: {} };
}

function rewind() {
  const t = (s) => Date.UTC(2026, 9, 20, 15, 10, 0) + Math.round(s * 1000);
  const c = conversation(R);
  const o = convOps(c);
  o.traj(trajBlob(t(-3), { root_conversation_id: R }));
  const CT = call('call_402211', 'run_command', { CommandLine: 'python3 -m pytest -q' });
  const u = (i, n, rid) => usage(i, n, rid);
  o.insert(c.user(0, { t: t(0), exec: E(50), id: ID('RU1') }, 'Fix the qty bug in cart.py.'));
  o.insert(c.planner(1, { t: t(3), exec: E(50), id: ID('RP1'), gen: 0, usage: u(6000, 20, 'resp-rw-01') }, { text: 'Fixed: the total multiplies by qty.' }));
  o.gen(genRow(0, 1, E(50), u(6000, 20, 'resp-rw-01')));
  o.exec(execRow(0, E(50), 1));
  o.insert(c.user(2, { t: t(60), exec: E(51), id: ID('RU2') }, 'Now add a coupon code TOY10.'));
  o.insert(c.planner(3, { t: t(62), exec: E(51), id: ID('RP2'), gen: 1, usage: u(6200, 30, 'resp-rw-03') }, { calls: [CT] }));
  o.gen(genRow(1, 3, E(51), u(6200, 30, 'resp-rw-03')));
  o.insert(c.generic(4, { t: t(65), exec: E(51), id: ID('RG'), call: CT }, STATUS.DONE, 'Command exited with code 0.\n\n3 passed'));
  o.insert(c.planner(5, { t: t(66), exec: E(51), id: ID('RP3'), gen: 2, usage: u(6400, 15, 'resp-rw-05') }, { text: 'Added TOY10; the tests pass.' }));
  o.gen(genRow(2, 5, E(51), u(6400, 15, 'resp-rw-05')));
  o.exec(execRow(1, E(51), 5));
  o.insert(c.user(6, { t: t(120), exec: E(52), id: ID('RU3') }, 'Which model are you?'));
  o.insert(c.planner(7, { t: t(121), exec: E(52), id: ID('RP4'), gen: 3, usage: u(6500, 9, 'resp-rw-07') }, { text: 'Gemini 4 Argon.' }));
  o.gen(genRow(3, 7, E(52), u(6500, 9, 'resp-rw-07')));
  o.exec(execRow(2, E(52), 7));
  // The rewind to step 2: agy hard-deletes the rows from there and reuses their idx (spec §6).
  o.sql('DELETE FROM steps WHERE idx >= ?', [2]);
  o.sql('DELETE FROM gen_metadata WHERE idx >= ?', [1]);
  o.sql('DELETE FROM executor_metadata WHERE idx >= ?', [1]);
  o.insert(c.user(2, { t: t(300), exec: E(53), id: ID('RU2b') }, 'Instead, add a coupon code TOY20.'));
  o.insert(c.planner(3, { t: t(302), exec: E(53), id: ID('RP2b'), gen: 1, usage: u(9000, 20, 'resp-rw-03b') }, { text: 'Added TOY20.' }));
  o.gen(genRow(1, 3, E(53), u(9000, 20, 'resp-rw-03b')));
  o.exec(execRow(1, E(53), 3));

  // The transcript keeps the rewound lines and appends the new ones from step_index 2.
  const iso = (s) => new Date(t(s)).toISOString().replace(/\.\d+Z$/, 'Z');
  const req = (s, at) => `<USER_REQUEST>\n${s}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${at}.\n</ADDITIONAL_METADATA>`;
  const lines = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(0), content: req('Fix the qty bug in cart.py.', '2026-10-20T15:10:00+00:00') },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(3), input_tokens: 6000, cache_read_tokens: 0, output_tokens: 20, content: 'Fixed: the total multiplies by qty.' },
    { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(60), content: req('Now add a coupon code TOY10.', '2026-10-20T15:11:00+00:00') },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(62), input_tokens: 6200, cache_read_tokens: 0, output_tokens: 30, tool_calls: [{ name: 'run_command', args: { CommandLine: 'python3 -m pytest -q' } }] },
    { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(65), content: 'Command exited with code 0.\n\n3 passed' },
    { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(66), input_tokens: 6400, cache_read_tokens: 0, output_tokens: 15, content: 'Added TOY10; the tests pass.' },
    { step_index: 6, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(120), content: req('Which model are you?', '2026-10-20T15:12:00+00:00') },
    { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(121), input_tokens: 6500, cache_read_tokens: 0, output_tokens: 9, content: 'Gemini 4 Argon.' },
    { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(300), content: req('Instead, add a coupon code TOY20.', '2026-10-20T15:15:00+00:00') },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(302), input_tokens: 9000, cache_read_tokens: 0, output_tokens: 20, content: 'Added TOY20.' },
  ];
  const sums = [summaryInsert(R, { title: 'Coupon codes', preview: 'Fix the qty bug in cart.py.', steps: 4 })];
  return {
    dbs: { [`conversations/${R}.db`]: [CONV_DDL, o.ops], 'conversation_summaries.db': [SUMMARIES_DDL, sums] },
    files: { [`brain/${R}/.system_generated/logs/transcript_full.jsonl`]: lines.map((l) => JSON.stringify(l) + '\n').join('') },
  };
}

// The summaries rows of the three DB-less transcripts in transcript/store/ (the scrubbed lab rows
// of fc9eefd9 and 9df49d75; e96784d2, a headless run, had none captured, so its row is invented).
function transcript() {
  const sums = [
    summaryInsert(F, { preview: 'What is in toyshop/? Briefly describe the cart module and the tests.', ws: ['file:///home/user/work/ag2/toyshop'], steps: 46, at: '2026-10-20 15:20:44.218443004+00:00' }),
    summaryInsert(C, { agent: 'research', parent: P, depth: 1, steps: 13, at: '2026-10-21 13:06:24.534130154+00:00' }),
    summaryInsert('e96784d2-85ca-49f8-97c0-b271bfad1510', { title: 'Two wooden toys', preview: 'Name two classic wooden toys.', steps: 3, at: '2026-10-21 13:18:56.391665704+00:00' }),
  ];
  return { dbs: { 'conversation_summaries.db': [SUMMARIES_DDL, sums] }, files: null };
}

function writeCase(name, { dbs, files }) {
  const dir = path.join(HERE, name);
  fs.rmSync(path.join(dir, 'store-sql'), { recursive: true, force: true });
  if (files !== null) fs.rmSync(path.join(dir, 'store'), { recursive: true, force: true });
  for (const [rel, [schema, ops]] of Object.entries(dbs)) {
    const base = path.join(dir, 'store-sql', rel);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(`${base}.schema.sql`, schema);
    fs.writeFileSync(`${base}.ops.jsonl`, ops.map((x) => JSON.stringify(x) + '\n').join(''));
  }
  for (const [rel, text] of Object.entries(files ?? {})) {
    const file = path.join(dir, 'store', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeCase('features', features());
  writeCase('fork', fork());
  writeCase('subagent', subagent());
  writeCase('rewind', rewind());
  writeCase('transcript', transcript());
  console.log('agy fixtures written');
}
