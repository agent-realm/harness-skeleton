import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { adapterFor, harnessPath } from '../src/index.js';
import { idTime } from '../src/harnesses/opencode/index.js';
import { jcs, sha256 } from '../src/jcs.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, tmpStore, copyTree, storeOf, nameLint } from '../conformance/runner.js';
import { prepareStore, sqlFilesOf, buildDb, sqlGrowthCheck } from '../conformance/sql-store.js';
import { SCHEMA, mkId, T0 } from '../fixtures/opencode/generate.js';

const adapter = adapterFor('opencode');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opencode');
const CASES = ['basic', 'features', 'edits', 'v2', 'channels', 'sentinel'];
const EXEMPT = adapter.describe().redaction.exemptions;
const T = (name) => `table:${name}`;
// Every OpenCode store is bound to its database file (sessions-model §1).
const storeFile = (dir) => path.join(dir, 'opencode.db');

function withCase(name, fn) {
  const dir = tmpStore();
  try {
    prepareStore(path.join(FIX, name), dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const golden = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name, 'expected.json'), 'utf8'));
const sessionOf = (g, title) => Object.entries(g).find(([, recs]) => recs.some((r) => r.type === 'session' && r.title === title));
const messages = (recs) => recs.filter((r) => r.type === 'message');
function lastDerive(e, sid) {
  for (const [id, s] of e.sessions) if (id.split('\u0000')[0] === sid) return s.last;
  return null;
}
// A unit's body as JSON, with the JSON columns (`data`, `revert`) parsed too, for the name lint.
function unitTree(u) {
  let o;
  try {
    o = JSON.parse(u.body);
  } catch {
    return null;
  }
  const open = (row) => {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    for (const k of ['data', 'revert']) if (typeof out[k] === 'string') try { out[k] = JSON.parse(out[k]); } catch { /* text */ }
    return out;
  };
  return u.enc === 'rows-json' ? Object.fromEntries(Object.entries(o).map(([t, rows]) => [t, rows.map(open)])) : open(o);
}
function allUnits(e) {
  const out = [];
  for (const s of e.sessions.values()) for (const src of s.sources.values()) out.push(...src.units.values());
  return out;
}
// The rollback-journal variant of the fixture schema, so a writer's lock blocks readers.
const ROLLBACK = SCHEMA.replace('PRAGMA journal_mode=WAL;', 'PRAGMA journal_mode=DELETE;');

for (const name of CASES) {
  test(`opencode/${name}: the full replay equals the reviewed golden`, () => {
    withCase(name, (dir) => assert.deepEqual(project(fullReplay(adapter, storeFile(dir)).views()), golden(name)));
  });

  test(`opencode/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    const r = sqlGrowthCheck(adapter, path.join(FIX, name), { steps: 12 });
    assert.deepEqual(r.incremental, r.full);
    assert.ok(r.equal, 'the incremental and the full view differ');
    assert.deepEqual(r.notUnchanged, []);
  });

  test(`opencode/${name}: keys are stable across a lost state`, () => {
    withCase(name, (dir) => assert.deepEqual(project(fullReplay(adapter, storeFile(dir)).views()), project(fullReplay(adapter, storeFile(dir)).views())));
  });

  test(`opencode/${name}: no string under a secret-looking name in any unit or record`, () => {
    withCase(name, (dir) => {
      const e = fullReplay(adapter, storeFile(dir));
      const hits = [];
      for (const u of allUnits(e)) {
        const tree = unitTree(u);
        if (tree) hits.push(...nameLint(tree, EXEMPT, `${u.source_key}@${u.unit_key}:`));
      }
      for (const s of e.sessions.values()) for (const r of s.view.values()) hits.push(...nameLint(r, EXEMPT, `${r.type}:`));
      assert.deepEqual(hits, []);
    });
  });

  test(`opencode/${name}: every tool call has exactly one result with its call id`, () => {
    for (const recs of Object.values(golden(name))) {
      const parts = messages(recs).flatMap((m) => m.parts);
      for (const c of parts.filter((p) => p.kind === 'tool_call')) {
        assert.equal(parts.filter((p) => p.kind === 'tool_result' && p.call_id === c.call_id).length, 1, c.call_id);
      }
    }
  });
}

test('opencode: list names each session and its sources; the hint moves with the session only', () => {
  withCase('features', (dir) => {
    const store = storeOf(adapter, storeFile(dir));
    const got = adapter.list(store);
    assert.equal(got.length, 7, 'A, P, CH, H, F, V and the interrupted fetch I');
    assert.deepEqual(got.map((s) => s.session_id), [...got.map((s) => s.session_id)].sort());
    const [A] = sessionOf(golden('features'), 'Toy cart work');
    const a = got.find((s) => s.session_id === A);
    assert.deepEqual([a.incarnation, a.live], ['', 'unknown']);
    const spill = a.sources.find((s) => s.source_key.includes(`${path.sep}tool-output${path.sep}`));
    assert.deepEqual(a.sources.map((s) => [s.source_key, s.role, s.mode, s.position_kind]), [
      [T('message'), 'main', 'delta', 'time_updated+id'],
      [T('session_message'), 'main', 'delta', 'time_updated+id'],
      // Side sources by source_key: the spill's absolute path sorts before the table keys.
      [spill.source_key, 'side', 'snapshot', 'snapshot'],
      [T('event'), 'side', 'stream', 'seq'],
      [T('session'), 'side', 'snapshot', 'snapshot'],
      [T('session_input'), 'side', 'delta', 'pk'],
    ]);
    // The spill a part names under /etc is never a source.
    assert.ok(!a.sources.some((s) => s.source_key.includes('passwd')));
    assert.deepEqual(adapter.list(store), got, 'list twice: deep-equal');

    const [P] = sessionOf(golden('features'), 'Review the cart');
    const hint = (sid) => adapter.list(store).find((s) => s.session_id === sid).updated_hint;
    const file = path.join(dir, 'opencode.db');
    const changes = [
      ['a part upserted', (w) => w.prepare('UPDATE part SET time_updated = time_updated + 99 WHERE id = (SELECT max(id) FROM part WHERE session_id = ?)').run(A)],
      ['a part deleted', (w) => w.prepare('DELETE FROM part WHERE id = (SELECT max(id) FROM part WHERE session_id = ?)').run(A)],
      ['a revert set', (w) => w.prepare('UPDATE session SET revert = ? WHERE id = ?').run(JSON.stringify({ messageID: 'msg_x' }), A)],
      ['a removal event', (w) => w.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)').run(mkId('evt', T0 + 99999, 1, 'rm'), A, 900, 'message.removed.1', JSON.stringify({ sessionID: A, messageID: 'msg_gone' }))],
      ['archived', (w) => w.prepare('UPDATE session SET time_archived = ? WHERE id = ?').run(T0 + 5000, A)],
      ['renamed', (w) => w.prepare('UPDATE session SET title = ? WHERE id = ?').run('Cart qty fix', A)],
    ];
    let prev = hint(A);
    for (const [what, change] of changes) {
      const other = hint(P);
      const w = new DatabaseSync(file);
      change(w);
      w.close();
      assert.notEqual(hint(A), prev, `${what}: the hint moves`);
      assert.equal(hint(P), other, `${what}: another session's hint stays`);
      prev = hint(A);
    }
    const w = new DatabaseSync(file);
    w.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)').run(mkId('evt', T0 + 99998, 1, 'up'), A, 901, 'message.part.updated.1', '{}');
    w.close();
    assert.equal(hint(A), prev, 'an event that changes no record leaves the hint alone');
  });
});

