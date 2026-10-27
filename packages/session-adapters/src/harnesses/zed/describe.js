// What the Zed adapter declares (sessions v1 §2 `describe`). Every facet is a claim, and each cites
// its source: a fixture under fixtures/zed/, the adapter spec (unpublished; written from synthetic
// captures on a test VM, 2026-10-19: Zed 1.24.3), the memhouse normaliser (which read some shapes
// from Zed's source), or the sessions-model annex (2026-10-22). Each `explicit` claim is backed by
// a fixture record, which test/zed.test.js checks.

const THREADS = 'threads/threads.db#table:threads';
const SIDEBAR = 'db/<channel>/db.sqlite#table:sidebar_threads';

export const describe = Object.freeze({
  adapter: '@agent-realm/session-adapters/zed',
  adapter_ver: '0.2.3',
  model_version: 'sessions-model/1',
  harness: 'zed',
  state_ver: 1,
  // The lab fixture comes from Zed 1.24.3 (thread format 0.3.0); none is certified until
  // conformance
  // runs against a real Zed.
  versions: { certified: [], compatible: [] },
  // `harness_path` is the data folder: `~/.local/share/zed` on Linux (fixture captures),
  // `~/Library/
  // Application Support/Zed` on macOS.
  sources: [
    // This thread's row of the rollback-journal threads.db. `data` is the whole thread as zstd JSON
    // (data_type 'zstd') or plain JSON ('json'), rewritten on every save (fixture captures). The
    // unit is
    // the row with `data` decoded in read (zstd -> JSON, redacted on the paths below) and
    // `orig_sha256`, the sha256 of the blob as stored: a row-json whose `data` is a JSON tree
    // rather
    // than base64 (sessions-model §3).
    { pattern: THREADS, role: 'main', mode: 'snapshot', position_kind: 'snapshot', enc: 'row-json' },
    // This thread's rows of one channel's workspace DB (WAL), projected to `session_id` and
    // `archived`: the archive flag (fixture captures). One source per channel that has a row for
    // it.
    { pattern: SIDEBAR, role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
  ],
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  // No per-message timestamp anywhere in the thread (fixture captures; annex mapping row).
  ts_source: 'none',
  redaction: {
    // The thread holds no credential: the provider key comes from the environment or the keyring
    // (fixture captures). These paths are declared because they carry what the user never typed
    // into
    // the conversation: a remote URL can embed credentials (`https://user:token@host/…`), a diff
    // can hold any file's content, and the draft is unsent input. A value on them is replaced in
    // read, before the unit leaves the adapter.
    paths: [
      { source: THREADS, path: 'data.initial_project_snapshot.worktree_snapshots[].git_state.remote_url', opened: true },
      { source: THREADS, path: 'data.initial_project_snapshot.worktree_snapshots[].git_state.diff', opened: true },
      { source: THREADS, path: 'data.draft_prompt', opened: true },
      // Never opened (sessions-model §4.7): the OS keyring entry that holds a provider key.
      { source: '<OS keyring>', path: '*', opened: false },
    ],
    exemptions: [],
  },
  facets: {
    // Every threads row whose blob is a thread of format 0.3.0 (or an unreadable one, which read
    // reports as `damaged`). A legacy agent-1 thread (messages with `role`; format 0.1.0 / 0.2.0)
    // is
    // not listed until Zed re-saves it as 0.3.0 (memhouse normaliser; fixture: features).
    list: 'partial',
    // Lossy: Agent messages have no native id and no message a timestamp (annex); `is_error` is
    // kept
    // only when true on a call that completed (a failing command stores false, annex §2); a
    // terminal's exit code stays in
    // its
    // output text; an Image's media type is taken as image/png; a Mention keeps its content but not
    // its URI; the model is per thread (a mid-thread switch relabels earlier replies) and its
    // provider is not carried. Usage is one per_session record from `cumulative_token_usage`
    // (annex §4 finding 6): `request_token_usage` holds a turn's last request, part of that total
    // and not a turn total (annex §2), so beside a total it reaches no record (it stays in the raw
    // unit). Where the cumulative is empty, each entry is one per_turn record anchored to its User
    // message, an orphaned entry anchored to its gone User id (sessions-model v1.x proposal (#6), §2.4;
    // fixtures: features, restore).
    // `ui_scroll_position`, `sandbox_grants`, `speed` and the row / thread `updated_at` reach no
    // record either.
    read: 'lossy',
    reuse: 'impossible', // thread ids are uuids (annex mapping row, fx)
    lifecycle: {
      // A checkpoint restore truncates messages[] in place, the restored User message included,
      // with
      // no record of the act; the regrown turn's new User id gives new keys (fixture captures;
      // fixture:
      // restore-lab, a capture of Zed 1.24.3).
      rewind: 'implicit',
      edit: 'implicit', // UNVERIFIED (not observed): editing a sent message truncates and regrows like a restore
      // UNVERIFIED: a Compaction message, read from Zed's source by memhouse, never captured in the
      // lab (fixture: features, synthetic).
      compaction: 'explicit',
      delete: 'implicit', // the threads row goes (memhouse normaliser); not observed in the lab
      archive: 'explicit', // sidebar_threads.archived = 1 (fixture captures; fixture: features)
      unarchive: 'implicit', // the flag cleared: the archive record goes
      rename: 'implicit', // threads.summary updated in place (fixture captures)
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'invisible', // annex: `?`; no fork was observed
      clear: 'invisible', // a new thread; nothing names the old one
    },
    linkage: {
      fork: 'none', // annex: `?`
      // The child's subagent_context.parent_thread_id and row parent_id (lab cases, unpublished; fixture: lab).
      // The parent's spawn_agent result naming the child (origin side) is source-read, UNVERIFIED
      // (fixture: features, synthetic).
      subagent: 'explicit',
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      tool: 'native', // ToolUse.id = the tool_results key (lab cases, unpublished; fixture: lab)
      compaction: '{through_id}', // the summary replaces through the message before it (source-read, UNVERIFIED)
    },
    // Annex: `?`. Zed has no hook surface that names a thread.
    join: { hook: 'no', rule: 'none observed' },
  },
});
