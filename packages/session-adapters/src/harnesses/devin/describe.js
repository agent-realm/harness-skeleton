// What the Devin Local adapter declares (sessions v1 §2 `describe`). Every facet is a claim, and
// each cites its source: a fixture under fixtures/devin/, the adapter spec (unpublished; written
// from synthetic captures on a test VM, 2026-10-20: Windsurf / Devin Desktop 3.10.67 (Devin Local)
// with the bundled CLI 3000.10.67), or the sessions-model annex (2026-10-22). A claim of `explicit`
// is backed by a fixture record, which test/devin.test.js checks.

const SOURCE = 'sessions.db#table:message_nodes';

export const describe = Object.freeze({
  adapter: '@agent-realm/session-adapters/devin',
  adapter_ver: '0.2.0',
  model_version: 'sessions-model/1',
  harness: 'devin',
  state_ver: 1,
  // The fixtures are generated in the store's shape from the spec and the scrubbed lab samples;
  // none is certified until conformance runs against a real Devin Local.
  versions: { certified: [], compatible: [] },
  sources: [
    // The session's `sessions` row (its stable columns), its `message_nodes` (without row_id and
    // the
    // row created_at, both reset on every save), `tool_call_state` (the final update) and
    // `subagent_heads`, read in one transaction: one unit, replaced whole. Every turn deletes and
    // re-inserts every node (spec, "Write pattern"), so per-table deltas would buy nothing and
    // could
    // tear the pointer from the nodes (sessions §1).
    { pattern: SOURCE, role: 'main', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
  ],
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  // The row created_at resets on every save; a message's ts is chat_message.metadata.created_at
  // (sessions-model §2.1; lab cases, unpublished).
  ts_source: 'reset_on_save',
  redaction: {
    // sessions-model §4.1 declares no Devin path, and the fixtures show no secret on a field path.
    // Only sessions.db is opened; Devin Desktop's globalStorage and the CLI's config are not.
    paths: [],
    // A string under a secret-looking name that is not a secret (sessions-model §4.3): the
    // `affogato/cog-context` extension's `key` names a context slot (`workspace/context`; the
    // scrubbed system_info sample).
    exemptions: ['affogato/cog-context.key'],
  },
  facets: {
    // Every sessions row, hidden summary-agent sessions included (spec, "Store").
    list: 'exact',
    // Lossy: the system prefix (system prompt, sub-agent profiles, mode prompts), cache-keepalive
    // nodes and the summarizer's own prompt are not messages; streaming twins and prefix copies
    // fold
    // to one record per message_id; sessions.cogs_json, metadata (credit totals) and
    // last_activity_at, tool_call_state.tool_call_json and subagent_heads.updated_at are not read;
    // chisel/undo, chisel/conversation_history, tool timings and an inline image's source path stay
    // in the unit and reach no record (a shell's `chisel/terminal_output.exit.exit_code` is the
    // tool_result's `exit_code`); archive state lives in another store.
    read: 'lossy',
    // A two-word slug, reuse unverified, and no birth marker: incarnation '' (annex mapping row).
    reuse: 'undetectable',
    lifecycle: {
      rewind: 'implicit', // only main_chain_id moves back; the abandoned branch stays, on_active_branch false (spec; fixture: features, brisk-meadow)
      edit: 'implicit', // a revert plus a new sibling branch (spec)
      compaction: 'explicit', // the summary node, `summarized_from` (fixture: features, calm-orchard)
      delete: 'implicit', // the row, its nodes and tool states are deleted (spec)
      archive: 'invisible', // only Devin Desktop's globalStorage changes, another harness store (spec)
      unarchive: 'invisible',
      rename: 'implicit', // `title` rewritten in place (spec)
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'invisible', // a new slug copying the chain; nothing names the origin (spec)
      clear: 'invisible', // UNVERIFIED: no /clear was observed (annex: ?)
    },
    linkage: {
      fork: 'inferable', // the copy keeps node_ids and message_ids (spec; annex observation 1)
      subagent: 'none', // sub-agents live in the same tree, with agent_id (spec; annex observation 13)
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      tool: 'native', // tool_calls[].id = the tool node's tool_call_id = tool_call_state.tool_call_id (lab cases, unpublished)
      compaction: '{through_id}', // the summary replaces through the message of node `summarized_from`
    },
    // UNVERIFIED: no hook surface was observed for Devin Local (annex: ?).
    join: { hook: 'no', rule: 'none observed' },
  },
});