test('opencode: every store is its database file: default, channel and OPENCODE_DB stores list their own sessions; a folder is refused', () => {
  withCase('channels', (dir) => {
    // The data folder is not a store (sessions-model §1).
    assert.throws(() => adapter.list(storeOf(adapter, dir)), { code: 'bad_request' });
    // OPENCODE_DB naming the default file, through a symlink: one real path, so one key.
    fs.symlinkSync(path.join(dir, 'opencode.db'), path.join(dir, 'link-to-default.db'));
    assert.equal(harnessPath(path.join(dir, 'link-to-default.db')), harnessPath(storeFile(dir)));
    const folder = adapter.list(storeOf(adapter, storeFile(dir))).map((s) => s.session_id);
    const betaPath = harnessPath(path.join(dir, 'opencode-beta.db'));
    assert.equal(betaPath, path.join(dir, 'opencode-beta.db'), 'harness_path may be the database file itself');
    const betaStore = storeOf(adapter, betaPath);
    const beta = adapter.list(betaStore);
    const custom = adapter.list(storeOf(adapter, path.join(dir, 'custom-oc.db'))).map((s) => s.session_id);
    const [N] = sessionOf(golden('channels'), 'Default channel work');
    assert.deepEqual(folder, [N], 'no channel or OPENCODE_DB session in the default store');
    assert.equal(beta.length, 2);
    assert.ok(beta.some((s) => s.session_id === N), 'the imported session, under the beta store too');
    assert.equal(custom.length, 1);
    assert.ok(!custom.includes(N) && !beta.some((s) => custom.includes(s.session_id)));
    // A file store's table keys name no path; its spill sits in the data folder, by absolute key.
    const B = beta.find((s) => s.session_id !== N);
    assert.deepEqual(B.sources.filter((s) => s.source_key.startsWith('table:')).map((s) => s.source_key).sort(), ['table:event', 'table:message', 'table:session', 'table:session_input', 'table:session_message']);
    const spill = B.sources.find((s) => path.isAbsolute(s.source_key));
    assert.equal(path.dirname(spill.source_key), path.join(dir, 'tool-output'));
    // Its records: the output reference is the spill file's sha256 and length.
    const view = project(fullReplay(adapter, betaPath).views());
    const ref = messages(view[B.session_id]).flatMap((m) => m.parts).find((p) => p.output_ref).output_ref;
    const body = fs.readFileSync(spill.source_key);
    assert.deepEqual(ref, { ref: path.basename(spill.source_key), sha256: sha256(body), bytes: body.length });
    // The same id in two stores: two sessions, two keys.
    const e1 = fullReplay(adapter, storeFile(dir));
    const e2 = fullReplay(adapter, betaPath);
    const s1 = [...e1.sessions.get(`${N}\u0000`).view.values()].find((r) => r.type === 'session');
    const s2 = [...e2.sessions.get(`${N}\u0000`).view.values()].find((r) => r.type === 'session');
    assert.notEqual(s1.harness_path, s2.harness_path);
    assert.equal(s1.session_id, s2.session_id);
    // And the file store grows like any other.
    const grow = tmpStore();
    try {
      copyTree(path.join(FIX, 'channels', 'store'), grow);
      const dbs = sqlFilesOf(path.join(FIX, 'channels'));
      const e = new MiniEngine(adapter, storeOf(adapter, path.join(grow, 'opencode-beta.db')));
      for (let t = 1; t <= 8; t++) {
        for (const db of dbs) buildDb(grow, db, t === 8 ? db.ops.length : Math.floor((db.ops.length * t) / 8));
        e.pass();
      }
      assert.deepEqual(project(e.views()), project(fullReplay(adapter, path.join(grow, 'opencode-beta.db')).views()));
    } finally {
      fs.rmSync(grow, { recursive: true, force: true });
    }
  });
});

