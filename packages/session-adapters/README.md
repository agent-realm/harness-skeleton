# @agent-realm/session-adapters

**Status: v0, building.** Twelve harnesses: Claude Code, Codex, Copilot CLI, Gemini CLI, VS Code,
Goose, OpenCode, Antigravity (agy), Cursor IDE, cursor-agent, Zed and Devin Local.

## What it is

The session adapters are one reader per agent harness: Claude Code, Codex, Copilot CLI, Cursor, Zed and
the rest. Each reads that harness's own conversation store and gives back the same records:
sessions, messages and their parts, usage, links and lifecycle events. Two contracts define them:

- [sessions-model][sessions-model] v1, for what the records are and how they are keyed;
- [sessions][sessions] v1, for the four operations every adapter speaks.

| Operation | Takes | Gives |
|---|---|---|
| `describe()` | nothing | the adapter's sources, versions, redaction paths and facets |
| `list(store)` | `{host, harness, harness_path}` | every session with its sources and an `updated_hint` |
| `read(store, session, source_key, from, known)` | a position, or none | the new raw units, `continuity`, a new position |
| `derive(session, input, state)` | units and the last state | the records that changed, the complete `live` keys, a new state |

`read` never writes into a harness store. `derive` is pure.

For a file source whose raw bytes a consumer archived, `unitsFromBytes(harness, source_key, bytes,
{start})` returns the units `read` would have returned from those bytes, with no file system:

```js
import { unitsFromBytes } from '@agent-realm/session-adapters';

const { units, held_back } = unitsFromBytes('claude-code', sourceKey, archivedBytes);
```

A database source has no file bytes, so it is a `bad_request`. The package loads from CommonJS
too, with `require('@agent-realm/session-adapters')`.

## Why

Every harness keeps its conversations differently, and changes the format often. memhouse
captures them, `hs` (harness-skeleton) exposes them, and sessions-sql loaders store them. Each of
them needs the same readers. This package is the single copy: one place to fix a reader, with one
conformance suite proving it against fixtures.

## How

Node.js 22.15 or later (node:sqlite, and zstd in node:zlib for Zed). The package has no dependencies.

```js
import { adapterFor, host, harnessPath } from '@agent-realm/session-adapters';

const adapter = adapterFor('claude-code');
const store = { host: host().host, harness: 'claude-code', harness_path: harnessPath('/home/user/.claude') };
for (const s of adapter.list(store)) {
  const session = { ...store, session_id: s.session_id, incarnation: s.incarnation };
  const input = s.sources.map((src) => {
    const r = adapter.read(store, session, src.source_key, null, null);
    return { source_key: src.source_key, generation: 1, complete: true, units: r.units, gone: [] };
  });
  const { changed } = adapter.derive(session, input, null);
  // `changed` holds every record of the session on a first derive.
}
```

A consumer keeps each source's position and generation, and the derive state, between passes.
`conformance/engine.js` is a minimal consumer that shows how.

`validateSession` checks one session's records against the contract's record shapes
(sessions-model §2) and returns its findings, none when the records are valid. The conformance
suite runs it over every golden; a writer can run it before it writes:

```js
import { validateSession } from '@agent-realm/session-adapters/validate';

const findings = validateSession(records, { harness: 'claude-code', sessionId });
// [{at, problem}]: valid when every finding is a warning (`warning: true`, an unknown
// registry value such as a new harness or ts_source, which a v1 reader accepts)
```

[`docs/conformance-matrix.md`](docs/conformance-matrix.md) says, for each of the 32 adapter-side
conformance items of sessions-model and sessions and each of the twelve harnesses, what proves it:
a generic check run over every fixture case, a named test, or the reason the item does not apply.
It is generated from `conformance/matrix.js`, and `npm test` fails when it is stale.

```sh
npm test                              # unit tests and the conformance suite, against the fixtures
node conformance/golden.js claude-code   # rewrite one harness's goldens, for review
node conformance/matrix.js --write    # regenerate docs/conformance-matrix.md
```

## Where next

- [`docs/`](docs/README.md): the adapter interface, how to add a harness, and the port notes.
- [`docs/conformance-matrix.md`](docs/conformance-matrix.md): what proves each conformance item,
  per harness.
- [`CHANGELOG.md`](CHANGELOG.md): what changed, with a migration note for every key change.
- [`AGENTS.md`](AGENTS.md): rules for anyone changing this package.

<!-- The contract links: one base, https://github.com/agent-realm/sessions-model/blob/main/contracts/.
     The repository name and the ref are pending its publication; replace the base in every file that defines these links. -->
[sessions-model]: https://github.com/agent-realm/sessions-model/blob/main/contracts/sessions-model.md
[sessions]: https://github.com/agent-realm/sessions-model/blob/main/contracts/sessions.md
