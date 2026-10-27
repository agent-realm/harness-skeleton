import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../src/index.js';
import { MiniEngine } from '../conformance/engine.js';
import { fullReplay, project, growthCheck, rewriteCheck, tmpStore, copyTree, storeOf, nameLint } from '../conformance/runner.js';

const adapter = adapterFor('codex');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'codex');
const CASES = ['basic', 'no-ids', 'live', 'features'];

function withCopy(name, fn) {
  const dir = tmpStore();
  try {
    copyTree(path.join(FIX, name, 'store'), dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const name of CASES) {
  test(`codex/${name}: the full replay equals the reviewed golden`, () => {
    const expected = JSON.parse(fs.readFileSync(path.join(FIX, name, 'expected.json'), 'utf8'));
    withCopy(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), expected));
  });

  test(`codex/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    const r = growthCheck(adapter, path.join(FIX, name, 'store'), { steps: 31 });
    assert.deepEqual(r.incremental, r.full);
    assert.ok(r.equal, 'content_sha differs between the incremental and the full view');
    assert.deepEqual(r.notUnchanged, []);
  });

  test(`codex/${name}: keys are stable across a lost state`, () => {
    withCopy(name, (dir) => {
      const a = project(fullReplay(adapter, dir).views());
      const b = project(fullReplay(adapter, dir).views());
      assert.deepEqual(a, b);
    });
  });

  test(`codex/${name}: no string under a secret-looking name in any unit or record`, () => {
    withCopy(name, (dir) => {
      const e = fullReplay(adapter, dir);
      const hits = [];
      for (const s of e.sessions.values()) {
        for (const src of s.sources.values()) for (const u of src.units.values()) hits.push(...nameLint(JSON.parse(u.body), [], `${u.unit_key}:`));
        for (const r of s.view.values()) hits.push(...nameLint(r, [], `${r.type}:`));
      }
      assert.deepEqual(hits, []);
    });
  });
}

test('codex: a rewrite of a rollout (new inode, shorter) is a reset, and vanished keys go', () => {
  const store = path.join(FIX, 'features', 'store');
  // The file comes from the adapter's own list, never from a directory walk: an archive tool can
  // leave files beside it (macOS tar's `._*` AppleDouble files) that are no source at all.
  const rel = withCopy('features', (dir) => adapter.list(storeOf(adapter, dir))
    .find((x) => x.session_id.startsWith('0c0d0e0f-')).sources.find((x) => x.source_key.startsWith('sessions/')).source_key);
  const r = rewriteCheck(adapter, store, rel, 5);
  assert.equal(r.continuity, 'reset');
  assert.ok(r.equal);
});

test('codex: archiving moves the rollout; the re-derive keeps every key and only the session state changes', () => {
  withCopy('basic', (dir) => {
    const store = storeOf(adapter, dir);
    const e = new MiniEngine(adapter, store);
    e.pass();
    const before = project(e.views());
    const rel = adapter.list(store)[0].sources[0].source_key;
    assert.ok(rel.startsWith('sessions/'));
    fs.mkdirSync(path.join(dir, 'archived_sessions'), { recursive: true });
    fs.renameSync(path.join(dir, rel), path.join(dir, 'archived_sessions', path.basename(rel)));
    e.pass();
    assert.deepEqual(e.log.map((l) => l.continuity), ['reset']);
    const after = project(e.views());
    assert.deepEqual(Object.keys(after), Object.keys(before));
    for (const sid of Object.keys(before)) {
      const strip = (recs) => recs.filter((r) => r.type !== 'session');
      assert.deepEqual(strip(after[sid]), strip(before[sid]), 'every message, usage and lifecycle record is unchanged');
      const s0 = before[sid].find((r) => r.type === 'session');
      const s1 = after[sid].find((r) => r.type === 'session');
      assert.equal(s0.state, 'active');
      assert.equal(s1.state, 'archived');
      assert.deepEqual({ ...s1, state: 'active' }, s0);
    }
  });
});

test('codex: list names every session and its rollouts, by path relative to CODEX_HOME', () => {
  withCopy('features', (dir) => {
    const sessions = adapter.list(storeOf(adapter, dir));
    assert.equal(sessions.length, 3);
    for (const s of sessions) {
      assert.equal(s.incarnation, '');
      assert.equal(s.live, 'unknown');
      for (const x of s.sources) {
        assert.deepEqual([x.role, x.mode, x.position_kind], ['main', 'stream', 'byte_offset']);
        assert.match(x.source_key, /^(sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions)\/rollout-[^/]+\.jsonl$/);
        assert.ok(x.source_key.endsWith(`-${s.session_id}.jsonl`));
      }
    }
    // Two rollouts with one id: two main sources of one session.
    const two = sessions.find((s) => s.sources.length === 2);
    assert.ok(two);
    assert.deepEqual(two.sources.map((x) => x.source_key.split('/')[0]), ['archived_sessions', 'sessions']);
    // A rollout whose name has no UUID takes its id from line 1's session_meta.
    const [first] = sessions;
    const src = path.join(dir, first.sources[0].source_key);
    fs.copyFileSync(src, path.join(dir, 'archived_sessions', 'rollout-no-uuid.jsonl'));
    const again = adapter.list(storeOf(adapter, dir));
    assert.equal(again.length, 3);
    assert.ok(again.find((s) => s.session_id === first.session_id).sources.some((x) => x.source_key === 'archived_sessions/rollout-no-uuid.jsonl'));
    // The hint moves when a source grows.
    const before = again.find((s) => s.session_id === first.session_id).updated_hint;
    fs.appendFileSync(src, '\n');
    assert.notEqual(adapter.list(storeOf(adapter, dir)).find((s) => s.session_id === first.session_id).updated_hint, before);
  });
});

test('codex: errors: an unknown session, an unknown source, a deleted session', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.sources.length === 1 && x.sources[0].source_key.startsWith('sessions/'));
    const key = { ...store, session_id: s.session_id, incarnation: '' };
    assert.throws(() => adapter.read(store, { ...key, session_id: '11111111-1111-4111-8111-111111111111' }, s.sources[0].source_key), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, 'sessions/2026/01/01/rollout-none.jsonl'), { code: 'source_unknown' });
    // A deleted session: its rollout removed, list omits it and read says session_unknown.
    fs.rmSync(path.join(dir, s.sources[0].source_key));
    assert.ok(!adapter.list(store).some((x) => x.session_id === s.session_id));
    assert.throws(() => adapter.read(store, key, s.sources[0].source_key), { code: 'session_unknown' });
  });
});

test('codex: describe states every facet, and each explicit claim has a fixture', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'codex');
  assert.equal(d.model_version, 'sessions-model/1');
  for (const op of ['rewind', 'edit', 'compaction', 'delete', 'archive', 'unarchive', 'rename', 'pin', 'unpin', 'fork', 'clear']) {
    assert.ok(['explicit', 'implicit', 'invisible'].includes(d.facets.lifecycle[op]), op);
  }
  for (const k of ['fork', 'subagent', 'rewind_copy', 'clear', 'continuation']) {
    assert.ok(['explicit', 'inferable', 'none'].includes(d.facets.linkage[k]), k);
  }
  const explicit = Object.entries(d.facets.lifecycle).filter(([, v]) => v === 'explicit').map(([k]) => k).sort();
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'features', 'expected.json'), 'utf8'));
  const ops = new Set(Object.values(expected).flat().filter((r) => r.type === 'lifecycle').map((r) => r.op));
  for (const op of explicit) assert.ok(ops.has(op), `explicit ${op} has no fixture record`);
  // Every tool call with a result pairs with exactly one result by call_id (linkage.tool native).
  const parts = Object.values(expected).flat().filter((r) => r.type === 'message').flatMap((m) => m.parts);
  for (const r of parts.filter((p) => p.kind === 'tool_result')) {
    assert.equal(parts.filter((p) => p.kind === 'tool_call' && p.call_id === r.call_id).length, 1, r.call_id);
  }
});

// `held` has the shape of `live` (sessions v1 §2; docs/adapter-interface.md, "derive output"). This
// derive never holds a record (the conformance matrix, S.held), so each of its five lists is empty.
test('codex: derive never holds a record: held is the five record types of live, each empty', () => {
  for (const name of CASES) {
    withCopy(name, (dir) => {
      for (const s of fullReplay(adapter, dir).sessions.values()) {
        assert.deepEqual(s.last.held, { session: [], message: [], usage: [], link: [], lifecycle: [] }, name);
      }
    });
  }
});

test('codex: a tool_result carries the stored metadata.exit_code; a plain-text output has none', () => {
  withCopy('features', (dir) => {
    const parts = Object.values(project(fullReplay(adapter, dir).views())).flat()
      .filter((r) => r.type === 'message').flatMap((m) => m.parts).filter((p) => p.kind === 'tool_result');
    const byCall = Object.fromEntries(parts.map((p) => [p.call_id, p]));
    // `{"output":"1 failing","metadata":{"exit_code":2,...}}`: the code, never parsed from the text.
    assert.equal(byCall.call_shell_1.exit_code, 2);
    assert.equal(byCall.call_shell_1.output, '1 failing');
    assert.equal(byCall.call_local_1.exit_code, null);
  });
});

// sessions-model v1.x proposal (#6), §2.3 (tool_result `is_error`): where the store keeps no success or error
// flag, `is_error` is null. A flag that says success beside a shell's non-zero `exit_code` is
// unreliable for that result (Copilot CLI and Codex store `success: true` so): that result's
// `is_error` is null. It is never derived from the exit code (`metadata.exit_code` stays in
// `exit_code`) or from the text.
test('codex: is_error is null where the output keeps no success flag; a stored flag is copied; never derived from exit_code', () => {
  const resultsOf = (dir) => Object.fromEntries(Object.values(project(fullReplay(adapter, dir).views())).flat()
    .filter((r) => r.type === 'message').flatMap((m) => m.parts).filter((p) => p.kind === 'tool_result').map((p) => [p.call_id, [p.is_error, p.exit_code]]));
  withCopy('features', (dir) => {
    const r = resultsOf(dir);
    assert.deepEqual(r.call_shell_1, [null, 2], '{output, metadata: {exit_code: 2}}: no flag');
    assert.deepEqual(r.call_patch_1, [null, 0], '{output, metadata: {exit_code: 0}}: no flag');
    assert.deepEqual(r.call_local_1, [null, null], 'plain text: no flag');
  });
  withCopy('basic', (dir) => {
    for (const [call, v] of Object.entries(resultsOf(dir))) assert.equal(v[0], null, `${call}: exit_code ${v[1]} with no flag`);
  });
  // An output that does carry `success` (no fixture rollout does; the object form the adapter already
  // reads, appended to a copy as synthetic lines): the flag is copied. With `success: true` and a
  // non-zero exit code beside it, the flag is contradicted, and is_error is null, as for copilot-cli.
  withCopy('features', (dir) => {
    const rel = adapter.list(storeOf(adapter, dir)).flatMap((s) => s.sources.map((x) => x.source_key)).find((k) => k.includes('2026-02-10'));
    const line = (call, output) => JSON.stringify({ timestamp: '2026-02-10T09:00:30.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: call, output } });
    fs.appendFileSync(path.join(dir, rel), [
      line('call_flag_false', { content: 'no such file', success: false }),
      line('call_flag_true', { content: 'ok', success: true }),
      line('call_flag_text_false', JSON.stringify({ output: 'boom', metadata: { exit_code: 0 }, success: false })),
      line('call_flag_text_contradicted', JSON.stringify({ output: '1 failing', metadata: { exit_code: 1 }, success: true })),
    ].join('\n') + '\n');
    const r = resultsOf(dir);
    assert.deepEqual(r.call_flag_false, [true, null]);
    assert.deepEqual(r.call_flag_true, [false, null]);
    assert.deepEqual(r.call_flag_text_false, [true, 0], 'the flag, not the exit code');
    assert.deepEqual(r.call_flag_text_contradicted, [null, 1], 'success true, exit 1: contradicted');
  });
});

test('codex: positional ids are qualified by the rollout file name, so two main sources never share a key (sessions-model §1 rule 10)', () => {
  withCopy('no-ids', (dir) => {
    const rel = adapter.list(storeOf(adapter, dir))[0].sources[0].source_key;
    const one = project(fullReplay(adapter, dir).views());
    const sid = Object.keys(one)[0];
    const msgs = (v) => v[sid].filter((r) => r.type === 'message');
    const positional = msgs(one).filter((m) => m.message_id.includes('@'));
    assert.ok(positional.length > 0, 'the no-ids case has items without payload.id');
    for (const m of positional) assert.match(m.message_id, new RegExp(`^${path.basename(rel).replace(/\./g, '\\.')}@\\d+$`));
    // A second rollout of the same session (Codex resumes into a new file), byte for byte the
    // same, so every positional item sits at the same offset in both.
    const second = rel.replace(/rollout-2026-01-03T14-00-00-/, 'rollout-2026-01-03T15-00-00-');
    fs.copyFileSync(path.join(dir, rel), path.join(dir, second));
    const two = project(fullReplay(adapter, dir).views());
    const ids = msgs(two).filter((m) => m.message_id.includes('@')).map((m) => m.message_id);
    assert.equal(new Set(ids).size, ids.length, 'no positional id repeats across the two rollouts');
    assert.equal(ids.length, positional.length * 2);
  });
});

test('codex: one rollout left in both sessions/ and archived_sessions/ is one source name; its records do not double', () => {
  // A rollout's file name carries its creation time and the session uuid, so two main sources of
  // one session differ in name. The same name in two folders is the same rollout (a copy left
  // behind by archiving), and its positional ids collapse onto one set of keys.
  withCopy('no-ids', (dir) => {
    const rel = adapter.list(storeOf(adapter, dir))[0].sources[0].source_key;
    const one = project(fullReplay(adapter, dir).views());
    fs.mkdirSync(path.join(dir, 'archived_sessions'), { recursive: true });
    fs.copyFileSync(path.join(dir, rel), path.join(dir, 'archived_sessions', path.basename(rel)));
    const both = project(fullReplay(adapter, dir).views());
    const keysOf = (v) => Object.fromEntries(Object.entries(v).map(([sid, recs]) => [sid, recs.filter((r) => r.type !== 'session').map((r) => `${r.type} ${r.message_id ?? r.usage_id ?? r.lifecycle_id ?? r.kind}`).sort()]));
    assert.deepEqual(keysOf(both), keysOf(one));
  });
});

test('codex: one id in two rollouts of a session keeps the lowest-order copy, whatever the read order', async () => {
  const { derive } = await import('../src/harnesses/codex/index.js');
  // A resumed session's second rollout repeats an earlier item verbatim, id included; the text
  // differs here only to tell the copies apart. Each rollout opens with its own session_meta.
  const sid = '44444444-4444-4444-8444-444444444444';
  const meta = (ts) => JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: sid, timestamp: ts, cwd: '/work/toy-repo' } });
  const item = (text) => JSON.stringify({ timestamp: '2026-01-05T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_copied', content: [{ type: 'input_text', text }] } });
  const source = (sk, lines) => {
    let off = 0;
    const units = lines.map((body) => {
      const u = { source_key: sk, unit_key: String(off), enc: 'utf8', bytes: Buffer.byteLength(body), sha256: '', redacted: false, body };
      off += Buffer.byteLength(body) + 1;
      return u;
    });
    return { source_key: sk, generation: 1, complete: true, units, gone: [] };
  };
  const a = source(`archived_sessions/rollout-2026-01-05T10-00-00-${sid}.jsonl`, [meta('2026-01-05T10:00:00.000Z'), item('from the first rollout')]);
  const b = source(`sessions/2026/01/06/rollout-2026-01-06T09-00-00-${sid}.jsonl`, [meta('2026-01-06T09:00:00.000Z'), item('from the resumed rollout')]);
  const session = { host: 'h', harness: 'codex', harness_path: '/x', session_id: sid, incarnation: '' };
  const msgs = (out) => out.changed.filter((r) => r.type === 'message' && r.message_id === 'msg_copied');
  const ab = derive(session, [a, b], null);
  const ba = derive(session, [b, a], null);
  assert.equal(msgs(ab).length, 1);
  assert.equal(msgs(ab)[0].content_sha, msgs(ba)[0].content_sha);
  assert.equal(msgs(ab)[0].parts[0].text, 'from the first rollout');
  // Split across two derives, the resumed rollout first: the first rollout's copy still wins.
  const first = derive(session, [b], null);
  const second = derive(session, [{ ...a, complete: false }], first.state);
  assert.deepEqual(msgs(second).map((m) => m.parts[0].text), ['from the first rollout']);
  assert.deepEqual(second.live.message.filter((k) => k === 'msg_copied'), ['msg_copied']);
});

test('codex: compaction is not deletion: every message derived before the compacted record stays, current', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const s = adapter.list(store).find((x) => x.session_id.startsWith('0c0d0e0f-'));
    const file = path.join(dir, s.sources[0].source_key);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const at = lines.findIndex((l) => JSON.parse(l).type === 'compacted');
    assert.ok(at > 0);
    fs.writeFileSync(file, lines.slice(0, at).map((l) => l + '\n').join(''));
    const e = new MiniEngine(adapter, store);
    e.pass();
    const before = [...e.views()[s.session_id].values()].filter((r) => r.type === 'message');
    assert.ok(before.length >= 10);
    fs.appendFileSync(file, lines.slice(at).map((l) => l + '\n').join(''));
    e.pass();
    const view = e.views()[s.session_id];
    assert.ok([...view.values()].some((r) => r.type === 'lifecycle' && r.op === 'compaction'));
    for (const m of before) {
      const now = view.get(`message\u0000${m.message_id}`);
      assert.ok(now, `${m.message_id} is still present`);
      assert.equal(now.state, 'current', m.message_id);
    }
  });
});
