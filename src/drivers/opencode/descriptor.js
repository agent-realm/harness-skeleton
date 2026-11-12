// The OpenCode harness descriptor: declarative data, no logic (design note v0.2 §7.3).
// Every fact carries its source:
// - `OC §n`: the 1.18.18 survey, docs/design/surveys/opencode-2026-10-04.md, where 2.x kept it;
// - `G2:<path>`: OpenCode's source at tag v2.2.7, https://github.com/anomalyco/opencode, read
//   2026-11-12;
// - `D2:<page>`: https://opencode.ai/v2/docs/<page>, read 2026-11-12;
// - `T1`: the tier 1 check conformance/tier1/opencode-launch-surface.mjs on 2.2.7, 2026-11-12;
// - `T2`: the tier 1 check conformance/tier1/opencode-persisted.mjs on 2.2.7, 2026-11-12;
// - `T3`: the tier 1 check conformance/tier1/opencode-bridge.mjs on 2.2.7, 2026-11-12.

import { OPENCODE_HOOKS } from '../../shim/opencode-hooks.js';

export default Object.freeze({
  harness: 'opencode',
  name: 'OpenCode',
  binary: 'opencode',
  version_args: ['--version'],

  // Launch (milestone 7.1), and into the folder's own config directory (7.2).
  delivery_modes: ['materialize', 'overlay'],

  // The 2.x line, from the release measured [T1]. 1.x is out of range: its `run` has no
  // --standalone, and a launch with the 2.x config never reaches the model [T1, 1.19.5]; 2.x
  // renamed the config keys (permissions, agents, commands, plugins, providers [D2:config]).
  versions: {
    certified: [],
    compatible: { min: '2.2.7', below: '2.3.0' },
    note: '1.x (npm opencode-ai) is out of range: its run has no --standalone, and the 2.x config never reaches the model (tier 1, 1.19.5, 2026-11-12); 2.x is the npm package @opencode/cli',
  },

  binding: {
    // OpenCode keeps everything in the four XDG roots, each with opencode/ appended
    // [G2:packages/util/src/global-roots.ts]: the data folder holds config/, data/, cache/ and
    // state/, one per root (design note §1, "data folder").
    env_set: { XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' },
    // Variables that add a config layer or move a store from the host shell [G2:packages/cli/src/
    // server-process.ts; G2:packages/core/src/config.ts; OC §1, §19]. The launch sets its own.
    env_unset: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'OPENCODE_DB', 'OPENCODE_AUTH_CONTENT'],
    // No single default folder: the default is the user's own four XDG roots [OC §1].
    default_folder: null,
    escapes: [
      // Known limits: a launch cannot close them, and observe --state reports them when present.
      { kind: 'inbound-read', path: '~/.agents/skills', class: 'config', closable: false, when: 'present', known_limit: true,
        note: 'a "Global compatibility" skill root with no switch in 2.x; its skills reach every launch, whatever the folder',
        source: 'D2:skills; G2:packages/cli/src/server-process.ts (only OPENCODE_DISABLE_CLAUDE_CODE(_SKILLS), which gates .claude); T1' },
      { kind: 'outbound-write', path: '~/.opencode/', class: 'config', closable: false, when: 'present', known_limit: true,
        note: 'when it exists, OpenCode reads it as a config directory and writes a .gitignore into it, outside the data folder',
        source: 'T1 (~/.opencode/.gitignore written); OC §1' },
      { kind: 'inbound-read', path: '~/.claude/skills', class: 'config', closable: true,
        note: 'closed: every launch sets OPENCODE_DISABLE_CLAUDE_CODE', source: 'D2:skills; G2:packages/cli/src/server-process.ts; T1 (~/.claude/CLAUDE.md does not reach)' },
      { kind: 'outbound-write', path: '$TMPDIR/opencode', class: 'runtime', closable: false,
        note: 'its temp root', source: 'G2:packages/util/src/global-roots.ts' },
      { kind: 'inbound-read', path: '/etc/opencode/', class: 'config', closable: false, platforms: ['linux'],
        note: 'the system config, above every user layer', source: 'D2:config' },
      { kind: 'inbound-read', path: '/Library/Application Support/opencode/', class: 'config', closable: false, platforms: ['darwin'],
        note: 'the system config, above every user layer', source: 'D2:config' },
      { kind: 'inbound-read', path: '/Library/Managed Preferences/ai.opencode.managed.plist', class: 'config', closable: false, platforms: ['darwin'],
        note: 'MDM managed preferences, the highest layer', source: 'D2:config' },
      { kind: 'child-env', path: 'XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME', class: 'config', closable: false,
        note: 'tool shells, MCP servers and git inherit the relocated roots; a bridge plugin could restore them (design note §8), not in this build', source: 'OC §1' },
    ],
  },

  // Path classes (§9.1), relative to harness_path: the four roots, each with opencode/ inside.
  // Names written by a run [T1] and the survey's 1.x layout where 2.x kept it [OC §1, §20].
  paths: [
    { pattern: '.harness-skeleton', class: 'skeleton', source: 'design note v0.2 §9.3' },
    { pattern: 'hs-run', class: 'config', note: 'the bound copies of the processes a plan persists', source: 'design note v0.2 §7.5' },
    { pattern: 'config', descend: true },
    { pattern: 'config/opencode', class: 'config', source: 'OC §1; T1' },
    { pattern: 'data', descend: true },
    { pattern: 'data/opencode', descend: true },
    { pattern: 'data/opencode/opencode.db*', class: 'sessions', mixed: ['credentials'], note: 'sessions, and in 2.x the logins (the credential import reads auth.json into it)', source: 'G2:packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts; T1' },
    { pattern: 'data/opencode/auth.json', class: 'credentials', note: '1.x login file, imported into opencode.db by 2.x', source: 'OC §7; G2:packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts' },
    { pattern: 'data/opencode/mcp-auth.json', class: 'credentials', note: '1.x MCP OAuth tokens', source: 'OC §7' },
    { pattern: 'data/opencode/log', class: 'logs', source: 'OC §1; T1' },
    { pattern: 'data/opencode/repos', class: 'cache', note: 'cloned references', source: 'OC §20; T1' },
    { pattern: 'data/opencode/*', class: 'runtime', note: 'other entries a run writes (shell/ in 2.2.7)', source: 'T1' },
    { pattern: 'cache', descend: true },
    { pattern: 'cache/opencode', class: 'cache', source: 'OC §1; T1' },
    { pattern: 'state', descend: true },
    { pattern: 'state/opencode', class: 'runtime', note: 'service.json, the background service registration, among others', source: 'G2:packages/cli/src/services/service-config.ts; T1' },
  ],

  // What a launch carries (§4, §7.1 launch-spec). There is no settings flag: an inline config layer
  // (OPENCODE_CONFIG_CONTENT) and an extra config directory (OPENCODE_CONFIG_DIR), above the user
  // and project config and below the system and managed layers [D2:config; G2:packages/core/src/
  // config.ts; G2:packages/cli/src/server-process.ts; T1].
  launch: {
    // A run uses the folder's background service when one is up, and runs on that service's
    // config, not the launch's [G2:packages/cli/src/commands/handlers/run.ts; T1]; --standalone
    // runs "with a private server instead of the background service" (`run --help`). So every
    // launch, interactive or headless, passes it.
    standalone: '--standalone',
    interactive: { argv: ['--standalone'] },
    headless: {
      argv: ['run', '--standalone', '--format', 'json'],
      result: 'exit 1 when the run fails, the model refusing included; one JSON object per line on stdout',
      source: 'OC §17; T1',
    },
    config_content_env: 'OPENCODE_CONFIG_CONTENT',
    config_dir_env: 'OPENCODE_CONFIG_DIR',
    // Set on every launch: closes the .claude skill roots [G2:packages/cli/src/server-process.ts].
    always_env: { OPENCODE_DISABLE_CLAUDE_CODE: '1' },
    cwd: [],
    roles: {
      primary: { flag: '-m', cite: 'OC §5; `run --help` (provider/model#variant)' },
      small: { unsupported: 'OpenCode 2.x lists no small-model key in its config [D2:config]' },
      subagent: { unsupported: 'OpenCode 2.x has no subagent model role in its config; a subagent sets its own model [D2:config]' },
      effort: { unsupported: 'OpenCode takes a model variant (provider/model#variant), whose names are the provider\'s; this build does not map effort onto one' },
    },
    // An endpoint becomes a provider of its own for the launch, `providers.<id>` in the inline
    // layer: `package` picks the runtime, `settings.baseURL` the endpoint, and `env` names the
    // variable that holds the key [D2:providers]. Measured on the OpenAI Chat wire: the key goes
    // out as a bearer token [T1]. The model is then `<id>/<model>`.
    wire: 'openai-chat',
    endpoint: {
      provider_id: 'hs',
      key_env: 'HS_ENDPOINT_KEY',
      package: '@opencode/ai/providers/openai-compatible',
      auth: ['bearer'],
      cite: 'D2:providers; T1',
    },
    endpoint_unset: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY'],
    // With an endpoint the launch names its provider and model itself, so OpenCode's model catalog
    // (models.opencode.ai, asked for on every start [T3]) is not fetched: a launch contacts only what
    // the spec names. OPENCODE_DISABLE_MODELS_FETCH turns the fetch off [G2:packages/cli/src/
    // server-process.ts]; measured, with the network blocked, the explicit provider and model still
    // reach the endpoint and no host is asked for [T1].
    no_catalog_env: 'OPENCODE_DISABLE_MODELS_FETCH',
    // What a launch contacts on the network, by host, as describe reports it.
    network: {
      with_endpoint: 'the endpoint only: no model catalog fetch (OPENCODE_DISABLE_MODELS_FETCH)',
      without_endpoint: 'OpenCode\'s model catalog, models.opencode.ai, and the providers the folder\'s config names',
      source: 'tier 1, opencode-launch-surface and opencode-bridge, 2.2.7, 2026-11-12',
    },
    // 2.x keeps logins in opencode.db, which also holds the sessions, and imports a 1.x auth.json
    // into it on start [G2:packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts].
    stored_login: {
      files: ['data/opencode/auth.json'],
      unverified: 'OpenCode 2.x keeps its logins in data/opencode/opencode.db, which also holds the sessions; hs never opens a credential store to check it, so a folder that was ever logged in must not be used for an endpoint launch',
      cite: 'OC §7; G2:packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts',
    },
    // MCP servers: `mcp.servers.<name>` (2.x no longer puts names directly under `mcp`); local
    // {type, command (an array), environment, cwd}, remote {type, url, headers, oauth} [D2:mcp-servers].
    // Measured: a local server in the inline layer starts, and its tool reaches the model [T1].
    // OpenCode substitutes {env:VAR} and {file:path} in the config text before parsing it, keys
    // included [D2:config; G2:packages/core/src/config/variable.ts]: a ref reaches a server as
    // {env:HS_REF_<ref>}, which the caller fills from the reference, and {env:…} or {file:…} in any
    // string or key the spec provides is refused, as ${…} is on Claude Code (§5.3).
    mcp: {
      config_key: 'mcp', servers_key: 'servers', ref_prefix: 'HS_REF_', transports: ['http'],
      id: /^[A-Za-z0-9_-]+$/,
      unverified: 'a server of the same name in the system or managed config, or MDM, outranks the launch\'s [D2:config]; hs does not read those layers',
    },
    // Skills and AGENTS.md go into a config directory in the launch's temp dir: its skills/ are
    // discovered, and its AGENTS.md replaces the global one [OC §3; T1].
    skills: { dir: 'skills' },
    agents_md: 'AGENTS.md',
    statusline: { supported: false, reason: 'OpenCode has no configurable status line [OC §13]' },
    // Hooks (milestone 7.3): OpenCode 2.x has no command hooks, only plugin functions [D2:plugins].
    // hs's bridge plugin, written into the launch's config directory, runs hs's hook shim for each
    // spec hook (src/shim/opencode-bridge.js). Only the two tool hooks carry a spec event; only
    // execute.before can refuse [G2:packages/core/src/plugin/hooks.ts; T3].
    hooks: OPENCODE_HOOKS,
    bridge: {
      file: 'plugins/hs-hooks.js',
      id: 'hs-hooks',
      on: { PreToolUse: 'execute.before', PostToolUse: 'execute.after' },
      // Why the other events have no route, by name (§5.10: refused when required, skipped when
      // if-supported) [G2:packages/plugin/src/effect/session.ts SessionHooks, packages/core/src/plugin/hooks.ts].
      events_refused: {
        UserPromptSubmit: 'OpenCode 2.x\'s session.prompt hook can rewrite a prompt but not refuse it (only tool execute.before may fail), so a guard here would not block',
        Stop: 'OpenCode 2.x\'s nearest hook, session experimental.idle, is experimental and cannot refuse',
        PreCompact: 'OpenCode 2.x\'s session.compaction hook can replace a compaction but not refuse it',
        PermissionRequest: 'OpenCode 2.x\'s permission.evaluate runs for every rule evaluation, not only a prompt, and carries an action and resources, not a tool call; not mapped in this build',
      },
      no_hook: 'OpenCode 2.x has no plugin hook for this event; it reaches a plugin only through the event stream, which cannot answer',
      may_allow: 'an allow on OpenCode would go through permission.evaluate, which this build does not carry; a hook may deny only',
      mcp_match: 'OpenCode names an MCP tool <server>_<tool>, every character outside [A-Za-z0-9_-] made _, so a server match cannot be exact: server a would also match server a_b\'s tools [G2:packages/core/src/tool/runtime.ts effectiveName; T3]',
      context: 'a hook\'s context output is not delivered: no OpenCode plugin hook takes it',
      mcp_class: 'an MCP tool reaches a hook as <server>_<tool>, which hs cannot tell from another tool\'s name, so its envelope has tool.class null and no tool.input.mcp [T3]',
      fail_closed: 'a PreToolUse hook fails closed in every way the bridge can see: the shim exiting other than 0 or 2, dying by a signal, failing to start, or still running at the hook\'s limit plus the margin (its process group killed)',
      load: 'if the bridge plugin fails to load, OpenCode starts without it and no hook runs',
      source: 'G2:packages/core/src/plugin/hooks.ts, packages/plugin/src/promise/adapter.ts, packages/core/src/tool.ts; T3',
    },
  },

  // Under materialize (milestone 7.2): the folder's own config directory, config/opencode/, which
  // a start reads under the launch's inline layer: its opencode.json, its skills/ (T2: tier 1,
  // conformance/tier1/opencode-persisted.mjs on 2.2.7, 2026-11-12). A start leaves opencode.json as
  // written and adds nothing beside it [T2]. An opencode.jsonc there outranks opencode.json for a
  // key both hold [T2; OC §2], so a plan refuses to write while one is there. A running background
  // service picks up a change without a restart [T2], so a plan needs no quiet folder. The endpoint
  // and the login never persist (§5.2), nor AGENTS.md in this build: launch only.
  persist: {
    config_file: 'config/opencode/opencode.json',
    jsonc_file: 'config/opencode/opencode.jsonc',
    skills_dir: 'config/opencode/skills',
    mcp_key: 'mcp/servers',
    model_key: 'model',
    root: 'hs-run',
    jsonc_reason: 'the folder\'s config/opencode/opencode.jsonc outranks opencode.json, which hs writes, for any key both hold (tier 1, opencode-persisted, 2.2.7); move its settings into opencode.json, or deliver at launch',
  },
  writable: {
    json: { 'config/opencode/opencode.json': { keys: ['model'], prefixes: ['mcp/servers/'] } },
    trees: ['config/opencode/skills', 'hs-run'],
    private: ['hs-run'],
  },

  state: {
    retention_days: { expressible: false, harness_default: null, reason: 'OpenCode documents no age sweep of its sessions [OC §16]', source: 'OC §16' },
    sessions: { expressible: false, harness_default: 'keep', reason: 'OpenCode has no switch that keeps a session from being recorded [OC §16]', source: 'OC §16' },
    prompt_history: { expressible: false, harness_default: 'keep', reason: 'OpenCode has no switch for its prompt history [OC §16, §20]', source: 'OC §16' },
  },
});
