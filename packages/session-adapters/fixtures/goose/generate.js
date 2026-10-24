// Writes the Goose fixture stores as text: for each case, the schema and the statements that build
// `<data>/sessions/sessions.db` (conformance/sql-store.js builds the database at test time; no
// binary file is committed).
//   node fixtures/goose/generate.js
// - `lab`: a Goose 1.55.0 lab capture of a synthetic session (inventory-cli) and its sub-agent,
//   scrubbed outside this repository (home /home/user, gateway model names). The capture holds the
//   first rows of the parent session only, so its later ledger rows have no message. Four captured
//   rows had long cells cut by the capture tool and are completed by hand: the end of a cat output
//   (row 7), a tool call's `_meta` (row 8), a shell result's exit code (row 11), and the closing
//   brace of two metadata cells (rows 3, 8).
// - `features`: written here, one session per behaviour the adapter claims, ported from memhouse's
//   normaliser tests: results claimed by call id, parallel MCP calls,
//   an image, resource URIs, an elicitation pair stored out of order, compaction with its in-place
//   flip, statuses, the session record, sub-agents, copied usage, a truncate, a running call, the
//   extension and recipe redaction.
// - `conformance-goose-sentinel`: the normative sentinel fixture (fixture captures, synthetic,
//   captured on a test VM; scrubbed): a fake secret in an extension's `envs`
//   (redacted on its path) and the same value in free text (kept, sessions-model §4.6).
// The schema is Goose's live schema 17 (adapter spec §3), as memhouse's
// normaliser test builds it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REL = 'sessions/sessions.db';

const SCHEMA = `PRAGMA journal_mode=WAL;
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', user_set_name BOOLEAN DEFAULT FALSE,
  session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  extension_data TEXT DEFAULT '{}', total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER,
  accumulated_cache_write_tokens INTEGER, accumulated_cost REAL, schedule_id TEXT, recipe_json TEXT, user_recipe_values_json TEXT, provider_name TEXT,
  model_config_json TEXT, goose_mode TEXT NOT NULL DEFAULT 'auto', archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT,
  system_prompt_override TEXT, system_prompt_extras_json TEXT, container_id TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
  content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT);
CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_timestamp INTEGER NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_session_created ON messages(session_id, created_timestamp, id);
CREATE INDEX idx_usage_ledger_session ON usage_ledger(session_id);
`;

// ---- the statements of one store ----------------------------------------------------------------

const textTs = (sec) => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');

class Store {
  constructor({ rid = 0, lid = 0 } = {}) {
    this.ops = [{ sql: 'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', params: [17, '2026-10-19 22:00:00'] }];
    this.rid = rid;
    this.lid = lid;
  }

  op(sql, params = []) {
    this.ops.push({ sql, params });
  }