test('opencode: held: the streaming reply is held, not written; once complete, only it and the session record change', () => {
  withCase('features', (dir) => {
    const [A] = sessionOf(golden('features'), 'Toy cart work');
    const file = path.join(dir, 'opencode.db');
    const db = new DatabaseSync(file);
    const open = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1').get(A);
    db.close();
    const e = new MiniEngine(adapter, storeOf(adapter, storeFile(dir)));
    e.pass();
    const first = lastDerive(e, A);
    assert.deepEqual(first.held.message, [open.id]);
    assert.ok(!first.live.message.includes(open.id));
    // The dead run before it is written, interrupted.
    const dead = messages(golden('features')[A]).filter((m) => m.status === 'interrupted');
    assert.equal(dead.length, 1);
    const w = new DatabaseSync(file);
    const d = JSON.parse(open.data);
    w.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify({ ...d, time: { ...d.time, completed: d.time.created + 900 }, finish: 'stop', tokens: { input: 1300, output: 9, reasoning: 0, cache: { read: 700, write: 0 } } }), open.id);
    w.close();
    e.pass();
    const next = lastDerive(e, A);
    assert.deepEqual(next.held.message, []);
    assert.deepEqual(next.changed.map((r) => [r.type, r.message_id ?? r.usage_id ?? '']).sort(), [['message', open.id], ['session', ''], ['usage', `message:${open.id}#1`]]);
    assert.equal(e.views()[A].get(`message\u0000${open.id}`).status, 'complete');
  });
});

test('opencode: the event log is a seq stream: a new removal appends, a wiped log resets', () => {
  withCase('edits', (dir) => {
    const [E] = sessionOf(golden('edits'), 'Edit work');
    const file = path.join(dir, 'opencode.db');
    const e = new MiniEngine(adapter, storeOf(adapter, storeFile(dir)));
    e.pass();
    const continuity = () => e.log.find((l) => l.session_id === E && l.source_key === T('event')).continuity;
    const edits = () => [...e.views()[E].values()].filter((r) => r.type === 'lifecycle' && r.op === 'edit').length;
    assert.equal(edits(), 2);
    let w = new DatabaseSync(file);
    w.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)').run(mkId('evt', T0 + 40000, 1, 'more'), E, 50, 'message.part.removed.1', JSON.stringify({ sessionID: E, messageID: 'msg_x', partID: 'prt_x' }));
    w.close();
    e.pass();
    assert.equal(continuity(), 'appended');
    assert.equal(edits(), 3);
    // A migration that wipes `event` (spec §1): the log restarts, so the source resets.
    w = new DatabaseSync(file);
    w.exec('DELETE FROM event');
    w.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)').run(mkId('evt', T0 + 41000, 1, 'again'), E, 0, 'message.removed.1', JSON.stringify({ sessionID: E, messageID: 'msg_y' }));
    w.close();
    e.pass();
    assert.equal(continuity(), 'reset');
    assert.equal(edits(), 1);
    assert.deepEqual(project(e.views()), project(fullReplay(adapter, storeFile(dir)).views()));
  });
});

test('opencode: a spilled output is a side source; once cleaned up, the reference keeps its name', () => {
  withCase('features', (dir) => {
    const [A] = sessionOf(golden('features'), 'Toy cart work');
    const e = new MiniEngine(adapter, storeOf(adapter, storeFile(dir)));
    e.pass();
    const spill = adapter.list(storeOf(adapter, storeFile(dir))).find((s) => s.session_id === A).sources.find((s) => s.source_key.includes(`${path.sep}tool-output${path.sep}`));
    const r = adapter.read(storeOf(adapter, storeFile(dir)), { ...storeOf(adapter, storeFile(dir)), session_id: A, incarnation: '' }, spill.source_key, null, null);
    assert.equal(r.continuity, 'reset');
    assert.equal(r.units[0].body, fs.readFileSync(spill.source_key, 'utf8'));
    fs.rmSync(spill.source_key);
    e.pass();
    const refs = messages([...e.views()[A].values()]).flatMap((m) => m.parts).filter((p) => p.output_ref).map((p) => p.output_ref);
    assert.deepEqual(refs, [{ ref: path.basename(spill.source_key), sha256: null, bytes: null }]);
    assert.deepEqual(project(e.views()), project(fullReplay(adapter, storeFile(dir)).views()));
  });
});

test('opencode: a tool_result carries the stored exit code (v1 metadata.exit, v2 structured.exit); none is null', () => {
  withCase('features', (dir) => {
    const parts = Object.values(fullReplay(adapter, storeFile(dir)).views()).flatMap((v) => messages([...v.values()]).flatMap((m) => m.parts));
    const exit = Object.fromEntries(parts.filter((p) => p.kind === 'tool_result').map((p) => [p.call_id, p.exit_code]));
    // v1 `metadata: {output, exit: 1}`; the output, '1 failed', names no code.
    assert.equal(exit.call_bc3a64f28f, 1);
    // v2 `structured: {exit: 0, truncated: true}`.
    assert.equal(exit.call_fake_scn_bigout_v2, 0);
    // Shell mode keeps only `{output}`; a rejected call has no metadata.
    assert.deepEqual([exit['01M5FAEW4AEJ4QVFJMH093YG1S'], exit['chatcmpl-tool-FixtureFixt00050']], [null, null]);
  });
});

