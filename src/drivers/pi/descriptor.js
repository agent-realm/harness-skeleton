// The pi harness descriptor: declarative data, no logic (design note v0.2 §7.3).
// Every fact carries its source:
// - `PI §n`: the survey, docs/design/surveys/pi-2026-10-04.md (0.80.2, upstream 1.0.2), where 1.5 kept it;
// - `P15:<doc>`: the docs shipped in @earendil-works/pi-coding-agent@1.5.2 (docs/<doc>.md), read
//   2026-11-12; `P15:dist/<file>` its shipped code;
// - `T1`: the tier 1 check conformance/tier1/pi-launch-surface.mjs on 1.5.2, 2026-11-12.

export default Object.freeze({
  harness: 'pi',
  name: 'pi',
  binary: 'pi',
  version_args: ['--version'], // prints `1.5.2` [T1]

  // Launch only (milestone 8.1); materialize comes with 8.3.
  delivery_modes: ['overlay'],

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
        note: 'a skill root read from $HOME, not the folder; its skills reach every launch',
        source: 'PI §1, §9; P15:skills; T1' },
      { kind: 'inbound-read', path: 'AGENTS.md and CLAUDE.md in the working directory and every parent', class: 'config', closable: false, known_limit: true,
        note: 'context files load from the working directory up to /, with no trust needed; --no-context-files would also drop the folder\'s own',
        source: 'P15:configuration (Context files); T1' },
      { kind: 'inbound-read', path: '.pi/ in the working directory', class: 'config', closable: false, known_limit: true,
        note: 'the project\'s settings, mcp.json, extensions, skills, prompts, themes and system-prompt files load once the project is trusted; a launch leaves the decision to pi (a saved decision in the folder\'s trust.json, else defaultProjectTrust), and observe --state --cwd says whether a trusted project .pi/ is there',
        source: 'P15:security (project trust); P15:dist/core/trust-manager.js; T1 (skipped in JSON mode by default)' },
      { kind: 'inbound-read', path: '~/.pi/agent', class: 'config', closable: true,
        note: 'closed: PI_CODING_AGENT_DIR replaces the default root', source: 'P15:configuration; T1' },
      { kind: 'outbound-write', path: 'the folder\'s settings.json sessionDir', class: 'sessions', closable: false,
        note: 'a sessionDir key moves sessions out of the folder; observe --state reports it when set', source: 'P15:settings; P15:configuration; design note v0.2 §8' },
    ],
  },

  // Path classes (§9.1), relative to harness_path, the agent dir [P15:configuration; PI §1, §20].
  paths: [
    { pattern: '.harness-skeleton', class: 'skeleton', source: 'design note v0.2 §9.3' },
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
    stored_login: { files: ['auth.json'], empty_bytes: 2, cite: 'P15:configuration; PI §7; T1' },
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
    // AGENTS.md is carried as a system-prompt append, which is not a context file: the folder's own
    // context files still load [P15:cli; T1].
    agents_md: { flag: '--append-system-prompt', file: 'hs-agents.md', role: 'instructions' },
    statusline: { supported: false, reason: 'pi has no status line setting; only an extension can draw one [PI §13]' },
    hooks: { supported: false, reason: 'pi hooks are extension handlers; they come through the launch extension in milestone 8.2' },
    permissions: { supported: false, reason: 'pi has no permission system by design [PI §12; P15:security]' },
  },

  state: {
    retention_days: { expressible: false, harness_default: null, reason: 'pi has no session retention setting [PI §16]', source: 'PI §16' },
    sessions: { expressible: false, harness_default: 'keep', reason: 'pi keeps every session unless --no-session is passed, which this build does not map [PI §16]', source: 'PI §16; P15:cli' },
    prompt_history: { expressible: false, harness_default: 'keep', reason: 'pi has no prompt history setting [PI §16]', source: 'PI §16' },
  },
});
