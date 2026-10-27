# Examples

From the smallest to a full pass. Each directory has a README and one script, run from the
package directory:

```sh
cd packages/harness-session-adapters
node examples/01-describe/describe.js
```

Examples 02 to 05 read this package's own synthetic fixtures (01 opens nothing). A fixture case
is copied into a fresh scratch directory first ([`fixture-store.js`](fixture-store.js)), so no
example reads a real harness store or changes a fixture. What they print is the same on every
machine: the `host` is derived from a synthetic machine id, and no scratch path is shown.
`npm test` runs them all (`test/examples.test.js`), and fails if one exits other than 0, prints a
scratch path, the home directory, the host name or the checkout path, prints something else on a
second run, or leaves a file in its temp directory.

On Node 22, loading `node:sqlite` prints an `ExperimentalWarning` on stderr. It is harmless; add
`--disable-warning=ExperimentalWarning` to silence it.

| Example | Shows |
|---|---|
| [01-describe](01-describe/) | what one adapter says about itself: versions, sources, redaction, facets |
| [02-list-sessions](02-list-sessions/) | the sessions in a harness store, and each one's sources |
| [03-read-and-derive](03-read-and-derive/) | one session read from the start and derived into records, then validated: its kind, tool results, usage and links |
| [04-incremental-read](04-incremental-read/) | reading on from a saved position: `reset`, `appended`, `unchanged`, and a rewrite |
| [05-full-pass](05-full-pass/) | every fixture case of every harness, derived and validated, written as JSON Lines |

Example 01 takes a harness, `[harness]`, and examples 02 and 03 a harness and a fixture case,
`[harness] [case]`; an unknown one prints the choices.

The examples import the package by its name, `@agent-realm/harness-session-adapters`, as a consumer
would. `fixture-store.js` also uses the conformance suite's database builder
(`conformance/sql-store.js`), which is not part of the package's exports: a consumer reads a real
store and needs no builder. For the same reason `examples/` is not in the package's `files`: the
examples need `fixtures/` and `conformance/`, which do not ship either. Run them from a checkout.
