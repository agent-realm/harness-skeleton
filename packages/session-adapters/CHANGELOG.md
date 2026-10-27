# Changelog

`@agent-realm/session-adapters`. A change that moves a record's key carries a migration note here
(sessions-model §1 rule 8): the harness, the `adapter_ver` and how old keys map to new ones. See
[Versions](docs/adapter-interface.md#versions) for what each version bump asks of a consumer.

## Unreleased

### Contract citations: the v1.x proposal

- Rules cited as "sessions-model v1.x proposal (#6)" or "sessions v1.x proposal (#6)" follow the
  v1.x proposal in sessions-model pull request #6. They take effect as cited when that proposal is
  released; until then the released contract is v1.2.0. The citations here and in the code switch
  to the released reference when it is.

### sessions-model v1 (adapter_ver 0.2.0, model_version `sessions-model/1`)

Every adapter's records change for the same units, so every `adapter_ver` moves to 0.2.0 and a
consumer re-derives (see [Versions](docs/adapter-interface.md#versions)).

- **Every session record carries `setup`**, null unless the harness store records it
  (sessions-model §2.1). No harness in this package records one yet.
- **Every usage record carries `tool_prompt`** (§2.4). Gemini CLI fills it from a record's
  `tokens.tool`; it is null everywhere else.
- **Codex: positional ids are qualified by the rollout's file name** (§1 rule 10), so two
  rollouts of one session never share a key. **Migration:** for every Codex record keyed on a
  position (an item without `payload.id`, a compaction, a call with no native `call_id`), the old
  key `@<offset>` becomes `<rollout file name>@<offset>`, where the file name is the basename of
  the record's rollout (its `source_key`). A derived call id `@@<offset>:<n>` becomes
  `@<rollout file name>@<offset>:<n>`. The file name, not the whole `source_key`, so that
  archiving (a move into `archived_sessions/`) keeps every key.
- **zed `restore-lab`**: a captured checkpoint restore and regrow (Zed 1.24.3, on a test VM), the
  fixture sessions-model's Anchored ids item cites.

### The fixture guard states what is allowed

- `test/public-fixtures.test.js` is allowlist-based where it can be: model fields and `gateway/`
  ids must name a toy model, a listed public vendor model or a listed placeholder; times carry no
  offset but UTC; a URL names no port. Its examples are generic, so it names nothing a fixture
  once held. The decoder it shares is `conformance/decode.js`.

### Fixtures normalised for publication

- **The captured fixtures are normalised for publication:** synthetic model output of the same
  byte length, neutral ids and UTC times.
- **Goldens:** only the normalised values change, plus each changed text's `cmp_sha`. Where a
  normalised value changed length, the byte offsets after it move: Copilot `order` values and
  Gemini CLI's positional lifecycle ids. One cursor-agent archive id (its message and its
  lifecycle record) is new, because it is the sha256 of a blob that holds normalised ids. No key
  changes except through a normalised id, so no `adapter_ver` moves.

### Registries accepted (sessions-model v1 §8, sessions §5)

- **`validateSession` warns on an unknown registry value and refuses none.** `harness` and
  `ts_source` grow in v1.x, so a value this version does not know gives a finding with
  `warning: true`, once per value; the records stay valid. An empty or non-string value is still
  refused. Closed lists are unchanged.
- The conformance checks stay strict: this package emits only registered values, so a warning on
  one of its own fixtures is still a finding.
- A test holds the reference consumer (`conformance/engine.js`) to `enc` and `position_kind` too:
  it passes a unit of an unknown `enc` to `derive` and keeps a position of an unknown kind
  verbatim. Nothing in the package checks those two against a list.

### claude-code: a gateway's tool results are kept (adapter_ver 0.2.1)

- **A plain `tool_result` block in an assistant record is a `tool_result` part of the reply.** A
  gateway that runs a tool itself writes the call and its result into the response, and the
  adapter read only the server-tool `*_tool_result` blocks there, so those results were dropped.
  `is_error` is kept when the block carries it. No key changes; consumers re-derive claude-code
  sessions. Fixture: the `features` record …0014.

### Smaller derive state: claude-code and codex (state_ver 2)

The derive state grows with the number of record keys, not with unit bytes. claude-code and codex
now keep a unit's position as `[source index, unit key]` and rebuild its `order` string when they
compare, instead of repeating the source path per record. Their usage state keeps counters, not
whole usage records. Records are unchanged, so no `adapter_ver` moves. A consumer drops the saved
state of these two harnesses and refolds (see [Versions](docs/adapter-interface.md#versions)).

| Synthetic session (turns × tool output) | claude-code state, before → after | codex state, before → after |
|---|---|---|
| 2000 × 100 B | 5.48 → 2.72 MB (457 → 227 B per key) | 5.53 → 3.19 MB (553 → 319 B per key) |
| 2000 × 2 KB | 5.48 → 2.73 MB | 5.54 → 3.20 MB |
| 500 × 20 KB | 1.37 → 0.68 MB | 1.38 → 0.80 MB |

What remains is one entry per key: its `content_sha` (change detection and `live`), its position,
and a message's `cmp_sha` (the fingerprint). Codex keys are longer because a positional message id
carries its rollout's file name (sessions-model §1 rule 10). A test now holds every adapter's
`describe()` versions to what its `derive` returns.

### Support for consumers

- **`@agent-realm/session-adapters/validate`**, a new export: `validateSession(records, {harness,
  sessionId})` checks one session's records against the record shapes of sessions-model §2 and
  returns `[{at, problem}]` (valid when every finding is a warning: see *Registries accepted*). It checks shape, not meaning: enums, ISO times,
  non-empty string keys and call ids that are unique and carry no time, one session record with
  `setup`, usage with `tool_prompt` and no retired `basis`, an error part's `error_kind`.
- **The conformance matrix**: `conformance/checklist.js` lists the 32 adapter-side items of
  sessions-model v1 (21, and the v1.x proposal's `is_error`) and sessions v1 (10); `conformance/matrix.js` says, for every item and
  every harness, what proves it: `generic` (a check in `conformance/generic.js`, run over every
  fixture case), a named test, `n/a` with the reason, or `open` with the reason, for an item
  whose reading waits on a ruling (no cell is `open` today). `docs/conformance-matrix.md` is
  generated from it.
  `test/conformance-matrix.test.js` refuses a missing cell, an unknown item or harness, and a
  named test that is not exactly one test, and holds each generic check to the break it exists
  for.
- **Anchored ids** (sessions-model §1 rule 4, as v1 rules it): new tests show a reply
  regrown under a surviving anchor keeps its key, revised, for Goose (`<id>+n`) and Cursor
  (`<bubbleId>:assistant`). Records are unchanged: no `adapter_ver` moves.
- **`unitsFromBytes(harness, source_key, bytes, {start})`**, a new package export, plus one per
  adapter with file sources: claude-code, codex, copilot-cli, gemini-cli, vscode, agy,
  cursor-agent and opencode. It returns the units `read` returns from scratch for a file holding
  `bytes`, as `{units, held_back}`, with no position, no continuity and no file system. A
  database source is a `bad_request`. For a consumer that re-derives from archived raw bytes.
- `src/sources.js`: `read`'s line split is now `splitLines`, and its snapshot unit
  `snapshotUnit`. `read` and `unitsFromBytes` share both. `read`'s output is unchanged: no
  `adapter_ver` moves.
- Tests:
  - `units-from-bytes.test.js` holds `unitsFromBytes` to `read` on every file source of every
    fixture;
  - `require.test.js` checks that CommonJS `require()` loads all twelve adapters;
  - `derive-state.test.js` checks that every derive state survives a JSON round trip.
- Docs: a Versions section in `docs/adapter-interface.md` (`model_version`, `adapter_ver`,
  `state_ver`, key migrations).

### gemini-cli: thought summaries kept beside API-part content (adapter_ver 0.2.1)

- **A reply's thought summaries (`thoughts`) are reasoning parts unless its content carries a
  `thought` part.** The CLI's history replay drops them once the history sync has rewritten the
  content as API parts (a `functionCall` part); capture kept that rule, so a reply with calls and
  summaries but no `thought` part lost its reasoning. A `thought` part in the content still stands
  for the summaries, so reasoning is not counted twice. No key changes; consumers re-derive
  gemini-cli sessions. Fixture: the `features` session `6e7f8091…`.

### gemini-cli: a record's model is the requested model only (adapter_ver 0.2.2)

- **A usage record's `model` is null.** The adapter wrote a gemini record's `model` as the
  message's `requested_model` and also as its usage record's `model`, which sessions-model §2.4
  defines as the served model. Gemini CLI records the model it named in its own request (after its
  model selection, fallback and hooks), never the response's `modelVersion`, which it keeps only
  in telemetry (google-gemini/gemini-cli at 363a131: `packages/core/src/core/geminiChat.ts`
  1239-1240 and 1767-1768, `packages/core/src/services/chatRecordingService.ts` 1099). The
  sessions-model annex says the same: "record `model` (requested id)". The message keeps
  `requested_model`, and `served_model` stays null.
- **Goldens:** `usage.model` becomes null on 20 usage records (features 12, pass3 4, legacy 2,
  rewind 2). Nothing else moves. No key changes; consumers re-derive gemini-cli sessions. A
  reader that wants a model per usage record takes the anchored message's `requested_model`.

### vscode: `describe().redaction.paths` in the documented shape

- **`redaction.paths` is a list of `{source, path, opened}`**, as `docs/adapter-interface.md`
  fixes it and every other adapter writes it. It held a bare string,
  `'**.selectedModel.metadata.auth'`. It now holds that path once per chat source (the `.jsonl`
  change log and the `.json` snapshot, in a workspace's `chatSessions/` and in
  `emptyWindowChatSessions/`), `opened: true`.
- Only `describe()` changes. What `read` redacts, its units and the records are the same, so no
  `adapter_ver` moves and no golden changes.
- A test holds every adapter's `redaction.paths` to that shape (`test/describe.test.js`).

### claude-code and codex: derive's `held` in the documented shape

- **`held` is `{session, message, usage, link, lifecycle}`, each an empty list**, the shape of
  `live` that sessions v1 §2 and `docs/adapter-interface.md` give it. Both adapters returned
  `held: {}`. Neither derive holds a record (a record is final once its line is whole), so the
  lists stay empty.
- `changed`, `live`, the records and the state are the same: no `adapter_ver` or `state_ver`
  moves, and no golden changes. A consumer that read a missing list as empty sees no difference.
- A test holds every adapter's `held` to the five record types of `live` after a full replay of
  every fixture case (`test/derive-state.test.js`).

### copilot-cli and codex: `is_error` is the stored flag only (adapter_ver 0.2.1 each)

sessions-model v1.x proposal (#6), §2.3 (`tool_result.is_error`): an adapter copies the harness store's
success or error flag and never derives `is_error` from the exit code or the text. A flag that says
success beside a shell's non-zero `exit_code` is unreliable for that result (Copilot CLI and Codex
store `success: true` so): that result's `is_error` is null, and the harness store's other results
keep the flag. Both adapters applied an exit-code rule inherited from an earlier reader.

- **copilot-cli:** `success: false` gives true and `success: true` gives false, except where the
  shell exited non-zero under `success: true`: there `is_error` is null and `exit_code` carries the
  failure. An event with no `success` gives null.
- **codex:** a rollout's tool output keeps no success flag (an `{output, metadata}` string, or plain
  text), so `is_error` is null; `metadata.exit_code` stays in `exit_code`. Where an output does carry
  `success`, it is copied, with the same rule for `success: true` beside a non-zero exit code. No
  fixture rollout carries one.
- **Goldens:** `parts[0].is_error` changes on 14 tool results, and with it each message's
  `cmp_sha` (`is_error` is in its projection) and that entry of the session's
  `fingerprint.cmp_shas`. Nothing else moves.
  - copilot-cli, 4 results, `true` → `null` (success true, exit 1): `basic` 2, `features` 1 in each
    of the two sessions that hold the call.
  - codex, 10 results, every one with a `metadata.exit_code` and no flag: `basic` 4 (3 `true`, 1
    `false`), `features` 2 (1 `true`, 1 `false`), `no-ids` 4 (1 `true`, 3 `false`), each now `null`.
    `live`'s plain-text outputs were null already.
- No key changes; consumers re-derive copilot-cli and codex sessions. A reader that wants a shell's
  failure reads `exit_code`.

### cursor-agent, cursor and zed: a sub-agent session's `kind` is null (adapter_ver 0.2.1 each)

sessions-model v1.x proposal (#6), §2.1 (`kind`, the native session type): an adapter never mints a `kind`
the harness store does not write, and a flag or a parent reference is not a kind. cursor-agent's
`subagentInfo`, Cursor IDE's `isSubagent` and Zed's `subagent_context` or `parent_id` leave `kind`
null, and such a sub-agent session is told by its `subagent` link (§2.5). Each adapter wrote
`'subagent'`.

- **cursor-agent:** for a chat whose `meta.subagentInfo` names a parent. The fact stays the
  child-side `subagent` link from `meta.subagentInfo`, and the parent-side link from its Task
  result, both unchanged.
- **cursor** (Cursor IDE): for a chat whose `composerHeaders` row has `isSubagent = 1`. A child
  names no parent, so the fact is the parent's origin-side link from
  `composerData.subagentComposerIds`, unchanged. `isSubagent` now reaches no record; it stays in
  the raw unit.
- **zed:** for a thread whose `subagent_context.parent_thread_id` or row `parent_id` names another
  thread. The fact stays the child-side `subagent` link from either, unchanged.
- **Goldens:** one field per sub-agent session, `kind` `"subagent"` → `null`; nothing else moves:
  - cursor-agent: the `subagent` case's child session;
  - cursor: `features`, the child chat `c0c0a005…`;
  - zed: `features`, the child thread `…c5`, and `lab`, the child thread `865975e1…`.
- **adapter_ver:** cursor 0.2.0 → 0.2.1. cursor-agent and zed stay at 0.2.1, the bump each already
  carries in this unreleased change: a consumer re-derives once for it.
- No key changes; consumers re-derive the three harnesses' sessions. A reader that wants to know
  whether a session is a sub-agent reads its `subagent` links.

### zed: per-turn usage where the cumulative total is empty (adapter_ver 0.2.1)

sessions-model v1.x proposal (#6), §2.4 (*No overlap*, whose one Zed record assumes a total): where a
thread's `cumulative_token_usage` is empty, its `request_token_usage` entries are the usage. The
adapter emitted no usage at all for such a thread.

- **One record per entry**: `usage_id` `message:<user id>#1`, `anchor` `{message_id: <user id>}`
  (the User message the entry is keyed by), `granularity: per_turn`, `input_includes_cache` and
  `output_includes_reasoning` null, `model` null. An entry with no counter gives no record: never a
  zero record.
- **A non-empty cumulative is unchanged**: one `per_session` total, `session#1`, and the entries
  stay in the raw unit, so nothing is counted twice.
- **The running turn's usage is held** with its reply (#6, §2.4, with sessions §2 `held`): its entry is
  rewritten by every request of the turn. Released with the reply, and held again, with its last
  version standing, when Zed regenerates the reply.
- **An orphaned entry is still a record**: one keyed by a User message the thread no longer holds
  (after a checkpoint restore) is emitted, anchored to that id, because it is spend. Its `usage_id`
  keeps its key across the restore. A test keeps one through a synthetic save; `restore-lab`'s
  restore cleared every entry, so Zed has not been seen to keep one.
- **Goldens:** three usage records are new, nothing else moves:
  - `features`, the held thread: `message:…a9#1` (input 500, output 20). Its running turn's
    `message:…aa#1` is held, so it is in no golden.
  - `restore`: `message:…e1#1` (400, 9) and `message:…e4#1` (530, 16), the last save's two entries.
- The conformance checks accept `per_turn` with a `message_id` anchor for zed beside `per_session`
  with `session` (`conformance/generic.js`); the matrix's M.usage cell for zed names the new test.
- No key changes; consumers re-derive zed sessions.

### devin: only the main line tears a read (adapter_ver 0.2.1)

sessions v1.x proposal (#6), §2 (`read` errors, `inconsistent`, whose Devin example is a `main_chain_id`
naming a node not yet written): only the main line itself tears a Devin read, its head and the
parent links along it. A node the main line only names (a sub-agent head, a compacted history's
prior nodes, a sub-agent chain a tool result names) that the read lacks does not: derive leaves out
what it would have reached, the raw unit keeps the naming row, and a later read that holds the node
derives it.

- **`read`:** a dangling `main_chain_id`, or a parent link along the main line that the read cannot
  follow (after a compaction or a mode switch, the re-rooted copies are that line), still throws
  `inconsistent`. These no longer do, and the read returns the snapshot: a `subagent_heads` row
  naming a node the read does not hold, or whose chain it does not hold whole; a compacted history
  (`summarized_from`) the read does not hold whole; a sub-agent chain a tool result names
  (`subagent/chain_node_id`) that it does not hold whole. A loop anywhere is still `damaged`.
- **`derive` leaves out what the dangling node would have reached.** Its chain cannot be walked,
  so its held nodes cannot be named. They would otherwise read as an abandoned branch (messages
  with `on_active_branch: false`). While something dangles, a node is left out only when no valid
  head reaches its tree and no tree holding a main-line node contains it. A tree is kept when it
  holds a node the plan reached from the main line or a node of a valid sub-agent head's chain, or
  the original such a node names through `compact/prior_node_ids`. So a sub-agent's task, a root
  of its own re-rooted under its prompt (fixture `features`, session `dusty-lantern`), is left out
  with its chain. Off-line trees that exist without the dangling node keep their normal treatment:
  a mode switch's old root, a valid sub-agent's pre-copy task, and the abandoned branches in either
  (save for the old root while a compacted history tears, below).
- **A compacted history that tears is left out whole**, with its compaction record and summary
  message. A compaction re-roots the line as a mode switch does, so the tree its history sits in is
  named by the line's prefix copies; while that history tears, a tree named only that way is left
  out with it. Its nodes above the gap cannot be told from an abandoned branch there. A side
  effect: where the compacted history is a mode switch's line, the switch's old root is named only
  through the history's copies, so it is left out too, with any branch abandoned in it (fixture
  `switch-compaction`). Such a branch is held where derive wrote it before, and live again once a
  read holds the node.
- **Records the gap only moves (a message's `order`, the session's `fingerprint`) are revised, and
  revised back once a later read holds the node and derives it** (sessions v1.x proposal (#6), §2,
  `inconsistent`). Leaving a piece out moves the `order` of the line messages after it and the
  session's fingerprint. `calm-orchard` without `co:a2` or `co:r1`: `co:si` (its parent is now the
  copy's), `co:cont`, `co:u2`, `co:a3` and the session record. `dusty-lantern` without `dl:sa2` or
  `dl:sr1`: `dl:res`, `dl:a2` and the session record. `keen-ridge` without `kr:a2` or `kr:u2`:
  `kr:si` (its parent is now the copy's), `kr:cont`, `kr:u3`, `kr:a3` and the session record.
- **Records derive wrote earlier among what it leaves out are held, and so are a compaction record
  and its summary that point into the missing nodes** (sessions v1.x proposal (#6), §2, `inconsistent`).
  While a node the main line names dangles, a key written before (live or held in the state derive
  is given) and left out now goes to `held`, not away: its last written version stands (sessions
  §2, `held`). The next read that holds the node releases it, live again, or drops it. Before, a
  read with a dangling head that followed a whole read left those keys out of both `live` and
  `held`, so a consumer tombstoned them and the next whole read recreated them: `dusty-lantern` at
  the head's last move, its node removed, tombstoned three messages (the task and the streaming
  twins' siblings) and two usage records.
- **Goldens:** none change. No fixture case has a dangling node. One case is new,
  `switch-compaction` (session `keen-ridge`: a turn abandoned in the original root, a mode switch,
  then a compaction), with its own golden of 18 records, the abandoned turn's two messages among
  them with `on_active_branch: false`. The tests:
  - build the `features` store up to the head's last move and remove the head's node, or an
    earlier node of its chain, deriving from an empty state and from the whole read's state;
  - add a dangling head to `amber-harbor`, the mode-switch shape (the line runs through prefix
    copies), with and without a turn abandoned in its old root: the records are the same as
    without the head;
  - remove the compacted history's named node (`co:a2`) or an earlier one (`co:r1`) from
    `calm-orchard`, and the named sub-agent chain's node (`dl:sa2`) or an earlier one (`dl:sr1`)
    from `dusty-lantern`. Each read succeeds, the piece is left out (and held from the whole read's
    state), and the read that holds the node again folds to the whole read's state, from either
    state;
  - remove the compacted history's named node (`kr:a2`) or an earlier one (`kr:u2`) from
    `switch-compaction`. Derived from the whole read's state, the turn abandoned in the mode
    switch's old root is left out with the history: its two messages and its usage record go to
    `held` at their last written version, with the compaction record and its summary, and no key is
    tombstoned. The read that holds the node again makes them live, unchanged, and revises back what
    the gap moved. A dangling sub-agent head there leaves the old root alone.
- No key changes. Consumers re-derive devin sessions: `derive`'s records change only for units
  `read` used to refuse.
- `subagent_heads` is still INFERRED from the table's columns: the lab never saw a row in it.

### Docs: what a consumer does about a retryable read error

- `docs/adapter-interface.md`, *Errors*, gains *Retryable errors: what a consumer does*: a
  retryable read error (`busy`, `inconsistent`, `damaged`) that outlasts the consumer's retry
  budget while `updated_hint` is unchanged is reported, and the consumer stops retrying that
  session until `updated_hint` moves, apart from its scheduled re-read, keeping the last derived
  state. The scheduled re-read is sessions §2's periodic read of every session: one read on the
  schedule, no backoff retries. sessions v1.x proposal (#6), §2 (`read` errors). Consumer behaviour only:
  no adapter changes.

### devin, opencode, vscode, agy, cursor, cursor-agent and goose: `is_error` is the stored flag

sessions-model v1.x proposal (#6), §2.3 (`tool_result.is_error`), one of the clarifications §8 lists for
the v1.x proposal: `is_error` is the harness store's own flag. It is null where the harness store has no flag,
and where its flag is unreliable: a flag that says success beside a shell's non-zero `exit_code`
is unreliable for that result, so that result's `is_error` is null, and the harness store's other
results keep the flag. An adapter never derives `is_error` from `exit_code` or from the output's
text. copilot-cli and codex follow it already (above). Each adapter below bumps its `adapter_ver`
(§8: an adapter that derived otherwise bumps it, so the consumer re-derives); no key changes, and
a reader that wants a shell's failure reads `exit_code`.

- **devin (adapter_ver 0.2.1 → 0.2.2).** A failure flag gives true, as before:
  `chisel/tool_result_meta.success: false`, a `failed` final status in `tool_call_state`, a
  rejection or a cancel (a rejection or a cancel gives null now: see *`is_error` is null where a
  call did not complete*, below). A success flag (`success: true`, a `completed` final status) gives
  false, except beside a non-zero `exit_code` (the node's `chisel/terminal_output.exit.exit_code`),
  where it gives null. A result with no flag gives null. Before, every result without a failure flag
  was false, `success: true` beside exit 1 included.
  - Goldens: one tool result, `features` `amber-harbor` `ah:r1` (`success: true`, a `completed`
    status, exit 1): `parts[0].is_error` `false` → `null`, with its message's `cmp_sha` and that
    entry of the session's `fingerprint.cmp_shas`. Nothing else moves; `switch-compaction` has no
    tool result.
- **opencode (adapter_ver 0.2.0 → 0.2.1).** The flag is a tool part's state status, v1 and v2
  alike: `error` gives true, and `completed` gives false, except beside a non-zero `exit_code`
  (v1 `metadata.exit`, v2 `structured.exit`), where it gives null. A part still pending or running
  gives null, as before.
  - Goldens: one tool result, `features` session `ses_15e9c27c…`, message `msg_15e9c2f9…`, call
    `call_bc3a64f28f` (`completed`, exit 1): `parts[3].is_error` `false` → `null`, with the
    message's `cmp_sha` and that entry of the session's `fingerprint.cmp_shas`. Nothing else moves.
- **vscode (adapter_ver 0.2.0 → 0.2.1).** A denial (null now: see below) or a `resultError` gives
  true, and a done invocation (`isComplete`, or a result stored) gives false, except beside a
  terminal's non-zero `exit_code` (`terminalCommandState.exitCode`), where it gives null. An
  invocation still running gives null, as before.
  - Goldens: two tool results, `features` `call_B` (done, exit 1) in session `0a0a0a0a…` (message
    `response_…05`) and in its fork `0d0d0d0d…` (message `…080`): `parts[6].is_error` `false` →
    `null`, with each message's `cmp_sha` and that entry of each session's `fingerprint.cmp_shas`.
    The fork's leading `cmp_shas` still match its origin's. Nothing else moves; `lab` is unchanged.
- **agy (adapter_ver 0.2.0 → 0.2.1).** The flag is a GENERIC step's status in the conversation
  database: ERROR gives true, and DONE gives false, except beside a run_command's non-zero
  `exit_code` (the RunCommand payload's), where it gives null. A step still running gives null, and
  a CANCELED or INTERRUPTED step false, as before (null now: see below). The transcript keeps no
  exit code, so its results are unchanged.
  - Goldens: one tool result, `features` step G1 (message `c0497521…`, `call_1164701`, DONE,
    exit 1): `parts[0].is_error` `false` → `null`, with the message's `cmp_sha` and that entry of
    the session's `fingerprint.cmp_shas`. Nothing else moves.
- **cursor (Cursor IDE; adapter_ver 0.2.1 → 0.2.2).** The flag is the tool bubble's status: an
  `error` status, `toolFormerData.status` or `additionalData.status`, gives true, and `completed`
  gives false, except beside a non-zero `exit_code` (`result.exitCode`), where it gives null. The
  exit code no longer decides: before, a non-zero `exitCode` gave true whatever the status said. A
  denial, a cancel and an abort give false, as before (null now: see below).
  - Goldens: none change. Both fixture results with exit 1 (`features` `CALL(2, 1)`, `lab`'s
    pytest shell) carry `additionalData.status: error`, so they stay true from the flag. The test
    edits a copy for the other cases.
- **cursor-agent (adapter_ver 0.2.1 → 0.2.2).** The flag is a step result's oneof case
  (ShellSuccess, ShellFailure and the other kinds' success or failure cases) or the model context's
  `highLevelToolCallResult.isError`, which wins where both are stored. A success, either one,
  beside a non-zero `exit_code` (ShellSuccess #3) gives null. A shell-mode turn (`!cmd`) gives
  null: the ShellOutput fields read (#1 stdout, #2 stderr, #3 exit_code) hold no flag, and its
  `is_error` was derived from the exit code. A model-context result with no `isError` and no step
  result gives null, where it gave false; no fixture holds one.
  - Goldens: one tool result, `features` session `c4a1e0de…`, the shell-mode turn
    `8b76b964…202+1` (exit 3): `parts[1].is_error` `true` → `null`, with the message's `cmp_sha`
    and that entry of the session's `fingerprint.cmp_shas`. Nothing else moves; `orphan`, `rewind`
    and `subagent` are unchanged.
- **goose (adapter_ver 0.2.1, its one move in this release: see below).** The flag is a tool
  result's `isError`. `isError: false`, or none (read as false), beside a non-zero
  `structuredContent.exit_code` gave false. It gives null. `isError: true` stays true, beside any
  exit code. A result without `isError` has MCP's default, false, as sessions-model v1.x proposal (#6),
  §2.3 now states (a flag the harness store leaves out where its protocol defines a default has
  that default): false beside exit 0 or no exit code, null beside a non-zero one. The code and the
  test cite the clause; no behaviour changes for it.
  - Goldens: none change. Both fixture results with exit 1 (`call-1` in `20261021_1` and
    `20261021_8`) carry `isError: true`. The test edits a copy for the other cases.

### `is_error` is null where a call did not complete

sessions-model v1.x proposal (#6), §2.3 (`tool_result.is_error`): `is_error` describes a call that
completed. Where a `tool_result`'s `status` is `cancelled` or `denied`, `is_error` is null, and
the status carries the fact. The adapters below gave false or true there. No key changes; a record
changes only in that `is_error`, its message's `cmp_sha` and that entry of the session's
`fingerprint.cmp_shas`. An adapter whose `adapter_ver` already moved in this release (agy, cursor,
cursor-agent, devin, opencode, vscode, above) keeps it; any other moves once.

- **agy (adapter_ver 0.2.1, unchanged).** A CANCELED or INTERRUPTED step (`cancelled`) gave false,
  and an ERROR whose error is a denial (`denied`) gave true, in the conversation database; a denied
  transcript line gave true too. All give null. An ERROR that is no denial stays true, a DONE false.
  - Goldens: two tool results, `features` session `63e1ede9…`: step G9 (message `5fccbbf0…`,
    `call_213908`, CANCELED) `false` → `null`, and step G2 (message `d24bade1…`, `call_322814`,
    denied) `true` → `null`, with each message's `cmp_sha` and its entry of the session's
    `fingerprint.cmp_shas`. Nothing else moves.
  - **The transcript reads a CANCELED or INTERRUPTED line as the database reads the step.** A
    session with no conversation database read such a GENERIC line as `completed` with `false`
    (`true` beside an `error`), in a `complete` (`error`) message. It is `cancelled` with
    `is_error` null now, whatever error the line carries, in a `cancelled` or `interrupted`
    message, as `doneStatus` gives a step; any other line with either status takes the same
    message status. The status is the line's own field: `cancelled` and `denied` come from a
    structured marker the harness store writes, never from the output's text
    (sessions-model v1.x proposal (#6), §2.3). No capture shows such a line.
  - Goldens: none change; no captured transcript holds either status. One synthetic case is new,
    `transcript-cancel` (a session with no database, `0b5e7c1a…`: a CANCELED, an INTERRUPTED and a
    DONE result), with its own golden of 15 records. Its two cancelled results (messages `@552`
    and `@1192`) are `cancelled`, `null`; the DONE one (`@1818`) is `completed`, `false`. The
    matrix's M.is-error cell for agy names the new test.
- **copilot-cli (adapter_ver 0.2.1 → 0.2.2).** A denied call (`error.code: denied`, `denied`) gave
  true from its `success: false`. It gives null, whatever `success` says. A call that completed
  keeps `success` as its flag.
  - Goldens: three tool results, the denied call in `features` (`chatcmpl-tool-feat-pip`, message
    `a0000000…056`) in session `a0a0a0a0…` and in its fork `c2c2c2c2…`, and in `vscode-host`
    (`call_…00018`, message `b579dd63…`): `parts[0].is_error` `true` → `null`, with each message's
    `cmp_sha` and its entry of the session's `fingerprint.cmp_shas`. The fork's `cmp_shas` still
    match its origin's. Nothing else moves.
- **cursor (adapter_ver 0.2.2, unchanged).** A denial (`rejected`, or a result that says
  `rejected`: `denied`) and a cancel or an abort (`cancelled`) gave false, or true beside an `error`
  status. They give null. A call that completed keeps its status as the flag.
  - Goldens: three tool results, `parts[n].is_error` `false` → `null`, with each message's
    `cmp_sha` and its entry of the session's `fingerprint.cmp_shas`: in `features`, the cancelled
    loop (session `c0c0a001…`, message `b0b0b003…:assistant`) and the rejected tool (session
    `c0c0a007…`, message `b0b0b071…:assistant`); in `lab`, the cancelled loop (message
    `5a5a0029…:assistant`). Nothing else moves.
- **cursor-agent (adapter_ver 0.2.2, unchanged).** A rejected or permission-denied step (`denied`),
  a ShellFailure marked cancelled (#11) and a shell timeout (`cancelled`) gave true. They give
  null, and so does a model context's `isError` beside such a step. A call that completed keeps the
  flag.
  - Goldens: one tool result, `features` session `c4a1e0de…`, the rejected shell (message
    `c3a28bce…104:assistant`): `parts[1].is_error` `true` → `null`, with the message's `cmp_sha`
    and that entry of the session's `fingerprint.cmp_shas`. Nothing else moves.
- **devin (adapter_ver 0.2.2, unchanged).** A rejection (`denied`) and a cancel (`cancelled`), from
  the tool node's failure reason or from `tool_call_state`, gave true. They give null, whatever
  `success` says beside them. `success: false` and a `failed` final status stay true on a call that
  completed.
  - Goldens: two tool results, `features` `amber-harbor`: `ah:x3` (`ah:rej`, denied) and `ah:x4`
    (`ah:slow`, cancelled), `parts[0].is_error` `true` → `null`, with each message's `cmp_sha` and
    its entry of the session's `fingerprint.cmp_shas`. Nothing else moves.
- **gemini-cli (adapter_ver 0.2.2 → 0.2.3).** A cancelled call (`status: cancelled`) gave false, or
  true where its response held an `error`. It gives null. A call that completed keeps the flag: an
  `error` status or an `error` in its response true, else false.
  - Goldens: one tool result, `features` session `7f3e9a10…`, message `00000000…004`, the cancelled
    edit (`write_file__…_1`): `parts[3].is_error` `false` → `null`, with the message's `cmp_sha` and
    that entry of the session's `fingerprint.cmp_shas`. Nothing else moves.
- **goose (adapter_ver 0.2.0 → 0.2.1).** A declined call (`denied`), Ctrl-C during a shell call
  and a cancelled approval (`cancelled`) copied goose's `isError: true`. They give null. A call
  that completed keeps `isError`.
  - Goldens: three tool results, `features` session `20261021_2`: `msg_rr` (`call-rm`, denied),
    `msg_rs` (`call-sleep`, Ctrl-C) and `msg_ri` (`call-rm2`, a cancelled approval),
    `parts[0].is_error` `true` → `null`, with each message's `cmp_sha` and its entry of the
    session's `fingerprint.cmp_shas`. Nothing else moves; `lab` and `conformance-goose-sentinel`
    are unchanged.
- **opencode (adapter_ver 0.2.1, unchanged).** A refused permission (an `error` status whose error
  says so: `denied`) gave true. It gives null; a call cut off while pending or running (`cancelled`)
  gave null already. A call that completed keeps its state status as the flag.
  - Goldens: one tool result, `features` session `ses_15e9c27c…`, message `msg_15e9c338…`, call
    `chatcmpl-tool-…00050` (denied): `parts[11].is_error` `true` → `null`, with the message's
    `cmp_sha` and that entry of the session's `fingerprint.cmp_shas`. Nothing else moves.
- **vscode (adapter_ver 0.2.1, unchanged).** A denial (`isConfirmed` 0, `denied`) gave true, and a
  skip (`isConfirmed` 5, `cancelled`; UNVERIFIED reading) gave false or true. Both give null; a call
  cut off in a reply that ended (`cancelled`) gave null already. A call that completed keeps the
  flag: a `resultError` true, done false.
  - Goldens: one tool result, `features` session `0a0a0a0a…`, message `response_…048`, `call_D`
    (denied): `parts[2].is_error` `true` → `null`, with the message's `cmp_sha` and that entry of the
    session's `fingerprint.cmp_shas`. Nothing else moves; `lab` is unchanged.
  - A skip's `status` is `cancelled`, never another value, a `resultError` beside it included (the
    test now shows that case too). The reading of 5 as a skip stays UNVERIFIED: no fixture holds
    one, and `docs/live-check.md` lists it.
- **zed (adapter_ver 0.2.1 → 0.2.2).** Zed's canned results, `Tool canceled by user` (`cancelled`)
  and `Permission to run tool denied by user` (`denied`), kept Zed's stored `is_error: true`. They
  give null. A call that completed keeps a stored true, and a stored false stays null (unreliable,
  as before).
  - Goldens: one message, `features` session `5a1e0000…c1`, message `5a1e0000…a3+1`, the cancelled
    and the denied call (`toolu_toy_…04`, `toolu_toy_…05`): `parts[1].is_error` and
    `parts[3].is_error` `true` → `null`, with the message's `cmp_sha` and that entry of the
    session's `fingerprint.cmp_shas`. Nothing else moves; `lab`, `restore`, `restore-lab` and
    `sentinel` are unchanged.
- **claude-code and codex: no change.** `cancelled` and `denied` come from a structured marker the
  harness store writes, never from the output's text (sessions-model v1.x proposal (#6), §2.3). No fixture
  holds a Claude Code rejection or interrupt, or a Codex `aborted` call, and no structured marker
  for either is known, so their results stay `completed` with the store's flag. `docs/live-check.md`
  lists both as not established: what would establish each status, and the mapping that would
  apply (`denied` for a rejection, `cancelled` for an interrupt or an abort, `is_error` null).
- **The conformance matrix gains `M.is-error`**, the sessions-model v1.x proposal's adapter-side `is_error`
  item (sessions-model v1.x proposal (#6), §2.3): every `tool_result` copies the harness store's own flag,
  and is null where the store has none, where the flag says success beside a shell's non-zero
  `exit_code`, and where `status` is `cancelled` or `denied`; a fixture result with a non-zero
  `exit_code` and no failure flag never has `is_error` true. Every harness's cell is `generic`
  plus its own tests. The generic check (`conformance/generic.js`, run over every fixture case)
  finds a non-null `is_error` on a cancelled or denied result, a false beside a non-zero
  `exit_code`, and a true beside one that `FAILURE_FLAGS` does not list with the store's failure
  flag (five results: cursor's two `additionalData.status: error`, cursor-agent's ShellFailure,
  goose's two `isError: true`). The named tests show the copy and the nulls per harness.
  claude-code gains one: its results copy the block's `is_error`, null where the block has none.
  Over the goldens as they stood before the fixes above, the check finds 19 results in ten
  harnesses; after them, none.

### `cancelled` and `denied`: a harness's own fixed string, matched exactly

sessions-model v1.x proposal (#6), §2.3 (`tool_result`): `cancelled` and `denied` come from a
structured marker the harness store writes, or from a fixed string the harness itself writes for
that case (never tool or model output), matched exactly and listed for that harness in the
sessions-model annex §5, v1.x proposal (#6); never from a pattern searched in free text. Where a
status goes, `is_error` copies the store's flag. Each adapter below matched text otherwise; each
bumps its `adapter_ver` once. No key changes. The strings, each read from the harness's source at
the version the fixtures came from:

| Harness | Text, exactly | Status | Source |
|---|---|---|---|
| zed | `Tool canceled by user` | `cancelled` | Zed v1.24.3, `crates/agent/src/thread.rs:73` |
| zed | `Permission to run tool denied by user` | `denied` | Zed v1.24.3, `crates/agent/src/thread.rs:6748`, `:6230`, `:6235` |
| zed | `Permission denied: user sent a follow-up message instead of approving the tool call.` | `denied` | Zed v1.24.3, `crates/agent/src/thread.rs:74-75` |
| goose | `The user has declined to run this tool. DO NOT attempt to call this tool again. If there are no alternative methods to proceed, clearly explain the situation and STOP.` | `denied` | Goose v1.55.0, `crates/goose/src/agents/tool_execution.rs:151-153` |
| goose | `Tool call was interrupted before completing` (no final period) | `cancelled` | Goose v1.55.0, `crates/goose-agent/src/machine.rs:83-86` |
| opencode | `The user rejected permission to use this specific tool call.` | `denied` | OpenCode v1.19.3, `packages/core/src/v1/permission.ts:7-11` |

- **zed (adapter_ver 0.2.2 → 0.2.3).** The three texts were compared with the result's content
  joined into one string, whatever `is_error` said. They now count only in the shape Zed writes
  them, which is also what Zed's own `is_canceled_tool_result` asks (`thread.rs:1734-1741`):
  `is_error: true` and a content of exactly that one Text item, the whole text equal. A result that
  says success, several items that join to the text, or a text that merely contains it is
  `completed`, with the stored flag (a stored false stays null, as before). A built-in tool's own
  cancel error (`Edit cancelled by user` and the like) is not one of the three and stays
  `completed`. A content stored as one Text value rather than a list counts as that one item,
  still whole, exact and with `is_error: true`: builds before Zed commit bf3fc2336d ("agent: Allow
  tools to output multiple content parts") stored every tool result's content so, the canned
  cancel included (`thread.rs:2746` at its parent), and Zed v1.24.3 reads that legacy value as a
  list of one (`crates/language_model_core/src/request.rs:104-146`).
  - Goldens: none change; the fixture's two canned results are in Zed's shape. The tests edit a
    copy for the near misses and for the single-value shape, and the matrix's M.is-error cell for
    zed names both.
- **goose (adapter_ver 0.2.1 → 0.2.2).** A result was `cancelled` where its text started with
  `Tool call was interrupted before completing`, `denied` where it started with `The user has
  declined to run this tool`, and `cancelled` where it was `(no output)` with `isError` and no exit
  code (read as Ctrl-C during a shell call). The two texts now count only whole and exact, in the
  shape goose writes them (an MCP error result, `isError: true`, whose content is that one text
  block). `(no output)` is the developer shell's output for an empty result (Goose v1.55.0,
  `crates/goose/src/agents/platform_extensions/developer/shell.rs:736`), so that heuristic is
  gone: such a call is `completed`, with its `isError`. The stored permission
  (`toolConfirmationResponse`) still decides first where it says `cancel`, `deny_once` or
  `always_deny`; goose stores a Cancel at the approval prompt as `deny_once`, and the interrupted
  text then says `cancelled`, as before.
  - Fixture: the `features` declined and interrupted results now carry goose's own texts. Before,
    the declined one held only its first two sentences and the interrupted one a final period.
  - Goldens: three tool results, `features` session `20261021_2`: `msg_rs` (`call-sleep`, the
    Ctrl-C): `status` `cancelled` → `completed` and `is_error` `null` → `true`; `msg_rr`
    (`call-rm`, still `denied`) and `msg_ri` (`call-rm2`, still `cancelled`): `output` and
    `output_len` (79 → 167, 44 → 43) follow the fixture. Each message's `cmp_sha` and its entry of
    the session's `fingerprint.cmp_shas` change with them. Nothing else moves; `lab` and
    `conformance-goose-sentinel` are unchanged.
- **opencode (adapter_ver 0.2.1 → 0.2.2).** A tool part in `error` was `denied` where its error
  text contained `rejected permission`, in any case. It is `denied` now only where the stored
  `state.error` is OpenCode's own text, whole: `PermissionRejectedError`'s message, which OpenCode
  v1.19.3 stores as the error string (`packages/opencode/src/session/processor.ts:186-194`). An
  error that contains the words, the text after a prefix, and a rejection with feedback
  (`PermissionCorrectedError`, whose text embeds the user's words: no fixed string) are
  `completed`, with the state status as the flag (true). v2 parts (`session_message`) never held
  the text: a declined permission there halts the loop instead of becoming a tool result.
  - Goldens: none change for this; the fixture's refused permission is OpenCode's text, whole.
    The earlier test edited a copy with an `Error: ` prefix before the text and expected
    `denied`; it now writes the text as OpenCode stores it, and a new test shows the near misses.
    The matrix's M.is-error cell for opencode names it.
- **opencode: a call cut off by an interrupt is `cancelled`, by its structured marker (the same
  adapter_ver, 0.2.2).** After an abort or a retry, OpenCode's cleanup writes every call still
  open as an `error` part with `metadata.interrupted: true`, beside the text `Tool execution
  aborted` (OpenCode v1.19.3, `packages/opencode/src/session/processor.ts:591-607`). Such a call
  was `completed` with `is_error` true. It is `cancelled` now, with `is_error` null, where the
  part is `error` and `metadata.interrupted` is true, which is OpenCode's own test
  (`packages/opencode/src/session/prompt.ts:96-100`). The marker decides, never the text: the
  same text without the marker, or with the marker false or a string, stays `completed` with the
  flag, and the marker beside another text is `cancelled`. v2 parts are unchanged.
  - Fixture: `features` gains a session, `Stopped fetch`: a turn stopped while a webfetch call
    was open, the call written as the cleanup writes it and the message's error a
    MessageAbortedError. Synthetic, from OpenCode's source; no capture holds an interrupt.
  - Goldens: `features` gains that session's three records, a user message, an assistant message
    and the session. The call is `cancelled`, `is_error` null, `output` `Tool execution
    aborted` (22 bytes), `truncated` and `exit_code` null; the assistant message is
    `interrupted` and carries the MessageAbortedError as an `error` part. Nothing else moves; the
    list test counts seven sessions in `features`.
  - Test: a call cut off by an interrupt is cancelled by its structured marker, with the near
    misses above; the matrix's M.is-error cell for opencode names it.
- **agy (adapter_ver 0.2.1 → 0.2.2).** An ERROR step whose error matched `/denied/i` was `denied`
  with `is_error` null, in the conversation database and in the transcript. agy has no structured
  denial marker the adapter reads (the step's `permissions` blob is not decoded) and no fixed denial
  string: its denial error embeds the command, and agy's source is not public. So nothing marks a
  denial: a denied command is an ERROR step or line, `completed`, with the store's flag, true. A
  CANCELED or INTERRUPTED step or line is still `cancelled`, from its status.
  - Goldens: one tool result, `features` session `63e1ede9…`, step G2 (message `d24bade1…`,
    `call_322814`, the denied command): `status` `denied` → `completed` and `is_error` `null` →
    `true`, with the message's `cmp_sha` and that entry of the session's `fingerprint.cmp_shas`.
    The message's own `status` stays `error`. Nothing else moves.
- **No other adapter decides `cancelled` or `denied` from text.** claude-code and codex map
  neither; copilot-cli (`error.code`), cursor (the bubble's status, `rejected`), cursor-agent (the
  result's oneof case, `outcome`), devin (`cognition.ai/rejected` and `canceled`, the failure
  reason), gemini-cli (`status`) and vscode (`isConfirmed`, `modelState`) read a structured marker.
