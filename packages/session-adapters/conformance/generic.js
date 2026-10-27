// The checklist items that hold for every harness the same way, checked over one fixture store.
// Each check returns findings (strings); none means the item holds on that store. The matrix
// (conformance/matrix.js) marks these items `generic`, and test/conformance-matrix.test.js runs
// them over every fixture case of every adapter.

import { MiniEngine } from './engine.js';
import { fullReplay, storeOf, project } from './runner.js';
import { validateSession } from '../src/validate.js';

// sessions-model §2.4's table: what each harness's `input` and `output` count.
export const USAGE_FLAGS = {
  'claude-code': [false, true],
  codex: [true, true],
  'gemini-cli': [true, false],
};
// OpenCode: v1 messages false/false, v2 null/null; every other harness null/null.

// Results whose call the session does not hold, each for a reason the fixture shows on purpose:
// harness, then session, then call_id. Any other result must answer a call of its session
// (M.tool-linkage), so an orphan in any other session of the same harness is still a finding.
export const ORPHAN_RESULTS = {
  // The call was lost in the store (gemini-cli/features is built for it: a result after a
  // $rewindTo dropped its request).
  'gemini-cli': {
    '7f3e9a10-5c2d-4b8e-9f01-2a3b4c5d6e7f': { lost_call_1: 'the call was lost', lost_call_2: 'the call was lost' },
  },
  // A denied call VS Code's agent host logged only as permission.completed and
  // tool.execution_complete (copilot-cli/vscode-host): the store holds no request for it.
  'copilot-cli': {
    '92b4b5fb-3d26-4492-9722-6d6e3bcaf8aa': { call_FixtureFixtureFixtu00018: 'a denied call the store logs without its request' },
  },
  // The call's reply is held while its tool runs (sessions §2, held), so the session's view has
  // the result of an earlier turn's call only (devin/features).
  devin: {
    'gentle-harvest': { call_c23e6047d44d58e326078e2f: 'its call is in a reply held at the tail while its other call runs' },
  },
};

// Results whose `is_error` is true beside a non-zero `exit_code`, each because the harness store
// keeps a failure flag for it: harness, then session, then call_id, then the flag. A non-zero
// `exit_code` alone never makes `is_error` true (sessions-model v1.x proposal (#6), §2.3), so a true beside
// one anywhere else is a finding (M.is-error). The harness's own tests show each flag (the
// matrix's M.is-error cell names them).
export const FAILURE_FLAGS = {
  cursor: {
    'c0c0a001-0000-4000-8000-000000000001': { 'call-ca11ca02-0000-4000-8000-000000000002-1\nfc_fc0fc002-0000-4000-8000-000000000002_0': 'additionalData.status error' },
    '5a5a0009-0009-4000-8000-000000000009': { 'call-5a5a0019-0019-4000-8000-000000000019-9\nfc_5a5a001a-001a-4000-8000-00000000001a_0': 'additionalData.status error' },
  },
  'cursor-agent': {
    'c4a1e0de-5a7e-4000-8000-000000000001': { 'call-00c41679-5a7e-4f00-8000-00000000c0de-2\nfc_synth02-0Synth-00000002-syn_th1_2': 'ShellFailure, and the model context\'s isError true' },
  },
  goose: {
    '20261021_1': { 'call-1': 'isError true' },
    '20261021_8': { 'call-1': 'isError true' },
  },
};

// The usage each harness declares (sessions-model annex, finding 6, and each describe.js): the
// granularities and anchor kinds its records may carry. cursor-agent stores no usage; no adapter
// emits per_record (§2.4).
export const USAGE_SHAPE = {
  'claude-code': [['per_response'], ['response_id']],
  codex: [['per_turn'], ['response_id', 'message_id']],
  'copilot-cli': [['per_response', 'per_turn'], ['response_id', 'compaction']],
  'gemini-cli': [['per_response'], ['message_id']],
  vscode: [['per_turn'], ['message_id', 'response_id']],
  goose: [['per_response'], ['message_id', 'compaction', 'session']],
  opencode: [['per_message'], ['message_id']],
  agy: [['per_response'], ['response_id', 'message_id']],
  cursor: [['per_message'], ['message_id']],
  'cursor-agent': [[], []],
  // per_turn from request_token_usage only where cumulative_token_usage is empty (sessions-model
  // v1.x proposal (#6), §2.4).
  zed: [['per_session', 'per_turn'], ['session', 'message_id']],
  devin: [['per_response'], ['message_id']],
};
const OTHER_HOST = 'ffffffffffffffffffffffffffffffff';
const COUNTERS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'tool_prompt', 'cost'];

const recordsOf = (view) => [...view.values()];

