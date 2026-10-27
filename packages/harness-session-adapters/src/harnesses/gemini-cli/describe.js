// What the Gemini CLI adapter declares (sessions v1 §2 `describe`). Every facet is a claim, and
// each cites its source: a fixture under fixtures/gemini-cli/, the adapter spec (unpublished;
// written from synthetic captures on a test VM: Gemini CLI 0.65.0; read 2026-10-22), or the
// sessions-model annex (2026-10-22). A claim of `explicit` is backed by a fixture record.

export const describe = Object.freeze({
  adapter: '@agent-realm/harness-session-adapters/gemini-cli',
  adapter_ver: '0.2.3',
  model_version: 'sessions-model/1',
  harness: 'gemini-cli',
  state_ver: 1,
  // No harness version is certified until conformance runs against a real Gemini CLI. The fixtures
  // come from 0.64.0 (rewind) and 0.65.0 (pass3) captures, scrubbed.
  versions: { certified: [], compatible: [] },
  // `harness_path` is the `.gemini` folder (`$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`; spec §1).
  sources: [
    { pattern: 'tmp/<slug>/chats/session-<YYYY-MM-DDTHH-MM>-[<i>-]<sid8>.jsonl', role: 'main', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
    // A sub-agent's own session (header kind `subagent`). Source-only: spec §11 and the annex (S).
    { pattern: 'tmp/<slug>/chats/<main session id>/<agent>.jsonl', role: 'main', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
    // A pre-0.6x session, one JSON object; replaced by `<name>.jsonl` when the CLI migrates it.
    { pattern: 'tmp/<slug>/chats/session-<YYYY-MM-DDTHH-MM>-<sid8>.json', role: 'main', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
    // The slug's workspace path (spec §1): the cwd when the session's own records name none.
    { pattern: 'tmp/<slug>/.project_root', role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
  ],
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  ts_source: 'event',
  redaction: {
    // sessions-model §4.1 names Gemini CLI checkpoint `authType`. Checkpoint files are never opened
    // (sessions-model §4.7): only chat files and `.project_root` are read, so no value on that path
    // can reach a unit or a record. No secret path is known inside chat records.
    paths: [{ source: 'tmp/<slug>/checkpoint-<tag>.json', path: 'authType', opened: false }],
    exemptions: [],
  },
  facets: {
    // Every chat file under tmp/<slug>/chats/ and its sub-agent directories, keyed by the header's
    // sessionId. A .jsonl whose line 1 is still being written is listed once it is complete; a
    // legacy .json is listed when its sessionId lies in its first 4 KB, where the CLI wrote it.
    list: 'exact',
    // Lossy: a user record's `displayContent` (what the UI showed, when it differs from what the
    // model saw); `tokens.tool` and `tokens.total`; a tool call's `resultDisplay`, `description`,
    // `displayName` and timestamp; thought timestamps; the header's `projectHash`; `$set`
    // `lastUpdated` and `memoryScratchpad`; spilled tool output (`tool-outputs/`) is not read.
    read: 'lossy',
    reuse: 'impossible', // sessionId is a uuid4 (spec §3; annex mapping row)
    lifecycle: {
      rewind: 'explicit', // `$rewindTo`, an append-only retraction (fixtures: rewind, features)
      edit: 'explicit', // `$patch` removeIds and content updates (fixtures: pass3, rewind, features)
      compaction: 'invisible', // UNVERIFIED: no compression record was ever captured (spec §11)
      delete: 'implicit', // `--delete-session` removes the chat file (spec §6)
      archive: 'invisible',
      unarchive: 'invisible',
      rename: 'implicit', // `$set.summary` replaces the title in place; no record of the act
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'invisible', // `/chat save` + resume copies history into a new id, with no pointer (spec §5)
      clear: 'invisible', // a fresh session context is appended in-session (spec §6)
    },
    linkage: {
      fork: 'inferable', // the copy carries the copied content (spec §5; annex: no fork link)
      subagent: 'explicit', // the child's directory, and the parent call's `agentId` (S; fixture: features)
      rewind_copy: 'none',
      clear: 'none', // `/clear` stays in the same session (sessions-model §2.5)
      continuation: 'none',
      tool: 'native', // toolCalls[i].id = functionResponse.id (lab cases, unpublished; fixture: pass3)
      compaction: 'none', // no summary record is known
    },
    // The annex has `?`: no hook payload was observed, so no join is claimed.
    join: { hook: 'no', rule: 'not established (sessions-model annex: ?)' },
  },
});
