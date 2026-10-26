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
