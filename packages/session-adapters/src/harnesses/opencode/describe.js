// What the OpenCode adapter declares (sessions v1 §2 `describe`). Every facet is a claim, and each
// cites its source: a fixture under fixtures/opencode/, the adapter spec (unpublished; written from
// synthetic captures on a test VM: OpenCode 1.19.3; read 2026-10-22), or the sessions-model annex
// (2026-10-22). Each `explicit` claim is backed by a fixture record, which test/opencode.test.js
// checks.
//
// Source keys. Every store's `harness_path` is its database file (sessions-model §1), so a table
// source is `table:<name>`, inside the harness's one database (sessions §1). A spilled tool output
// lives in the data folder's `tool-output/`, outside the store's `harness_path`, so its key is the
// absolute real path (sessions §1).

export const describe = Object.freeze({
  adapter: '@agent-realm/session-adapters/opencode',
  adapter_ver: '0.2.1',
  model_version: 'sessions-model/1',
  harness: 'opencode',
  state_ver: 1,
  // The fixtures come from OpenCode 1.19.3 (lab captures, scrubbed, and rows generated in their
  // shape); none is certified until conformance runs against a real OpenCode.
  versions: { certified: [], compatible: [] },
  sources: [
    // The session's own row, without its running sums and update times (spec §3): title,
    // directory, version, parent_id, time_created, time_archived, revert.
    { pattern: 'table:session', role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
    // v1 engine: the session's `message` and `part` rows as ONE source, so a held message and its
    // parts are read together (unit keys `message:<id>`, `part:<id>`).
    { pattern: 'table:message', role: 'main', mode: 'delta', position_kind: 'time_updated+id', enc: 'row-json' },
    // v2 engine: rows are upserted and a committed revert deletes one, so delta, not seq (the
    // sessions-model annex). Unit keys `session_message:<id>`.
    { pattern: 'table:session_message', role: 'main', mode: 'delta', position_kind: 'time_updated+id', enc: 'row-json' },
    // v2 prompt delivery (steer | queue). No update time, so `pk`. Unit keys `session_input:<id>`.
    { pattern: 'table:session_input', role: 'side', mode: 'delta', position_kind: 'pk', enc: 'row-json' },
    // The removal and revert events only (`message.removed`, `message.part.removed`,
    // `session.next.revert.*`); unit key = `seq`. A wiped or deleted log is a reset.
    { pattern: 'table:event', role: 'side', mode: 'stream', position_kind: 'seq', enc: 'row-json' },
    // A truncated tool output's full text, named by the parts that point at it (spec §2).
    { pattern: '<data folder>/tool-output/tool_<id>', role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
  ],
  // What `harness_path` names for this harness (sessions-model §1): every store is
  // its own database file in the data folder, the default one included; an OPENCODE_DB may be
  // anywhere.
  store_shape: { kind: 'file', default: 'opencode.db', names: ['opencode.db', 'opencode-<channel>.db'] },
  ts_source: 'event',
  redaction: {
    // sessions-model §4.1 declares no OpenCode path. These are the normaliser's rules moved into
    // `read` (memhouse's opencode normaliser): a provider error's response
    // headers, body and request metadata (the URL) are replaced by the marker; a non-file URL
    // keeps its scheme and host and the rest is the marker, an opaque URI is the marker whole.
    // Paths are inside the JSON of each row's `data` column.
    paths: [
      { source: '<db>table:message', path: 'message.data.error.data.responseHeaders', opened: true },
      { source: '<db>table:message', path: 'message.data.error.data.responseBody', opened: true },
      { source: '<db>table:message', path: 'message.data.error.data.metadata', opened: true },
      { source: '<db>table:message', path: 'part.data.error.data.{responseHeaders,responseBody,metadata}', opened: true },
      { source: '<db>table:message', path: 'part.data.state.error.data.{responseHeaders,responseBody,metadata}', opened: true },
      { source: '<db>table:message', path: 'part.data.url', opened: true },
      { source: '<db>table:message', path: 'part.data.source.uri', opened: true },
      { source: '<db>table:message', path: 'part.data.state.attachments[].url', opened: true },
      { source: '<db>table:session_message', path: 'data.error.data.{responseHeaders,responseBody,metadata}', opened: true },
      { source: '<db>table:session_message', path: 'data.content[].state.error.data.{responseHeaders,responseBody,metadata}', opened: true },
      { source: '<db>table:session_message', path: 'data.files[].{url,uri}', opened: true },
      { source: '<db>table:session_message', path: 'data.content[].state.attachments[].url', opened: true },
    ],
    exemptions: [],
  },
  facets: {
    // One entry per `session` row of the store's own database file. A default, a channel and an
    // OPENCODE_DB store each list only their own sessions (sessions-model §1; fixture: channels).
    list: 'exact',
    // Lossy: a tool's title, other metadata and times have no slot (its exit code, v1
    // `metadata.exit` / v2 `structured.exit`, is `exit_code`); nor has a data: attachment's
    // filename; v2 `session_input` delivery and its admitted / promoted seq (annex §2) stay in the
    // raw units only; the session's running token sums, `slug`, `project_id`, `permission`,
    // `agent` and `model` are not read; the provider error payloads and URL paths that read
    // redacts are gone.
    read: 'lossy',
    // `ses_` ids carry a time and a random part; an import restores the same id (annex mapping
    // row).
    reuse: 'impossible',
    lifecycle: {
      rewind: 'explicit', // v2 `session.next.revert.committed` (fixture: v2); a v1 revert is state `reverted`
      edit: 'explicit', // prompt-while-reverted deletes rows and writes `message.removed` (fixture: features)
      compaction: 'explicit', // the `compaction` part (fixture: features)
      delete: 'implicit', // the session's rows and events are deleted (spec §6)
      archive: 'explicit', // `time_archived`: session state `archived` (fixture: features); no lifecycle record
      unarchive: 'implicit', // `time_archived` cleared in place (spec §6)
      rename: 'implicit', // `title` updated in place; its `session.updated` event is not read (spec §6)
      pin: 'invisible', // pins live in the state dir's `session.json`, not read (spec §2)
      unpin: 'invisible',
      fork: 'invisible', // a fork stores no pointer: new ids, a `(fork #N)` title (spec §5)
      clear: 'invisible',
    },
    linkage: {
      fork: 'inferable', // copied content with new ids (annex §2; sessions-model §2.5)
      subagent: 'explicit', // child `parent_id`, parent `task` part `metadata.sessionId` (fixtures: basic, features)
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      tool: 'native', // one `tool` part holds call and result, by `callID` (spec §5)
      compaction: '{first_kept_id}', // v1 `tail_start_id` (fixture: features); v2 has none
    },
    // Plugin hooks carry `sessionID` = session.id and `callID` = the tool part's callID (annex
    // mapping row, from OpenCode's docs; untested).
    join: { hook: 'yes', rule: 'plugin hook sessionID = session_id; callID = the tool part callID (docs, untested)' },
  },
});
