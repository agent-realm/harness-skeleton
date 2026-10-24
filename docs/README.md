# Documentation

One line per page.

- **Tutorials** teach, in order, from nothing to a working setup.
- **Guides** each do one task.
- **Reference** pages are complete and dry.
- **Design** notes say why.

## Tutorials

- [first-steps.md](tutorials/first-steps.md): install `hs`, read a harness and a data folder, validate a layer, then deliver it into a scratch folder and take it out again.

## Guides

- [observe-a-data-folder.md](guides/observe-a-data-folder.md): see what a data folder holds, by class, and the retention in effect, without changing it.
- [write-a-spec.md](guides/write-a-spec.md): write spec layers and `local.toml`, and validate them.
- [launch-with-an-overlay.md](guides/launch-with-an-overlay.md): launch a harness with a spec carried at launch, writing nothing into its folder.
- [deliver-to-a-folder.md](guides/deliver-to-a-folder.md): plan, approve, apply, remove and recover in a folder a tool owns.
- [processes.md](guides/processes.md): MCP servers, hooks, status lines and skills: what each needs and how it is bound.
- [read-sessions.md](guides/read-sessions.md): list a folder's sessions and read their transcripts.
- [run-a-conformance-check.md](guides/run-a-conformance-check.md): prove an adapter against a real harness on a disposable bench.
- [add-a-session-adapter.md](guides/add-a-session-adapter.md): where a reader for a new harness goes, and what it must pass.

## Reference

- [cli-and-protocol.md](reference/cli-and-protocol.md): the `hs` command, its flags, the `hs/0.2` envelope and every operation.
- [errors.md](reference/errors.md): every error code, and what to do about it.
- [spec-format.md](reference/spec-format.md): the layer layout, every item kind in `spec.toml`, and `local.toml`.

## Design

- [skeleton-v0.2-2026-10-22.md](design/skeleton-v0.2-2026-10-22.md): **the current design**: the data folder and `harness_path`; spec layers, delivery modes, plans and receipts; state and capture; sessions through the session contracts; the conformance profiles; the Claude Code and Codex mapping.
- [build-v0-2026-10-22.md](design/build-v0-2026-10-22.md): **the build plan** for `hs`, the reference adapter: its rules, and its milestones with their status.
- [reference-harness-2026-10-23.md](design/reference-harness-2026-10-23.md): a reference harness that produces every feature the session contracts describe, on purpose, against a scripted model.
- [surveys/](design/surveys/): one cited survey per harness (Claude Code 2.1.289, Codex 0.160.0, OpenCode 1.18.18, pi 0.80.2), the sources the design note cites.

The runnable [`examples/`](../examples/) go from the smallest to a full spec.
