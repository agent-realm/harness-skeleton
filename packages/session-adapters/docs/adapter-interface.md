# The adapter interface

Every harness module under `src/harnesses/<harness-id>/` exports the same five names, and an
adapter with file sources a sixth, `unitsFromBytes`. The shapes are the JSON forms of sessions v1
§2. This page records the choices the contract leaves to an implementation.

## Exports

| Name | Shape |
|---|---|
| `HARNESS` | the harness id, as in sessions-model §1 rule 3 |
| `describe()` | `{adapter, adapter_ver, model_version, harness, state_ver, versions, sources, store_shape, ts_source, redaction, facets}`. `store_shape` (sessions §2) says what `harness_path` names: `{kind: 'folder'}`, or `{kind: 'file', default, names}` for a harness whose every harness store is a database file (OpenCode). It is never named `store`, which is `{host, harness, harness_path}` |
| `list(store)` | `[{session_id, incarnation, updated_hint, live, sources: [{source_key, role, mode, position_kind}]}]`, sorted by `session_id` |
| `read(store, session, source_key, from, known)` | `{continuity, units, gone, position, held_back}` |
| `derive(session, input, state)` | `{changed, live, held, state, checkpoint, adapter_ver, model_version, state_ver}` |
| `unitsFromBytes(source_key, bytes, {start})` | `{units, held_back}`. Only the adapters with file sources: claude-code, codex, copilot-cli, gemini-cli, vscode, agy, cursor-agent and opencode. See [below](#unitsfrombytes) |

- `store` is `{host, harness, harness_path}`.
- `session` is the full session key: `{host, harness, harness_path, session_id, incarnation}`.

The package entry (`src/index.js`) exports `ADAPTERS`, `adapterFor(harness)`, `unitsFromBytes(harness,
source_key, bytes, {start})`, `host`, `hostLabel`, `harnessPath`, `SessionsError` and `CODES`. It is
an ES module with no top-level await, so CommonJS can `require()` it on Node 22.12 and later
(`test/require.test.js`).

Three more entry points: `./host` (the host derivation and its parts), `./harness-path`
(`harnessPath`), and
`./validate`, whose `validateSession(records, {harness, sessionId})` checks one session's records
against the record shapes of sessions-model §2 and returns `[{at, problem}]`. A finding with
`warning: true` names a registry value it does not know (`harness`, `ts_source`: sessions-model
§8's registries grow in v1.x), which a v1 reader accepts; the records are valid when every finding
is a warning.
The conformance suite runs it over every golden, and a writer can run it before it writes. What
proves each conformance item for each harness is in [the conformance matrix](conformance-matrix.md).

## Units

A unit is `{source_key, unit_key, enc, bytes, sha256, redacted, body}`, as in sessions-model §3.
- `body` is the text for `utf8`, and base64 for `b64`.
- `sha256` and `bytes` describe the bytes as emitted, after redaction.
- A stream unit's `unit_key` is its start offset in the generation, as a decimal string.
- `pb-json` (cursor-agent) is a protobuf blob that carries a value `read` must redact, as the JCS
  text of `{orig_sha256, fields}` (sessions-model §3, §4.4). `fields` lists the entries in wire
  order, each `{n, w}` (field number, wire type) plus one of:
  - `v`: a varint, as a number, or as a decimal string beyond 2^53;
  - `b64`: the stored bytes of a length-delimited or fixed field;
  - `fields`: a length-delimited field decoded, only where the redaction goes inside it;
  - `redacted`: the marker `<redacted len=N>`, N being the value's byte length.

  The blob is never re-encoded. `orig_sha256` keeps its content address, which is its blob id. A
  blob with nothing to redact stays a `b64` unit.

## Positions

Positions are opaque to a consumer, and carried verbatim.

| Source | Position |
|---|---|
| stream | `{dev, inode, offset, line1_sha, anchor_sha}`. `dev` and `inode` are decimal strings. `anchor_sha` covers the 64 KiB before `offset`, so a same-size rewrite of the tail shows as a reset |
| snapshot | `{sha256}` of the emitted unit |

## `unitsFromBytes`

`unitsFromBytes(harness, source_key, bytes, { start = 0 })` returns the units that
`read(store, session, source_key, null, null)` returns for a file holding `bytes`, as
`{units, held_back}`. It is for a consumer that archived a source's raw bytes and must re-derive
after the harness deleted the file (Claude Code deletes transcripts after about 30 days).

- **The same units, unit for unit.** `read` and `unitsFromBytes` share one code path in
  `src/sources.js`: `splitLines` for a stream, `snapshotUnit` for a snapshot. So the line split,
  CRLF handling, skipped blank lines, `unit_key`s, `enc`, `sha256` and each adapter's redaction
  are the same. Each adapter's post-processing is shared with its `read` too:
  - VS Code holds a torn JSON document back;
  - Gemini CLI holds back a legacy `.json` session that does not parse;
  - cursor-agent reads `meta.json` as `{cwd}` only.
- **`held_back`** is the partial last line of a stream, or a torn snapshot, as `read` gives it.
- **`start`** is the generation offset of a stream's first byte, and every `unit_key` adds it. The
  result equals what `read` returns appended from a position at that offset. A snapshot's unit is
  the whole file, keyed by its `source_key`, so its `start` must be 0.
- **No position, no continuity, no file system.** The adapter decides stream or snapshot from the
  shape of `source_key`, as its `list` names it. `test/units-from-bytes.test.js` holds this to
  `read` over every file source of every fixture.

Errors (`SessionsError`):
- `harness_unknown` for an unknown harness, as `adapterFor` throws;
- `bad_request` for a source with no file bytes. That is every source of goose, cursor, zed and
  devin, and the database sources (`…#table:…`, `table:…`) of agy, cursor-agent and opencode;
- `bad_request` for `bytes` that are not a Buffer or a Uint8Array, a `start` that is not a
  non-negative integer, and a non-zero `start` for a snapshot;
- `source_unknown` for a key that names no file source of the harness.

Where it cannot match `read` exactly, and why:
- **No read cap.** One `read` returns at most `MAX_READ_BYTES` (64 MiB) and says `more: true`.
  `unitsFromBytes` returns every unit at once, which equals the units of `read` and its
  continuation reads together.
- **No session to check.** `read` checks the source against a live session. copilot-cli
  compares line 1's `session.start` id with the incarnation. Gemini CLI names only the winning
  file of a session id. OpenCode reads a spill only when a part of that session names it.
  `unitsFromBytes` has only bytes, so it checks the key's shape only. A consumer that needs the
  incarnation finds it in unit `0`.

## Versions

`describe()` and every `derive` output carry three versions. A consumer that persists records,
units or state acts on each:

- **`model_version`** (`sessions-model/1`) is the record shape.
- **`adapter_ver`** is per adapter. It is bumped on any change in `derive`'s records for the same
  units, and on any change in `read`'s split or redaction, which changes the units and so also
  what `unitsFromBytes` returns. On a bump the consumer re-derives that harness's sessions from
  its archived units or bytes.
- **`state_ver`** is the shape of `derive`'s state, per adapter. On a bump the consumer drops the
  saved state and refolds every unit with `complete: true`. A `derive` handed a state of another
  `state_ver` ignores it and starts from empty. Given only the new units, it would then lose the
  earlier ones, so the refold is the consumer's job.
- **A key change** (a record's key, sessions-model §1 rule 8) carries a migration note in
  [`CHANGELOG.md`](../CHANGELOG.md), naming the harness, the `adapter_ver` and how old keys map
  to new ones.

## `derive` input

`input` is a list with one entry per source that has something new:

```json
{ "source_key": "…", "generation": 1, "complete": true, "units": [ … ], "gone": [ … ] }
```

- **`complete: true`:** `units` is every unit of that generation. A consumer sends this on a
  first derive, and after a reset of any source; in both cases `state` is null (sessions §2).
- **`complete: false`:** `units` is only what `read` returned since the last derive, and `gone` the
  vanished keys of a delta source.

## `derive` output

- **`changed`:** every record whose `content_sha` moved since the state's last derive, sealed by
  `seal()`. The fields are `type`, the session key, the record's own key fields, `content_sha`,
  and `cmp_sha` on messages.
- **`live`:** `{session, message, usage, link, lifecycle}`, each the complete sorted list of live
  keys. The session record's key is `''`.
- **`held`:** the same shape. Keys withheld as incomplete, which a consumer neither writes nor
  tombstones (sessions §2).
- **`checkpoint`:** true when `state` is safe to persist.

## Record shapes this package fixes

sessions-model §2 lists each record's fields. Where it leaves a JSON shape open, this package uses:
- **Link** (sessions-model §2.5): `{type: 'link', kind, stated_on: 'child' | 'origin', child, origin,
  at, inherits, child_stored, evidence}`.
  - `child` and `origin` are references `{harness, session_id}`, plus `incarnation` when the stating
    session knows it.
  - `inherits` is `{through_message_id, ids_preserved, marked, usage_copied}` or null.
  - The key (`live.link`) is the JCS of `[kind, the other side's reference, at]`.
- **Lifecycle** (sessions-model §2.6): `target` is `{message_id}`, `{range: {from_id, through_id}}`
  or `{session: true}`. A retraction's last kept message goes in `at`.
- **`describe().redaction.paths`:** `[{source, path, opened}]`.
  - `source` is a `source_key` pattern.
  - `path` is a field path in that source's units.
  - `opened: false` marks a path in a file the adapter never opens (Gemini CLI's checkpoint
    `authType`).

## Errors

Every operation throws `SessionsError` with a `code`:
- `session_unknown`, `incarnation_gone` and `source_unknown` (sessions §2);
- `busy`, `inconsistent` and `damaged`, which are retryable (sessions §2);
- `harness_unknown`, `bad_request`, `folder_missing`, `host_unreadable` and `platform_unsupported`.

### Retryable errors: what a consumer does

sessions §2 has the consumer retry `busy`, `inconsistent` and `damaged` with backoff, and never
treat one as an empty or vanished source; a `damaged` that persists is reported, and the session
keeps its last derived state. For all three, the expected consumer behaviour is (a contract
decision, to appear in sessions v1.x):

A retryable read error that outlasts the consumer's retry budget while `updated_hint` is
unchanged is reported; the consumer stops retrying that session until `updated_hint` moves, and
keeps the last derived state.

`updated_hint` comes from `list`, which a failed `read` does not touch, so a moved hint means the
harness has written the session since. The reference consumer, `conformance/engine.js`, keeps no
retry budget: it lets the error out of `pass()`.

## Database sources

- A table slice's `source_key` is `<db path>#table:<name>` (sessions §1). Every OpenCode harness
  store is a file harness store (sessions-model §1), so its table sources are plain `table:<name>`,
  as the harness's one database, and its spilled `tool-output/` files, which sit in the data
  folder, have absolute `source_key`s. A fixture case binds such a store with `binding.json`
  (`{"harness_path": "opencode.db"}`).
- Goose's first ledger row, which its derive needs, is the side snapshot
  `sessions/sessions.db#table:usage_ledger@first`: a slice that every session of the harness store
  reads alike (sessions §1, `@<slice>`).
- Delta units are `row-json`. A multi-row snapshot is one `rows-json` unit (`src/sqlite.js`).
  - Where the primary key is minted again on every save (Devin's `row_id`), the unit leaves it out
    and orders the rows by their natural key (sessions-model §3).
  - A compressed column is decoded in `read` (Zed's zstd `data`). The `row-json` unit carries the
    decoded value plus `orig_sha256` of the stored blob (sessions-model §3).

## Fields beyond the contract

Every field this package emits is in sessions-model v1 and sessions v1, including `setup` on the
session record (§2.1), `tool_prompt` on usage (§2.4) and the qualifier of a positional id where a
session has several main sources (§1 rule 10, the Codex rollout file name). A field this package
emits ahead of the contract is listed in this section until the contract takes it. There is none
today.
