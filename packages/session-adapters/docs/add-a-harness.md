# Add a harness

**Goal:** a new adapter, from its module to a reviewed golden and its row in the conformance
matrix.

The rules are in the package's [`AGENTS.md`](../AGENTS.md): read them first. The short form:
records follow sessions-model v1 and the operations sessions v1; only `node:` builtins; `read` is
read-only toward the harness and redacts; `derive` is pure and deterministic; every fact carries
a source; fixtures are synthetic.

Run the commands from `packages/session-adapters/`. They are shown on `claude-code`, which already
exists, so each one runs as written; for a new harness, put its id in place of `claude-code`.

## 1. Register the harness id

The id comes from the registry of sessions-model §1 rule 3. A harness that is not in it is
registered there first, as a v1.x of the contract. Then add it to `REGISTRIES.harness` in
`src/validate.js`: `validateSession` warns on an id it does not know, and the conformance checks
count that warning as a finding on the package's own fixtures.

## 2. The files

```
src/harnesses/<harness-id>/index.js      HARNESS, describe, list, read, derive (and unitsFromBytes)
src/harnesses/<harness-id>/describe.js   the sources, facets and redaction paths, each with its source
fixtures/<harness-id>/generate.js        writes the fixture cases
fixtures/<harness-id>/<case>/            store/ (files) or store-sql/ (databases as text), expected.json
test/<harness-id>.test.js                the adapter's tests
```

Then register it in these lists:
- `ADAPTERS` in `src/index.js`;
- `HARNESSES` in `conformance/matrix.js`, with a cell under every item (step 6);
- `HARNESSES` in `test/require.test.js`;
- `USAGE_SHAPE` in `conformance/generic.js`: the usage granularities and anchor kinds its records
  may carry; `USAGE_FLAGS` too, if a vendor definition or a stored total settles what its `input`
  and `output` count;
- `FAILURE_FLAGS` in `conformance/generic.js`, only for a fixture result whose `is_error` is true
  beside a non-zero `exit_code`: name the store's failure flag that makes it true. The generic
  `M.is-error` check refuses any other such result;
- `ORPHAN_RESULTS` in `conformance/generic.js`, only for a fixture that holds a result without its
  call on purpose, with the reason.

For an adapter with file sources, also add its expected source kinds to `EXPECT` in
`test/units-from-bytes.test.js`.

## 3. describe, list, read, derive

- **`describe()`** returns the shape in [the adapter interface](adapter-interface.md#exports).
  Every facet is `explicit`, `implicit` or `invisible`; an `explicit` claim needs a fixture record
  that shows it. Put the source of each fact in a comment beside it.
- **`list(store)`** names every session with its sources, sorted by `session_id`, and omits a
  deleted one even when an index still holds it.
- **`read`**: use `readStream` and `readSnapshot` from `src/sources.js` for file sources, and
  `openReadOnly`, `readDelta` and `readRowsSnapshot` from `src/sqlite.js` for databases. They open
  read-only, keep the position and continuity rules, and never leave a `-wal`, `-shm` or lock
  behind. Redact the declared paths here, with `<redacted len=N>`.
- **`derive`**: seal every record with `seal()` from `src/records.js`. The same units must give the
  same records, whatever the order of the sources and however the units are split across calls.
  `live` and `held` each carry all five record types (`session`, `message`, `usage`, `link`,
  `lifecycle`), an empty list where there is nothing (`test/derive-state.test.js`).
- **`derive` copies what the store says, and invents nothing:**
  - a tool result's `is_error` is the store's own flag. It is null where the store keeps none,
    where the flag says success beside a shell's non-zero `exit_code`, and where `status` is
    `cancelled` or `denied`; never worked out from the exit code or the output's text
    (sessions-model v1.3, §2.3);
  - `cancelled` and `denied` come from a structured marker the store writes, or from a fixed
    string the harness itself writes for that case, matched exactly and listed for it in the
    sessions-model annex §5, v1.3; never from a pattern in free text (the same
    clause);
  - the session's `kind` is the store's own session type, null where it writes none. A sub-agent
    flag or a parent reference is a `subagent` link, not a kind (sessions-model v1.3, §2.1);
  - usage carries only the granularities and anchors the harness declares, and one session's usage
    records never overlap.
- **`unitsFromBytes`**, for file sources only, shares `read`'s split through `splitLines` and
  `snapshotUnit`.

See what an existing adapter declares:

```sh
node examples/01-describe/describe.js claude-code
```

## 4. Fixtures

A case is a store tree under `store/`, or databases as text under `store-sql/`
(`<file>.schema.sql` and `<file>.ops.jsonl`, built at test time by `conformance/sql-store.js`),
plus `binding.json` when the harness binds to a database file. Write one case per behaviour the
adapter claims. Content is synthetic: the home directory `/home/user`, documentation addresses,
`example.com` mail, toy model ids. `test/public-fixtures.test.js` scans every case.

```sh
node fixtures/claude-code/generate.js     # rewrites the cases; a second run changes nothing
git status --short fixtures/
```

## 5. The golden

```sh
node conformance/golden.js claude-code
```

```
claude-code/basic: 36 records
claude-code/features: 21 records
```

It writes each case's `expected.json` from a full replay. Review every record of it by hand before
you commit: the tests then hold the adapter to it.

## 6. Tests and the matrix row

Model `test/<harness-id>.test.js` on `test/claude-code.test.js`. It covers the golden, the growth
check, stable keys, the name lint, the reset control, `list`, the errors, the explicit facets and
`is_error`.

```sh
node --test test/claude-code.test.js
```

Then give the harness a cell under each of the 32 items of `MATRIX` in `conformance/matrix.js`:
a list of proofs, such as `[G]` (the generic check) or `[t('<harness-id>', '<words of one test
title>')]`, or `na('<why the item cannot apply>')`. Under `M.is-error`, every harness has the
generic check and its own tests: `[G, t('<harness-id>', '<words of the is_error test title>')]`.
Regenerate the report and check the matrix:

```sh
node conformance/matrix.js --write
node --test test/conformance-matrix.test.js
```

[Run the conformance matrix](run-the-conformance-matrix.md) says what each cell means and what
the test refuses.

## 7. Land it

```sh
cd ../..                   # the repository root
npm ci --ignore-scripts    # once: hs's one dependency
npm test                   # hs and every package; CI runs the same on Node 22 and 24
```

- Add a `CHANGELOG.md` entry.
- List in [`live-check.md`](live-check.md) every shape that no capture showed, marked not
  established (no live run), with what would establish it: it was built from the harness's source
  or documentation, and a live run would establish it.
- One PR per harness, or a few. Answer each review finding on its own thread, naming the commit
  that resolves it.
