# Session adapters: documentation

## Guides

Each one a short tutorial, with commands that run against the package's fixtures.

- [Read a store](read-a-store.md): list the sessions in a harness store, read their units, derive
  the records and read them right, and read on from a saved position.
- [Add a harness](add-a-harness.md): the files an adapter needs; `describe`, `list`, `read` and
  `derive`; fixtures, the reviewed golden, the tests and the harness's cells in the conformance
  matrix.
- [Run the conformance matrix](run-the-conformance-matrix.md): run it, read its report, and what
  an `n/a` cell means.

The runnable [examples](../examples/README.md) go from `describe` to a full pass over every
harness.

## Reference

- [The adapter interface](adapter-interface.md): the exports, units, positions,
  `unitsFromBytes`, the versions and what a bump asks of a consumer, `derive` input and output,
  the errors and what a consumer does about a retryable one, and the fields this package adds
  beyond the contracts.
- [The conformance matrix](conformance-matrix.md): what proves each conformance item, per harness.
- [Live check](live-check.md): the shapes no capture has shown yet, per harness, for a run on a
  test machine with each harness signed in. Each is marked confirmed (naming its capture or
  fixture) or not established, with what would establish it. No live run was made for this
  release.
- [`AGENTS.md`](../AGENTS.md): the rules for changing this package, and the short list of steps
  for adding a harness.

Per harness, `src/harnesses/<harness-id>/describe.js` states the sources, facets and redaction
paths, each with its source.
