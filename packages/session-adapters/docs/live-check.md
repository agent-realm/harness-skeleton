# Live check: the shapes no capture has shown yet

Every adapter is proved against fixtures. Most of each fixture follows a lab capture; the rest
was built from the harness's source code or from memhouse's readers, because no run produced it.
This page lists that rest, per harness. A live check runs each harness, signed in, on a
disposable test machine. For each item it drives the harness into that state, runs `list`, `read` and `derive`
over the real store, and compares the result with the adapter's own fixture.

When an item is confirmed, delete it here. When the real shape differs, fix the adapter and its
fixture in the same PR, then delete it. A capture that becomes a fixture is scrubbed first
([AGENTS.md, "Fixtures are public"](../AGENTS.md#fixtures-are-public)).

## Every harness

- **The hook join.** A session's hook events and its records must join on the same key.
- **What usage counts** (sessions-model §2.4). Run one turn that both reads from the cache and
  reasons:
  - where the flags are set (Claude Code, Codex, Gemini CLI, OpenCode v1), check that any total
    the store keeps equals the sum the flags imply. Today they rest on vendor definitions only;
  - where they are null, find out what `input` and `output` count, and set the flags if a stored
    total or a vendor definition settles it.

## Claude Code and Codex

- The fixtures are synthetic. They follow memhouse's long-running readers, not a lab capture.
  Run one session of each, including a tool call, a compaction and a sub-agent, against the
  goldens' shapes.
- Codex's newer format keeps a command's exit code in an `item_completed` CommandExecution event.
  In the fixture that event names no call id, so `exit_code` stays null there. Check whether a
  real event carries one to join on.

## Copilot CLI

- The wording a fork child writes about itself.
- That a `usage_record` comes before the message it bills.

## Gemini CLI

- The sub-agent file layout.
- Compaction.
- `orderIds`.

## VS Code

- `modelState` values other than 1.
- `kind 3` entries.
- A `kind 0` in the middle of a file.
- `isConfirmed.type` 5, read as a skipped tool call: not established (no live run). Only 1 and 4
  are observed; 5 is the reading the adapter marks UNVERIFIED. The adapter makes such a call
  `cancelled` with `is_error` null (sessions-model v1.x (#6), §2.3), a `resultError` beside it
  included. Skip a tool call in a live run and check the stored value.

## Goose

- The usage ledger's time window, and the compaction anchor, which is found by time.
- Four lab rows were completed by hand.

## OpenCode

- The DDL, which was rebuilt from the spec and the captured columns.
- A v2 assistant row, which was rebuilt from its events.

## Antigravity (agy)

- Whether a rewind deletes `gen_metadata` and `executor_metadata` rows.
- Whether a `response_id` is unique.
- A transcript line whose `status` is CANCELED or INTERRUPTED: the `transcript-cancel` fixture is
  synthetic. The adapter reads one as the database reads the step: `cancelled`, `is_error` null.

## Cursor IDE

- The lab case is thin: its captured composerData came from another moment than its bubbles, so
  5 of its 7 chats have no messages, and two cut `params` cells were completed by hand. Capture
  composerData and the bubbles in one pass.
- A rewind (expected: implicit, truncated on the next send) and a delete.
- Where tokens are stored on a paid plan. The free plan stores `{0,0}`. The adapter sums
  `tokenCount` over a reply's child bubbles, as memhouse did: check that each child carries its own
  call's counts, not a copy of the turn's, which the sum would multiply.
- Whether an older Cursor, with no `composerHeaders` table, leaves bubbles behind when a chat is
  deleted. Bubbles without a composerData row read as no session there.
- How tool bubbles and text bubbles interleave.
- A sub-agent link: only a synthetic fixture shows it.
- That composerData is written as TEXT and bubbles as BLOB.
- Whether `empty-state-draft` is reused.

## cursor-agent

- An ACP store (`acp-sessions/<id>/store.db`) holding a turn.
- An MCP call, and the `google.protobuf.Value` shapes in its arguments. No MCP call was observed.
- Step kind 34, which is truncated in the source.
- Whether a step is written while it streams. Real stores pass through a "text step only" state,
  so a reply can be read once before it is held.

## Zed

- Resume, compaction, the parent-side `spawn_agent` link, a Mention and an Image: the shapes come
  from Zed's source, and the fixtures are synthetic.
- The `sidebar_threads` schema, which is taken from memhouse's test.
- A checkpoint restore, and the thread growing again after it.
- Editing and deleting a thread, and the rule that detects a legacy agent-1 thread.

## Devin Local

- There is no lab case: the scrubbed samples are single rows, not whole trees.
- The `subagent_heads` row while a sub-agent runs. It is inferred, because the captures only ever
  showed that table empty.
- `/clear` (expected: invisible), the hook join, `client: 'devin'`, and the hidden summary-agent
  session (`kind: 'hidden'`).
