// The conformance matrix: for every checklist item (conformance/checklist.js) and every harness,
// what proves it. A cell is a list of proofs, or `{ na }` with the reason the item does not apply:
//   { generic: true }                  the check in conformance/generic.js, run over every fixture
//   { test: '<file>', match: '<text>' } a test in test/<file> whose title contains <text>
// or `{ open }`: the harness may fail the item, and the item's reading waits on a ruling.
// test/conformance-matrix.test.js refuses an empty cell, a proof whose test does not exist, and a
// docs/conformance-matrix.md that is not what `node conformance/matrix.js --write` makes.
//
//   node conformance/matrix.js           print the matrix as markdown
//   node conformance/matrix.js --write   write docs/conformance-matrix.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEMS } from './checklist.js';

export const HARNESSES = [
  'claude-code', 'codex', 'copilot-cli', 'gemini-cli', 'vscode', 'goose',
  'opencode', 'agy', 'cursor', 'cursor-agent', 'zed', 'devin',
];

const G = { generic: true };
const all = (cell) => Object.fromEntries(HARNESSES.map((h) => [h, cell]));

// Items the package proves once for every harness (host, harness_path).
const HOST = [{ test: 'host.test.js', match: 'host: derived from the machine id when one is readable' }, { test: 'host.test.js', match: 'host label: the short hostname, never part of a key' }];
const REGENERATED = [{ test: 'host.test.js', match: 'host: sha256 of the salt and the machine id' }];
const KNOWN = [{ test: 'host.test.js', match: 'host: the known answers' }, { test: 'harness-path.test.js', match: 'harness_path: one folder reached by two spellings gives one value' }, { test: 'harness-path.test.js', match: 'harness_path: on a case-insensitive volume, the on-disk case' }];

// Per-harness proofs. `t(file, match)` names a test in test/<file>.test.js; `na(reason)` says why
// the item cannot be shown for that harness.
const t = (file, match) => ({ test: `${file}.test.js`, match });
const na = (reason) => ({ na: reason });
const open = (reason) => ({ open: reason });
const each = (fn) => Object.fromEntries(HARNESSES.map((h) => [h, fn(h)]));

// Titles every harness's own test file carries once (templated per fixture case, or one test).
const GOLDEN = (h) => t(h, 'the full replay equals the reviewed golden');
const GROWTH = (h) => t(h, 'every incremental path folds to the full replay');
const LINT = (h) => t(h, 'no string under a secret-looking name');
const DESCRIBE = (h) => t(h, 'describe states every facet');
// The shared readers every adapter of a kind goes through (src/sources.js, src/sqlite.js).
const STREAM_APPEND = t('sources', 'stream: an append gives exactly the new lines');
const STREAM_PARTIAL = t('sources', 'stream: a partial last line is held back, then returned whole');
const STREAM_RESET = t('sources', 'stream: a new inode, a shrink, a changed line 1 or a same-size tail rewrite is a reset');
const SQL_DELTA = t('sqlite', 'sqlite: readDelta diffs against known; gone lists vanished keys');
const SQL_WAL = t('sqlite', 'sqlite: a WAL-only committed row is read while a writer holds the -wal');

const FOLDER_STORE = 'describe store_shape is folder: harness_path is the data folder, never a database file';
const NO_DELTA = 'no delta source: describe lists stream and snapshot sources only';
const NO_MIGRATION = 'no migration copies records in this harness store';

