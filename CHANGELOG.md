# Changelog

All notable changes to this repository. The packages under `packages/` keep their own changelogs
where they have one.

## Unreleased

The first public cut.

- **The design:** `docs/design/skeleton-v0.2-2026-10-22.md` (format `0.2`), with the cited
  harness surveys, the build plan, and the reference harness's design.
- **`hs`, the reference adapter (`hs/0.2`):**
  - on Claude Code and Codex: `describe`, `detect`, `validate` and `observe --state`;
  - `plan`, `apply`, `recover` and `remove` under `materialize`, with receipts, a ledger per
    owner, and in-place edits of the user's JSON;
  - `launch-spec` with an overlay and launch receipts, for model roles, endpoints and login, MCP
    servers, hooks through a shim, the status line and skills;
  - `sessions.list`, `sessions.read` and `sessions.derive` through the session adapters.
- **Packages:**
  - `@agent-realm/session-adapters`: session readers;
  - `@agent-realm/skeleton-spec`: the spec as code;
  - `@agent-realm/scripted-model`: a scripted model endpoint for tests.
- **Conformance:** eleven tier 1 checks against Claude Code 2.1.307 and Codex 0.160.0, run on
  disposable benches.
- **Documentation:** a tutorial, a concepts page with five diagrams, guides, a reference, and
  eight runnable examples.