// sessions-model v1.x (#6), §2.3 (`tool_result.is_error`): the part's state status is the harness
// store's flag, `error` true and `completed` false. A `completed` beside a shell's non-zero
// exit_code is unreliable for that result, so its is_error is null; never derived from exit_code.
test('opencode: is_error is the state status: completed beside a non-zero exit is null, completed is false, error is true', () => {
  withCase('features', (dir) => {
    const resultsOf = () => Object.fromEntries(Object.values(fullReplay(adapter, storeFile(dir)).views()).flatMap((v) => messages([...v.values()]).flatMap((m) => m.parts))
      .filter((p) => p.kind === 'tool_result').map((p) => [p.call_id, [p.is_error, p.exit_code, p.status]]));
    const r = resultsOf();
    assert.deepEqual(r.call_bc3a64f28f, [null, 1, 'completed'], 'v1: completed beside exit 1, unreliable for this result');
    assert.deepEqual([r.call_4b13d21247, r.call_fake_scn_bigout_v2], [[false, 0, 'completed'], [false, 0, 'completed']], 'v1 and v2: completed, exit 0');
    assert.deepEqual(r['01M5FAEW4AEJ4QVFJMH093YG1S'], [false, null, 'completed'], 'completed, no exit code (shell mode)');
    assert.deepEqual([r['chatcmpl-tool-FixtureFixt00049'], r['chatcmpl-tool-FixtureFixt00050']], [[true, null, 'completed'], [null, null, 'denied']], 'error; error, a refused permission (denied: no call that completed)');
    // Edited in this copy: the v2 shell exits 2 under `completed` (null); the v1 shell's status is
    // `error` beside exit 1 (the flag says failure: true).
    const w = new DatabaseSync(storeFile(dir));
    w.prepare("UPDATE session_message SET data = replace(data, '\"structured\":{\"exit\":0,', '\"structured\":{\"exit\":2,') WHERE data LIKE '%call_fake_scn_bigout_v2%'").run();
    w.prepare("UPDATE part SET data = json_set(data, '$.state.status', 'error') WHERE json_extract(data, '$.callID') = 'call_bc3a64f28f'").run();
    w.close();
    const e = resultsOf();
    assert.deepEqual(e.call_fake_scn_bigout_v2, [null, 2, 'completed'], 'v2: completed beside exit 2');
    assert.deepEqual(e.call_bc3a64f28f, [true, 1, 'completed'], 'v1: error beside exit 1');
  });
});

// sessions-model v1.x (#6), §2.3 (`tool_result.is_error`): `is_error` describes a call that
// completed. A refused permission (an `error` status whose error is OpenCode's own text: `denied`)
// and a call cut off while pending or running (`cancelled`) did not: their is_error is null and the
// status carries the fact. A call that completed keeps the state status as its flag (the positive
// control).
test('opencode: is_error is null where the call did not complete: a refused permission, a call cut off; the status carries the fact', () => {
  withCase('features', (dir) => {
    const resultsOf = () => Object.fromEntries(Object.values(fullReplay(adapter, storeFile(dir)).views()).flatMap((v) => messages([...v.values()]).flatMap((m) => m.parts))
      .filter((p) => p.kind === 'tool_result').map((p) => [p.call_id, [p.status, p.is_error]]));
    const r = resultsOf();
    assert.deepEqual(r['chatcmpl-tool-FixtureFixt00050'], ['denied', null], 'the fixture\'s refused permission');
    assert.deepEqual([r['chatcmpl-tool-FixtureFixt00049'], r.call_4b13d21247], [['completed', true], ['completed', false]], 'the positive control: error; completed');
    // Edited in this copy: the v1 read is refused (OpenCode's own text, as OpenCode stores it), and
    // the v1 shell is cut off while running.
    const w = new DatabaseSync(storeFile(dir));
    w.prepare("UPDATE part SET data = json_set(data, '$.state.status', 'error', '$.state.error', 'The user rejected permission to use this specific tool call.') WHERE json_extract(data, '$.callID') = 'call_4b13d21247'").run();
    w.prepare("UPDATE part SET data = json_set(data, '$.state.status', 'running') WHERE json_extract(data, '$.callID') = 'call_bc3a64f28f'").run();
    w.close();
    const e = resultsOf();
    assert.deepEqual([e.call_4b13d21247, e.call_bc3a64f28f], [['denied', null], ['cancelled', null]]);
  });
});

// sessions-model v1.x proposal (#6), §2.3: `cancelled` and `denied` come from a structured marker,
// or from a fixed string the harness itself writes for that case, matched exactly (sessions-model
// annex §5, v1.x proposal (#6)); never from a pattern in free text. OpenCode's text for a refused
// permission (OpenCode v1.19.3, packages/core/src/v1/permission.ts:7-11) counts only as the whole
// stored error. An error that merely contains it, or the words, is completed with the state status
// as its flag (true).
test('opencode: a refused permission is OpenCode\'s own text, matched exactly as the whole stored error; a near miss is completed with the flag', () => {
  withCase('features', (dir) => {
    const resultOf = (call) => Object.values(fullReplay(adapter, storeFile(dir)).views()).flatMap((v) => messages([...v.values()]).flatMap((m) => m.parts))
      .filter((p) => p.kind === 'tool_result' && p.call_id === call).map((p) => [p.status, p.is_error])[0];
    const refuse = (error) => {
      const w = new DatabaseSync(storeFile(dir));
      w.prepare("UPDATE part SET data = json_set(data, '$.state.status', 'error', '$.state.error', ?) WHERE json_extract(data, '$.callID') = 'call_4b13d21247'").run(error);
      w.close();
      return resultOf('call_4b13d21247');
    };
    // The positive control: the fixture's refused permission, and the same text on another call.
    assert.deepEqual(resultOf('chatcmpl-tool-FixtureFixt00050'), ['denied', null]);
    assert.deepEqual(refuse('The user rejected permission to use this specific tool call.'), ['denied', null]);
    // Near misses.
    assert.deepEqual(refuse('EACCES: rejected permission to open toyshop/cart.py'), ['completed', true], 'a tool\'s error with the words in it');
    assert.deepEqual(refuse('Error: The user rejected permission to use this specific tool call.'), ['completed', true], 'the text after a prefix: not the whole error');
    assert.deepEqual(refuse('The user rejected permission to use this specific tool call with the following feedback: run the tests first'), ['completed', true], 'a rejection with feedback embeds the user\'s words: no fixed string');
  });
});

