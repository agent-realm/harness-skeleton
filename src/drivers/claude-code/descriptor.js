// The Claude Code harness descriptor: declarative data, no logic (design note v0.2 §7.3).
// Every fact carries its source: `CC §n` is the survey
// docs/design/surveys/claude-code-2026-10-04.md, section n, with the survey's own keys.

// The keys cpb removes for a playbook with no login of its own [cpb §Authentication preparation].
const ACCOUNT_STATE_KEYS = ['oauthAccount', 'cachedGrowthBookFeatures', 'cachedGrowthBookFeaturesAt', 'cachedExperimentFeatures', 'cachedExperimentData', 'passesEligibilityCache', 'cachedExtraUsageDisabledReason'];

import path from 'node:path';
import { CLAUDE_CODE_HOOKS } from '../../shim/claude-code-hooks.js';

export default Object.freeze({
  harness: 'claude-code',
  name: 'Claude Code',
  binary: 'claude',
  version_args: ['--version'],

  // Nothing is certified until a conformance run proves it (§7.2, §10). The compatible
  // range is the surveyed minor, from the surveyed release on: 2.1.289 surveyed [CC §21],
  // 2.1.307 observed by a reviewer on 2026-10-22 [CC §16].
  // The delivery modes this build plans for the harness (milestones 3 and 4).
  delivery_modes: ['materialize', 'overlay'],

  versions: { certified: [], compatible: { min: '2.1.289', below: '2.2.0' } },

  binding: {
    env_set: 'CLAUDE_CONFIG_DIR', // [CC §1, D-env]
    // Ambient variables that redirect the harness from the host shell (§8): the first moves
    // the plugin root out of the data folder [CC §1, D-plug]; the second moves the temp tree,
    // where images are written after 2.1.274 [CC §1, D-dir], so with it unset the images
    // escape sits at its default place.
    env_unset: ['CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_TMPDIR'],
    default_folder: '~/.claude',
    escapes: [
      { kind: 'credential-namespace', path: 'the login keychain (macOS); item name varies per data folder',
        class: 'credentials', closable: false, platforms: ['darwin'], source: 'CC §1, §7 [D-auth]' },
      { kind: 'credential-namespace', path: '~/.config/anthropic', class: 'credentials', closable: false,
        note: 'Anthropic profiles; moved by ANTHROPIC_CONFIG_DIR', source: 'CC §1 [D-auth]' },
      { kind: 'inbound-read', path: '/Library/Application Support/ClaudeCode/', class: 'config', closable: false,
        note: 'managed policy', platforms: ['darwin'], source: 'CC §1 [D-managed]' },
      { kind: 'inbound-read', path: '/etc/claude-code/', class: 'config', closable: false,
        note: 'managed policy', platforms: ['linux'], source: 'CC §1 [D-managed]' },
      // The asymmetry [CC §1]: with CLAUDE_CONFIG_DIR unset, .claude.json sits beside the
      // default folder, in $HOME; with it set, inside the folder, where the path rules class it.
      { kind: 'outbound-write', path: '~/.claude.json', siblings: ['~/.claude.json.lock', '~/.claude.json.tmp.*'],
        class: 'config', mixed: ['runtime', 'history'], when: 'default-folder',
        note: 'account state, MCP servers, per-project trust and history; applies when harness_path is the default folder and a launch leaves CLAUDE_CONFIG_DIR unset',
        source: 'CC §1 [D-settings][D-dir][L-fs]' },
      { kind: 'outbound-write', path: '$TMPDIR/claude-<uid>/ (or CLAUDE_CODE_TMPDIR)', class: 'history',
        note: 'images/ per session after 2.1.274; session scratchpads', source: 'CC §1 [D-dir], re-read 2026-10-22' },
    ],
  },

  // Path classes (§9.1), relative to harness_path. Patterns match path segments; `*` matches
  // within one segment. The first rule that matches an entry gives its class. A `descend`
  // rule classifies nothing itself and sends the walk into the directory. An entry no rule
  // matches is `unknown` and is reported, never hidden (§9.4 rule 1).
  paths: [
    { pattern: '.harness-skeleton', class: 'skeleton', source: 'design note v0.2 §9.3' },

    { pattern: 'projects', descend: true },
    { pattern: 'projects/*', descend: true },
    { pattern: 'projects/*/memory', class: 'history', source: 'CC §20 [D-mem]' },
    { pattern: 'projects/*/*.jsonl', class: 'sessions', source: 'CC §1, §16 [D-dir][D-sess]' },
    { pattern: 'projects/*/*', kind: 'dir', class: 'sessions', note: '<session-id>/subagents/, <session-id>/tool-results/',
      source: 'CC §1, §16 [D-dir][D-sess]' },

    { pattern: 'plugins', descend: true },
    { pattern: 'plugins/cache', class: 'cache', source: 'CC §1 [D-plug]' },
    { pattern: 'plugins/*', class: 'config', source: 'CC §1 [D-plug]' },

    { pattern: 'settings.json', class: 'config', source: 'CC §1 [D-settings]' },
    { pattern: 'settings.local.json', class: 'config', source: 'CC §1 [D-perm]' },
    { pattern: 'CLAUDE.md', class: 'config', source: 'CC §1 [D-mem]' },
    { pattern: 'rules', class: 'config', source: 'CC §1 [D-mem]' },
    { pattern: 'skills', class: 'config', source: 'CC §1 [D-skills][D-dir]' },
    { pattern: 'hs-run', class: 'config', note: 'harness-skeleton\'s bound copies of the processes a plan persisted (status line, MCP servers, hooks); owner-only; Claude Code does not read it', source: 'design note v0.2 §7.5' },
    { pattern: 'commands', class: 'config', source: 'CC §1 [D-dir]' },
    { pattern: 'agents', class: 'config', source: 'CC §1 [D-dir]' },
    { pattern: 'output-styles', class: 'config', source: 'CC §1, §20 [D-os]' },
    { pattern: 'workflows', class: 'config', source: 'CC §1, §20 [D-dir]' },
    { pattern: 'themes', class: 'config', source: 'CC §1, §20 [D-dir]' },
    { pattern: 'keybindings.json', class: 'config', source: 'CC §1, §20 [D-kb]' },
    { pattern: '.claude.json', class: 'config', mixed: ['runtime', 'history'],
      note: 'user MCP servers; account state, per-project trust and history', source: 'CC §1 [D-settings]' },
    { pattern: 'backups', class: 'config', mixed: ['runtime', 'history'], note: 'earlier versions of .claude.json',
      source: 'CC §1 [D-dir]' },

    { pattern: 'history.jsonl', class: 'history', source: 'CC §1 [D-dir]' },
    { pattern: 'file-history', class: 'history', source: 'CC §1, §20 [D-dir]' },
    { pattern: 'plans', class: 'history', source: 'CC §1, §20 [D-dir]' },
    { pattern: 'tasks', class: 'history', source: 'CC §1, §20 [D-dir]' },
    { pattern: 'todos', class: 'history', note: 'legacy, no longer written', source: 'CC §1, §20 [D-dir]' },
    { pattern: 'agent-memory', class: 'history', source: 'CC §1, §20 [D-sub]' },
    { pattern: 'uploads', class: 'history', source: 'CC §1 [D-dir]' },
    { pattern: 'image-cache', class: 'history', note: 'images of 2.1.274 and earlier', source: 'CC §1 [D-dir]' },
    { pattern: 'feedback', class: 'history', source: 'CC §1 [D-dir]' },
    { pattern: 'usage-data', class: 'history', source: 'CC §1 [D-dir]' },

    { pattern: '.credentials.json', class: 'credentials', source: 'CC §1 [D-auth]' },

    { pattern: 'paste-cache', class: 'cache', source: 'CC §1 [D-dir]' },
    { pattern: 'stats-cache.json', class: 'cache', source: 'CC §1 [D-dir]' },
    { pattern: 'cache', class: 'cache', source: 'CC §1 [D-dir]' },
    { pattern: 'remote-settings.json', class: 'cache', note: 'server-managed settings, cached', source: 'CC §1, §2 [D-dir][D-managed]' },
    { pattern: 'policy-limits*.json', class: 'cache', source: 'CC §1 [D-dir]' },
    { pattern: 'statsig', class: 'cache', note: 'legacy, no longer written', source: 'CC §1 [D-dir]' },

    { pattern: 'sessions', class: 'runtime', note: 'sessions/<pid>.json per running process, removed on exit',
      source: 'CC §1 [D-dir]' },
    { pattern: 'session-env', class: 'runtime', source: 'CC §1 [D-dir]' },
    { pattern: 'shell-snapshots', class: 'runtime', source: 'CC §1 [D-dir]' },
    { pattern: '.claude.json.lock', class: 'runtime', source: 'CC §1 [L-fs]' },
    { pattern: '.claude.json.tmp.*', class: 'runtime', note: 'atomic-rename temps', source: 'CC §1 [L-fs]' },
    { pattern: 'jobs', class: 'runtime', source: 'CC §1 [D-av]' },
    { pattern: 'daemon', class: 'runtime', source: 'CC §1 [D-av]' },

    { pattern: 'debug', class: 'logs', source: 'CC §1 [D-dir]' },
    { pattern: 'daemon.log', class: 'logs', source: 'CC §1 [D-av]' },
    { pattern: 'logs', class: 'logs', note: 'legacy, no longer written', source: 'CC §1 [D-dir]' },
  ],

  // The layers a launch in one working directory adds above the folder, highest first
  // [CC §2]: local settings at the git root (the main checkout for a worktree), then project
  // settings in the working directory. observe --cwd reads them.
  cwd_layers: [
    { source: 'local', file: '.claude/settings.local.json', at: 'git-root', note: 'written at the git repo root (2.1.211+), main checkout for worktrees', cite: 'CC §2 [D-settings]' },
    { source: 'project', file: '.claude/settings.json', at: 'cwd', note: 'read from the session\'s primary working directory', cite: 'CC §2 [D-settings]' },
  ],
  git_root_marker: '.git',

  // What a launch carries (§4, §7.1 launch-spec). --settings merges as a level above the folder
  // and the project files [CC §2], so a value given there wins at launch ("launch wins", §7.2).
  launch: {
    settings_flag: '--settings',
    // Skills at launch: one session-only plugin directory, `--plugin-dir <dir>` (repeatable; a
    // directory or a .zip) [CC §10 L-help @2.1.307]. Its manifest names the plugin, and a plugin's
    // skills are namespaced `/<plugin>:<skill>` [CC §9 D-skills, §10 D-plug manifest]. Observed on a
    // bench, 2.1.307: a skill so passed reaches the request as `<plugin>:<name>`, and nothing is
    // copied into the data folder [CC §9 B-skills].
    plugin: { flag: '--plugin-dir', name: 'hs', manifest: '.claude-plugin/plugin.json', skills_dir: 'skills' },
    // MCP servers at launch: one file in the mcpServers form, `--mcp-config <file>`, not strict, so
    // the folder's own servers still load [CC §8 L-help]. Server fields: type, command, args, env,
    // url, headers; no working directory [CC §8 D-mcp]. `${VAR}` is expanded in command, args, env,
    // url and headers, and a credential-named variable reads as empty in a remote url or header
    // [CC §8 D-mcp §Environment variable expansion], so a ref reaches a server as `${HS_REF_<ref>}`,
    // a name no credential list holds, which the caller fills from the reference (env_from_refs).
    // The status line at launch: `statusLine: {type: "command", command, refreshInterval}` in the
    // --settings overlay [CC §13 D-sl][CC §2]. Its input is Claude Code's status-line JSON, which
    // the canonical input is a subset of, so it passes through (§5.9). It has no environment field.
    // Under materialize the process's directory is copied into hs-run/statusline/ (§7.5).
    statusline: { settings_key: 'statusLine', type: 'command', persist_root: 'hs-run' },
    hooks: CLAUDE_CODE_HOOKS,
    // Under materialize a server persists in user scope, .claude.json's top-level mcpServers
    // [CC §8 D-mcp §User scope], its directory bound by copy into hs-run/ (§7.5).
    mcp: { flag: '--mcp-config', file: 'mcp.json', ref_prefix: 'HS_REF_', fields: ['type', 'command', 'args', 'env', 'url', 'headers'], persist: { file: '.claude.json', key: 'mcpServers', root: 'hs-run' } },
    headless: {
      argv: ['-p', '--output-format', 'json'],
      result: '0 on success, non-zero on failure, 143 on SIGTERM; -p silently ignores an invalid settings file',
      source: 'CC §17 [D-hl][L-help]',
    },
    // [state] items a launch carries: retention in the --settings file, no transcript or prompt
    // history through the environment [CC §16].
    state: {
      retention_days: { settings_key: 'cleanupPeriodDays' },
      sessions_none: { env: { CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' }, headless_argv: ['--no-session-persistence'] },
    },
    cwd: [],
    // Model roles (§5.2) [CC §5, §19]: the primary model by flag, the others by variable. Under
    // materialize they also persist: `model`, and the variables in settings.json's env block.
    roles: {
      primary: { flag: '--model', settings_key: 'model', cite: 'CC §5 [D-model]' },
      small: { env: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', cite: 'CC §5, §19 [D-model]' },
      subagent: { env: 'CLAUDE_CODE_SUBAGENT_MODEL', cite: 'CC §5, §19 [D-env][D-model]' },
      effort: { env: 'CLAUDE_CODE_EFFORT_LEVEL', cite: 'CC §5, §19 [D-model]' },
    },
    // The wire Claude Code speaks, and how an endpoint reaches it (§5.2) [CC §6, §19]. The
    // credential is a reference the caller resolves into the variable at launch; hs never does.
    wire: 'anthropic-messages',
    endpoint: {
      base_url_env: 'ANTHROPIC_BASE_URL',
      auth: { bearer: 'ANTHROPIC_AUTH_TOKEN', 'x-api-key': 'ANTHROPIC_API_KEY' },
      cite: 'CC §6 [D-env][D-gw]',
    },
    // A launch with an endpoint unsets every other credential and provider variable, in every
    // login mode: each of these outranks or competes with the supplied one, and would otherwise be
    // sent to the endpoint [CC §7 precedence, §6, §19 D-env]. The one the caller fills is kept.
    // The federation variables (precedence 6) are not named in the source; they rank below both
    // supplied variables, so they lose to it [CC §7].
    // The cloud switches are also cancelled in the --settings overlay, with "", which cancels an
    // inherited value for provider selection [CC §19]: --settings is the command-line level, above
    // local, project and user settings [CC §2], so a switch a settings file sets is cancelled too.
    cancel_switches: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS'],
    endpoint_unset: [
      'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'ANTHROPIC_VERTEX_PROJECT_ID',
      'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_KEY', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    ],
    // A stored login in the folder can reach the endpoint: under token auth, Claude Code's 401
    // recovery adopts a differing stored accessToken over the env token [CC §7, observed]. So an
    // endpoint launch, and an endpoint plan, are refused while the folder holds one (login.js).
    // The file is checked by name. On macOS the login keychain item is keyed to the folder:
    // `Claude Code-credentials-<first 8 hex of sha256 of the path as given>`, and
    // `Claude Code-credentials` for the default folder (observed, undocumented [CC §7]); its
    // presence is asked by service name, its secret never read. `oauthAccount` in .claude.json is
    // the trace a claude.ai login leaves: where the keychain cannot be asked, it counts as a login.
    // Settings `env` overwrites the shell [CC §19 D-env §Precedence], so the folder's settings.json
    // is checked for credential variables by key name.
    stored_login: {
      files: ['.credentials.json'],
      settings_env: { file: 'settings.json', key: 'env', vars: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY'] },
      settings_unverified: 'project and local settings in the working directory, and managed settings, can also set a credential variable in env, which outranks the one the caller fills; hs reads only the folder\'s settings.json at launch-spec',
      keychain: { service: 'Claude Code-credentials', hex: 8, default_folder: '.claude', platforms: ['darwin'] },
      account_trace: { file: '.claude.json', key: 'oauthAccount' },
      cite: 'CC §7 [D-auth][D-ti][L-fs], observed',
    },
  },

  // What delivery may write (§7.2), the floor every write handler checks: JSON files with the
  // keys allowed in each (`*` for a pure config file; a mixed file would name its keys), and
  // the roots under which whole trees are installed, one directory deep.
  writable: {
    // Credentials are never written to a file (§5.3): the variables and the helper that carry
    // one stay out of settings.json whatever an operation asks.
    // Nor the routing variables: a persisted base URL or cloud switch would send every bare start
    // in the folder, with the folder's own login, somewhere else.
    // Persisted hooks set single elements of settings.json's hooks.<Event> arrays, never the
    // whole array (the user's own groups stay byte for byte); an element is ours when its JSON
    // carries the marker of its bound tree, /hs-run/<item>/ (design note §7.5).
    json: { 'settings.json': { keys: '*', elements: ['hooks/*'], never: [
      'env/ANTHROPIC_AUTH_TOKEN', 'env/ANTHROPIC_API_KEY', 'env/CLAUDE_CODE_OAUTH_TOKEN', 'env/AWS_BEARER_TOKEN_BEDROCK', 'env/ANTHROPIC_FOUNDRY_API_KEY', 'apiKeyHelper',
      'env/ANTHROPIC_BASE_URL', 'env/CLAUDE_CODE_USE_BEDROCK', 'env/CLAUDE_CODE_USE_VERTEX', 'env/CLAUDE_CODE_USE_FOUNDRY', 'env/CLAUDE_CODE_USE_ANTHROPIC_AWS',
    ] },
    // A mixed file: delivery clears only the cached account state (account_state below), the one
    // named state write (§7.2), and writes only user-scope MCP servers, one key per server,
    // `mcpServers/<id>` [CC §8 D-mcp §User scope] (design note §7.5, persisted MCP).
    '.claude.json': { keys: ACCOUNT_STATE_KEYS, clear_only: ACCOUNT_STATE_KEYS, prefixes: ['mcpServers/'] } },
    // hs-run/<item>/: the bound copies of the processes a plan persists (status line, MCP servers,
    // hooks), owner-only (design note §7.5, bind by copy).
    trees: ['skills', 'hs-run'],
    // Which element of a hooks array is hs's for an id: by its shape and its closing comment for
    // that hook's copy in this folder (the hook table's persist.owns), never by a string found
    // anywhere in it. `folder` is the bound folder's real path, as persistedHook writes it.
    element_owner: (v, { id, folder, key }) => CLAUDE_CODE_HOOKS.persist.owns(v, { copy: path.join(folder, 'hs-run', id), event: key.split('/').at(-1) }),
    private: ['hs-run'],
    // A name starting with . is never a tree (skills/.trash is Claude Code's own), and these skill
    // names are reserved: claude.ai-synced skills live in skills/synced [CC §9 D-skills, D-dir].
    reserved: { skills: ['synced', 'anthropic-skills', 'claude-ai'] },
    reserved_source: 'CC §1, §9 [D-skills][D-dir][D-cl 2.1.282]',
  },

  // Cached claude.ai account state in .claude.json. Claude Code turns on its claude.ai-hosted
  // tools (Artifact and friends) from it whatever ANTHROPIC_BASE_URL says, and at least one
  // third-party backend rejects their schema (GLM, 400 code 1210, since 2.1.265) [CC §6 cpb]. A
  // plan for a spec with an endpoint clears these keys. Observed on a bench, 2.1.307: endpoint
  // starts do not write them back, and a planted account's ids did not reach the endpoint
  // [CC §7 B-account].
  account_state: { file: '.claude.json', keys: ACCOUNT_STATE_KEYS, source: 'CC §6 [cpb §Authentication preparation], CC §7 [B-account]' },

  // The [state] items (§5.12) and how this harness expresses them.
  state: {
    retention_days: {
      expressible: true,
      native: 'cleanupPeriodDays',
      harness_default: 30,
      minimum: 1,
      source: 'CC §16 [D-sref §cleanupPeriodDays][D-dir], re-read 2026-10-22; measured on 2.1.307',
    },
    sessions: {
      expressible: true,
      harness_default: 'keep',
      launch_only: ['CLAUDE_CODE_SKIP_PROMPT_HISTORY=1', '--no-session-persistence (with -p)'],
      source: 'CC §16',
    },
    prompt_history: {
      expressible: false,
      harness_default: 'keep',
      reason: 'the one switch, CLAUDE_CODE_SKIP_PROMPT_HISTORY, also stops transcripts',
      source: 'CC §16',
    },
  },

  // Managed policy (§5.12): the first source present wins, unless one sets
  // `managedSourcesBehavior: "merge"` (2.1.242+) [CC §2 D-managed]. Highest first.
  managed: {
    roots: { darwin: '/Library/Application Support/ClaudeCode', linux: '/etc/claude-code' },
    file: 'managed-settings.json',
    dropins: 'managed-settings.d',
    mdm_plists: {
      darwin: ['/Library/Managed Preferences/com.anthropic.claudecode.plist'],
    },
    server_cache: 'remote-settings.json',
    source: 'CC §1, §2 [D-managed]',
  },
});
