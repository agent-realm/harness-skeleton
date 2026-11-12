// The value in effect for each [state] item on OpenCode, with its source (design note v0.2 §5.12).
// OpenCode has no switch for any of them [OC §16]: each is its harness default, not expressible.
// Its escapes are the descriptor's; the ones present on this machine are reported by observe.

export function stateInEffect(harnessPath, descriptor) {
  const items = descriptor.state;
  return {
    items: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { value: v.harness_default, source: 'default', expressible: false, reason: v.reason }])),
    harness_defaults: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.harness_default])),
    escapes: [],
    errors: [],
  };
}