// sessions-model v1.x proposal (#6), §2.3: `cancelled` comes from a structured marker the harness
// store writes. OpenCode's cleanup marks a call cut off by a stopped turn with
// `metadata.interrupted: true` on an `error` part, beside the text `Tool execution aborted`
// (OpenCode v1.19.3, packages/opencode/src/session/processor.ts:591-607). The marker decides, as
// OpenCode's own check reads it (packages/opencode/src/session/prompt.ts:96-100): never the text.
test('opencode: a call cut off by an interrupt is cancelled by its structured marker, metadata.interrupted, never by its text; a near miss is completed with the flag', () => {
  withCase('features', (dir) => {
    const resultOf = (call) => Object.values(fullReplay(adapter, storeFile(dir)).views()).flatMap((v) => messages([...v.values()]).flatMap((m) => m.parts))
      .filter((p) => p.kind === 'tool_result' && p.call_id === call).map((p) => [p.status, p.is_error, p.output])[0];
    const edit = (status, error, metadata) => {
      const w = new DatabaseSync(storeFile(dir));
      w.prepare("UPDATE part SET data = json_set(data, '$.state.status', ?, '$.state.error', ?, '$.state.metadata', json(?)) WHERE json_extract(data, '$.callID') = 'call_4b13d21247'")
        .run(status, error, JSON.stringify(metadata));
      w.close();
      return resultOf('call_4b13d21247').slice(0, 2);
    };
    // The positive control: the fixture's interrupted call, as OpenCode writes it, and the marker
    // on another call, its metadata kept.
    assert.deepEqual(resultOf('chatcmpl-tool-FixtureFixt00051'), ['cancelled', null, 'Tool execution aborted']);
    assert.deepEqual(edit('error', 'Tool execution aborted', { output: '3 passed', exit: 0, truncated: false, interrupted: true }), ['cancelled', null]);
    // The marker decides, not the text: another error text beside it is cancelled too.
    assert.deepEqual(edit('error', 'Tool execution interrupted', { interrupted: true }), ['cancelled', null], 'the marker with another text');
    // Near misses: the text without the marker is a tool's error, completed with the flag (true).
    assert.deepEqual(edit('error', 'Tool execution aborted', {}), ['completed', true], 'the text, no marker');
    assert.deepEqual(edit('error', 'Tool execution aborted', { interrupted: false }), ['completed', true], 'the text, the marker false');
    assert.deepEqual(edit('error', 'Tool execution aborted', { interrupted: 'true' }), ['completed', true], 'the text, the marker a string');
    assert.deepEqual(edit('completed', null, { output: '3 passed', exit: 0, truncated: false, interrupted: true }), ['completed', false], 'the marker on a completed part: not OpenCode\'s write, the flag (false)');
  });
});

