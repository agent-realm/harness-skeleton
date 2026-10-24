// Skeleton defaults: values the skeleton chooses itself, as opposed to a harness's built-in
// defaults, which live in each harness descriptor.

// Retention, in days, that the skeleton delivers to a folder the tool owns (`materialize`)
// when a spec sets no `retention_days`. Question 8 of the design note (§14), decided by the
// maintainer on 2026-10-22: "9999 days fine". This is the only place the value is set; everything
// else imports it.
export const DEFAULT_RETENTION_DAYS = 9999;

export const DEFAULTS = Object.freeze({
  retention_days: Object.freeze({
    value: DEFAULT_RETENTION_DAYS,
    applies_to: 'materialize, when a spec sets no retention_days',
    status: 'decided by the maintainer, 2026-10-22: design note v0.2 §13, §14 question 8',
  }),
});
