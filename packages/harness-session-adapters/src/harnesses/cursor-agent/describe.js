// What the cursor-agent adapter declares (sessions v1 §2 `describe`). Every facet is a claim, and
// each cites its source: a fixture under fixtures/cursor-agent/, the adapter spec (unpublished;
// written from synthetic captures on a test VM, 2026-10-19 to 2026-10-21: cursor-agent 2026.10.19),
// or the sessions-model annex (2026-10-22). Each `explicit` claim is backed by a fixture record,
// which test/cursor-agent.test.js checks.

const CHAT = 'chats/<md5(cwd)>/<chatId>';
const ACP = 'acp-sessions/<id>';

export const describe = Object.freeze({
  adapter: '@agent-realm/harness-session-adapters/cursor-agent',
  adapter_ver: '0.2.2',
  model_version: 'sessions-model/1',
  harness: 'cursor-agent',
  state_ver: 1,
  // Observed on cursor-agent 2026.10.19 (spec); none is certified until conformance runs against a
  // real cursor-agent.
  versions: { certified: [], compatible: [] },
  // `harness_path` is the config folder: $CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else
  // ~/.cursor (spec §1). One store.db per chat; nothing is shared between sessions.
  sources: [
    // Immutable rows, id = sha256(data), written with INSERT OR REPLACE (rowid unusable; spec §3).
    // A JSON model message is `utf8`; a protobuf blob is `b64`, or `pb-json` when it carries a
    // value
    // redaction replaces (sessions-model §4.4).
    { pattern: `${CHAT}/store.db#table:blobs`, role: 'main', mode: 'delta', position_kind: 'kv', enc: 'utf8 | b64 | pb-json' },
    // Row "0", hex(utf8(JSON)), read as the decoded JSON: a rewind or a stale writer moves its
    // root, which is a snapshot change, never a reset (annex mapping row).
    { pattern: `${CHAT}/store.db#table:meta`, role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
    // Rewritten on every open (`updatedAtMs`): read as `{cwd}` only.
    { pattern: `${CHAT}/meta.json`, role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
    { pattern: `${ACP}/store.db#table:blobs`, role: 'main', mode: 'delta', position_kind: 'kv', enc: 'utf8 | b64 | pb-json' },
    { pattern: `${ACP}/store.db#table:meta`, role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
    { pattern: `${ACP}/meta.json`, role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
  ],
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  // UserMessage started_at_ms, the first step's started_at_ms (annex mapping row).
  ts_source: 'event',
  redaction: {
    // sessions-model §4.1: cursor-agent meta `blobEncryptionKey` and the turn's `encrypted_model`.
    // The credential tools follow memhouse's normaliser: their arguments keep only naming keys, and
    // their results are never kept. A pb-json path names field numbers; `»` enters a decoded
    // column.
    paths: [
      { source: `${CHAT}/store.db#table:meta`, path: 'meta[].value » blobEncryptionKey', opened: true },
      { source: `${CHAT}/store.db#table:blobs`, path: 'ConversationTurnStructure #1 agent_conversation_turn » #4 encrypted_model (pb-json)', opened: true },
      {
        source: `${CHAT}/store.db#table:blobs`,
        path: 'ConversationStep #2 tool_call » #41 mcp_login | #51 replace_env | #68 connect_scm | #15 mcp whose own tool name (McpArgs #5, else #1) is a credential tool | any kind not in the adapter\'s table | any kind whose tool_call_id the model context names a credential tool » every field (#2 result: every field of its set case; #15 mcp keeps McpArgs #1, #4, #5, #9, which name the call) (pb-json)',
        opened: true,
      },
      {
        source: `${CHAT}/store.db#table:blobs`,
        path: 'JSON content[type=tool-call] of ReplaceEnv | McpLogin | McpAuth | ConnectScm (any case; also as CallDynamicTool args.toolName) » args.* (args.arguments.* under CallDynamicTool) except name, names, server, server_name, serverName, provider, provider_identifier, providerIdentifier, scm, host (a string or list of strings, user:pass@ cut)',
        opened: true,
      },
      {
        source: `${CHAT}/store.db#table:blobs`,
        path: 'JSON content[type=tool-result] of a credential call » result, experimental_content, output; providerOptions.cursor.highLevelToolCallResult.* except isError',
        opened: true,
      },
      // The same paths apply to `${ACP}/store.db`.
      // Never opened (sessions-model §4.7): the CLI's auth files. list and read touch only the
      // paths
      // in `sources`.
      { source: 'cli-config.json', path: 'authInfo', opened: false },
      { source: '<config dir>/cursor/auth.json', path: '*', opened: false },
    ],
    // The meta table's `key` column holds the KV row key ("0"), a key name, which sessions-model
    // §4.3 exempts by definition. Nothing else under a secret-looking name was found in the
    // fixtures' units or records.
    exemptions: ['meta[].key'],
  },
  facets: {
    // Every chat directory with its store.db, and every ACP store (UNVERIFIED with a turn). An
    // empty
    // chat (meta.json only) and an orphan transcript are no sessions (fixture: orphan).
    list: 'exact',
    // Lossy: `projects/<slug>/agent-transcripts/<id>.jsonl`, a side source by sessions-model §1
    // rule 3, is not read; an untyped tool kind's step arguments and result text are never decoded
    // (only which result case is set); usage is not stored at all (the root's token_details is a
    // context gauge); the root's todos, plans, file states and the UserMessage selected context are
    // not read; meta.json beyond cwd; a shell turn has no id and is anchored `<id>+n`. The shell
    // exit
    // code (ShellSuccess / ShellFailure #3, a shell turn's ShellOutput #3) is the tool_result's
    // `exit_code`, null for a credential step.
    read: 'lossy',
    reuse: 'impossible', // chat ids are uuids (annex mapping row)
    lifecycle: {
      rewind: 'implicit', // latestRootBlobId moves back; the later turns leave the tree (fixture: rewind)
      edit: 'invisible', // no edit command (spec)
      compaction: 'explicit', // a new root with a summary archive (fixture: features)
      delete: 'implicit', // the chat directory is removed (fixture: orphan; spec)
      archive: 'invisible',
      unarchive: 'invisible',
      rename: 'implicit', // meta `name` rewritten in place (spec)
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'implicit', // a new directory with the blobs copied, no parent reference (fixture: rewind)
      clear: 'invisible',
    },
    linkage: {
      fork: 'inferable', // same root and blob ids, " (forked)", a later createdAt (annex mapping row; fixture: rewind)
      subagent: 'explicit', // meta subagentInfo (child), the Task result and root subagent maps (parent) (fixture: subagent)
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      tool: 'native', // step tool_call_id = JSON toolCallId (lab cases, unpublished; fixture: features)
      compaction: '{archive_ref}', // summary_archives (sessions-model §2.3)
    },
    // UNVERIFIED: no hook surface was observed for cursor-agent (annex: `?`).
    join: { hook: 'no', rule: 'none observed' },
  },
});