test('opencode: errors: an unknown session, an unknown or unreferenced source, a deleted session', () => {
  withCase('features', (dir) => {
    const store = storeOf(adapter, storeFile(dir));
    const [A] = sessionOf(golden('features'), 'Toy cart work');
    const [P] = sessionOf(golden('features'), 'Review the cart');
    const key = (sid) => ({ ...store, session_id: sid, incarnation: '' });
    const spill = adapter.list(store).find((s) => s.session_id === A).sources.find((s) => s.source_key.includes(`${path.sep}tool-output${path.sep}`)).source_key;
    assert.throws(() => adapter.read(store, key('ses_gone'), T('message')), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key(A), 'opencode.db#table:credential'), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, key(P), spill), { code: 'source_unknown' }, "another session's spill");
    assert.throws(() => adapter.read(store, key(A), path.join(dir, 'tool-output', 'tool_15e9c3391001NotReferencedX')), { code: 'source_unknown' });
    const w = new DatabaseSync(path.join(dir, 'opencode.db'));
    for (const t of ['part', 'message']) w.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(P);
    w.prepare('DELETE FROM session WHERE id = ?').run(P);
    w.close();
    assert.ok(!adapter.list(store).some((s) => s.session_id === P));
    assert.throws(() => adapter.read(store, key(P), T('message')), { code: 'session_unknown' });
    // A store whose database file is gone: nothing listed, nothing read.
    const empty = tmpStore();
    try {
      const gone = storeOf(adapter, storeFile(empty));
      assert.deepEqual(adapter.list(gone), []);
      assert.throws(() => adapter.read(gone, { ...gone, session_id: A, incarnation: '' }, T('message')), { code: 'session_unknown' });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

test('opencode: a lock past the wait is `busy`, never fewer rows; no file is created beside the database', () => {
  const dir = tmpStore();
  try {
    const [db] = sqlFilesOf(path.join(FIX, 'features'));
    buildDb(dir, { ...db, schema: ROLLBACK });
    const store = storeOf(adapter, storeFile(dir));
    const [s] = adapter.list(store);
    const key = { ...store, session_id: s.session_id, incarnation: '' };
    const full = adapter.read(store, key, T('message'), null, null).units.length;
    const before = fs.readdirSync(dir).sort();
    const w = new DatabaseSync(path.join(dir, 'opencode.db'));
    w.exec('BEGIN EXCLUSIVE');
    try {
      assert.throws(() => adapter.list(store), { code: 'busy' });
      assert.throws(() => adapter.read(store, key, T('message'), null, null), { code: 'busy' });
    } finally {
      w.exec('ROLLBACK');
      w.close();
    }
    assert.equal(adapter.read(store, key, T('message'), null, null).units.length, full);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode: a damaged page or a row that does not parse is `damaged`, never fewer rows', () => {
  const dir = tmpStore();
  try {
    const [db] = sqlFilesOf(path.join(FIX, 'edits'));
    buildDb(dir, { ...db, schema: `PRAGMA page_size=4096;\n${ROLLBACK}` });
    const store = storeOf(adapter, storeFile(dir));
    const sessions = adapter.list(store);
    const E = sessions.find((s) => s.session_id === sessionOf(golden('edits'), 'Edit work')[0]).session_id;
    const key = { ...store, session_id: E, incarnation: '' };
    const file = path.join(dir, 'opencode.db');
    const w = new DatabaseSync(file);
    const root = (t) => w.prepare('SELECT rootpage FROM sqlite_master WHERE name = ?').get(t).rootpage;
    const roots = { message: root('message'), part: root('part') };
    w.close();
    const good = fs.readFileSync(file);
    for (const [table, page] of Object.entries(roots)) {
      const bad = Buffer.from(good);
      bad.fill(0xff, (page - 1) * 4096, (page - 1) * 4096 + 16); // the b-tree page header: an invalid page
      fs.writeFileSync(file, bad);
      assert.throws(() => adapter.list(store), { code: 'damaged' }, `list on a damaged ${table} page`);
      assert.throws(() => adapter.read(store, key, T('message'), null, null), { code: 'damaged' }, `read on a damaged ${table} page`);
    }
    // Committed rows whose JSON does not parse.
    const cases = [
      ['message', "UPDATE message SET data = '{\"role\":\"assist' WHERE id = (SELECT max(id) FROM message WHERE session_id = ?)", T('message')],
      ['part', "UPDATE part SET data = 'not json' WHERE id = (SELECT max(id) FROM part WHERE session_id = ?)", T('message')],
      ['revert', "UPDATE session SET revert = '{\"messageID\":\"msg_' WHERE id = ?", T('session')],
      ['event', "UPDATE event SET data = '{\"sessionID\":' WHERE id = (SELECT id FROM event WHERE aggregate_id = ? ORDER BY seq DESC LIMIT 1)", T('event')],
    ];
    for (const [what, sql, sk] of cases) {
      fs.writeFileSync(file, good);
      const x = new DatabaseSync(file);
      x.prepare(sql).run(E);
      x.close();
      assert.throws(() => adapter.read(store, key, sk, null, null), (e) => e.code === 'damaged' && /unreadable/.test(e.message), what);
    }
    fs.writeFileSync(file, good);
    const x = new DatabaseSync(file);
    x.prepare('UPDATE session SET revert = NULL WHERE id = ?').run(E);
    x.close();
    assert.equal(adapter.read(store, key, T('session'), null, null).continuity, 'reset', 'a NULL revert is no revert');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode: an older schema (no time_archived, revert, event or v2 tables) lists and reads every session', () => {
  const dir = tmpStore();
  try {
    const [db] = sqlFilesOf(path.join(FIX, 'basic'));
    const old = [
      'CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real, tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer, revert_unused text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived_unused integer);',
      'CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated_unused integer, data text NOT NULL);',
      'CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);',
    ].join('\n');
    // The same rows, through columns renamed away (so the old table lacks them).
    const ops = db.ops.filter((o) => !/^INSERT INTO event/.test(o.sql)).map((o) => ({
      ...o, sql: o.sql.replace(', revert,', ', revert_unused,').replace(', time_archived)', ', time_archived_unused)').replace('time_created, time_updated, data)', 'time_created, time_updated_unused, data)'),
    }));
    // The part table keeps time_updated; only message's was renamed.
    for (const o of ops) if (/^INSERT INTO part/.test(o.sql)) o.sql = o.sql.replace('time_updated_unused', 'time_updated');
    buildDb(dir, { rel: 'opencode.db', schema: old, ops });
    const store = storeOf(adapter, storeFile(dir));
    const got = adapter.list(store);
    assert.equal(got.length, 2, 'the missing columns read as NULL; no session is dropped');
    assert.deepEqual(got[0].sources.map((s) => s.source_key), [T('message'), T('session')]);
    const view = project(fullReplay(adapter, storeFile(dir)).views());
    const want = golden('basic');
    for (const sid of Object.keys(want)) assert.deepEqual(messages(view[sid]).map((m) => m.message_id), messages(want[sid]).map((m) => m.message_id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode: a committed row only in the WAL is read while the writer holds it; the reader creates nothing', () => {
  withCase('features', (dir) => {
    const store = storeOf(adapter, storeFile(dir));
    const [A] = sessionOf(golden('features'), 'Toy cart work');
    const key = { ...store, session_id: A, incarnation: '' };
    const before = adapter.read(store, key, T('message'), null, null).units.length;
    const w = new DatabaseSync(path.join(dir, 'opencode.db'));
    try {
      w.exec('PRAGMA wal_autocheckpoint=0');
      const id = mkId('msg', T0 + 99000, 1, 'wal');
      w.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, A, T0 + 99000, T0 + 99000, JSON.stringify({ role: 'user', time: { created: T0 + 99000 } }));
      assert.ok(fs.existsSync(path.join(dir, 'opencode.db-wal')));
      const files = fs.readdirSync(dir).sort();
      const r = adapter.read(store, key, T('message'), null, null);
      assert.equal(r.units.length, before + 1);
      assert.ok(r.units.some((u) => u.unit_key === `message:${id}`));
      assert.deepEqual(fs.readdirSync(dir).sort(), files);
    } finally {
      w.close();
    }
  });
  // With no writer, the WAL store is opened immutable: no -wal, no -shm appears.
  withCase('v2', (dir) => {
    const before = fs.readdirSync(dir).sort();
    fullReplay(adapter, storeFile(dir));
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  });
});

test('opencode: redaction: provider-error payloads and URL tokens are gone from units and records; free text keeps its sentinel', () => {
  withCase('sentinel', (dir) => {
    const e = fullReplay(adapter, storeFile(dir));
    const units = allUnits(e);
    const records = Object.values(project(e.views())).flat();
    const text = JSON.stringify(units.map((u) => u.body)) + JSON.stringify(records);
    assert.deepEqual([...new Set(text.match(/OCSENTINEL-[A-Za-z0-9-]+/g))], ['OCSENTINEL-free-text-1'], 'only the free-text sentinel (sessions-model §4.6), never the credential table');
    // Exactly the units that held a declared path are marked redacted.
    const redacted = units.filter((u) => u.redacted);
    assert.equal(redacted.length, 6);
    for (const u of redacted) assert.equal(u.sha256, sha256(Buffer.from(u.body, 'utf8')), 'the sha is of the emitted bytes');
    // The marker's N: bytes of a string, canonical JSON length of anything else.
    const ops = sqlFilesOf(path.join(FIX, 'sentinel'))[0].ops;
    const orig = JSON.parse(ops.find((o) => /^UPDATE message/.test(o.sql) && o.params[0].includes('APIError')).params[0]).error.data;
    const msg = unitTree(redacted.find((u) => u.unit_key.startsWith('message:')));
    assert.deepEqual(msg.data.error.data, {
      ...orig,
      responseHeaders: `<redacted len=${Buffer.byteLength(jcs(orig.responseHeaders))}>`,
      responseBody: `<redacted len=${Buffer.byteLength(orig.responseBody)}>`,
      metadata: `<redacted len=${Buffer.byteLength(jcs(orig.metadata))}>`,
    });
    const url = 'https://files.example.com/spec.pdf?token=OCSENTINEL-url-token&x=1';
    const atts = records.filter((r) => r.type === 'message').flatMap((m) => m.parts).filter((p) => p.kind === 'attachment').map((p) => p.ref);
    assert.ok(atts.includes(`https://files.example.com/<redacted len=${Buffer.byteLength(url)}>`));
    assert.ok(atts.includes('<redacted len=35>'), 'an opaque URI is the marker whole');
    assert.ok(atts.includes('C:\\work\\toyshop\\cart.py') && atts.includes('docs/spec.md') && atts.includes('/home/user/work/toyshop/notes.txt'), 'paths are kept');
    // Usage counters survive.
    assert.ok(records.some((r) => r.type === 'usage' && r.input === 900));
  });
});

test('opencode: redaction: a tool attachment\'s `uri` (no `url`) is cut like its url, in the unit and the record', () => {
  const TOK = 'sentinel-opencode-att-uri-not-a-secret';
  const uri = `https://api.example.com/data?token=${TOK}`;
  withCase('sentinel', (dir) => {
    const w = new DatabaseSync(path.join(dir, 'opencode.db'));
    const row = w.prepare("SELECT id, data FROM part WHERE json_extract(data, '$.callID') = 'call_fake_scn_fetch_1_0'").get();
    const d = JSON.parse(row.data);
    d.state.attachments = [{ type: 'file', mime: 'application/json', uri, id: d.state.attachments[0].id }];
    w.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify(d), row.id);
    w.close();
    const e = fullReplay(adapter, storeFile(dir));
    for (const u of allUnits(e)) assert.ok(!u.body.includes(TOK), `the sentinel is not in ${u.source_key}@${u.unit_key}`);
    const records = Object.values(project(e.views())).flat();
    assert.ok(!JSON.stringify(records).includes(TOK));
    const atts = records.filter((r) => r.type === 'message').flatMap((m) => m.parts).filter((p) => p.kind === 'attachment').map((p) => p.ref);
    assert.ok(atts.includes(`https://api.example.com/<redacted len=${Buffer.byteLength(uri)}>`), 'cut to scheme://host');
  });
});

test('opencode: a fork copy that re-minted its ids has the origin prefix cmp_sha; it states no link', () => {
  const g = golden('features');
  const [, a] = sessionOf(g, 'Toy cart work');
  const [, f] = sessionOf(g, 'Toy cart work (fork #1)');
  const fm = messages(f);
  assert.notEqual(fm[0].message_id, messages(a)[0].message_id);
  assert.equal(fm[0].cmp_sha, messages(a)[0].cmp_sha);
  const fp = (recs) => recs.find((r) => r.type === 'session').fingerprint.cmp_shas;
  assert.deepEqual(fp(f), fp(a).slice(0, 1));
  assert.ok(!f.some((r) => r.type === 'link'));
  assert.equal(f.find((r) => r.type === 'session').state, 'archived');
});

test('opencode: compaction is not deletion: every replaced message stays current', () => {
  const [, c] = sessionOf(golden('edits'), 'Compaction work');
  const life = c.find((r) => r.type === 'lifecycle' && r.op === 'compaction');
  const ms = messages(c);
  const through = ms.findIndex((m) => m.message_id === life.target.range.through_id);
  assert.ok(through >= 0);
  for (const m of ms.slice(0, through + 1)) assert.equal(m.state, 'current');
  const summary = ms.flatMap((m) => m.parts).find((p) => p.kind === 'summary');
  assert.deepEqual(summary.replaces, { first_kept_id: ms[through + 1].message_id });
});

test('opencode: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'opencode');
  assert.equal(d.model_version, 'sessions-model/1');
  const all = CASES.flatMap((c) => Object.values(golden(c)).flat());
  const ops = new Set(all.filter((r) => r.type === 'lifecycle').map((r) => r.op));
  for (const [op, v] of Object.entries(d.facets.lifecycle)) {
    assert.ok(['explicit', 'implicit', 'invisible'].includes(v), op);
    if (v !== 'explicit') continue;
    // An archive is the session's state, with no lifecycle record (map-c, sessions-model §2.6).
    if (op === 'archive') assert.ok(all.some((r) => r.type === 'session' && r.state === 'archived'), op);
    else assert.ok(ops.has(op), `explicit ${op} has no fixture record`);
  }
  for (const k of ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation', 'tool', 'compaction']) assert.ok(k in d.facets.linkage, k);
  const links = all.filter((r) => r.type === 'link');
  assert.ok(links.some((l) => l.stated_on === 'child' && l.at === '') && links.some((l) => l.stated_on === 'origin' && l.at), 'subagent: both sides');
  assert.ok(all.some((r) => r.type === 'message' && r.parts.some((p) => p.kind === 'summary' && p.replaces && p.replaces.first_kept_id)), 'compaction {first_kept_id}');
  assert.equal(d.facets.reuse, 'impossible');
});

test('opencode: a symlinked database or spill is neither listed nor read', () => {
  withCase('features', (dir) => {
    const store = storeOf(adapter, storeFile(dir));
    const [A] = sessionOf(golden('features'), 'Toy cart work');
    const key = { ...store, session_id: A, incarnation: '' };
    const spill = adapter.list(store).find((s) => s.session_id === A).sources.find((s) => s.source_key.includes(`${path.sep}tool-output${path.sep}`)).source_key;
    const outside = tmpStore('sa-outside-');
    try {
      // The spill replaced by a link to a file outside: not listed, not read.
      fs.copyFileSync(spill, path.join(outside, 'spill'));
      fs.rmSync(spill);
      fs.symlinkSync(path.join(outside, 'spill'), spill);
      assert.ok(!adapter.list(store).find((s) => s.session_id === A).sources.some((s) => s.source_key === spill));
      assert.throws(() => adapter.read(store, key, spill), { code: 'source_unknown' });
      // The database itself a link: no session.
      fs.renameSync(path.join(dir, 'opencode.db'), path.join(outside, 'opencode.db'));
      fs.symlinkSync(path.join(outside, 'opencode.db'), path.join(dir, 'opencode.db'));
      assert.deepEqual(adapter.list(store), []);
      assert.throws(() => adapter.read(store, key, T('message')), { code: 'session_unknown' });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('opencode: idTime gives back an ascending id\'s minting ms', () => {
  const t = T0 + 123456;
  assert.equal(idTime(mkId('evt', t, 7), T0), t);
  assert.equal(idTime('ses_notanid', T0), null);
});

test('opencode: read of a delta source with known: a changed row returns with a new sha, a deleted row is in gone; without known, every unit', () => {
  withCase('features', (dir) => {
    const store = storeOf(adapter, storeFile(dir));
    const [A] = sessionOf(golden('features'), 'Toy cart work');
    const key = { ...store, session_id: A, incarnation: '' };
    const r1 = adapter.read(store, key, T('message'), null, null);
    assert.equal(r1.continuity, 'reset');
    const known = Object.fromEntries(r1.units.map((u) => [u.unit_key, u.sha256]));
    assert.equal(adapter.read(store, key, T('message'), r1.position, known).continuity, 'unchanged');
    const w = new DatabaseSync(path.join(dir, 'opencode.db'));
    const [changed, deleted] = w.prepare("SELECT id FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY id").all(A).map((r) => r.id);
    w.prepare("UPDATE part SET data = json_set(data, '$.text', 'Rewritten in place.'), time_updated = time_updated + 1 WHERE id = ?").run(changed);
    w.prepare('DELETE FROM part WHERE id = ?').run(deleted);
    w.close();
    const r2 = adapter.read(store, key, T('message'), r1.position, known);
    assert.equal(r2.continuity, 'delta');
    assert.deepEqual(r2.units.map((u) => u.unit_key), [`part:${changed}`], 'only the changed row');
    assert.notEqual(r2.units[0].sha256, known[`part:${changed}`]);
    assert.deepEqual(r2.gone, [`part:${deleted}`]);
    const r3 = adapter.read(store, key, T('message'), null, null);
    assert.deepEqual([r3.continuity, r3.units.length], ['reset', r1.units.length - 1], 'without known: every current unit');
  });
});

test('opencode: usage: v1 has both flags false, v2 both null; per_message, keyed and anchored on its assistant message', () => {
  withCase('features', (dir) => {
    const view = project(fullReplay(adapter, storeFile(dir)).views());
    const db = new DatabaseSync(path.join(dir, 'opencode.db'), { readOnly: true });
    const v2 = new Set(db.prepare('SELECT id FROM session_message').all().map((r) => r.id));
    db.close();
    const seen = new Set();
    for (const recs of Object.values(view)) {
      const anchors = new Set();
      for (const u of recs.filter((r) => r.type === 'usage')) {
        const m = messages(recs).find((x) => x.message_id === u.anchor.message_id);
        assert.ok(m && m.role === 'assistant', u.usage_id);
        assert.deepEqual([u.usage_id, u.granularity, Object.keys(u.anchor)], [`message:${m.message_id}#1`, 'per_message', ['message_id']]);
        const engine = v2.has(m.message_id) ? 'v2' : 'v1';
        seen.add(engine);
        const want = engine === 'v2' ? [null, null] : [false, false];
        assert.deepEqual([u.input_includes_cache, u.output_includes_reasoning], want, `${engine} ${u.usage_id}`);
        assert.ok(!anchors.has(m.message_id), 'one usage record per message: no overlap');
        anchors.add(m.message_id);
      }
    }
    assert.deepEqual([...seen].sort(), ['v1', 'v2']);
  });
});

test('opencode: retraction vs destruction: a pending revert keeps its messages, reverted; a prompt while reverted deletes them, an edit record each, and they are tombstoned', () => {
  const [db] = sqlFilesOf(path.join(FIX, 'edits'));
  const upto = db.ops.findIndex((o) => o.sql.startsWith('DELETE FROM part'));
  assert.ok(upto > 0);
  const dir = tmpStore();
  try {
    buildDb(dir, db, upto);
    const e = new MiniEngine(adapter, storeOf(adapter, storeFile(dir)));
    e.pass();
    const [E] = sessionOf(golden('edits'), 'Edit work');
    const gone = ['msg_15e9c8972001aLh19UOz511rQq', 'msg_15e9c8d5a001vtgaMqFLPDKZmE'];
    for (const id of gone) assert.ok(e.views()[E].has(`message\u0000${id}`), `${id} is written before the prompt`);
    buildDb(dir, db);
    e.pass();
    const recs = [...e.views()[E].values()];
    for (const id of gone) assert.ok(!e.views()[E].has(`message\u0000${id}`), `${id} is tombstoned`);
    assert.deepEqual(recs.filter((r) => r.type === 'lifecycle' && r.op === 'edit').map((r) => [r.target.message_id, r.evidence]).sort(), gone.map((id) => [id, 'explicit']));
    // A revert still pending: the messages after its point stay, `reverted`, and no record names it.
    for (const title of ['Revert at a part', 'Revert at a message']) {
      const [sid] = sessionOf(golden('edits'), title);
      const view = [...e.views()[sid].values()];
      assert.deepEqual(messages(view).sort((a, b) => (a.order < b.order ? -1 : 1)).map((m) => m.state), ['current', 'current', 'reverted', 'reverted'], title);
      assert.ok(!view.some((r) => r.type === 'lifecycle'), title);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