export function genericChecks(adapter, harnessPath) {
  const h = adapter.HARNESS;
  const found = {};
  const add = (item, msg) => (found[item] ??= []).push(msg);

  const e = fullReplay(adapter, harnessPath);
  const views = e.views();

  // The record shape (sessions-model §2), behind every item that reads records. A registry warning
  // counts here too: a consumer accepts an unknown value, but this package emits only values the
  // contract has registered.
  for (const [sid, view] of Object.entries(views)) {
    for (const f of validateSession(recordsOf(view), { harness: h, sessionId: sid })) add('shape', `${sid}: ${f.at}: ${f.problem}`);
  }

  // M.keys-stable: a second fresh replay, as after a lost state, gives identical records.
  if (JSON.stringify(project(fullReplay(adapter, harnessPath).views())) !== JSON.stringify(project(views))) {
    add('M.keys-stable', 'a second replay from empty state gives different records');
  }

  // M.one-store-one-session: the same files under another host are other sessions.
  const other = new MiniEngine(adapter, { ...storeOf(adapter, harnessPath), host: OTHER_HOST });
  other.pass();
  const otherViews = other.views();
  for (const sid of Object.keys(views)) {
    const recs = recordsOf(otherViews[sid] ?? new Map());
    if (!recs.length) add('M.one-store-one-session', `${sid}: not derived under a second host`);
    else if (recs.some((r) => r.host !== OTHER_HOST)) add('M.one-store-one-session', `${sid}: a record under the second host names another host`);
  }

  // S.unchanged: a further pass over the same store reads unchanged everywhere, with no units.
  e.pass();
  for (const l of e.log) {
    if (l.continuity !== 'unchanged') add('S.unchanged', `${l.session_id} ${l.source_key}: ${l.continuity}`);
    if (l.units) add('S.unchanged', `${l.session_id} ${l.source_key}: ${l.units} unit(s) on a read with nothing new`);
  }
  Object.assign(found, ...Object.entries(recordChecks(h, views)).map(([k, v]) => ({ [k]: [...(found[k] ?? []), ...v] })));
  return found;
}

// The record-level checks, over one replay's views ({session_id: Map of records}). Exported so a
// test can hold each check to the break it must catch.
export function recordChecks(h, views) {
  const found = {};
  const add = (item, msg) => (found[item] ??= []).push(msg);

  for (const [sid, view] of Object.entries(views)) {
    const recs = recordsOf(view);
    const messages = recs.filter((r) => r.type === 'message');

    // M.tool-linkage: per call_id, at most one call and at most one result, and every result
    // answers a call of this session.
    const calls = new Map();
    const results = new Map();
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        if (p.kind === 'tool_call') calls.set(p.call_id, (calls.get(p.call_id) ?? 0) + 1);
        if (p.kind === 'tool_result') results.set(p.call_id, (results.get(p.call_id) ?? 0) + 1);
      }
    }
    for (const [id, n] of calls) if (n > 1) add('M.tool-linkage', `${sid}: call ${id} appears ${n} times`);
    for (const [id, n] of results) if (n > 1) add('M.tool-linkage', `${sid}: call ${id} has ${n} results`);
    for (const id of results.keys()) {
      if (!calls.has(id) && !ORPHAN_RESULTS[h]?.[sid]?.[id]) add('M.tool-linkage', `${sid}: result for ${id}, which no call of the session has`);
    }

    // M.is-error (sessions-model v1.x proposal (#6), §2.3): `is_error` describes a call that
    // completed, so a cancelled or denied result has none. A false beside a non-zero `exit_code` is
    // a flag that says success beside it, unreliable for that result, so null instead. A true
    // beside one needs the harness store's failure flag (FAILURE_FLAGS): never the exit code alone.
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        if (p.kind !== 'tool_result') continue;
        const at = `${sid}: result for ${JSON.stringify(p.call_id)}`;
        const exit = Number.isInteger(p.exit_code) && p.exit_code !== 0 ? p.exit_code : null;
        if ((p.status === 'cancelled' || p.status === 'denied') && p.is_error != null) add('M.is-error', `${at}: ${p.status} with is_error ${p.is_error}, not null`);
        else if (p.is_error === false && exit !== null) add('M.is-error', `${at}: is_error false beside exit_code ${exit}, not null`);
        else if (p.is_error === true && exit !== null && !FAILURE_FLAGS[h]?.[sid]?.[p.call_id]) add('M.is-error', `${at}: is_error true beside exit_code ${exit}, and no failure flag is listed`);
      }
    }

    // M.compaction: the message a summary keeps from is still present, and nothing before it was
    // dropped for the summary's sake (it may be retracted or reverted for other reasons).
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        if (p.kind !== 'summary' || !p.replaces || typeof p.replaces !== 'object') continue;
        const id = p.replaces.first_kept_id ?? p.replaces.through_id;
        if (id && !messages.some((x) => x.message_id === id)) add('M.compaction', `${sid}: summary ${m.message_id} names ${id}, which is gone`);
      }
    }

    // M.setup: no harness of this package records a setup, so every session's is null.
    for (const s of recs.filter((r) => r.type === 'session')) {
      if (s.setup !== null) add('M.setup', `${sid}: setup ${JSON.stringify(s.setup)}, not null (nothing records it)`);
    }

    // M.usage: the flags of §2.4's table, and no record that is all zeros (a stored zero for
    // unknown is null).
    for (const u of recs.filter((r) => r.type === 'usage')) {
      const [grans, anchors] = USAGE_SHAPE[h] ?? [[], []];
      if (!grans.includes(u.granularity)) add('M.usage', `${sid} ${u.usage_id}: granularity ${u.granularity}, not ${grans.join(' | ') || 'none (no usage)'}`);
      const kind = Object.keys(u.anchor ?? {})[0];
      if (!anchors.includes(kind)) add('M.usage', `${sid} ${u.usage_id}: anchor ${kind}, not ${anchors.join(' | ') || 'none'}`);
      const want = USAGE_FLAGS[h];
      const got = [u.input_includes_cache, u.output_includes_reasoning];
      if (want && (got[0] !== want[0] || got[1] !== want[1])) add('M.usage', `${sid} ${u.usage_id}: flags ${got}, not ${want}`);
      if (!want && h !== 'opencode' && (got[0] !== null || got[1] !== null)) add('M.usage', `${sid} ${u.usage_id}: flags ${got}, not null (nothing establishes them)`);
      const vals = COUNTERS.map((k) => u[k]);
      if (vals.every((v) => v === 0 || v === null) && vals.some((v) => v === 0)) add('M.usage', `${sid} ${u.usage_id}: no counter above 0, yet some are 0; unknown is null`);
    }
  }
  return found;
}
