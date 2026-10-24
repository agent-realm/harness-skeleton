# Harness survey: Claude Code (Anthropic)

| Field | Value |
|---|---|
| Harness | Claude Code CLI (`claude`), Anthropic |
| Version surveyed | **2.1.289** (released 2026-10-03), local native install, `claude --version` = `2.1.289 (Claude Code)` |
| Upstream at survey time | 2.1.289 is the newest entry in the docs changelog [D-cl] |
| Survey date | 2026-10-04 |
| Mode | read-only: no session started, no login, no config change; only `--help` / `--version`; names under config dirs listed; no credential file or keychain secret read |
| Primary sources | Anthropic docs at `code.claude.com/docs/en/*` (raw `.md`), agentskills.io |
| Secondary source | cpb (claude-playbook) v4 spec, `SPEC.md` in [github.com/ramazanpolat/claude-playbooks](https://github.com/ramazanpolat/claude-playbooks) (observed behaviour on 2.1.233 to 2.1.283) |

## Sources and citation keys

Convention: `D-*` keys are **documented** (Anthropic docs). `L-*` keys are **observed** on a macOS workstation with Claude Code 2.1.289. `cpb §X` is **observed** behaviour recorded by cpb (secondary). Every `D-*` URL was fetched 2026-10-04 as raw markdown (`<url>.md`).

| Key | Source |
|---|---|
| [D-dir] | https://code.claude.com/docs/en/claude-directory (fetched 2026-10-04; re-read 2026-10-22 for the cleanup sweep in §16 and the image location in §1) |
| [D-settings] | https://code.claude.com/docs/en/settings (fetched 2026-10-04) |
| [D-sref] | https://code.claude.com/docs/en/settings-reference (fetched 2026-10-04; re-read 2026-10-22 for `cleanupPeriodDays` in §16) |
| [D-managed] | https://code.claude.com/docs/en/managed-settings (fetched 2026-10-04) |
| [D-mem] | https://code.claude.com/docs/en/memory (fetched 2026-10-04; re-read 2026-10-22 for the delivery line in §3) |
| [D-auth] | https://code.claude.com/docs/en/authentication (fetched 2026-10-04) |
| [D-ti] | https://code.claude.com/docs/en/troubleshoot-install (fetched 2026-10-04) |
| [D-env] | https://code.claude.com/docs/en/env-vars (fetched 2026-10-04) |
| [D-model] | https://code.claude.com/docs/en/model-config (fetched 2026-10-04) |
| [D-gw] | https://code.claude.com/docs/en/llm-gateway-connect (fetched 2026-10-04); overview https://code.claude.com/docs/en/llm-gateway |
| [D-mcp] | https://code.claude.com/docs/en/mcp (fetched 2026-10-04) |
| [D-skills] | https://code.claude.com/docs/en/skills (fetched 2026-10-04; re-read 2026-10-22 for the listing line in §9) |
| [D-plug] | https://code.claude.com/docs/en/plugins/manifest-reference, /plugins/loading, /plugins/install, /plugins/components, /plugins/marketplace-reference (all fetched 2026-10-04) |
| [D-hooks] | https://code.claude.com/docs/en/hooks (fetched 2026-10-04) |
| [D-perm] | https://code.claude.com/docs/en/permissions (fetched 2026-10-04) |
| [D-sbx] | https://code.claude.com/docs/en/sandboxing (fetched 2026-10-04) |
| [D-sl] | https://code.claude.com/docs/en/statusline (fetched 2026-10-04) |
| [D-sub] | https://code.claude.com/docs/en/sub-agents (fetched 2026-10-04) |
| [D-cmd] | https://code.claude.com/docs/en/commands (fetched 2026-10-04) |
| [D-sess] | https://code.claude.com/docs/en/sessions (fetched 2026-10-04) |
| [D-av] | https://code.claude.com/docs/en/agent-view (fetched 2026-10-04) |
| [D-hl] | https://code.claude.com/docs/en/headless (fetched 2026-10-04) |
| [D-cli] | https://code.claude.com/docs/en/cli-reference (fetched 2026-10-04) |
| [D-sdk] | https://code.claude.com/docs/en/agent-sdk/claude-code-features and /agent-sdk/overview (fetched 2026-10-04) |
| [D-os] | https://code.claude.com/docs/en/output-styles (fetched 2026-10-04) |
| [D-kb] | https://code.claude.com/docs/en/keybindings (fetched 2026-10-04) |
| [D-mon] | https://code.claude.com/docs/en/monitoring-usage (fetched 2026-10-04) |
| [D-setup] | https://code.claude.com/docs/en/setup (fetched 2026-10-04) |
| [D-cl] | https://code.claude.com/docs/en/changelog (fetched 2026-10-04; generated from github.com/anthropics/claude-code CHANGELOG.md) |
| [AS-spec] | https://agentskills.io/specification (fetched 2026-10-04) |
| [AS-client] | https://agentskills.io/client-implementation/adding-skills-support (fetched 2026-10-04) |
| [L-help] | local: `claude --help`, `claude <sub> --help`, `claude <sub> help <cmd>` @2.1.289 |
| [L-fs] | local: entry names under `~/.claude`, `$HOME`, and a `$CLAUDE_CONFIG_DIR` other than the default; keychain item **existence** via `security find-generic-password -s <name>` with output discarded (exit code only) |
| [B-overlay] | bench: `conformance/tier1/overlay-env-precedence.mjs` @2.1.307 on Linux, 2026-10-24; report in `conformance/results/claude-code-2.1.307-overlay-env-precedence-2026-10-24-10_02.json` |
| [B-hooks-persisted] | bench: `conformance/tier1/hooks-persisted.mjs` @2.1.307 on Linux, 2026-10-24; report in `conformance/results/claude-code-2.1.307-hooks-persisted-2026-10-24-10_02.json` |
| [B-hooks] | bench: `conformance/tier1/hooks-at-launch.mjs` @2.1.307 on Linux, 2026-10-24; report in `conformance/results/claude-code-2.1.307-hooks-at-launch-2026-10-24-10_02.json` |
| [B-mcp-persisted] | bench: `conformance/tier1/mcp-persisted.mjs` @2.1.307 on Linux, 2026-10-24; report in `conformance/results/claude-code-2.1.307-mcp-persisted-2026-10-24-10_02.json` |
| [B-mcp] | bench: `conformance/tier1/mcp-at-launch.mjs` @2.1.307 on Linux, 2026-10-24; report in `conformance/results/claude-code-2.1.307-mcp-at-launch-2026-10-24-10_02.json` |
| [B-skills] | bench: `conformance/tier1/skills-at-launch.mjs` @2.1.307 on Linux, 2026-10-24; report in `conformance/results/claude-code-2.1.307-skills-at-launch-2026-10-24-10_02.json` |
| [B-account] | bench: `conformance/tier1/account-state.mjs` @2.1.307 on Linux, 2026-10-24; report in `conformance/results/claude-code-2.1.307-account-state-2026-10-24-10_02.json` |
| cpb §X | `SPEC.md` in github.com/ramazanpolat/claude-playbooks, section X |

## 1. Config root

**Location.** Default `~/.claude` (`%USERPROFILE%\.claude` on Windows). `CLAUDE_CONFIG_DIR` overrides it: "All settings, session history, and plugins are stored under this path" [D-env]; "every `~/.claude` path on this page lives under that directory instead" [D-dir]. It can be set in the shell, user settings or managed settings, and is ignored in project/local settings `env` (since 2.1.251) [D-env][D-sref env][D-cl 2.1.251]. The Agent SDK multi-tenant guidance says `~/.claude.json` is "always read" and is relocated with `CLAUDE_CONFIG_DIR` [D-sdk].

**`.claude.json` placement (the asymmetry).**
- Documented as `~/.claude.json`: a *sibling* of `~/.claude/`, in `$HOME` [D-settings][D-dir]. Holds sign-in session/account, MCP servers (user and local scope), per-project state (trust, history), and "global config" keys that `/config` writes [D-settings][D-sref §Global config].
- Observed: with `CLAUDE_CONFIG_DIR=<a folder>` the file is `$CLAUDE_CONFIG_DIR/.claude.json`, i.e. *inside* the dir [L-fs]; cpb treats it as per-config-dir state and reads user-scope MCP servers from it [cpb §MCP servers][cpb §Caller-supplied config directory].
- Observed: `~/.claude.json` in `$HOME` and a `~/.claude/.claude.json` can both exist [L-fs]; the second is consistent with a launch that set `CLAUDE_CONFIG_DIR=~/.claude` explicitly (inference, not verified).
- Observed side files: `.claude.json.lock/` (directory), `.claude.json.tmp.<pid>.<hex>` (atomic-rename temps) [L-fs]; documented: `backups/` keeps the five newest earlier versions plus any unparseable one [D-dir].

**What lives in the config root** (paths relative to `~/.claude` or `$CLAUDE_CONFIG_DIR`):

| Path | Contents | Source |
|---|---|---|
| `settings.json` | user-scope settings | [D-settings] |
| `settings.local.json` | local scope; read only in sessions started in the config home itself, not globally | [D-perm §When your local settings file needs trust]; present in `~/.claude` [L-fs] |
| `CLAUDE.md`, `rules/*.md` | user instructions and user rules | [D-mem] |
| `skills/<name>/SKILL.md`, `skills/synced/`, `skills/.trash/` | personal skills; claude.ai-synced skills | [D-skills][D-dir] |
| `commands/*.md`, `agents/*.md`, `output-styles/*.md`, `workflows/*.js`, `themes/*.json` | user-scope components | [D-dir] |
| `agent-memory/<agent>/` | user-scope subagent memory | [D-dir][D-sub] |
| `keybindings.json` | key bindings (global only) | [D-kb] |
| `plugins/` (`cache/`, `data/`, `marketplaces/`, `synced/`, `.trash/`, `installed_plugins.json`, `known_marketplaces.json`, `flagged-plugins.json`) | plugin root; movable with `CLAUDE_CODE_PLUGIN_CACHE_DIR` | [D-plug loading §Find plugins on disk]; names confirmed [L-fs] |
| `projects/<encoded-cwd>/<session-id>.jsonl`, `<session-id>/subagents/`, `<session-id>/tool-results/`, `memory/` | transcripts, subagent transcripts, spilled tool output, auto memory | [D-dir][D-sess] |
| `sessions/<pid>.json` | one file per running process; removed on exit | [D-dir]; format undocumented, observed by cpb [cpb §SHOW SESSIONS] |
| `sessions/<pid>.<64-hex>.key` | sibling per-session files, purpose not found in docs | observed [L-fs] |
| `history.jsonl` | every typed prompt with timestamp and project path | [D-dir] |
| `file-history/<session>/`, `plans/`, `debug/`, `paste-cache/`, `uploads/`, `session-env/`, `tasks/`, `shell-snapshots/`, `backups/`, `feedback/`, `usage-data/`, `dev-mods/` | app data, swept after `cleanupPeriodDays` | [D-dir §Cleaned up automatically] |
| `stats-cache.json`, `remote-settings.json`, `cache/changelog.md`, `policy-limits.json` (+ `.stamp.json`) | caches kept until deleted (remote-settings and policy-limits deleted on logout) | [D-dir §Kept until you delete them] |
| `jobs/<id>/`, `daemon/roster.json`, `daemon.log` | background-session supervisor state; with `CLAUDE_CONFIG_DIR` the supervisor is a separate instance | [D-av §Where state is stored] |
| `.credentials.json` | login store on Linux/Windows; macOS fallback | [D-auth §Credential management] |
| `todos/`, `statsig/`, `logs/`, `image-cache/` | legacy, no longer written | [D-dir] |

Observed extra names in a non-default folder, not in the tables above: `chrome/`, `channels/` (also in `~/.claude`), `cache/model-catalog`, `daemon.status.json`, `daemon.lock` [L-fs]. A folder that another tool also writes (a playbook manager, say) holds that tool's names too.

**Does `CLAUDE_CONFIG_DIR` relocate everything?** No. It relocates user-scope config, state, plugins, transcripts, the `.credentials.json` store, and re-keys the macOS keychain item [D-env][D-auth]. What escapes it:

| Escapes | Where | Source |
|---|---|---|
| macOS keychain item | the user's login keychain (one namespace; item name varies per dir, see §7) | [D-auth]; [L-fs] |
| Managed policy | `/Library/Application Support/ClaudeCode/` (macOS), `/etc/claude-code/` (Linux/WSL), `C:\Program Files\ClaudeCode\` (Windows); plist domain `com.anthropic.claudecode`; HKLM/HKCU `SOFTWARE\Policies\ClaudeCode` | [D-managed] |
| Project config | `.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.worktreeinclude` in the repo | [D-dir] |
| Temp tree | `/private/tmp/claude-<uid>/<project>/<session>/scratchpad/` (macOS), pasted images; moved by `CLAUDE_CODE_TMPDIR`. Images: versions after 2.1.274 save pasted and attached images "outside `~/.claude`, in an `images/` directory for each session under the temp directory that `CLAUDE_CODE_TMPDIR` controls"; `image-cache/<session>/` holds only those of 2.1.274 and earlier (re-read 2026-10-22) | [D-dir §Session scratchpad directory, §Cleaned up automatically] |
| Anthropic profiles / WIF | `~/.config/anthropic` (`ANTHROPIC_CONFIG_DIR`); a Console sign-in without an API key is stored there, so separate config dirs do not keep two such sign-ins apart | [D-auth §Log in with multiple accounts, §Anthropic profiles] |
| Install | `~/.local/bin/claude` -> `~/.local/share/claude/versions/` | [D-setup] |
| Git global excludes | Claude Code adds `settings.local.json` to the user's global git excludes on first write | [D-settings] |
| Long-lived token file | `~/.config/claude-code/oauth-token` is a cpb convention, not a Claude Code path (not found in docs) | [cpb §Authentication preparation] |

`CLAUDE_CODE_PROJECT_DIR_NAME` (2.1.234+, launch env only, honoured only with `CLAUDE_CONFIG_DIR`) pins the `projects/<name>/` directory regardless of cwd [D-sess][D-env]. `claude auth status` JSON carries `configDirectory` (2.1.268+), the only documented probe of the effective config dir [D-cli].

## 2. Scopes and precedence

| Rank (high to low) | Scope | Where | Notes | Source |
|---|---|---|---|---|
| 1 | Managed | server-managed (claude.ai console or Claude apps gateway; cached in `remote-settings.json`) > MDM plist / HKLM > `managed-settings.json` + `managed-settings.d/*.json` (merged) > HKCU | default `managedSourcesBehavior: "first-wins"` (one source used); `"merge"` (2.1.242+) composes them. Server-managed fetched only for direct Anthropic API with an eligible login/key, never when `ANTHROPIC_BASE_URL` points elsewhere. `policyHelper` can compute policy | [D-managed] |
| 2 | Command line | `--settings <file-or-json>`, key flags (`--model`, `--permission-mode`, `--effort`, `--allowedTools` ...) | one session only | [D-settings][L-help] |
| 3 | Local | `.claude/settings.local.json` | written at the git repo root (2.1.211+), main checkout for worktrees | [D-settings] |
| 4 | Project | `.claude/settings.json` | read from the session's primary working directory | [D-settings] |
| 5 | User | `~/.claude/settings.json` | | [D-settings] |

Merge rules [D-settings §Lists merge instead of overriding]:
- Scalars: highest level wins. `--settings` merges like a level (keys it omits fall through).
- Arrays merge (e.g. `permissions.allow`), except `fallbackModel` (whole value from highest), `modelPicker` (whole value from managed, `--settings` or user only; ignored in project/local), `availableModels` (a managed list replaces), `modelSettings` (resolved per model).
- Hooks merge across levels; identical handlers in several files run once [D-hooks].
- Permission rules: a deny at any level wins; evaluation order deny > ask > allow [D-perm].
- Environment variables are not a level: precedence is decided per variable/key pair (`ANTHROPIC_MODEL` beats `model`; `ANTHROPIC_DEFAULT_MODEL` only when no file sets `model`) [D-settings][D-env §Precedence].
- Some keys only count from certain scopes ("User or managed", "Managed", "Global config" in the index) [D-sref §Settings index]. Exceptions where a stricter lower-level value beats managed: `disableClaudeAiConnectors`, `enableArtifact`/`disableArtifact`, `isolatePeerMachines`, `remoteControlAtStartup`, `crossSessionInbound`, `useAutoModeDuringPlan`, `syncClaudeAiSkills`, `syncClaudeAiPlugins`, `maxEffortLevel` [D-settings §Exceptions].
- Workspace trust gates project-supplied `permissions.allow`, `additionalDirectories`, `extraKnownMarketplaces`, most `env`, project hooks, `apiKeyHelper`; deny/ask apply immediately [D-settings][D-perm §What runs before you trust a folder].
- `--setting-sources user,project,local` selects file sources; `--bare`, `--safe-mode`, `--restricted` cut sources further (managed always applies) [L-help].

## 3. Instructions

| Scope | Location | Source |
|---|---|---|
| Managed | `/Library/Application Support/ClaudeCode/CLAUDE.md`, `/etc/claude-code/CLAUDE.md`, `C:\Program Files\ClaudeCode\CLAUDE.md`; or managed `claudeMd` settings key (string) | [D-mem][D-sref claudeMd] |
| User | `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md` | [D-mem] |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md`, `.claude/rules/**/*.md` | [D-mem] |
| Local | `./CLAUDE.local.md` (gitignore it yourself) | [D-mem] |

- Load: every `CLAUDE.md` / `CLAUDE.local.md` from cwd up to filesystem root at launch, concatenated root-first; `CLAUDE.local.md` after `CLAUDE.md` per directory; subdirectory files load on demand when Claude reads files there [D-mem §How CLAUDE.md files load].
- Delivery: "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself" [D-mem §Claude isn't following my CLAUDE.md] (re-read 2026-10-22).
- `@path` imports: relative to the importing file, absolute allowed, recursive with **max depth four hops**; skipped inside code spans/fences; external imports need a one-time approval; block HTML comments stripped [D-mem §Import additional files].
- Rules: `.claude/rules/` discovered recursively; `paths:` frontmatter makes a rule load only when matching files are touched; user rules load before project rules [D-mem].
- `claudeMdExcludes` (globs on absolute paths, arrays merge, managed files cannot be excluded) [D-mem].
- Size: a CLAUDE.md up to 4 MiB loads in full, larger is skipped [D-mem §How it works].
- `--add-dir` directories load their CLAUDE.md only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` [D-mem].
- **AGENTS.md: read natively since v2.1.277** (extended to Bedrock/Vertex/Foundry/gateways/telemetry-off in 2.1.281) [D-mem §AGENTS.md][D-cl 2.1.281]. Default `claude-md-or-agents-md`: `AGENTS.md` and `.claude/AGENTS.md` (cwd and ancestors, plus subdirectories on demand) are read **only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in cwd or above**; `~/.claude/CLAUDE.md`, managed CLAUDE.md and rules do not count against it. Other values: `claude-md-and-agents-md`, `claude-md`, `managed-only`. Set via `/config` "Project instructions" or `pluginConfigs["agents-md@builtin"].options.instructionFiles` in user/`--settings`/managed (ignored in project/local). Not read: `AGENTS.local.md`, `AGENTS.override.md`, anything under `.agents/`. `InstructionsLoaded` hooks do not fire for it [D-mem].
- Documented workaround where native support is unavailable (older versions, `agents-md` built-in plugin disabled, first session after upgrade): `@AGENTS.md` in a `CLAUDE.md`, or `ln -s AGENTS.md CLAUDE.md` (Edit/Write refuse to write through the symlink; avoid on Windows) [D-mem §Share one file with other coding tools].
- System prompt flags: `--system-prompt`, `--append-system-prompt` (and `-file` forms), `--system-prompt-snapshot on|off`, `--exclude-dynamic-system-prompt-sections` [L-help]. Kill switches: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `--bare` [D-env][L-help].
- Migration: `/init` reads Cursor/Copilot rules (and AGENTS.md with `CLAUDE_CODE_NEW_INIT=1`); `/import` and `claude import [codex|gemini|cursor]` copy instructions, MCP servers, commands, subagents, skills [D-mem][L-help].

## 4. Settings file

- Format: strict JSON (`//` comments and trailing commas are errors). Schema: `"$schema": "https://json.schemastore.org/claude-code-settings.json"` (may lag releases) [D-settings §Edit a settings file].
- Reloaded on change mid-session (permissions, hooks, `apiKeyHelper`, `env` ...); `model` and `effortLevel`/`modelSettings` are read at start only; `ConfigChange` hook fires per file change [D-settings §When edits take effect].
- Invalid files: interactive shows a Settings Error; `-p` silently ignores files that fail validation [L-help -p].
- The settings index lists 243 keys with a scope class each (`Any file`, `User, local, or managed`, `User or managed`, `Managed`, `Global config`) [D-sref §Settings index].

Notable keys [D-sref]:

| Key | Scope | Purpose |
|---|---|---|
| `model`, `fallbackModel`, `availableModels`, `modelOverrides`, `modelSettings`, `effortLevel`, `maxEffortLevel` | Any file | model selection and effort |
| `modelPicker` | User or managed | `/model` rows `{options:[{model,label,description,behavesAs}], replaceBuiltInOptions}` (2.1.242+; `behavesAs` 2.1.257+) |
| `env` | Any file (blocklist for project/local) | env for the session and subprocesses |
| `permissions.{allow,ask,deny,defaultMode,additionalDirectories,disableBypassPermissionsMode,blockReadsOutsideWorkingDirectories}` | Any file | tool permissions |
| `hooks`, `disableAllHooks`, `allowedHttpHookUrls`, `httpHookAllowedEnvVars` | Any file | hooks |
| `statusLine`, `subagentStatusLine` | Any file | status line commands |
| `outputStyle` | Any file | output style name |
| `agent` | Any file | run the main thread as a named subagent |
| `enabledPlugins`, `extraKnownMarketplaces` | Any file | plugins (`name@marketplace` -> bool), marketplace registration |
| `pluginConfigs` | User or managed | plugin options (incl. `agents-md@builtin`) |
| `apiKeyHelper`, `otelHeadersHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh` | Any file | credential helpers |
| `forceLoginMethod` (`claudeai`/`console`/`gateway`), `forceLoginOrgUUID` | Any file (`gateway` managed only) | login restriction |
| `sandbox.*` | mostly Any file | bash sandbox |
| `cleanupPeriodDays` (default 30, min 1) | Any file | retention |
| `autoMemoryEnabled`, `autoMemoryDirectory`, `claudeMdExcludes`, `plansDirectory` | Any file | memory/context |
| `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `allowedMcpServers`, `deniedMcpServers` | Any file | MCP approval and allow/deny |
| `attribution.*`, `includeCoAuthoredBy`, `includeGitInstructions` | Any file | git attribution |
| `worktree.*`, `teammateMode`, `processWrapper` | various | sessions/worktrees |
| `allowManaged*Only`, `strictKnownMarketplaces`, `blockedMarketplaces`, `strictPluginOnlyCustomization`, `managedMcpServers`, `policyHelper`, `requiredMinimumVersion` | Managed | org locks |

Global config keys live only in `.claude.json` (ignored in settings files): `autoConnectIde`, `autoInstallIdeExtension`, `claudeInChromeDefaultEnabled`, `copyFullResponse`, `copyOnSelect`, `defaultToAgentsView`, `diffTool`, `externalEditorContext`, `leftArrowOpensAgents`, `permissionExplainerEnabled`, `prStatusFooterEnabled`, `teammateDefaultModel` [D-sref §Global config settings]. A plugin's own `settings.json` may set only `agent` and `subagentStatusLine` [D-plug manifest §Standard layout].

## 5. Model

- Priority (high to low): `/model` in session > `--model` > `ANTHROPIC_MODEL` > `model` setting > `ANTHROPIC_DEFAULT_MODEL` (2.1.236+) [D-model §Setting your model]. A managed `model` sets the start model only; `availableModels` is the lock and also filters `--model` [D-settings §Settings precedence].
- `/model` writes `model` to **user** settings on Enter; `s` in the picker switches for the session only; in `-p` it is session-only [D-model]. Resumed sessions keep the transcript's model unless `--model`/`ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL` are given [D-model].
- Aliases: `default`, `best`, `fable`, `opus`, `sonnet`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`; resolution differs by provider (e.g. `sonnet` = Sonnet 5.5 on Anthropic API, Sonnet 4.5 on Bedrock/Vertex) [D-model §Model aliases].
- Alias pins: `ANTHROPIC_DEFAULT_FABLE_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` (also background work); `ANTHROPIC_SMALL_FAST_MODEL` deprecated [D-model §Environment variables].
- Subagents: `CLAUDE_CODE_SUBAGENT_MODEL` is the default for subagents/teammates/workflow agents; a per-invocation model or a definition's `model` (incl. `inherit`) wins [D-env][D-model].
- Picker customisation: `modelPicker` (user/managed/`--settings` only), `ANTHROPIC_CUSTOM_MODEL_OPTION` (+ `_NAME`, `_DESCRIPTION`, no validation), gateway discovery via `/v1/models` with `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` [D-model §Add a custom model option][D-gw].
- Fallback: `--fallback-model <list>`, `fallbackModel` [L-help][D-sref].
- Effort: levels `low`, `medium`, `high`, `xhigh`, `max` (model-dependent). Resolution: `CLAUDE_CODE_EFFORT_LEVEL` / `--effort` / `/effort` > saved per-model level or `effortLevel` > model default (`medium` on Opus 5.5 / Sonnet 5.5). `max` not accepted in settings keys; `maxEffortLevel` caps; skill/subagent frontmatter `effort` overrides the session level [D-model §Adjust effort level].
- cpb observation: `model` in a config dir's `settings.json` is the lowest-priority choice there; no CLI writes it [cpb §Status line and model].

## 6. Endpoint / provider routing

| Mechanism | Behaviour | Source |
|---|---|---|
| `ANTHROPIC_BASE_URL` | route to a proxy/gateway. Side effects at a non-first-party host: MCP tool search off by default, Remote Control disabled (2.1.196+), server-managed settings not fetched, 1M context used where the model has it (2.1.285) | [D-env][D-managed][D-cl 2.1.285] |
| `ANTHROPIC_AUTH_TOKEN` | sent as `Authorization: Bearer <value>` | [D-env][D-gw] |
| `ANTHROPIC_API_KEY` | sent as `X-Api-Key`; interactive approval once, always used in `-p` | [D-auth][D-env] |
| `apiKeyHelper` (setting) | shell command; output sent as both `X-Api-Key` and `Authorization: Bearer`; cached 5 min (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`), rerun on 401/403 and expired JWT | [D-sref apiKeyHelper] |
| `ANTHROPIC_CUSTOM_HEADERS` | `Name: Value` lines (newline-separated; `\n` in JSON) | [D-env][D-gw §Send additional headers] |
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_ANTHROPIC_AWS` | cloud providers; per-provider vars (`ANTHROPIC_BEDROCK_BASE_URL`, `AWS_BEARER_TOKEN_BEDROCK`, `CLAUDE_CODE_SKIP_BEDROCK_AUTH`, `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_API_KEY`); `/setup-bedrock`, `/setup-vertex` wizards write `settings.json` in the config dir | [D-env][D-auth] |
| Claude apps gateway | self-hosted IdP gateway, `forceLoginMethod: "gateway"` / `forceLoginGatewayUrl` (managed) outranks every other credential | [D-auth §Authentication precedence] |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` | embedding host owns routing; settings-file provider/endpoint/auth vars ignored | [D-env] |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | stops update checks, telemetry, release notes etc. outside the gateway path | [D-gw §Turn off traffic outside the gateway path] |

Gateway docs: any gateway exposing a supported API format works; Anthropic does not support routing to non-Claude models [D-gw overview]. Setting the URL and credential in a settings-file `env` block is the documented persistent form [D-gw].

Observed on a bench [B-account], 2026-10-22, @2.1.307, with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` pointing at a local listener and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: a fresh config dir held none of the account state keys below after two starts. With a dummy `oauthAccount` planted, the requests' `metadata.user_id` carried `account_uuid: ""`, and neither the planted account ids nor the email reached the listener. Claude Code started from a `.claude.json` with those keys removed.

Observed (cpb): Claude Code enables claude.ai-hosted tools (Artifact and friends) from cached account flags in `.claude.json` (`oauthAccount`, `cachedGrowthBookFeatures`, ...) regardless of `ANTHROPIC_BASE_URL`; since 2.1.265 the Artifact tool schema is rejected by at least one third-party backend (GLM, 400/1210), so cpb purges that state for isolated playbooks without a login [cpb §Authentication preparation].

## 7. Login / auth

Methods: claude.ai subscription OAuth (`/login`, `claude auth login [--claudeai|--console|--sso|--email]`), Console (API key, or since 2.1.242 an Anthropic profile without a key), long-lived token, API key, cloud providers, WIF/profiles, gateway [D-auth][L-help auth].

Precedence [D-auth §Authentication precedence]: (gateway session) > 1 cloud provider vars > 2 `ANTHROPIC_AUTH_TOKEN` > 3 `ANTHROPIC_API_KEY` > 4 `apiKeyHelper` > 5 `CLAUDE_CODE_OAUTH_TOKEN` > 6 Anthropic profile / federation (named or federation vars) > 7 `/login` subscription OAuth.

Observed on a bench [B-overlay], 2026-10-22, @2.1.307:
- With both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` set and `ANTHROPIC_BASE_URL` pointing at a gateway, each request carried both: `Authorization: Bearer` with the token and `x-api-key` with the key. A token in the environment therefore reaches a gateway even when the key is the one meant for it.
- With `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_BEDROCK_BASE_URL` and `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`, the requests went to the Bedrock base URL (`GET /inference-profiles`, then `POST /model/<id>/invoke-with-response-stream`), and still carried the shell's `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer`.
- A settings `env` value beat the shell for `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_BEDROCK`, and a `--settings` overlay's `env` beat the folder's settings `env` for both; `""` in the overlay cancelled `CLAUDE_CODE_USE_BEDROCK` (§2, §19).

Long-lived token: `claude setup-token` runs the browser flow and **prints** a one-year token without saving it; use it as `CLAUDE_CODE_OAUTH_TOKEN`; model requests only (no Remote Control, no claude.ai connectors); not read in `--bare` [D-auth §Generate a long-lived token].

Storage [D-auth §Credential management][D-ti]:
- macOS: login Keychain; when the write is rejected (locked keychain over SSH), fallback to plaintext `~/.claude/.credentials.json` (0600).
- Linux: `~/.claude/.credentials.json` (0600). Windows: `%USERPROFILE%\.claude\.credentials.json`.
- With `CLAUDE_CONFIG_DIR`: the file lives under that dir, and **the keychain entry is keyed to that directory** (documented).
- The store also holds MCP OAuth logins and plugin sensitive values (`/logout` wipes them) [D-ti].
- Observed naming (undocumented): the default dir's item is `Claude Code-credentials`; for a `CLAUDE_CONFIG_DIR` other than the default the item is `Claude Code-credentials-<8 hex>`, where the 8 hex digits are the first 8 of the SHA-256 of the dir string as given (checked by computing the hash for a folder and asking for the item by name, existence only) [L-fs]. Consequence (inference, untested): two spellings of one dir (symlink, trailing slash) would key different items.
- Observed: on macOS a `.credentials.json` can exist in the folder beside the keychain items [L-fs]; cpb links playbooks to it.

Isolation by config dir:
- Documented: "Each directory has its own settings, session history, and claude.ai login or API key" (alias `CLAUDE_CONFIG_DIR=~/.claude-work claude`); exception: Console sign-ins without an API key are stored outside the config dir [D-auth §Log in with multiple accounts].
- Observed (cpb): a fresh config dir is logged out; cpb shares login by symlinking `<dir>/.credentials.json` -> `~/.claude/.credentials.json`; Claude Code writes the store by rename, so a refresh or `/login` in a shared dir can replace the link with a regular file; under token auth Claude Code never refreshes a stored grant and its 401 recovery adopts a differing stored `accessToken` over the env token, hence cpb quarantines the stored `claudeAiOauth` grant on the token path [cpb §Isolated login][cpb §Authentication preparation].
- `claude auth status` exits 0 if logged in, 1 if not; JSON by default (`--text` for human) [D-cli][L-help].
- Restrictions: `forceLoginMethod`, `forceLoginOrgUUID`, managed `allowedProviders` [D-sref][D-auth].

## 8. MCP servers

| Scope | Loads in | Stored in | Source |
|---|---|---|---|
| local (default for `claude mcp add`) | current project only | `.claude.json` under `projects["<abs path>"].mcpServers` | [D-mcp §Local scope] |
| project | current project, shared | `.mcp.json` at project root (approval prompt per server in interactive sessions; auto-loaded in `-p`/SDK) | [D-mcp §Project scope] |
| user | all projects | `.claude.json` top-level `mcpServers` (observed: `$CLAUDE_CONFIG_DIR/.claude.json`) | [D-mcp §User scope][cpb §MCP servers] |
| plugin | where enabled | plugin `.mcp.json` or `plugin.json` `mcpServers` | [D-plug] |
| claude.ai connectors | claude.ai login sessions | remote | [D-mcp] |
| managed | everyone | `managed-mcp.json` (exclusive control) or `managedMcpServers` key (2.1.259+, ranks above all) | [D-managed][D-mcp] |

- **Measured** [B-mcp-persisted]: a server in `$CLAUDE_CONFIG_DIR/.claude.json` top-level `mcpServers` loads in `-p` without an approval prompt, and its tool reaches the request; a remote one gets its literal headers (2.1.307, 2026-10-23).
- Precedence on duplicates: local > project > user > plugin > connectors; whole entry from the winner, **no field merge**; plugins/connectors deduplicated by endpoint [D-mcp §Scope hierarchy and precedence].
- Transports: stdio, `sse`, `http`; WebSocket via `add-json` [L-help mcp add/add-json][D-mcp].
- Server fields: `type`, `command`, `args`, `env`, `url`, `headers`, `headersHelper` (dynamic headers command), OAuth client settings, `alwaysLoad` [D-mcp][D-cl 2.1.287].
- `${VAR}` and `${VAR:-default}` expansion in `command`, `args`, `env`, `url`, `headers` (documented for `.mcp.json`; cpb verified `env` and `headers` in user scope on 2.1.283). Unset without default: loads, warns, keeps literal. Credential-named vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `HTTPS_PROXY`, `NPM_TOKEN` ...) read as **empty** in remote `url`/`headers` [D-mcp §Environment variable expansion][cpb §MCP servers].
- OAuth 2.0 for remote servers: `/mcp`, `claude mcp login <name> [--no-browser]`, `claude mcp logout`; `--client-id`, `--client-secret` (or `MCP_CLIENT_SECRET`), `--callback-port`; tokens kept in the credential store [D-mcp][L-help][D-ti].
- CLI [L-help]: `claude mcp add [-s local|user|project] [-t stdio|sse|http] [-e K=V] [-H 'K: V'] <name> <cmdOrUrl> [args...]`, `add-json <name> <json> [-s]`, `add-from-claude-desktop`, `get`, `list` (health-checks every approved server; cpb avoids it), `remove [-s]`, `login`, `logout`, `reset-project-choices`, `serve` (Claude Code as an MCP server).
- Observed on a bench [B-mcp], 2026-10-22, @2.1.307: a stdio server given in a `--mcp-config` file started in a `-p` run, and its tool reached the model's request as `mcp__<server>__<tool>`. `${VAR}` in the file's `env` and in a remote server's `headers` was expanded from Claude Code's environment, as documented for `.mcp.json`. Nothing was written to the config dir's `.claude.json`.
- Session flags: `--mcp-config <files-or-json...>`, `--strict-mcp-config` [L-help]. Env: `MCP_TIMEOUT` (30 s), `MAX_MCP_OUTPUT_TOKENS` (25000), `ENABLE_TOOL_SEARCH` [D-env].
- Helper working directory: user-scope/managed/connector helpers run from the config dir (2.1.238+) [D-mcp].

## 9. Skills

- Format: directory with `SKILL.md`, YAML frontmatter between `---` lines then Markdown; supporting files alongside [D-skills].
- Frontmatter accepted by Claude Code (all optional; `description` recommended): `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context` (`fork`), `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility`. Unknown fields ignored silently; booleans accept yes/no/on/off/1/0 [D-skills §Frontmatter reference][D-dir].
- Locations [D-skills §Where skills live]:

| Location | Path | Notes |
|---|---|---|
| Enterprise | `.claude/skills/<n>/SKILL.md` in the managed settings dir | wins over personal |
| Personal | `~/.claude/skills/<n>/SKILL.md` | wins over project |
| Project | `.claude/skills/<n>/SKILL.md` in cwd and every parent up to repo root | |
| Nested | `<subdir>/.claude/skills/` | lazy, qualified as `/<subdir>:<name>` on clash |
| `--add-dir` | `<dir>/.claude/skills/` | |
| Plugin | `<plugin>/skills/<n>/SKILL.md` | namespaced `/plugin:skill`; observed @2.1.307 for `--plugin-dir <dir>`: the manifest's `name` is the plugin name, or the directory's name without a manifest, and the skill reaches the request as `<plugin>:<name>` [B-skills] |
| claude.ai synced | `~/.claude/skills/synced/` | name `anthropic-skills:<n>` |

- Symlinked skill folders are followed; reserved names `synced`, `anthropic-skills`, `claude-ai`; a skill folder holding `.claude-plugin/plugin.json` loads as plugin `<name>@skills-dir` [D-skills][D-cl 2.1.282].
- Discovery and invocation: `description` + `when_to_use` listed, truncated at 1,536 chars (`skillListingBudgetFraction`, `skillListingMaxDescChars`); invoked by `/name` or by the model; `disable-model-invocation: true` blocks the model, `user-invocable: false` hides it from `/`; substitutions `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`; `` !`cmd` `` dynamic context injection; live reload of `.claude/skills/` [D-skills]. `--disable-slash-commands` disables all skills [L-help].
- Listing placement: the docs say skill descriptions "are loaded into context so Claude knows what's available", and do not say where in the request (system prompt, a message or a tool definition) [D-skills] (re-read 2026-10-22).
- Agent Skills relation: Claude Code "follow[s] the Agent Skills open standard" and extends it [D-skills]. Spec: required `name` (1-64 chars, lowercase alnum and hyphen, no leading/trailing/double hyphen, must match directory) and `description` (1-1024 chars); optional `license`, `compatibility` (<=500), `metadata` (string map), `allowed-tools` (space-separated, experimental); optional `scripts/`, `references/`, `assets/`; progressive disclosure; validator `skills-ref validate` [AS-spec]. Outside Claude Code (claude.ai upload, Skills API) only `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` are accepted and others are a hard error [D-skills §Using skill frontmatter outside Claude Code].
- Cross-client paths: the Agent Skills client guide recommends scanning `<project>/.agents/skills/` and `~/.agents/skills/` besides the client's own dir, project overriding user [AS-client]. Claude Code's skill docs list no `.agents/skills` location (not found in docs).
- No CLI installs an existing skill; `claude plugin init <name>` scaffolds a new skills-dir plugin at `~/.claude/skills/<name>/` [L-help][cpb §Skills].

## 10. Plugins and marketplaces

- Layout [D-plug manifest §Standard layout]: optional `.claude-plugin/plugin.json`; `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `output-styles/`, `workflows/`, `themes/`, `monitors/monitors.json`, `bin/` (on Bash `PATH`), `settings.json` (`agent`, `subagentStatusLine` only), channels, mods (function-hook UI extensions; `plugins/mods/*` docs). A plugin-root `CLAUDE.md` is **not** loaded. Plugin agents ignore `hooks`, `mcpServers`, `permissionMode` [D-sub].
- Manifest: `name`, `displayName`, `version`, `metadata`, `defaultEnabled`, `dependencies`, `settings`, component path keys, `userConfig` (sensitive values to the credential store) [D-plug manifest].
- Path variables: `${CLAUDE_PLUGIN_ROOT}` (version dir, changes per version), `${CLAUDE_PLUGIN_DATA}` (`plugins/data/<id>/`, survives updates) [D-plug loading].
- Marketplace: `.claude-plugin/marketplace.json` at the marketplace root; one name per marketplace per user; plugin sources: relative path, `github`, `url`, `git-subdir`, `npm`, `archive`, `command` (2.1.229+, confirmation by sha256) [D-plug marketplace-reference].
- Install scopes: user / project / local -> `enabledPlugins` in the matching settings file; project scope enables but does not download for collaborators [D-plug install §Choose an install scope]. Plugin id `<plugin>@<marketplace>` [D-sref enabledPlugins].
- On disk: `plugins/cache/<marketplace>/<plugin>/<version>/`, `marketplaces/<name>/`, `installed_plugins.json`, `known_marketplaces.json`; root movable by `CLAUDE_CODE_PLUGIN_CACHE_DIR`; read-only seeds `CLAUDE_CODE_PLUGIN_SEED_DIR` [D-plug loading][D-env].
- CLI [L-help plugin]: `install|i [--scope user|project|local] [--config k=v] [--json] [-y] [--accept-command <sha256>] [--registry]`, `uninstall|remove [--scope] [--keep-data] [--prune] [--json]`, `enable|disable [--scope] [--json]`, `update`, `list [--json] [--available] [--data-size]`, `details`, `configure [--values-stdin]`, `validate`, `tag`, `eval`, `test`, `prune`, `init|new`; `marketplace add <source> [--scope user|project|local] [--sparse paths] [--claudeai] [--json]`, `marketplace list|remove|update`. Session-only: `--plugin-dir`, `--plugin-url` [L-help].
- Observed (cpb): `install --json` / `uninstall --json` exist from 2.1.268; marketplaces clone by branch or tag only, a commit cannot be pinned; `marketplace remove` silently uninstalls its plugins; marketplace name comes from the source's `marketplace.json`, not the command [cpb §Plugins and the agent].

## 11. Hooks

**Events (33)** [D-hooks §Hook lifecycle]: `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`.

- Shape: `hooks.<Event>[] = {matcher, hooks:[handler...]}` [D-hooks §Configuration].
- **`onFailure`** (a command or http handler field): `"continue"` (the default) or `"block"`; it needs Claude Code 2.1.295 or later. A failure is any of: the hook can't start, it exits other than 0 or 2, an HTTP error, a timeout, or invalid JSON output. With `"block"` a failure does what exit 2 does on that event, except `PermissionRequest`, which it denies. It has no effect on `Stop`, `SubagentStop`, `TaskCompleted`, `TeammateIdle` or async hooks [D-hooks §onFailure, read 2026-10-23]. **Measured** [B-hooks-persisted]: a persisted `UserPromptSubmit` hook with `onFailure: "block"` whose script was gone kept the prompt from the model (2.1.307).
- Matcher: `"*"`, `""` or omitted = all; only `[A-Za-z0-9_- ,|]` = exact name(s) split on `|` or `,`; anything else = unanchored JavaScript regex. Field matched varies per event (tool name; `startup|resume|clear|compact|fork` for SessionStart; source for ConfigChange; filenames for FileChanged; none for Stop, UserPromptSubmit, ...) [D-hooks §Matcher patterns].
- Handler types: `command`, `http` (POST JSON), `mcp_tool`, `prompt` (single-turn model verdict), `agent` (experimental subagent verifier). Common fields: `type`, `if` (one permission rule, tool events only), `timeout` (600 s command/http/mcp_tool; 30 prompt; 60 agent), `statusMessage`, `once` (skill hooks only), `async` for background command hooks. All matching handlers run in parallel; identical handlers dedupe [D-hooks §Hook handler fields].
- Input on stdin (command) or POST body (http): `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort.level`, `hook_event_name`, plus `agent_id`/`agent_type` in subagents or `--agent`, plus event fields (`tool_name`, `tool_input`, `tool_use_id` ...) [D-hooks §Common input fields].
- Exit codes: 0 = success (stdout to debug log, except `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `PostModelSwitch` where plain stdout becomes context); 2 = blocking (stderr is the reason; cannot be overridden by JSON allow); other = non-blocking error. JSON is parsed from stdout on every exit code when it starts with `{` and ends with `}` [D-hooks §Exit code output].
- JSON output: universal `continue`, `stopReason`, `suppressOutput` (no effect), `systemMessage`, `terminalSequence`; top-level `decision: "block"` + `reason`; `hookSpecificOutput` (`hookEventName`, `permissionDecision` allow/deny/ask/defer, `permissionDecisionReason`, `updatedInput`, `additionalContext`, `updatedToolOutput`, SessionStart `initialUserMessage`/`watchPaths`/`sessionTitle`/`reloadSkills`, ...); strings capped at 10,000 chars [D-hooks §JSON output, §Decision control].
- Where configured: user/project/local/managed settings, plugin `hooks/hooks.json`, skill frontmatter (active for rest of session), subagent frontmatter (while running; `Stop` becomes `SubagentStop`) [D-hooks §Hook locations]. Merge across levels; `disableAllHooks`; managed `allowManagedHooksOnly`; project hooks wait for workspace trust [D-hooks].
- Env given to hooks: parent env minus `OTEL_*` exporter vars; `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`; `CLAUDE_ENV_FILE` for SessionStart/Setup/CwdChanged/FileChanged to persist exports [D-hooks][D-env].
- `/hooks` is a viewer; no CLI adds hooks [D-cmd].
- Observed on a bench [B-hooks], 2026-10-22, @2.1.307, in a `-p` run with hooks in a `--settings` file:
  - `SessionStart` (source `startup`) and `UserPromptSubmit` command hooks ran before the model was asked;
  - `hookSpecificOutput.additionalContext` from `UserPromptSubmit` reached the model's request;
  - exit 2 from `UserPromptSubmit` blocked the prompt, so no request was sent;
  - the request offered, among others, the tools `Bash`, `Edit`, `Write`, `NotebookEdit`, `Read`, `WebFetch` and `WebSearch`.

## 12. Permissions / sandbox

- Rule syntax `Tool` or `Tool(specifier)`: `Bash(npm run test *)` (`*` matches any text incl. spaces), `Read(./.env)`, `Edit(/src/**/*.ts)`, `WebFetch(domain:example.com)`, `mcp__server`, `mcp__server__tool`, `Agent(Explore)`, `Skill(...)`; deny/ask rules may match a top-level parameter `Tool(param:value)` (not the primary content field) [D-perm §Permission rule syntax].
- Read/Edit paths use gitignore syntax: `//abs`, `~/home`, `/relative-to-settings-source`, `./` or bare relative to cwd [D-perm §Read and Edit].
- Lists: `permissions.allow`, `ask`, `deny`; evaluation deny > ask > allow, first match by category; bare-name deny removes the tool from context [D-perm §Manage permissions].
- `defaultMode`: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, `manual` (alias of `default`, 2.1.200+); `auto`/`bypassPermissions` ignored from project/local (2.1.257+) [D-sref permissions.defaultMode]. Unset now means **auto mode** for interactive sessions (2.1.284) and `-p` on 3P/telemetry-off (2.1.285) [D-cl]. CLI `--permission-mode` choices observed: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` [L-help].
- `additionalDirectories` / `--add-dir` / `/add-dir` grant file access, not configuration; `blockReadsOutsideWorkingDirectories`; `disableBypassPermissionsMode`; managed `allowManagedPermissionRulesOnly` [D-perm][D-sref].
- Session flags: `--allowedTools`, `--disallowedTools`, `--tools`, `--dangerously-skip-permissions`, `--permission-prompts host|none` [L-help].
- "Yes, and don't ask again" saves to `.claude/settings.local.json` at the git repo root (2.1.211+) [D-perm].
- Bash sandbox: off by default; `/sandbox` or `sandbox.enabled`; covers Bash/PowerShell/Monitor commands only (not file tools, MCP, hooks, status line); macOS Seatbelt, Linux/WSL2 bubblewrap, built on `@anthropic-ai/sandbox-runtime`; keys `sandbox.filesystem.{allowWrite,denyWrite,denyRead,allowRead,disabled}`, `sandbox.network.{allowedDomains,deniedDomains,allowUnixSockets,httpProxyPort,...}`, `excludedCommands`, `allowUnsandboxedCommands`, `autoAllowBashIfSandboxed`, `credentials.*`. Protected paths include the config dir, `.claude.json` and `.credentials.json` [D-sbx].
- No CLI for permission rules; cpb writes the key [cpb §Tool permissions].

## 13. Status line

- `statusLine: {"type":"command","command":"...","padding":N,"refreshInterval":S,"hideVimModeIndicator":bool}`; any settings file; `/statusline` configures it in-session [D-sl][D-sref statusLine].
- Script gets JSON on stdin; top-level keys: `agent`, `context_window`, `cost`, `cwd`, `effort`, `fast_mode`, `model`, `output_style`, `pr`, `prompt_cache`, `prompt_id`, `rate_limits`, `session_id`, `session_name`, `thinking`, `transcript_path`, `version`, `vim`, `workspace`, `worktree` [D-sl §Available data].
- Triggers: session start/resume, new assistant message, `/compact`, permission-mode change, vim toggle, command change, `refreshInterval` timer (min 1 s), rate-limit/cache expiry; 300 ms debounce; in-flight run cancelled; `COLUMNS`/`LINES` set [D-sl §How status lines work].
- `subagentStatusLine` for subagent rows; with `allowManagedHooksOnly` only managed values run [D-sref].
- Observed (cpb, 2.1.283): without `refreshInterval` the status line is not re-rendered while idle [cpb §Status line and model].

## 14. Agents / subagents

- Locations and priority: managed `.claude/agents/` (1) > `--agents` JSON (2) > project `.claude/agents/` walked up to repo root, nearest wins (3) > `~/.claude/agents/` (4) > plugin `agents/` (5). Scanned recursively; identity is `name`, not path (plugin subfolders become part of `plugin:sub:name`) [D-sub §Choose the subagent scope].
- Frontmatter (camelCase): `name` (required, no `:`), `description` (required), `tools`, `disallowedTools`, `model` (alias, full id, `inherit`), `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory` (`user|project|local` -> `agent-memory/`, `.claude/agent-memory/`, `.claude/agent-memory-local/`), `background`, `effort`, `isolation` (`worktree`), `color`, `initialPrompt`, `omitClaudeMd`, `experimental`; body = system prompt (subagents do not get the Claude Code system prompt) [D-sub][D-dir].
- `--agents '<json>'`: `{name: {description, prompt, tools, model, ...}}`; with `-p` also a file path; `color`/`experimental` ignored [D-sub][L-help].
- Main session as an agent: `agent` setting (any file) or `--agent <name>` (flag wins); the agent's prompt, tools and model apply to the main thread; a plugin `settings.json` may also name one [D-sref agent][L-help].
- Observed (cpb): among plugins naming an agent, the last loaded wins; the user-scope `agent` overrides every plugin; the key has no CLI [cpb §Plugins and the agent].
- Built-ins include `general-purpose`, `Explore`, `Plan`; disable with `Agent(Name)` deny rules [D-perm][D-hooks matcher table]. Note: `claude agents` is the background-session manager (agent view), not subagent management [L-help][D-av].

## 15. Custom slash commands

- `commands/*.md` in `~/.claude/commands/`, `.claude/commands/`, plugin `commands/`; "Commands and skills are now the same mechanism" [D-dir]. Same frontmatter as skills except `name` and `paths`; command name = filename, subdirectories become `:` namespaces (`frontend/component.md` -> `/frontend:component`); a skill beats a command file of the same name [D-skills §How a skill gets its command name].
- Arguments: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, named `$name` via `arguments` [D-skills].
- Also commands: `workflows/*.js` become `/<name>` [D-dir]; MCP prompts. Built-ins include `/config`, `/model`, `/permissions`, `/hooks`, `/mcp`, `/plugin`, `/memory`, `/statusline`, `/output-style`, `/effort`, `/sandbox`, `/keybindings`, `/resume`, `/context`, `/import`, `/init`, `/login`, `/logout`, `/status` [D-cmd]. A user skill can shadow a built-in (not its aliases) [D-skills].

## 16. Sessions

- Transcript: `<config>/projects/<cwd with every non-alphanumeric char as ->/<session-id>.jsonl`; names over 200 chars truncated plus a hash; format internal and unstable [D-sess §Where transcripts are stored]; cpb uses the same encoding [cpb §SHOW SESSIONS].
- Auto memory per project under `projects/<project>/memory/` (derived from git repo, shared by worktrees) [D-mem].
- Live registry `sessions/<pid>.json`: documented to exist ("one small file per running session, used to detect concurrent sessions and crashes", removed on exit, not swept) [D-dir]; fields observed by cpb: pid, session id, cwd, kind (`interactive`/`bg`), status, name, version, start time; format undocumented [cpb §SHOW SESSIONS]. Observed sibling `<pid>.<64hex>.key` files [L-fs].
- `history.jsonl`: all typed prompts with project path [D-dir].
- Flags [L-help][D-sess]: `-c/--continue` (latest in cwd; skips `-p`/SDK sessions), `-r/--resume [id|name|transcript path]` (cross-project lookup since 2.1.223), `--fork-session` (new id), `--session-id <uuid>`, `-n/--name`, `--from-pr`, `--no-session-persistence` (`-p` only), `--bg`, `claude attach|logs|stop|rm|respawn`. `/branch` in-session.
- Resume keeps the transcript's model [D-model]. Concurrent writers on one id corrupt it; Claude Code's own exit "resume" hint ignores `CLAUDE_CONFIG_DIR` (observed, cpb) [cpb §SHOW SESSIONS].
- Retention: `cleanupPeriodDays` default 30, min 1 (0 is invalid); `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` writes no transcript/history; `claude purge [path] [--all] [--dry-run] [-y] [-i]` (renamed from `claude project purge` in 2.1.288) [D-dir][D-cl 2.1.288][L-help].
- Retention, re-read 2026-10-22: the sweep deletes `projects/<project>/<session>.jsonl` ("Full conversation transcript: every message, tool call, and tool result"), with `<session>/subagents/` and `<session>/tool-results/`, once older than `cleanupPeriodDays`, "as long as it can safely determine the retention period" [D-dir §Cleaned up automatically]. "The sweep deletes transcripts without showing a message"; "Setting `0` fails validation, so pick a large value such as `3650` for long retention" [D-sref §cleanupPeriodDays]. Not swept: `sessions/` (removed on exit), auto memory under `projects/<project>/memory/`. The sweep is skipped under `-p --bare` and runs at the managed value when managed settings set it [D-dir §Cleaned up automatically].
- Retention, observed 2026-10-22 on Claude Code 2.1.307 by a reviewer, using throwaway folders that each held a 50-day-old transcript:
  - with no setting, the transcript was deleted;
  - it was kept with `--settings '{"cleanupPeriodDays": 9999}'` at launch;
  - it was kept with the value in the folder's `settings.json`;
  - it was kept under a managed value of 9999 alone.

  So the sweep runs on every start, takes its period from the merged settings, and accepts 9999. A managed `cleanupPeriodDays` (macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`) is taken the same way (observed 2026-10-22) [L-fs].

## 17. Headless / non-interactive

- `-p/--print`; `--output-format text|json|stream-json`; `--input-format text|stream-json`; `--json-schema` (result in `structured_output`); `--include-partial-messages`; `--include-hook-events`; `--replay-user-messages`; `--forward-subagent-text`; `--max-turns`; `--max-budget-usd`; `--permission-prompts host|none`; `--no-session-persistence` [L-help][D-hl][D-cli].
- `-p` skips the workspace trust dialog, silently ignores invalid settings files, and loads `.mcp.json` servers without approval [L-help][D-mcp].
- Exit codes: 0 success, non-zero on failure; 143 on SIGTERM; invalid flag errors before the run [D-hl].
- `--bare`: skips hooks, LSP, plugin sync, auto-memory, keychain reads, CLAUDE.md discovery; auth only `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`; sets `CLAUDE_CODE_SIMPLE=1`; since 2.1.286 connects only command-line MCP servers [L-help][D-cl 2.1.286].
- Agent SDK: TypeScript `@anthropic-ai/claude-agent-sdk`, Python `claude-agent-sdk`; a library that runs the Claude Code binary. `settingSources` `["user","project","local"]` (omitted = all three); managed policy, `.claude.json`, auto memory and connectors are read regardless; multi-tenant isolation requires own filesystem + `settingSources: []` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` [D-sdk].

## 18. Native config-mutation CLI

| Setting / state | Native CLI | Source |
|---|---|---|
| MCP servers (local/project/user) | `claude mcp add`, `add-json`, `remove`, `reset-project-choices`, `login`/`logout` | [L-help] |
| Plugins (`enabledPlugins`, install records) | `claude plugin install/uninstall/enable/disable/update/prune`, `--scope`, `--json` | [L-help] |
| Marketplaces (`extraKnownMarketplaces`, `known_marketplaces.json`) | `claude plugin marketplace add/remove/update --scope` | [L-help] |
| Plugin options (`pluginConfigs`) | `claude plugin configure --values-stdin`, `install --config k=v` | [L-help] |
| Login | `claude auth login/logout/status`, `claude setup-token` | [L-help] |
| Auto mode rules (`autoMode`) | `claude auto-mode reset` (removes it from user settings), `config`, `defaults`, `critique` | [L-help] |
| Project state | `claude purge` | [L-help] |
| Import from other agents | `claude import [codex|gemini|cursor]` (interactive) | [L-help][D-cli] |
| Generic settings | **none**: `claude config` is not a registered subcommand in 2.1.289 (`claude config --help` prints the root help); `claude config` was deprecated in 1.0.7 ("in favor of editing settings.json") and unshipped in 2.0.0 | [L-help][D-cl 1.0.7, 2.0.0] |
| In-session only | `/config key=value` (also in `-p`), `/model` (writes `model` to user settings), `/permissions`, `/statusline`, `/memory`, `/output-style`, `/effort`, `/sandbox`, `/keybindings` | [D-cmd][D-model] |

File-only for a non-interactive tool (no CLI): `permissions.*`, `statusLine`, `model`, `agent`, `modelPicker`, `hooks`, `env`, `outputStyle`; skills have no install CLI [cpb §An agent's configuration][cpb §Tool permissions][cpb §Status line and model][cpb §Model picker][cpb §Skills].

## 19. Environment variables

The reference table documents about 387 variables [D-env §Variables]. Rules: shell vars read at start; a settings `env` value overwrites the shell value; `""` cancels an inherited value for provider selection; project/local `env` cannot set `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`, `HOME`/`TMPDIR`/`XDG_*`, OTel exporter/content vars (2.1.282), `CLAUDE_CODE_PROCESS_WRAPPER`, plugin dir vars; some are launch-env only (`CLAUDE_CODE_PROJECT_DIR_NAME`, `CLAUDE_CODE_RESTRICTED`) [D-env §Precedence][D-sref §Variables Claude Code ignores in env].

| Group | Variables (one line each) |
|---|---|
| Location | `CLAUDE_CONFIG_DIR` config root; `CLAUDE_CODE_PROJECT_DIR_NAME` fixed `projects/` name; `CLAUDE_CODE_TMPDIR` temp tree; `CLAUDE_CODE_PLUGIN_CACHE_DIR` plugins root; `CLAUDE_CODE_PLUGIN_SEED_DIR` read-only seeds |
| Auth | `ANTHROPIC_API_KEY` x-api-key; `ANTHROPIC_AUTH_TOKEN` bearer; `CLAUDE_CODE_OAUTH_TOKEN` setup-token; `ANTHROPIC_PROFILE` named profile; `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` helper cache |
| Endpoint | `ANTHROPIC_BASE_URL`; `ANTHROPIC_CUSTOM_HEADERS`; `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_ANTHROPIC_AWS`; `ANTHROPIC_BEDROCK_BASE_URL`; `AWS_BEARER_TOKEN_BEDROCK`; `CLAUDE_CODE_SKIP_BEDROCK_AUTH`; `ANTHROPIC_VERTEX_PROJECT_ID`; `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_API_KEY`; `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`; `HTTPS_PROXY` |
| Model | `ANTHROPIC_MODEL`; `ANTHROPIC_DEFAULT_MODEL`; `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`; `CLAUDE_CODE_SUBAGENT_MODEL`; `ANTHROPIC_CUSTOM_MODEL_OPTION` (+`_NAME`, `_DESCRIPTION`); `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`; `CLAUDE_CODE_EFFORT_LEVEL` (beats `--effort`); `MAX_THINKING_TOKENS`; `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; `DISABLE_PROMPT_CACHING` |
| Modes | `CLAUDE_CODE_SIMPLE` (= `--bare`); `CLAUDE_CODE_SAFE_MODE` (= `--safe-mode`); `CLAUDE_CODE_RESTRICTED` (= `--restricted`); `CLAUDE_CODE_DISABLE_CLAUDE_MDS`; `CLAUDE_CODE_DISABLE_AUTO_MEMORY`; `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` |
| Shell/tools | `CLAUDE_CODE_SHELL`; `CLAUDE_ENV_FILE`; `BASH_DEFAULT_TIMEOUT_MS`; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` |
| MCP | `MCP_TIMEOUT`; `MAX_MCP_OUTPUT_TOKENS`; `ENABLE_TOOL_SEARCH`; `MCP_CLIENT_SECRET` |
| Privacy/network | `DISABLE_TELEMETRY` (any value incl. `0` opts out); `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; `DISABLE_AUTOUPDATER`; `CLAUDE_CODE_SKIP_PROMPT_HISTORY`; `CLAUDE_CODE_ENABLE_TELEMETRY` + standard `OTEL_*` |
| Tasks/background | `CLAUDE_CODE_TASK_LIST_ID` shared task list; `CLAUDE_CODE_ENABLE_TASKS`; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`; `CLAUDE_JOB_DIR` (set for background sessions) |

Full list: https://code.claude.com/docs/en/env-vars (fetched 2026-10-04).

## 20. Other stateful features

- Output styles: `outputStyle` key, `/output-style` (2.1.269+); files in `~/.claude/output-styles`, project `.claude/output-styles` (walked to repo root), managed dir, plugins; frontmatter `name`, `description`, `keep-coding-instructions`, `force-for-plugin` [D-os][D-dir].
- Keybindings: `~/.claude/keybindings.json` (global only), schema `https://www.schemastore.org/claude-code-keybindings.json`, `/keybindings` [D-kb].
- Tasks: Task tools write `tasks/<list>/`; `todos/` is legacy and no longer written [D-dir][D-env].
- Auto memory: `projects/<project>/memory/MEMORY.md` index (first 200 lines or 25 KB loaded) + topic files; `autoMemoryEnabled`, `autoMemoryDirectory`, `/memory`; not swept [D-mem §Auto memory].
- Subagent memory: `agent-memory/`, `.claude/agent-memory/`, `.claude/agent-memory-local/` [D-sub].
- Checkpoints: `file-history/<session>/`, `fileCheckpointingEnabled`, `/rewind` [D-dir][D-sref].
- Plans: `plans/` (`plansDirectory`) [D-dir].
- Telemetry: `CLAUDE_CODE_ENABLE_TELEMETRY=1` then `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` / `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_*`; `otelHeadersHelper`; not settable from project/local [D-mon][D-sref].
- Themes `themes/*.json`, workflows `workflows/*.js`, scheduled tasks `.claude/scheduled_tasks.json`, worktrees `.claude/worktrees/` + `.worktreeinclude`, background sessions `jobs/` + `daemon/` [D-dir][D-sbx §Protected paths][D-av].

## 21. Versioning

- Surveyed 2.1.289 (2026-10-03) [L-help --version][D-cl]. Docs changelog holds 411 releases; 27 releases between 2026-09-01 and 2026-10-03, i.e. near-daily [D-cl]. A cached copy sits at `<config>/cache/changelog.md` [D-dir].
- Native installer channels: `stable`, `latest`, or a pinned version (`claude install <target>`); `autoUpdatesChannel`, `minimumVersion`, managed `requiredMinimumVersion`/`requiredMaximumVersion`; `DISABLE_AUTOUPDATER` [L-help][D-sref][D-env].
- Recent config-relevant changes (version numbers from [D-cl]; 2.1.277 removal from [D-env], 2.1.242 / 2.1.211 / 2.1.268 gates from [D-managed], [D-settings], [D-cli]):

| Version | Change |
|---|---|
| 2.1.288 | `claude project purge` -> `claude purge` (old name still works) |
| 2.1.286 | `--bare` connects only command-line MCP servers |
| 2.1.285 | `-p` on 3P providers starts in auto mode when no mode set; project settings cannot widen or disable an admin-required sandbox; custom `ANTHROPIC_BASE_URL` uses 1M context |
| 2.1.284 | interactive sessions start in **auto mode** when no permission mode is configured |
| 2.1.282 | project/local settings ignore OTel export/content vars; `anthropic-skills` / `claude-ai` names reserved |
| 2.1.281 | AGENTS.md support on Bedrock/Vertex/Foundry/gateways |
| 2.1.277 | native AGENTS.md reading; `TASK_MAX_OUTPUT_LENGTH`/`TaskOutput` removed |
| 2.1.268 | `claude plugin install/uninstall --json`; `auth status` `configDirectory` |
| 2.1.257 | `bypassPermissions` default mode only from user/managed |
| 2.1.251 | project `env` can no longer set `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`, `TMPDIR` |
| 2.1.242 | `modelPicker`, `managedSourcesBehavior: merge` |
| 2.1.211 | `settings.local.json` moved to git repo root |
| 2.0.0 / 1.0.7 | `claude config` unshipped / deprecated in favour of editing settings.json |

## Things a harness-neutral standard must not copy blindly from Claude Code

1. **`.claude.json` placement asymmetry.** Default `~/.claude.json` sits beside the config dir, but with `CLAUDE_CONFIG_DIR` it moves inside it. One file mixes account/OAuth state, cached feature flags, per-project trust, MCP servers of two scopes and UI prefs. A standard should keep "config root" as one directory and separate config, state and credentials.
2. **Keychain item naming by hash of the path string** (`Claude Code-credentials-<sha256[:8]>`, observed, undocumented). Path spelling becomes identity; the namespace is shared OS-wide. Specify credential isolation as a property, not a naming scheme.
3. **Harness-owned secret store holds third-party secrets** (MCP OAuth tokens, plugin sensitive values in the same keychain item / `.credentials.json`); `/logout` wipes them all.
4. **MCP "local" scope is not local to the project**: it is stored in the home-level `.claude.json` keyed by absolute project path; "local" means two different things for MCP and for settings files.
5. **`settings.local.json` placement rules** (git repo root, main checkout for worktrees, auto-added to global git excludes): host-git-specific side effects.
6. **Per-key scope eligibility** (`modelPicker` user/managed only, `defaultMode: auto|bypassPermissions` not from project, env-var blocklist for repo files, "Global config" keys only in `.claude.json`): useful security ideas, but the specific lists are Claude-specific.
7. **Env-vs-settings precedence decided per pair**, not by layer (`ANTHROPIC_MODEL` beats `model`, `CLAUDE_CODE_EFFORT_LEVEL` beats `--effort`, `--model` beats `ANTHROPIC_MODEL`). A standard should define one rule.
8. **List-merge exceptions** (`fallbackModel`, `modelPicker`, `availableModels`, `modelSettings`) and no field merge for MCP entries.
9. **AGENTS.md as a fallback only**, switched by a built-in plugin's `pluginConfigs` key; a `CLAUDE.local.md` silently suppresses AGENTS.md. `.agents/` is never read, and `.agents/skills` (the Agent Skills cross-client convention) is not scanned.
10. **Skill frontmatter superset**: Claude Code treats `name`/`description` as optional and accepts ~20 fields; the Agent Skills spec requires `name` matching the directory and rejects unknown keys on upload. Agent files use camelCase fields, skill files kebab-case: inconsistent within one harness.
11. **Project-dir encoding** (`[^A-Za-z0-9]` -> `-`, lossy and collision-prone, truncated with hash past 200 chars) and an undocumented `sessions/<pid>.json` registry: neither is a stable contract.
12. **Plugin identity `<plugin>@<marketplace>`**, marketplace name taken from the remote manifest, no commit pinning, `marketplace remove` uninstalling plugins: supply-chain semantics a standard should state explicitly.
13. **Hook vocabulary** (33 event names, exit code 2 = block, stdout-as-context only on four events, regex-vs-exact matcher heuristic by character class) is Claude-specific; map semantics, not names.
14. **No generic config CLI** (`claude config` removed); only MCP and plugins mutate via CLI, everything else is file editing or in-session slash commands. A standard that assumes a harness-native setter for every key will not map.
15. **Account-state caching that outlives routing**: cached claude.ai flags in `.claude.json` keep provider-specific tools on after `ANTHROPIC_BASE_URL` is pointed elsewhere (cpb observed); endpoint switching must be specified to reset provider-bound state.
16. **Version-gated behaviour everywhere** with near-daily releases (defaults such as permission mode changed within the last month); any mapping must pin a version range.