export const MATRIX = {
  'M.replay': each((h) => [GOLDEN(h), GROWTH(h)]),
  'M.keys-stable': all([G]),
  'M.file-stores': {
    ...each(() => na(FOLDER_STORE)),
    opencode: [t('opencode', 'every store is its database file: default, channel and OPENCODE_DB stores list their own sessions'), t('harness-path', 'a database file is accepted')],
  },
  'M.host': all(HOST),
  'M.regenerated-id': all(REGENERATED),
  'M.known-answers': all(KNOWN),
  'M.one-store-one-session': all([G]),
  'M.incarnation': {
    // reuse impossible: the shape check (src/validate.js) enforces incarnation '', and describe declares it.
    'claude-code': [G, DESCRIBE('claude-code'), t('claude-code', 'list names every session and its sources')],
    codex: [G, DESCRIBE('codex'), t('codex', 'list names every session and its rollouts')],
    'copilot-cli': [t('copilot-cli', 'a reused --session-id is a new incarnation; the old one reads incarnation_gone'), t('copilot-cli', 'a rewind (new inode, shorter file, appended session.info{rewind}) is a reset'), DESCRIBE('copilot-cli')],
    'gemini-cli': [G, DESCRIBE('gemini-cli')],
    vscode: [G, DESCRIBE('vscode'), t('vscode', 'list names every chat file of the user-data folder')],
    goose: [t('goose', 'session record: title, created (UTC), archived'), t('goose', 'an id reused after a delete is a new incarnation'), DESCRIBE('goose')],
    opencode: [G, DESCRIBE('opencode')],
    agy: [G, DESCRIBE('agy')],
    cursor: [G, DESCRIBE('cursor')],
    'cursor-agent': [G, DESCRIBE('cursor-agent')],
    zed: [G, DESCRIBE('zed')],
    devin: [t('devin', 'a turn: each message once (twins, prefix copies)'), t('devin', 'an incarnation Devin never gives'), DESCRIBE('devin')],
  },
  'M.anchored-ids': {
    'claude-code': na('every message carries its native uuid; a rewind is a new branch in an append-only file, never a truncate and regrow'),
    codex: na('a backtrack is invisible (describe lifecycle.rewind); keys are native ids, or byte offsets of an append-only rollout'),
    'copilot-cli': na('every message is keyed by its native event id; a rewound and regrown turn has new event ids'),
    'gemini-cli': na('every record carries its native id; a rewind retracts in place, and the regrown turn has new ids'),
    vscode: na('a reply is keyed by its native responseId; the request regrown after a kind 2 splice has new ids'),
    goose: [t('goose', 'anchored ids: a reply regrown under its surviving anchor keeps its `<id>+n` key, revised, never two messages'), t('goose', 'anchored ids: a reply regrown under a new anchor gets a new key'), t('goose', 'ids: a NULL message_id is anchored on the previous native id')],
    opencode: na('every message is its native row id; a revert deletes rows and a regrow mints new ids'),
    agy: na('with a DB, keys are step content ids, never the reused idx (the DB rewind test); without one, @offset ids in an append-only transcript'),
    cursor: [t('cursor', 'anchored ids: a reply regenerated under its surviving user bubble keeps `<bubbleId>:assistant`, revised, never two messages'), t('cursor', 'anchored ids: a reply regrown under a new user bubble gets a new key'), t('cursor', 'edit: the user bubble rewritten in place (same id)')],
    'cursor-agent': na('a reply is keyed on its turn\'s native request_id; a rewind and regrow mints new request ids (the rewind test)'),
    zed: [t('zed', 'zed/restore-lab (capture): the regrown Agent messages get keys no pre-restore message had'), t('zed', 'zed/restore: an appended turn keeps every earlier key unchanged (positive control); a checkpoint restore drops exactly the cut keys')],
    devin: na('every node carries its native message_id; a revert moves main_chain_id and the regrown branch has new ids'),
  },
  'M.tool-linkage': all([G]),
  'M.folding': {
    'claude-code': [t('claude-code', 'one uuid in two main sources keeps the lowest-order copy, whatever the read order')],
    codex: [t('codex', 'one id in two rollouts of a session keeps the lowest-order copy, whatever the read order')],
    'copilot-cli': na('every event line carries its own id in an append-only file: no native id is written twice in a session (a fork copies ids into another session)'),
    'gemini-cli': [t('gemini-cli', 'fold ops: orderIds, a $rewindTo the fold does not hold, a legacy $set.messages'), t('gemini-cli', 'held: a waiting tail reply, a reply re-held with a running call, then complete')],
    vscode: [t('vscode', 'the features golden holds the normaliser'), t('vscode', 'the reply still being written is held, never live')],
    goose: [t('goose', 'compaction: earlier rows flipped in place are to_model false (keys kept)'), t('goose', '--edit re-mints rowids: the same keys and records'), t('goose', 'ids: a NULL message_id is anchored on the previous native id')],
    opencode: [t('opencode', 'held: the streaming reply is held, not written; once complete, only it and the session record change')],
    agy: [t('agy', 'a running tool holds its planner and itself, not the steps after them; its end releases both'), t('agy', 'a background task: written as it stands when its turn ends, revised when it finishes')],
    cursor: [t('cursor', 'edit: the user bubble rewritten in place (same id)'), t('cursor', 'held again: a reply regenerated after an edit keeps its last version')],
    'cursor-agent': [t('cursor-agent', 'held: the last reply waits while its tool runs or no step exists'), t('cursor-agent', 'compaction: a summary after the turn it covers')],
    zed: [t('zed', 'an open call in the last turn is held; the result releases it; held again')],
    devin: [t('devin', 'a turn: each message once (twins, prefix copies)'), t('devin', 'every save re-inserts every node')],
  },
  'M.migration-fold': {
    'claude-code': na(NO_MIGRATION),
    codex: na(`${NO_MIGRATION}; a resumed rollout's verbatim copy is a revision of the same id (M.folding)`),
    'copilot-cli': na(NO_MIGRATION),
    'gemini-cli': [t('gemini-cli', 'lab cases: 56749748 rewind, twin errors'), t('gemini-cli', 'a legacy .json migrated to .jsonl: the session keeps its keys and continues')],
    vscode: [t('vscode', 'one id in both formats reads the change log')],
    goose: na('the one migration known, an upgraded store\'s threads tables, is never read (describe read): no copy reaches derive'),
    opencode: na(`${NO_MIGRATION}: an older schema is read in place (the older-schema test)`),
    agy: na(NO_MIGRATION),
    cursor: na(`${NO_MIGRATION}: the older format (bubbles inline in composerData) is read where it is, never beside a copy`),
    'cursor-agent': na(NO_MIGRATION),
    zed: na('Zed upgrades a legacy agent-1 thread in place, under its own row, and list skips it until then: no copy exists'),
    devin: na(NO_MIGRATION),
  },
  'M.explicit-links': {
    'claude-code': na('describe linkage states no link (fork, subagent, rewind_copy, clear, continuation: none); sub-agents live in the session\'s own sources'),
    codex: na('describe linkage states no link (fork, subagent, rewind_copy, clear, continuation: none)'),
    'copilot-cli': [t('copilot-cli', 'forks: the origin states each child, the child states its origin'), t('copilot-cli', 'a sub-agent stays in the session with agent_id')],
    'gemini-cli': [DESCRIBE('gemini-cli'), GOLDEN('gemini-cli')],
    vscode: [t('vscode', 'the lab cases of the annex')],
    goose: [t('goose', 'sub-agents: the child states its parent, the parent the child it was delivered')],
    opencode: [DESCRIBE('opencode'), t('opencode', 'a fork copy that re-minted its ids has the origin prefix cmp_sha; it states no link')],
    agy: [t('agy', 'lab case: a fork links to its origin at the fork point'), t('agy', 'a sub-agent is linked from both sides')],
    cursor: [t('cursor', 'sub-agents: the parent names them'), t('cursor', 'fork: a new composer with identical bubble ids and times, no parent field: no link')],
    'cursor-agent': [t('cursor-agent', 'lab case: subagentInfo.parentAgentId'), t('cursor-agent', 'fork: the blobs copied to a new chat id')],
    zed: [t('zed', 'sub-agents: the child states its parent')],
    devin: [t('devin', 'a sub-agent in the same tree')],
  },
  'M.cmp-sha': {
    'claude-code': na('a fork is invisible (describe lifecycle.fork, linkage.fork none): no fork copy is in the store'),
    codex: na('a fork is invisible (describe lifecycle.fork, linkage.fork none): no fork copy is in the store'),
    'copilot-cli': na('a fork copies the origin\'s events with their ids (the forks test: ids_preserved): no copy re-mints ids'),
    'gemini-cli': na('no fork copy is captured: /chat save and resume copy history into a new session (spec §5), and whether its record ids are re-minted is not established'),
    vscode: [t('vscode', 'one id in both formats reads the change log; a mid-file kind 0 drops what came before')],
    goose: na('a fork copies rows with their message_id (describe linkage.fork): no copy re-mints ids'),
    opencode: [t('opencode', 'a fork copy that re-minted its ids has the origin prefix cmp_sha')],
    agy: na('a fork keeps the copied rows\' content ids (the fork test): no copy re-mints ids'),
    cursor: na('a fork keeps the copied bubble ids (the fork test): no copy re-mints ids'),
    'cursor-agent': na('a fork copies the blobs with their message ids (the fork test): no copy re-mints ids'),
    zed: na('no fork was observed (describe linkage.fork none)'),
    devin: na('a fork copy keeps node_ids and message_ids (describe linkage.fork): no copy re-mints ids'),
  },
  'M.retraction': {
    'claude-code': na('a rewind is a new branch in the parentUuid tree and the file only grows: nothing is retracted or destroyed (describe lifecycle.rewind)'),
    codex: na('rewind and edit are invisible (describe lifecycle): no rollout record retracts or destroys a message'),
    'copilot-cli': [t('copilot-cli', 'a rewind (new inode, shorter file, appended session.info{rewind}) is a reset')],
    'gemini-cli': [t('gemini-cli', 'an append-only retraction ($rewindTo) stays appended'), t('gemini-cli', 'lab cases: 56749748 rewind, twin errors, pass3 patch')],
    vscode: [t('vscode', 'a kind 2 with i arrives appended; the cut requests stay, retracted')],
    goose: [t('goose', 'a truncate deletes rows: delta with gone, the vanished keys go')],
    opencode: [t('opencode', 'retraction vs destruction')],
    agy: [t('agy', 'a DB rewind: deleted rows and a reused idx reach read as a delta'), t('agy', 'fork-retract: step_index 38 after 43 retracts lines 0-1')],
    cursor: [t('cursor', 'edit: the user bubble rewritten in place (same id), its children overwritten, later bubbles hard-deleted')],
    'cursor-agent': [t('cursor-agent', 'rewind: the root moves back, a snapshot change of meta, never a reset')],
    zed: [t('zed', 'zed/restore: an appended turn keeps every earlier key unchanged')],
    devin: [t('devin', 'revert and edit: only main_chain_id moves')],
  },
  'M.speaker-split': {
    'claude-code': [t('claude-code', 'speaker split: a user record holding tool results and text')],
    codex: na('each response_item has one role: no native record holds both sides'),
    'copilot-cli': na('each event is one speaker (user.message, assistant.message, tool.execution_complete): no native record holds both sides'),
    'gemini-cli': [t('gemini-cli', 'a tool turn: thoughts, the reply, call and result parts')],
    vscode: [t('vscode', 'speaker split: one request gives a user message keyed by its requestId')],
    goose: [t('goose', 'speaker split: a row holding a tool result and text')],
    opencode: na('each message row has one role, and a tool part holds its call and result on the assistant message (describe linkage.tool)'),
    agy: na('each step is one speaker (a user input, a planner response, a tool result as its own step)'),
    cursor: [t('cursor', 'one speaker per message: the user bubble, then <bubbleId>:assistant')],
    'cursor-agent': [t('cursor-agent', 'lab case: turn key = request_id')],
    zed: na('User and Agent are separate items of the thread\'s messages; an Agent\'s tool results stay its own parts'),
    devin: na('each node is one chat message with one role; a tool result is its own node'),
  },
  'M.orphans': {
    'claude-code': na('the transcript file is the session: a delete removes it (describe lifecycle.delete), so no transcript outlives its session'),
    codex: na('the rollout file is the session: a delete removes it (describe lifecycle.delete), so no transcript outlives its session'),
    'copilot-cli': [t('copilot-cli', 'list omits a deleted session though session-store.db keeps its rows as orphans')],
    'gemini-cli': [t('gemini-cli', 'checkpoints, logs.json, projects.json and rewrite backups are never opened')],
    vscode: na('the chat file is the session: a delete removes it (describe lifecycle.delete); the side transcript under GitHub.copilot-chat is never read, and no fixture holds one'),
    goose: na('one sessions.db: a delete removes the sessions row with its messages and ledger rows, so no index outlives a session'),
    opencode: na('one database file: a delete removes the session row with its rows and events, so no index outlives a session'),
    agy: [t('agy', 'list names each conversation DB and each DB-less transcript')],
    cursor: [t('cursor', 'errors: an unknown chat, another chat')],
    'cursor-agent': [t('cursor-agent', 'cursor-orphan: a transcript whose chat was deleted is never listed')],
    zed: [t('zed', 'errors: an unknown session or source, a legacy thread, a channel with no DB, a deleted thread')],
    devin: na('a delete removes the sessions row, its nodes and tool states (describe lifecycle.delete), so no index outlives a session'),
  },
  'M.compaction': {
    'claude-code': [G, t('claude-code', 'compaction is not deletion: every message derived before the compact_boundary stays')],
    codex: [t('codex', 'compaction is not deletion')],
    'copilot-cli': [t('copilot-cli', 'its prompt is automated; image and summary parts')],
    'gemini-cli': na('compaction is invisible (describe lifecycle.compaction): no summary record was ever captured'),
    vscode: [t('vscode', 'compaction is not deletion')],
    goose: [t('goose', 'compaction: earlier rows flipped in place are to_model false (keys kept)')],
    opencode: [G, t('opencode', 'compaction is not deletion: every replaced message stays current')],
    agy: [t('agy', 'fork-retract: step_index 38 after 43 retracts lines 0-1'), t('agy', 'lab case: a CHECKPOINT is a summary replacing through included_step_index_end')],
    cursor: na('compaction is invisible (describe lifecycle.compaction, linkage.compaction none): not exercised in the lab'),
    'cursor-agent': [t('cursor-agent', 'compaction: a summary after the turn it covers')],
    zed: [G, t('zed', 'Resume and Compaction (source-read, UNVERIFIED)')],
    devin: [G, t('devin', 'compaction: the compactor reply is a summary')],
  },
  'M.redaction': {
    'claude-code': [LINT('claude-code')],
    codex: [LINT('codex')],
    'copilot-cli': [LINT('copilot-cli')],
    'gemini-cli': [LINT('gemini-cli'), t('gemini-cli', 'checkpoints, logs.json, projects.json and rewrite backups are never opened')],
    vscode: [LINT('vscode'), t('vscode', 'redaction: selectedModel.metadata.auth never leaves read'), t('vscode', 'redaction: a value below selectedModel.metadata.auth')],
    goose: [LINT('goose'), t('goose', 'redaction: the extension env sentinel'), t('goose', 'redaction: extension args, headers, URLs'), t('goose', 'redaction: an extension config outside an')],
    opencode: [LINT('opencode'), t('opencode', 'redaction: provider-error payloads and URL tokens'), t('opencode', 'redaction: a tool attachment')],
    agy: [LINT('agy'), t('agy', 'a file part\'s URI: http(s) cut to scheme://host')],
    cursor: [LINT('cursor'), t('cursor', 'redaction: the composer\'s two keys are replaced in read')],
    'cursor-agent': [LINT('cursor-agent'), t('cursor-agent', 'lab case: blobEncryptionKey and encrypted_model are never emitted'), t('cursor-agent', 'credential tools: args keep naming keys only'), t('cursor-agent', 'an mcp step to a credential tool'), t('cursor-agent', 'a step of a kind the adapter does not know is redacted in read')],
    zed: [LINT('zed'), t('zed', 'redaction: the sentinel on remote_url, diff and draft_prompt')],
    devin: [LINT('devin')],
  },
  'M.setup': all([G]),
  'M.usage': {
    'claude-code': [G],
    codex: [G],
    'copilot-cli': [G, t('copilot-cli', 'usage, served model and effort by apiCallId'), t('copilot-cli', 'cost is Copilot'), t('copilot-cli', 'a reply cut off by the output cap leaves a usage record and no message')],
    'gemini-cli': [G, t('gemini-cli', 'lab cases: 56749748 rewind, twin errors, pass3 patch, one call, injected context, tokens')],
    vscode: [G, t('vscode', 'the lab cases of the annex')],
    goose: [G, t('goose', 'a turn: native ids, the result row a tool message claimed by call id, reasoning, ledger usage'), t('goose', 'copied usage: a fork copy with metadata.usage'), t('goose', 'the ledger rows it leaves are session usage records')],
    opencode: [G, t('opencode', 'usage: v1 has both flags false, v2 both null')],
    agy: [G, t('agy', 'a turn: content ids, a call and its result, reasoning, usage and the served model'), t('agy', 'is billed once, on its first step')],
    cursor: [G, t('cursor', 'tokens: {0,0} is unknown, so no usage record')],
    'cursor-agent': na('cursor-agent stores no usage (sessions-model §2.4 table); the turn test asserts no fixture yields a usage record'),
    zed: [G, t('zed', 'a thread with both cumulative_token_usage and request_token_usage yields exactly one usage record'), t('zed', 'an empty cumulative_token_usage gives one per_turn usage record per request_token_usage entry')],
    devin: [G, t('devin', 'a turn: each message once (twins, prefix copies), context injected, tools as tool messages, reasoning, usage')],
  },
  'S.describe': each((h) => [DESCRIBE(h), t('describe', 'describe: every adapter states what its harness_path names')]),
  'S.positive': {
    ...each((h) => [GOLDEN(h), GROWTH(h)]),
    'claude-code': [GOLDEN('claude-code'), GROWTH('claude-code'), STREAM_APPEND],
    codex: [GOLDEN('codex'), GROWTH('codex'), STREAM_APPEND],
    'copilot-cli': [GOLDEN('copilot-cli'), GROWTH('copilot-cli'), t('copilot-cli', 'read: appended gives exactly the new lines')],
    'gemini-cli': [GOLDEN('gemini-cli'), GROWTH('gemini-cli'), t('gemini-cli', 'a partial last line is held back, and returned whole once complete')],
    vscode: [GOLDEN('vscode'), GROWTH('vscode'), STREAM_APPEND],
    opencode: [GOLDEN('opencode'), GROWTH('opencode'), t('opencode', 'the event log is a seq stream: a new removal appends')],
    agy: [GOLDEN('agy'), GROWTH('agy'), t('agy', 'read of the transcript: a partial last line is held back until whole, then appended')],
    'cursor-agent': [GOLDEN('cursor-agent'), GROWTH('cursor-agent'), t('cursor-agent', 'positive control: one appended turn keeps every earlier key unchanged')],
    zed: [GOLDEN('zed'), GROWTH('zed'), t('zed', 'zed/restore: an appended turn keeps every earlier key unchanged (positive control)')],
  },
  'S.negative': {
    'claude-code': [t('claude-code', 'a rewrite of the transcript (new inode, shorter) is a reset, and vanished keys go'), STREAM_RESET],
    codex: [t('codex', 'a rewrite of a rollout (new inode, shorter) is a reset, and vanished keys go'), STREAM_RESET],
    'copilot-cli': [t('copilot-cli', 'a rewind (new inode, shorter file, appended session.info{rewind}) is a reset'), t('copilot-cli', 'any shorter rewrite of events.jsonl is a reset')],
    'gemini-cli': [t('gemini-cli', 'a rewrite of the chat file (new inode, shorter) is a reset, and vanished keys go'), t('gemini-cli', 'an append-only retraction ($rewindTo) stays appended')],
    vscode: [t('vscode', 'a rewrite of the change log (new inode, shorter) is a reset, and vanished keys go'), t('vscode', 'a kind 2 with i arrives appended')],
    goose: [t('goose', 'a truncate deletes rows: delta with gone, the vanished keys go')],
    opencode: [t('opencode', 'the event log is a seq stream: a new removal appends, a wiped log resets')],
    agy: [t('agy', 'a DB rewind: deleted rows and a reused idx reach read as a delta; rewound ids go, kept ids stay')],
    cursor: [t('cursor', 'edit: the user bubble rewritten in place (same id), its children overwritten, later bubbles hard-deleted')],
    'cursor-agent': [t('cursor-agent', 'rewind: the root moves back, a snapshot change of meta, never a reset; the later turns leave live')],
    zed: [t('zed', 'a checkpoint restore drops exactly the cut keys (negative control)')],
    devin: [t('devin', 'every save re-inserts every node: new row ids and row times change nothing'), t('devin', 'revert and edit: only main_chain_id moves')],
  },
  'S.delta-known': {
    'claude-code': na(NO_DELTA),
    codex: na(NO_DELTA),
    'copilot-cli': na(NO_DELTA),
    'gemini-cli': na(NO_DELTA),
    vscode: na(NO_DELTA),
    goose: [t('goose', 'read: delta sources diff against known (unchanged, then a changed and a gone unit)'), SQL_DELTA],
    opencode: [t('opencode', 'read of a delta source with known: a changed row returns with a new sha, a deleted row is in gone'), SQL_DELTA],
    agy: [t('agy', 'read of a delta source: reset, then unchanged, then the changed and gone keys only'), SQL_DELTA],
    cursor: [t('cursor', 'read: the bubble range diffs against known (unchanged, then a changed and a gone unit)'), SQL_DELTA],
    'cursor-agent': [t('cursor-agent', 'read of blobs: reset, then unchanged, then only the new blobs; a known blob that vanished is gone')],
    zed: na(`${NO_DELTA}: a thread row is replaced whole on every save`),
    devin: na(`${NO_DELTA}: every save re-inserts every node, so one snapshot is read`),
  },
  'S.live-keys': each((h) => [GOLDEN(h), GROWTH(h)]),
  'S.unchanged': all([G]),
  'S.held-back': {
    'claude-code': [GROWTH('claude-code'), STREAM_PARTIAL],
    codex: [GROWTH('codex'), STREAM_PARTIAL],
    'copilot-cli': [t('copilot-cli', 'a partial last line is held back until whole; then unchanged')],
    'gemini-cli': [t('gemini-cli', 'a partial last line is held back, and returned whole once complete'), t('gemini-cli', 'a legacy .json still being written is held back')],
    vscode: [GROWTH('vscode'), t('vscode', 'a JSON snapshot that does not parse is held back, never returned'), t('vscode', 'the reply still being written is held, never live')],
    goose: [t('goose', 'a running call is held with its usage; its result releases it'), t('goose', 'list names every sessions row, its incarnation and its four sources')],
    opencode: [t('opencode', 'held: the streaming reply is held, not written'), t('opencode', 'a committed row only in the WAL is read while the writer holds it')],
    agy: [t('agy', 'read of the transcript: a partial last line is held back until whole'), t('agy', 'a reply still generating is held while its turn runs'), SQL_WAL],
    cursor: [t('cursor', 'held: a reply still generating, a tool still running'), t('cursor', 'a WAL-only row (Cursor running, no checkpoint) is read')],
    'cursor-agent': [t('cursor-agent', 'held: the last reply waits while its tool runs or no step exists'), SQL_WAL],
    zed: [t('zed', 'an open call in the last turn is held; the result releases it'), SQL_WAL],
    devin: [t('devin', 'held: a tail reply with no finish_reason is held'), t('devin', 'list names every sessions row, hidden ones too')],
  },
  'S.errors': {
    'claude-code': [t('claude-code', 'errors: an unknown session, an unknown source')],
    codex: [t('codex', 'errors: an unknown session, an unknown source, a deleted session')],
    'copilot-cli': [t('copilot-cli', 'errors: an unknown session, an unknown source, a deleted session'), t('copilot-cli', 'a reused --session-id is a new incarnation; the old one reads incarnation_gone')],
    'gemini-cli': [t('gemini-cli', 'errors: an unknown session, an unknown source, another session')],
    vscode: [t('vscode', 'errors: an unknown session, an unknown source, a path for an id, a deleted session')],
    goose: [t('goose', 'errors: an unknown session, an unknown source, a deleted session'), t('goose', 'an id reused after a delete is a new incarnation'), t('goose', 'a locked store (goose mid-save) is busy'), t('goose', 'damaged: a corrupt page, a row whose JSON does not parse')],
    opencode: [t('opencode', 'errors: an unknown session, an unknown or unreferenced source, a deleted session'), t('opencode', 'a lock past the wait is `busy`'), t('opencode', 'a damaged page or a row that does not parse is `damaged`')],
    agy: [t('agy', 'errors: an unknown session, an unknown source, a deleted session'), t('agy', 'a locked store is busy, a damaged one or an undecodable step is damaged')],
    cursor: [t('cursor', 'errors: an unknown chat, another chat'), t('cursor', 'a locked store (Cursor mid-save) is busy'), t('cursor', 'damaged: a stored bubble, composerData or header value that does not parse'), t('cursor', 'inconsistent: bubbles stored but no composerData row')],
    'cursor-agent': [t('cursor-agent', 'errors: an unknown session, an unknown source, a deleted chat'), t('cursor-agent', 'a locked store is busy, a damaged one or an undecodable meta row damaged'), t('cursor-agent', 'a torn tree: read of meta is the retryable inconsistent')],
    zed: [t('zed', 'errors: an unknown session or source'), t('zed', 'Zed saving (a write lock on threads.db) is busy'), t('zed', 'damaged: an undecodable blob is listed and reads damaged'), t('zed', 'a channel DB with a -wal but no -shm is busy')],
    devin: [t('devin', 'errors: an unknown session, an unknown source, an incarnation Devin never gives'), t('devin', 'a locked store is busy, a damaged one or a row that does not parse is damaged'), t('devin', 'a torn read is inconsistent')],
  },
  'S.held': {
    'claude-code': na('derive never holds a record: a message is final once its line is whole (held is always empty)'),
    codex: na('derive never holds a record: a message is final once its line is whole (held is always empty)'),
    'copilot-cli': [t('copilot-cli', 'a running tool holds only its own message; its completion returns it in changed and live')],
    'gemini-cli': [t('gemini-cli', 'held: a waiting tail reply, a reply re-held with a running call, then complete')],
    vscode: [t('vscode', 'a reply held again keeps its last version, and returns when complete')],
    goose: [t('goose', 'a running call is held with its usage; its result releases it')],
    opencode: [t('opencode', 'held: the streaming reply is held, not written; once complete')],
    agy: [t('agy', 'a held key keeps its last version: neither rewritten nor tombstoned'), t('agy', 'a running tool holds its planner and itself')],
    cursor: [t('cursor', 'held again: a reply regenerated after an edit keeps its last version, then returns complete')],
    'cursor-agent': [t('cursor-agent', 'a held key keeps its last version: a reply written once and regenerated is held'), t('cursor-agent', 'held: the last reply waits while its tool runs')],
    zed: [t('zed', 'an open call in the last turn is held; the result releases it; held again, the view keeps its last version')],
    devin: [t('devin', 'a held key keeps its last version: a reply written once and held again'), t('devin', 'held: a tail reply with a running call is held with its usage')],
  },
  'S.list-deleted': {
    'claude-code': [t('claude-code', 'errors: an unknown session, an unknown source')],
    codex: [t('codex', 'errors: an unknown session, an unknown source, a deleted session')],
    'copilot-cli': [t('copilot-cli', 'list omits a deleted session though session-store.db keeps its rows as orphans'), t('copilot-cli', 'errors: an unknown session, an unknown source, a deleted session')],
    'gemini-cli': [t('gemini-cli', 'errors: an unknown session, an unknown source, another session')],
    vscode: [t('vscode', 'errors: an unknown session, an unknown source, a path for an id, a deleted session')],
    goose: [t('goose', 'errors: an unknown session, an unknown source, a deleted session')],
    opencode: [t('opencode', 'errors: an unknown session, an unknown or unreferenced source, a deleted session')],
    agy: [t('agy', 'errors: an unknown session, an unknown source, a deleted session')],
    cursor: [t('cursor', 'errors: an unknown chat, another chat')],
    'cursor-agent': [t('cursor-agent', 'errors: an unknown session, an unknown source, a deleted chat'), t('cursor-agent', 'cursor-orphan: a transcript whose chat was deleted is never listed')],
    zed: [t('zed', 'errors: an unknown session or source, a legacy thread, a channel with no DB, a deleted thread')],
    devin: [t('devin', 'errors: an unknown session, an unknown source, an incarnation Devin never gives, a deleted session')],
  },
};

