import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { adapterFor } from '../src/index.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, tmpStore, storeOf, nameLint } from '../conformance/runner.js';
import { prepareStore, sqlGrowthCheck, sqlFilesOf, buildDb } from '../conformance/sql-store.js';
import {
  CASES as BUILDERS, Chat, SCHEMA, pb, ref, sha, uid, call, userMsg, say, toolStep, shellArgs, shellOk, shellFailure, agentTurn, root, metaOf,
  A, H, E, ACP, P, SUB, R, F, L, ORPHAN, ORPHAN_TRANSCRIPT, TOOL, RID, UID, BUCKET, CWD, T0, MODEL, EMPTY_ROOT,
  SECRET_META, SECRET_ENC, SECRET_SCOPE, SECRET_ARG, SECRET_OUT, SECRET_PW,
} from '../fixtures/cursor-agent/generate.js';

const adapter = adapterFor('cursor-agent');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cursor-agent');
const CASES = ['features', 'subagent', 'rewind', 'orphan'];
const EXEMPT = adapter.describe().redaction.exemptions;
// Values redaction replaces, in units and records alike. ShellArgs secret_scope_id names a scope,
// holds no secret, and stays in the raw step; no record carries it.
const SECRETS = [SECRET_META, SECRET_ENC, SECRET_ARG, SECRET_OUT, SECRET_PW];
const chat = (id) => `chats/${BUCKET}/${id}`;
const blobsKey = (id) => `${chat(id)}/store.db#table:blobs`;
const metaKey = (id) => `${chat(id)}/store.db#table:meta`;

