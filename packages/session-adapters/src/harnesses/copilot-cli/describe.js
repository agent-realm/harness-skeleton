// What the Copilot CLI adapter declares (sessions v1 §2 `describe`). Every facet is a claim, and
// each cites its source: a fixture under fixtures/copilot-cli/, the adapter spec (unpublished;
// written from synthetic captures on a test VM, 2026-10-19 to 2026-10-21: Copilot CLI
// 1.0.100/1.0.101), or the sessions-model annex. Each `explicit` claim is backed by a fixture
// record, which test/copilot-cli.test.js checks.

export const describe = Object.freeze({
  adapter: '@agent-realm/session-adapters/copilot-cli',
  adapter_ver: '0.2.0',
  model_version: 'sessions-model/1',
  harness: 'copilot-cli',
  state_ver: 1,
  // Observed on 1.0.100 and 1.0.101 (CLI) and 1.0.95-0.unstable (VS Code's agent host); none is
  // certified until conformance runs against a real Copilot CLI.
  versions: { certified: [], compatible: [] },
  sources: [
    // Append-only, whole lines; rewritten through a new inode, shorter, on /rewind (spec §2, §6).
    { pattern: 'session-state/<session>/events.jsonl', role: 'main', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
    // Rewritten whole (new inode) on rename, title, /cwd and custom-agent select (spec §2).
    { pattern: 'session-state/<session>/workspace.yaml', role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
  ],
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  ts_source: 'event',
  redaction: {
    // sessions-model §4.1 declares no Copilot CLI path, and the fixtures show none.
    paths: [],
    // String values under a secret-looking name that are not secrets (sessions-model §4.3), each
    // seen in a fixture: compaction_complete's accounting label (features, pass2), a usage
    // record's token-detail type (vscode-host), and a shell permission request's argv words
    // (`permissionRequest.commandSegments[].staticTokens`; basic, pass2).
    exemptions: ['tokenAccountingBasis', 'tokenType', 'staticTokens'],
  },
  facets: {
    // Every `session-state/<sid>/` with an events.jsonl whose line 1 is a complete
    // `session.start`. `session-store.db` is never read: it keeps orphans, merges a reused id and
    // omits failed sessions (spec §8).
    list: 'exact',
    // Lossy: the side files `session.db` (todos), `plan.md`, `checkpoints/*.md` and
    // `rewind-file-snapshots/` are not read, nor, for a VS Code-hosted session, VS Code's
    // `agentSessionData/<vsSid>/session.db` (title, chosen model, cost; annex). Bookkeeping events
    // (system.message, model.*, hook.*, permission.*, subagent.*, skill.*, abort, task_complete)
    // make no record; their units are returned whole.
    read: 'lossy',
    // The `session.start` event id differs between two lives of one `--session-id`
    // (fixture: conformance-copilot-reuse).
    reuse: 'detected',
    lifecycle: {
      rewind: 'explicit', // events.jsonl rewritten shorter + appended `session.info{rewind}` (fixture: rewind)
      edit: 'implicit', // a rewind, then a resend with new ids (spec §6)
      compaction: 'explicit', // `session.compaction_complete` (fixtures: pass2, features)
      delete: 'implicit', // `/session delete` removes the directory (spec §6)
      archive: 'invisible',
      unarchive: 'invisible',
      rename: 'implicit', // workspace.yaml rewritten, no event (spec §6)
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'explicit', // `session.info{fork}` on both sides (fixtures: features, vscode-host)
      clear: 'invisible', // `/clear` starts a new directory; no event names the old session (spec §6)
    },
    linkage: {
      fork: 'explicit', // the other sid, parsed from `session.info{fork}`'s text (fixtures: features, vscode-host)
      // Sub-agents live in this session's own file, with the envelope `agentId` (spec §5).
      subagent: 'none',
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      tool: 'native', // toolRequests[].toolCallId = tool.execution_complete.toolCallId
      compaction: '{count}', // `messagesRemoved`, no id range (spec §5)
    },
    // Annex §3 (pass3 hook fixtures): a root hook's `input.sessionId` is the session id; a
    // sub-agent hook carries its `agentId` there, and joins as (session, agent_id).
    join: { hook: 'derived', rule: 'input.sessionId = session_id; a sub-agent hook carries its agentId as sessionId and joins as (session, agent_id)' },
  },
});