// The matrix as markdown: one row per item, one column per harness.
export function report() {
  const short = (cell) => {
    if (!cell) return '**missing**';
    if (cell.na) return `n/a: ${cell.na}`;
    if (cell.open) return `**open**: ${cell.open}`;
    return cell.map((p) => (p.generic ? 'generic' : `${p.test.replace(/\.test\.js$/, '')}: “${p.match}”`)).join('<br>');
  };
  const lines = [
    '# The conformance matrix',
    '',
    'Generated by `node conformance/matrix.js --write`; do not edit by hand. Each cell names what',
    'proves the item for that harness: `generic` is a check in `conformance/generic.js` run over',
    'every fixture case; a quoted title is a test in `test/<file>`; `n/a` gives the reason.',
    '',
  ];
  for (const item of ITEMS) {
    lines.push(`## ${item.id}: ${item.title}`, '', `From ${item.of}.`, '', '| Harness | Proved by |', '|---|---|');
    for (const h of HARNESSES) lines.push(`| ${h} | ${short(MATRIX[item.id]?.[h]).replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  return lines.join('\n');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPORT_FILE = path.join(HERE, '..', 'docs', 'conformance-matrix.md');

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--write')) fs.writeFileSync(REPORT_FILE, report());
  else process.stdout.write(report());
}