function withStore(name, fn) {
  const dir = tmpStore();
  try {
    if (name) prepareStore(path.join(FIX, name), dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// A store built from chats given inline (generate.js's Chat), plus plain files.
function withChats(chats, fn, files = {}) {
  const dir = tmpStore();
  try {
    for (const c of chats) buildDb(dir, { rel: `${c.dir}/store.db`, schema: SCHEMA, ops: c.ops });
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const golden = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name, 'expected.json'), 'utf8'));
const recsOf = (name, sid) => golden(name)[sid];
const ofType = (recs, type) => recs.filter((r) => r.type === type);
const messages = (recs) => ofType(recs, 'message').sort((a, b) => (a.order < b.order ? -1 : 1));
const msg = (recs, id) => recs.find((r) => r.type === 'message' && r.message_id === id);
const ids = (recs) => messages(recs).map((m) => m.message_id);
const viewOf = (e, sid) => [...(e.views()[sid] ?? new Map()).values()];
function lastDerive(e, sid) {
  for (const [id, s] of e.sessions) if (id.split('\u0000')[0] === sid) return s.last;
  return null;
}
const keyOf = (store, sid) => ({ ...store, session_id: sid, incarnation: '' });
// Every unit an engine read, and every record it holds, as one text.
function everything(e) {
  const out = [];
  for (const s of e.sessions.values()) {
    for (const src of s.sources.values()) for (const u of src.units.values()) out.push(u.enc === 'b64' ? Buffer.from(u.body, 'base64').toString('latin1') : u.body);
    for (const r of s.view.values()) out.push(JSON.stringify(r));
  }
  return out.join('\n');
}

// A simple chat: one turn per [text, reply], each from the previous root.
function simpleChat(id, turns, { dir = chat(id), name = 'toy-chat' } = {}) {
  const s = new Chat(dir);
  let prev = s.put(pb([[9, `file://${CWD}`], [22, 'cli']]));
  const ts = [];
  turns.forEach(([text, reply], i) => {
    const um = userMsg(s, { text, id: uid('8b76b964', 900 + i), snap: prev, t: T0 + i * 60000 });
    ts.push(agentTurn(s, { um, steps: [say(s, reply, T0 + i * 60000 + 500, false)], rid: uid('c3a28bce', 900 + i), uid: uid('8b76b964', 900 + i) }));
    prev = root(s, { turns: ts });
    s.meta(metaOf(id, prev, { name }));
  });
  return { s, last: prev, turns: ts };
}

// ---- the conformance checks, per case ----------------------------------------------------------

for (const name of CASES) {
  test(`cursor-agent/${name}: the full replay equals the reviewed golden`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), golden(name)));
  });

  test(`cursor-agent/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    const r = sqlGrowthCheck(adapter, path.join(FIX, name), { steps: 12 });
    assert.deepEqual(r.incremental, r.full);
    assert.ok(r.equal, 'the incremental and the full view differ');
    assert.deepEqual(r.notUnchanged, []);
  });

  test(`cursor-agent/${name}: keys are stable across a lost state`, () => {
    withStore(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), project(fullReplay(adapter, dir).views())));
  });

  test(`cursor-agent/${name}: no string under a secret-looking name, and no sentinel, in any unit or record`, () => {
    withStore(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) {
          for (const u of src.units.values()) {
            if (u.enc === 'b64') continue;
            hits.push(...nameLint(JSON.parse(u.body), EXEMPT, `${u.source_key}@${u.unit_key}:`));
          }
        }
        for (const r of s.view.values()) hits.push(...nameLint(r, EXEMPT, `${r.type}:`));
      }
      assert.deepEqual(hits, []);
      const text = everything(e);
      for (const x of SECRETS) assert.ok(!text.includes(x), `${x} reached a unit or a record`);
      for (const s of e.sessions.values()) assert.ok(!JSON.stringify([...s.view.values()]).includes(SECRET_SCOPE));
    });
  });
}

test('cursor-agent: generate.js reproduces every committed fixture file byte for byte', () => {
  for (const [name, build] of Object.entries(BUILDERS)) {
    const { dbs, files } = build();
    for (const [rel, [schema, ops]] of Object.entries(dbs)) {
      const base = path.join(FIX, name, 'store-sql', rel);
      assert.equal(fs.readFileSync(`${base}.schema.sql`, 'utf8'), schema, `${name}/${rel}`);
      assert.equal(fs.readFileSync(`${base}.ops.jsonl`, 'utf8'), ops.map((x) => JSON.stringify(x) + '\n').join(''), `${name}/${rel}`);
    }
    for (const [rel, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(FIX, name, 'store', rel), 'utf8'), text, `${name}/${rel}`);
    // A blob is stored under the sha256 of its bytes.
    for (const db of sqlFilesOf(path.join(FIX, name))) {
      for (const op of db.ops.filter((o) => o.sql.startsWith('INSERT OR REPLACE INTO blobs'))) assert.equal(op.params[0], sha(Buffer.from(op.params[1].$b64, 'base64')));
    }
  }
});

test('cursor-agent: the folded result does not depend on the order sources are given', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    for (const s of adapter.list(store)) {
      const k = keyOf(store, s.session_id);
      const input = s.sources.map((x) => ({ source_key: x.source_key, generation: 1, complete: true, units: adapter.read(store, k, x.source_key).units, gone: [] }));
      const a = adapter.derive(k, input, null);
      const b = adapter.derive(k, [...input].reverse(), null);
      const sorted = (out) => out.changed.map((r) => JSON.stringify(r)).sort();
      assert.deepEqual(sorted(b), sorted(a));
      assert.deepEqual(b.live, a.live);
      assert.deepEqual(b.held, a.held);
    }
  });
});

// ---- the lab cases (unpublished) ---------------------------------------------------------------

test('cursor-agent: lab case: turn key = request_id fbef27ef…, the user message = user_message_id 45c3fe3c…', () => {
  const recs = recsOf('features', A);
  assert.deepEqual(ids(recs).slice(1, 3), [UID(1), `${RID(1)}:assistant`]);
  assert.match(UID(1), /^45c3fe3c-/);
  assert.match(RID(1), /^fbef27ef-/);
});

test('cursor-agent: lab case: tool_call_id call-00c41679…-2\\nfc_… links the step to the JSON tool result, byte-exact', () => {
  const a = msg(recsOf('features', A), `${RID(1)}:assistant`);
  const [c, r] = a.parts.filter((p) => p.part_id.startsWith('2:'));
  assert.ok(c.call_id.startsWith('call-00c41679-') && c.call_id.includes('-2\nfc_'), 'the newline is kept');
  assert.equal(r.call_id, c.call_id);
  assert.deepEqual([c.kind, c.name, c.args], ['tool_call', 'Shell', { command: 'python3 -m pytest -q', working_directory: CWD, description: 'Run the tests' }]);
  assert.deepEqual([r.kind, r.is_error, r.status], ['tool_result', true, 'completed']);
  assert.match(r.output, /1 failed, 2 passed/, 'the output the model saw, from the JSON tool result');
});

test('cursor-agent: lab case: a plain-uuid toolCallId is accepted as a call_id', () => {
  const a = msg(recsOf('features', A), `${RID(4)}:assistant`);
  const plain = a.parts.filter((p) => /^[0-9a-f-]{36}$/.test(p.call_id ?? ''));
  assert.deepEqual(plain.map((p) => [p.kind, p.name ?? p.output]), [['tool_call', 'Shell'], ['tool_result', 'README.md\ntoyshop']]);
});

test('cursor-agent: lab case: subagentInfo.parentAgentId de1be1a9… + toolCallId give a subagent link from the child to the parent\'s call', () => {
  const [child] = ofType(recsOf('subagent', SUB), 'link');
  assert.match(P, /^de1be1a9-/);
  assert.deepEqual([child.kind, child.stated_on, child.origin, child.child.session_id, child.at, child.evidence], ['subagent', 'child', { harness: 'cursor-agent', session_id: P }, SUB, TOOL, 'explicit']);
  // The parent names its child once, though its Task result, subagent_states and runs all do.
  const parent = ofType(recsOf('subagent', P), 'link');
  assert.deepEqual(parent.map((l) => [l.kind, l.stated_on, l.child.session_id, l.origin.session_id, l.at]), [['subagent', 'origin', SUB, P, TOOL]]);
  const task = msg(recsOf('subagent', P), `${uid('c3a28bce', 131)}:assistant`).parts;
  assert.deepEqual([task[0].name, task[0].args.prompt, task[1].output], ['Task', 'List every test function.', 'Found 4 tests.']);
  // The child's prompt is its parent's, its user message has no id, and the reminder is not its text.
  const um = msg(recsOf('subagent', SUB), `${uid('c3a28bce', 132)}:user`);
  assert.deepEqual([um.source, um.parts.map((p) => p.text)], ['automated', ['List the test functions under tests/.']]);
  assert.equal(ofType(recsOf('subagent', SUB), 'session')[0].kind, null, 'no kind field: the sub-agent fact is the link');
});

// sessions-model v1.3, §2.1 (`kind`, the native session type): cursor-agent stores no kind
// field, and a flag or a parent reference is not a kind, so a session's `kind` is null. A sub-agent
// stays a sub-agent through the §2.5 link that meta.subagentInfo states.
test('cursor-agent: kind is null for every session, a sub-agent included; meta.subagentInfo stays the child-side subagent link', () => {
  for (const name of CASES) {
    withStore(name, (dir) => {
      const views = project(fullReplay(adapter, dir).views());
      for (const [sid, recs] of Object.entries(views)) assert.equal(ofType(recs, 'session')[0].kind, null, `${name} ${sid}`);
      if (name !== 'subagent') return;
      const links = ofType(views[SUB], 'link');
      assert.deepEqual(links.map((l) => [l.kind, l.stated_on, l.origin.session_id, l.at]), [['subagent', 'child', P, TOOL]]);
    });
  }
});

test('cursor-agent: lab case: latestRootBlobId = e3b0c442… gives a titled session with zero messages', () => {
  const recs = recsOf('features', E);
  assert.equal(EMPTY_ROOT.slice(0, 8), 'e3b0c442');
  assert.deepEqual(recs.map((r) => r.type), ['session']);
  assert.equal(recs[0].title, 'SKU List');
});

test('cursor-agent: lab case: blobEncryptionKey and encrypted_model are never emitted; their paths hold the marker', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const k = keyOf(store, A);
    const m = adapter.read(store, k, metaKey(A));
    const [u] = m.units;
    assert.deepEqual([u.enc, u.redacted], ['rows-json', true]);
    assert.equal(JSON.parse(u.body).meta[0].value.blobEncryptionKey, `<redacted len=${Buffer.byteLength(SECRET_META)}>`);
    // A turn blob is pb-json: #1 agent turn, #4 encrypted_model redacted, the rest kept as stored.
    const blobs = adapter.read(store, k, blobsKey(A)).units;
    const turns = blobs.filter((x) => x.enc === 'pb-json' && JSON.parse(x.body).fields[0].n === 1);
    assert.ok(turns.length >= 9, 'every agent turn blob, live and superseded');
    for (const t of turns) {
      const body = JSON.parse(t.body);
      assert.equal(body.orig_sha256, t.unit_key, 'orig_sha256 is the content address');
      const enc = body.fields[0].fields.find((f) => f.n === 4);
      assert.deepEqual(enc, { n: 4, w: 2, redacted: `<redacted len=${Buffer.byteLength(SECRET_ENC)}>` });
      assert.equal(t.redacted, true);
    }
    assert.ok(!JSON.stringify(blobs).includes(SECRET_ENC));
  });
});

// ---- the memhouse normaliser's reviewed cases ----------------------------------------------------

test('cursor-agent: a turn: reasoning, text, a failing tool with its result; part ids; models; no usage at all', () => {
  const recs = recsOf('features', A);
  const a = msg(recs, `${RID(1)}:assistant`);
  assert.deepEqual(a.parts.map((p) => [p.part_id, p.kind]), [['0', 'reasoning'], ['1', 'text'], ['2:call', 'tool_call'], ['2:result', 'tool_result'], ['3', 'text']]);
  assert.equal(a.parts[0].text, 'The total ignores qty; run the tests first.', 'reasoning is the step\'s plaintext');
  assert.deepEqual([a.served_model, a.requested_model, a.effort, a.status, a.source], [MODEL, 'default', null, 'complete', 'model']);
  assert.equal(a.ts, new Date(T0 + 1000).toISOString(), 'the first step\'s start');
  for (const c of CASES) assert.deepEqual(Object.values(golden(c)).flat().filter((r) => r.type === 'usage'), [], 'cursor-agent stores no usage');
  const s = ofType(recs, 'session')[0];
  assert.deepEqual([s.title, s.cwd, s.last_cwd, s.created_at, s.client, s.incarnation, s.reuse], ['coupon-work', CWD, CWD, new Date(T0 - 40000).toISOString(), 'cli', '', 'impossible']);
});

test('cursor-agent: without the model context the step is decoded: name, curated args, typed output; an untyped kind keeps its outcome only', () => {
  const recs = recsOf('features', A);
  const read = msg(recs, `${RID(2)}:assistant`).parts;
  assert.deepEqual([read[0].name, read[0].args, read[1].output, read[1].is_error], ['Read', { path: `${CWD}/toyshop/cart.py` }, 'class Cart: ...', false]);
  const p = msg(recs, `${RID(4)}:assistant`).parts;
  assert.deepEqual([p[0].name, p[1].status, p[1].is_error, p[1].output], ['Shell', 'denied', null, 'Denied: do not run git clean.']);
  assert.deepEqual(p[0].args, { command: 'git clean -fdx', working_directory: CWD, description: 'Run the tests', timeout: 30000 }, 'never secret_scope_id or the bookkeeping');
  assert.deepEqual([p[2].name, p[2].args, p[3].output, p[3].is_error, p[3].status], ['WebSearch', {}, null, false, 'completed']);
  assert.ok(!JSON.stringify(recs).includes('SENTINEL-UNTYPED'), 'an untyped kind\'s step is never decoded');
});

test('cursor-agent: shell mode (!cmd): an anchored id, one call and its result; exit code 3 is exit_code, and is_error null (no flag)', () => {
  const m = msg(recsOf('features', A), `${UID(2)}+1`);
  assert.deepEqual([m.role, m.source, m.status, m.ts], ['user', 'user', 'complete', null]);
  assert.deepEqual(m.parts.map((p) => [p.part_id, p.kind, p.call_id]), [['0:call', 'tool_call', `@${UID(2)}+1:0`], ['0:result', 'tool_result', `@${UID(2)}+1:0`]]);
  assert.deepEqual([m.parts[0].args.command, m.parts[1].output, m.parts[1].is_error, m.parts[1].exit_code], ['python3 -c "import sys; print(7); sys.exit(3)"', '7\n', null, 3]);
  // An empty ShellOutput (the empty blob) is a finished command with exit 0, and still no flag.
  const { s, turns } = simpleChat(A, [['hi', 'hello']]);
  const quiet = s.put(pb([[2, [[1, ref(s.put(pb([[1, 'true']])))], [2, ref(s.put(Buffer.alloc(0)))]]]]));
  s.meta(metaOf(A, root(s, { turns: [...turns, quiet] })));
  withChats([s], (dir) => {
    const q = viewOf(fullReplay(adapter, dir), A).find((r) => r.type === 'message' && r.message_id === `${uid('8b76b964', 900)}+1`);
    assert.deepEqual([q.parts[1].output, q.parts[1].is_error, q.parts[1].exit_code], ['', null, 0]);
  });
});

test('cursor-agent: credential tools: args keep naming keys only, outputs are never kept; read redacts steps and model messages', () => {
  const p = msg(recsOf('features', A), `${RID(5)}:assistant`).parts;
  const calls = p.filter((x) => x.kind === 'tool_call').map((x) => [x.name, x.args]);
  assert.deepEqual(calls, [
    ['ReplaceEnv', { name: 'API_KEY' }],
    ['McpLogin', {}],
    ['MCPLogin', { server: 'https://example.com/toybox/login', names: ['TOYBOX', 'TOYBOX_EU'] }],
    ['ConnectSCM', { provider: 'github', scm: ['https://example.com/toybox.git'] }],
  ]);
  assert.deepEqual(p.filter((x) => x.kind === 'tool_result').map((x) => [x.output, x.is_error]), [[null, false], [null, true], [null, false], [null, false]]);
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const units = adapter.read(store, keyOf(store, A), blobsKey(A)).units;
    // The steps: by their kind (#51, #41), and by the name the model context gives them (#18, #24).
    const steps = units.filter((u) => u.enc === 'pb-json' && JSON.parse(u.body).fields[0].n === 2);
    const kinds = steps.map((u) => JSON.parse(u.body).fields[0].fields[0]);
    assert.deepEqual(kinds.map((k) => k.n).sort((a, b) => a - b), [18, 24, 41, 51]);
    for (const k of kinds) {
      assert.match(k.fields.find((f) => f.n === 1).redacted, /^<redacted len=\d+>$/, 'the args');
      const res = k.fields.find((f) => f.n === 2).fields;
      assert.ok(res.length === 1 && /^<redacted len=\d+>$/.test(res[0].redacted), 'the result keeps its case, not its content');
    }
    // The model messages stay utf8 JSON, with the values replaced.
    const json = units.filter((u) => u.enc === 'utf8' && u.redacted).map((u) => JSON.parse(u.body));
    const a5 = json.find((o) => o.role === 'assistant');
    const dyn = a5.content.find((x) => x.toolName === 'CallDynamicTool').args;
    assert.deepEqual(Object.keys(dyn.arguments), ['server', 'host', 'names', 'token']);
    assert.equal(dyn.arguments.server, 'https://example.com/toybox/login', 'user:pass@ cut');
    assert.match(dyn.arguments.token, /^<redacted len=\d+>$/);
    assert.match(a5.content.find((x) => x.toolName === 'ReplaceEnv').args.value, /^<redacted len=\d+>$/);
    const results = json.filter((o) => o.role === 'tool');
    assert.equal(results.length, 2);
    for (const o of results) for (const c of o.content) assert.match(c.result, /^<redacted len=\d+>$/);
    assert.match(results.find((o) => o.providerOptions).providerOptions.cursor.highLevelToolCallResult.output, /^<redacted len=\d+>$/);
    for (const x of [SECRET_ARG, SECRET_OUT, SECRET_PW]) assert.ok(!JSON.stringify(units).includes(x), x);
  });
});

// A chat whose last turn holds the given tool steps, with no model context at all.
function stepsChat(make, ctx = () => []) {
  const { s, last: prev, turns } = simpleChat(A, [['hi', 'hello']]);
  const um = userMsg(s, { text: 'Log in.', id: uid('8b76b964', 990), snap: prev, t: T0 + 400000 });
  const steps = make(s);
  const t = agentTurn(s, { um, steps: [...steps, say(s, 'Done.', T0 + 409000, false)], rid: uid('c3a28bce', 990), uid: uid('8b76b964', 990) });
  s.meta(metaOf(A, root(s, { turns: [...turns, t], ctx: ctx(s) })));
  return { s, steps };
}
// Every unit read gives for the chat, decoded, as one text, and the units of `ids`.
function readAll(dir, ids) {
  const store = storeOf(adapter, dir);
  const k = keyOf(store, A);
  const out = adapter.list(store).find((x) => x.session_id === A).sources.map((x) => adapter.read(store, k, x.source_key));
  const units = out.flatMap((r) => r.units);
  const text = units.map((u) => (u.enc === 'b64' ? Buffer.from(u.body, 'base64').toString('latin1') : u.body)).join('\n');
  return { text, units: ids.map((id) => units.find((u) => u.unit_key === id)) };
}
const SENT = 'SENTINEL-STEP-ONLY-0123456789';

test('cursor-agent: an mcp step to a credential tool, by its own name, is redacted in read with no model context', () => {
  const value = (v) => [[3, v]]; // google.protobuf.Value string_value
  const { s, steps } = stepsChat((c) => [
    // McpAuth by tool_name (#5); mcp_login by name (#1) only. Both carry the secret in the args map
    // (#2) and the result.
    toolStep(c, 15, call(61), [[1, 'auth'], [2, [[1, 'token'], [2, value(SENT)]]], [3, call(61)], [4, 'toybox-provider'], [5, 'McpAuth'], [9, 'toybox']], [[1, [[1, [[1, [[1, `ok ${SENT}`]]]]]]]], T0 + 401000),
    toolStep(c, 15, call(62), [[1, 'mcp_login'], [2, [[1, 'password'], [2, value(SENT)]]], [9, 'toybox']], [[1, [[1, [[1, [[1, SENT]]]]]]]], T0 + 402000),
  ]);
  withChats([s], (dir) => {
    const { text, units } = readAll(dir, steps);
    assert.ok(!text.includes(SENT), 'no argument or result value reaches read');
    for (const u of units) {
      assert.deepEqual([u.enc, u.redacted], ['pb-json', true]);
      const mcp = JSON.parse(u.body).fields[0].fields[0];
      assert.equal(mcp.n, 15);
      const args = mcp.fields.find((f) => f.n === 1).fields;
      assert.match(args.find((f) => f.n === 2).redacted, /^<redacted len=\d+>$/, 'the args map');
      assert.ok(args.filter((f) => f.n !== 2 && f.n !== 3).every((f) => 'b64' in f), 'the naming fields are kept');
    }
    const a = viewOf(fullReplay(adapter, dir), A).find((r) => r.message_id === `${uid('c3a28bce', 990)}:assistant`);
    assert.deepEqual(a.parts.slice(0, 4).map((p) => [p.kind, p.name ?? null, p.args ?? null, p.server ?? null, p.output ?? null]), [
      ['tool_call', 'CallMcpTool', {}, 'toybox', null], ['tool_result', null, null, null, null],
      ['tool_call', 'CallMcpTool', {}, 'toybox', null], ['tool_result', null, null, null, null],
    ]);
    assert.ok(!JSON.stringify(a).includes(SENT));
  });
});

test('cursor-agent: a step of a kind the adapter does not know is redacted in read, and folds into a call and its result', () => {
  const { s, steps } = stepsChat((c) => [
    c.put(pb([[2, [[99, [[1, [[1, 'deploy'], [2, SENT]]], [2, [[1, [[1, `deployed ${SENT}`]]]]]]], [57, call(63)], [59, T0 + 403000], [60, T0 + 403500]]]])),
  ]);
  withChats([s], (dir) => {
    const { text, units } = readAll(dir, steps);
    assert.ok(!text.includes(SENT), 'no argument or result value reaches read');
    const kind = JSON.parse(units[0].body).fields[0].fields[0];
    assert.deepEqual([units[0].enc, kind.n], ['pb-json', 99]);
    assert.match(kind.fields.find((f) => f.n === 1).redacted, /^<redacted len=\d+>$/);
    assert.deepEqual(kind.fields.find((f) => f.n === 2).fields.map((f) => [f.n, /^<redacted len=\d+>$/.test(f.redacted)]), [[1, true]], 'the result keeps its case');
    const a = viewOf(fullReplay(adapter, dir), A).find((r) => r.message_id === `${uid('c3a28bce', 990)}:assistant`);
    assert.deepEqual(a.parts.slice(0, 2).map((p) => [p.part_id, p.kind, p.call_id, p.name ?? null, p.args ?? null, p.status ?? null, p.is_error ?? null, p.output ?? null]), [
      ['0:call', 'tool_call', call(63), 'Tool99', {}, null, null, null],
      ['0:result', 'tool_result', call(63), null, null, 'completed', false, null],
    ]);
  });
  // With the model context, the call takes its name and arguments; the step itself stays redacted.
  const step = (c) => [c.put(pb([[2, [[99, [[1, [[1, 'deploy'], [2, SENT]]], [2, [[1, [[1, 'deployed']]]]]]], [57, call(63)], [59, T0 + 403000]]]]))];
  const ctx = (c) => [c.json({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: call(63), toolName: 'Deploy', args: { target: 'staging' } }] })];
  const named = stepsChat(step, ctx);
  withChats([named.s], (dir) => {
    assert.ok(!readAll(dir, named.steps).text.includes(SENT));
    const a = viewOf(fullReplay(adapter, dir), A).find((r) => r.message_id === `${uid('c3a28bce', 990)}:assistant`);
    assert.deepEqual([a.parts[0].name, a.parts[0].args, a.parts[1].output], ['Deploy', { target: 'staging' }, null]);
  });
});

test('cursor-agent: typed grep and MCP results are projected field by field; MCP names its server; by-reference outputs', () => {
  const p = msg(recsOf('features', A), `${RID(6)}:assistant`).parts;
  assert.equal(p[1].output, './toyshop/cart.py:22:    def apply_coupon(self, code):\n./toyshop/cart.py:30:        return COUPONS[code]');
  assert.deepEqual([p[2].name, p[2].server, p[3].output], ['CallMcpTool', 'toybox', 'three robots\n[1 non-text content item]']);
  assert.ok(!JSON.stringify(golden('features')).includes('SENTINEL-UNPROJECTED'));
  const bin = p[5].output_ref;
  assert.deepEqual([bin.ref, bin.bytes], [`blob:${bin.sha256}`, 11], 'a binary read holds its data blob by reference');
  assert.deepEqual([p[7].truncated, p[7].output_ref.bytes], [true, 48213], 'a truncated step references its original blob');
  assert.equal(p[7].output_ref.sha256, sha(Buffer.from('the original step, too big to keep inline')));
  assert.ok(!('output_ref' in p[1]) && p[0].server === null, 'only by-reference outputs carry a ref; only MCP calls a server');
});

test('cursor-agent: an image in the user\'s model message is an inline attachment', () => {
  const u = msg(recsOf('features', A), UID(6));
  assert.deepEqual(u.parts[1], { part_id: 'att:0', kind: 'attachment', media_type: 'image/png', inline: Buffer.from('PNG!').toString('base64'), ref: null, bytes_len: 4 });
});

test('cursor-agent: source: plan execution is automated, a commit reminder injected, a message the user sent to a sub-agent the user\'s', () => {
  const recs = recsOf('features', A);
  assert.deepEqual([7, 8, 9, 1].map((n) => msg(recs, UID(n)).source), ['automated', 'injected', 'user', 'user']);
});

test('cursor-agent: compaction: a summary after the turn it covers, an explicit compaction record; every turn kept; archived context still feeds model and args', () => {
  const recs = recsOf('features', A);
  const sum = messages(recs).find((m) => m.parts[0].kind === 'summary');
  assert.deepEqual(ids(recs).slice(0, 4), [ids(recs)[0], UID(1), `${RID(1)}:assistant`, sum.message_id]);
  assert.deepEqual([sum.role, sum.source, sum.to_user, sum.to_model, sum.parts[0].replaces], ['system', 'system_notice', false, true, { archive_ref: sum.message_id }]);
  const [lc] = ofType(recs, 'lifecycle');
  assert.deepEqual([lc.lifecycle_id, lc.op, lc.target, lc.evidence], [sum.message_id, 'compaction', { range: { from_id: UID(1), through_id: `${RID(1)}:assistant` } }, 'explicit']);
  const a1 = msg(recs, `${RID(1)}:assistant`);
  assert.equal(a1.served_model, MODEL, 'from the archived model message');
  assert.equal(a1.parts[2].args.description, 'Run the tests');
});

test('cursor-agent: a <system_reminder> in the model context is a hidden, injected system message, placed by the request before it', () => {
  const recs = recsOf('features', A);
  const rem = messages(recs).filter((m) => m.source === 'injected' && m.role === 'system');
  assert.equal(rem.length, 2);
  assert.equal(ids(recs)[0], rem[0].message_id, 'before the first turn: no request precedes it');
  assert.equal(ids(recs)[ids(recs).indexOf(`${RID(6)}:assistant`) + 1], rem[1].message_id, 'after the last request in the context');
  for (const m of rem) assert.deepEqual([m.to_user, m.to_model], [false, true]);
  assert.ok(!rem.some((m) => /<user_info>/.test(m.parts[0].text)), 'the context preamble is not a reminder');
});

// ---- held, interrupted, torn ---------------------------------------------------------------------

test('cursor-agent: held: the last reply waits while its tool runs or no step exists; the user message is out; completion releases it', () => {
  withStore('features', (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const out = lastDerive(e, H);
    const rid = uid('c3a28bce', 112);
    assert.deepEqual(out.held.message, [`${rid}:assistant`]);
    assert.ok(out.live.message.includes(uid('8b76b964', 212)), 'the user message is written');
    // The tool finishes: a new step blob, a re-minted turn, a new root.
    const db = sqlFilesOf(path.join(FIX, 'features')).find((d) => d.rel === `${chat(H)}/store.db`);
    const s = new Chat(chat(H));
    for (const op of db.ops) if (op.sql.startsWith('INSERT OR REPLACE INTO blobs')) s.put(Buffer.from(op.params[1].$b64, 'base64'));
    const ops = [...db.ops];
    const um2 = userMsg(s, { text: 'Run the tests again.', id: uid('8b76b964', 212), snap: rootOfOps(ops, 0), t: T0 + 3660000 });
    const C = call(9);
    const doneStep = toolStep(s, 1, C, shellArgs('python3 -m pytest -q', C), shellOk('python3 -m pytest -q', '4 passed'), T0 + 3661000);
    const t1 = turnsOf(s, rootOfOps(ops, 0))[0];
    const t2 = agentTurn(s, { um: um2, steps: [say(s, 'Running.', T0 + 3660500), doneStep, say(s, 'All green.', T0 + 3665000, false)], rid, uid: uid('8b76b964', 212) });
    s.meta(metaOf(H, root(s, { turns: [t1, t2] }), { name: 'held-run' }));
    buildDb(dir, { rel: db.rel, schema: SCHEMA, ops: [...ops, ...s.ops.filter((o) => !ops.some((x) => x.params[0] === o.params[0] && o.sql.startsWith('INSERT')))] });
    e.pass();
    const next = lastDerive(e, H);
    assert.deepEqual(next.held.message, []);
    const a = next.changed.find((r) => r.message_id === `${rid}:assistant`);
    assert.deepEqual([a.status, a.parts[2].output, a.parts[2].is_error], ['complete', '4 passed', false]);
    assert.deepEqual(e.log.filter((l) => l.session_id === H).map((l) => [l.source_key.split('#')[1] ?? 'meta.json', l.continuity]), [['table:blobs', 'delta'], ['table:meta', 'snapshot']]);
  });
});

// The root a meta statement names: the n-th meta op's latestRootBlobId (H has 3 meta ops).
function rootOfOps(ops, n) {
  const metas = ops.filter((o) => o.sql.includes('INTO meta'));
  return JSON.parse(Buffer.from(metas[n].params[0], 'hex').toString('utf8')).latestRootBlobId;
}
// The turn blob ids of a root built by generate.js's root() (field 8).
function turnsOf(s, rootId) {
  const buf = s.blobs.get(rootId);
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = buf[pos++];
    if ((key & 7) === 2) {
      let len = 0;
      let mul = 1;
      for (;;) {
        const b = buf[pos++];
        len += (b & 0x7f) * mul;
        mul *= 128;
        if (b < 0x80) break;
      }
      if (key >> 3 === 8) out.push(buf.subarray(pos, pos + len).toString('hex'));
      pos += len;
    } else while (buf[pos++] & 0x80);
  }
  return out;
}

test('cursor-agent: a held key keeps its last version: a reply written once and regenerated is held, not rewritten nor tombstoned', () => {
  const { s, turns } = simpleChat(A, [['one', 'first'], ['two', 'second']]);
  withChats([s], (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const rid = `${uid('c3a28bce', 901)}:assistant`;
    assert.ok(lastDerive(e, A).live.message.includes(rid));
    // The same turn re-minted with no step yet (a regeneration after an edit).
    const um = userMsg(s, { text: 'two', id: uid('8b76b964', 901), snap: turns[0], t: T0 + 60000 });
    const again = agentTurn(s, { um, steps: [], rid: uid('c3a28bce', 901), uid: uid('8b76b964', 901) });
    s.meta(metaOf(A, root(s, { turns: [turns[0], again] }), { name: 'toy-chat' }));
    buildDb(dir, { rel: `${s.dir}/store.db`, schema: SCHEMA, ops: s.ops });
    e.pass();
    const out = lastDerive(e, A);
    assert.deepEqual(out.held.message, [rid]);
    assert.ok(!out.live.message.includes(rid) && !out.changed.some((r) => r.message_id === rid));
    assert.equal(viewOf(e, A).find((r) => r.message_id === rid).parts[0].text, 'second', 'the consumer keeps its last version');
  });
});

test('cursor-agent: a turn followed by another is released; its tool with no result is interrupted, with no result part; a running shell turn last is held', () => {
  const { s, turns } = simpleChat(A, [['hi', 'hello']]);
  const C = call(7);
  const um = userMsg(s, { text: 'Sleep 90 seconds.', id: uid('8b76b964', 950), snap: turns[0], t: T0 + 150000 });
  const t3 = agentTurn(s, { um, steps: [toolStep(s, 1, C, shellArgs('sleep 90', C), null, T0 + 151000)], rid: uid('c3a28bce', 950), uid: uid('8b76b964', 950) });
  const um4 = userMsg(s, { text: 'Never mind.', id: uid('8b76b964', 951), snap: turns[0], t: T0 + 160000 });
  const t4 = agentTurn(s, { um: um4, steps: [say(s, 'Ok.', T0 + 161000, false)], rid: uid('c3a28bce', 951), uid: uid('8b76b964', 951) });
  // A shell command with no output yet, last.
  const running = s.put(pb([[2, [[1, ref(s.put(pb([[1, 'make serve']])))]]]]));
  s.meta(metaOf(A, root(s, { turns: [...turns, t3, t4, running] })));
  withChats([s], (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const v = viewOf(e, A);
    const a3 = v.find((r) => r.message_id === `${uid('c3a28bce', 950)}:assistant`);
    assert.deepEqual([a3.status, a3.parts.map((p) => p.kind)], ['interrupted', ['tool_call']]);
    assert.equal(v.find((r) => r.message_id === `${uid('c3a28bce', 951)}:assistant`).status, 'complete');
    assert.deepEqual(lastDerive(e, A).held.message, [`${uid('8b76b964', 951)}+1`]);
  });
});

test('cursor-agent: a torn tree: read of meta is the retryable inconsistent; a derive that meets one holds every key; the next pass folds', () => {
  const { s, last: root2 } = simpleChat(A, [['one', 'first'], ['two', 'second']]);
  withChats([s], (dir) => {
    const store = storeOf(adapter, dir);
    const k = keyOf(store, A);
    const e = new MiniEngine(adapter, store);
    e.pass();
    const before = project(e.views());
    // A third turn's blobs and root arrive between the engine's read of blobs and its read of meta.
    const um = userMsg(s, { text: 'three', id: uid('8b76b964', 960), snap: root2, t: T0 + 200000 });
    const t3 = agentTurn(s, { um, steps: [say(s, 'third', T0 + 200500, false)], rid: uid('c3a28bce', 960), uid: uid('8b76b964', 960) });
    const turns = turnsOf(s, root2);
    s.meta(metaOf(A, root(s, { turns: [...turns, t3] }), { name: 'toy-chat' }));
    const blobsBefore = adapter.read(store, k, blobsKey(A)).units;
    buildDb(dir, { rel: `${s.dir}/store.db`, schema: SCHEMA, ops: s.ops });
    const known = Object.fromEntries(blobsBefore.map((u) => [u.unit_key, u.sha256]));
    const metaNow = adapter.read(store, k, metaKey(A), { sha256: 'x' });
    const held = adapter.derive(k, [
      { source_key: blobsKey(A), generation: 1, complete: true, units: blobsBefore, gone: [] },
      { source_key: metaKey(A), generation: 1, complete: true, units: metaNow.units, gone: [] },
    ], lastDerive(e, A).state);
    assert.deepEqual(held.changed, []);
    assert.deepEqual(held.held.message, lastDerive(e, A).live.message, 'every emitted key is held: none rewritten, none tombstoned');
    assert.deepEqual(held.held.session, ['']);
    // The missing blobs arrive with the next read: the tree folds.
    const fresh = adapter.read(store, k, blobsKey(A), { count: 0 }, known);
    const out = adapter.derive(k, [{ source_key: blobsKey(A), generation: 1, complete: false, units: fresh.units, gone: [] }], held.state);
    assert.ok(out.live.message.includes(`${uid('c3a28bce', 960)}:assistant`));
    assert.deepEqual(out.held.message, []);
    e.pass();
    assert.notDeepEqual(project(e.views()), before);
    // A store whose meta names a blob that is not there: inconsistent, never an empty session.
    const db = new DatabaseSync(path.join(dir, `${s.dir}/store.db`));
    db.prepare('DELETE FROM blobs WHERE id = ?').run(t3);
    db.close();
    assert.throws(() => adapter.read(store, k, metaKey(A)), { code: 'inconsistent' });
  });
});

test('cursor-agent: positive control: one appended turn keeps every earlier key unchanged, adds the new ones, tombstones nothing', () => {
  const { s, last: root2 } = simpleChat(A, [['one', 'first'], ['two', 'second']]);
  withChats([s], (dir) => {
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const before = lastDerive(e, A).live;
    const um = userMsg(s, { text: 'three', id: uid('8b76b964', 980), snap: root2, t: T0 + 300000 });
    const t3 = agentTurn(s, { um, steps: [say(s, 'third', T0 + 300500, false)], rid: uid('c3a28bce', 980), uid: uid('8b76b964', 980) });
    s.meta(metaOf(A, root(s, { turns: [...turnsOf(s, root2), t3] }), { name: 'toy-chat' }));
    buildDb(dir, { rel: `${s.dir}/store.db`, schema: SCHEMA, ops: s.ops });
    e.pass();
    const out = lastDerive(e, A);
    const added = [uid('8b76b964', 980), `${uid('c3a28bce', 980)}:assistant`];
    assert.deepEqual(out.changed.map((r) => r.type === 'message' ? r.message_id : r.type).sort(), [...added, 'session'].sort());
    assert.deepEqual(out.live.message, [...before.message, ...added].sort());
    assert.deepEqual(out.held.message, []);
  });
});

// ---- rewind and fork -----------------------------------------------------------------------------

test('cursor-agent: rewind: the root moves back, a snapshot change of meta, never a reset; the later turns leave live; no lifecycle record', () => {
  const caseDir = path.join(FIX, 'rewind');
  const db = sqlFilesOf(caseDir).find((d) => d.rel === `${chat(R)}/store.db`);
  const metas = db.ops.map((o, i) => [o, i]).filter(([o]) => o.sql.includes('INTO meta')).map(([, i]) => i);
  withStore('rewind', (dir) => {
    buildDb(dir, db, metas[2] + 1); // turns 1 and 2
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const t2 = [uid('8b76b964', 242), `${uid('c3a28bce', 142)}:assistant`];
    assert.deepEqual(ids(viewOf(e, R)), [uid('8b76b964', 241), `${uid('c3a28bce', 141)}:assistant`, ...t2]);
    buildDb(dir, db, metas[3] + 1); // the rewind: meta only
    e.pass();
    const log = e.log.filter((l) => l.session_id === R).map((l) => [l.source_key.split('#')[1] ?? 'meta.json', l.continuity]);
    assert.deepEqual(log, [['meta.json', 'unchanged'], ['table:blobs', 'unchanged'], ['table:meta', 'snapshot']]);
    const out = lastDerive(e, R);
    for (const id of t2) assert.ok(!out.live.message.includes(id) && !out.held.message.includes(id), `${id} leaves live`);
    assert.deepEqual(out.live.lifecycle, [], 'an implicit rewind writes no record');
    assert.deepEqual(ids(viewOf(e, R)), [uid('8b76b964', 241), `${uid('c3a28bce', 141)}:assistant`], 'the kept turn keeps its ids');
    buildDb(dir, db);
    e.pass();
    assert.deepEqual(ids(viewOf(e, R)), [uid('8b76b964', 241), `${uid('c3a28bce', 141)}:assistant`, uid('8b76b964', 243), `${uid('c3a28bce', 143)}:assistant`]);
    assert.deepEqual(project(e.views()), project(fullReplay(adapter, dir).views()));
  });
});

test('cursor-agent: fork: the blobs copied to a new chat id, " (forked)": the same message ids, no link', () => {
  const fork = recsOf('rewind', F);
  assert.deepEqual(ofType(fork, 'link'), []);
  assert.equal(ofType(fork, 'session')[0].title, 'coupon-work (forked)');
  assert.deepEqual(ids(fork), [uid('8b76b964', 241), `${uid('c3a28bce', 141)}:assistant`, uid('8b76b964', 242), `${uid('c3a28bce', 142)}:assistant`]);
  // The fork's copied prefix has the origin's cmp_shas, which a consumer nominates (inferable).
  const o = ofType(recsOf('rewind', R), 'session')[0].fingerprint.cmp_shas;
  assert.deepEqual(ofType(fork, 'session')[0].fingerprint.cmp_shas.slice(0, 2), o.slice(0, 2));
});

// ---- list and read ------------------------------------------------------------------------------

test('cursor-agent: list: every chat with its store.db and every ACP store; an empty chat is none; hints are stable', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const sessions = adapter.list(store);
    assert.deepEqual(sessions.map((s) => s.session_id), [ACP, E, A, H].sort());
    const a = sessions.find((s) => s.session_id === A);
    assert.deepEqual([a.incarnation, a.live], ['', 'unknown']);
    assert.deepEqual(a.sources.map((s) => [s.source_key, s.role, s.mode, s.position_kind]), [
      [`${chat(A)}/meta.json`, 'side', 'snapshot', 'snapshot'],
      [blobsKey(A), 'main', 'delta', 'kv'],
      [metaKey(A), 'side', 'snapshot', 'snapshot'],
    ]);
    assert.deepEqual(sessions.find((s) => s.session_id === H).sources.map((s) => s.source_key), [blobsKey(H), metaKey(H)], 'no meta.json, no source');
    assert.equal(sessions.find((s) => s.session_id === ACP).sources[1].source_key, `acp-sessions/${ACP}/store.db#table:blobs`);
    assert.deepEqual(adapter.list(store), sessions);
    // A rewrite of meta.json (every open bumps updatedAtMs) moves no hint and reads unchanged.
    const k = keyOf(store, A);
    const mj = `${chat(A)}/meta.json`;
    const r1 = adapter.read(store, k, mj);
    assert.deepEqual(JSON.parse(r1.units[0].body), { cwd: CWD });
    const o = JSON.parse(fs.readFileSync(path.join(dir, mj), 'utf8'));
    fs.writeFileSync(path.join(dir, mj), JSON.stringify({ ...o, updatedAtMs: o.updatedAtMs + 1 }));
    assert.deepEqual(adapter.list(store), sessions);
    assert.equal(adapter.read(store, k, mj, r1.position).continuity, 'unchanged');
  });
});

