// What the Cursor IDE adapter declares (sessions v1 §2 `describe`). Every facet is a claim, and
// each cites its source: a fixture under fixtures/cursor/, the adapter spec (unpublished; written
// from synthetic captures on a test VM, 2026-10-20: Cursor IDE 3.25.9), or the sessions-model annex
// (2026-10-22). A claim of `explicit` is backed by a fixture record, which test/cursor.test.js
// checks.

const DB = 'User/globalStorage/state.vscdb';

export const describe = Object.freeze({
  adapter: '@agent-realm/session-adapters/cursor',
  adapter_ver: '0.2.2',
  model_version: 'sessions-model/1',
  harness: 'cursor',
  state_ver: 1,
  // The lab fixture comes from Cursor IDE 3.25.9 rows (scrubbed, ids re-minted); none is certified
  // until conformance runs against a real Cursor.
  versions: { certified: [], compatible: [] },
  // `harness_path` is Cursor's user-data folder (the parent of `User/`). Every chat of every
  // workspace lives in its one global database (spec: "Store"), so `list` reads it once and names
  // each chat's slices.
  sources: [
    // The chat's bubbles: `bubbleId:<cid>:<bubbleId>` keys, the user bubble and its children
    // `<bubbleId>/s:<n>` and `<bubbleId>/t:<toolCallId>` (a call id holds `\n`). Rows are upserted
    // in place (`ON CONFLICT REPLACE`) and hard-deleted on an edit, so `known` decides. Unit key =
    // the full KV key; the unit is `{key, value}` with the value as text.
    { pattern: `${DB}#kv:bubbleId:<cid>:`, role: 'main', mode: 'delta', position_kind: 'kv', enc: 'row-json' },
    // `composerData:<cid>`: the authoritative message order (`fullConversationHeadersOnly`), name,
    // mode, model config, the streaming flags. Read without the volatile fields below.
    { pattern: `${DB}#kv:composerData:<cid>`, role: 'main', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
    // The chat's `composerHeaders` row, the chat list (sessions-model §1 rule 3), read without its
    // volatile columns and value fields.
    { pattern: `${DB}#table:composerHeaders`, role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
  ],
  // Fields `read` leaves out because they move without the conversation moving (memhouse's
  // normaliser kept them out of its log for the same reason): a view, a gauge, a UI hint
  // (sessions §2, `volatile`).
  volatile: {
    composerHeaders: ['lastUpdatedAt', 'recency', 'checkpointAt', 'value.lastUpdatedAt', 'value.conversationCheckpointLastUpdatedAt',
      'value.lastReadAtMs', 'value.contextUsagePercent', 'value.hasUnreadMessages'],
    composerData: ['lastUpdatedAt', 'conversationCheckpointLastUpdatedAt', 'lastReadAtMs', 'hasUnreadMessages', 'contextUsagePercent',
      'contextTokensUsed', 'contextTokenLimit', 'promptTokenBreakdown', 'promptContextUsageTree', 'conversationState',
      'latestChatGenerationUUID', 'fullConversationHeadersOnly[].contentHeightHint'],
  },
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  // Bubble `createdAt` is ISO time of the bubble's own event (spec: "Messages").
  ts_source: 'event',
  redaction: {
    // sessions-model §4.1: the composer's two per-chat encryption keys (spec: "never capture or log
    // them"). Replaced in `read` by `<redacted len=N>`.
    paths: [
      { source: `${DB}#kv:composerData:<cid>`, path: 'value » blobEncryptionKey', opened: true },
      { source: `${DB}#kv:composerData:<cid>`, path: 'value » speculativeSummarizationEncryptionKey', opened: true },
      // Never opened (sessions-model §4.7): the login rows in the same database's ItemTable, and
      // the
      // `agentKv:blob:*` rows (cursor-agent turn blobs, with `encrypted_model`). No query names
      // them.
      { source: `${DB}#table:ItemTable`, path: 'cursorAuth/*', opened: false },
      { source: `${DB}#kv:agentKv:blob:`, path: '** encrypted_model', opened: false },
    ],
    // `originalFileStates.*.contentKey` names an `ofsContent:` KV key, not a secret (sessions-model
    // §4.3, found in the lab). `key` is the KV row's key column in a unit (`{key, value}`): a KV
    // row
    // key is a key name, exempt by definition (sessions-model §4.3); only that column, not a `key`
    // field inside a value.
    exemptions: ['contentKey', 'key'],
  },
  facets: {
    // One entry per `composerHeaders` row, the chat list (sessions-model §1 rule 3; spec "Reading
    // Cursor 3.25" §1). A store without that table (an install from before it) falls back to the
    // `composerData:` keys, as memhouse's normaliser does: that path is partial (UNVERIFIED on a
    // live old install).
    list: 'exact',
    // Lossy: the `agent-transcripts` side source (outside `harness_path`, under `~/.cursor`) is not
    // read in this version; `agentKv:blob:*` is not read; images are a path, no bytes; a tool's
    // toolFormerData beyond name, args, status and result (whose `exitCode` is the tool_result's
    // `exit_code`), and a sub-agent's `isSubagent` and `subagentTypeName` reach no record (they
    // stay in the raw unit: a flag is not a kind, sessions-model v1.x proposal (#6), §2.1; the parent's
    // `subagent` link states the sub-agent); usage is `{0,0}` on the free plan; the volatile fields
    // above are not read.
    read: 'lossy',
    // `composerId` is a uuid (annex mapping row). UNVERIFIED: the archived draft id
    // `empty-state-draft` (fixture: lab) is not a uuid and may be reused.
    reuse: 'impossible',
    lifecycle: {
      rewind: 'implicit', // a checkpoint restore truncates on the next send (spec: lifecycle table; UNVERIFIED)
      edit: 'implicit', // the user bubble rewritten in place, later bubbles hard-deleted (spec; fixture: features)
      compaction: 'invisible', // not exercised in the lab (annex: ?)
      delete: 'implicit', // no menu entry in the Agents sidebar (spec); a deleted chat's header row goes (UNVERIFIED)
      archive: 'explicit', // `isArchived = 1` in place, no time (spec; fixtures: lab, features)
      unarchive: 'implicit', // the flag cleared in place: the archive record goes
      rename: 'implicit', // name rewritten in place, `lastUpdatedAt` not bumped (spec)
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'invisible', // a new composer `(1) <name>`, identical bubble ids, no parent field (spec; fixture: lab)
      clear: 'invisible',
    },
    linkage: {
      fork: 'inferable', // copied bubbles keep their ids and times (lab cases, unpublished; fixture: features)
      // Origin side only: `composerData.subagentComposerIds` (annex mapping row; not exercised in
      // the
      // lab, so the fixture is synthetic: features). A child names no parent.
      subagent: 'explicit',
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      tool: 'native', // one `/t:<toolCallId>` bubble holds call and result (spec)
      compaction: 'none',
    },
    // UNVERIFIED: no hook surface was observed for Cursor IDE (annex: `?`).
    join: { hook: 'no', rule: 'none observed (annex: ?)' },
  },
});
