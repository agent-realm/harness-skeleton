# Live check: the shapes no capture has shown yet

Every adapter is proved against fixtures. Most of each fixture follows a lab capture; the rest
was built from the harness's source code or from memhouse's readers, because no run produced it.
This page lists that rest, per harness, with what would establish each item. A live check runs
each harness, signed in, on a disposable test machine. For each item it drives the harness into
that state, runs `list`, `read` and `derive` over the real store, and compares the result with
the adapter's own fixture.

## Status

**No live run was made for this release.** Each open item is marked **not established (no live
run)**: the adapter reads it the way its fixture shows, and that reading rests on the source the
item names, not on a run of the harness. One item has been confirmed since this list was written,
by a capture that is now a fixture, and is marked **confirmed** with that fixture.

| Status | Items |
|---|---|
| Confirmed | 1 |
| Not established (no live run) | 42 |

When a live run confirms an item, mark it confirmed and name the capture or fixture that shows
it; do not delete it. When the real shape differs, fix the adapter and its fixture in the same
PR, then mark it confirmed. A capture that becomes a fixture is scrubbed first
([AGENTS.md, "Fixtures are public"](../AGENTS.md#fixtures-are-public)).

## Every harness

- **The hook join.** Not established (no live run). A session's hook events and its records must
  join on the same key. To establish: fire a hook in a live session, and join its payload to the
  session's records by the rule `describe().facets.join` states.
- **What usage counts** (sessions-model §2.4). Not established (no live run). To establish: run
  one turn that both reads from the cache and reasons:
  - where the flags are set (Claude Code, Codex, Gemini CLI, OpenCode v1), check that any total
    the store keeps equals the sum the flags imply. Today they rest on vendor definitions only;
  - where they are null, find out what `input` and `output` count, and set the flags if a stored
    total or a vendor definition settles it.

## Claude Code and Codex

- **A real session against the goldens.** Not established (no live run). The fixtures are
  synthetic. They follow memhouse's long-running readers, not a lab capture. To establish: run one
  session of each, including a tool call, a compaction and a sub-agent, against the goldens'
  shapes.
- **Codex: the exit code's call id.** Not established (no live run). Codex's newer format keeps a
  command's exit code in an `item_completed` CommandExecution event. In the fixture that event
  names no call id, so `exit_code` stays null there. To establish: check whether a real event
  carries one to join on.
- `cancelled` and `denied` come from a structured marker the harness store writes, or from a
  fixed string the harness itself writes for that case (never tool or model output), matched
  exactly and listed for that harness in the sessions-model annex §5, v1.3; never
  from a pattern in free text (sessions-model v1.3, §2.3). For these two harnesses,
  neither is established (no live run, and no fixture holds the case), so every result is
  `completed` today:
  - **Claude Code: a user's rejection of a tool call, or an interrupt during one.** Not
    established (no live run). The adapter copies the `tool_result` block's `is_error`. What would
    establish a status: a structured field the store writes for the rejection or the interrupt,
    beside the block rather than in its text. If one is found, a rejection is `denied` and an
    interrupt `cancelled`, each with `is_error` null. If the store tells it only in the result's
    text, that text counts only where it is a fixed string Claude Code itself writes for the case,
    read from a source the annex can cite and matched exactly; otherwise the result stays
    `completed`, with the block's own flag.
  - **Codex: an aborted call (`aborted`).** Not established (no live run). The adapter copies a
    stored `success` and is null without one. What would establish a status: `aborted` as a field
    or a status of the call's output, or an event that names the call. The `turn_aborted` events
    in the fixtures (`reason: interrupted`) name no call. If such a field is found, the call is
    `cancelled`, with `is_error` null. If `aborted` is only the output's text, it counts only where
    it is a fixed string Codex itself writes for the case, matched exactly (Codex's source is
    public); otherwise the result stays `completed`, with the store's flag (null where the output
    keeps none).

## Copilot CLI

- **The wording a fork child writes about itself.** Not established (no live run). The origin's
  wording is in a fixture; the child's is in none. To establish: fork a session, and read the
  child's own `session.info` event about the fork.
- **That a `usage_record` comes before the message it bills.** Not established (no live run). The
  adapter takes a reply's served model and effort from the `usage_record` of the same API call. To
  establish: run a turn and check the order of the two events in `events.jsonl`.

## Gemini CLI

- **The sub-agent file layout.** Not established (no live run). To establish: run a sub-agent and
  compare where its file lands, and its name, with what `list` expects.
- **Compaction.** Not established (no live run). No compression record was ever captured, so the
  adapter declares compaction `invisible`. To establish: compress a long session and see whether
  the store records it.
- **`orderIds`.** Not established (no live run). To establish: capture a session whose records
  carry `orderIds`, and compare the message order with the golden's.

## VS Code

- **`modelState` values other than 1.** Not established (no live run). To establish: capture a
  pending, a cancelled and a failed reply.
- **`kind 3` entries.** Not established (no live run). To establish: capture a chat file holding
  one, and compare the derived records with the fixture's.
- **A `kind 0` in the middle of a file.** Not established (no live run). Only the synthetic
  fixture shows one. To establish: capture a chat file in which VS Code wrote one.
- **`isConfirmed.type` 5, read as a skipped tool call.** Not established (no live run). Only 1 and
  4 are observed; 5 is the reading the adapter marks UNVERIFIED. The adapter makes such a call
  `cancelled` with `is_error` null (sessions-model v1.3, §2.3), a `resultError` beside it
  included. To establish: skip a tool call in a live run and check the stored value.

## Goose

- **The usage ledger's time window, and the compaction anchor, which is found by time.** Not
  established (no live run). To establish: run a session through a compaction, and check that each
  ledger row lands on the message or the compaction the adapter anchors it to.
- **Four lab rows were completed by hand.** Not established (no live run). The capture tool cut
  long cells in them. To establish: capture those rows whole and compare.

## OpenCode

- **The DDL, which was rebuilt from the spec and the captured columns.** Not established (no live
  run). To establish: dump OpenCode's own schema and compare it with the fixture's.
- **A v2 assistant row, which was rebuilt from its events.** Not established (no live run). To
  establish: capture a v2 assistant row before a revert deletes it.
- **A call cut off by a stopped turn.** Not established (no live run). An `error` part with
  `metadata.interrupted: true` and the text `Tool execution aborted`, read from OpenCode's source
  (`packages/opencode/src/session/processor.ts:591-607`). The `features` session `Stopped fetch`
  is synthetic. The adapter makes such a call `cancelled`, `is_error` null, from the marker. To
  establish: stop a turn while a call runs and check the stored part.

## Antigravity (agy)

- **Whether a rewind deletes `gen_metadata` and `executor_metadata` rows.** Not established (no
  live run). To establish: rewind a session and compare those tables before and after.
- **Whether a `response_id` is unique.** Not established (no live run). To establish: run several
  turns and look for a `response_id` that repeats.
- **A transcript line whose `status` is CANCELED or INTERRUPTED.** Not established (no live run):
  the `transcript-cancel` fixture is synthetic. The adapter reads one as the database reads the
  step: `cancelled`, `is_error` null. To establish: stop a tool call and cut one off in a live
  session, and read the `status` of their transcript lines.

## Cursor IDE

- **The lab case is thin.** Not established (no live run). Its captured composerData came from
  another moment than its bubbles, so 5 of its 7 chats have no messages, and two cut `params`
  cells were completed by hand. To establish: capture composerData and the bubbles in one pass.
- **A rewind (expected: implicit, truncated on the next send) and a delete.** Not established (no
  live run). To establish: rewind a chat and send again, then delete a chat, capturing after each.
- **Where tokens are stored on a paid plan.** Not established (no live run). The free plan stores
  `{0,0}`. The adapter sums `tokenCount` over a reply's child bubbles, as memhouse did. To
  establish: check that each child carries its own call's counts, not a copy of the turn's, which
  the sum would multiply.
- **Whether an older Cursor, with no `composerHeaders` table, leaves bubbles behind when a chat is
  deleted.** Not established (no live run). Bubbles without a composerData row read as no session
  there. To establish: delete a chat in such a version and look for its bubbles.
- **How tool bubbles and text bubbles interleave.** Not established (no live run). To establish:
  capture a turn with several tool calls and compare the bubble order with the golden's.
- **A sub-agent link.** Not established (no live run). Only a synthetic fixture shows it. To
  establish: run a sub-agent and capture both chats.
- **That composerData is written as TEXT and bubbles as BLOB.** Not established (no live run). To
  establish: check `typeof(value)` of both kinds of row in a real store.
- **Whether `empty-state-draft` is reused.** Not established (no live run). The archived draft's id
  is not a uuid. To establish: archive more than one draft, and see whether each gets that id.

## cursor-agent

- **An ACP store (`acp-sessions/<id>/store.db`) holding a turn.** Not established (no live run).
  To establish: run a turn over ACP and read its store.
- **An MCP call, and the `google.protobuf.Value` shapes in its arguments.** Not established (no
  live run). No MCP call was observed. To establish: call an MCP tool with arguments of several
  types.
- **Step kind 34, which is truncated in the source.** Not established (no live run). To
  establish: capture a step of that kind.
- **Whether a step is written while it streams.** Not established (no live run). Real stores pass
  through a "text step only" state, so a reply can be read once before it is held. To establish:
  read the store repeatedly while a reply streams.

## Zed

- **Resume, compaction, the parent-side `spawn_agent` link, a Mention and an Image.** Not
  established (no live run). The shapes come from Zed's source, and the fixtures are synthetic. To
  establish: capture a thread with each.
- **The `sidebar_threads` schema, which is taken from memhouse's test.** Not established (no live
  run). To establish: dump the schema of a real channel database and compare.