test('cursor-agent: cursor-orphan: a transcript whose chat was deleted is never listed, and read of its id is session_unknown', () => {
  withStore('orphan', (dir) => {
    const store = storeOf(adapter, dir);
    assert.ok(fs.existsSync(path.join(dir, ORPHAN_TRANSCRIPT)), 'the orphan transcript is in the store');
    assert.deepEqual(adapter.list(store).map((s) => s.session_id), [L]);
    assert.deepEqual(Object.keys(golden('orphan')), [L]);
    for (const sk of [ORPHAN_TRANSCRIPT, blobsKey(ORPHAN), metaKey(ORPHAN)]) assert.throws(() => adapter.read(store, keyOf(store, ORPHAN), sk), { code: 'session_unknown' });
  });
});

test('cursor-agent: read of blobs: reset, then unchanged, then only the new blobs; a known blob that vanished is gone', () => {
  const { s, last: root2 } = simpleChat(A, [['one', 'first']]);
  withChats([s], (dir) => {
    const store = storeOf(adapter, dir);
    const k = keyOf(store, A);
    const r1 = adapter.read(store, k, blobsKey(A));
    assert.equal(r1.continuity, 'reset');
    assert.deepEqual(r1.units.map((u) => u.enc).sort(), ['b64', 'b64', 'b64', 'b64', 'pb-json'], 'two roots, a user message, a step; the turn is pb-json');
    for (const u of r1.units.filter((x) => x.enc === 'b64')) assert.equal(u.sha256, u.unit_key, 'an unredacted blob\'s sha is its id');
    const known = Object.fromEntries(r1.units.map((u) => [u.unit_key, u.sha256]));
    assert.equal(adapter.read(store, k, blobsKey(A), r1.position, known).continuity, 'unchanged');
    const um = userMsg(s, { text: 'two', id: uid('8b76b964', 970), snap: root2, t: T0 + 1 });
    s.put(pb([[1, 'two']]));
    buildDb(dir, { rel: `${s.dir}/store.db`, schema: SCHEMA, ops: s.ops });
    const r2 = adapter.read(store, k, blobsKey(A), r1.position, { ...known, deadbeef: 'x' });
    assert.equal(r2.continuity, 'delta');
    assert.deepEqual(r2.units.map((u) => u.unit_key).sort(), [um, sha(pb([[1, 'two']]))].sort());
    assert.deepEqual(r2.gone, ['deadbeef']);
  });
});

