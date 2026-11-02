// What the Claude Code adapter declares (sessions v1 §2 `describe`). Every facet is a claim; a
// claim of `explicit` is backed by a fixture under fixtures/claude-code/.

export const describe = Object.freeze({
  adapter: '@agent-realm/harness-session-adapters/claude-code',
  adapter_ver: '0.3.0',
  model_version: 'sessions-model/1',
  harness: 'claude-code',
  state_ver: 3,
  // No harness version is certified until conformance runs against a real Claude Code.
  versions: { certified: [], compatible: [] },
  sources: [
    { pattern: 'projects/<encoded cwd>/<session>.jsonl', role: 'main', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
    { pattern: 'projects/<encoded cwd>/<session>/subagents/[workflows/<workflow>/]agent-<agent>.jsonl', role: 'agent', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
  ],
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  ts_source: 'event',
  redaction: {
    // sessions-model §4.1 declares no Claude Code path.
    paths: [],
    exemptions: [],
  },
  // The native fields each message carries (sessions-model §2.7): leaf values of the line the
  // message comes from that no other field maps. Each is a fixed value set or an id, never user
  // content or a path; `gitBranch` and `cwd` stay out.
  native: {
    session: [],
    message: [
      'userType', // who wrote the line: `external`
      'requestId', // the API request id, beside `message.id` (response_id)
      'message.stop_reason', // why the response ended: end_turn, tool_use, max_tokens
      'compactMetadata.trigger', // what started a compaction: manual or auto
      'compactMetadata.preTokens', // the context size a compaction started from
    ],
    part: [],
  },
  facets: {
    list: 'exact',
    // Lossy: spilled tool output (`<session>/tool-results/*.txt`) and images inside tool results
    // are not read; the `parentUuid` tree is passed on as `parent_id`, never walked.
    read: 'lossy',
    reuse: 'impossible',
    lifecycle: {
      rewind: 'implicit', // a new branch in the parentUuid tree; the file only grows
      edit: 'implicit',
      compaction: 'explicit', // system `compact_boundary` (fixture: compaction)
      delete: 'implicit', // the file is removed
      archive: 'invisible',
      unarchive: 'invisible',
      rename: 'explicit', // `custom-title` records (fixture: rename)
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'invisible',
      clear: 'invisible',
    },
    linkage: {
      // Sub-agents live in this session's own sources, with `agent_id` (sessions-model §2.2).
      fork: 'none',
      subagent: 'none',
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      tool: 'native',
      compaction: '{through_id}',
    },
    // From Claude Code's hook documentation, not yet tested: a hook's `session_id` and
    // `transcript_path` name the session; a sub-agent's hook joins as (session, agent_id).
    join: { hook: 'derived', rule: 'session_id or transcript_path; sub-agents as (session, agent_id)' },
  },
});