  session(row) {
    const cols = Object.keys(row);
    this.op(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
  }

  // One messages row; JSON columns as goose writes them (compact text), the visibility flags first
  // unless the metadata is given verbatim. Returns the row.
  message(sid, t, mid, role, content, meta = {}, { id, verbatim = false } = {}) {
    const r = {
      id: id ?? ++this.rid, message_id: mid, session_id: sid, role, content_json: JSON.stringify(content), created_timestamp: t,
      timestamp: textTs(t), tokens: null,
      metadata_json: JSON.stringify(verbatim ? meta : { userVisible: true, agentVisible: true, ...meta }),
    };
    if (id !== undefined) this.rid = Math.max(this.rid, id);
    this.op('INSERT INTO messages (id, message_id, session_id, role, content_json, created_timestamp, timestamp, tokens, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.id, r.message_id, r.session_id, r.role, r.content_json, r.created_timestamp, r.timestamp, r.tokens, r.metadata_json]);
    return r;
  }

  ledger(sid, t, model, input, output, cacheRead, { cost = null, costSource = null, compaction = 0, cacheWrite = null, id } = {}) {
    const lid = id ?? ++this.lid;
    if (id !== undefined) this.lid = Math.max(this.lid, id);
    this.op('INSERT INTO usage_ledger (id, session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [lid, sid, t, model, input, output, input + output, cacheRead, cacheWrite, cost, costSource, compaction]);
    return lid;
  }

  // compaction's in-place flip of an earlier row: agentVisible true -> false, no insert.
  flip(r) {
    const meta = { ...JSON.parse(r.metadata_json), agentVisible: false };
    r.metadata_json = JSON.stringify(meta);
    this.op('UPDATE messages SET metadata_json = ? WHERE id = ?', [r.metadata_json, r.id]);
  }
}

function write(name, store) {
  const dir = path.join(HERE, name, 'store-sql', path.dirname(REL));
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(HERE, name, 'store-sql', REL);
  fs.writeFileSync(`${base}.schema.sql`, SCHEMA);
  fs.writeFileSync(`${base}.ops.jsonl`, store.ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
  console.log(`goose/${name}: ${store.ops.length} statements`);
}

// ---- content builders
// ----------------------------------------------------------------------------

const text = (s) => ({ type: 'text', text: s });
const req = (id, name, args, ext) => ({
  type: 'toolRequest', id, toolCall: { status: 'success', value: { name, arguments: args } },
  _meta: { 'goose.toolCall.providerIndex': 0, ...(ext ? { goose_extension: ext } : {}) },
});
const resp = (id, content, { isError, structured, resultType } = {}) => ({
  type: 'toolResponse', id,
  toolResult: { status: 'success', value: { ...(resultType ? { resultType } : {}), content, ...(structured ? { structuredContent: structured } : {}), ...(isError !== undefined ? { isError } : {}) } },
});
const action = (data) => ({ type: 'actionRequired', data });
const usage = (i, o, cr, el, extra = {}) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o, cacheReadTokens: cr, elapsedMs: el, timeToFirstTokenMs: Math.max(0, el - 1), ...extra });
const TOOLS_MAIN = ['analyze', 'apps__create_app', 'apps__delete_app', 'apps__iterate_app', 'apps__list_apps', 'delegate', 'edit', 'extensionmanager__list_resources',
  'extensionmanager__manage_extensions', 'extensionmanager__read_resource', 'extensionmanager__search_available_extensions', 'load', 'load_skill', 'read_image', 'shell', 'tree', 'write'];
const TOOLS_SUB = ['analyze', 'apps__create_app', 'apps__delete_app', 'apps__iterate_app', 'apps__list_apps', 'edit', 'extensionmanager__list_resources',
  'extensionmanager__read_resource', 'extensionmanager__search_available_extensions', 'load', 'load_skill', 'read_image', 'recipe__final_output', 'shell', 'tree', 'write'];
// The features rows advertise a short tool list; the captures carry goose's full one.
const inference = (model, tools = ['delegate', 'edit', 'shell', 'tree']) => ({ inference: { provider: 'openai', requestedModel: model }, operations: { llm: { advertised_tools: tools } } });
const turnContext = (time, cwd) => text(`<turn-context>\n<current-time>${time}</current-time>\n<working-directory>${cwd}</working-directory>\n</turn-context>`);
const modelConfig = (model, effort) => JSON.stringify({
  model_name: model, temperature: null, max_tokens: 131072, toolshim: false, toolshim_model: null,
  ...(effort ? { request_params: { thinking_effort: effort } } : {}), reasoning: true, supports_vision: false,
});
const DEVELOPER = { type: 'builtin', name: 'developer', description: 'Write and edit files, and execute shell commands', display_name: 'Developer', timeout: null, bundled: true };
const SUMMON = { type: 'platform', name: 'summon', description: 'Load knowledge and delegate tasks to subagents', display_name: 'Summon', bundled: true };
const extData = (list) => JSON.stringify({ 'enabled_extensions.v0': { extensions: list } });

// ---- lab
// -----------------------------------------------------------------------------------------

const LAB_SESSIONS = [
  { id: '20261019_1', name: 'Synthetic title 40d902 for', user_set_name: 0, session_type: 'user', working_dir: '/home/user/work/inventory-cli', created_at: '2026-10-19 22:13:23', updated_at: '2026-10-19 23:09:52', provider_name: 'openai', model_config_json: '{"model_name":"gateway/toy-model-a","temperature":null,"max_tokens":131072,"toolshim":false,"toolshim_model":null,"reasoning":true,"supports_vision":false}', parent_session_id: null, total_tokens: 6467 },
  { id: '20261019_2', name: 'Synthetic titl', user_set_name: 0, session_type: 'sub_agent', working_dir: '/home/user/work/inventory-cli', created_at: '2026-10-19 22:16:57', updated_at: '2026-10-19 22:17:02', provider_name: 'openai', model_config_json: '{"model_name":"gateway/toy-model-a","temperature":null,"max_tokens":131072,"toolshim":false,"toolshim_model":null,"reasoning":true,"supports_vision":false}', parent_session_id: '20261019_1', total_tokens: 4037 },
];
// [id, session_id, created_timestamp, model, input, output, cache_read, is_compaction]
const LAB_LEDGER = [
  [1, '20261019_1', 1792448138, 3952, 256, 0, 0], [2, '20261019_1', 1792448156, 4100, 173, 3072, 0], [3, '20261019_1', 1792448171, 4237, 292, 3584, 0],
  [4, '20261019_1', 1792448173, 4380, 40, 3584, 0], [5, '20261019_1', 1792448182, 4447, 182, 3584, 0], [6, '20261019_1', 1792448217, 4673, 50, 3584, 0],
  [7, '20261019_2', 1792448220, 3946, 56, 0, 0], [8, '20261019_2', 1792448222, 4009, 28, 3072, 0], [9, '20261019_1', 1792448228, 4757, 53, 4096, 0],
  [10, '20261019_1', 1792451047, 4991, 37867, 0, 0], [11, '20261019_1', 1792451335, 18056, 3865, 0, 1], [12, '20261019_1', 1792451392, 6358, 109, 0, 0],
];
// The captured messages rows: `c` is content_json, `m` metadata_json.
const LAB_MESSAGES = [
  {"id":1,"mid":"msg_806ae76b-4771-4115-9ced-3efc0f4716cb","sid":"20261019_1","role":"user","t":1792448019,"ts":"2026-10-19 22:13:39","c":[{"type":"text","text":"What does this CLI do? One sentence, no tools."}],"m":{"userVisible":true,"agentVisible":false}},
  {"id":2,"mid":"msg_88044b65-504a-4fbc-992a-9d5ba873db4d","sid":"20261019_1","role":"user","t":1792448019,"ts":"2026-10-19 22:15:38","c":[{"type":"text","text":"<turn-context>\n<current-time>2026-10-19 22:13:00 +00:00</current-time>\n<working-directory>/home/user/work/inventory-cli</working-directory>\n</turn-context>"}],"m":{"userVisible":false,"agentVisible":false,"turnContext":true}},
  {"id":3,"mid":"chatcmpl-FixtureFixt00053","sid":"20261019_1","role":"assistant","t":1792448120,"ts":"2026-10-19 22:15:38","c":[{"type":"text","text":"Synthetic reply ee0580. synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the "}],"m":{"userVisible":true,"agentVisible":false,"inference":{"provider":"openai","requestedModel":"gateway/toy-model-a"},"usage":{"inputTokens":3952,"outputTokens":256,"totalTokens":4208,"cacheReadTokens":0,"elapsedMs":119120,"timeToFirstTokenMs":100525},"operations":{"llm":{"advertised_tools":TOOLS_MAIN}}}},
  {"id":4,"mid":"msg_92cbe459-1ce5-404a-9709-66643ee4a228","sid":"20261019_1","role":"user","t":1792448149,"ts":"2026-10-19 22:15:49","c":[{"type":"text","text":"Add a \"list\" command to src/cli.js that prints every sku and its stock, then run: node src/cli.js list  and then run: node src/cli.js missing-cmd --strict && false"}],"m":{"userVisible":true,"agentVisible":false}},
  {"id":5,"mid":"msg_7235731a-c42c-4ea2-92f2-46840264516f","sid":"20261019_1","role":"user","t":1792448149,"ts":"2026-10-19 22:15:56","c":[{"type":"text","text":"<turn-context>\n<current-time>2026-10-19 22:15:00 +00:00</current-time>\n<working-directory>/home/user/work/inventory-cli</working-directory>\n</turn-context>"}],"m":{"userVisible":false,"agentVisible":false,"turnContext":true}},
  {"id":6,"mid":"chatcmpl-FixtureFixt00054","sid":"20261019_1","role":"assistant","t":1792448156,"ts":"2026-10-19 22:15:56","c":[{"type":"toolRequest","id":"chatcmpl-tool-FixtureFixt00055","toolCall":{"status":"success","value":{"name":"tree","arguments":{"depth":3,"path":"/home/user/work/inventory-cli"}}},"_meta":{"goose.toolCall.providerIndex":0,"goose_extension":"developer"}},{"type":"toolRequest","id":"chatcmpl-tool-FixtureFixt00056","toolCall":{"status":"success","value":{"name":"shell","arguments":{"command":"cat src/cli.js"}}},"_meta":{"goose.toolCall.providerIndex":1,"goose_extension":"developer"}}],"m":{"userVisible":true,"agentVisible":false,"inference":{"provider":"openai","requestedModel":"gateway/toy-model-a"},"usage":{"inputTokens":4100,"outputTokens":173,"totalTokens":4273,"cacheReadTokens":3072,"elapsedMs":7058,"timeToFirstTokenMs":7057},"operations":{"llm":{"advertised_tools":TOOLS_MAIN}}}},
  {"id":7,"mid":"msg_1004e334-50b3-4a20-b260-c03c295ea0ff","sid":"20261019_1","role":"user","t":1792448156,"ts":"2026-10-19 22:15:56","c":[{"type":"toolResponse","id":"chatcmpl-tool-FixtureFixt00055","toolResult":{"status":"success","value":{"resultType":"complete","content":[{"type":"text","text":"src/  [6]\n  cli.js  [6]\npackage.json  [1]\n"}],"isError":false}}},{"type":"toolResponse","id":"chatcmpl-tool-FixtureFixt00056","toolResult":{"status":"success","value":{"resultType":"complete","content":[{"type":"text","text":"#!/usr/bin/env node\n// Synthetic inventory CLI for agent exercises.\nconst stock = { \"A-1\": 4, \"B-2\": 0 };\nconst [cmd, sku] = process.argv.slice(2);\nif (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\nelse console.log(\"usage: inv get <sku>\");\n"}],"isError":false}}}],"m":{"userVisible":true,"agentVisible":false}},
  {"id":8,"mid":"chatcmpl-FixtureFixt00057","sid":"20261019_1","role":"assistant","t":1792448165,"ts":"2026-10-19 22:16:11","c":[{"type":"text","text":"Synthetic reply d04ef7. synthetic reply text for the toy"},{"type":"toolRequest","id":"chatcmpl-tool-FixtureFixt00058","toolCall":{"status":"success","value":{"name":"edit","arguments":{"after":"if (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\nelse if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\nelse console.log(\"usage: inv get <sku>\");","before":"if (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\nelse console.log(\"usage: inv get <sku>\");","path":"src/cli.js"}}},"_meta":{"goose.toolCall.providerIndex":0,"goose_extension":"developer"}}],"m":{"userVisible":true,"agentVisible":false,"inference":{"provider":"openai","requestedModel":"gateway/toy-model-a"},"usage":{"inputTokens":4237,"outputTokens":292,"totalTokens":4529,"cacheReadTokens":3584,"elapsedMs":15009,"timeToFirstTokenMs":8542},"operations":{"llm":{"advertised_tools":TOOLS_MAIN}}}},
  {"id":9,"mid":"msg_7e09d6e9-cfdb-4856-a11f-c5f336bc4a9d","sid":"20261019_1","role":"user","t":1792448172,"ts":"2026-10-19 22:16:12","c":[{"type":"toolResponse","id":"chatcmpl-tool-FixtureFixt00058","toolResult":{"status":"success","value":{"resultType":"complete","content":[{"type":"text","text":"Edited src/cli.js (2 lines -> 3 lines)","annotations":{"priority":0}}],"isError":false}}}],"m":{"userVisible":true,"agentVisible":false}},
  {"id":10,"mid":"chatcmpl-FixtureFixt00059","sid":"20261019_1","role":"assistant","t":1792448173,"ts":"2026-10-19 22:16:13","c":[{"type":"toolRequest","id":"chatcmpl-tool-FixtureFixt00060","toolCall":{"status":"success","value":{"name":"shell","arguments":{"command":"node src/cli.js list"}}},"_meta":{"goose.toolCall.providerIndex":0,"goose_extension":"developer"}},{"type":"toolRequest","id":"chatcmpl-tool-FixtureFixt00061","toolCall":{"status":"success","value":{"name":"shell","arguments":{"command":"node src/cli.js missing-cmd --strict && false; echo \"exit=$?\""}}},"_meta":{"goose.toolCall.providerIndex":1,"goose_extension":"developer"}}],"m":{"userVisible":true,"agentVisible":false,"inference":{"provider":"openai","requestedModel":"gateway/toy-model-a"},"usage":{"inputTokens":4380,"outputTokens":40,"totalTokens":4420,"cacheReadTokens":3584,"elapsedMs":1624,"timeToFirstTokenMs":1624},"operations":{"llm":{"advertised_tools":TOOLS_MAIN}}}},
  {"id":11,"mid":"msg_bcc85d1e-cab5-4f25-ba30-162ad7e4b46f","sid":"20261019_1","role":"user","t":1792448173,"ts":"2026-10-19 22:16:13","c":[{"type":"toolResponse","id":"chatcmpl-tool-FixtureFixt00060","toolResult":{"status":"success","value":{"resultType":"complete","content":[{"type":"text","text":"A-1 4\nB-2 0","annotations":{"priority":0}}],"structuredContent":{"stdout":"A-1 4\nB-2 0","stderr":"","exit_code":0},"isError":false}}},{"type":"toolResponse","id":"chatcmpl-tool-FixtureFixt00061","toolResult":{"status":"success","value":{"resultType":"complete","content":[{"type":"text","text":"usage: inv get <sku>\nexit=1","annotations":{"priority":0}}],"structuredContent":{"stdout":"usage: inv get <sku>\nexit=1","stderr":"","exit_code":0},"isError":false}}}],"m":{"userVisible":true,"agentVisible":false}},
  {"id":12,"mid":"chatcmpl-FixtureFixt00062","sid":"20261019_1","role":"assistant","t":1792448176,"ts":"2026-10-19 22:16:22","c":[{"type":"text","text":"Synthetic reply 90abc7. synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic r"}],"m":{"userVisible":true,"agentVisible":false,"inference":{"provider":"openai","requestedModel":"gateway/toy-model-a"},"usage":{"inputTokens":4447,"outputTokens":182,"totalTokens":4629,"cacheReadTokens":3584,"elapsedMs":8318,"timeToFirstTokenMs":2844},"operations":{"llm":{"advertised_tools":TOOLS_MAIN}}}},
  {"id":13,"mid":"msg_8c7894f0-067b-4afe-a33c-7970fd6c5f46","sid":"20261019_1","role":"user","t":1792448215,"ts":"2026-10-19 22:16:55","c":[{"type":"text","text":"Delegate to a subagent (use your subagent/dynamic task tool if you have one): have it read package.json and report the bin name. Then tell me what it said."}],"m":{"userVisible":true,"agentVisible":false}},
  {"id":14,"mid":"msg_66a1e752-fdac-4b8d-afbf-33a957373a19","sid":"20261019_1","role":"user","t":1792448215,"ts":"2026-10-19 22:16:57","c":[{"type":"text","text":"<turn-context>\n<current-time>2026-10-19 22:16:00 +00:00</current-time>\n<working-directory>/home/user/work/inventory-cli</working-directory>\n</turn-context>"}],"m":{"userVisible":false,"agentVisible":false,"turnContext":true}},
  {"id":16,"mid":"msg_20261019_2_5b0f5073-5487-41d4-8399-3cb8103a9381","sid":"20261019_2","role":"user","t":1792448217,"ts":"2026-10-19 22:16:57","c":[{"type":"text","text":"Subagent ID: 20261019_2\n\nRead the file /home/user/work/inventory-cli/package.json and report back the \"bin\" name (the command name defined in the bin field). Just report the bin name and nothing else."}],"m":{"userVisible":true,"agentVisible":true}},
  {"id":18,"mid":"msg_042cbd4b-4097-4048-a149-a6aa7fbcb5a8","sid":"20261019_2","role":"user","t":1792448217,"ts":"2026-10-19 22:17:00","c":[{"type":"text","text":"<turn-context>\n<current-time>2026-10-19 22:16:00 +00:00</current-time>\n<working-directory>/home/user/work/inventory-cli</working-directory>\n</turn-context>"}],"m":{"userVisible":false,"agentVisible":true,"turnContext":true}},
  {"id":19,"mid":"chatcmpl-FixtureFixt00063","sid":"20261019_2","role":"assistant","t":1792448220,"ts":"2026-10-19 22:17:01","c":[{"type":"toolRequest","id":"chatcmpl-tool-FixtureFixt00064","toolCall":{"status":"success","value":{"name":"shell","arguments":{"command":"cat /home/user/work/inventory-cli/package.json"}}},"_meta":{"goose.toolCall.providerIndex":0,"goose_extension":"developer"}}],"m":{"userVisible":true,"agentVisible":true,"inference":{"provider":"openai","requestedModel":"gateway/toy-model-a"},"usage":{"inputTokens":3946,"outputTokens":56,"totalTokens":4002,"cacheReadTokens":0,"elapsedMs":3401,"timeToFirstTokenMs":3401},"operations":{"llm":{"advertised_tools":TOOLS_SUB}}}},
  {"id":20,"mid":"msg_bdd0d9d6-53d4-4f8f-bd3b-f7083ec8bde6","sid":"20261019_2","role":"user","t":1792448221,"ts":"2026-10-19 22:17:01","c":[{"type":"toolResponse","id":"chatcmpl-tool-FixtureFixt00064","toolResult":{"status":"success","value":{"resultType":"complete","content":[{"type":"text","text":"{ \"name\": \"inventory-cli\", \"version\": \"0.0.1\", \"type\": \"module\", \"bin\": { \"inv\": \"src/cli.js\" } }","annotations":{"priority":0}}],"structuredContent":{"stdout":"{ \"name\": \"inventory-cli\", \"version\": \"0.0.1\", \"type\": \"module\", \"bin\": { \"inv\": \"src/cli.js\" } }","stderr":"","exit_code":0},"isError":false}}}],"m":{"userVisible":true,"agentVisible":true}},
  {"id":21,"mid":"chatcmpl-FixtureFixt00065","sid":"20261019_2","role":"assistant","t":1792448222,"ts":"2026-10-19 22:17:02","c":[{"type":"toolRequest","id":"chatcmpl-tool-FixtureFixt00066","toolCall":{"status":"success","value":{"name":"recipe__final_output","arguments":{"summary":"inv"}}},"_meta":{"goose.toolCall.providerIndex":0}}],"m":{"userVisible":true,"agentVisible":true,"inference":{"provider":"openai","requestedModel":"gateway/toy-model-a"},"usage":{"inputTokens":4009,"outputTokens":28,"totalTokens":4037,"cacheReadTokens":3072,"elapsedMs":1368,"timeToFirstTokenMs":1368},"operations":{"llm":{"advertised_tools":TOOLS_SUB}}}},
  {"id":22,"mid":"msg_c9d93586-f613-43e4-8910-207f062e4990","sid":"20261019_2","role":"user","t":1792448222,"ts":"2026-10-19 22:17:02","c":[{"type":"toolResponse","id":"chatcmpl-tool-FixtureFixt00066","toolResult":{"status":"success","value":{"resultType":"complete","content":[{"type":"text","text":"Final output successfully collected."}],"isError":false}}}],"m":{"userVisible":true,"agentVisible":true}},
  {"id":23,"mid":"msg_5dbd871c-1fe5-47f5-8997-d588afc08546","sid":"20261019_2","role":"assistant","t":1792448222,"ts":"2026-10-19 22:17:02","c":[{"type":"text","text":"Synthetic reply d3d8c"}],"m":{"userVisible":true,"agentVisible":true}},
];

function lab() {
  const s = new Store();
  // In the order goose wrote them: each sessions row at its creation, messages and ledger rows by
  // their time (ties: messages first, then by id).
  const events = [
    ...LAB_SESSIONS.map((row) => ({ t: Date.parse(`${row.created_at.replace(' ', 'T')}Z`) / 1000, k: 0, id: 0, run: () => s.session(row) })),
    ...LAB_MESSAGES.map((r) => ({ t: r.t, k: 1, id: r.id, run: () => s.message(r.sid, r.t, r.mid, r.role, r.c, r.m, { id: r.id, verbatim: true }) })),
    ...LAB_LEDGER.map(([id, sid, t, i, o, cr, comp]) => ({ t, k: 2, id, run: () => s.ledger(sid, t, 'gateway/toy-model', i, o, cr, { id, compaction: comp }) })),
  ].sort((a, b) => a.t - b.t || a.k - b.k || a.id - b.id);
  for (const e of events) e.run();
  write('lab', s);
}

// ---- features
// ------------------------------------------------------------------------------------

const REQ = 'gateway/toy-model-a';
const SERVED = 'gateway/toy-model';
const FLASH = 'gateway/toy-model-c';
const FLASH_SERVED = 'toy/toy-model-c';
const at = (y, mo, d, h, mi, sec) => Date.UTC(y, mo - 1, d, h, mi, sec) / 1000;
const PNG = Buffer.from('PNG-TOY-LABEL-240x120').toString('base64');
// Synthetic stand-ins for a signed URL, a token in an extension arg, in an SSE URL query, and a
// recipe value; none of them is a real credential.
const LINK_TOKEN = 'toysig-91c2e7a4b05d3f68';
const ARG_TOKEN = 'toyarg-7f3c9e2a51d84b06';
const URL_TOKEN = 'toyurl-0c8b4e6f2a917d35';
const RECIPE_VALUE = 'toyrecipe-5e1a7c903b2f';
const sessionRow = (over) => ({
  name: 'Synthetic t', description: '', user_set_name: 0, session_type: 'user', working_dir: '/home/user/work/toyshop',
  extension_data: extData([DEVELOPER]), provider_name: 'openai', model_config_json: modelConfig(REQ), goose_mode: 'auto', ...over,
});

function features() {
  const s = new Store({ rid: 100, lid: 10 });

  // 20261020_5 and its sub-agent 20261020_6: the child states its parent (parent_session_id); the
  // parent row that delivered the child's result names it (foreground_subagent.delivered).
  {
    const P = '20261020_5';
    const C = '20261020_6';
    const T = at(2026, 10, 20, 9, 10, 0);
    s.session(sessionRow({ id: P, name: 'gs2-recipe', user_set_name: 1, created_at: '2026-10-20 09:09:59', extension_data: extData([DEVELOPER, SUMMON]), model_config_json: modelConfig(FLASH) }));
    s.message(P, T, 'msg_pp', 'user', [text('Use the count_tests sub-recipe.')]);
    s.message(P, T + 4, 'chatcmpl-del', 'assistant', [req('call-del', 'delegate', { source: 'count_tests', instructions: 'Count test functions in tests/' }, 'summon')],
      { ...inference(FLASH), usage: usage(3490, 148, 3072, 7977, { cost: 0.000160716, costSource: 'estimated' }) });
    s.session(sessionRow({
      id: C, name: 'Synthetic titl', session_type: 'sub_agent', parent_session_id: P, created_at: '2026-10-20 09:10:05', model_config_json: modelConfig(FLASH),
      recipe_json: JSON.stringify({ version: '1.0.0', title: 'Count tests', description: 'Count test functions in tests/', instructions: 'Count functions starting with test_ in the tests/ directory. Reply with only the number.', extensions: [{ type: 'builtin', name: 'developer', description: '', display_name: null, timeout: 300, bundled: null }], settings: { max_turns: 25 } }),
    }));
    s.message(C, T + 5, `msg_${C}_98200e64-0f8e-41b9-8106-2b7be88168bb`, 'user', [text(`Subagent ID: ${C}\n\nCount test functions in tests/`)]);
    s.message(C, T + 9, 'chatcmpl-fo', 'assistant', [req('call-fo', 'recipe__final_output', { summary: '4' })], { ...inference(FLASH), usage: usage(3704, 59, 3328, 1926) });
    s.message(C, T + 9, 'msg_for', 'user', [resp('call-fo', [text('Final output successfully collected.')], { isError: false, resultType: 'complete' })]);
    s.ledger(C, T + 10, FLASH_SERVED, 3704, 59, 3328);
    s.message(P, T + 10, 'msg_dr', 'user', [resp('call-del', [text('{"summary":"4"}')])]);
    s.message(P, T + 10, 'msg_done', 'user', [text(`Subagent ${C} completed: {"summary":"4"}`)], { userVisible: false, operations: { foreground_subagent: { delivered: C } } });
    s.ledger(P, T + 11, FLASH_SERVED, 3490, 148, 3072, { cost: 0.000160716, costSource: 'estimated' });
    s.message(P, T + 12, 'chatcmpl-pa', 'assistant', [text('4 tests.')], { ...inference(FLASH), usage: usage(3600, 3, 3328, 300) });
    s.ledger(P, T + 13, FLASH_SERVED, 3600, 3, 3328);
  }

  // 20261021_1: a turn with a failing shell call and reasoning; an elicitation answered inside the
  // call, its response row stored before its request; three parallel MCP calls whose results land
  // in one row in completion order (an image, a file: link, a text resource); resource URIs with
  // tokens; a rename; a manual compaction that flips every earlier row to agentVisible=false in
  // place; a turn after it.
  const S1 = '20261021_1';
  const T = at(2026, 10, 21, 13, 0, 0);
  const s1 = [];
  {
    s.session(sessionRow({
      id: S1, created_at: '2026-10-21 12:59:58', model_config_json: modelConfig(REQ, 'high'),
      extension_data: extData([DEVELOPER, { type: 'stdio', name: 'python3', description: 'toy MCP server', cmd: 'python3', args: ['toy_mcp.py'], envs: {}, env_keys: [], timeout: 300, cwd: null, bundled: null }]),
    }));
    const m = (...a) => {
      const r = s.message(...a);
      s1.push(r);
      return r;
    };
    m(S1, T, 'msg_u1', 'user', [text('Run the cart tests and tell me what fails.')]);
    s.op('UPDATE sessions SET name = ?, user_set_name = 1 WHERE id = ?', ['cart tests', S1]);
    m(S1, T, 'msg_tc1', 'user', [turnContext('2026-10-21 13:00:00 +00:00', '/home/user/work/toyshop')], { userVisible: false, turnContext: true });
    m(S1, T + 3, 'chatcmpl-a1', 'assistant', [{ type: 'thinking', thinking: 'Run pytest first.', signature: '' }, req('call-1', 'shell', { command: 'python3 -m pytest -q' }, 'developer')],
      { ...inference(REQ), usage: usage(5790, 50, 5120, 3111) });
    m(S1, T + 4, 'msg_elr', 'user', [action({ actionType: 'elicitationResponse', id: '2a1898c8-9421-4c21-9063-74b418980e4e', user_data: { qty: 25 }, action: 'accept' })], { userVisible: false });
    m(S1, T + 4, 'msg_el', 'assistant', [action({ actionType: 'elicitation', id: '2a1898c8-9421-4c21-9063-74b418980e4e', message: 'How many units of TRAIN-42 should be restocked?', requested_schema: { type: 'object', properties: { qty: { type: 'integer', description: 'units to order' } }, required: ['qty'] } })]);
    s.ledger(S1, T + 5, SERVED, 5790, 50, 5120);
    m(S1, T + 6, 'msg_r1', 'user', [resp('call-1', [{ type: 'text', text: '1 failed, 2 passed\n\nCommand exited with code 1', annotations: { priority: 0 } }], { isError: true, resultType: 'complete', structured: { stdout: '1 failed, 2 passed', stderr: '', exit_code: 1 } })]);
    m(S1, T + 8, 'chatcmpl-a2', 'assistant', [text('test_total_uses_qty fails: the total ignores qty.')], { ...inference(REQ), usage: usage(5905, 71, 5120, 1500) });
    s.ledger(S1, T + 9, SERVED, 5905, 71, 5120);
    m(S1, T + 60, 'msg_u2', 'user', [text('Check stock for TRAIN-42 with the toy tools.')]);
    m(S1, T + 60, 'msg_tc2', 'user', [turnContext('2026-10-21 13:01:00 +00:00', '/home/user/work/toyshop')], { userVisible: false, turnContext: true });
    m(S1, T + 66, 'chatcmpl-a3', 'assistant', [
      req('call-stock', 'python3__stock_count', { sku: 'TRAIN-42' }, 'python3'),
      req('call-scan', 'python3__broken_scanner', { code: '0042' }, 'python3'),
      req('call-label', 'python3__label_preview', {}, 'python3'),
    ], { ...inference(REQ), usage: usage(4871, 175, 0, 6176) });
    s.ledger(S1, T + 66, SERVED, 4871, 175, 0);
    m(S1, T + 69, 'msg_r2', 'user', [
      resp('call-label', [text('label preview follows'), { type: 'image', data: PNG, mimeType: 'image/png' },
        { type: 'resource_link', uri: 'file:///home/user/work/toyshop/label.png', name: 'label.png', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'toy://catalog/sku-42', mimeType: 'text/plain', text: 'SKU-42 wooden train, price 12.50' } }]),
      resp('call-stock', [text('SKU TRAIN-42: 17 units on 3 shelves')], { structured: { sku: 'TRAIN-42', units: 17 } }),
      resp('call-scan', [text('scanner offline: E_TOY_42')], { isError: true }),
    ]);
    m(S1, T + 72, 'chatcmpl-a4', 'assistant', [text('TRAIN-42: 17 units; the scanner is offline.')], { ...inference(REQ), usage: usage(5200, 20, 4096, 900) });
    s.ledger(S1, T + 73, SERVED, 5200, 20, 4096);
    m(S1, T + 80, 'msg_u3', 'user', [text('Fetch the label from the toy CDN.')]);
    m(S1, T + 82, 'chatcmpl-res', 'assistant', [req('call-res', 'python3__label_preview', { remote: true }, 'python3')], { ...inference(REQ), usage: usage(100, 1, 0, 100) });
    s.ledger(S1, T + 83, SERVED, 100, 1, 0);
    m(S1, T + 84, 'msg_rl', 'user', [resp('call-res', [
      { type: 'resource_link', uri: `https://toy-cdn.example/label.png?sig=${LINK_TOKEN}`, name: 'label.png' },
      { type: 'resource', resource: { uri: `https://toy-cdn.example/a.bin?token=${LINK_TOKEN}`, mimeType: 'application/octet-stream', blob: PNG } },
      { type: 'resource', resource: { uri: `toy:opaque?token=${LINK_TOKEN}`, mimeType: 'text/plain' } },
      { type: 'resource_link', uri: 'C:\\toys\\label.png' },
      { type: 'resource_link', uri: 'toyshop/label.png' },
    ])]);
    m(S1, T + 86, 'chatcmpl-a5', 'assistant', [text('The label is on the toy CDN.')], { ...inference(REQ), usage: usage(130, 8, 0, 400) });
    s.ledger(S1, T + 87, SERVED, 130, 8, 0);
    // /compact: the summary row (role user, hidden from the user), goose's continuation note and
    // its "Compaction complete" line; the compaction call's ledger row; then the in-place flip.
    const earlier = [...s1];
    s.message(S1, T + 120, 'msg_c1', 'user', [text('/compact')], { agentVisible: false });
    s.message(S1, T + 125, 'chatcmpl-s1', 'user', [text('# Conversation Summary\n\n- test_total_uses_qty fails; TRAIN-42 has 17 units; the scanner is offline.')], { userVisible: false });
    s.message(S1, T + 150, 'msg_cont', 'assistant', [text("Your context was compacted at the user's request. The previous message contains a summary of the conversation so far.")], { userVisible: false });
    s.message(S1, T + 150, 'msg_cc', 'assistant', [text('Compaction complete')], { agentVisible: false });
    s.ledger(S1, T + 150, SERVED, 766, 3043, 0, { compaction: 1 });
    for (const r of earlier) s.flip(r);
    s.message(S1, T + 200, 'msg_u4', 'user', [text('Thanks.')]);
    s.message(S1, T + 200, 'msg_tc4', 'user', [turnContext('2026-10-21 13:03:00 +00:00', '/home/user/work/toyshop')], { userVisible: false, turnContext: true });
    s.message(S1, T + 203, 'chatcmpl-a6', 'assistant', [text('You are welcome.')], { ...inference(REQ), usage: usage(900, 5, 0, 300) });
    s.ledger(S1, T + 204, SERVED, 900, 5, 0);
  }

  // 20261021_2: a confirmation denied, a Ctrl-C during a shell call, a cancel in the approval
  // prompt, a provider error, a reply cut by Ctrl-C (no usage, no ledger row), the output-token
  // limit.
  {
    const S2 = '20261021_2';
    const T2 = at(2026, 10, 21, 13, 20, 0);
    s.session(sessionRow({ id: S2, name: 'statuses', user_set_name: 1, created_at: '2026-10-21 13:19:58' }));
    s.message(S2, T2, 'msg_p1', 'user', [text('Delete README.md.')]);
    s.message(S2, T2 + 2, 'chatcmpl-b1', 'assistant', [req('call-rm', 'shell', { command: 'rm README.md' }, 'developer')], { ...inference(REQ), usage: usage(4162, 13, 3072, 898) });
    s.message(S2, T2 + 2, 'msg_conf', 'assistant', [action({ actionType: 'toolConfirmation', id: 'call-rm', toolName: 'shell', arguments: { command: 'rm README.md' }, prompt: null })], { agentVisible: false });
    s.ledger(S2, T2 + 3, SERVED, 4162, 13, 3072);
    s.message(S2, T2 + 30, `msg_${S2}_35db50cf-7cdf-4c69-9d18-eed5b840014b`, 'user', [action({ actionType: 'toolConfirmationResponse', id: 'call-rm', permission: 'deny_once' })], { userVisible: false, agentVisible: false });
    s.message(S2, T2 + 30, 'msg_rr', 'user', [resp('call-rm', [text('The user has declined to run this tool. DO NOT attempt to call this tool again.')], { isError: true, resultType: 'complete' })]);
    s.message(S2, T2 + 32, 'chatcmpl-b2', 'assistant', [text('Not deleted.')], { ...inference(REQ), usage: usage(4200, 5, 3072, 500) });
    s.ledger(S2, T2 + 33, SERVED, 4200, 5, 3072);
    s.message(S2, T2 + 60, 'msg_p2', 'user', [text('Run exactly this shell command: sleep 90; echo late')]);
    s.message(S2, T2 + 62, 'chatcmpl-b3', 'assistant', [req('call-sleep', 'shell', { command: 'sleep 90; echo late', timeout_secs: 150 }, 'developer')], { ...inference(REQ), usage: usage(5905, 71, 5120, 3089) });
    s.ledger(S2, T2 + 65, SERVED, 5905, 71, 5120);
    s.message(S2, T2 + 70, 'msg_rs', 'user', [resp('call-sleep', [text('(no output)')], { isError: true, resultType: 'complete', structured: { stdout: '', stderr: '' } })]);
    s.message(S2, T2 + 80, 'msg_p3', 'user', [text('Delete it again.')]);
    s.message(S2, T2 + 82, 'chatcmpl-b4', 'assistant', [req('call-rm2', 'shell', { command: 'rm README.md' }, 'developer')], { ...inference(REQ), usage: usage(4300, 13, 3072, 700) });
    s.ledger(S2, T2 + 83, SERVED, 4300, 13, 3072);
    s.message(S2, T2 + 90, `msg_${S2}_6a1f0c2e-1d3b-4c5a-9e7f-0b1c2d3e4f50`, 'user', [action({ actionType: 'toolConfirmationResponse', id: 'call-rm2', permission: 'deny_once' })], { userVisible: false, agentVisible: false });
    s.message(S2, T2 + 90, 'msg_ri', 'user', [resp('call-rm2', [text('Tool call was interrupted before completing.')], { isError: true })]);
    s.message(S2, T2 + 95, 'msg_err', 'assistant', [{ type: 'error', kind: 'other', message: 'Ran into this error: Server error: Server error (503 Service Unavailable) at http://192.0.2.100/v1/chat/completions.' }], { agentVisible: false });
    s.message(S2, T2 + 100, 'msg_p4', 'user', [text('Write a long story about a wooden train.')]);
    s.message(S2, T2 + 105, 'chatcmpl-part', 'assistant', [text('Once upon a time, on the top shelf')], { ...inference(REQ) });
    s.message(S2, T2 + 110, 'msg_p5', 'user', [text('One word.')]);
    s.message(S2, T2 + 112, 'chatcmpl-otl', 'assistant', [], { agentVisible: false, ...inference(REQ), outputTokenLimitReached: true, usage: { inputTokens: 3953, outputTokens: 40, totalTokens: 3993, cacheReadTokens: 1536, elapsedMs: 7109 } });
    s.ledger(S2, T2 + 119, SERVED, 3953, 40, 1536);
  }

  // 20261021_3: the session record: a mode change and a rename in place, goose-written user turns
  // (a
  // goal kick-off, a nudge, the compaction replay of a prompt), a steer, an archive, a row after
  // it.
  {
    const S3 = '20261021_3';
    const T3 = at(2026, 10, 21, 13, 16, 33);
    s.session(sessionRow({ id: S3, created_at: '2026-10-21 13:16:32', model_config_json: modelConfig(REQ, 'high') }));
    s.op('UPDATE sessions SET goose_mode = ? WHERE id = ?', ['smart_approve', S3]);
    s.message(S3, T3, 'msg_g1', 'user', [text('Start working toward this goal now:\n\n**Goal:** README.md mentions the word toyshop')], { userVisible: false });
    s.op('UPDATE sessions SET name = ?, user_set_name = 1 WHERE id = ?', ['gs3-effort', S3]);
    s.message(S3, T3 + 2, 'chatcmpl-g1', 'assistant', [text('Done.')], { ...inference(REQ), usage: usage(3000, 3, 0, 400) });
    s.ledger(S3, T3 + 3, SERVED, 3000, 3, 0);
    s.message(S3, T3 + 3, 'msg_g2', 'user', [text('Before finishing, check whether the following goal has been fully met:\n\n**Goal:** README.md mentions the word toyshop\n\nIf not, continue working toward it.')], { userVisible: false, operations: { retry: { nudged: true } } });
    s.message(S3, T3 + 4, 'steer_f446f645-132f-466d-bd9c-1966ddcccd88', 'user', [text('Also add the word STEERED at the end of your reply.')], { steer: true });
    s.message(S3, T3 + 5, 'msg_replay', 'user', [text('And is 397 prime? One line.')], { userVisible: false });
    s.message(S3, T3 + 7, 'chatcmpl-g2', 'assistant', [text('397 is prime. STEERED')], { ...inference(REQ), usage: usage(3100, 9, 0, 500) });
    s.ledger(S3, T3 + 8, SERVED, 3100, 9, 0);
    s.op('UPDATE sessions SET archived_at = ? WHERE id = ?', ['2026-10-21T13:42:16.664403276+00:00', S3]);
    s.message(S3, T3 + 4000, 'msg_after', 'user', [text('Back again after the archive.')]);
  }

  // 20261021_8: a CLI fork of 20261021_1: its first rows copied with their message ids, times and
  // metadata.usage, and no ledger rows; then a turn of its own.
  {
    const F = '20261021_8';
    s.session(sessionRow({ id: F, name: 'cart tests (copy)', created_at: '2026-10-21 13:30:00', model_config_json: modelConfig(REQ, 'high') }));
    const unflipped = (r) => ({ ...JSON.parse(r.metadata_json), agentVisible: true });
    for (const r of s1.filter((x) => ['msg_u1', 'msg_tc1', 'chatcmpl-a1', 'msg_r1', 'chatcmpl-a2'].includes(x.message_id))) {
      s.message(F, r.created_timestamp, r.message_id, r.role, JSON.parse(r.content_json), unflipped(r), { verbatim: true });
    }
    s.message(F, T + 300, 'msg_f1', 'user', [text('Now add a coupon test.')]);
    s.message(F, T + 303, 'chatcmpl-f1', 'assistant', [text('Added test_coupon.')], { ...inference(REQ), usage: usage(6100, 30, 5120, 900) });
    s.ledger(F, T + 304, SERVED, 6100, 30, 5120);
  }

  // 20261021_4: a truncate (ACP conversation/truncate: rows from T+60 deleted, the ledger kept),
  // a new turn, and a call still running at the end: its message and usage are held.
  {
    const S4 = '20261021_4';
    const T4 = at(2026, 10, 21, 14, 0, 1);
    s.session(sessionRow({ id: S4, name: 'ducks', user_set_name: 1, session_type: 'acp', created_at: '2026-10-21 14:00:00' }));
    s.message(S4, T4, 'msg_t1', 'user', [text('List the toy SKUs.')]);
    s.message(S4, T4 + 2, 'chatcmpl-t1', 'assistant', [text('TRAIN-42, DUCK-07.')], { ...inference(REQ), usage: usage(4000, 9, 0, 800) });
    s.ledger(S4, T4 + 3, SERVED, 4000, 9, 0);
    s.message(S4, T4 + 60, 'msg_t2', 'user', [text('Now count the ducks with the shell.')]);
    s.message(S4, T4 + 62, 'chatcmpl-t2', 'assistant', [req('call-ducks', 'shell', { command: 'grep -c DUCK stock.txt' }, 'developer')], { ...inference(REQ), usage: usage(4100, 20, 3072, 900) });
    s.ledger(S4, T4 + 63, SERVED, 4100, 20, 3072);
    s.message(S4, T4 + 63, 'msg_tr', 'user', [resp('call-ducks', [text('7')], { isError: false, resultType: 'complete', structured: { stdout: '7', stderr: '', exit_code: 0 } })]);
    s.message(S4, T4 + 64, 'chatcmpl-t3', 'assistant', [text('7 ducks.')], { ...inference(REQ), usage: usage(4200, 4, 3072, 400) });
    s.ledger(S4, T4 + 65, SERVED, 4200, 4, 3072);
    s.op('DELETE FROM messages WHERE session_id = ? AND created_timestamp >= ?', [S4, T4 + 60]);
    s.message(S4, T4 + 200, 'msg_t3', 'user', [text('Instead, show the stock of DUCK-07.')]);
    s.message(S4, T4 + 202, 'chatcmpl-t4', 'assistant', [req('call-stock2', 'shell', { command: 'grep DUCK-07 stock.txt' }, 'developer')], { ...inference(REQ), usage: usage(4300, 15, 3072, 600) });
    s.ledger(S4, T4 + 203, SERVED, 4300, 15, 3072);
  }

  // 20261021_5: extensions and a recipe whose values carry tokens (args, header, SSE URL query, a
  // cmd with its args folded in, inline code), recipe parameter defaults and sub-recipe values,
  // and user recipe values: every one redacted in `read`.
  {
    const S5 = '20261021_5';
    const T5 = at(2026, 10, 21, 15, 0, 1);
    s.session(sessionRow({
      id: S5, name: 'redaction', user_set_name: 1, created_at: '2026-10-21 15:00:00',
      extension_data: extData([
        DEVELOPER,
        { type: 'streamable_http', name: 'toyhttp', uri: 'http://localhost/mcp', envs: {}, env_keys: [], headers: { 'X-Toy-Header': 'toy-header-value' }, timeout: 300, bundled: null },
        { type: 'stdio', name: 'toyargs', cmd: 'npx', args: ['-y', 'toy-mcp', `--token=${ARG_TOKEN}`], envs: {}, env_keys: ['TOY_SHOP_KEY'], timeout: 300, cwd: null, bundled: null },
        { type: 'sse', name: 'toysse', uri: `https://toy-mcp.example/sse?token=${URL_TOKEN}`, envs: {}, env_keys: [], timeout: 300, bundled: null },
        { type: 'stdio', name: 'toycmd', cmd: `toy-mcp --token ${ARG_TOKEN}`, args: [], envs: {}, env_keys: [], timeout: 300, bundled: null },
        { type: 'inline_python', name: 'toypy', code: `TOKEN = "${ARG_TOKEN}"`, timeout: 300, dependencies: null },
        SUMMON,
      ]),
      recipe_json: JSON.stringify({
        version: '1.0.0', title: 'Count tests', extensions: [{ type: 'stdio', name: 'toyrec', cmd: 'python3', args: [], envs: { TOY_LEVEL: 'shelf-7' } }],
        parameters: [{ key: 'shop_key', input_type: 'string', requirement: 'optional', description: 'the shop key', default: RECIPE_VALUE }],
        sub_recipes: [{ name: 'count_tests', path: '/home/user/work/recipes/count-tests.yaml', values: { shop_key: RECIPE_VALUE } }],
      }),
      user_recipe_values_json: JSON.stringify({ shop_key: RECIPE_VALUE, shelf: 'B-2' }),
    }));
    s.message(S5, T5, 'msg_ok', 'user', [text('Reply with exactly: ok')]);
    s.message(S5, T5 + 2, 'chatcmpl-ok', 'assistant', [text('ok')], { ...inference(REQ), usage: usage(3949, 3, 0, 300) });
    s.ledger(S5, T5 + 3, SERVED, 3949, 3, 0);
  }

  // 20261020_14: a `goose term` session (kind terminal): the shell history the user's prompt
  // carries, and its turn context.
  {
    const S6 = '20261020_14';
    const T6 = at(2026, 10, 20, 9, 36, 17);
    s.session(sessionRow({ id: S6, name: 'Goose Term Session', session_type: 'terminal', working_dir: '/home/user/work/inventory-cli', created_at: '2026-10-20 09:36:07', model_config_json: modelConfig(FLASH) }));
    s.message(S6, T6, 'msg_bdf5f251-5601-4c42-b16a-287d1751c6c1', 'user', [text('<shell_history>\nnode src/cli.js list\ngit status --short\n</shell_history>\n\nWhich two shell commands did I just run? One line.')]);
    s.message(S6, T6 + 1, 'msg_befc7038-a835-43df-a240-dae19fe2ceb1', 'user', [turnContext('2026-10-20 09:36:00 +00:00', '/home/user/work/inventory-cli')], { userVisible: false, turnContext: true });
    s.message(S6, T6 + 2, 'gen-1792489179-toyTermReply0001', 'assistant', [{ type: 'thinking', thinking: 'Read the history block.', signature: 'c2lnbmF0dXJl' }, text('node src/cli.js list, then git status --short.')],
      { ...inference(FLASH), usage: usage(4413, 119, 4096, 1200, { cacheWriteTokens: 0 }) });
    s.ledger(S6, T6 + 3, FLASH_SERVED, 4413, 119, 4096, { cacheWrite: 0, cost: 0.000131238, costSource: 'estimated' });
  }

  // 20261021_6: an ACP session whose prompt carries an image.
  {
    const S7 = '20261021_6';
    const T7 = at(2026, 10, 21, 13, 39, 30);
    s.session(sessionRow({ id: S7, name: 'New Chat', session_type: 'acp', working_dir: '/home/user/work/inventory-cli', created_at: '2026-10-21 13:39:25', project_id: 'toy-project-1' }));
    s.message(S7, T7, 'msg_76a1c7ac-c18d-4cc1-ad36-72078209764c', 'user', [text('Here is a toy label image. In one line: what text is on the label?'), { type: 'image', data: PNG, mimeType: 'image/png' }]);
    s.message(S7, T7 + 3, 'chatcmpl-img', 'assistant', [text('The label reads SKU-0042.')], { ...inference(REQ), usage: usage(4843, 12, 4096, 900) });
    s.ledger(S7, T7 + 4, SERVED, 4843, 12, 4096);
  }

  write('features', s);
}

// ---- conformance-goose-sentinel
// ------------------------------------------------------------------

const SENTINEL = 'sentinel-0a1b2c3d4e5f-not-a-secret';
const SENTINEL_EXTENSIONS = '{"enabled_extensions.v0":{"extensions":[{"type":"builtin","name":"developer","description":"Write and edit files, and execute shell commands","display_name":"Developer","timeout":null,"bundled":true},{"type":"stdio","name":"rf4sentinel","description":"rf4 sentinel fixture (fake env value)","cmd":"/bin/true","args":[],"envs":{"RF4_SENTINEL_TOKEN":"sentinel-0a1b2c3d4e5f-not-a-secret"},"env_keys":[],"timeout":300,"cwd":null,"bundled":null},{"type":"platform","name":"summon","description":"Load knowledge and delegate tasks to subagents","display_name":"Summon","bundled":true},{"type":"platform","name":"skills","description":"Discover and provide skill instructions from filesystem and builtins","display_name":"Skills","bundled":true},{"type":"platform","name":"apps","description":"Create and manage custom Goose apps through chat. Apps are HTML/CSS/JavaScript and run in sandboxed windows.","display_name":"Apps","bundled":true},{"type":"platform","name":"analyze","description":"Analyze code structure with tree-sitter: directory overviews, file details, symbol call graphs","display_name":"Analyze","bundled":true},{"type":"platform","name":"scheduler","description":"Create and manage scheduled recipe execution","display_name":"Scheduler","bundled":true},{"type":"platform","name":"tom","description":"Inject custom context into every turn via GOOSE_MOIM_MESSAGE_TEXT and GOOSE_MOIM_MESSAGE_FILE environment variables","display_name":"Top Of Mind","bundled":true},{"type":"platform","name":"Extension Manager","description":"Enable extension management tools for discovering, enabling, and disabling extensions","display_name":"Extension Manager","bundled":true}]}}';
// The sentinel capture's session row, whole as captured (every column).
const SENTINEL_ROW = {
  id: '20261021_9', name: 'Synthetic t', description: '', user_set_name: 0, session_type: 'user', working_dir: '/home/user/work/rf4/toyshop',
  created_at: '2026-10-21 22:44:00', updated_at: '2026-10-21 22:44:02', extension_data: SENTINEL_EXTENSIONS,
  total_tokens: 3952, input_tokens: 3949, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: null, accumulated_total_tokens: 3952,
  accumulated_input_tokens: 3949, accumulated_output_tokens: 3, accumulated_cache_read_tokens: 0, accumulated_cache_write_tokens: 0, accumulated_cost: null,
  schedule_id: null, recipe_json: null, user_recipe_values_json: null, provider_name: 'openai',
  model_config_json: '{"model_name":"gateway/toy-model-a","temperature":null,"max_tokens":131072,"toolshim":false,"toolshim_model":null,"reasoning":true,"supports_vision":false}',
  goose_mode: 'auto', archived_at: null, project_id: null, parent_session_id: null, system_prompt_override: null, system_prompt_extras_json: null, container_id: null,
};

function sentinel() {
  const s = new Store({ rid: 505, lid: 140 });
  s.session(SENTINEL_ROW);
  s.message('20261021_9', 1792622641, 'msg_b114b1ba-9dee-4f2d-a72f-a025db88e392', 'user', [text('Reply with exactly: ok')]);
  s.message('20261021_9', 1792622642, 'chatcmpl-FixtureFixt00067', 'assistant', [text('ok')], { ...inference('gateway/toy-model-a'), usage: usage(3949, 3, 0, 1200) });
  s.ledger('20261021_9', 1792622642, SERVED, 3949, 3, 0);
  // The session the free-text fixtures belong to: a row of the same shape (the capture keeps its
  // messages only), with the same extensions enabled.
  s.session({ ...SENTINEL_ROW, id: '20261021_10', created_at: '2026-10-21 22:44:20', updated_at: '2026-10-21 22:44:27', total_tokens: 4066, input_tokens: 3968, output_tokens: 98, accumulated_total_tokens: 4066, accumulated_input_tokens: 3968, accumulated_output_tokens: 98 });
  // The sentinel capture's free-text message and its assistant echo, verbatim.
  s.message('20261021_10', 1792622662, 'msg_4529c054-7cae-44c7-89b0-07890b209751', 'user', [text(`Remember this fake key: ${SENTINEL}, reply ok`)], { userVisible: true, agentVisible: true }, { id: 509, verbatim: true });
  s.message('20261021_10', 1792622666, 'chatcmpl-FixtureFixt00068', 'assistant', [text(`Synthetic reply 5e1d2a: the key \`${SENTINEL}\` is noted for the fixture.`)],
    { userVisible: true, agentVisible: true, inference: { provider: 'openai', requestedModel: 'gateway/toy-model-a' }, usage: { inputTokens: 3968, outputTokens: 98, totalTokens: 4066, cacheReadTokens: 0, elapsedMs: 4638, timeToFirstTokenMs: 4092 }, operations: { llm: { advertised_tools: TOOLS_MAIN } } },
    { id: 511, verbatim: true });
  s.ledger('20261021_10', 1792622667, SERVED, 3968, 98, 0);
  write('conformance-goose-sentinel', s);
}

lab();
features();
sentinel();
