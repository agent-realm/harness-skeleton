// What the Codex adapter declares (sessions v1 §2 `describe`). Every facet is a claim; a claim of
// `explicit` is backed by a fixture under fixtures/codex/.

export const describe = Object.freeze({
  adapter: '@agent-realm/session-adapters/codex',
  adapter_ver: '0.2.1',
  model_version: 'sessions-model/1',
  harness: 'codex',
  state_ver: 2,
  // No harness version is certified until conformance runs against a real Codex.
  versions: { certified: [], compatible: [] },
  // `harness_path` is CODEX_HOME. Both trees are walked recursively for `rollout-*.jsonl`; several
  // rollouts with one session id are several `main` sources of one session.
  sources: [
    { pattern: 'sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<session>.jsonl', role: 'main', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
    { pattern: 'archived_sessions/rollout-<stamp>-<session>.jsonl', role: 'main', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
  ],
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  ts_source: 'event',
  redaction: {
    // sessions-model §4.1 declares no Codex path. `<CODEX_HOME>/auth.json` holds credentials and
    // is never read (sessions-model §4.7): only `rollout-*.jsonl` files are opened.
    paths: [],
    exemptions: [],
  },
  facets: {
    list: 'exact',
    // Lossy: encrypted reasoning is kept as an opaque part with its length only; event_msg records
    // other than task_started and token_count (the user_message / agent_message duplicates,
    // item_completed, turn_aborted, …), token_usage_record, world_state and the `replacement_history`
    // of a compacted record make no record; a tool output's duration (`metadata.duration_seconds`)
    // is not kept, its `metadata.exit_code` is the tool_result's `exit_code`; a plain-text output
    // (fixture: live) has exit_code null, since the `item_completed` CommandExecution that carries
    // one names no call_id to join on; no fixture output carries a success flag, so `is_error` is
    // null there, never derived from the exit code (contract decision, to appear in
    // sessions-model v1.x; refines §2.3); an image given by URL rather than a data URL is not kept.
    read: 'lossy',
    reuse: 'impossible',
    lifecycle: {
      rewind: 'invisible', // no rollout record of a backtrack is handled; whether one exists is not established
      edit: 'invisible',
      compaction: 'explicit', // `compacted` records (fixture: features)
      delete: 'implicit', // the rollout file is removed
      archive: 'implicit', // the rollout moves under archived_sessions/; no record
      unarchive: 'implicit', // moved back under sessions/
      rename: 'invisible',
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'invisible',
      clear: 'invisible',
    },
    linkage: {
      fork: 'none',
      subagent: 'none',
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      tool: 'native', // `call_id` on the call and on its output
      compaction: 'unknown', // a compacted record does not say which messages it replaced
    },
    // From Codex's hook documentation, not yet tested: a hook's stdin carries `session_id`,
    // `transcript_path` (may be null) and `turn_id`; join on `transcript_path` when it is set.
    join: { hook: 'derived', rule: 'transcript_path when non-null (documented, untested)' },
  },
});
