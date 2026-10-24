// The record validator: one session's sessions-model records checked against the contract's shape
// (sessions-model §2). The conformance matrix runs it over every golden; a writer (the reference
// harness's) runs it before it writes, so the two can never disagree on what a valid record is.
// It checks shape, not meaning: enums, ISO times, ids that are unique and carry no time, one
// session record whose fingerprint names messages that exist, explicit evidence.
//
// A closed list (sessions-model §8) refuses a value it does not hold. A registry grows in v1.x
// (`harness`, `ts_source`; `enc` and `position_kind` are unit and source fields, not checked here),
// so a value this validator does not know is a warning, never a refusal.

const ENUMS = {
  role: ['user', 'assistant', 'system', 'tool'],
  source: ['user', 'model', 'injected', 'hook', 'system_notice', 'steering', 'automated'],
  status: ['complete', 'streaming', 'interrupted', 'error', 'cancelled'],
  messageState: ['current', 'reverted', 'retracted'],
  partKind: ['text', 'reasoning', 'tool_call', 'tool_result', 'attachment', 'summary', 'error', 'notice'],
  resultStatus: ['completed', 'cancelled', 'denied'],
  sessionState: ['active', 'archived', 'deleted'],
  titleSetBy: ['user', 'auto', 'unknown'],
  reuse: ['impossible', 'detected', 'undetectable'],
  granularity: ['per_response', 'per_message', 'per_turn', 'per_session', 'per_record'],
  linkKind: ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation'],
  statedOn: ['child', 'origin'],
  op: ['rewind', 'edit', 'compaction', 'delete', 'archive', 'unarchive', 'rename', 'pin', 'unpin', 'fork', 'clear'],
};
// The registries' values as of sessions-model v1 (§1 rule 3, §2.1).
const REGISTRIES = {
  harness: ['claude-code', 'codex', 'copilot-cli', 'vscode', 'cursor', 'cursor-agent', 'agy', 'antigravity', 'opencode', 'goose',
    'gemini-cli', 'commandcode', 'droid', 'devin', 'zed', 'kiro', 'jetbrains-copilot', 'pi', 'reference-harness'],
  tsSource: ['event', 'write', 'reset_on_save', 'seconds', 'none', 'first_seen'],
};
const RECORD_TYPES = ['session', 'message', 'usage', 'link', 'lifecycle'];
const ANCHORS = ['response_id', 'message_id', 'session', 'compaction'];
const COUNTERS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'tool_prompt', 'cost'];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const SHA = /^[0-9a-f]{64}$/;
const TIME_LIKE = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d/;
const KEY = (v) => typeof v === 'string' && v.length > 0;

/**
 * Check one session's records. Returns findings, each `{at, problem}`. A finding with `warning:
 * true` names a registry value this version does not know, and does not make the records invalid:
 * they are valid when every finding is a warning.
 * @param {object[]} records every record of one session (as derive's view holds them)
 * @param {{harness?: string, sessionId?: string}} [expect] the harness and session the records must name
 */
