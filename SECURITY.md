# Security

## Reporting

Report a vulnerability privately, through GitHub's "Report a vulnerability" on this repository's
Security tab, not in a public issue. Say what is affected (a file, an operation, a harness and
its version), how to reproduce it, and what it lets an attacker do.

## What the project promises

These are the properties a report can show broken:

- **Secrets are references, never values.** Specs, plans, receipts, ledgers, journals,
  responses and logs carry references (`env:NAME`, `keychain:…`, `op://…`). `hs` never resolves
  a reference, never reads a harness's credential store (it may ask whether an item exists, by
  name, discarding every byte of output), and never prints a value. A binding that is not a
  reference is refused without being echoed.
- **No write without a plan and a receipt.** Only `apply`, `recover` and `remove` write a data
  folder, and only `config`-class paths and `hs`'s own records. A `sessions`, `history` or
  `credentials` path is never written. A plan is re-derived and its digest checked before any
  write.
- **What runs is what was approved.** A receipt binds a plan's or a launch's digest. The digest
  covers every file a process names in its layer, and a persisted process is bound by copy.
  Code a launch fetches (`npx`, `uvx`) is tagged `fetches-code`.
- **Reads are reads.** `describe`, `detect`, `validate`, `observe`, `plan`, `launch-spec` and the
  `sessions.*` operations write nothing into a data folder.
- **Guards fail closed where the harness lets them.** A hook on a gating event blocks the
  action when its process crashes or overruns its limit. Persisted on Claude Code 2.1.295 or
  later, it also blocks when its shim cannot start. At launch on Claude Code, and on Codex, a
  shim that cannot start lets the action through, and `launch-spec` says so under
  `unverified`.
- **The scripted model listens on 127.0.0.1 only,** and records requests by names, never content.

`docs/design/skeleton-v0.2-2026-10-22.md` states each rule precisely. The unit tests hold most
of them.

## Out of scope

- A harness's own behaviour once it is started.
- What a spec author chooses to run, once the user's receipt allows it.
- Running the conformance suite on a workstation: it is for disposable benches only.
