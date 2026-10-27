# Run the conformance matrix

**Goal:** check that every adapter-side conformance item of the two contracts is proved for every
harness, read the report, and tell a proof from an `n/a`.

Run the commands from `packages/session-adapters/`. Nothing here starts a harness: every proof
runs against the package's synthetic fixtures.

## What it is

- **`conformance/checklist.js`** lists the 32 adapter-side items: 22 of sessions-model (`M.*`),
  that is the 21 of v1 and `M.is-error` of the sessions-model v1.3, and 10 of
  sessions v1 (`S.*`).
- **`conformance/matrix.js`** gives each item a cell for each of the twelve harnesses: what proves
  the item there, or why it does not apply.
- **`conformance/generic.js`** holds the generic checks: the ones that hold for every harness the
  same way, run over every fixture case.
- **`docs/conformance-matrix.md`** is the report, generated from the matrix.

## Run it

```sh
node --test test/conformance-matrix.test.js
```

Its 21 tests check that:
- the harnesses are the package's twelve, and no cell names an unknown item or harness;
- every item has a cell for every harness, and a reason where it has no proof;
- every named test exists, and its words match exactly one test title;
- `docs/conformance-matrix.md` is what `matrix.js` makes now;
- the generic checks find nothing on any fixture case of any harness (one test per harness);
- they do find the breaks they exist for, on stores built to break them: a broken record, a broken
  tool link, a foreign usage shape, units on an unchanged read, and an `is_error` that is set on a
  cancelled or denied result, false beside a non-zero `exit_code`, or true beside one with no
  failure flag listed;
- an unknown registry value (`harness`, `ts_source`, `enc`, `position_kind`) is accepted, with a
  warning where the validator checks it.

The matrix test checks that a named test exists; the test itself runs with the rest:

```sh
npm test        # every test in the package, the named proofs included
```

A cell is proved only when both pass.

## Read the report

```sh
node conformance/matrix.js | grep -A9 '^## S.held:'
```

```
## S.held: Held: a record withheld again is in held, not changed or live, until it completes

From sessions.

| Harness | Proved by |
|---|---|
| claude-code | n/a: derive never holds a record: a message is final once its line is whole (held is always empty) |
| codex | n/a: derive never holds a record: a message is final once its line is whole (held is always empty) |
| copilot-cli | copilot-cli: “a running tool holds only its own message; its completion returns it in changed and live” |
| gemini-cli | gemini-cli: “held: a waiting tail reply, a reply re-held with a running call, then complete” |
```

One section per item: its id, its title (abbreviating the contract's wording), the contract it
comes from, then one row per harness. A cell is one of:

| Cell | Means |
|---|---|
| `generic` | a check in `conformance/generic.js`, run over every fixture case of the harness |
| `<file>: “<title>”` | the test in `test/<file>.test.js` whose title holds these words |
| `n/a: <reason>` | the item cannot be shown for this harness, for the reason given |
| `**open**: <reason>` | the harness may fail the item, and its reading waits on a ruling; none today |
| `**missing**` | no cell: the matrix test fails |

A cell can list several proofs, joined by `<br>`. Every harness's `M.is-error` cell is the generic
check plus the harness's own tests:

```sh
node conformance/matrix.js | grep -A8 '^## M.is-error:'
```

```
## M.is-error: is_error (v1.3): every tool_result copies the store's own flag; null where it has none, where the flag says success beside a shell's non-zero exit_code, and where status is cancelled or denied; a fixture result with a non-zero exit_code and no failure flag never has is_error true

From sessions-model.

| Harness | Proved by |
|---|---|
| claude-code | generic<br>claude-code: “is_error copies the tool_result block's flag; a block without one is null; every result is completed” |
| codex | generic<br>codex: “is_error is null where the output keeps no success flag; a stored flag is copied; never derived from exit_code” |
| copilot-cli | generic<br>copilot-cli: “is_error copies success; success true with a non-zero shell exit is null”<br>copilot-cli: “is_error is null for a denied call” |
```

To count the cells by kind:

```sh
node --input-type=module -e "
import { MATRIX } from './conformance/matrix.js';
const n = { generic: 0, test: 0, 'n/a': 0, open: 0 };
for (const row of Object.values(MATRIX)) for (const cell of Object.values(row)) {
  if (cell.na) n['n/a']++; else if (cell.open) n.open++; else if (cell.some((p) => p.test)) n.test++; else n.generic++;
}
console.log(n);
"
```

```
{ generic: 62, test: 253, 'n/a': 69, open: 0 }
```

Of the 384 cells, 62 are proved by generic checks alone, 253 by at least one named test, and 69
are `n/a`.

## What an n/a cell means

`n/a` is neither a pass nor a skipped failure. It says the item has nothing to test on this
harness, because its store cannot show the case the item is about:
- **M.file-stores** is `n/a` for the eleven folder-shaped stores: `describe().store_shape` is
  `folder`, so `harness_path` never names a database file. Only OpenCode binds to one.
- **S.held** is `n/a` for Claude Code and Codex: their `derive` never holds a record, because a
  message is final once its line is whole. Their `held` is the five record types' lists, each
  empty.

So an `n/a` is a claim about the harness, and is reviewed like one:
- **It needs a reason.** The matrix test refuses an `n/a` with an empty reason.
- **The reason must be true of the adapter.** Where it names a facet or a shape
  (`store_shape is folder`, `held is always empty`), check it against `describe()` and the
  adapter's tests when you review it.
- **It does not last by itself.** When a harness gains the feature (a new source, a new
  lifecycle operation), its `n/a` becomes a proof in the same PR.

An `open` cell is different: the item applies, and the harness might fail it, but what the item
asks of it waits on a ruling of the contract.

## When it fails

- **`run node conformance/matrix.js --write`:** the report is stale. Regenerate it and commit it
  with the matrix change.
- **`<item> <harness>`** in the missing list: give that harness a cell under that item.
- **`0 tests in <file> titled …`** or **`2 tests …`:** the words of a named test match no title or
  more than one. Quote words that match exactly one.
- **A generic check, `{ '<item>': [ … ] }`:** a fixture case breaks that item. Each finding names the
  session and what broke. Fix the adapter, or, if the fixture shows a real case on purpose, say
  why in `generic.js` (as `ORPHAN_RESULTS` and `FAILURE_FLAGS` do), never by loosening the check.
