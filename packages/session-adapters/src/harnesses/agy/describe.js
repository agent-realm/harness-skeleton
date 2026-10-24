// What the agy adapter declares (sessions v1 §2 `describe`). Every facet is a claim, and each cites
// its source: a fixture under fixtures/agy/, the adapter spec (unpublished; written from synthetic
// captures on a test VM, 2026-10-21: agy 1.4.4), or the sessions-model annex (2026-10-22). Each
// `explicit` claim is backed by a fixture record, which test/agy.test.js checks.

export const describe = Object.freeze({
  adapter: '@agent-realm/session-adapters/agy',
  adapter_ver: '0.2.0',
  model_version: 'sessions-model/1',
  harness: 'agy',
  state_ver: 2,
  // Observed on 1.4.3 and 1.4.4 (spec §1); none is certified until conformance runs against a real
  // agy.
  versions: { certified: [], compatible: [] },
  // `harness_path` is `~/.gemini/antigravity-cli` (only HOME moves it; spec §1).
  sources: [
    // Upserted while a step runs; hard-deleted on a rewind, which reuses the idx (spec §2, §6).
    { pattern: 'conversations/<id>.db#table:steps', role: 'main', mode: 'delta', position_kind: 'rowid', enc: 'row-json' },
    // Projected: the fields derive reads, without the prompt it re-stores (spec §3).
    { pattern: 'conversations/<id>.db#table:gen_metadata', role: 'side', mode: 'delta', position_kind: 'rowid', enc: 'row-json' },
    { pattern: 'conversations/<id>.db#table:executor_metadata', role: 'side', mode: 'delta', position_kind: 'rowid', enc: 'row-json' },
    { pattern: 'conversations/<id>.db#table:parent_references', role: 'side', mode: 'delta', position_kind: 'rowid', enc: 'row-json' },
    { pattern: 'conversations/<id>.db#table:trajectory_metadata_blob', role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
    // Append-only (spec §2): `side` beside a DB, where it gives the rewinds only; `main` without
    // one.
    { pattern: 'brain/<id>/.system_generated/logs/transcript_full.jsonl', role: 'side', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
    { pattern: 'brain/<id>/.system_generated/logs/transcript_full.jsonl (no conversations/<id>.db)', role: 'main', mode: 'stream', position_kind: 'byte_offset', enc: 'utf8' },
    // This session's row of the index shared with the hub and the IDE, without its counters.
    { pattern: 'conversation_summaries.db#table:conversation_summaries', role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
    { pattern: 'annotations/<id>.pbtxt', role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
    // A tool's whole output, when the step holds a cut copy (generic.result.full_output_uri).
    { pattern: 'brain/<id>/.system_generated/steps/<idx>/output.txt', role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'utf8' },
  ],
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  ts_source: 'event',
  redaction: {
    // sessions-model §4.1 declares no agy path. The credential files (`antigravity-oauth-token`,
    // `jetski-standalone-oauth-token`; annex mapping row) are never opened: list and read touch
    // only
    // the paths above. Signatures are read as lengths only.
    paths: [],
    // The annex's agy exemptions (sessions-model §4.3), all inside protobuf blobs: they reach a
    // name lint only through a pb-json decoding; this adapter's units keep the blobs as base64.
    exemptions: ['aggregation_key', 'accumulated_sections.key', 'time_to_first_token'],
  },
  facets: {
    // Every `conversations/<id>.db`, and every brain transcript with no DB. An empty conversation
    // (0
    // steps; `/clear`, a failed headless run) and an orphaned sub-agent are sessions (spec §6).
    list: 'exact',
    // Lossy: gen_metadata is projected (prompts, tools, context breakdown are not read); the
    // credit cost, the planner's bot message id and the step's permissions and interactions make
    // no field (a RunCommand's exit code is `exit_code`, from the DB only: the transcript keeps
    // none); `brain/<id>/` messages, tasks, subagents and
    // artifacts, `transcript.jsonl`, `history.jsonl` and the caches are not read. Without a DB the
    // transcript has no ids, pairs tools by position, never writes a CANCELED step and never
    // updates a RUNNING one (spec §2, §8).
    read: 'lossy',
    reuse: 'impossible', // cascade ids are uuid4, not reused after delete (annex mapping row)
    lifecycle: {
      rewind: 'explicit', // a lower step_index in the transcript (fixtures: rewind, transcript)
      edit: 'implicit', // a rewind, then a new prompt (spec §6)
      compaction: 'explicit', // a CHECKPOINT step (fixtures: features, transcript)
      delete: 'implicit', // the DB, the annotation and the brain dir are removed (spec §6)
      archive: 'implicit', // the annotation's `archived` flag; no CLI command (spec §2, §6; source-only)
      unarchive: 'implicit',
      rename: 'implicit', // the annotation and the summaries title are rewritten (spec §2)
      pin: 'implicit', // the annotation's `pinned` flag (spec §2; source-only)
      unpin: 'implicit',
      fork: 'explicit', // a parent_references FORK row (fixture: fork)
      clear: 'invisible', // `/clear` starts a new conversation; nothing names the old one (spec §6)
    },
    linkage: {
      fork: 'explicit', // parent_references (fixture: fork; lab cases, unpublished)
      subagent: 'explicit', // the child's parent_conversation_id, the parent's invoke_subagent result (fixture: subagent)
      rewind_copy: 'none',
      clear: 'none', // sessions-model §2.5: no record names the old session
      continuation: 'none',
      // planner tool_calls[].id = the GENERIC step's metadata.tool_call.id (lab cases, unpublished; fixtures:
      // features, pass3). Without a DB the transcript pairs by position (`positional`).
      tool: 'native',
      compaction: '{through_index}', // CHECKPOINT included_step_index_end (lab cases, unpublished; fixture: features)
    },
    // Annex §3 (pass3 hook payloads): every event's `conversationId` is the cascade id; `stepIdx`
    // names the step, whose message has `order` = the idx.
    join: { hook: 'yes', rule: 'conversationId = session_id; stepIdx = the step idx (the message order)' },
  },
});
