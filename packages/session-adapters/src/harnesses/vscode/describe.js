// What the VS Code (Local engine) adapter declares (sessions v1 §2 `describe`). Every facet is a
// claim with its source: a fixture under fixtures/vscode/ (`lab` is rebuilt from the scrubbed lab
// captures, `features` is synthetic), the adapter spec (unpublished; written from synthetic
// captures on a test VM: VS Code 1.142; read 2026-10-22), or the sessions-model annex row "vscode
// (engine local)". A claim of `explicit` is backed by a fixture record.

export const describe = Object.freeze({
  adapter: '@agent-realm/session-adapters/vscode',
  adapter_ver: '0.2.0',
  model_version: 'sessions-model/1',
  harness: 'vscode',
  state_ver: 1,
  // Observed on VS Code 1.142 with built-in Copilot Chat 0.70.0 (spec; fixture `lab`). Nothing is
  // certified until conformance runs against a real VS Code.
  versions: { certified: [], compatible: [] },
  // `harness_path` is the VS Code user-data folder (the parent of `User/`). One id with a `.jsonl`
  // and a `.json`, or in two workspaces, is one session with several `main` sources; derive reads
  // the change log first, then the one with the latest activity, then the lowest source_key.
  sources: [
    { pattern: 'User/workspaceStorage/<ws>/chatSessions/<session>.jsonl', role: 'main', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
    { pattern: 'User/globalStorage/emptyWindowChatSessions/<session>.jsonl', role: 'main', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
    // The pre-change-log format (memhouse normaliser; fixture `features`).
    { pattern: 'User/workspaceStorage/<ws>/chatSessions/<session>.json', role: 'main', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
    { pattern: 'User/globalStorage/emptyWindowChatSessions/<session>.json', role: 'main', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
    // The workspace's folder, shared by its sessions: the session's cwd.
    { pattern: 'User/workspaceStorage/<ws>/workspace.json', role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
  ],
  // A request's own `timestamp` (ms). A fork resets it to the fork time + 1 ms (annex; fixture
  // `lab`), and the reply's `responseTimestamp` keeps the origin's time.
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  ts_source: 'event',
  redaction: {
    // sessions-model §4.1: VS Code selected-model metadata `auth`. `**` is any depth of the session
    // state: in a change-log op the path is the op's `k` joined with the path inside `v`, so a
    // `kind 1` whose `k` ends at `…selectedModel.metadata.auth`, or holds it, is redacted too
    // (fixture `features`). A line or a snapshot that does not parse is never emitted as it is:
    // a complete line becomes one marker, and a snapshot is held back until it parses.
    paths: ['**.selectedModel.metadata.auth'],
    // sessions-model §4.3's lab exemptions for VS Code, none of them secrets: `cacheKey` (a folder
    // URI, fixture `lab`), `tokenizer`, `tokenType`, and a URI's `authority` (in an object with a
    // `scheme`).
    exemptions: ['cacheKey', 'tokenizer', 'tokenType', 'authority'],
  },
  facets: {
    // A delete removes the chat file (spec, "Lifecycle"); every chat file is listed.
    list: 'exact',
    // Lossy (spec; annex §2): images keep a path, never bytes; reasoning is never readable (an
    // opaque id); response parts have no ids (array indices) and text runs are merged; bookkeeping
    // and UI parts (textEditGroup, codeblockUri, undoStop, progressMessage, confirmation,
    // mcpServersStarting, autoModeResolution) make no part; a tool's `hidden` presentation and
    // its round timestamp have no field (a terminal tool's `terminalCommandState.exitCode` is
    // `exit_code`); `copilotCredits` has no usage field; a request with no `requestId` makes no
    // record; a sub-agent's prompt is not told apart from a user prompt; the side transcript
    // (GitHub.copilot-chat/transcripts), chatEditingSessions and debug-logs are not read.
    read: 'lossy',
    // The file stem is the session id, a UUID (annex).
    reuse: 'impossible',
    lifecycle: {
      // A `kind 2` with `i` at ['requests']: an append-only retraction (sessions-model §2.6 (a));
      // the cut requests stay, `state: retracted` (fixtures `lab` and `features`).
      rewind: 'explicit',
      // An edit is the same truncating splice, followed by the regrown request; the store cannot
      // tell it from a checkpoint restore, so the record says `rewind` (spec, "Lifecycle").
      edit: 'implicit',
      // `/compact`: a request whose result metadata holds the summary (spec, "Lifecycle"; fixture
      // `features`, synthetic: the summary's shape is the normaliser's, not a lab capture).
      compaction: 'explicit',
      delete: 'implicit', // the chat file is removed (spec)
      archive: 'invisible', // not exercised in the lab; nothing in the chat file
      unarchive: 'invisible',
      rename: 'explicit', // a `kind 1` at ['customTitle'] (spec; fixture `lab`, session f0da568c)
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'implicit', // a new session id holding one `kind 0`, new ids, no link (spec; annex)
      clear: 'invisible', // not exercised
    },
    linkage: {
      // A fork mints new ids and resets timestamps, with no link: only content can nominate it
      // (annex §2, §4.1), through `fingerprint.cmp_shas`.
      fork: 'inferable',
      // A sub-agent lives in its parent's request, as `agent_id` = `subAgentInvocationId` (spec).
      subagent: 'none',
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      // `toolCallId` on the call; one native part holds call and result (annex).
      tool: 'native',
      // The summary does not say what it replaces (spec).
      compaction: 'unknown',
    },
    // No hook payload was observed for the Local engine (annex: `?`).
    join: { hook: 'no', rule: 'not observed for the Local engine (annex row: ?)' },
  },
});
