# Session adapters: documentation

- [The adapter interface](adapter-interface.md): the exports, units, positions,
  `unitsFromBytes`, the versions and what a bump asks of a consumer, `derive` input and output,
  the errors, and the fields this package adds beyond the contracts.
- [Adding a harness](../AGENTS.md#adding-a-harness): the steps, from module to reviewed golden.
- [Live check](live-check.md): the shapes no capture has shown yet, per harness, for a run on a
  test machine with each harness signed in.
- [The conformance matrix](conformance-matrix.md): what proves each conformance item, per harness.

Per harness, `src/harnesses/<harness-id>/describe.js` states the sources, facets and redaction
paths, each with its source.
