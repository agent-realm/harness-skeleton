# @agent-realm/skeleton-spec

The harness-skeleton spec as code (design note v0.2 §5):
- spec layers and `local.toml`, read and resolved (`layers.js`);
- validation, including the checks on anything a spec runs (`validate.js`, `process-checks.js`);
- the safe file readers both use (`files.js`).

`hs` and the reference harness both import it, so one spec is never read two ways. It imports
nothing from either. Its one dependency is `smol-toml`, pinned in the repository's lockfile.