- **A checkpoint restore, and the thread growing again after it.** Confirmed: fixture
  `zed/restore-lab`, a Zed 1.24.3 capture of a restore and a regrow. One detail is not
  established (no live run): whether a turn that survives a restore keeps its
  `request_token_usage` entry, because the capture restored to the first message. To establish
  it: restore to a later message.
- **Editing and deleting a thread, and the rule that detects a legacy agent-1 thread.** Not
  established (no live run). To establish: edit a sent message, delete a thread, and capture a
  thread in the older agent-1 format.
- **A canned cancel or denial stored as one Text value rather than a list.** Not established (no
  live run). Builds before Zed's multi-part tool content (commit bf3fc2336d) wrote it so. It is
  read from Zed's source history: no fixture or capture holds one, and the test edits a copy. The
  adapter reads it as Zed v1.24.3 does, a list of one. To establish: open a thread such a build
  saved with a cancelled call and check the stored content.

## Devin Local

- **There is no lab case.** Not established (no live run). The scrubbed samples are single rows,
  not whole trees. To establish: capture whole session trees.
- **The `subagent_heads` row while a sub-agent runs.** Not established (no live run). It is
  inferred, because the captures only ever showed that table empty. To establish: read the store
  while a sub-agent runs.
- **`/clear` (expected: invisible), the hook join, `client: 'devin'`, and the hidden summary-agent
  session (`kind: 'hidden'`).** Not established (no live run). To establish: run `/clear`, fire a
  hook, and fork a session to capture the summary-agent session the fork starts.
