# harness-skeleton v0.2: design note

| Field | Value |
|---|---|
| Status | draft for review. Supersedes the earlier drafts, v0 (2026-10-04) and v0.1 (2026-10-14), and a sessions addendum (2026-10-22) |
| Date | 2026-10-22 |
| Author | written with Claude Code (Opus 5.5) |
| Why a revision | to fold v0.1, the sessions addendum and the answers of 2026-10-22 into one note; to add the capture principle set the same day; to follow the session contracts as merged |
| Harness facts | the four surveys in `surveys/` (Claude Code 2.1.289, Codex 0.160.0, OpenCode 1.18.18, pi 0.80.2 and upstream 1.0.2), cited `[CC §n]`, `[CX §n]`, `[OC §n]`, `[PI §n]`. Four Claude Code pages (memory, skills, claude-directory, settings-reference) were re-read on 2026-10-22; the survey marks each line it took from them |
| Contracts | the session contracts `sessions-model` v0 and `sessions` v0 ([`contracts/sessions-model.md`](https://github.com/agent-realm/sessions-model/blob/main/contracts/sessions-model.md), [`contracts/sessions.md`](https://github.com/agent-realm/sessions-model/blob/main/contracts/sessions.md)), cited "sessions-model §n" and "sessions §n", with their informative annex `contracts/sessions-model-annex.md`; and [sessions-sql](https://github.com/agent-realm/sessions-sql) v0, the database mapping |

Where the merged contracts and this note differ, the contracts win; the skeleton cites them and never restates their definitions.

## 1. Vocabulary

| Word | Meaning |
|---|---|
| **harness** | the program that runs an agent loop for a user: Claude Code, Codex, OpenCode, pi. Say *test harness* for the other sense. The session contracts' vocabulary has the same row, and keeps **editor** for a harness with an IDE surface |
| **harness-skeleton** | this standard |
| **user** | the person a harness runs for: who drives its sessions, owns its data folders, and approves what a plan or a launch may do |
| **spec** | one desired harness environment, harness-neutral: a stack of **layers**. (question 1) |
| **layer** | one directory: a `spec.toml` and the file items beside it. `local.toml` is the install-local layer |
| **item** | one entry of a spec, with a stable id `<kind>.<name>`: `mcp.sentry`, `hook.guard`, `skill.release-notes`, `model.roles` |
| **data folder** | the folder a harness keeps its user-scope configuration and state in, which a binding binds. For Claude Code, Codex and pi it is their config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`); for OpenCode it holds the four XDG roots `config/`, `data/`, `cache/`, `state/`. It is the word the session contracts use. (v0: "config dir", which does not fit OpenCode; v0.1: "root", retired on 2026-10-22) |
| **`harness_path`** | the data folder's real path: absolute, symlinks resolved, in the case the filesystem stores (on case-insensitive APFS or HFS+, the on-disk case the native resolver reports: `realpath(3)`, `F_GETPATH`), without a trailing slash, compared as bytes, never a working directory. sessions-model §1 is normative. Codex canonicalizes `CODEX_HOME` the same way for symlinks [CX §1] |
| **harness store** | the conversation data of the harness bound to one `harness_path` on one host, including any it keeps elsewhere by override (pi `--session-dir`). The JSON key `store = {host, harness, harness_path}` identifies it. In prose always "harness store", never a bare "store", never a database (sessions-model §1, as the session contracts define it, 2026-10-22) |
| **session**, **source**, **raw unit**, **position**, **continuity** | as sessions-model §1 and §3 and sessions §1 and §3 define them |
| **binding** | the variables a launch sets and unsets so the harness uses a data folder, plus its typed escapes |
| **delivery mode** | how a spec reaches a harness: `overlay`, `materialize` or `reconcile` (section 4) |
| **observation** | what an adapter reports about a data folder: managed items, drift, unmanaged entries by address, and the state inventory by path class; redacted |
| **path class** | the class of a path a harness writes: `config`, `sessions`, `history`, `credentials`, `cache`, `runtime`, `logs`, or `skeleton` for this standard's own records (section 9) |
| **conformance profile** | what an adapter claims and is certified for: `full` or `sessions-only` (section 6.2). The session contracts' sessions-only conformance profile is the second |
| **plan** | the declarative, preconditioned operations that would deliver a spec; bound to digests |
| **receipt** | the user's approval of a plan: its digest, plus each trust record and risk item it allows |
| **ledger** | per-owner record of what was delivered: item id, native address, installed digest, previous value |
| **descriptor** | an adapter's report on one capability: mechanism, fidelity, readiness, dropped fields, evidence |
| **driver** | the per-harness part of an implementation; **harness descriptor**: its declarative data, path classes included |
| **reference** | a string naming a secret (`keychain:…`, `op://…`, `env:…`), never the secret |

## 2. Scope

- **Writes**: the user scope of one data folder: the managed items a spec delivers, and the skeleton's own records (section 9.3).
- **Reads**:
  - the layers that will apply at launch in a given working directory, project and managed ones included, read-only. A tool cannot predict an environment without them: project settings override user settings in every surveyed harness [CC §2, CX §2, OC §2, PI §2];
  - session content: transcripts and their sources, through sessions@v0 (the answer to question 10);
  - the state inventory: every path the harness keeps, by class (section 9).
- **Platforms**: macOS and Linux. Escapes and bindings are stated per platform (the keychain is macOS-only; Claude Code and pi keep logins in files on Linux).
- **Deferred, named**: event subscriptions (session started or ended, trust required, config rewritten); a capture operation that copies a data folder's capturable classes in one call. Until then a consumer polls `observe` and `sessions.list`, reads `observe --state`, and reads sessions with `sessions.read`.
- **Out**: writing project files; managed policy; the agent loop; UI themes and keybindings; a recipe language (tools compile their own to a spec); the database layout of captured data (sessions-sql's); live event streams such as ACP.

## 3. Principles

1. **Reuse shapes, define semantics.** Canonical file shapes come from convergence (a shape at least two harnesses read natively). Behaviour that only looks shared (hook payloads, matcher fields, permission matching) is defined by the standard and translated by adapters.
2. **The spec is the truth for what it manages; the data folder is the truth for everything else.** Managed items reconcile toward the spec; harness state and unmanaged keys are never touched.
3. **Prefer delivery that writes nothing.** Overlay at launch where the harness allows it; otherwise materialize into a data folder the tool owns; reconcile a user-owned data folder only on request.
4. **Fail before mutation.** Requirements are evaluated against the actual items, the delivery mode and the installed version, before the first write.
5. **Secrets are declared, bound per install, and never values.**
6. **Authority needs consent.** Anything that runs code, sends data to a destination or passes a trust gate is tagged; from a layer the user did not write, it needs a receipt. No trust record is written without one.
7. **Unknown is kept, and observations are redacted.**
8. **Claims are proven.** Certified version ranges come from conformance runs; everything else is labelled compatible or untested.
9. **State stays capturable.** The maintainer, 2026-10-22: the storage model must "keep things separated" so that capturing state is never made impossible; "it should be easy to extract the state (and history, and other stuff)", for memhouse in particular but not only. So every path a harness writes has a class; the skeleton's own records are kept apart and retained; no operation moves, rewrites or deletes state; and turning persistence down is explicit, install-local and listed in the plan (section 9).

## 4. Delivery modes

| Mode | Folder owner | Writes | Drift | Use |
|---|---|---|---|---|
| `overlay` | anyone | nothing in the data folder except `[state]` keys whose value keeps at least what is in effect (section 5.12); the launch spec carries flags, environment and generated files in a temp dir | none possible for configuration; a persisted `[state]` key that changes is reported as drift | ephemeral and fleet launches; any item the harness can take at launch |
| `materialize` | the tool | the managed files, regenerated from the spec before each launch; state and unmanaged keys kept | reset at next launch, reported | environments a tool creates and owns |
| `reconcile` | the user | managed fields only, three-way (spec, observed, last delivered) | conflicts reported: `keep-native`, `take-spec`, or `adopt` (import into a layer) | the user's own data folder |

A delivery mode moves configuration, never state. Under `overlay` the generated files sit in a temp dir, but the harness still writes its sessions and history into the bound data folder, where they outlive the launch (section 9.4). The one exception to "writes nothing" protects what is kept. A harness may sweep old sessions on any start, including a start the tool never made, so under `overlay` a `[state]` key with a native folder setting is persisted only when its value keeps at least what is in effect. The plan lists that write. A value that keeps less never outlives the tool's own launches under `overlay` (section 5.12). The second exception is endpoint hygiene (section 5.2): for a spec with an endpoint, the plan clears Claude Code's cached account state from the folder's `.claude.json`. That is a state write the receipt must allow (`clears-state`), nothing restores it, and a folder still logged in is refused rather than cleared.

What each harness can take at launch, from the surveys:

| Harness | Launch-time surfaces | Covers |
|---|---|---|
| Claude Code | `--settings <json>` (merges as a level), `--mcp-config`, `--strict-mcp-config`, `--agents <json>`, `--plugin-dir`, `--append-system-prompt-file`, env | settings (model, hooks, permissions, status line, env), MCP, subagents, plugins and their skills and commands, extra instructions [CC §2, §3, §8, §10, §14] |
| Codex | `-c key=value` (any key), `-p <profile>` (a whole-file profile in the data folder), `--enable`/`--disable`, env | every `config.toml` key: model, providers, MCP, hooks, permissions; not skills or `AGENTS.md` [CX §2, §4, §18] |
| OpenCode | `OPENCODE_CONFIG_CONTENT` (inline layer), `OPENCODE_CONFIG_DIR` (an additive dir of agents, commands, skills, plugins), `OPENCODE_PERMISSION`, env | nearly everything, except `AGENTS.md`, which `OPENCODE_CONFIG_DIR` replaces rather than adds to [OC §1, §2] |
| pi | `--extension`, `--skill`, `--prompt-template`, `--append-system-prompt`, `--provider`/`--model`/`--models`, `--tools` | skills, prompts, extensions (and so bridges), model; not `models.json` providers or MCP [PI §3, §5, §9, §10] |

An item a harness cannot take at launch makes `overlay` fall back per item to `materialize` when the tool owns the data folder, or to a refusal; the plan says which.

## 5. The spec

### 5.1 Layers and composition

```
<layer>/
  spec.toml                every item that is not a file; starts with [spec]
  AGENTS.md                instructions
  skills/<name>/SKILL.md   skills, with their files
  agents/<name>.md         subagents
  commands/<name>.md       prompt templates
  hooks/, bin/             processes the items run
local.toml                 the install-local layer: endpoints, ref bindings, login, state
```

A spec is an ordered list of layers, lowest first; `local.toml` is always last. Each layer's `spec.toml` starts with `[spec] name = "…", version = "1.2.0", format = "0.2"`: the content has its own version, apart from the format. Items whose key is not natural (hooks) carry explicit ids, and a later layer that replaces a `runs-code` item set by another author needs a receipt. Merge rules are per kind, never a generic deep merge:

| Kind | Rule |
|---|---|
| scalars (`model.roles.*`, `statusline`, `runtime.*`, `state.*`) | the last layer that sets it wins |
| keyed items (`mcp.*`, `hook.*`, `refs.*`, `env.*`, `plugin.*`) | merge by item id; a later layer replaces the whole item, never a field of it |
| file items (`skills/<n>`, `agents/<n>`, `commands/<n>`) | the later layer's directory or file wins by name |
| `AGENTS.md` | concatenated in layer order, each part headed by its layer's name |
| `permissions` rules | appended; evaluation is order-independent (section 5.8) |
| tombstones | `[remove] items = ["mcp.legacy", "skill.old"]` deletes an item from lower layers |

Every resolved item records its **provenance** (the layer that set it). The resolved spec has a digest; plans and receipts bind to it. The digest is the sha256 of the canonical JSON (object keys sorted) of: the format, each layer's name and version, every item's id, layer and value, the permission rules with their layers, each `AGENTS.md` part's layer and sha256, each file item's id, layer and sha256, and, for each process item (section 5.4), the sha256 of every file it names inside its layer: `exec`, and each `args` entry that resolves to a file there (since milestone 6a.3; the resolved spec lists them under `processes`). A file item's sha256 covers a file's bytes, or a directory's sorted listing of relative paths with their own digests; a symlink is digested as its target string, never followed. Provenance is part of the digest: the same content set by another layer is another spec. File items have ids `skill.<name>`, `agent.<name>` and `command.<name>`, and a tombstone removes an id or every id under it (`model.roles` removes each `model.roles.<role>`). Under `[refs]`, a table declares a ref (portable) and a string binds one to a reference (install-local) (added with the v0 build). Relative paths in a layer (`hooks/guard.sh`) are relative to that layer; delivery places the files in the data folder and writes absolute paths into the native config. Three content classes set each kind's default: **portable** items travel with a shared spec; **install-local** items (endpoints, ref bindings, login, state) live only in `local.toml` and are never adopted from a spec written elsewhere; **state** is written by the harness and only read through the skeleton.

### 5.2 Model roles, endpoints and login

```toml
# spec.toml (portable)
[model.roles]
primary  = "toy-model"
small    = "toy-model-small"     # titles, summaries, background calls
subagent = "toy-model"
effort   = "high"

[model.catalog."toy-model"]       # metadata some harnesses need (OpenCode, pi)
context = 200000
output  = 32000
```

```toml
# local.toml (install-local)
[endpoints.anthropic-messages]
base_url   = "https://gateway.example/anthropic"
credential = "keychain:example/gateway-key"
auth       = "bearer"

[endpoints.openai-responses]
base_url   = "https://gateway.example/v1"
credential = "keychain:example/gateway-key"
auth       = "bearer"

[login]
mode = "endpoint"               # isolated | endpoint
```

- Each adapter picks the endpoint for the wire its harness speaks. A provider that does not offer that wire makes the plan report `gateway_required` with the missing wire, before any write. **Adapters never translate wires**: a wire-translating proxy (9router and LiteLLM do this today) is infrastructure the tool or the user provides, and it then appears in `local.toml` as one more endpoint.
- Roles map to native slots: Claude Code `model`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`; Codex `model`, `agents.default_subagent_model`; OpenCode `model`, `small_model`; pi `defaultModel` [CC §5, CX §5, OC §5, PI §5].
- **Login**: `isolated` means the harness's own login store, inside the data folder; `endpoint` means the endpoint's credential is the only login and the store stays empty [CC §7, CX §6, §7]. v0.1 dropped `shared`: sharing a login is a tool's business above the standard.
- **A launch with an endpoint has one login, whatever the mode**: the endpoint's credential. The folder's own login could otherwise reach the endpoint: Claude Code adopts a stored claude.ai token over the supplied one after a 401 [CC §7]. So the launch unsets every other credential and provider variable, and is refused as `login_present` while the folder holds a stored login (§7.5). The login mode matters only for a launch without an endpoint.
- **Endpoint hygiene**: Claude Code turns on its claude.ai-hosted tools from cached account state in `.claude.json`, whatever `ANTHROPIC_BASE_URL` says, and at least one third-party backend rejects their schema [CC §6]. That state belongs to a login an endpoint launch does not use (the endpoint's credential is the only one), so a plan for a spec with an endpoint clears it, on Claude Code: `oauthAccount`, `cachedGrowthBookFeatures`, `cachedGrowthBookFeaturesAt`, `cachedExperimentFeatures`, `cachedExperimentData`, `passesEligibilityCache`, `cachedExtraUsageDisabledReason`. It is the one named state write (section 7.2), made one way: a login regenerates it. `launch-spec` writes nothing, so it names any of these keys still present, by name, in a note.
  - **Never from a folder still logged in.** `oauthAccount` is the trace a claude.ai login leaves, and on macOS the grant itself sits in the login keychain, where the 401 recovery path could hand it to the endpoint [CC §7]. So a plan or launch for a spec with an endpoint is refused as `login_present` while the folder holds a login (section 7.5). Where the store is shown empty, the clear removes a stale cache. The six feature-flag keys are not a login, and are cleared on their own when `oauthAccount` is absent.
  - Measured on Claude Code 2.1.307 by the tier 1 check `conformance/tier1/account-state.mjs` (pass, 2026-10-22). Endpoint starts in a fresh folder did not write the state back. Claude Code started from the cleared file. A planted account's ids did not reach the endpoint, before the clear or after it, so the reason to clear is the tools, not a leak.
- A model or MCP destination is **routing authority** (tagged `sends-data`): a layer the user did not write cannot set it without a receipt.

### 5.3 Secrets

```toml
# spec.toml
[refs.SENTRY_TOKEN]
description = "Sentry MCP token, raw, without the Bearer prefix"
[refs.DB_PASSWORD]
description = "database password for the db MCP server"

# local.toml
[refs]
SENTRY_TOKEN = "keychain:example/sentry-token"
DB_PASSWORD  = "keychain:example/db-password"
```

- A spec declares the secrets it needs; `local.toml` binds each to a reference. An unbound ref fails `validate` as `ref_unbound`; a ref an item uses (`env_refs`, `header_refs`, `bearer_ref`, at any depth) that no layer declares fails as `ref_undeclared`; a binding that is not a reference (`keychain:`, `op://`, `age:`, `env:`, `file:/`) fails as `ref_not_reference`, and its value is never echoed, because it may be a pasted secret (added with the v0 build).
- Items use structured fields, never interpolation inside strings: `env_refs = { DB_PASS = "DB_PASSWORD" }`, `bearer_ref = "SENTRY_TOKEN"`, `header_refs = { "X-Api-Key" = "SVC_KEY" }`. Since milestone 6a.4, `validate` refuses `${` in every string of an MCP server, and since 6a.5 in every process string (a status line's or a hook's `run`), as `interpolation_refused`: `exec`, `shell`, `cwd`, each `args` entry, `env` and `headers` names and values, the names in `env_refs` and `header_refs` (they become variable and header names in the file), and `url`. A process's checks are shared (`src/process.js`); `args` beside a `shell` string are refused, since a shell string carries its own and they would be dropped. Claude Code expands each one from its own environment, a shell string's `-c` argument included [CC §8 B-mcp], so it could hand the endpoint's credential or any ambient variable to the server. The string is never echoed.
- At launch the tool resolves each ref into the child's environment under a derived name; adapters write only that name into native config: `${VAR}` on Claude Code, `env_vars` / `bearer_token_env_var` / `env_http_headers` on Codex, `{env:VAR}` on OpenCode [CC §8, CX §8, OC §4]. Codex's `env_vars` forwards a variable by its own name only, so a stdio server's ref travels under its derived name and a `/bin/sh` prelude renames it for the server (section 7.5).
- Claude Code empties some credential-named variables in remote headers [CC §8]; derived names never collide with that list.
- **Exposure.** A resolved ref lives in the harness process's environment, so hook, status line and stdio MCP subprocesses inherit it, and so does the agent's own shell tool unless the harness scrubs it. Adapters set the scrub where the harness has one (Codex's `shell_environment_policy` drops names containing KEY, SECRET or TOKEN only while `ignore_default_excludes` is false. Codex 0.160.0 defaults it to true, against its docs, so the Codex adapter forces it false on every launch that carries a secret (section 7.5) [CX §12]; Claude Code lists `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` [CC §19], semantics to be verified), and derived names are chosen to match those patterns. Where no scrub exists, the descriptor says `fidelity: lossy` for secret isolation. The same exposure is why a transcript can carry a secret (section 5.11).

### 5.4 Processes

Anything a spec runs (a stdio MCP server, a hook, a status line) is a **process**: `{ exec, args, cwd?, env?, env_refs? }`, with paths relative to its layer. A plain shell string is allowed as `shell = "…"` and is tagged non-portable. Every process carries `runs-code`.

A process is bound by what it runs, not only by its name (the spec digest's part since milestone 6a.3; the launch risks come with the receipt mechanism):
- **Files in its layer.** The spec digest (section 5.1) takes in the sha256 of every file a process names inside its layer: `exec`, and each `args` entry that resolves to a file there (a directory's digest, if it names one; `.`, the layer itself, binds the whole layer's digest). An item's value alone is the string `hooks/guard.sh`, which an edited script would not change. With the files in the spec digest, plans, `plan_stale`, plan receipts and launch digests all cover an edited script, with no separate rule.
- **Anything else is bound by its text only**: an `exec` found on `PATH`, and a `shell` string. The risk list says so.
- **Only what a process names is bound.** A file it loads by itself, such as a module `server.js` imports, is not, unless the process names its directory, or `.` for the whole layer. A layer that wants its whole server bound names the directory it runs from.
- **Persisted, a process is bound by copy** (since milestone 6a.11). Under `materialize` a process runs at every start with no launch receipt, so the plan binds what it runs, not only the layer it came from. The bound unit is the one top-level directory of its layer that holds every layer path the process names. It is copied into `hs-run/<item>/` in the folder: owner-only (directories 0700, files 0700 if executable, else 0600), a tree in the ledger digest-bound like a skill. The persisted command names the copies. The rules:
  - **Only that tree is bound.** What it loads at run time from elsewhere (an interpreter, its imports, a config it reads) is not. So persisting a unit needs `self_contained = true` on the process: the author's word that the directory holds everything it loads. Without it, persisting is refused with the reason, and the item can still be carried at launch.
  - **One directory.** Paths in two top-level entries, or a file at the layer's root, are refused: put what it runs in one directory.
  - **A process that names no layer path** (a bare command on `PATH`, an absolute path, a shell string) is persisted by its text, which the receipt binds. For an absolute path the plan says "the file at this path is not bound; only the command text is".
  - **Drift:** `observe` reports a bound copy that no longer matches what the receipt allowed as drift, in words, and a launch carries the item again under a launch receipt. Once persisted, the copy runs at every start, with or without hs: an edit to `hs-run/` after `apply` runs at the next bare start, and `observe` reports it only afterwards. The owner-only modes limit that to the user's own account; `observe` is the check, not a gate.
  - **Sources:** the unit is copied from one of the plan's layers or from the install-local layer's directory (where `local.toml` sits, the user's own layer); `apply` refuses a source anywhere else.
- **Launchers that fetch code.** `exec = "npx"`, `uvx`, `bunx` or `pipx run`, with a package such as `-y @scope/server`, downloads code when it starts, so binding the text binds a name, not code. Such an item is also tagged `fetches-code`, naming the package spec. Unpinned, it may run different code at each launch. Pinned (`@scope/server@1.2.3`), it is pinned but still not bound to content.

### 5.5 MCP servers

```toml
[mcp.db]
exec     = "db-mcp"
env      = { DB_HOST = "localhost" }
env_refs = { DB_PASS = "DB_PASSWORD" }

[mcp.sentry]
url        = "https://mcp.sentry.dev/mcp"
bearer_ref = "SENTRY_TOKEN"
exposure   = "direct"          # direct | deferred | codemode; facet
```

The canonical shape is one entry of the `mcpServers` form that clients exchange (`{command, args, env}` or `{type: "http" | "sse", url, headers}`), with secrets only through refs. Adapters write native config directly where the harness CLI cannot express the item: `codex mcp add` has no flags for `env_vars` or `env_http_headers` [CX §8], and `opencode mcp add` is interactive and ignores `OPENCODE_CONFIG_DIR` [OC §8].

### 5.6 Hooks

```toml
[hook.guard]
event   = "PreToolUse"
match   = { tool = ["shell"] }
run     = { exec = "hooks/guard.sh" }
require = "required"
```

- **Portable events** (all four harnesses): `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`, `PostCompact`. **Facet events**: `PermissionRequest`, `SubagentStart`, `SubagentStop` (pi has neither subagents nor permission prompts [PI §11, §14]).
- **Matchers are typed per event**: tool events match tool classes (`shell`, `edit`, `read`, `fetch`, `mcp:<server>[/<tool>]`); `SessionStart` matches a source (`startup`, `resume`, `clear`, `compact`); compaction matches `manual`/`auto`; subagent events match an agent type [CX §11, CC §11].
- **The envelope.** The adapter's shim runs the process with one JSON object on stdin: `{"hs": {"event", "session_id", "cwd", "tool": {"class", "name", "input": {"command"?, "paths"?, "url"?, "mcp"?}}, "prompt"?, "source"?}, "native": {…the harness's own payload…}}`. A script reads `hs` to be portable, and `native` when it needs to. `session_id` resolves to a session key as section 5.11 says.
- **Decisions**: exit 0 continues; exit 2 blocks, with stderr as the reason; or stdout JSON `{"decision": "allow" | "deny", "reason", "context"}`. The shim translates to the native protocol: Claude Code and Codex natively, OpenCode by throwing in `tool.execute.before`, pi by `{block: true}` from `tool_call` [OC §11, PI §11].
- **Inert items**: a delivered item the harness will not run (an untrusted Codex hook, a hook whose content changed after trust, an untrusted project) is reported by `observe` and `launch-spec` with readiness `inert`. It is never presented as active.
- **Codex hook trust**: a delivered hook has readiness `needs-trust` until the user approves it in Codex's `/hooks`, or a receipt names it and the Codex driver for that version is certified to write `trusted_hash` correctly. Launching with `--dangerously-bypass-hook-trust` is never used: it would also run repository hooks nobody reviewed [CX §11]. Since milestone 6a.8 a launch carries its own trust: `-c hooks.state` names each launch hook's `trusted_hash` for that launch only, under the launch receipt, and nothing is written into `config.toml` (section 7.5). The hash is certified on Codex 0.160.0 by a tier 1 check.

### 5.7 Skills, agents, commands, plugins, instructions

- **Skills**: the Agent Skills specification (agentskills.io), imported by reference and normatively, never paraphrased. The standard adds one rule: `name` must equal the directory, which OpenCode enforces [OC §9]. Other frontmatter passes through and is reported as harness-specific. On Codex 0.160.0 the only per-folder location that loads today is the deprecated `$CODEX_HOME/skills` (readiness warns `deprecated`); the target is a skill-only local plugin under `$CODEX_HOME/plugins/`, adopted once tier 1 proves it loads [CX §9, §10]. A skill name starting with `.`, or one a harness keeps for itself, is refused as `skill_name_reserved` by `validate`, and its address by every write handler: Codex skips hidden directories and keeps `.system` for its bundled skills [CX §9]; Claude Code keeps `.trash`, `synced` (claude.ai-synced skills), `anthropic-skills` and `claude-ai` [CC §9]. Such a skill would install and never load as given, so it is refused rather than dropped.
- **Agents**: `agents/<name>.md`, frontmatter `name` (equal to the file name), `description` (required), `model`, `tools`; the body is the agent's prompt. Codex is translated to TOML with the body as `developer_instructions`, losing `tools` (`lossy`) [CX §14].
- **Commands**: `commands/<name>.md`, frontmatter `description`, `argument-hint`; the body takes `$ARGUMENTS` and `$1`..`$9`, as three of four harnesses do [CC §15, OC §15, PI §15]. On Codex they become skills invoked as `$name`, and positional arguments are lost (`lossy`) [CX §15].
- **Plugins**: `{id, source, format}`; the portable format is the `.claude-plugin` layout, which Claude Code and Codex load [CC §10, CX §10]. OpenCode plugins and pi packages are their own formats, and an adapter refuses a format it cannot load.
- **Instructions**: `AGENTS.md`, plain markdown. Because Claude Code expands `@path` lines recursively in an imported file and strips block HTML comments, the canonical file must contain neither; `validate` refuses both [CC §3]. The Claude Code adapter writes a `CLAUDE.md` holding `@AGENTS.md` beside it, since Claude Code reads `AGENTS.md` natively only at project scope [CC §3].

### 5.8 Permissions

```toml
mode = "ask"     # default | ask | accept-edits | bypass

[[permissions.rule]]
action      = "allow"
tool        = "shell"
argv_prefix = ["git", "diff"]

[[permissions.rule]]
action    = "deny"
tool      = "read"
path_glob = "~/.ssh/**"

[[permissions.rule]]
action = "deny"
mcp    = { server = "files", tool = "write_file" }
```

Semantics: **deny beats ask beats allow**, whatever the order. Predicate kinds: `argv_prefix`, `shell_glob`, `path_glob` (with `tool = read | edit`), `mcp`.

| Predicate | Claude Code | Codex | OpenCode | pi |
|---|---|---|---|---|
| `argv_prefix` | exact (`Bash(git diff *)`) | exact (`prefix_rule`) | exact (pattern) | none |
| `shell_glob` | exact | refused unless it is a prefix | exact | none |
| `path_glob`, allow/deny | exact | lossy: profile paths, no globs | exact | none |
| `path_glob`, ask | exact | none: profiles have no `ask` | exact | none |
| `mcp`, allow/ask | exact | exact (`approval_mode`) | exact | none |
| `mcp`, deny | exact | lossy: `disabled_tools` hides the tool | exact | none |

OpenCode takes the last matching rule, so its adapter emits allow rules first and deny rules last [OC §12]. A `required` rule that cannot be expressed exactly is refused; it is never widened.

### 5.9 Status line, runtime, session env

- `statusline = { run = { exec = "bin/status.sh" }, refresh = 10, require = "if-supported" }`. The command receives a **canonical input**: a documented subset of Claude Code's status-line JSON (`session_id`, `cwd`, `model.id`, `model.display_name`, `workspace.current_dir`, `transcript_path`, `context_window`, `cost`, `version`) [CC §13]. On Claude Code it passes through; a pi bridge builds it from extension events; absent fields are `null`. The native payload rides along under `native`.
- `[runtime]` `autoupdate = false`, `telemetry = false`, `nonessential_traffic = false`: maps to `DISABLE_AUTOUPDATER` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` on Claude Code, `check_for_update_on_startup` on Codex, `autoupdate`, `OPENCODE_DISABLE_MODELS_FETCH` and `OPENCODE_DISABLE_LSP_DOWNLOAD` on OpenCode, `PI_SKIP_VERSION_CHECK` and `enableInstallTelemetry` on pi [CC §19, CX §19, OC §19, PI §19].
- `[env]` literals only; secrets go through refs.

### 5.10 Requirement policy

Every item has `require = "required" | "if-supported"`. Defaults: required for core items, permissions, sandbox and hooks; if-supported for status line, model list, runtime and state. An unsupported `if-supported` item is skipped and listed in the plan; an unsupported `required` item refuses the plan before any write.

### 5.11 Sessions and transcripts

The model is not defined here. sessions-model@v0 defines the records (sessions, messages and parts, usage, links, lifecycle), their keys, raw units and redaction; sessions@v0 defines the adapter operations, sources, positions and continuity. Both live in agent-realm/sessions-model (the answer to question 11). This section says only what the skeleton adds: where sessions are found, how the reader is bound, and how hooks and status lines join them.

**Read-only.** A reader never writes into a harness store, never takes the folder lock (section 7.2), and never moves, checkpoints or vacuums a store file. SQLite stores are opened read-only; the one side effect allowed is the `-shm` file a read-only open of a WAL database creates (sessions §2). Reading is allowed while the harness writes. A bridge never persists into a session either: pi's `appendEntry` writes extension state into the session file as entries [PI §10], so the pi bridge must not use it.

**Where sessions live** comes from the binding (section 8). `observe` lists them as the `sessions` class (section 9). For the four surveyed harnesses:

| Harness | Harness store | Session id | Override | Source |
|---|---|---|---|---|
| Claude Code | `<harness_path>/projects/<encoded cwd>/<session-id>.jsonl`, append-only, with `<session-id>/subagents/` and `<session-id>/tool-results/`; live registry `<harness_path>/sessions/<pid>.json` | UUID | none beyond `CLAUDE_CONFIG_DIR` | [CC §1, §16] |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl`; SQLite thread state and paginated history beside it | UUIDv7 thread id | none beyond `CODEX_HOME` | [CX §16] |
| OpenCode | one SQLite DB, `data/opencode/opencode.db` (tables `session`, `message`, `part`, …) | `ses_` + 26 base62 | `XDG_DATA_HOME` | [OC §16] |
| pi | `<harness_path>/sessions/--<encoded cwd>--/<ts>_<uuid>.jsonl`, a tree of entries (`id`, `parentId`) | UUID | `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir`. A launch unsets the variable, and a `sessionDir` key is a declared escape (section 8) | [PI §16] |

**Identity.** Every key starts with `(host, harness, harness_path)`:
- `harness_path` is the real path of the data folder the binding binds (section 1). The skeleton reports the value the rule gives and never normalises it further.
- A session is `(host, harness, harness_path, session_id, incarnation)`. A session read on another host, or under another data folder, is a different session (the maintainer: "different host = different session"; sessions-model §1 rule 1). `incarnation` only tells apart the lives of one id inside one data folder (rule 2).
- Positions, cursors and continuity are scoped the same way, and a position from another host counts as absent, which forces a full read (sessions §1).
- A source the harness keeps outside the data folder by override is named by its absolute real path (sessions §1).
- `host` is the value sessions-model §1 defines (`sessions-model/host/v0`). It is derived from the OS machine id with a versioned salt, never from the hostname, so every reader on one machine gives the same value. A machine with no readable id uses a persisted random `r-` value, on which readers agree only when they run as the same OS user (sessions-model §1). An `hs` driver computes it by that rule and never invents its own; a display label may travel beside it, never in a key. Whoever clones a machine image regenerates its machine id. A clone that did not shows up in the two-hosts check (section 10).

**Reading.** `sessions.read` returns raw units per source, with one of the five continuity values (`appended`, `delta`, `reset`, `snapshot`, `unchanged`), the vanished unit keys, the new position and the held-back incomplete units. `sessions.derive` turns units into records; it is pure, and a full replay from empty state equals every incremental path (sessions-model §3). The consumer, not the adapter, keeps cursors, generations, the archive and `rev` (sessions §4).

**Joins.** The hook envelope's `session_id` (section 5.6) and the status line's `session_id` and `transcript_path` (section 5.9) must resolve to a session key. Where they do not map directly, the harness's `join.hook` facet says how:

| Harness | Hook `session_id` is the native id? | Other join aids | Source |
|---|---|---|---|
| Claude Code | yes: the transcript file is `<session-id>.jsonl`, and `transcript_path` names it | sub-agent hooks add `agent_id`/`agent_type`, so a sub-agent joins as (session, agent_id). Whether a sub-agent hook's `session_id` is the parent's is untested. The status line carries `session_id` and `transcript_path`; skills get `${CLAUDE_SESSION_ID}` | [CC §9, §11, §13, §16] |
| Codex | probably, untested | hooks carry `transcript_path` (sometimes null) and, on turn events, `turn_id`. The rollout name carries the thread id, but `session_meta` has both `id` and `session_id`, and which one hooks send is untested. Join on `transcript_path` when present. `CODEX_THREAD_ID` and `CODEX_SESSION_ID` are strings in the binary, undocumented | [CX §11, §16, §19] |
| OpenCode | yes, through the bridge: plugin hooks get `sessionID` (= `session.id`, `ses_…`) | `callID` on tool events; `messageID` on `chat.message`. A sub-agent is a child session (`session.parent_id`), so its hooks presumably carry the child's id: untested | [OC §11, §16] |
| pi | yes, through the bridge: extension handlers get `ctx.sessionManager`, and the bridge builds the envelope from it | shell tools get `PI_SESSION_ID` and `PI_SESSION_FILE` (0.82.0+). Whether `PI_SESSION_ID` equals the header `id` and the uuid in `<ts>_<uuid>.jsonl` is untested | [PI §10, §16] |

**Secrets in transcripts.** The adapter never emits a value from a declared secret field (sessions-model §4). A value the agent printed is not under a secret field path, and a resolved ref reaches the agent's shell tool (section 5.3), so a tool result can carry a secret that no field rule catches (sessions-model §4 rule 6). Transcripts are treated as sensitive, and a tool that ships them somewhere carries the `sends-data` tag. Auth stores are never read (rule 7).

### 5.12 Persistence and retention

Whether a harness keeps sessions and history, and for how long, decides what can be captured. So it is stated, never left implicit:

```toml
# local.toml (install-local only)
[state]
sessions       = "keep"     # keep | none
prompt_history = "keep"     # keep | none
retention_days = 9999       # unset: whatever is in effect, which observe reports
```

- `[state]` is install-local: only the user's own layer can reduce what is kept, as with endpoints. A `[state]` table in a portable layer fails `validate`.
- **Persisted in the folder, under `overlay` too when it protects capture.** Claude Code runs its sweep on every start and takes the period from the merged settings. Measured on 2.1.307 on 2026-10-22 [CC §16]: a 50-day-old transcript in a throwaway folder was deleted with no setting, and kept with `cleanupPeriodDays = 9999` given either by `--settings` at launch or in the folder's `settings.json`. A value carried only at launch therefore protects only the launches that carry it. One later start that bypasses the tool (a bare `claude` with `CLAUDE_CONFIG_DIR`, the IDE extension, a script) sweeps at the folder's own value. So the adapter writes the `[state]` items that have a native folder setting into the folder's settings: Claude Code `cleanupPeriodDays` (from `retention_days`) and Codex `[history] persistence` (from `prompt_history`). It writes those keys only, each recorded in the ledger with its previous value, so `remove` restores it.
  - Under `materialize` and `reconcile`, every such value is written.
  - Under `overlay`, only a value that keeps at least what is in effect is written, such as a longer retention, or `keep` where history is off. These keys, and endpoint hygiene's clear (section 5.2), are the only writes into the data folder, and the plan lists them.
  - Under `overlay`, a value that keeps less (`prompt_history = "none"`, a shorter retention) applies at launch only. It never outlives the tool's launches on a folder that may be the user's own, and the plan still lists it under **reduces capture**.

  A caller that must write nothing passes `--no-persist-state`; the plan then lists "retention covers only launches made through `launch-spec`" under **reduces capture**. Items that exist only as launch flags or environment variables (`CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `--no-session-persistence`, `codex exec --ephemeral`, pi `--no-session`) have nothing to persist. They apply to launches made through `launch-spec` only, and a start that bypasses the tool keeps sessions, so capture is never reduced by that gap.
- **The effective value and its source.** `observe --state` reports, per `[state]` item, the value in effect and where it comes from:
  - `managed`: policy that outranks the folder and every launch layer: Claude Code's managed settings, Codex's `/etc/codex/managed_config.toml` [CX §2];
  - `folder`: the folder's own settings;
  - `system`: a host-wide layer below the folder, such as Codex's `/etc/codex/config.toml` [CX §2] (added with the v0 build);
  - `project` and `local`: the layers a launch in one working directory adds above the folder, which `observe --cwd` reads. On Claude Code these are `.claude/settings.json` in the working directory and `.claude/settings.local.json` at the git root, the main checkout for a worktree; local outranks project [CC §2]. On Codex they are each `.codex/config.toml` from the working directory up to the project root (the nearest directory holding `.git`), the closest first, and only when the user config trusts the project; an untrusted project's files are named, not used [CX §2] (added with the v0 build);
  - `overlay`: launch only;
  - `default`: the harness's built-in value.

  Managed policy wins over every other source [CC §16]. A `[state]` value that managed policy overrides is delivered without effect, so `plan` flags it as `overridden_by_managed`. When the managed value keeps less than the spec asks for, the plan also lists it under **reduces capture**. Reading managed policy is read-only and in scope (section 2). A concrete case: a `/Library/Application Support/ClaudeCode/managed-settings.json` that sets `cleanupPeriodDays` to 9999 makes every Claude Code folder on that host run at 9999, whatever its own settings say (section 13).
- **Only managed policy holds for every launch.** A value persisted in the folder holds for every launch whose project and local settings and `--settings` leave the key unset. Those layers outrank the folder [CC §2, §4], and the sweep covers every `projects/<project>/` in the folder, so one launch from a project that sets a shorter period sweeps the whole folder at that period. Measuring this needs a bench without managed settings, since a managed value hides it. Whenever the source is not `managed`, `observe --state` names the layers that can still lower the value under `unverified`; `observe --cwd` reads them for one working directory.
- Any value that keeps less than what is in effect (`none`, or a shorter retention) is listed in the plan under **reduces capture**.
- Unset items keep what is in effect (managed, folder or the harness default). `observe` reports it with its source, so a consumer knows what will be deleted and when.

| Item | Claude Code | Codex | OpenCode | pi |
|---|---|---|---|---|
| `sessions = "none"` | `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` (no transcript and no prompt history); `--no-session-persistence` with `-p` only [CC §16] | `codex exec --ephemeral`, headless only [CX §16] | no switch found [OC §16]: unsupported | `--no-session` [PI §16] |
| `prompt_history = "none"` | not expressible alone: the one switch also stops transcripts [CC §16] | `[history] persistence = "none"` [CX §4, §16] | no switch found: unsupported | no prompt history in the survey |
| `retention_days` | `cleanupPeriodDays`: default 30, minimum 1, `0` fails validation. The sweep deletes transcripts, subagent transcripts and tool results older than that, without a message. The docs suggest a large value such as 3650 for long retention, and 9999 is accepted and in effect (measured on 2.1.307). The sweep runs on every start, with the period from the merged settings; managed settings override the rest; `-p --bare` skips the sweep [CC §16] | no age sweep documented; `[history] max_bytes` caps prompt history by size [CX §4] | no session sweep found; snapshot git objects are pruned by `git gc --prune=7.days`, and logs keep the newest 10, both fixed [OC §20] | no sweep found |

So on Claude Code, unless managed policy or the folder's settings say otherwise, a transcript older than 30 days is gone. A consumer that captures less often than that loses history, which is exactly what principle 9 forbids leaving unstated. What the skeleton delivers when a spec sets no `retention_days` is open question 8.

## 6. Capability descriptors

`describe` reports, per capability and per facet:

```json
{"capability": "hooks", "mechanism": "native", "fidelity": "exact",
 "readiness": "needs-trust", "facets": {"events": ["SessionStart", "PreToolUse", "..."]},
 "dropped": [], "evidence": {"run": "gentar-run-1234", "harness": "0.160.0"}}
```

- **mechanism**: `native`, `translated`, `bridged`, `none`.
- **fidelity**: `exact`, `lossy` (with `dropped` naming what is lost), `unsupported`.
- **readiness**: `ready`, `needs-trust`, `needs-login`, `inert` (delivered, but the harness will not run it: section 5.6), `untested`, `unknown`.
- **evidence**: the conformance run that proves it, or nothing (then readiness is at best `untested`).

**Bundles.** A tool states what it needs as a named bundle of capabilities with a minimum fidelity (`builder = [mcp, skills, hooks.PreToolUse]`, `statusline-host = [statusline]`, `transcript-capture = [sessions.list, sessions.read, linkage.tool]`), and `describe --bundles builder` answers whether this harness, at this version, can hold it, in one call.

| Capability | Core in the `full` profile | Facets |
|---|---|---|
| `binding` | yes | variables, typed escapes (section 8) |
| `instructions` | yes | |
| `model` | yes | roles |
| `endpoint` | yes | the wires the harness speaks |
| `login` | yes | `isolated`, `endpoint` |
| `mcp` | yes (question 2) | transports, exposure (`direct`, `deferred`, `codemode`). Minimum guarantee: stdio and HTTP, `exposure = direct`. pi's floor is 0.99.0 |
| `skills`, `plugins`, `agents`, `main-agent`, `commands`, `model-list`, `session-env` | no | plugin formats |
| `hooks` | no | events (8 portable, 3 facet) |
| `permissions`, `sandbox` | no | predicate kinds (section 5.8) |
| `statusline`, `runtime` | no | |
| `state` | no | which `[state]` items are expressible (section 5.12) |
| `sessions` | no; the whole of the `sessions-only` profile | section 6.1 |

### 6.1 The `sessions` capability

Its facets and their values are sessions@v0's (sessions §2), used verbatim:

| Facet | Values |
|---|---|
| `list` | `exact` \| `partial` (name the gap) |
| `read` | `exact` \| `lossy` (name the loss) |
| `reuse` | `impossible` \| `detected` \| `undetectable` (sessions-model §1 rule 2) |
| `lifecycle.<op>` for rewind, edit, compaction, delete, archive, unarchive, rename, pin, unpin, fork, clear | `explicit` \| `implicit` \| `invisible` |
| `linkage.<kind>` for fork, subagent, rewind_copy, clear, continuation | `explicit` \| `inferable` \| `none` |
| `linkage.tool` | `native` \| `positional` \| `none` |
| `linkage.compaction` | a `summary.replaces` form (sessions-model §2.3), or `none` |
| `join.hook` | `yes` \| `derived` (with the rule) \| `no` |

The skeleton grades each facet with the usual descriptor. A facet's value already states its fidelity; the descriptor adds mechanism, readiness and evidence.

### 6.2 Conformance profiles

| Profile | Core | Operations | Certified by |
|---|---|---|---|
| `full` | the capabilities marked core above | every operation of section 7.1; the `sessions.*` operations follow the `sessions` capability | sections 10 and 11 |
| `sessions-only` | the protocol and the binding | `describe`, `detect`, `sessions.list`, `sessions.read`, `sessions.derive`; `observe --state` if-supported | the adapter-side Conformance lists of sessions-model@v0 and sessions@v0, unchanged (sessions-model §7 decision 1) |

The `sessions-only` profile admits editors that are not harnesses in the section 2 sense: Cursor, Windsurf, VS Code Copilot, Zed, Kiro, JetBrains Copilot (the answer to question 9). For them the binding locates the data folder (its `harness_path`, from the default location or an override that `describe` names); it does not relocate it.

## 7. The adapter protocol

### 7.1 Shape

Requests and responses are versioned JSON envelopes: `{"protocol": "hs/0.2", "request_id", "op", "args"}` in, `{"protocol", "request_id", "ok", "result" | "error": {"code", "message", "items", "retryable"}}` out. `retryable` is true when the same request may succeed if sent again unchanged, false otherwise. True for the session adapters' `busy`, `inconsistent` and `damaged` from an operation that reads a store (`sessions.list`, `sessions.read`), never from `sessions.derive`, which is pure, so an error there comes from the request's own units and recurs. True for `folder_busy` when the folder is busy for now: a harness running in it, or the skeleton's lock held by a live process. False for a stale lock, which only `recover` clears. Output is bounded; subprocess output is captured and redacted.

| Op | Does | Writes |
|---|---|---|
| `describe` | the protocol versions it speaks (tools refuse an adapter without theirs), the conformance profile, descriptors, version ranges (certified, compatible), binding with typed escapes, the harness's normalization allowlist, its path classes; for `sessions`, sessions@v0's `describe` fields (`adapter_ver`, `model_version`, `state_ver`, per-role `mode` and `position_kind`, `ts_source`, the redaction field paths and lint exemptions, the facets) | nothing |
| `detect` | harness present, version, range status | nothing |
| `validate` | a resolved spec against the standard and this harness: unbound refs, forbidden `AGENTS.md` content, unexpressible required items, `[state]` outside `local.toml`. It returns item ids, layers and the digest, never values. Problems carry a code and a severity: `layer_unreadable`, `spec_header_missing`, `format_unsupported`, `layer_name_duplicate`, `item_malformed`, `install_local_misplaced` (endpoints, login, state or a ref binding outside `local.toml`), `ref_unbound`, `ref_undeclared`, `ref_not_reference` (also for an endpoint's credential), `endpoint_wire_unknown`, `state_value_invalid`, `agents_md_import`, `agents_md_comment`, `skill_malformed`, `skill_name_mismatch` (errors); `state_unexpressible` and `unknown_kind` (warnings) | nothing |
| `observe` | managed items with drift, unmanaged entries by address (values redacted), with `--cwd` the effective layers that will apply there (project, managed, trust); with `--state` the state inventory by path class, and the value in effect for each `[state]` item with its source (section 9.2) | nothing |
| `plan` | declarative operations with preconditions, risk tags and needed trust; skipped items; items that reduce capture; `[state]` values that managed policy overrides (`overridden_by_managed`); the `[state]` write under `overlay`; or `unchanged` | nothing |
| `apply` | executes a plan under a receipt; journals each step | `config` items and `skeleton` records |
| `recover` | finishes or rolls forward an interrupted apply from its journal | `config` items and `skeleton` records |
| `remove` | removes one owner's items, only where the installed digest still matches | `config` items and `skeleton` records |
| `import` | best-effort, one-way: native items into a new layer, with what it could not translate | nothing in the data folder |
| `launch-spec` | argv, `env_set`, `env_unset`, generated overlay files, working-directory requirements (pi `-a` only when a receipt covers the cwd; Codex git or `--skip-git-repo-check`; OpenCode `--auto` only when asked), and for headless runs the result semantics: exit codes, output format, and how failure shows (pi's JSON mode exits 0 after a model error, so failure is read from events [PI §17]) | temp files only |
| `sessions.list` | sessions@v0 `list` for the bound harness store: per session `session_id`, `incarnation`, `updated_hint`, `live`, `sources`; for a `full` adapter also liveness with freshness and a `resume-spec` | nothing |
| `sessions.read` | sessions@v0 `read`: takes `session`, `source_key`, `from`, `known` (the harness store comes from the binding and is echoed as `store`); returns `continuity`, `units`, `gone`, `position`, `held_back`; errors `session_unknown`, `incarnation_gone`, `source_unknown` | nothing |
| `sessions.derive` | sessions@v0 `derive`: takes `session`, `input`, `state`; returns `changed`, `live`, the new `state`, `checkpoint`. Pure: it never touches the harness store | nothing |
| `login-status` | method, presence, verified usability; never a value | nothing |

The three `sessions.*` operations are the JSON form of sessions@v0's operations inside this envelope, so an `hs` driver and a memhouse reader can both claim the contract (sessions §5).

Errors carry a code. Beside the ones named where they arise (`folder_busy`, `state_write_refused`, `unowned_conflict`, sessions@v0's `session_unknown`, `incarnation_gone` and `source_unknown`), the envelope has `bad_request`, `protocol_unsupported`, `op_unknown` (an op outside this table), `not_implemented` (an op in this table that the adapter does not carry yet), `harness_unknown`, `folder_missing`, `probe_failed` (a harness binary that would not answer), `host_unreadable` (a persisted `r-` id that cannot be read or has the wrong form, which is never overwritten), `platform_unsupported` (a `host` asked for outside macOS and Linux), the retryable read errors `busy`, `inconsistent` and `damaged` from the session adapters (the sessions contract), `gateway_required` (§5.2), `login_present` (§7.5), `interpolation_refused` (§5.3), `item_unsupported` (a `required` item the harness cannot carry, §5.10), and `internal` (added with the v0 build, `build-v0-2026-10-22.md`).

### 7.2 Rules

- **Plans are data.** A caller cannot inject a native command; the driver chooses the native effect. A plan carries the resolved spec digest, the adapter version and, per operation, the expected native digest or value. `apply` refuses a plan whose preconditions no longer hold.
- **Locks and writers.** `apply` takes `<harness_path>/.harness-skeleton/lock`, checks the harness's own locks (`.claude.json.lock`, pi's lockfile, OpenCode `state/locks/`) and live sessions [CC §1, PI §4, OC §1], writes by atomic rename in the same directory, and reads each write back to verify it. A data folder another writer holds is refused as `folder_busy`. In `reconcile` mode it refuses to write a file a live session holds open; it plans the change for the next launch instead.
- **Ledger.** `<harness_path>/.harness-skeleton/ledger.json`, namespaced by owner (`--owner builder`, `--owner other-tool`): per item, native address, installed digest, previous value. `remove` and `apply --prune` act on one owner's items only; an item two owners deliver is reference-counted.
- **Unowned items.** When the spec wants an item that exists in the data folder but is in no ledger (made by hand, or by a tool that keeps no ledger), `plan` refuses with `unowned_conflict`; `--adopt` records it under the applying owner and proceeds.
- **State is never written.** `apply`, `recover` and `remove` write managed keys in `config`-class paths and the skeleton's own records, nothing else. A plan step that would touch a `sessions`, `history` or `credentials` path is refused as `state_write_refused`, with no exception. The harness descriptor may name exceptions only as single keys inside a `config`-class file that also holds harness-written state (a `mixed` file, section 9.1); never a whole file, and never a key in a `sessions`, `history` or `credentials` path. Today there is one: the Claude Code account state in `.claude.json` (section 5.2). It is cleared, never set: a `clear` operation, tagged `clears-state`, so the receipt must allow it. The journal records only that the key was there, never its value. All clears of one file in a plan are made in one write, so the copy staged for it holds none of the values being cleared; a staged copy that never reaches its target is removed, and `recover` sweeps any a crash left. A clear makes no ledger entry, so `remove` restores nothing; `recover` finishes one a crash interrupted. Under `overlay` with `no_persist_state` it is left in place and listed under `skipped`.
- **Launch wins.** When an item is both delivered at launch and persisted, the launch value must win. A driver whose harness would let persisted config win does not deliver the item both ways.
- **Bridges** (OpenCode plugin, pi extension) are ledger items owned by the adapter, versioned with the driver, re-shipped on upgrade, and removed with the last item that needs them.
- **"Unchanged"** means an empty plan after applying the harness's **normalization allowlist**: the edits a harness makes to its own config without changing a managed value (OpenCode's `$schema`, `.gitignore` and `bun install`) are recognised, not counted as drift [OC §4]. Claude Code's `/model` is not on the list. It writes the chosen `model` to user settings [CC §5], which changes the managed value when the spec manages the model. That is drift, handled by the delivery mode (section 4): reset at the next launch under `materialize`, reported as a conflict under `reconcile`.
- **Delegation** to a harness CLI only where its semantics are exact; otherwise the driver writes the key itself.
- **Version ranges**: inside `certified`, everything runs; inside `compatible`, writes run with an `uncertified_version` warning unless `--strict-version` (set by CI and benches); outside both, writes refuse.

### 7.4 Plans, receipts, the ledger and the journal

Added with the v0 build (`build-v0-2026-10-22.md`, milestone 3, hardened in its review).

- **A plan** (`hs-plan/0.2`) records:
  - the harness, its version and range status, and the host;
  - `harness_path`;
  - **its own arguments**: layers, `local.toml`, owner, mode, `prune`, `adopt`, `strict_version`;
  - the resolved spec's digest and the ledger's digest;
  - its operations;
  - what it skipped, what reduces capture, what managed policy overrides, and warnings;
  - `unchanged` when there are no operations.

  Its digest is the sha256 of its canonical JSON without the digest itself.
- **A JSON file the user owns is edited in place** (since milestone 6a.13). A key (`json-key`) or one element of an array (`json-element`) is set by rewriting only its span (`src/json-edit.js`). So the user's other keys, their order, the indentation and whitespace all stay byte for byte, and removing what a plan added restores the exact bytes.
  - **An empty container** keeps its bytes over the round trip. An entry added to `[]` or `{}` goes inside the brackets on the same line (`[{ … }]`), and one added to a container with whitespace inside goes on a line of its own, with that whitespace kept after it. Taking the entry out removes it and the whitespace before it, which gives back the container as it was. An object or array a plan had to create stays when emptied, since the user's own empty one looks the same.
  - **The span hs writes** uses the file's indentation unit and its line ending (CRLF in a CRLF file).
  - **Refused, with the reason, and never rewritten:** a file that is not valid UTF-8 (decoding it would replace the bytes that are not), and a key held twice on the edited path (JSON readers, Claude Code's among them, take the last one, so an edit of the first would go where nothing reads it). The plan says so, and the user fixes the file.
  - **Concurrent edits.** The file is checked unchanged once the new copy is staged and synced, right before the rename, so a concurrent edit by the user or the harness is refused, never overwritten. Only the instant between that read and the rename is left, and an edit landing in it cannot be told apart.
- **`apply` never runs the operations it is handed.** Plans are data, and a caller never
  chooses a native effect (section 7.2). Under the lock, `apply` derives the plan again from
  the recorded arguments, the folder and the ledger. It runs the derived operations only if
  the derived digest equals the given one; otherwise it refuses with `plan_stale`, listing
  what differs. That covers:
  - a forged operation;
  - a folder that changed since planning;
  - a ledger another owner changed in between;
  - a harness that was upgraded in between.

  `remove` derives its operations from the ledger, under the lock, and takes none from the
  caller.
- **An operation** names:
  - the item and its native address. The address is a JSON key (`settings.json#cleanupPeriodDays`)
    or a tree (`skills/notes`);
  - the value, or the source and its digest;
  - `desired_sha256`;
  - a precondition: the address's current digest, null when absent;
  - risk tags, on writes only;
  - an action:
    - writes: `create`, `update`, `reset` (drift under `materialize`), `remove`,
      `restore` (an adopted original coming back), and `clear` (a named state key deleted one
      way, with no ledger entry; §7.2);
    - ledger only: `adopt`, `share`, `unshare`, `release`, `skip`.
- **The write handlers hold a floor of their own**, whatever operation reaches them:
  - the address is a normalized relative path: not absolute, no empty, `.` or `..` segment;
  - a `sessions`, `history` or `credentials` path is refused as `state_write_refused`, before
    anything is read;
  - the harness descriptor declares what may be written (`writable`):
    - JSON files, with the keys allowed in each: all of them for a pure config file, the named
      ones for a `mixed` file;
    - the roots under which trees are installed, one directory deep;
  - a tree's source must lie inside one of the plan's layers or in the records, and must hold
    no symlink (`write_refused`).

  A JSON key address may be nested, its segments joined by `/` (`settings.json#env/CLAUDE_CODE_SUBAGENT_MODEL`). A segment on the way that is not an object (`null` included) is refused at plan time, and an object the write created stays (as `{}`) after the key is removed. The descriptor can list keys delivery never writes: Claude Code's credential variables and `apiKeyHelper`, so that no credential reaches a settings file whatever an operation asks (§5.3), and its routing variables (`ANTHROPIC_BASE_URL` and the `CLAUDE_CODE_USE_*` provider switches), so that no bare start in the folder sends the folder's own login somewhere else. An object that holds a key on the list (`settings.json#env`) is refused too: a whole-object value could carry the key in. A JSON key write keeps every other key's value. It re-serializes the file with two-space
  indentation, and JavaScript puts integer-like keys first, so the layout can change.
- **A plan is refused before it is returned** when an item cannot be delivered:
  - `unowned_conflict`: the address exists in no ledger, unless `--adopt`;
  - `owner_conflict`: another owner installed other content, or this owner would change an
    address it shares;
  - `write_refused`, `state_write_refused`;
  - `not_implemented`: a kind this build does not deliver;
  - `spec_invalid`;
  - `version_unsupported`.

  `--prune` removes this owner's items that the spec no longer wants. A value the spec still
  wants without needing a write, such as the default retention already in place, counts as
  wanted.
- **A receipt** (`hs-receipt/0.2`) is `{plan_digest, allows, by, at}`. `allows` lists the ids
  of the operations whose risks the user accepts. `apply` refuses without a receipt for that
  digest, or when the receipt leaves out a risky operation (`receipt_required`). Both plan and
  receipt are stored under `.harness-skeleton/`, only once the plan is cleared to run.
  A receipt is the caller's record of consent, not an authorization `hs` can verify: `hs` checks
  that it matches the digest and allows every risky operation, and nothing more. Its `by` and
  `at` are what the caller wrote, never proof of who agreed. The same holds for a launch's
  receipt (section 7.5).
- **The ledger** (`hs-ledger/0.2`) is keyed by native address. Each address has `previous`
  and `owners`.
  - `previous` is what was there before the first owner: a value, absent, or an adopted tree.
    An adopted tree that was replaced carries the path of its copy in the records.
  - Each owner has the item, the installed digest, the plan and the time.

  `remove` acts only where the current digest equals the owner's installed digest. It gives
  `previous` back only when the last owner leaves: it restores a value, deletes a key, moves a
  tree into the records, or restores an adopted tree from its copy.
- **Nothing a write replaces is lost.** A tree that is replaced or removed is moved into
  `.harness-skeleton/replaced/<apply-id>/<op-id>/`. It is retained there like every other
  record, never deleted. A JSON key's value before a write is in the journal's `op-begin`.
- **The journal** is one file per apply, with the events `begin`, `op-begin`, `op-stage` (a
  tree's staged copy and aside path, before the swap), `op-done` and `complete`, each fsynced.
  A partial line from a crash during an append was never confirmed. The next append ends that
  line first and marks its own event `after_torn`, so the fragment stays a line of its own.
  A fragment is dropped and reported when it is the last line or the next event carries the
  mark. A bad line anywhere else is `recover_failed`. `apply` refuses while any journal
  is unfinished (`recover_first`).
- **`recover`** classifies every write operation first, including the ones the journal calls
  done:
  - at its desired digest, it is done;
  - at its precondition, it is pending;
  - a tree swap a crash interrupted resumes from the staged copy, or from the aside copy and
    then again;
  - anything else is a conflict.

  A single conflict stops recovery before any write (`recover_failed`). Then it acts.
- **Durability.** After every rename the containing directory is fsynced.
- **The lock** is written whole to a temp file and `link()`ed into place, so it never exists
  empty. It holds the process id, the sessions-model `host` and a nonce, and it is busy while
  that process lives on that host. A stale or unreadable lock is refused by `apply` and taken
  over by `recover`. The taker renames it to a name of its own, then checks that what it moved
  is the stale lock it read. If another taker had replaced it with a fresh lock in between,
  the fresh lock is linked back and this taker stands down. A taker proceeds, and a holder
  releases, only while the lock on disk holds its own nonce.
- **The skeleton default retention** (question 8) is delivered under `materialize` only when
  the spec sets none, and never lowers a longer folder value.

### 7.5 Launch specs and overlay

Added with the v0 build (`build-v0-2026-10-22.md`, milestone 4).

- **`launch-spec`** writes nothing into the data folder. It returns:
  - `argv`, a prefix the caller appends to (a prompt, for a headless run);
  - `env_set`: the binding variable set to `harness_path`, plus the environment the launch items need;
  - `env_unset`: the descriptor's ambient variables (section 8);
  - `files`: generated overlay files, each with its role and sha256, in a fresh temp directory (mode 700, files 600) that the caller removes after the launch, named in `temp_dir`;
  - `cwd_requirements`;
  - for a headless run, the result semantics from the survey;
  - the launch items it carries, and what it skipped;
  - `unverified`: what `hs` could not check and the caller must know.

  `observe --cwd` takes its layer files, root markers and trust table from the harness descriptor (`cwd_layers`, `project_layers`), never from logic.

  **Credentials at launch** (milestone 6a.1): `launch-spec` returns `env_from_refs`, a map from variable to reference. The caller resolves each reference into its variable when it starts the harness (`with-secret VAR=<reference> -- <argv>`). `hs` never resolves a reference, and a reference appears nowhere else in the launch spec. An endpoint for the harness's wire (§5.2) becomes:
  - on Claude Code: `ANTHROPIC_BASE_URL`, with the credential as `ANTHROPIC_AUTH_TOKEN` (bearer) or `ANTHROPIC_API_KEY` (x-api-key) [CC §6];
  - on Codex: a provider of its own, through `-c model_provider` and `-c model_providers.<id>`, whose key the provider reads from a variable it names [CX §6].

  A launch with an endpoint, in every login mode (§5.2):
  - unsets every other credential and provider variable, keeping the one the caller fills: on Claude Code the other of `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`, the `CLAUDE_CODE_USE_*` cloud switches and their per-provider variables [CC §6, §7, §19]; on Codex `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` and the workload-identity variables [CX §7]. The federation variables of Claude Code's precedence are not named in the source; they rank below both supplied variables [CC §7];
  - is refused as `login_present` while the folder holds a stored login file: Claude Code's `.credentials.json`, Codex's `auth.json`. The file is checked by name and never opened. A login in the OS credential store is keyed to the folder [CC §7, CX §7]:
    - on Claude Code under macOS, the login keychain item `Claude Code-credentials-<first 8 hex of sha256 of the folder path as spelled at login>`, or `Claude Code-credentials` for the default folder. `hs` asks whether that item exists, by service name, with every byte of output discarded; its secret is never read (`/usr/bin/security find-generic-password -s` without `-w`, by absolute path so nothing on `PATH` stands in). A locked login keychain can make the lookup raise an unlock dialog on the console, which may wait on a screen nobody watches. So a lookup gets 5 seconds; one with no answer is killed with SIGKILL, which a slow or stubborn `security` cannot ignore, and no further name is asked. It asks under the path as the caller spelled it and as the real path, and an item under either is a login. Another spelling cannot be ruled out, and `unverified` says so. Where the keychain gives no answer, an `oauthAccount` in `.claude.json`, the trace a claude.ai login leaves, counts as a login. Without one, `unverified` names the gap and the locked-keychain case;
    - on Linux `.credentials.json` is Claude Code's whole store [CC §7], so `oauthAccount` alone is a stale cache;
    - Codex's keyring, under `cli_auth_credentials_store = "keyring"` or `"auto"`, is never queried and is named in the launch spec's `unverified`;
  - on Claude Code, is also refused as `login_present` while the folder's `settings.json` sets a credential variable in `env`: a settings `env` value overwrites the shell value [CC §19], so it would replace the caller's, and an overlay cannot override it without writing a value. Key names only; no value is shown. A `settings.json` that cannot be read (a link, not JSON) cannot be ruled out, and is refused. Project, local and managed settings can set one too; `hs` does not read them at launch, and names them under `unverified`.

  On Claude Code the generated `--settings` overlay repeats, in its `env`, every variable the launch sets (the roles, the base URL, `sessions = "none"`'s variable), because a settings `env` value overwrites the shell value [CC §19] and the overlay is the command-line level, above local, project and user settings [CC §2]. With an endpoint it also sets the four `CLAUDE_CODE_USE_*` switches to `""`, which cancels an inherited value for provider selection [CC §19]. That the overlay's `env` wins per variable over the folder's is measured on Claude Code 2.1.307 by the tier 1 check `conformance/tier1/overlay-env-precedence.mjs` (pass, 2026-10-22). Without the overlay, the folder's settings `env` beat the shell for `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_BEDROCK`. With it, every request reached the spec's endpoint and none the folder's. The same check measures the unsets, with launches built as a caller builds them (its own shell, then `env_set`, the reference, then `env_unset`): with `auth = "x-api-key"`, an ambient `ANTHROPIC_AUTH_TOKEN` reached the endpoint next to the key without hs, and was cleared by hs's launch. The small and subagent role variables were not observed, since a one-shot start uses neither. The Bedrock control also showed the shell's `ANTHROPIC_AUTH_TOKEN` sent as a bearer token to the Bedrock base URL when Bedrock auth is skipped, so a switch left on would carry the endpoint's credential elsewhere.

  When the spec's endpoints offer no wire the harness speaks, the request is refused as `gateway_required`, naming the wire. Model roles are carried as follows:
  - Claude Code: `--model`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL` [CC §5, §19];
  - Codex: `-m`, and `-c agents.default_subagent_model` and `-c model_reasoning_effort` [CX §5]. Codex has no small-model role, so that one is skipped and named.

  Endpoints and login are never written to a folder; they exist only at launch. Under `materialize`, Claude Code's roles also persist, as `model` and as variables in the `env` block of `settings.json`.

  **Launch-time receipts** (since milestone 6a.3; skills at launch are the first item to need one, MCP, hooks and the status line follow). A plan's receipt covers what `apply` writes; nothing yet covers what a launch carries. Principle 6 needs one as soon as a launch carries an item that runs code or sends data.
  - **What carries risk at launch.** `runs-code`: a stdio MCP server, a hook, the status line, and a skill (it may carry scripts the agent is told to run, as under `materialize`). `fetches-code`: a process started through a launcher that downloads its code, naming the package spec (section 5.4). `sends-data`: every remote MCP server, whatever its transport (`http`, `sse`; section 5.5), naming its destination. A trust gate the launch passes, such as pi's `-a` for a working directory (section 7.1), is `trust`, bound to the directory it trusts (below). Codex's hook review is another: each launch hook's `trust` entry names the gate, its key and the hash the launch trusts. `grants-permission`: a `PreToolUse` hook that declares `may_allow`, whose `allow` skips the permission prompt for every tool its matcher names, as much as `bypassPermissions` there; the entry names the event, the tool classes and the matcher. Endpoints are not: they are install-local, so only the user's own `local.toml` sets one (section 5.1).
  - **The launch digest**: the sha256 of the canonical JSON of what the launch would run. It covers the harness, its version, the host, `harness_path`, the spec digest, `argv` with each generated file replaced by its role, `env_set`, `env_unset`, `env_from_refs` (names and references, never values), each generated file's role and sha256, and the risk list. A risk entry is `{item, layer, risk}`, plus what binds it: `sha256` for the content the item runs (a process's file, a skill's directory), a view of what the spec digest already covers (section 5.1); `package` for a `fetches-code` launcher; `destination` for a `sends-data` server; `cwd` for a `trust` gate.
  - **Working-directory trust is bound to the directory.** A launch that passes a trust gate for a working directory needs `args.cwd`. Its real path (section 1's rules, as for `harness_path`) goes into the launch digest and into the `trust` entry. The returned launch's `cwd_requirements` names exactly that directory, and the caller starts the harness there. An approval for one project therefore never authorizes another. A launch with no working-directory gate leaves the cwd out of the digest, as `hs` reads nothing from it at launch (section 7.5, Claude Code's project settings). Temp paths are left out, so two calls for the same launch give the same digest.
  - **The flow.** A launch with any risky item and no receipt is refused as `receipt_required` before anything is written: no temp dir is made. `items` carries `{launch_digest, risks}`. A receipt `{format: "hs-receipt/0.2", launch_digest, allows: [item ids], by, at}` that matches the digest and allows every risky item lets `launch-spec` return the launch, with `launch_digest`, and the receipt's `by` and `at`, in the result. A launch with no risky item needs no receipt, as today.
  - **Every risky item needs it, whichever layer set it**, as plans already require of every risky operation. Principle 6 sets the floor at layers the user did not write, but `hs` cannot tell who wrote a portable layer. The only layer known to be the user's is `local.toml`, and it holds no risky kind (endpoints, login, state, ref bindings), so the stricter rule costs nothing. The risk list names each item's layer, so a tool can show who asked.
  - **Nothing is stored.** `launch-spec` writes nothing into the data folder, so the caller keeps the receipt and may present it again while the digest holds. As with a plan's, the receipt is the caller's record of consent, not an authorization `hs` can verify (section 7.4). Any change the launch would carry changes the digest and needs a new receipt: a new MCP server, an edited hook script, a harness upgrade.
  - **In the result.** `launch-spec` returns `launch_digest` (for every launch, risky or not), `risks`, and, when a receipt was needed, its `by` and `at`. The digest is computed before anything is written. The temp root is checked first, outside the data folder, since the version probe a risky launch needs (the only launch whose binary is asked its version) makes its scratch directory under it. Before the receipt check nothing is written in the data folder. Outside it two things may be: the probe's scratch directory, under the checked temp root and removed when the probe ends, and the package's `r-` host id file (sessions-model host/v0), made only where the machine id cannot be read.
  - **The binary it binds is the binary it runs.** A launch that needs a receipt probes the binary (`bin`, else the harness's name on `PATH`) and names it by its path as `argv[0]`, so the version in the digest is the version launched. A binary that cannot be asked has no version to bind, and the launch is refused: `version_unsupported` when none is on `PATH`, `probe_failed` when the named one does not answer. A launch with nothing risky keeps the harness's name, to be found on `PATH`. The CLI takes the receipt with `--receipt <file>`.
  - **Skills at launch, on Claude Code**: one plugin directory, `hs`, in the launch's temp dir, passed with `--plugin-dir` [CC §10]. Its manifest names it, and each skill is copied in from its layer and checked against its digest. A skill appears as `/hs:<name>`, where a materialized folder has `/<name>` [CC §9]. A skill a plan already installed in the folder, at the same content, is not carried again, since the plan's receipt covered it. That needs the ledger's installed digest, the folder's copy and the layer's all equal: a copy edited in place to match an edited layer is carried, under the launch receipt. A skill holding a symlink is refused, as under `materialize`. Under `overlay` a plan lists skills under `launch_only`. Codex refuses a skill at launch (below). Measured on Claude Code 2.1.307 by the tier 1 check `conformance/tier1/skills-at-launch.mjs` (pass, 2026-10-22). Without a receipt the launch was refused and made no temp dir; with one, the skill reached the request as `hs:notes`, and nothing was copied into the data folder.
  - **Skills at launch, on Codex**: refused as `item_unsupported`, with the reason, never dropped. Codex 0.160.0 has no skill root a launch can add for `codex exec` or the TUI [CX §9]:
    - the SessionFlags layer has no skill roots;
    - `[[skills.config]]` only enables or disables skills already found;
    - only the app-server RPC `skills/extraRoots/set` adds a root, and neither front end sends it.

    Skills need no trust on Codex, so nothing like `hooks.state` applies. Three routes would reach a root, at a cost: a temp `HOME` with `.agents/skills` (the agent's shell, git and ssh see a fake home), a temp working directory (another workspace), or an overlay `CODEX_HOME` (sessions and state move with it). They change what the user works in, so they are the user's call and are not built. So a Codex skill reaches the folder through a plan under `materialize` (since milestone 6a.10), into `$CODEX_HOME/skills/<name>`, under the plan's receipt and the ledger; under `overlay` it is refused, since nothing is written there either. A launch over a folder where a plan installed the skill at this content skips it as installed; a copy edited in place is refused, as on Claude Code. Codex marks that location deprecated and still loads it: the tier 1 check `conformance/tier1/codex-skills-materialized.mjs` fails loudly the day a release stops. Measured on 0.160.0 (pass, 2026-10-23): before apply no request carried the skill; after, its description did, in the catalog line `- <name>: <description> (file: r0/<name>/SKILL.md)`, which names files by a root alias whose roots the request lists, `$CODEX_HOME/skills` among them (listed even when empty); `config.toml` was byte for byte the user's. `~/.agents/skills` is not used, since every Codex folder of the user shares it. An app-server launcher that can call `skills/extraRoots/set` is an open item.
  - **MCP servers at launch, on Claude Code** (since milestone 6a.4):
    - **The file:** one `mcp.json` in the `mcpServers` form, in the launch's temp dir, passed with `--mcp-config`. It is not strict, so the folder's and the project's own servers still load [CC §8]. Where `--mcp-config` ranks among those scopes is not documented, so a server named like one of theirs may lose to it, and `unverified` says so.
    - **Refs:** each becomes `${HS_REF_<ref>}` in the file, a name no credential list holds, and a variable in `env_from_refs` that the caller fills from the reference. The reference itself never reaches the file.
    - **Paths and shells:** a path in the server's layer is given absolutely, so the server runs from its layer; the receipt binds the layer's files as they were at `launch-spec`. The path is walked one component at a time, as the spec digest walks it (§5.4), and one that goes through a symlink is refused, since what it runs would not be bound. A `shell` string runs under `/bin/sh -c`.
    - **What is refused or skipped:** `cwd` is refused, since Claude Code's server fields have none [CC §8]. A non-direct `exposure` is skipped and named.
    - **Risks:** a server hs starts is `runs-code` (by its layer files, else its text), and also `fetches-code` when `npx`, `bunx`, `uvx` or `pipx run` starts it.
      - The `fetches-code` entry lists every package the launcher fetches, each with its own `pinned` flag: every `--package` for `npx`; `--from` and every `--with` for `uvx`; else the command's package.
      - Each launcher's options are parsed by their own semantics, so a value such as `uvx -p 3.12` is never taken for a package (`npx --help`, npm 12.0.1; `uvx --help`, uv 0.11.2).
      - An option the table does not know makes the parse `ambiguous`: nothing after it is read as the command, since it may take a value, so only explicit package options are listed (possibly none). An ambiguous entry is never `pinned`, and is still a `fetches-code` risk.
      - A remote server is `sends-data`, with its destination.
    - **Plans:** under `overlay` plans list MCP servers under `launch_only`; under `materialize` they persist (below). Codex: below.
    - **What the receipt covers.** A launch's MCP servers are the folder's, the project's and the spec's together, since `--mcp-config` is not strict. Only the spec's are in the launch digest and the risk list; the others are the folder's and the project's own business, as they are in a bare start.
    - **No interpolation.** A `${` in any MCP string is refused by `validate` (§5.3), since Claude Code would expand it.
    - **Measured** on Claude Code 2.1.307 by the tier 1 check `conformance/tier1/mcp-at-launch.mjs` (pass, 2026-10-22). Without a receipt the launch was refused with those risks. With one, the stdio server started and its tool reached the request. The server's `${HS_REF_…}` env value and the remote server's bearer header both arrived expanded, so expansion works in a `--mcp-config` file, as documented for `.mcp.json`. Nothing was written into the data folder.
  - **MCP servers persisted, on Claude Code** (since milestone 6a.12): a plan under `materialize` writes each server into user scope, `.claude.json#mcpServers/<id>` [CC §8], which Claude Code loads in every project without an approval prompt.
    - **Stdio servers** are bound by copy (section 5.4): the server's one layer directory is copied into `hs-run/mcp.<id>/`, and the persisted `command` and `args` name the copies. They are `runs-code` (and `fetches-code` for a package launcher) under the plan's receipt.
    - **Remote servers** persist by their text, `sends-data` with the destination.
    - **Refused:** a server with refs (`env_refs`, `header_refs`, `bearer_ref`), since its `${HS_REF_…}` would be filled only by a launch through hs, and a bare start would get an empty secret; `cwd`; a non-direct `exposure`. Each such server can still be carried at launch.
    - **The default folder:** refused there, as `item_unsupported`, by the asymmetry [CC §1]. In `~/.claude`, a bare `claude` (with `CLAUDE_CONFIG_DIR` unset) reads user-scope servers from `~/.claude.json` beside the folder, outside it, which hs never writes. A server written into the folder's own `.claude.json` would show as installed and never load. Launch delivery carries it as before. The default folder is told by real path: a folder that `~/.claude` links to counts as the default one, since a bare `claude` reaches it as `~/.claude` and reads `~/.claude.json`. Refusing there is the conservative reading, and `launch-spec` still carries the server.
    - **`.claude.json`:** delivery may write exactly `mcpServers/<id>` in it, one segment (a prefix rule in the descriptor's writable files), beside the account-state keys it only ever clears; `clear_only` is per key now. A user's own server of that name is `unowned_conflict`.
    - **Launch** skips a server a plan installed at this content (the key with this value, and its copy if any, as the ledger recorded them). Where `--mcp-config` ranks against user scope is undocumented [CC §8], so a server is never delivered both ways. A project or local server of the same name wins over the user-scope one [CC §8], and each operation's note says so.
    - **Measured** on Claude Code 2.1.307 by the tier 1 check `conformance/tier1/mcp-persisted.mjs` (pass, 2026-10-23):
      - apply without a receipt was refused and wrote nothing;
      - after apply, `.claude.json` held both servers and the copy was owner-only;
      - `launch-spec` passed no `--mcp-config`;
      - the stdio server started from its copy in `hs-run/`, and its tool reached the request;
      - the remote server got its literal header.
  - **MCP servers at launch, on Codex** (since milestone 6a.7): one `-c mcp_servers.<id>.<key>=<TOML value>` override per field [CX §8, §2]. The folder's `config.toml` is not written.
    - **Stdio:** `command`, `args`, `env` and `cwd`; Codex has a working directory field, so `cwd` is carried here. Layer paths are absolute and walked as on Claude Code. A `shell` string runs under `/bin/sh -c`.
    - **Refs:** Codex takes secrets by variable name and documents no `${VAR}` in values [CX §8]. Each ref becomes `HS_SECRET_<REF>`, which the caller fills from `env_from_refs`. A remote server names it in `bearer_token_env_var` or `env_http_headers`.
    - **The shell tool's scrub:** every variable hs puts a secret in, the endpoint key `HS_ENDPOINT_KEY` and each `HS_SECRET_<REF>`, is named to match `*KEY*`, `*SECRET*` or `*TOKEN*`. Codex drops those from the shell tool's environment only while `shell_environment_policy.ignore_default_excludes` is false, and 0.160.0 defaults it to true: `ShellEnvironmentPolicy::default()` and the TOML conversion's `unwrap_or(true)`, "Defaults to true" [CX §12]. The docs say the opposite. So a launch that carries a secret passes `-c shell_environment_policy.ignore_default_excludes=false`, which outranks the folder, a `-p` profile and a trusted project [CX §2], and names it in `notes`: the shell tool then gets none of the caller's own `*KEY*`, `*SECRET*` or `*TOKEN*` variables either. `exclude` is never written, since a `-c` write would replace the user's list. `managed_config.toml` outranks the flag and is named in `unverified`.
    - **The prelude:** `env_vars` forwards a variable of Codex's environment by its own name only. A server reading `DB_PASS` would put `DB_PASS` in Codex's environment, where the scrub's patterns do not reach it. So a stdio server with `env_refs` is started by `/bin/sh -c 'export DB_PASS="$HS_SECRET_DB_PASSWORD"; unset HS_SECRET_DB_PASSWORD; exec "$0" "$@"' <server argv>`, and `env_vars` forwards the derived names. The server's own name never enters Codex's environment, the derived ones are gone before the server starts, and the server runs in the prelude's place, so Codex's signals reach it. A server may therefore read a name the launch unsets, such as `OPENAI_API_KEY`. A name that is not a shell variable name is `item_unsupported`; two refs with one derived name are refused, and so is an `env` or `env_refs` name under `HS_SECRET_`, in any case, since one export could overwrite a variable a later export reads.
    - **TOML values:** each `-c` value is a TOML basic string: `"` and `\` escaped, control characters and DEL as `\uXXXX`. A lone surrogate is no Unicode scalar value, so it is refused.
    - **Refused:** an id outside `[A-Za-z0-9_-]`, since the `-c` path is dotted, and the `sse` transport, which Codex does not list (both `item_unsupported`). A non-direct `exposure` is skipped and named.
    - **Same-named servers:** CLI overrides are dotted-path writes into the merged config [CX §2], so a `-c` key lands inside a server of the same id from any layer and leaves its other keys. That would run a server neither side describes (read in source, not measured). A server id that the folder's `config.toml` defines is refused, and so is a launch with servers whose `config.toml` cannot be read. The system config, a trusted project's `.codex/config.toml` and `managed_config.toml`, which outranks the overrides, are not read for this and are named in `unverified`.
    - **Risks:** as on Claude Code: `runs-code`, `fetches-code` for a package launcher, `sends-data` with the destination. The folder's own servers still load beside the spec's and are outside the receipt.
    - **Measured** on Codex 0.160.0 by the tier 1 check `conformance/tier1/codex-mcp-at-launch.mjs` (pass, 2026-10-22), with `codex exec` against a local Responses endpoint. Without a receipt the launch was refused with those risks. With one, the stdio server started and its tool reached the request, and it saw its ref as the dummy with no `HS_SECRET_` variable left. The remote server got the bearer dummy. `config.toml` was not written. A scripted model then had the shell tool run `env` (unsandboxed, since the read-only sandbox's bwrap could not set up loopback on the bench). With hs's scrub flag taken out of the launch, in a folder with no policy, the tool's output held `HS_ENDPOINT_KEY` and both `HS_SECRET_` variables: the 0.160.0 default. With hs's launch as given, in a folder setting `ignore_default_excludes = true`, it held neither, and still held a plain variable.
  - **The status line at launch, on Claude Code** (since milestone 6a.5): `statusLine: {type: "command", command, refreshInterval}` in the `--settings` overlay [CC §13]. Its process is quoted into one command string, word by word, with layer paths absolute and never through a symlink (as for MCP); a `shell` string is the command as written. Its input is Claude Code's status-line JSON, which the canonical input is a subset of, so it passes through (§5.9). It is `runs-code` and needs the launch receipt. Claude Code's `statusLine` has no environment field and no working directory, so `env`, `env_refs` and `cwd` on it are refused in this build, never dropped. A status line, like any `runs-code` item, runs with the harness's environment, resolved endpoint credentials included (§5.3, *Exposure*): its receipt is consent to code that can read them. The `${` refusal (§5.3) keeps the harness from expanding a secret into a string it passes on, such as a header, an argument or a command; it is not a fence around the process, which can read its environment directly. Plans under `overlay` list it under `launch_only`; under `materialize` it persists (below). Codex has no custom status line [CX §13]: an `if-supported` one (the default, §5.10) is skipped and named, and a `required` one is refused as `item_unsupported`. Not bench-checked: the status line renders only in an interactive session, so a tier 1 check needs a pty driver.
  - **The status line persisted, on Claude Code** (since milestone 6a.11): a plan under `materialize` writes `settings.json#statusLine`, and, when the process names files in its layer, the bound copy `hs-run/statusline/` (section 5.4, bound by copy). Both are `runs-code` under the plan's receipt, and each operation's note states what is bound and what is not. `env`, `env_refs` and `cwd` are refused, since `statusLine` has neither field. A user's own `statusLine` is `unowned_conflict` unless adopted. A launch over a folder where a plan installed the status line at this content (the key with this value, and the copy at this content, both as the ledger recorded them) skips it, and the folder's settings carry it. Anything else is carried at launch as before, under a launch receipt. `remove` restores the key and takes the copy out. Not bench-checked yet: the status line renders only in an interactive session (the pty bench is item 3).
  - **Hooks at launch, on Claude Code** (since milestone 6a.6): `hooks.<Event>[] = {matcher, hooks: [{type: "command", command, timeout}]}` in the `--settings` overlay; hooks merge across settings levels, so the folder's own still run [CC §11].
    - **The matcher:** exact names joined by `|` while every name is in Claude Code's exact-match charset, else escaped and anchored (`^(reviewer\.v1|code-reviewer)$`), since a matcher with any other character is an unanchored regex [D-hooks §Matcher patterns]. For the classes, the names are (`shell` is `Bash`; `edit` is `Edit`, `Write` and `NotebookEdit`; `read` is `Read`; `fetch` is `WebFetch` and `WebSearch`; `mcp:<server>/<tool>` is `mcp__<server>__<tool>`), or an anchored regex once an MCP server's every tool is asked for. Sources, triggers and agent types are joined by `|`. The tool table is descriptor data, observed in 2.1.307's requests [CC §11 B-hooks].
    - **The command** runs hs's hook shim (`src/drivers/claude-code/hook-shim.js`) under the node that runs `hs`. The shim hands the process the envelope of §5.6 on stdin and translates its decision:
      - exit 2, or `decision: "deny"`, blocks, with the reason on stderr. On `PermissionRequest` exit 2 is not honoured, so a block there is `hookSpecificOutput.decision {behavior: "deny", message}` on exit 0 [D-hooks §PermissionRequest decision control, read 2026-10-22];
      - `allow` on `PreToolUse` becomes `permissionDecision: "allow"`, which skips the permission prompt for that call, but only for a hook that declares `may_allow = true`, which then carries a `grants-permission` risk. From any other hook an `allow` only continues;
      - `context` becomes `additionalContext`;
      - plain stdout passes through;
      - a process that cannot be run blocks. On a gating event (`PreToolUse`, `PermissionRequest`, `UserPromptSubmit`), a process that exits with any code but 0 or 2, dies by a signal, or runs past its limit, blocks too, whatever it printed: a guard that crashes or stalls fails closed. `Stop` is not gating, since blocking it keeps the agent going.
      - **The limit.** Claude Code cancels a hook that reaches its `timeout` and goes on, which on `PreToolUse` lets the call through [D-hooks §Timeouts]. So the shim stops the process itself at the hook's `timeout` (60 s when the spec gives none), with SIGKILL, and decides; the native `timeout` is set 10 s above it. Claude Code's own `onFailure: "block"` (2.1.295 and later) is not set, since the compatible range starts at 2.1.289 and a `-p` run ignores a settings file that fails validation. If the shim itself cannot start, Claude Code takes that as a non-blocking error, and `unverified` says so.
      - **Events that cannot block.** On `SessionStart`, `SessionEnd`, `SubagentStart`, `PostToolUse` and `PostCompact`, exit 2 only shows stderr [D-hooks §Exit code 2 behavior per event]. Such a hook's `runs-code` risk carries `blocks: false`, and its launch item says a deny there is shown, not enforced.
    - **Paths and environment:** the process's layer paths are absolute, never through a symlink. `env` and `env_refs` reach it through the shim, a ref by its derived variable, so no value and no `${` is in the command. `cwd` is honoured.
    - **Approval:** each hook is `runs-code`, under the launch receipt.
    - **Plans:** plans list hooks under `launch_only`. Codex: below.
    - **Measured** on Claude Code 2.1.307 by the tier 1 check `conformance/tier1/hooks-at-launch.mjs` (pass, 2026-10-22):
      - without a receipt the launch was refused;
      - a `SessionStart` hook got the envelope (event, source `startup`, the session id, the native payload) and its env ref;
      - an `allow` with context reached the model's request;
      - a `deny` on `UserPromptSubmit` blocked the prompt, so no request was sent.

      The tool events' translations (`PreToolUse`, `PostToolUse`, `PermissionRequest`) need a model that calls a tool, and are unit-tested only.
  - **Hooks persisted, on Claude Code** (since milestone 6a.13): a plan under `materialize` writes each hook as a group of its own in `settings.json`'s `hooks.<Event>`, beside the user's groups, never replacing the array.
    - **The element:** set by `json-element`. Our element is told by its shape: a group holding one handler whose command ends with hs's own closing comment, the recovery comment below, exactly as hs writes it for this hook's copy in this folder, `<folder>/hs-run/<item>/`, and its event, under any owner name. The folder is its real path, so the match is exact whatever characters it holds; a mention of another hook's path anywhere earlier in a command, or another folder's comment, never counts. No marker field is added, since Claude Code's settings validation could drop a file with an unknown key. Only its span is rewritten (§7.4).
    - **What it runs:** hs's shim from the folder's copy, `hs-run/hook-shim/`, and the hook's process from its bound copy, `hs-run/hook.<id>/` (section 5.4). Nothing persisted points into an hs checkout or a layer that may move.
      - `src/shim/` is self-contained (the core, each harness's entry and hook table, importing nothing outside it).
      - It is the one tree source outside a plan's layers, admitted for `hs-run/hook-shim` only.
      - Each tree is `runs-code` under the plan's receipt, and so is each element (`grants-permission` too when it declares `may_allow`).
    - **A guard fails closed:** a gating hook (`PreToolUse`, `PermissionRequest`, `UserPromptSubmit`) sets `onFailure: "block"`. Claude Code then treats a hook that cannot start (node gone, the copy missing), exits other than 0 or 2, times out, or prints invalid JSON as exit 2 on that event, and on `PermissionRequest` as a deny. It needs Claude Code 2.1.295 or later [code.claude.com/docs/en/hooks §onFailure, read 2026-10-23], so a gating hook is refused for a folder whose detected Claude Code is older. A non-gating hook persists without it.
    - **The way out:** a guard that cannot start blocks every matching action, so each command ends in a shell comment naming how to take it away: `hs remove --owner <owner>` on the folder, or the `settings.json` entry to delete. Claude Code quotes the command when the hook fails.
    - **The interpreter.** The command starts with the node hs ran under when the plan was made, by its absolute path, and the plan's note names it: "bound to the node at <path>: if that node is removed or moved (a version manager's upgrade, say), every matching action in this folder is blocked until a plan is applied again". That is the guard failing closed, as intended; the note is how the user learns it before a blocked session does.
    - **The version gate checks one binary.** hs checks the Claude Code it was given. Another Claude Code using the same folder, such as an IDE's bundled one, is not checked, and below 2.1.295 it ignores `onFailure`, so the guard fails open there. The plan lists this under `unverified`.
    - **Refused:** refs (a bare start would get an empty secret), a `cwd` outside the bound copy, and a folder whose path holds a line break or a control character (it would end the closing comment early and run the rest of it).
    - **Launch** skips a hook a plan installed at this content (its group, its copy and the shim's copy), so it never runs twice. The group is compared under the node the folder's group names, so hs running under another node is drift for `plan` to show (an `update`), not a reason to carry the hook again. When that node is missing, `launch-spec` says so in its notes: every matching action is blocked until a plan is applied again.
    - **Measured** on Claude Code 2.1.307 by the tier 1 check `conformance/tier1/hooks-persisted.mjs` (pass, 2026-10-23):
      - `settings.json` kept the user's group and bytes, with our two groups inserted;
      - `launch-spec` carried neither hook;
      - the `SessionStart` context reached the request, and the `UserPromptSubmit` guard let the prompt through;
      - with the shim's copy removed, the guard could not start, and `onFailure: "block"` kept the prompt from the model, with no request sent;
      - `remove` took both out and kept the user's bytes.
  - **Hooks at launch, on Codex** (since milestone 6a.8). Source read at `rust-v0.160.0`, recorded in the Codex survey §11:
    - **The groups:** one `-c hooks.<Event>=[{matcher, hooks: [{type: "command", command, timeout}]}]` per event, one group of one handler per hook. Codex builds the SessionFlags layer from the `-c` overrides alone, and discovers hooks from each layer's own TOML and `hooks.json` (config/src/loader/mod.rs `build_cli_overrides_layer`; hooks/src/engine/discovery.rs). So `-c hooks.PreToolUse` replaces none of the folder's own `PreToolUse` hooks, and the folder's and a trusted project's hooks still run. This was measured with the folder's own `PreToolUse` guard on `Bash` beside the launch's. The array replaces only within the SessionFlags layer, which holds nothing else.
    - **Trust for the launch:** SessionFlags hooks need trust like the user's. Trust state is read from the user and session-flag layers only, field by field. So one `-c hooks.state={…}` table names each handler's `trusted_hash`, keyed `/<session-flags>/config.toml:<event label>:<group>:0`. It is one table because a second `-c hooks.state` would replace the first. The folder's own `[hooks.state]` is left as it is.
    - **The hash:** `sha256:` and the hex digest of the canonical JSON (keys sorted at every depth, no spaces) of `{event_name: <label>, matcher (matcher events only), hooks: [{type, command, timeout, async}]}`. hs computes it as Codex does (`hookHash` in `src/drivers/codex/deliver.js`). A Codex that hashes otherwise would skip the hooks, silently under `codex exec`, so a guard would not run; `unverified` says so, and the tier 1 check certifies each version range.
    - **The command** runs hs's hook shim for Codex (`src/drivers/codex/hook-shim.js`; the core is shared with Claude Code in `src/hook-shim.js`). Codex runs it as `<zsh|bash|sh> -c <command>`, so POSIX quoting holds, with Codex's full environment (`shell_environment_policy` does not apply to hooks).
    - **Failing closed:** Codex lets a `PreToolUse` call through on a spawn error, a timeout, an exit other than 0 and 2, a signal, exit 2 with an empty stderr, or JSON stdout that does not parse. So the shim decides each case itself:
      - it stops the process at its limit (the hook's `timeout`, else 60 s; Codex's own sits 10 s above);
      - every block is exit 2 with a reason that is never empty. Exit 2 also denies a `PermissionRequest` on Codex;
      - on a gating event, output whose trimmed start is `{` or `[` (Codex's `looks_like_json`) must be one JSON object, else the hook blocks. Plain text still passes. Claude Code's shim keeps passing such output through.
    - **Envelope:** the shell tool reports `Bash` with `{command}`; the patch tool reports `apply_patch` with the patch in `command`, so its `paths` come from the patch's file headers and it carries no `command`; MCP tools are `mcp__<server>__<tool>`.
    - **Context:** `context` becomes `additionalContext` only on `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit` and `SubagentStart`. Codex's output structs refuse unknown fields, so a field an event lacks would invalidate the whole output.
    - **The matcher:** exact names joined by `|` only within Codex's exact charset `[A-Za-z0-9_]` (no `-`), else escaped and anchored. The matcher is left out on `UserPromptSubmit` and `Stop`, which match nothing.
    - **Refused** (`item_unsupported`):
      - `may_allow`: Codex takes `allow` only with `updatedInput`, which rewrites the call, so a bare allow is a failed hook;
      - the `read` and `fetch` classes: Codex has no file-read tool, and its web search is hosted, so such a hook would never fire;
      - a `SessionEnd` limit above 2 s, since Codex caps `SessionEnd` hooks at 3 s.
    - **No interpolation:** Codex substitutes `${key}` in a hook command, so a `${` anywhere in the built command is refused as `interpolation_refused`: in a layer directory, in hs's own path, in node's. The same check runs on Claude Code's hook and status-line commands and on every in-layer path a launch resolves, for MCP too (`refuseInterpolation` in `src/process.js`).
    - **Approval:** each hook is `runs-code` (with `blocks`) and `trust` (the gate, the key, the hash), under the launch receipt. A hook's `env_refs` travel as `HS_SECRET_<REF>`, so the launch also forces the shell tool's scrub (above). Plans list hooks under `launch_only`.
    - **Measured** on Codex 0.160.0 by the tier 1 check `conformance/tier1/codex-hooks-at-launch.mjs` (pass, 2026-10-22). A scripted model called `exec_command`, under `--sandbox danger-full-access`:
      - with the trust table taken out, no spec hook ran and the command ran;
      - with it, `SessionStart` got the envelope and its env ref, and its context reached the request;
      - the `PreToolUse` guard got the shell call (`Bash`, class `shell`) and denied it: the command did not run, and its reason reached the tool output;
      - a guard whose process exits 1 failed closed;
      - the folder's own `PreToolUse` hook on `Bash`, trusted in its own `[hooks.state]` by the same hash and keyed by the user config's path, ran in every run, beside the launch's guard.
  - **One receipt per launch, apart from the plan's.** An overlay plan lists the same items under `launch_only`, but a launch can happen without a plan, and a plan with no operations writes no records. A single receipt covering both is a later refinement.

  On Claude Code, retention goes into a `--settings` file, which outranks every file but managed policy, so the launch wins (section 7.2). `sessions = "none"` becomes `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, and `--no-session-persistence` on a headless run [CC §16, §17]. On Codex, prompt history becomes `-c history.persistence="…"`, and `sessions = "none"` becomes `--ephemeral` on a headless run only; an interactive run has no switch, so it is skipped and named [CX §16, §17]. Kinds that reach a launch through their own milestones are described above; on Codex, a skill at launch is refused as `item_unsupported` (above).
- **An overlay plan** carries no skeleton default: the folder may be the user's own. It can make two writes. One is endpoint hygiene's clear (section 5.2): one way, behind a `clears-state` receipt, and never in a folder still logged in, which is refused. The other is a `[state]` key with a native folder setting whose value keeps more than the folder keeps now (section 5.12):
  - When the folder's own settings already keep at least the spec's value, nothing is written; the launch still carries the value.
  - When a value the user set by hand keeps less, the spec's value replaces it, and that one key is adopted implicitly. The user's value becomes `previous`, so `remove` gives it back, and the operation's note says what it replaces.
  - A shorter value goes to `launch_only` and `reduces_capture`.
  - `no_persist_state` writes nothing, and the plan says retention then covers only the tool's launches.

  The plan lists every launch-only item under `launch_only`. Under overlay a `--prune` never removes an address holding a `[state]` value, since restoring an earlier value could lower it, and with `no_persist_state` it removes nothing. The apply follows section 7.4: derived again under the lock, run only if identical.
- **A plan with no operations** changes nothing, so its apply writes nothing either: no lock, no records, no `.harness-skeleton/` in a folder that may be the user's own. The plan is still derived again and must match, and the receipt is still checked.
- **`launch-spec` refuses a temp root inside the data folder** (`write_refused`), which a `TMPDIR` pointing there would give.
- **Each descriptor names its delivery modes.** Claude Code has `materialize` and `overlay`. Codex has both, and under `materialize` writes skills only (since milestone 6a.10): trees one level under `skills/`. Its `config.toml` is never written, since it is the user's TOML and an edit of one key that keeps the rest of the file as written is later work. The descriptor's writable roots are skill trees and nothing else (`writable: {json: {}, trees: ["skills"]}`), so no handler can write `config.toml` or any JSON or TOML file, whatever plan it is handed. So a Codex plan in either mode lists its `[state]` items under `launch_only` and `reduces_capture`, and its only operations are skill trees.

### 7.3 Implementations

**The protocol is the contract.** Any implementation that passes conformance counts, wherever it lives, and in whatever language. The session readers of memhouse, the memory plane that consumes this package, are the first session adapters (the answer to question 12; sessions-model §7 decision 2). A reader that is a module rather than an executable is run through a thin shim that speaks the envelope; conformance tests the operations' semantics, not the transport.

**One reference implementation is proposed, not decided** (questions 4 and 6, section 14). The proposal is one binary, `hs`, with three parts:
- a shared core: layer resolution, validation, refs, ledger, locks, journal, digests;
- a **driver** per harness: native serialization, CLI delegation, probes;
- a **harness descriptor** per harness and version range, kept as data: capabilities, facets, tool-class names, binding, escapes, path classes, and what delivery may write (section 7.4).

A third party can ship a driver as its own executable speaking the same protocol.

**The session adapters** (sessions@v0's `describe`, `list`, `read`, `derive`, one reader per harness) live in this repository as their own package, `packages/session-adapters/` (`@agent-realm/session-adapters`), maintained with memhouse (section 13). The package imports nothing from `hs` or memhouse, holds the one `host` and `harness_path` implementation, and carries the fixtures and the conformance runner. memhouse consumes it; `hs` wraps it, and its `sessions.*` operations pass through to it. `hs` never reads a harness store itself.

Since milestone 5 (`build-v0-2026-10-22.md`):
- `hs` takes `host` and `harness_path` from the package, keeping only its own refusal of Windows (section 2).
- `sessions.list`, `sessions.read` and `sessions.derive` hand sessions v0 §2's JSON to the package and return its answer unchanged. `sessions.list` and `sessions.read` add the `store` the binding gives. `sessions.derive` takes no binding, being pure.
- `sessions.read` refuses a session key whose `host`, `harness` or `harness_path` is not the bound harness store's, as `session_unknown`: another host or folder is another session (sessions-model §1 rule 1).
- The package's typed errors keep their codes in the envelope. `busy`, `inconsistent` and `damaged` (the sessions contract) carry `"retryable": true` on the error (until then, `{"retryable": true}` in `items`).
- `describe` carries the package's sessions `describe()` under `sessions`.
- The sessions operations need the package's reader, not an `hs` driver: a harness the package reads is served even where `hs` delivers nothing yet (OpenCode today). A harness neither knows is `harness_unknown`.
- **Database-file stores.** Every OpenCode store is bound to its database file (sessions-model §1): the default `opencode.db` in the data folder, each `opencode-<channel>.db`, and an `OPENCODE_DB` anywhere. The binding stays the data folder, a directory as always, but the store's key is the file's real path, from the package's `harness_path`, never the folder. Where a harness keeps its stores is the package's fact: `describe().store_shape` (sessions v0 §2), `{kind: "folder"}` or `{kind: "file", default, names}`, which the shim reads (hs's own `sessions_store` table is gone). `args.store` names a store: a file name inside the folder, which must still be inside the folder once every link is resolved, or an absolute path, the documented way to name a store elsewhere. Only an absent `args.store` means the default store; `null` or any other non-string is `bad_request`. It is refused for a harness that keeps its sessions in the folder, and anything but a file is refused as a store. A missing store is `folder_missing`, naming the store. An absolute store is trusted input, since an `OPENCODE_DB` can point anywhere: `hs` does not check that the file is an OpenCode database. The package's reader opens it read-only as SQLite and queries only its own tables, so a file that is not one yields no sessions, or `damaged`. `--store` should name an OpenCode database.

## 8. Binding and isolation

```json
{"harness_path": "/…/env-1", "env_set": {"CODEX_HOME": "/…/env-1"},
 "env_unset": ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION"],
 "escapes": [{"kind": "inbound-read", "path": "~/.agents/skills", "class": "config", "closable": false}]}
```

- **`harness_path`** is the bound data folder's real path (section 1). Session keys carry it, so a binding that reaches the folder through a symlink still names one folder. Where a harness's stores are database files (OpenCode), a session key carries the store file's real path instead, and the binding stays the folder (section 7.3).
- **Typed escapes**: `inbound-read` (host paths the harness reads), `outbound-write` (host paths it writes), `child-env` (binding variables its tools inherit), `credential-namespace` (stores shared across data folders, such as Codex's MCP OAuth keyring entries [CX §7] or Anthropic Console profiles [CC §7]). Every escape that holds written data carries its path class (section 9), so a consumer knows where state outside the folder sits.
- **Ambient environment**: every launch spec unsets the variables that would redirect the harness from the host shell. OpenCode's `OPENCODE_CONFIG*` family is the sharpest case [OC §1]. pi's `PI_CODING_AGENT_SESSION_DIR` is unset too, so sessions stay in the folder [PI §16].
- **pi's session dir.** A `sessionDir` key in the folder's own `settings.json` is reported by `observe` as an `outbound-write` escape of class `sessions`. In a folder the tool owns (`materialize`), the managed settings leave it unset; in the user's own folder (`reconcile`), it is reported, never changed. Sessions written there still belong to the harness store of the bound folder (sessions-model §1).
- **Closing what can be closed**: the OpenCode bridge plugin restores the host's XDG values for shell tools through its `shell.env` hook and passes them to stdio MCP servers; OpenCode launches set `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_EXTERNAL_SKILLS` [OC §1, §11]. Where a restore is not possible, `GIT_CONFIG_GLOBAL` pointing at the user's real git config keeps the agent's git working under relocated XDG roots.
- **Isolation as a requirement**: a spec may say `isolation = "strict"`; any non-closable inbound escape then refuses the plan, and the user sees exactly which path.

## 9. State and capture

The maintainer's requirement (principle 9): a harness's state, its history and everything else it keeps must stay easy to extract, for memhouse in particular but not only. The skeleton does not capture anything itself. It makes sure a consumer always can, by knowing what every path is, by never destroying it, and by making any reduction of what is kept explicit.

### 9.1 Path classes

Every path a harness writes, inside the data folder or through an escape, has exactly one class in the harness descriptor for that version:

| Class | Holds | Capture |
|---|---|---|
| `config` | settings, instructions, skills, agents, commands, plugins, hooks; what a spec delivers or the user writes | copy as files; values on secret paths are redacted |
| `sessions` | the harness store: transcripts, session databases, sub-agent files, sidecars | through `sessions.read` and `sessions.derive` only, never as raw file copies, so redaction applies |
| `history` | other records of past activity: prompt history, checkpoints and file history, plans, tasks, memories, generated images | copy as files; sensitive, like transcripts |
| `credentials` | login and token stores | never read; named by path only (sessions-model §4 rule 7) |
| `cache` | anything the harness rebuilds: model catalogs, downloaded tools, plugin installs | not needed |
| `runtime` | live-process state: locks, the live-session registry, sockets, shell snapshots | not needed; `sessions.list` reports liveness |
| `logs` | logs and debug output | optional |
| `skeleton` | the skeleton's own records under `.harness-skeleton/` (section 9.3) | copy as files |

A file that mixes classes is classified by its main content and lists the others in `mixed`. OpenCode's `opencode.db` is `sessions` with `mixed: [credentials]`, because its `account` and `credential` tables hold tokens [OC §7]. A raw copy of that file is a copy of credentials, which is why `sessions` is captured only through the adapter. Claude Code's `.claude.json` is `config` (user MCP servers) with `mixed: [runtime, history]` (account state, per-project trust and history) [CC §1].

The surveyed harnesses, by class (paths relative to `harness_path`; the descriptor holds the complete list per version):

| Class | Claude Code [CC §1, §16, §20] | Codex [CX §1, §16, §20] | OpenCode [OC §1, §20] | pi [PI §1, §16] |
|---|---|---|---|---|
| `config` | `settings.json`, `CLAUDE.md`, `rules/`, `skills/`, `commands/`, `agents/`, `output-styles/`, `keybindings.json`, `plugins/` records; `.claude.json` (mixed) | `config.toml`, `<name>.config.toml`, `AGENTS.md`, `hooks.json`, `rules/`, `skills/`, `agents/`, `plugins/` | `config/opencode/` (`opencode.json`, `tui.json`, `AGENTS.md`, agents, commands, plugins, skills) | `settings.json`, `models.json`, `keybindings.json`, `AGENTS.md`, `SYSTEM.md`, `extensions/`, `skills/`, `prompts/`, `npm/`, `git/` |
| `sessions` | `projects/<cwd>/<id>.jsonl`, `<id>/subagents/`, `<id>/tool-results/` | `sessions/YYYY/MM/DD/rollout-*.jsonl`, `session_index.jsonl`, `state_5.sqlite`, `thread_history_1.sqlite` | `data/opencode/opencode.db` (mixed), `data/opencode/storage/` | `sessions/--<cwd>--/*.jsonl` |
| `history` | `history.jsonl`, `file-history/`, `plans/`, `tasks/`, `projects/<cwd>/memory/`, `agent-memory/`, `uploads/` | `history.jsonl`, `memories/`, `memories_1.sqlite`, `goals_1.sqlite`, `generated_images/` | `state/opencode/prompt-history.jsonl`, `data/opencode/snapshot/`, `data/opencode/plans/`, `data/opencode/tool-output/` | none beyond sessions |
| `credentials` | `.credentials.json`; escapes: the macOS keychain item, `~/.config/anthropic` | `auth.json`, `.credentials.json`; escape: keyring entries | `data/opencode/auth.json`, `data/opencode/mcp-auth.json` | `auth.json`; upstream `mcp-auth.json` |
| `cache` | `plugins/cache/`, `paste-cache/`, `stats-cache.json`, `cache/` | `models_cache.json`, `cache/`, `.tmp/`, `vendor_imports/` | `cache/opencode/`, `config/opencode/node_modules/` | `bin/`, `tmp/extensions/`, upstream `models-store.json` |
| `runtime` | `sessions/<pid>.json`, `session-env/`, `shell-snapshots/`, `.claude.json.lock/`, `jobs/`, `daemon/` | `app-server-daemon/`, `app-server-control/`, `thread-writer-locks/`, `shell_snapshots/` | `state/opencode/locks/`, `state/opencode/kv.json`; escape `$TMPDIR/opencode` | none found |
| `logs` | `debug/`, `daemon.log` | `log/`, `logs_2.sqlite` | `data/opencode/log/` (newest 10) | `pi-debug.log`, upstream `mcp.log` |

Claude Code versions after 2.1.274 save pasted and attached images outside the config dir, in an `images/` directory per session under the temp directory (`CLAUDE_CODE_TMPDIR`) [CC §1, re-read 2026-10-22]. That is a `history` escape: the descriptor names it, and a consumer that wants attachments reads it before the temp tree is cleared.

### 9.2 The state inventory

`observe --state` lists, per class, the paths present with their size and modification time, plus the escapes with their classes, the value in effect for each `[state]` item with its source (`managed`, `folder`, `system`, `overlay` or `default`; section 5.12), and the harness defaults. `credentials` paths are listed by name, size and mtime only; their content is never read, not even to hash it. The inventory is how a consumer finds everything without parsing any harness's config.

Paths are grouped by the descriptor rule that classed them. A rule lists its paths while it has at most 20 entries, and above that gives totals only: entries, files, bytes, newest mtime. The inventory therefore stays bounded on a folder with thousands of transcripts, which a consumer reads through `sessions.*` anyway. A value in effect that the adapter cannot fully determine names what it could not see under `unverified`, such as Claude Code's server-managed cache, whose format is undocumented. The inventory never follows a symlink. The folder's own settings file is the one link an adapter follows, because the harness reads through it and dotfiles setups point it outside the folder; the item names the target in `from` with `via_symlink`. It is not opened when the target is a credential store (a `credentials` path of the folder, a credential escape, or a credential file name of a surveyed harness) or a transcript, nor when it is not a regular file; the item then reports the folder as its source with `refused` and a null value. A file that fails to parse is reported by path and position only, never with an excerpt, because the excerpt could hold a secret. For Claude Code's default folder, `~/.claude.json` sits beside it, not inside [CC §1]; it is listed with the escapes, stat-ed and never read (added with the v0 build).

### 9.3 The skeleton's own records

Everything the skeleton writes about itself lives under `<harness_path>/.harness-skeleton/`, never inside a harness's own files (OpenCode refuses unknown keys in `opencode.json` [OC §4]):

```
.harness-skeleton/
  lock                     held during apply, recover, remove
  ledger.json              per owner: item, native address, installed digest, previous value
  journal/<apply-id>.jsonl one per apply, kept after it succeeds
  plans/<digest>.json      every applied plan
  receipts/<digest>.json   every receipt an apply ran under
```

These are retained: no operation deletes them, so what was delivered, when, by which owner and under which approval is itself history a consumer can capture. Pruning them is the user's act, outside the protocol.

### 9.4 Rules

1. **Classified.** Every path a harness writes has a class. A path the descriptor does not know is reported as `unknown`, never hidden, and fails certification for that harness version (section 10).
2. **Never destroyed by the skeleton.** No operation moves, rewrites, compacts, truncates or deletes a `sessions`, `history` or `credentials` path (section 7.2). `remove` removes managed items only. The skeleton never deletes a data folder; a tool that does should capture first, and the inventory tells it what is there.
3. **State is not in an overlay.** `overlay` puts generated configuration in a temp dir; the harness's sessions and history still go to the bound data folder, so they outlive the launch. A retention that keeps at least what is in effect is persisted in every mode where the harness has a folder setting for it (section 5.12), so a later start that bypasses the tool does not sweep them early.
4. **Located.** Session locations a harness lets the environment move are pinned or declared (section 8), so a consumer never has to guess where a harness store sits.
5. **Reductions are explicit.** Persistence and retention are install-local items, and a plan lists every value that keeps less than what is in effect (managed, folder or the harness default), plus a managed value that keeps less than the spec asks (section 5.12).
6. **Redacted on the way out.** `sessions` data leaves only through the adapter, already redacted (sessions-model §4). `credentials` never leave.

### 9.5 The database mapping

Where captured session data lands in a database is not the skeleton's: it is **sessions-sql**, a separate, versioned reference (decided 2026-10-22: a separate reference, in a repository of its own). Its v0 draft (agent-realm/sessions-sql) keeps the archive of raw units apart from the derived entity tables, keys every table by the session key, writes revisions forward and keeps removed content as history. ClickHouse is normative; Postgres covers the same logical tables, and the two may be mixed. (What to call each database's form is still open: *dialect* clashes, and *database profile* is proposed.) Classes other than `sessions` (prompt history, memories, checkpoints, settings) are outside sessions-sql v0; they are extracted as files through the path classes here. A mapping for them is later work, and would be a reference of its own.

## 10. Conformance

Tiers stay: 0 static, 1 harness without a model, 2 scripted model, 3 real model.

- **Tier 0** is network-free: marketplaces and plugins come from local directory fixtures, and anything that needs a harness CLI or the network moves to tier 1. It tests the delivery contract, not round-trips:
  - `validate` and `plan` against golden files;
  - `apply` then `observe` shows no drift, and a second `apply` is `unchanged`;
  - unmanaged keys survive, and two owners do not prune each other;
  - an injected crash mid-apply is finished by `recover`;
  - `import` of fixtures is best-effort and reports its losses;
  - every `sessions`, `history` and `credentials` path in the fixture is unchanged after `apply`, `recover` and `remove`: by digest, except `credentials`, which are compared by size and mtime only.
- **Sessions at tier 0** run the adapter-side Conformance lists of sessions-model@v0 and sessions@v0 unchanged, against the session adapters' fixtures (`packages/session-adapters/fixtures/`). Among them:
  - replay: `derive` from empty state equals every incremental split;
  - stable keys, and one harness store giving two sessions under two hosts;
  - the positive controls (`appended` for streams; unchanged earlier keys for delta and snapshot sources) and the negative control (`reset`);
  - `delta` with `known`, complete `live` sets, `unchanged`, held-back units, and the typed errors.

  The skeleton adds no tier 0 sessions check of its own, so the two cannot drift. pi has no fixtures yet.
- **Every negative check has a positive control** in the same run: a denied command is paired with an allowed one that runs, and the session must complete; otherwise the verdict is "inconclusive", not "pass" (pi's JSON mode exits 0 after a model error [PI §17]).
- **The escape snapshot is wider than `$HOME`**: `$TMPDIR` and `/tmp` (OpenCode's temp root, Claude Code's images), `/etc` (Codex's system layer), and on macOS benches the names, never the contents, of keychain items before and after [OC §1, CX §1, CC §1].
- **Every write is classified** (tiers 1 and 2): each path in the snapshot's difference must match a path class in the harness descriptor for that version. An unclassified path fails the run and is reported by path.
- **Inbound-read canaries**: the bench plants skills and instructions in `~/.agents/skills`, `~/.opencode/`, `~/.claude/CLAUDE.md` and an ancestor `AGENTS.md`; the scripted endpoint asserts none of them reached the model. The scan covers the whole request (system prompt, every message, tool definitions), because a harness may carry instructions outside the system prompt: Claude Code delivers `CLAUDE.md` content as a user message after the system prompt [CC §3]. Where it puts the skill list is not documented [CC §9], so the scan assumes no place for it. Each excluded canary is paired with an included one planted in the bound data folder: an absence counts only when the same scan finds the included marker (gentar's refinement, 2026-10-14).
- **Harness-specific tool names** in scripts: `mcp__stub__ping` on Claude Code and Codex, `stub_ping` on OpenCode [OC §8]; pi tier 2 runs with `exposure = "direct"` [PI §8]; Codex tier 2 runs with `workspace-write` [CX §17].
- **Inert detection**: deliver a Codex hook, trust it, edit its script, deliver again; `observe` must report it `inert`.
- **Sessions at tier 2**: a scripted conversation with a tool call and a failing tool, a compaction and a resume, and a fork and a rewind where the harness supports them. `sessions.read` from empty, then `sessions.derive` from empty state, must give exactly the scripted turns, in order:
  - ids stay stable across the resume;
  - every tool call is linked to its result;
  - the compaction summary is linked to the turns it replaced;
  - the fork is linked to its origin.
- **Positive controls for sessions**:
  - a turn appended after a read comes back `appended` on a stream source, or `delta` with the new units and no `gone` on a delta source, so a reader that always answers `reset` fails;
  - a hook that logs its `session_id` resolves to the session `sessions.read` returns.
- **Two hosts**: copy the bench's bound data folder to a second bench, then read both. They give two sessions: every key differs in `host`, and nothing is merged. A position from one host given to the other counts as absent and forces a full read. Two benches that report one `host` fail the check loudly; that is how a clone that kept its parent's machine id shows.
- **Two spellings**: bind the same folder once directly and once through a symlink, then read both; every key must be identical. Where the bench's volume is case-insensitive (APFS or HFS+ on macOS), also bind it through a differently cased spelling. A reader that keys on the spelling it was given fails.
- **Capture survives the launch**: after an `overlay` launch has ended and its temp dir is gone, `sessions.list` and `sessions.read` still return the session.
- **pi stays in the folder**: with `PI_CODING_AGENT_SESSION_DIR` set in the bench's ambient environment to an outside directory, a launch from `launch-spec` writes its session inside the bound data folder, and the outside directory stays empty.
- **Retention holds between launches** (tier 1, on a bench with no managed policy):
  - plant a transcript older than the harness default in two folders;
  - deliver `[state] retention_days` to one of them under `overlay`;
  - start the harness once in each folder **without** the overlay.

  The transcript must survive in the delivered folder, and must be deleted in the control, which proves the sweep ran. *Run 2026-10-22 on a bench with Claude Code 2.1.307 (`conformance/tier1/retention-between-launches.mjs`): pass, the project-short-period folder included; the managed variant is not run yet.* `observe --state` reports the value with source `folder`. With `--no-persist-state`, the plan lists the launch-only notice. A shorter retention delivered under `overlay` is not written to the folder. A second run, with a managed policy file present, checks that `observe` reports source `managed` and that `plan` flags `overridden_by_managed`.
  A third folder gets the same delivered retention, and one launch from a project whose `.claude/settings.json` sets a short period. The planted transcript must be deleted there, which proves the folder's value is not a floor and only managed policy is.
- **Evidence tuples**: harness binary, daemon, OS, driver, bridge, protocol and model versions per result, plus `adapter_ver` and `state_ver` for sessions; certified ranges list tested releases, not inferred ones.
- **The scripted endpoint** keeps the five additions gentar accepted on 2026-10-14:
  - conversations bound to routes by a marker in the first user message (or by order of appearance), so parallel sessions and subagents on one model do not share turns;
  - the turn taken from the request's own history (prior assistant turns, or the stub's map from `previous_response_id`), so a retry gets the same reply;
  - per-harness tool names in scripts;
  - whole-request exclusion scans paired with included canaries;
  - an inconclusive verdict (exit 3) when a negative check lacks its passing control.

## 11. The acceptance scenario

The first end-to-end job every `full` adapter must pass: one environment on a third-party model through a gateway, with two MCP servers (stdio with a secret env var, HTTP with a bearer secret), a required `PreToolUse` guard hook, one skill and an if-supported status line, delivered to Claude Code and to Codex, then read back.

| Step | Claude Code | Codex |
|---|---|---|
| endpoint | `anthropic-messages` entry; `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` at launch; account flags cleared | `openai-responses` entry; `-c model_providers.hs` with `env_key` at launch |
| model roles | `model`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` | `model`, `agents.default_subagent_model` |
| stdio MCP + secret | `env: {DB_PASS: "${HS_REF_DB_PASSWORD}"}` | `env_vars = ["DB_PASS"]`, the launch maps the ref to `DB_PASS` |
| HTTP MCP + bearer | `headers: {Authorization: "Bearer ${HS_REF_SENTRY_TOKEN}"}` | `bearer_token_env_var = "HS_REF_SENTRY_TOKEN"` |
| guard hook | settings `hooks.PreToolUse`, matcher `Bash`, shim | `hooks.json`, matcher `Bash`, shim; readiness `needs-trust` |
| skill | `<harness_path>/skills/<name>/` | skill-only local plugin (tier 1 proves it) |
| status line | settings `statusLine` | skipped (`if-supported`), listed in the plan |
| sessions | `sessions.read` on `projects/<cwd>/<id>.jsonl` (a `stream` source, `byte_offset`), then `sessions.derive`, gives the scripted turns | the same on the rollout JSONL |
| capture | every written path classed; `observe --state` lists the transcript and `history.jsonl` | the same, with `history.jsonl` and the SQLite thread state |
| result | ready | ready after the user approves the hook in `/hooks`, or with a receipt on a certified driver |

## 12. Mapping: Claude Code 2.1.289 and Codex 0.160.0

**mapped**: the item has the same meaning in the harness (native, or a lossless translation). **partial**: lossy, bridged or gated; the note says what is lost. **missing**: refused. Rows keep v0's numbers; row 10 was removed in v0.1, and row 34 is new.

| # | Item | Claude Code | Note | Codex | Note |
|---|---|---|---|---|---|
| 1 | binding | mapped | `CLAUDE_CONFIG_DIR`; escapes listed (keychain item per folder, managed, temp) [CC §1] | partial | `CODEX_HOME`, created first since Codex refuses a missing dir; `~/.agents/skills` and the personal marketplace are shared by every data folder [CX §1] |
| 2 | instructions | mapped | `AGENTS.md` plus a `CLAUDE.md` holding `@AGENTS.md` [CC §3] | mapped | `AGENTS.md`; the project-doc cap is 32 KiB [CX §3] |
| 3 | default model | mapped | `settings.json` `model` [CC §5] | mapped | `config.toml` `model` [CX §5] |
| 4 | effort | partial | `effortLevel`; `max` is not accepted in settings [CC §5] | mapped | `model_reasoning_effort` [CX §5] |
| 5 | model list | mapped | `modelPicker` rows [CC §5] | partial | `model_catalog_json`: the adapter must generate a catalog file [CX §5] |
| 6 | endpoint, `anthropic-messages` | mapped | `ANTHROPIC_BASE_URL` at launch [CC §6] | missing | Responses wire only [CX §6] |
| 7 | endpoint, `openai-responses` | missing | Anthropic wire only [CC §6] | mapped | `[model_providers.<id>]`, `wire_api = "responses"` [CX §6] |
| 8 | endpoint credential | mapped | `ANTHROPIC_AUTH_TOKEN` or `_API_KEY` from the reference at launch [CC §6] | mapped | `env_key` names the variable the tool fills at launch [CX §6] |
| 9 | login `isolated` | mapped | claude.ai OAuth and API keys; the keychain item is keyed to the folder. Console sign-ins without a key live in `~/.config/anthropic` and are shared [CC §7] | mapped | CLI login: `auth.json` in the folder, or a keyring account derived from the canonical `CODEX_HOME`. MCP OAuth tokens are shared (credential-namespace escape) [CX §7] |
| 10 | login `shared` | removed | v0.1 | removed | v0.1 |
| 11 | login `endpoint` | mapped | `CLAUDE_CODE_OAUTH_TOKEN` or an API key from the reference; the store stays empty [CC §7] | mapped | the provider's `env_key` for a custom endpoint; `CODEX_API_KEY` for headless runs on the default provider [CX §6, §7] |
| 12 | login status | mapped | `claude auth status`, exit 0/1, JSON with `configDirectory` [CC §7] | mapped | `codex login status` [CX §7] |
| 13 | MCP stdio | mapped | `claude mcp add-json --scope user` [CC §8] | mapped | `config.toml` written directly when secrets are involved [CX §8] |
| 14 | MCP http | mapped | `type: http` [CC §8] | mapped | streamable HTTP `url` [CX §8] |
| 15 | MCP sse | mapped | `type: sse` [CC §8] | missing | not listed [CX §8] |
| 16 | MCP secrets | mapped | `${VAR}` in `env` and `headers` [CC §8] | mapped | structured refs: `env_vars`, `bearer_token_env_var`, `env_http_headers` [CX §8] |
| 17 | skills | mapped | `<harness_path>/skills/<name>/` [CC §9] | partial | per folder only through the deprecated `$CODEX_HOME/skills`, until the local-plugin route is proven; `~/.agents/skills` is shared by every folder [CX §9] |
| 18 | plugins, `claude-plugin` | mapped | `claude plugin marketplace add`, `claude plugin install` [CC §10] | partial | `codex plugin marketplace add`, `codex plugin add`; plugin `commands/` become skills; which other components load is unverified [CX §10] |
| 19 | hooks, 8 portable events | mapped | `hooks` in `settings.json` [CC §11] | partial | `hooks.json`, same shape; readiness `needs-trust` until the hash is trusted [CX §11] |
| 20 | hooks, `Notification` | mapped | native [CC §11] | missing | no event; `notify` is a different mechanism [CX §11] |
| 21 | permission mode | mapped | `permissions.defaultMode` [CC §12] | partial | `approval_policy` x `sandbox_mode`; `accept-edits` has no exact pair [CX §12] |
| 22 | permission rules, shell | mapped | `Bash(<pattern>)` [CC §12] | partial | Starlark `prefix_rule`: only argv prefixes translate [CX §12] |
| 23 | permission rules, read/edit | mapped | `Read(...)`, `Edit(...)` [CC §12] | partial | profiles have static paths and no `ask` [CX §12] |
| 24 | permission rules, MCP tools | mapped | `mcp__server__tool` [CC §12] | partial | allow and ask by `approval_mode`; deny only as `disabled_tools` [CX §8, §12] |
| 25 | sandbox | partial | Bash, PowerShell and Monitor commands, not file tools or MCP [CC §12] | mapped | `sandbox_mode`, writable roots, network [CX §12] |
| 26 | status line | mapped | `statusLine` command, `refreshInterval` [CC §13] | missing | built-in items only [CX §13] |
| 27 | subagents | mapped | `agents/<name>.md` [CC §14] | partial | `agents/<name>.toml`, body as `developer_instructions`; `tools` does not translate [CX §14] |
| 28 | main agent | mapped | `agent` key [CC §14] | missing | no equivalent [CX §14] |
| 29 | commands | mapped | `commands/<name>.md` [CC §15] | partial | become skills, invoked as `$name`; positional arguments are lost [CX §15] |
| 30 | session env | mapped | settings `env` [CC §4] | partial | `shell_environment_policy.set`: tool subprocesses only [CX §12] |
| 31 | sessions, list and resume | mapped | transcripts under `projects/`, `--resume <id>` from the session's cwd [CC §16] | mapped | `codex resume <id>` [CX §16] |
| 32 | sessions, live | partial | `sessions/<pid>.json`, format undocumented [CC §16] | partial | `codex agents` on the shared daemon; output format unverified [CX §16] |
| 33 | headless launch | mapped | `-p --output-format json` [CC §17] | mapped | `codex exec --json --skip-git-repo-check` [CX §17] |
| 34 | sessions, read (sessions@v0) | mapped | append-only JSONL, `byte_offset`; record `uuid` ids; `reuse` impossible; hook join `yes` per the docs. Readiness `untested`: memhouse 0.20's reader is not yet on the contract (annex, claude-code row) | mapped | append-only rollouts, `byte_offset`; `payload.id`, else `@<offset>`, which is allowed for append-only streams (sessions-model §1 rule 4); hook join untested (annex, codex row) |

Counts over the 33 rows in force: **Claude Code 29 mapped, 3 partial, 1 missing; Codex 15 mapped, 13 partial, 5 missing.** Codex's gaps are the same two whole capabilities (status line, main-agent pin) plus three facets (the Anthropic wire, the `sse` transport, the `Notification` event); Claude Code's one is a facet (the OpenAI wire).

## 13. Decisions recorded

The decisions that shaped this note, by date.

| Date | Decision |
|---|---|
| 2026-10-04 | harness-skeleton is defined: "the standard-ish thing that defines what an agent harness should provide, and how" |
| 2026-10-14 | three outside reviews of v0, which produced v0.1 |
| 2026-10-22 | "harness" is the generic word; "editor" names only a harness with an IDE surface |
| 2026-10-22 | question 9: a sessions-only conformance profile |
| 2026-10-22 | question 10: transcript reads are in scope |
| 2026-10-22 | question 11: the model text stays with the session contracts (sessions-model), outside this note |
| 2026-10-22 | question 12: any implementation that passes conformance counts; memhouse's session readers are the first session adapters |
| 2026-10-22 | state must stay capturable: "it should be easy to extract the state (and history, and other stuff)"; and a reference maps session data to a database, ClickHouse first, Postgres too |
| 2026-10-22 | that database mapping is a separate reference, sessions-sql, in a repository of its own |
| 2026-10-22 | a session belongs to one harness store, and the host is in every key ("different host = different session") |
| 2026-10-22 | keys use the bound folder's real path, `harness_path`, not a label; "harness store" is the prose noun for what `store` identifies |
| 2026-10-22 | license: Apache 2.0, for harness-skeleton and sessions-sql |
| 2026-10-22 | the v0 build starts: `hs`, a reference adapter, built in this repository, one PR per milestone (`build-v0-2026-10-22.md`); the retention default is one constant, 9999, until question 8 is answered |
| 2026-10-22 | the session adapters get one home: a self-contained package in this repository, `packages/session-adapters/` (`@agent-realm/session-adapters`). It holds the one `host` and `harness_path` implementation and imports nothing from `hs` or memhouse; memhouse consumes it, and `hs` wraps it (section 7.3) |
| 2026-10-22 | question 8: the retention default is 9999 days in folders a tool owns |
| 2026-10-23 | the repository is published as a fresh public repository, together with the session contracts and sessions-sql |

## 14. Open questions

1. **The word *spec*.** Instances are *specs* (v0 called them "skeletons"). Keep it? *data folder*, `harness_path` and *harness store* are settled.
2. **MCP in core** for the `full` profile. One reviewer kept it in core with minimum guarantees (stdio, HTTP, direct exposure). Another would make it a capability that tools require through bundles, which keeps pi 0.80.2 usable. The sessions-only profile already shows a core can be small. v0.2 keeps MCP in core until this is decided.
3. **Registration**: whether the standard is registered with the projects that compose it, as an external seam providing `harness-skeleton v0` (recommended, unchanged).
4. **The reference implementation.** The protocol is the contract, and any conforming implementation counts (question 12). Still open: does this repo ship one reference binary (`hs`) with per-harness drivers, and do the drivers live here (`adapters/<harness>/`) until v1? This is what is left of questions 4 and 6. Since 2026-10-22 `hs` is being built here (section 13, `build-v0-2026-10-22.md`), and the session adapters have their home here too, as their own package (section 7.3). Whether `hs` stays the reference after v0, and where its drivers live from v1, is still open.
5. **Project scope**: the reviewers proposed to observe project and managed layers now and never write them in v0.x. Agree?
6. **Default delivery mode** for the first tool: `overlay` where possible, `materialize` otherwise?
7. **Strict isolation**: should a spec be able to demand it, refusing Codex and pi while `~/.agents/skills` cannot be closed? Or is a declared escape enough?
8. **Retention when a spec sets none.** *Decided 2026-10-22: 9999 in folders a tool owns, as recommended (section 13).* By default Claude Code deletes transcripts after 30 days, without a message (section 5.12). A user who wants long retention can set it per folder, or host-wide with a managed settings file (section 5.12). The question is the skeleton's default when a spec has no `retention_days`. Should it deliver a long retention in folders a tool owns (`materialize`): 9999, where the docs' own example is 3650? Or should it leave what is in effect and report it? Recommendation: 9999 in tool-owned folders. In folders the tool does not own (`reconcile`, and `overlay` on a folder the user owns), the skeleton changes nothing unless the spec asks, and reports the value in effect and its source.
