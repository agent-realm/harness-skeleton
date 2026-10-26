# Changelog

`@agent-realm/session-adapters`. A change that moves a record's key carries a migration note here
(sessions-model §1 rule 8): the harness, the `adapter_ver` and how old keys map to new ones. See
[Versions](docs/adapter-interface.md#versions) for what each version bump asks of a consumer.

## Unreleased

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
- **The conformance matrix**: `conformance/checklist.js` lists the 31 adapter-side items of
  sessions-model v1 (21) and sessions v1 (10); `conformance/matrix.js` says, for every item and
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

sessions-model v1.x (#6), §2.3 (`tool_result.is_error`): an adapter copies the harness store's
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

### cursor-agent: a session's `kind` is null (adapter_ver 0.2.1)

A contract decision, to appear in sessions-model v1.x, refining §2.1 (`kind`, the native session
type): cursor-agent stores no kind field, so `kind` is null for every session. The adapter wrote
`'subagent'` for a chat whose `meta.subagentInfo` names a parent. That fact stays where §2.5 puts
it: the child-side `subagent` link from `meta.subagentInfo`, and the parent-side link from its Task
result, both unchanged.

- **Goldens:** one field, `kind` `"subagent"` → `null` on the child session of the `subagent` case.
  Nothing else moves.
- No key changes; consumers re-derive cursor-agent sessions. A reader that wants to know whether a
  session is a sub-agent reads its `subagent` link with `stated_on: child`.

### zed: per-turn usage where the cumulative total is empty (adapter_ver 0.2.1)

sessions-model v1.x (#6), §2.4 (*No overlap*, whose one Zed record assumes a total): where a
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

### devin: a dangling sub-agent head is no torn read (adapter_ver 0.2.1)

A contract decision, to appear in sessions v1.x, refining §2 (`read` errors, `inconsistent`, whose
Devin example is a `main_chain_id` naming a node not yet written): only the main chain's head makes
a read inconsistent.

- **`read`:** a `subagent_heads` row naming a node the read does not hold, or whose chain the read
  does not hold whole, no longer throws `inconsistent`. The read returns the snapshot. A dangling
  `main_chain_id`, and a compacted history or a finished sub-agent chain that the main line names,
  still do. A loop in a head's chain is still `damaged`.
- **`derive` leaves out what the dangling head would have reached.** Its head cannot be walked,
  so its held nodes cannot be named as a sub-agent's. They would otherwise read as an abandoned
  branch (messages with `on_active_branch: false`). While a head dangles, a node is left out only
  when no valid head reaches its tree and no tree holding a main-line node contains it (sessions
  v1.x (#6), §2). A tree is kept when it holds a node the plan reached from the main line or a
  node of a valid sub-agent head's chain, or the original such a node names through
  `compact/prior_node_ids`. So a sub-agent's task, a root of its own re-rooted under its prompt
  (fixture `features`, session `dusty-lantern`), is left out with its chain. Off-line trees that
  exist without the dangling head keep their normal treatment: a mode switch's old root, a valid
  sub-agent's pre-copy task, and the abandoned branches in either. A later read that holds the node
  derives the chain as usual, as a new rev.
- **What a dangling read leaves out is held, not tombstoned.** While a head dangles, a key written
  before (live or held in the state derive is given) and left out now goes to `held`: its last
  written version stands (sessions §2, `held`). The next read that holds the node releases it, live
  again, or drops it. Before, a read with a dangling head that followed a whole read left those keys
  out of both `live` and `held`, so a consumer tombstoned them and the next whole read recreated
  them: `dusty-lantern` at the head's last move, its node removed, tombstoned three messages (the
  task and the streaming twins' siblings) and two usage records.
- **Goldens:** none change. No fixture case ends with a sub-agent running. One test builds the
  `features` store up to the head's last move and removes the head's node, or an earlier node of
  its chain. Another adds a dangling head to `amber-harbor`, the mode-switch shape (the line runs
  through prefix copies), with and without a turn abandoned in its old root: the records are the
  same as without the head.
- No key changes. Consumers re-derive devin sessions: `derive`'s records change only for units
  `read` used to refuse.
- `subagent_heads` is still INFERRED from the table's columns: the lab never saw a row in it.

### Docs: what a consumer does about a retryable read error

- `docs/adapter-interface.md`, *Errors*, gains *Retryable errors: what a consumer does*: a
  retryable read error (`busy`, `inconsistent`, `damaged`) that outlasts the consumer's retry
  budget while `updated_hint` is unchanged is reported, and the consumer stops retrying that
  session until `updated_hint` moves, keeping the last derived state. It is a contract decision, to
  appear in sessions v1.x, refining sessions §2's read errors. Consumer behaviour only: no adapter
  changes.
