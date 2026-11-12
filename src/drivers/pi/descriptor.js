// The pi harness descriptor: declarative data, no logic (design note v0.2 §7.3).
// Every fact carries its source:
// - `PI §n`: the survey, docs/design/surveys/pi-2026-10-04.md (0.80.2, upstream 1.0.2), where 1.5 kept it;
// - `P15:<doc>`: the docs shipped in @earendil-works/pi-coding-agent@1.5.2 (docs/<doc>.md), read
//   2026-11-12; `P15:dist/<file>` its shipped code;
// - `T1`: the tier 1 check conformance/tier1/pi-launch-surface.mjs on 1.5.2, 2026-11-12;
// - `T2`: the tier 1 check conformance/tier1/pi-hooks.mjs on 1.5.2, 2026-11-12;
// - `T3`: the tier 1 check conformance/tier1/pi-persisted.mjs on 1.5.2, 2026-11-12.

import { PI_HOOKS } from '../../shim/pi-hooks.js';

export default Object.freeze({
  harness: 'pi',
  name: 'pi',
  binary: 'pi',
  version_args: ['--version'], // prints `1.5.2` [T1]

  // Launch (milestone 8.1), and into the folder, the agent dir itself (8.3).
  delivery_modes: ['materialize', 'overlay'],

  // The 1.5 line, from the release measured [T1]. 0.x is out of range: before 0.99 there is no
  // built-in MCP, before 0.84.3 a model switch rewrites the global settings, before 0.86 user_bash
  // fails open, and 0.x events differ from 1.x [PI §21]. 1.x ships a minor every week or two, most
  // with breaking notes [P15:CHANGELOG], so the range widens one minor at a time, each with a tier 1
  // run.
  versions: {
    certified: [],
    compatible: { min: '1.5.2', below: '1.6.0' },
    note: '0.x is out of range: no built-in MCP before 0.99, model switches rewrite the global settings before 0.84.3, and its extension events differ [PI §21]; the range widens one minor at a time, each with a tier 1 run',
  },

  // Strict isolation (§8): three switches keep out every skill root, context file and project
  // resource the spec does not name, while explicit --skill and --append-system-prompt still load
  // [P15:cli; tier 1, isolation-canaries, strict-isolation]. They keep the folder's own context
  // files and skills out too. What no switch keeps out without dropping hs's own extension is
  // refused when the folder holds it [P15:configuration; P15:settings (Resources)].
  isolation: {
    strict: {
      argv: ['--no-skills', '--no-context-files', '--no-approve'],
      how: '--no-skills, --no-context-files and --no-approve; the spec\'s skills by --skill, its AGENTS.md by --append-system-prompt',
      folder: 'the folder\'s own context files and skills are kept out too; a skill a plan of this spec installed is passed again with --skill',
      refuses: { files: ['SYSTEM.md', 'APPEND_SYSTEM.md'], dirs: ['extensions'], settings_keys: ['extensions', 'packages'] },
      refuses_text: ['SYSTEM.md or APPEND_SYSTEM.md, instructions pi reads from the folder', 'an entry in extensions/, or an extensions or packages list in settings.json: code pi loads from the folder', 'an mcp.json server no plan of this spec installed'],
    },
  },

  binding: {
    // One root holds settings, logins, MCP servers, instructions, resources and sessions
    // [P15:configuration; PI §1]. Sessions stay in it while PI_CODING_AGENT_SESSION_DIR is unset
    // [P15:environment-variables; T1].
    env_set: 'PI_CODING_AGENT_DIR',
    env_unset: ['PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR', 'PI_SELF_UPDATE_COMMAND'],
    default_folder: '~/.pi/agent',
    escapes: [
      // Known limits: a launch cannot close them, and observe --state reports them.
      { kind: 'inbound-read', path: '~/.agents/skills', class: 'config', closable: false, when: 'present', known_limit: true,
        strict: 'under isolation = "strict", --no-skills, the spec\'s skills passed with --skill (tier 1, isolation-canaries)',
        note: 'a skill root read from $HOME, not the folder; its skills reach every launch',
        source: 'PI §1, §9; P15:skills; T1' },
      { kind: 'inbound-read', path: 'AGENTS.md and CLAUDE.md in the working directory and every parent', class: 'config', closable: false, known_limit: true,
        strict: 'under isolation = "strict", --no-context-files, the spec\'s AGENTS.md passed with --append-system-prompt (tier 1, isolation-canaries)',
        note: 'context files load from the working directory up to /, with no trust needed; --no-context-files would also drop the folder\'s own',
        source: 'P15:configuration (Context files); T1' },
      { kind: 'inbound-read', path: '.pi/ in the working directory', class: 'config', closable: false, known_limit: true,
        strict: 'under isolation = "strict", --no-approve, so no project resource loads, trusted or not (P15:cli)',
        note: 'the project\'s settings, mcp.json, extensions, skills, prompts, themes and system-prompt files load once the project is trusted; a launch leaves the decision to pi (a saved decision in the folder\'s trust.json, else defaultProjectTrust), and observe --state --cwd says whether a trusted project .pi/ is there',
        source: 'P15:security (project trust); P15:dist/core/trust-manager.js; T1 (skipped in JSON mode by default)' },
      { kind: 'inbound-read', path: '~/.pi/agent', class: 'config', closable: true,
        note: 'closed: PI_CODING_AGENT_DIR replaces the default root', source: 'P15:configuration; T1' },
      { kind: 'outbound-write', path: '.pi/settings.json sessionDir in the working directory', class: 'sessions', closable: false, known_limit: true,
        closed_by: 'launch-spec given the working directory (cwd): --session-dir <folder>/sessions/<pi\'s own group for it>, which a project\'s sessionDir cannot outrank (launch.session_dir)',
        note: 'pi reads a project\'s sessionDir before it resolves project trust, so --no-approve does not stop it: a project can move session writes out of the folder',
        source: 'P15:security (project trust is not a complete startup boundary); P15:configuration' },
      { kind: 'outbound-write', path: 'the folder\'s settings.json sessionDir', class: 'sessions', closable: false,
        note: 'a sessionDir key moves sessions out of the folder; observe --state reports it when set', source: 'P15:settings; P15:configuration; design note v0.2 §8' },
    ],
  },

  // Path classes (§9.1), relative to harness_path, the agent dir [P15:configuration; PI §1, §20].
  paths: [
    { pattern: '.harness-skeleton', class: 'skeleton', source: 'design note v0.2 §9.3' },
    { pattern: 'hs-run', class: 'config', note: 'harness-skeleton\'s bound copies of the processes a plan persists; owner-only; pi does not read it', source: 'design note v0.2 §7.5' },
    { pattern: 'settings.json', class: 'config', source: 'P15:configuration' },
    { pattern: 'keybindings.json', class: 'config', source: 'P15:configuration' },
    { pattern: 'models.json', class: 'config', source: 'P15:configuration' },
    { pattern: 'mcp.json', class: 'config', source: 'P15:configuration' },
    { pattern: 'trust.json*', class: 'config', note: 'saved project-trust decisions, by directory', source: 'P15:security; P15:dist/core/trust-manager.js' },
    { pattern: 'AGENTS*.md', class: 'config', source: 'P15:configuration' },
    { pattern: 'CLAUDE.md', class: 'config', source: 'P15:configuration' },
    { pattern: 'SYSTEM.md', class: 'config', source: 'P15:configuration' },
    { pattern: 'APPEND_SYSTEM.md', class: 'config', source: 'P15:configuration' },
    { pattern: 'extensions', class: 'config', source: 'P15:configuration' },
    { pattern: 'skills', class: 'config', source: 'P15:configuration' },
    { pattern: 'prompts', class: 'config', source: 'P15:configuration' },
    { pattern: 'themes', class: 'config', source: 'P15:configuration' },
    { pattern: 'auth.json', class: 'credentials', source: 'P15:configuration; PI §7' },
    { pattern: 'mcp-auth.json', class: 'credentials', note: 'MCP OAuth tokens', source: 'PI §8' },
    { pattern: 'sessions', class: 'sessions', source: 'PI §16; T1' },
    { pattern: 'mcp.log', class: 'logs', source: 'PI §8' },
    { pattern: 'pi-debug.log', class: 'logs', source: 'PI §1' },
    { pattern: 'models-store.json', class: 'cache', note: 'the model catalog cache', source: 'PI §20' },
    { pattern: 'npm', class: 'cache', note: 'installed pi packages', source: 'PI §1, §10' },
    { pattern: 'git', class: 'cache', note: 'installed pi packages', source: 'PI §1, §10' },
    { pattern: 'bin', class: 'cache', note: 'managed fd and rg', source: 'PI §1' },
    { pattern: 'tmp', class: 'runtime', source: 'PI §1' },
    { pattern: 'tools', class: 'cache', source: 'PI §1' },
  ],

  // What a launch carries (§4, §7.1 launch-spec), with nothing written into the folder: one
  // extension hs generates in the launch's temp dir, passed with -e, which pi loads and awaits before
  // startup continues; providers and MCP servers it registers are the session's [P15:extensions,
  // P15:custom-provider, P15:mcp; T1]. An -e extension that does not parse stops pi: exit 1, no
  // request [T1].
  launch: {
    interactive: { argv: [] },
    headless: {
      argv: ['--mode', 'json'],
      result: 'exit 0 even when the assistant errors: read the JSONL events on stdout for the outcome; exit 1 on a thrown error or an extension that does not load',
      source: 'PI §17; P15:cli; T1',
    },
    extension: { file: 'hs-launch.js', role: 'extension', flag: '-e' },
    cwd: [],
    roles: {
      primary: { flag: '--model', cite: 'P15:cli' },
      small: { unsupported: 'pi has no small-model role [P15:settings]' },
      subagent: { unsupported: 'pi has no subagents [PI §14]' },
      effort: { unsupported: 'pi takes --thinking levels, which this build does not map onto effort [P15:cli]' },
    },
    // An endpoint becomes a provider the extension registers, `hs`, on the openai-completions API,
    // with its key read from a variable the caller fills; the launch names it with --provider.
    // Measured: the key goes out as a bearer token, and the model is reached [T1].
    wire: 'openai-chat',
    endpoint: {
      provider_id: 'hs',
      api: 'openai-completions',
      key_env: 'HS_ENDPOINT_KEY',
      provider_flag: '--provider',
      auth: ['bearer'],
      cite: 'P15:custom-provider; T1',
    },
    // Every other provider key pi reads from the environment [P15:providers].
    endpoint_unset: [
      'AI_GATEWAY_API_KEY', 'ANT_LING_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'BASETEN_API_KEY',
      'CEREBRAS_API_KEY', 'CLOUDFLARE_API_KEY', 'COPILOT_GITHUB_TOKEN', 'DEEPSEEK_API_KEY', 'FIREWORKS_API_KEY', 'GEMINI_API_KEY',
      'GROQ_API_KEY', 'HF_TOKEN', 'KIMI_API_KEY', 'META_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY', 'MISTRAL_API_KEY',
      'MOONSHOT_API_KEY', 'NVIDIA_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'OPENROUTER_API_KEY', 'QWEN_TOKEN_PLAN_API_KEY',
      'QWEN_TOKEN_PLAN_CN_API_KEY', 'RADIUS_API_KEY', 'TOGETHER_API_KEY', 'TYPESAFE_API_KEY', 'XAI_API_KEY', 'XIAOMI_API_KEY',
      'XIAOMI_TOKEN_PLAN_AMS_API_KEY', 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'XIAOMI_TOKEN_PLAN_SGP_API_KEY', 'ZAI_API_KEY', 'ZAI_CODING_CN_API_KEY',
      'AZURE_OPENAI_API_KEY', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
      'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
    ],
    // With an endpoint, pi's own network off: PI_OFFLINE ("automatic network activity, including
    // model catalog refreshes"), the pi.dev version check, and install telemetry and attribution
    // headers [P15:environment-variables]. Measured: no host is asked for and nothing but loopback
    // is connected to, while the explicit provider still reaches the model [T1].
    endpoint_env: { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
    network: {
      with_endpoint: 'the endpoint only: pi\'s automatic network activity, version check and telemetry off (PI_OFFLINE, PI_SKIP_VERSION_CHECK, PI_TELEMETRY=0)',
      without_endpoint: 'the providers the folder names, and pi\'s own: the pi.dev version check, model catalog refreshes and install telemetry unless the folder turns them off',
      source: 'P15:environment-variables; tier 1, pi-launch-surface, 1.5.2, 2026-11-12',
    },
    // Logins live in auth.json [P15:configuration; PI §7]: an endpoint launch is refused while the
    // folder holds one, so it can never reach the endpoint. pi writes an empty store there on every
    // start, 2 bytes, mode 600 [T1, by its size and mode only]: a file of exactly that size holds no
    // login, told from its metadata; any other size counts as one. The file is never opened.
    stored_login: {
      files: ['auth.json'], empty_bytes: 2, cite: 'P15:configuration; PI §7; T1',
      empty_rule: 'an endpoint launch is refused while the folder holds a login in auth.json; a regular auth.json of exactly 2 bytes is the empty store pi writes on every start (measured on 1.5.2, by size and mode only) and counts as no login; any other size, or a link, counts as a login, so a pi that changes that file is refused, never let through. The file is never opened',
    },
    // MCP servers: pi.registerMcpServer(name, config), the shape of an mcpServers entry, for the
    // session only [P15:mcp]. Measured: a server with exposure "direct" starts and its tool is offered
    // as mcp__<server>__<tool>; with no exposure only codemode is offered, so an exposure is always
    // given; a server of the same name in the folder's mcp.json starts instead [T1].
    mcp: {
      ref_prefix: 'HS_REF_', id: /^[A-Za-z0-9_-]+$/, transports: ['http'], default_exposure: 'direct',
      folder_file: 'mcp.json',
      same_name: 'the folder\'s mcp.json defines a server of this name, which pi starts instead of the one the launch registers (tier 1, pi-launch-surface, 1.5.2)',
      unverified: 'a trusted project .pi/mcp.json server of the same name may outrank the launch\'s too; hs does not know the working directory at launch-spec',
    },
    // What pi interpolates or executes in what a launch hands it [P15:custom-provider, P15:mcp; T1]:
    // a leading `!command` runs in a provider's apiKey and headers, an MCP server's env values and a
    // remote server's headers; `$NAME` and `${NAME}` read the environment there. MCP args and command
    // are measured literal, but a leading `~/` in command, args or cwd names the home directory
    // [P15:mcp]. So spec text with `$` or a leading `!` is refused wherever pi reads it, the
    // endpoint's base_url and model ids included (not measured, refused to be safe), and a leading
    // `~` in command, args or cwd; the only `$` a launch writes is its own $HS_ENDPOINT_KEY and
    // ${HS_REF_<ref>} names.
    interpolation: {
      reason: 'pi runs a leading !command and expands $NAME and ${NAME} in a provider\'s apiKey and headers and an MCP server\'s env and headers (tier 1, pi-launch-surface, 1.5.2), so the text could run a command or read what the receipt did not bind',
      tilde: 'pi expands a leading ~/ in an MCP server\'s command, arguments and working directory to the home directory [P15:mcp]',
    },
    skills: { flag: '--skill', tree: 'skills' },
    // The session's directory (§8). pi keeps a working directory's sessions in
    // <agent dir>/sessions/<group>, the group its own encoding of that directory's path; a session
    // dir given explicitly is used as it is, with no group [P15:dist/core/session-manager.js
    // getDefaultSessionDirPath; P15:dist/utils/paths.js resolvePath; tier 1, pi-session-dir]. Given
    // the working directory, a launch passes --session-dir with that very path, so the layout is
    // pi's own and a project's sessionDir, which pi reads before project trust [P15:security],
    // cannot move the session out of the folder. The encoding is a pi internal: it holds for this
    // descriptor's version range, and tier 1 compares it with the group pi itself writes.
    session_dir: {
      flag: '--session-dir',
      root: 'sessions',
      group: (cwd) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`,
      when: 'launch-spec is given cwd, and the folder\'s settings.json sets no sessionDir',
      coupling: 'the group is pi\'s own encoding of the working directory (getDefaultSessionDirPath), a pi internal hs computes: it holds for the 1.5 line this driver targets, and tier 1 (pi-session-dir) fails, rather than sessions scattering, if a pi changes it',
      unbound: 'no cwd was given, so this launch passes no --session-dir: a .pi/settings.json sessionDir in the directory pi runs in would move the session out of the folder (pi reads it before project trust); give launch-spec the cwd to close it',
      folder_set: 'the folder\'s settings.json sets sessionDir, which this launch leaves as it is (observe --state reports it); a project\'s .pi/settings.json sessionDir can still move the session',
      source: 'P15:dist/core/session-manager.js; P15:dist/utils/paths.js; tier 1, pi-session-dir',
    },
    // AGENTS.md is carried as a system-prompt append, which is not a context file: the folder's own
    // context files still load [P15:cli; T1].
    agents_md: { flag: '--append-system-prompt', file: 'hs-agents.md', role: 'instructions' },
    statusline: { supported: false, reason: 'pi has no status line setting; only an extension can draw one [PI §13]' },
    // Hooks (milestone 8.2): pi has no command hooks, only extension handlers [P15:extensions]. The
    // launch extension runs hs's hook shim for each spec hook (src/drivers/pi/extension-runtime.js),
    // on the pi event its spec event rides on [P15:extensions; T2].
    hooks: PI_HOOKS,
    // Hook behaviours describe names, so they are documented, not a surprise.
    behaviours: {
      Stop: 'a Stop hook that always blocks keeps the run going: each block asks pi for one more run. The hook ends the loop itself through stop_hook_active, which is true when the run it ends was one it asked for, as on Claude Code; hs sets no cap',
    },
    bridge: {
      on: { PreToolUse: 'tool_call', PostToolUse: 'tool_result', UserPromptSubmit: 'input', SessionStart: 'session_start', SessionEnd: 'session_shutdown', Stop: 'agent_before_settle' },
      // Why the other events have no route, by name (§5.10: refused when required, skipped when
      // if-supported).
      events_refused: {
        PermissionRequest: 'pi has no permission prompts [PI §12; P15:security]',
        SubagentStart: 'pi has no subagents [PI §14]',
        SubagentStop: 'pi has no subagents [PI §14]',
        PreCompact: 'pi\'s session_before_compact can cancel a compaction, but this build has not measured it [P15:extensions]',
        PostCompact: 'pi\'s session_compact reports a compaction, but this build has not measured it [P15:extensions]',
      },
      no_hook: 'pi has no extension event for it',
      may_allow: 'pi has no permission prompt for an allow to skip [PI §12]; a hook may deny only',
      context: 'a hook\'s context output is not delivered: this build passes none into the session on pi',
      fail_closed: 'a PreToolUse or UserPromptSubmit hook fails closed in every way the extension can see: the shim exiting other than 0 or 2, dying by a signal, failing to start, or still running at the hook\'s limit plus the margin (its process group killed)',
      load: 'an extension that does not load stops pi: it exits 1 and sends no request (tier 1), so hooks never go missing silently; the readiness marker says, besides, that every handler is registered',
      stop: 'a Stop hook\'s block asks pi for one more run, its reason added as a message for the model; stop_hook_active tells the hook the run it ends was one it asked for',
      mcp_codemode: 'a hook matching an MCP tool fires when the tool is called directly (exposure direct, measured); whether it fires for a call made from codemode is not measured',
      marker: 'hs-hooks.loaded',
      marker_means: 'the launch extension writes this file once every hook handler is registered; until it exists, no hook of this launch is active, so a caller that needs its guards must not take them as active',
      source: 'P15:extensions; T2',
    },
    permissions: { supported: false, reason: 'pi has no permission system by design [PI §12; P15:security]' },
  },

  // Under materialize (milestone 8.3): the folder's own files, which a bare start reads (T3: a
  // server in mcp.json, exposure "direct", starts and its tool is offered; a skill in skills/
  // reaches a request; settings.json's defaultProvider and defaultModel pick the model). A start
  // rewrites none of them; it adds auth.json, models-store.json and sessions/ [T3]. The endpoint and
  // the login never persist (§5.2), nor AGENTS.md or hooks in this build: launch only.
  persist: {
    mcp_file: 'mcp.json',
    mcp_key: 'mcpServers',
    settings_file: 'settings.json',
    provider_key: 'defaultProvider',
    model_key: 'defaultModel',
    skills_dir: 'skills',
    root: 'hs-run',
  },
  writable: {
    json: { 'mcp.json': { keys: [], prefixes: ['mcpServers/'] }, 'settings.json': { keys: ['defaultProvider', 'defaultModel'] } },
    trees: ['skills', 'hs-run'],
    private: ['hs-run'],
  },

  state: {
    retention_days: { expressible: false, harness_default: null, reason: 'pi has no session retention setting [PI §16]', source: 'PI §16' },
    sessions: { expressible: false, harness_default: 'keep', reason: 'pi keeps every session unless --no-session is passed, which this build does not map [PI §16]', source: 'PI §16; P15:cli' },
    prompt_history: { expressible: false, harness_default: 'keep', reason: 'pi has no prompt history setting [PI §16]', source: 'PI §16' },
  },
});