test('cursor-agent: list and read create nothing beside a WAL-mode store', () => {
  withStore('features', (dir) => {
    const files = () => {
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.relative(dir, path.join(d, e.name))));
      };
      walk(dir);
      return out.sort();
    };
    const before = files();
    assert.equal(fullReplay(adapter, dir).sessions.size, 4);
    assert.deepEqual(files(), before);
  });
});

test('cursor-agent: errors: an unknown session, an unknown source, a deleted chat', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const k = keyOf(store, A);
    assert.throws(() => adapter.read(store, keyOf(store, uid('11111111', 1)), blobsKey(A)), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, keyOf(store, '../..'), blobsKey(A)), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, k, `${chat(A)}/store.db#table:other`), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, k, blobsKey(H)), { code: 'source_unknown' });
    assert.throws(() => adapter.read(store, keyOf(store, H), `${chat(H)}/meta.json`), { code: 'source_unknown' });
    fs.rmSync(path.join(dir, chat(A)), { recursive: true });
    assert.ok(!adapter.list(store).some((s) => s.session_id === A));
    assert.throws(() => adapter.read(store, k, blobsKey(A)), { code: 'session_unknown' });
  });
});

test('cursor-agent: a locked store is busy, a damaged one or an undecodable meta row damaged; never fewer messages', () => {
  withStore('features', (dir) => {
    const store = storeOf(adapter, dir);
    const k = keyOf(store, A);
    const file = path.join(dir, `${chat(A)}/store.db`);
    const full = adapter.read(store, k, blobsKey(A)).units.length;
    const d = new DatabaseSync(file);
    d.exec('PRAGMA journal_mode = DELETE');
    d.close();
    const locker = new DatabaseSync(file);
    locker.exec('BEGIN EXCLUSIVE');
    try {
      assert.throws(() => adapter.read(store, k, blobsKey(A)), { code: 'busy' });
      assert.throws(() => adapter.read(store, k, metaKey(A)), { code: 'busy' });
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
    assert.equal(adapter.read(store, k, blobsKey(A)).units.length, full, 'and reads in full once the lock is gone');
    const bak = fs.readFileSync(file);
    const buf = Buffer.from(bak);
    const ps = buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16);
    for (let off = ps; off + 16 <= buf.length; off += ps) buf.fill(0xa5, off, off + 16);
    fs.writeFileSync(file, buf);
    assert.throws(() => adapter.read(store, k, blobsKey(A)), { code: 'damaged' });
    fs.writeFileSync(file, bak);
    const w = new DatabaseSync(file);
    w.prepare("UPDATE meta SET value = '7b7b' WHERE key = '0'").run();
    w.close();
    assert.throws(() => adapter.read(store, k, metaKey(A)), { code: 'damaged' });
  });
});

