// What the Goose adapter declares (sessions v1 §2 `describe`). Every facet is a claim, and each
// cites its source: a fixture under fixtures/goose/, the adapter spec (unpublished; written from
// synthetic captures on a test VM, 2026-10-19 to 2026-10-21: Goose CLI 1.55.0, schema version 17),
// or the sessions-model annex (2026-10-22). A claim of `explicit` is backed by a fixture record,
// which test/goose.test.js checks.

const DB = 'sessions/sessions.db';

export const describe = Object.freeze({
  adapter: '@agent-realm/harness-session-adapters/goose',
  adapter_ver: '0.2.2',
  model_version: 'sessions-model/1',
  harness: 'goose',
  state_ver: 1,
  // The fixtures come from Goose 1.55.0 (schema 17) captures, scrubbed; none is certified until
  // conformance runs against a real Goose.
  versions: { certified: [], compatible: [] },
  // `harness_path` is the data folder: `$GOOSE_PATH_ROOT/data`, else `$XDG_DATA_HOME/goose`, else
  // `~/.local/share/goose` (spec §1). Every source is a slice of its one database. The database is
  // shared by every session, so `list` reads it once and names each session's slices.
  sources: [
    // This session's rows, `ORDER BY created_timestamp, id` (spec §5). Rows are updated in place
    // (compaction's agentVisible flip, `update_tool_request_meta`) and deleted (truncate, /clear,
    // --edit re-inserts with new ids), so `known` decides (spec §8).
    { pattern: `${DB}#table:messages`, role: 'main', mode: 'delta', position_kind: 'rowid', enc: 'row-json' },
    // The session's own row, without the volatile columns (updated_at, the last-call token columns,
    // accumulated_*): rename, archive, mode and extension changes rewrite it in place (spec §6).
    { pattern: `${DB}#table:sessions`, role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
    // One row per LLM call, compaction calls included (spec §7); kept after the messages it paid
    // for
    // are deleted.
    { pattern: `${DB}#table:usage_ledger`, role: 'side', mode: 'delta', position_kind: 'rowid', enc: 'row-json' },
    // The store's first ledger row (by id), shared by every session: the copied-usage rule's one
    // input from outside the session.
    { pattern: `${DB}#table:usage_ledger@first`, role: 'side', mode: 'snapshot', position_kind: 'snapshot', enc: 'rows-json' },
  ],
  // `created_timestamp` is epoch seconds (spec §3); same-second rows can sort against causality.
  // What `harness_path` names for this harness (sessions-model §1): its data folder.
  store_shape: { kind: 'folder' },
  ts_source: 'seconds',
  redaction: {
    // sessions-model §4.1 names Goose `extension_data` stdio `envs` values. The rest follow
    // memhouse's
    // normaliser: tokens sit in header values, CLI args and SSE/HTTP URL queries, and a recipe
    // keeps
    // parameter values. `»` enters a JSON text column; `**` is any depth. A `uri` / `url` is cut to
    // `scheme://host` rather than replaced by the marker (the host is kept); a `cmd` with
    // whitespace
    // in it (args folded in) is replaced whole; an extension field not known to be harmless is
    // replaced. A JSON column on these paths that does not parse is replaced whole.
    paths: [
      { source: `${DB}#table:sessions`, path: 'sessions[].extension_data » **.extensions[].envs.*', opened: true },
      { source: `${DB}#table:sessions`, path: 'sessions[].extension_data » **.extensions[].headers.*', opened: true },
      { source: `${DB}#table:sessions`, path: 'sessions[].extension_data » **.extensions[].args[]', opened: true },
      { source: `${DB}#table:sessions`, path: 'sessions[].extension_data » **.extensions[].uri|url (cut to scheme://host)', opened: true },
      { source: `${DB}#table:sessions`, path: 'sessions[].extension_data » **.extensions[].cmd (when it holds whitespace)', opened: true },
      { source: `${DB}#table:sessions`, path: 'sessions[].extension_data » **.extensions[].* (except type, name, display_name, description, timeout, bundled, cwd, env_keys, available_tools, enabled)', opened: true },
      { source: `${DB}#table:sessions`, path: 'sessions[].extension_data » **.envs.*, **.headers.*', opened: true },
      { source: `${DB}#table:sessions`, path: 'sessions[].recipe_json » the extension_data paths, **.values.*, **.default', opened: true },
      { source: `${DB}#table:sessions`, path: 'sessions[].user_recipe_values_json » *', opened: true },
      { source: `${DB}#table:messages`, path: 'content_json » [type=toolResponse].toolResult.value[.content][type=resource_link].uri (cut to scheme://host)', opened: true },
      { source: `${DB}#table:messages`, path: 'content_json » [type=toolResponse].toolResult.value[.content][type=resource].resource.uri (cut to scheme://host)', opened: true },
      // Never opened (sessions-model §4.7): the config folder's config.yaml and secrets.yaml, the
      // keyring, permission.yaml and logs. They lie outside `harness_path`.
      { source: '<config dir>/goose/{config,secrets}.yaml', path: '*', opened: false },
    ],
    // String values under a secret-looking name that are not secrets (sessions-model §4.3): an
    // extension's `env_keys` lists env var NAMES (spec §3), and a recipe parameter's `key` is its
    // name (fixture: features, session 20261021_5).
    exemptions: ['env_keys', 'parameters[].key'],
  },
  facets: {
    // Every sessions row, whatever its session_type (user, sub_agent, hidden, terminal, scheduled,
    // acp; spec §3). goose's own `session list` hides some types; the store does not.
    list: 'exact',
    // Lossy: a copied call's metadata.usage (a fork or import copy: no usage record, so the call is
    // billed once); redacted extension and recipe values; resource URIs cut to scheme://host; the
    // volatile sessions columns; messages.timestamp and tokens; the sessions row's
    // model_config_json
    // beyond thinking_effort, provider_name, project_id, schedule_id and recipes reach no record
    // (they stay in the raw unit); a NULL or repeated message_id is anchored `<id>+n`, and a
    // repeated
    // call id `<id>+n`; the threads tables of upgraded stores are not read (spec §11).
    read: 'lossy',
    // `YYYYMMDD_N` ids are reused after a delete of the max; `created_at` has one-second
    // resolution,
    // so a same-second delete and recreate is one session (sessions-model §1 rule 2; annex).
    reuse: 'undetectable',
    lifecycle: {
      rewind: 'implicit', // ACP conversation/truncate deletes rows >= T (spec §6)
      edit: 'implicit', // `--edit` deletes and re-inserts the rows with new ids, same message_ids (spec §6)
      compaction: 'explicit', // the summary row (fixture: features, 20261021_1)
      delete: 'implicit', // the sessions row and its rows are deleted (spec §6)
      archive: 'explicit', // `archived_at` (fixture: features, 20261021_3)
      unarchive: 'implicit', // `archived_at` cleared: the archive record goes
      rename: 'implicit', // UPDATE name, user_set_name = 1; no record of the act (spec §6)
      pin: 'invisible',
      unpin: 'invisible',
      fork: 'invisible', // a new id with copied rows, no pointer (spec §5)
      clear: 'implicit', // `/clear` deletes every row and keeps the session (spec §6)
    },
    linkage: {
      fork: 'inferable', // copied rows keep message_id and created_timestamp (spec §5; annex)
      subagent: 'explicit', // child `parent_session_id`; parent `operations.foreground_subagent.delivered` (fixtures: features, lab)
      rewind_copy: 'none',
      clear: 'none',
      continuation: 'none',
      tool: 'native', // toolRequest.id = toolResponse.id; the first unclaimed result after the call (spec §5)
      compaction: '{flags}', // earlier rows flipped agentVisible=false in place (annex)
    },
    // UNVERIFIED: no hook surface was observed for Goose (annex: `?`).
    join: { hook: 'no', rule: 'none observed; an ACP session id is the goose session id (spec §1)' },
  },
});