export function validateSession(records, expect = {}) {
  const out = [];
  const bad = (at, problem) => out.push({ at, problem });
  const oneOf = (at, field, v, list, nullable = false) => {
    if (v === null && nullable) return;
    if (!list.includes(v)) bad(at, `${field} ${JSON.stringify(v)} is not one of ${list.join(' | ')}`);
  };
  // A registry value: a non-empty string; one this version does not know is warned once.
  const warned = new Set();
  const registered = (at, field, v, list) => {
    if (!KEY(v)) return bad(at, `${field} ${JSON.stringify(v)} is not a non-empty string`);
    if (list.includes(v) || warned.has(`${field}\u0000${v}`)) return;
    warned.add(`${field}\u0000${v}`);
    out.push({ at, problem: `${field} ${JSON.stringify(v)} is not a value this version knows (a registry, sessions-model §8: accepted)`, warning: true });
  };
  const isoOrNull = (at, field, v) => {
    if (v !== null && v !== undefined && !ISO.test(v)) bad(at, `${field} ${JSON.stringify(v)} is not an ISO time`);
  };
  const boolOrNull = (at, field, v) => {
    if (!(v === null || typeof v === 'boolean')) bad(at, `${field} ${JSON.stringify(v)} is not a boolean or null`);
  };
  const seen = { message: new Set(), usage: new Set(), lifecycle: new Set() };
  const shas = new Set();
  let sessions = 0;
  let fingerprint = null;

  for (const r of records) {
    const at = `${r.type} ${r.message_id ?? r.usage_id ?? r.lifecycle_id ?? r.kind ?? ''}`.trim();
    if (!RECORD_TYPES.includes(r.type)) { bad(at, `unknown record type ${JSON.stringify(r.type)}`); continue; }
    if (expect.harness !== undefined && r.harness !== expect.harness) bad(at, `harness ${r.harness}, not ${expect.harness}`);
    if (expect.sessionId !== undefined && r.session_id !== expect.sessionId) bad(at, `session_id ${r.session_id}, not ${expect.sessionId}`);
    if (typeof r.incarnation !== 'string') bad(at, 'incarnation is not a string');
    registered(at, 'harness', r.harness, REGISTRIES.harness);
    if (!KEY(r.session_id)) bad(at, 'session_id is not a non-empty string');

    if (r.type === 'message') {
      if (!KEY(r.message_id)) bad(at, 'message_id is not a non-empty string');
      if (seen.message.has(r.message_id)) bad(at, 'message_id repeats');
      seen.message.add(r.message_id);
      if (TIME_LIKE.test(r.message_id)) bad(at, 'message_id carries a time');
      oneOf(at, 'role', r.role, ENUMS.role);
      oneOf(at, 'source', r.source, ENUMS.source, true);
      oneOf(at, 'status', r.status, ENUMS.status);
      oneOf(at, 'state', r.state, ENUMS.messageState);
      for (const f of ['to_user', 'to_model', 'on_active_branch']) boolOrNull(at, f, r[f]);
      isoOrNull(at, 'ts', r.ts);
      if (typeof r.order !== 'string') bad(at, 'order is not a string');
      if (typeof r.agent_id !== 'string') bad(at, 'agent_id is not a string');
      if (!SHA.test(r.cmp_sha ?? '')) bad(at, 'cmp_sha is missing');
      shas.add(r.cmp_sha);
      const partIds = new Set();
      if (!Array.isArray(r.parts)) bad(at, 'parts is not a list');
      for (const p of Array.isArray(r.parts) ? r.parts : []) {
        if (typeof p.part_id !== 'string') bad(at, `part_id ${JSON.stringify(p.part_id)} is not a string`);
        if (partIds.has(p.part_id)) bad(at, `part_id ${p.part_id} repeats`);
        partIds.add(p.part_id);
        oneOf(at, 'part kind', p.kind, ENUMS.partKind);
        if (p.source !== undefined) oneOf(at, 'part source', p.source, ENUMS.source, true);
        if (p.state !== undefined) oneOf(at, 'part state', p.state, ENUMS.messageState);
        if ((p.kind === 'tool_call' || p.kind === 'tool_result') && !KEY(p.call_id)) bad(at, `${p.kind} has no non-empty string call_id`);
        if (p.kind === 'tool_result') {
          if ('is_error' in p) boolOrNull(at, 'is_error', p.is_error);
          if (p.status != null) oneOf(at, 'tool_result status', p.status, ENUMS.resultStatus);
          if (!('exit_code' in p)) bad(at, 'tool_result has no exit_code');
          else if (!(p.exit_code === null || Number.isInteger(p.exit_code))) bad(at, `exit_code ${JSON.stringify(p.exit_code)} is not an integer or null`);
          if (p.output_ref != null && !(typeof p.output_ref === 'object' && 'ref' in p.output_ref && 'sha256' in p.output_ref && 'bytes' in p.output_ref)) {
            bad(at, 'output_ref is not {ref, sha256, bytes}');
          }
        }
        if (p.kind === 'error' && !('error_kind' in p)) bad(at, 'an error part has no error_kind (its own kind; `kind` is the part\'s)');
      }
    } else if (r.type === 'session') {
      sessions++;
      oneOf(at, 'state', r.state, ENUMS.sessionState);
      oneOf(at, 'reuse', r.reuse, ENUMS.reuse);
      registered(at, 'ts_source', r.ts_source, REGISTRIES.tsSource);
      if (r.title_set_by != null) oneOf(at, 'title_set_by', r.title_set_by, ENUMS.titleSetBy);
      isoOrNull(at, 'created_at', r.created_at);
      isoOrNull(at, 'updated_at', r.updated_at);
      if (r.reuse === 'impossible' && r.incarnation !== '') bad(at, 'reuse is impossible but incarnation is set');
      if (!('setup' in r)) bad(at, 'session has no setup (null unless the harness store records it)');
      else if (r.setup !== null && (typeof r.setup !== 'object' || typeof r.setup.digest !== 'string')) bad(at, 'setup is neither null nor an object with a digest');
      fingerprint = r.fingerprint?.cmp_shas;
      if (!Array.isArray(fingerprint)) bad(at, 'fingerprint.cmp_shas is missing');
    } else if (r.type === 'usage') {
      if (!KEY(r.usage_id)) bad(at, 'usage_id is not a non-empty string');
      if (seen.usage.has(r.usage_id)) bad(at, 'usage_id repeats');
      seen.usage.add(r.usage_id);
      if (TIME_LIKE.test(r.usage_id)) bad(at, 'usage_id carries a time');
      if ('basis' in r) bad(at, 'basis is retired: use input_includes_cache and output_includes_reasoning (sessions-model §2.4)');
      if (!('tool_prompt' in r)) bad(at, 'usage has no tool_prompt (null where the store reports none)');
      boolOrNull(at, 'input_includes_cache', r.input_includes_cache);
      boolOrNull(at, 'output_includes_reasoning', r.output_includes_reasoning);
      oneOf(at, 'granularity', r.granularity, ENUMS.granularity);
      const anchor = Object.keys(r.anchor ?? {});
      if (anchor.length !== 1 || !ANCHORS.includes(anchor[0])) bad(at, `anchor ${JSON.stringify(r.anchor)}`);
      for (const k of COUNTERS) {
        const v = r[k];
        if (!(v === null || (typeof v === 'number' && v >= 0))) bad(at, `${k} ${JSON.stringify(v)} is not a count or null`);
      }
    } else if (r.type === 'link') {
      oneOf(at, 'kind', r.kind, ENUMS.linkKind);
      oneOf(at, 'stated_on', r.stated_on, ENUMS.statedOn);
      if (r.evidence !== 'explicit') bad(at, `evidence ${JSON.stringify(r.evidence)}: an adapter states explicit links only`);
      for (const side of ['child', 'origin']) {
        if (!r[side]?.harness || typeof r[side]?.session_id !== 'string') bad(at, `${side} reference ${JSON.stringify(r[side])}`);
      }
      if (typeof r.at !== 'string') bad(at, 'at is not a string');
    } else if (r.type === 'lifecycle') {
      if (!KEY(r.lifecycle_id)) bad(at, 'lifecycle_id is not a non-empty string');
      if (seen.lifecycle.has(r.lifecycle_id)) bad(at, 'lifecycle_id repeats');
      seen.lifecycle.add(r.lifecycle_id);
      oneOf(at, 'op', r.op, ENUMS.op);
      if (r.evidence !== 'explicit') bad(at, `evidence ${JSON.stringify(r.evidence)}: lifecycle records are explicit only`);
      isoOrNull(at, 'ts', r.ts);
    }
  }
  if (sessions !== 1) bad('session', `${sessions} session records, not 1`);
  for (const sha of fingerprint ?? []) if (!shas.has(sha)) bad('session', `fingerprint names ${sha.slice(0, 12)}, which no message has`);
  return out;
}
