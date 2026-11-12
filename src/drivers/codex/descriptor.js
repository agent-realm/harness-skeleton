// The Codex harness descriptor: declarative data, no logic (design note v0.2 §7.3).
// Every fact carries its source: `CX §n` is the survey
// docs/design/surveys/codex-2026-10-04.md, section n, with the survey's own keys.

import { CODEX_HOOKS } from '../../shim/codex-hooks.js';

export default Object.freeze({
  harness: 'codex',
  name: 'Codex',
  binary: 'codex',
  version_args: ['--version'], // prints `codex-cli 0.160.0` [CX §21]

  // Nothing is certified until a conformance run proves it. Codex ships about 1.6 minor
  // versions a week and changes config between them [CX §21], so the compatible range is
  // the surveyed minor only.
  // The delivery modes this build plans for the harness. `materialize` writes skills only
  // (milestone 6a.10), trees under skills/; config.toml is never written, since it is the user's
  // TOML and an edit of one key that keeps the rest of the file as written is later work.
  delivery_modes: ['materialize', 'overlay'],
  // What delivery may write: skill trees one level under skills/, nothing else (no JSON or TOML
  // file). The handlers check every address against this, whatever plan they are handed.
  // A name starting with . is never a tree (Codex skips hidden directories, ext/skills loader,
  // [CX §9]), and `reserved` names are the harness's own: skills/.system holds its bundled skills.
  // The plugin cache root takes one package per plugin name, under a version directory hs names
  // (plugins['agent-plugins'] below).
  writable: { json: {}, trees: ['skills', 'plugins/cache/harness-skeleton/*'], reserved: { skills: ['.system'] }, reserved_source: 'CX §9 [S-ext/skills/src/host_roots.rs]' },

  // Plugin formats this adapter maps (§5.7). Codex reads an Agent Plugins package natively: a root
  // plugin.json whose $schema names the format, read since 0.146.0 [CX §10], and on 0.160.0 and
  // 0.167.0 every component loads as the format says, literal text included (tier 1,
  // conformance/tier1/agent-plugins-codex.mjs, 2026-11-09). A plugin loads only from the cache,
  // plugins/cache/<marketplace>/<plugin>/<version>/, and only when enabled [CX §10]. Measured: a
  // package copied there loads with no marketplace added and no config.toml, enabled for one launch
  // by `-c plugins={"<plugin>@<marketplace>"={enabled=true}}`; unenabled it does not load; any
  // version directory name loads (tier 1, conformance/tier1/agent-plugins-codex-cache.mjs, 0.160.0
  // and 0.167.0, 2026-11-10). The override is one inline table because Codex splits an override's
  // key on every `.`, with no quoting, and deep-merges the override layer into the config's tables,
  // so the user's other plugin entries stay (codex-rs/config/src/overrides.rs and merge.rs, tag
  // rust-v0.160.0, read 2026-11-10); measured, a quoted dotted key does not load.
  // Plugin formats Codex reads, but which this adapter refuses, with the reason (§5.7, "No silent
  // degrade"). Claude Code's own layout: Codex finds .claude-plugin/plugin.json among its manifest
  // paths and reads it as its legacy manifest (utils/plugins/src/plugin_namespace.rs,
  // core-plugins/src/manifest.rs). From a package placed in its cache, as a driver places one, only
  // the skills load (tier 1, conformance/tier1/claude-plugin-codex-cache.mjs, 0.160.0 and 0.167.0,
  // 2026-11-12):
  // - a stdio server never starts: the legacy MCP parser expands no ${CLAUDE_PLUGIN_ROOT}, and runs a
  //   relative command from the session's directory, "relative helper commands therefore use the
  //   session's local process cwd" (codex-mcp/src/plugin_config.rs);
  // - commands are turned into skills only when `codex plugin add` installs the plugin, into
  //   .codex-plugin/migrated-command-skills/ (utils/plugins/src/lib.rs; core-plugins/src/loader.rs);
  // - its hooks register, with CLAUDE_PLUGIN_ROOT in their environment (hooks/src/engine/
  //   discovery.rs), and run only once trusted, which hs does not do for a package (§5.6).
  // All at tag rust-v0.160.0, read 2026-11-12.
  plugin_formats_refused: {
    'claude-plugin': {
      reason: 'Codex loads only the skills of a package in this layout placed in its cache: its stdio servers do not start (no ${CLAUDE_PLUGIN_ROOT} expansion, and a relative command runs from the session\'s directory), its commands become skills only through `codex plugin add`, and its hooks run only once trusted, which hs does not do for a package. Use the Agent Plugins format, which Codex reads natively',
      source: 'rust-v0.160.0 (codex-mcp/src/plugin_config.rs, utils/plugins/src/lib.rs, core-plugins/src/loader.rs, hooks/src/engine/discovery.rs); tier 1, 0.160.0 and 0.167.0, 2026-11-12',
    },
  },
  plugins: {
    'agent-plugins': {
      versions: ['1.0.0'],
      mechanism: 'native',
      components: ['skills', 'mcp'],
      keeps_literal: true,
      cwd: 'format',
      // Codex reads more than the format's components from a package of this format (rust-v0.160.0,
      // read 2026-11-10): extensions["com.openai"] in plugin.json or, when it is absent,
      // .codex-plugin/plugin.json, for apps, hooks, an onboarding skill and an interface
      // (codex-rs/core-plugins/src/agent_plugin_manifest.rs, manifest/manifest_cache.rs `load`). The
      // loader drops the hooks and apps for this format (loader.rs). .codex-plugin/plugin.json's
      // mcpServers also add env_vars, variables forwarded from Codex's own environment, to a stdio
      // server of the same name (agent_plugin_mcp_overlay.rs), and that is not dropped.
      // extensions["com.openai"] is the format's own namespace mechanism [AP §8]: a package
      // carrying it is reported as harness-specific, and planned as runs-code, since a plan cannot
      // tell what Codex makes of it. .codex-plugin/ is a path the format never discovers [AP §6.1,
      // §8], and Codex acts on it, so a package holding it is refused (validate,
      // plugin_path_unsupported), in any letter case. Measured with hook trust bypassed: neither's
      // hook runs, where Codex's own layout runs it; the overlay's env_vars reach the server.
      // Recorded only, with no positive control: neither's app, onboarding skill or interface
      // reached a request (tier 1, conformance/tier1/agent-plugins-codex-cache.mjs).
      namespace: { name: 'com.openai', reads: ['apps', 'hooks', 'onboarding skill', 'interface'], dropped: ['hooks', 'apps'] },
      acts_on_paths: ['.codex-plugin'],
      acts_on_source: 'Codex reads .codex-plugin/plugin.json for an Agent Plugins package, its MCP servers\' environment included (rust-v0.160.0, agent_plugin_mcp_overlay.rs, manifest_cache.rs)',
      cache: { root: 'plugins/cache', marketplace: 'harness-skeleton', version_dir: 'hs' },
      enable: { config_key: 'plugins' },
      // config.toml is never written (delivery_modes, §7.5), so a bare `codex` start in the folder
      // does not enable the plugin.
      bare_start: 'a bare `codex` start in this folder does not load it: it is enabled only by launches made through launch-spec, since config.toml is never written',
      readiness: 'untested',
      source: 'design note §5.7; CX §10; tier 1, 2026-11-09 and 2026-11-10',
    },
  },

  versions: { certified: [], compatible: { min: '0.160.0', below: '0.161.0' } },


  // Strict isolation (§8): no switch is measured, so a strict launch or plan is refused, naming each
  // inbound escape (binding.escapes).
  isolation: { strict: null, reason: 'this build has measured no switch that keeps Codex\'s project instructions or its $HOME skill roots out' },

  binding: {
    // Must already exist and be a directory, or startup fails; Codex canonicalizes it [CX §1].
    env_set: 'CODEX_HOME',
    // Moves the SQLite databases (the thread state among them) out of the data folder [CX §1].
    env_unset: ['CODEX_SQLITE_HOME'],
    default_folder: '~/.codex',
    escapes: [
      { kind: 'inbound-read', path: '~/.agents/skills', class: 'config', closable: false,
        note: 'user skills, resolved from the OS home, not CODEX_HOME', source: 'CX §1 [S-ext/skills/src/host_roots.rs]' },
      { kind: 'inbound-read', path: '~/.agents/plugins/marketplace.json', class: 'config', closable: false,
        note: 'personal marketplace; also ~/.claude-plugin/ and ~/.cursor-plugin/marketplace.json', source: 'CX §1 [S-core-plugins/src/marketplace.rs]' },
      { kind: 'inbound-read', path: 'AGENTS.md from the project root (its .git) down to the working directory', class: 'config', closable: false,
        note: 'project instructions; an untrusted project supplies none (0.150.0 and later), and this build has not measured a switch', source: 'CX §3 [D-agentsmd]' },
      { kind: 'inbound-read', path: '/etc/codex/', class: 'config', closable: false,
        note: 'system and managed layers: config.toml, requirements.toml, managed_config.toml, skills', source: 'CX §1, §2 [D-basic][D-managed]' },
      { kind: 'credential-namespace', path: 'OS keyring, service "Codex MCP Credentials"', class: 'credentials', closable: false,
        note: 'MCP OAuth tokens, keyed by server name and URL, not by CODEX_HOME', source: 'CX §1, §7 [S-rmcp-client/src/oauth.rs]' },
      { kind: 'credential-namespace', path: 'OS keyring, service "Codex Auth"', class: 'credentials', closable: true,
        note: 'CLI login when the store is keyring or auto; the account key derives from CODEX_HOME, so it isolates', source: 'CX §1 [S-login/src/auth/storage.rs]' },
      { kind: 'outbound-write', path: '$TMPDIR/hook_outputs/<session_id>/', class: 'logs',
        note: 'spilled oversized hook output', source: 'CX §1 [D-hooks]' },
    ],
  },

  // Path classes (§9.1), relative to harness_path. Same rule form as the Claude Code descriptor.
  paths: [
    { pattern: '.harness-skeleton', class: 'skeleton', source: 'design note v0.2 §9.3' },

    { pattern: 'config.toml', class: 'config', source: 'CX §1, §4 [D-basic]' },
    { pattern: '*.config.toml', class: 'config', note: 'profile layers, selected by -p', source: 'CX §1, §4 [D-adv]' },
    { pattern: 'AGENTS.md', class: 'config', source: 'CX §1, §3' },
    { pattern: 'AGENTS.override.md', class: 'config', source: 'CX §1, §3' },
    { pattern: 'hooks.json', class: 'config', source: 'CX §1 [D-hooks]' },
    { pattern: 'rules', class: 'config', source: 'CX §1 [D-rules]' },
    { pattern: 'skills', class: 'config', note: 'deprecated user-skills root, still loaded; skills/.system/ bundled', source: 'CX §1, §9' },
    { pattern: 'agents', class: 'config', source: 'CX §1 [D-sub]' },
    { pattern: 'plugins', class: 'config', note: 'installed plugins under plugins/cache/<marketplace>/<plugin>/<version>/', source: 'CX §1; design note v0.2 §9.1' },
    { pattern: 'themes', class: 'config', source: 'CX §1, §20 [S-schema]' },
    { pattern: 'pets', class: 'config', source: 'CX §1, §20 [S-schema]' },

    { pattern: 'sessions', class: 'sessions', note: 'sessions/YYYY/MM/DD/rollout-*.jsonl', source: 'CX §1, §16' },
    { pattern: 'archived_sessions', class: 'sessions', note: 'archive target; a third-party claim, absent locally', source: 'CX §16 [W-3p]' },
    { pattern: 'session_index.jsonl', class: 'sessions', source: 'CX §1, §16' },
    { pattern: 'state_*.sqlite*', class: 'sessions', note: 'thread metadata, with -wal and -shm', source: 'CX §1, §16' },
    { pattern: 'thread_history_*.sqlite*', class: 'sessions', note: 'paginated thread history, with -wal and -shm', source: 'CX §1, §16' },

    { pattern: 'history.jsonl', class: 'history', note: 'prompt history', source: 'CX §1, §16 [D-adv]' },
    { pattern: 'memories', class: 'history', source: 'CX §1, §20 [D-mem]' },
    { pattern: 'memories_*.sqlite*', class: 'history', source: 'CX §1, §20' },
    { pattern: 'goals_*.sqlite*', class: 'history', source: 'CX §1, §20' },
    { pattern: 'generated_images', class: 'history', source: 'CX §1, §20' },

    { pattern: 'auth.json', class: 'credentials', note: 'CLI login when cli_auth_credentials_store = "file"', source: 'CX §1 [D-auth]' },
    { pattern: '.credentials.json', class: 'credentials', note: 'MCP OAuth file fallback', source: 'CX §1 [S-schema]' },

    { pattern: 'models_cache.json', class: 'cache', source: 'CX §1' },
    { pattern: 'cache', class: 'cache', note: 'apps and connectors caches', source: 'CX §1, §20' },
    { pattern: '.tmp', class: 'cache', note: 'catalog and marketplace clones', source: 'CX §1 [S-core-plugins]' },
    { pattern: 'vendor_imports', class: 'cache', source: 'CX §1' },
    { pattern: 'skills-curated-cache.json', class: 'cache', source: 'CX §1' },
    { pattern: 'packages', class: 'cache', note: 'standalone install and daemon package', source: 'CX §1 [D-env]' },
    { pattern: 'version.json', class: 'cache', note: 'update-check state', source: 'CX §1, §21' },

    { pattern: 'app-server-daemon', class: 'runtime', source: 'CX §1, §16' },
    { pattern: 'app-server-control', class: 'runtime', source: 'CX §1, §16' },
    { pattern: 'thread-writer-locks', class: 'runtime', source: 'CX §1' },
    { pattern: 'shell_snapshots', class: 'runtime', source: 'CX §1, §20' },
    { pattern: '.sqlite-maintenance.lock', class: 'runtime', source: 'CX §1' },
    { pattern: 'tmp', class: 'runtime', note: 'arg0 dispatch', source: 'CX §1' },

    { pattern: 'log', class: 'logs', source: 'CX §1 [S-schema]' },
    { pattern: 'logs_*.sqlite*', class: 'logs', source: 'CX §1, §16' },
  ],

  // The project layers a launch in one working directory reads [CX §2]: every file below, from
  // the working directory up to the project root (the nearest directory holding a root marker;
  // `project_root_markers` defaults to [".git"]), the closest first, and only for a project the
  // user config trusts (`[projects."<absolute path>"] trust_level = "trusted"`). Which path the
  // trust key names, and whether a trusted ancestor or a real-path comparison counts, is not in
  // the survey: this build matches the project root or the working directory, exactly as given.
  project_layers: {
    file: '.codex/config.toml',
    root_markers: ['.git'],
    trust: { table: 'projects', key: 'trust_level', value: 'trusted' },
    unverified: 'trust is matched exactly on the project root or the working directory as given; whether Codex also honours a trusted ancestor, or compares real paths, is not in the survey [CX §2]',
    cite: 'CX §2 [D-adv][D-ref][S-schema]',
  },

  // What a launch carries (§4, §7.1 launch-spec). `-c key=value` sets any config.toml key for
  // one launch, above the folder [CX §2].
  launch: {
    headless: {
      argv: ['exec', '--json'],
      result: '0 on success; 1 when the turn fails or is interrupted, on a non-retryable error, outside a git repository without --skip-git-repo-check, and on config or bootstrap failures; no distinct codes per failure class',
      source: 'CX §17 [D-exec][S-exec/src/lib.rs]',
    },
    state: {
      prompt_history: { config_key: 'history.persistence', values: { keep: 'save-all', none: 'none' } },
      sessions_none: { headless_argv: ['--ephemeral'], interactive: null },
    },
    cwd: ['headless runs need a git repository, or --skip-git-repo-check [CX §17]'],
    // Model roles (§5.2) [CX §5]: `-m` and two config keys; Codex has no small-model role.
    roles: {
      primary: { flag: '-m', cite: 'CX §5 [L-help]' },
      subagent: { config_key: 'agents.default_subagent_model', cite: 'CX §5 [D-ref]' },
      effort: { config_key: 'model_reasoning_effort', cite: 'CX §5 [S-schema]' },
      small: { unsupported: 'Codex has no small or background model role [CX §5]' },
    },
    // An OpenAI Responses endpoint becomes a provider of its own for the launch [CX §6]. The
    // provider reads its key from the variable `env_key` names; the caller resolves the
    // credential reference into it. An `x-api-key` endpoint sends it as that header instead.
    wire: 'openai-responses',
    endpoint: {
      provider_id: 'hs',
      key_env: 'HS_ENDPOINT_KEY',
      cite: 'CX §6 [D-ref][D-adv][S-schema]',
    },
    // A launch with an endpoint unsets the other key, token, workload-identity and routing
    // variables, in every login mode [CX §7 D-env, D-auth], and is refused while the folder holds
    // a stored login: auth.json under the default file store. With
    // cli_auth_credentials_store = "keyring" or "auto" the login may sit in the OS keyring instead,
    // in service `Codex Auth`, account derived from the canonical CODEX_HOME [CX §7
    // S-login/src/auth/storage.rs]; hs never queries the keyring and names it under unverified.
    // MCP servers at launch: `-c mcp_servers.<id>.<key>=<TOML>` overrides [CX §8 D-mcp][CX §2].
    // stdio: command, args, env, env_vars (forwards variables of Codex's own environment, by
    // name), cwd; streamable HTTP: url, http_headers, env_http_headers (header from a variable),
    // bearer_token_env_var. No SSE transport. Env handling is by reference, and `${VAR}` inside
    // values is not documented [CX §8]. A ref reaches a server as a derived variable whose name
    // holds SECRET, which the launch keeps from the shell tool (`scrub` below, §5.3). env_vars
    // forwards by name only, so a stdio server's ref is forwarded under its derived name and
    // renamed by a /bin/sh prelude that execs the server.
    // CLI overrides are dotted-path writes into the merged config [CX §2 S-config/src/loader], so
    // `-c mcp_servers.<id>.command` lands inside a server of that id from any layer and keeps its
    // other keys (read, not measured). hs refuses an id the folder's config.toml defines, and names
    // the layers it does not read.
    mcp: {
      config_key: 'mcp_servers', ref_prefix: 'HS_SECRET_', transports: ['http'], id: /^[A-Za-z0-9_-]+$/,
      unverified: 'a server under the same id in /etc/codex/config.toml, a trusted project\'s .codex/config.toml or managed_config.toml would take these -c keys into its own table and keep its other keys, and managed_config.toml outranks them [CX §2]; hs reads only the folder\'s config.toml for that',
    },
    hooks: CODEX_HOOKS,
    // The shell tool's environment [CX §12]. Codex 0.160.0 drops variables named *KEY*, *SECRET*
    // or *TOKEN* (case-insensitive) only while ignore_default_excludes is false, and defaults it
    // to true when unset: `ShellEnvironmentPolicy::default()` and the TOML conversion's
    // `unwrap_or(true)`, "Defaults to true" [CX §12 S-protocol/src/config_types.rs,
    // S-config/src/shell_environment_policy.rs, S-protocol/src/shell_environment.rs populate_env].
    // The docs say the opposite [CX §12 D-adv]; the source wins.
    scrub: {
      config_key: 'shell_environment_policy.ignore_default_excludes',
      patterns: ['KEY', 'SECRET', 'TOKEN'],
      note: 'shell_environment_policy.ignore_default_excludes is forced false, so the shell tool gets no variable named *KEY*, *SECRET* or *TOKEN* in this launch, the caller\'s own included',
      unverified: 'managed_config.toml outranks -c and may set shell_environment_policy.ignore_default_excludes = true, which would put the secret variables in the shell tool\'s environment [CX §2]; hs does not read it',
    },
    // No custom status line command: tui.status_line lists built-in items only [CX §13 S-schema].
    statusline: { supported: false, reason: 'Codex has no custom status line command; tui.status_line lists built-in items only [CX §13]' },
    // No skill at launch for codex exec or the TUI [CX §9; source at rust-v0.160.0, read
    // 2026-10-22, the task's codex-skills-source note]: the SessionFlags layer has no skill roots
    // (ext/skills/src/host_roots.rs), [[skills.config]] only enables or disables skills already
    // found (config/src/skills_config.rs), and only the app-server RPC skills/extraRoots/set adds a
    // root, which neither sends. A temp HOME, cwd or CODEX_HOME would reach a root, at the cost of
    // the agent's home, workspace or state, so none is used.
    // A plan under materialize puts a skill in $CODEX_HOME/skills/<name>, a root Codex 0.160.0
    // still loads but calls "Deprecated user skills location" (ext/skills/src/host_roots.rs); the
    // tier 1 check codex-skills-materialized fails loudly if a release stops loading it. Not
    // ~/.agents/skills, which every Codex folder of the user shares.
    skills: {
      at_launch: false,
      dir: 'skills',
      reason: 'Codex 0.160.0 has no skill root a launch can add for codex exec or the TUI: -c adds none, [[skills.config]] only enables or disables skills already found, and only the app-server RPC skills/extraRoots/set adds one [CX §9]; deliver the skill with a plan under materialize, into $CODEX_HOME/skills',
    },
    endpoint_unset: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT'],
    stored_login: {
      files: ['auth.json'],
      unverified: 'a folder whose cli_auth_credentials_store is "keyring" or "auto" may keep its login in the OS keyring, keyed to this folder [CX §7]; hs never queries the keyring, so a folder that was ever logged in must not be used for an endpoint launch',
      cite: 'CX §1, §7 [D-auth][S-login]',
    },
  },

  state: {
    retention_days: {
      expressible: false,
      harness_default: null,
      reason: 'Codex documents no age sweep; [history] max_bytes caps prompt history by size',
      source: 'CX §4, §16; design note v0.2 §5.12',
    },
    sessions: {
      expressible: true,
      harness_default: 'keep',
      launch_only: ['codex exec --ephemeral (headless only)'],
      source: 'CX §16',
    },
    prompt_history: {
      expressible: true,
      native: 'history.persistence',
      harness_default: 'keep',
      values: { 'save-all': 'keep', none: 'none' },
      source: 'CX §4, §16 [D-ref][S-schema]',
    },
  },

  // Config layers, highest first, as Codex 0.160.0's loader orders them [CX §2,
  // S-config/src/loader/README.md and S-config/src/config_layer_source.rs at rust-v0.160.0,
  // read 2026-10-22]: legacy MDM managed_config.toml (50), legacy managed_config.toml (40),
  // session flags (30), project, user profile, user config.toml, cloud-managed (15),
  // system (10), MDM managed preferences (0). The legacy managed file outranks every launch
  // layer, so its source is `managed`.
  layers: {
    managed: { linux: '/etc/codex/managed_config.toml', darwin: '/etc/codex/managed_config.toml' },
    above_folder: ['-c/--config and other CLI flags (session flags)', 'a trusted project\'s .codex/config.toml, root to cwd', 'the profile selected with -p (<name>.config.toml)'],
    folder: 'config.toml',
    not_consulted_below_folder: ['cloud-managed config (EnterpriseManaged, precedence 15)'],
    system: { linux: '/etc/codex/config.toml', darwin: '/etc/codex/config.toml' },
    mdm_domain: { darwin: 'com.openai.codex' },
    source: 'CX §2 [S-config/src/loader/README.md][S-config/src/config_layer_source.rs] at rust-v0.160.0',
  },
});