test('cursor-agent: a symlinked chat directory or store.db is neither listed nor read', () => {
  withStore('orphan', (dir) => {
    const store = storeOf(adapter, dir);
    const outside = tmpStore('sa-outside-');
    try {
      const a = uid('99999999', 1);
      const b = uid('88888888', 2);
      fs.mkdirSync(path.join(outside, 'chat'));
      fs.copyFileSync(path.join(dir, `${chat(L)}/store.db`), path.join(outside, 'chat', 'store.db'));
      fs.symlinkSync(path.join(outside, 'chat'), path.join(dir, chat(a)));
      fs.mkdirSync(path.join(dir, chat(b)));
      fs.symlinkSync(path.join(outside, 'chat', 'store.db'), path.join(dir, `${chat(b)}/store.db`));
      fs.symlinkSync(path.join(outside), path.join(dir, 'chats', 'linked-bucket'));
      assert.deepEqual(adapter.list(store).map((s) => s.session_id), [L]);
      for (const sid of [a, b]) {
        for (const sk of [blobsKey(sid), metaKey(sid)]) assert.throws(() => adapter.read(store, keyOf(store, sid), sk), (e) => e.code === 'session_unknown' || e.code === 'source_unknown');
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---- describe -----------------------------------------------------------------------------------

test('cursor-agent: describe states every facet, and each explicit claim has a fixture record', () => {
  const d = adapter.describe();
  assert.deepEqual([d.harness, d.model_version, d.store_shape, d.facets.reuse], ['cursor-agent', 'sessions-model/1', { kind: 'folder' }, 'impossible']);
  for (const op of ['rewind', 'edit', 'compaction', 'delete', 'archive', 'unarchive', 'rename', 'pin', 'unpin', 'fork', 'clear']) {
    assert.ok(['explicit', 'implicit', 'invisible'].includes(d.facets.lifecycle[op]), op);
  }
  for (const k of ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation']) assert.ok(['explicit', 'inferable', 'none'].includes(d.facets.linkage[k]), k);
  const all = CASES.flatMap((c) => Object.values(golden(c)).flat());
  const ops = new Set(ofType(all, 'lifecycle').map((r) => r.op));
  for (const [op, v] of Object.entries(d.facets.lifecycle)) if (v === 'explicit') assert.ok(ops.has(op), `explicit ${op} has no fixture record`);
  assert.deepEqual([...ops], ['compaction'], 'no rewind record: lifecycle records are explicit-only');
  const kinds = new Set(ofType(all, 'link').map((r) => r.kind));
  for (const [k, v] of Object.entries(d.facets.linkage)) if (v === 'explicit') assert.ok(kinds.has(k), `explicit ${k} link has no fixture record`);
  const parts = ofType(all, 'message').flatMap((m) => m.parts);
  assert.ok(parts.some((p) => p.kind === 'summary' && p.replaces && p.replaces.archive_ref), 'linkage.compaction {archive_ref}');
  // linkage.tool native: every result's call_id names exactly one call in its session.
  for (const c of CASES) {
    for (const recs of Object.values(golden(c))) {
      const callIds = messages(recs).flatMap((m) => m.parts.filter((p) => p.kind === 'tool_call').map((p) => p.call_id));
      for (const r of messages(recs).flatMap((m) => m.parts.filter((p) => p.kind === 'tool_result'))) assert.equal(callIds.filter((x) => x === r.call_id).length, 1, r.call_id);
    }
  }
});

// sessions-model v1.3, §2.3 (`tool_result.is_error`): the harness store's own flag, a step
// result's case (ShellSuccess, ShellFailure) or the model context's `isError`. A flag that says
// success beside a shell's non-zero exit_code is unreliable for that result, so its is_error is
// null; a shell-mode turn's ShellOutput keeps no flag, so null. Never derived from exit_code.
test('cursor-agent: is_error is the stored flag: ShellSuccess or isError false beside a non-zero exit is null, a shell-mode turn is null, ShellFailure is true', () => {
  withStore('features', (dir) => {
    const recs = viewOf(fullReplay(adapter, dir), A);
    const results = (id) => msg(recs, id).parts.filter((p) => p.kind === 'tool_result').map((p) => [p.is_error, p.exit_code]);
    assert.deepEqual(results(`${UID(2)}+1`), [[null, 3]], 'a shell-mode turn: no flag, exit 3');
    assert.deepEqual(results(`${RID(1)}:assistant`), [[true, 1]], 'ShellFailure, and isError true, beside exit 1');
  });
  const { s, last, turns } = simpleChat(A, [['hi', 'hello']]);
  const [C2, C0, CF, CJ] = [call(81), call(82), call(83), call(84)];
  const shellSuccess = (cmd, out, code) => [[1, [[1, cmd], [2, CWD], [3, code], [5, out]]]];
  const um = userMsg(s, { text: 'Run the checks.', id: uid('8b76b964', 981), snap: last, t: T0 + 300000 });
  const steps = [
    toolStep(s, 1, C2, shellArgs('./check', C2), shellSuccess('./check', 'warned', 2), T0 + 300100),
    toolStep(s, 1, C0, shellArgs('true', C0), shellOk('true', ''), T0 + 300200),
    toolStep(s, 1, CF, shellArgs('false', CF), shellFailure('false', '', 1), T0 + 300300),
    toolStep(s, 1, CJ, shellArgs('./lint', CJ), shellSuccess('./lint', 'lint', 4), T0 + 300400),
  ];
  // CJ's model context: isError false beside its exit code 4.
  const rj = s.json({
    role: 'tool', id: CJ, content: [{ type: 'tool-result', toolCallId: CJ, toolName: 'Shell', result: 'Exit code: 4\n\nCommand output:\n\nlint' }],
    providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { exitCode: 4 } }, isError: false } } },
  });
  const t = agentTurn(s, { um, steps, rid: uid('c3a28bce', 981), uid: uid('8b76b964', 981) });
  s.meta(metaOf(A, root(s, { turns: [...turns, t], ctx: [rj] })));
  withChats([s], (dir) => {
    const parts = msg(viewOf(fullReplay(adapter, dir), A), `${uid('c3a28bce', 981)}:assistant`).parts;
    assert.deepEqual(Object.fromEntries(parts.filter((p) => p.kind === 'tool_result').map((p) => [p.call_id, [p.is_error, p.exit_code]])), {
      [C2]: [null, 2], [C0]: [false, 0], [CF]: [true, 1], [CJ]: [null, 4],
    }, 'ShellSuccess beside exit 2: null; ShellSuccess exit 0: false; ShellFailure: true; isError false beside exit 4: null');
    assert.match(parts.find((p) => p.kind === 'tool_result' && p.call_id === CJ).output, /^Exit code: 4/, 'CJ\'s result is the model context\'s');
  });
});

// sessions-model v1.3, §2.3 (`tool_result.is_error`): `is_error` describes a call that
// completed. A rejected shell (`denied`), a cancelled ShellFailure (#11) and a timeout (`cancelled`)
// did not; their is_error is null and the status carries the fact, the model context's `isError`
// beside them included. A call that completed keeps the flag (the positive control: ShellFailure
// true, ShellSuccess false).
test('cursor-agent: is_error is null where the call did not complete: a rejection, a cancelled ShellFailure, a timeout; the status carries the fact', () => {
  withStore('features', (dir) => {
    const p = msg(viewOf(fullReplay(adapter, dir), A), `${RID(4)}:assistant`).parts;
    assert.deepEqual([p[1].status, p[1].is_error], ['denied', null], 'the fixture\'s rejected shell');
  });
  const { s, last, turns } = simpleChat(A, [['hi', 'hello']]);
  const [CX, CT, CR, CF, CO] = [call(91), call(92), call(93), call(94), call(95)];
  const um = userMsg(s, { text: 'Run the checks.', id: uid('8b76b964', 991), snap: last, t: T0 + 400000 });
  const steps = [
    toolStep(s, 1, CX, shellArgs('./slow', CX), [[2, [[1, './slow'], [2, CWD], [3, 130], [5, 'tick'], [11, true]]]], T0 + 400100),
    toolStep(s, 1, CT, shellArgs('./hang', CT), [[3, [[3, 30000]]]], T0 + 400200),
    toolStep(s, 1, CR, shellArgs('git clean -fdx', CR), [[4, [[3, 'Denied: no.']]]], T0 + 400300),
    toolStep(s, 1, CF, shellArgs('false', CF), shellFailure('false', '', 1), T0 + 400400),
    toolStep(s, 1, CO, shellArgs('true', CO), shellOk('true', ''), T0 + 400500),
  ];
  // CR's model context: isError true beside the rejection.
  const rj = s.json({
    role: 'tool', id: CR, content: [{ type: 'tool-result', toolCallId: CR, toolName: 'Shell', result: 'Denied: no.' }],
    providerOptions: { cursor: { highLevelToolCallResult: { isError: true } } },
  });
  const t = agentTurn(s, { um, steps, rid: uid('c3a28bce', 991), uid: uid('8b76b964', 991) });
  s.meta(metaOf(A, root(s, { turns: [...turns, t], ctx: [rj] })));
  withChats([s], (dir) => {
    const parts = msg(viewOf(fullReplay(adapter, dir), A), `${uid('c3a28bce', 991)}:assistant`).parts;
    assert.deepEqual(Object.fromEntries(parts.filter((x) => x.kind === 'tool_result').map((x) => [x.call_id, [x.status, x.is_error]])), {
      [CX]: ['cancelled', null], [CT]: ['cancelled', null], [CR]: ['denied', null], [CF]: ['completed', true], [CO]: ['completed', false],
    });
  });
});

test('cursor-agent: a tool_result carries the stored shell exit code (ShellSuccess / ShellFailure #3, ShellOutput #3); none for other kinds or a credential step', () => {
  withStore('features', (dir) => {
    const recs = viewOf(fullReplay(adapter, dir), A);
    const results = (id) => msg(recs, id).parts.filter((p) => p.kind === 'tool_result');
    // The step's ShellFailure #3 = 1, beside the model context's "Exit code: 1" text.
    assert.deepEqual(results(`${RID(1)}:assistant`).map((p) => p.exit_code), [1]);
    // A rejected command (no code), an untyped kind, and a ShellSuccess #3 = 0.
    assert.deepEqual(results(`${RID(4)}:assistant`).map((p) => [p.status, p.exit_code]), [['denied', null], ['completed', null], ['completed', 0]]);
    assert.deepEqual(results(`${UID(2)}+1`).map((p) => p.exit_code), [3], 'a shell turn: ShellOutput #3');
    assert.deepEqual(results(`${RID(2)}:assistant`).map((p) => p.exit_code), [null], 'a read result keeps no exit code');
  });
  // A shell step whose call the model context names a credential tool: read redacts its result
  // case, and the result keeps no exit code; the same step under its own name keeps it.
  const { s, last, turns } = simpleChat(A, [['hi', 'hello']]);
  const [CP, CC] = [call(77), call(78)];
  const um = userMsg(s, { text: 'Set the token.', id: uid('8b76b964', 977), snap: last, t: T0 + 300000 });
  const plain = toolStep(s, 1, CP, shellArgs('false', CP), shellFailure('false', '', 5), T0 + 300100);
  const cred = toolStep(s, 1, CC, shellArgs('false', CC), shellFailure('false', '', 5), T0 + 300200);
  const aj = s.json({ role: 'assistant', id: 'msg_synth77', content: [{ type: 'tool-call', toolCallId: CC, toolName: 'ReplaceEnv', args: { name: 'TOKEN' } }] });
  const t = agentTurn(s, { um, steps: [plain, cred], rid: uid('c3a28bce', 977), uid: uid('8b76b964', 977) });
  s.meta(metaOf(A, root(s, { turns: [...turns, t], ctx: [aj] })));
  withChats([s], (dir) => {
    const parts = msg(viewOf(fullReplay(adapter, dir), A), `${uid('c3a28bce', 977)}:assistant`).parts;
    assert.deepEqual(parts.filter((p) => p.kind === 'tool_result').map((p) => [p.call_id, p.exit_code]), [[CP, 5], [CC, null]]);
  });
});
