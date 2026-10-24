// @agent-realm/skeleton-spec: the harness-skeleton spec, as code (design note v0.2 §5). Spec layers
// and local.toml are read and resolved (layers.js), validated (validate.js) with the process checks
// (process-checks.js), through the safe file readers (files.js). hs and the reference harness both
// import it, so one spec is never read two ways. It imports nothing from hs.

export * from './layers.js';
export * from './validate.js';
export { processProblems } from './process-checks.js';
