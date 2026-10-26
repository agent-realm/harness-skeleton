import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../src/index.js';
import { fullReplay, project, growthCheck, rewriteCheck, tmpStore, copyTree, storeOf, nameLint } from '../conformance/runner.js';

const adapter = adapterFor('claude-code');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude-code');
const CASES = ['basic', 'features'];

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
  test(`claude-code/${name}: the full replay equals the reviewed golden`, () => {
    const expected = JSON.parse(fs.readFileSync(path.join(FIX, name, 'expected.json'), 'utf8'));
    withCopy(name, (dir) => assert.deepEqual(project(fullReplay(adapter, dir).views()), expected));
  });

  test(`claude-code/${name}: every incremental path folds to the full replay; a further read is unchanged`, () => {
    const r = growthCheck(adapter, path.join(FIX, name, 'store'), { steps: 31 });
    assert.deepEqual(r.incremental, r.full);
    assert.ok(r.equal, 'content_sha differs between the incremental and the full view');
    assert.deepEqual(r.notUnchanged, []);
  });

  test(`claude-code/${name}: keys are stable across a lost state`, () => {
    withCopy(name, (dir) => {
      const a = project(fullReplay(adapter, dir).views());
      const b = project(fullReplay(adapter, dir).views());
      assert.deepEqual(a, b);
    });
  });

  test(`claude-code/${name}: no string under a secret-looking name in any unit or record`, () => {
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

test('claude-code: a rewrite of the transcript (new inode, shorter) is a reset, and vanished keys go', () => {
  const store = path.join(FIX, 'features', 'store');
  // The file comes from the adapter's own list, never from a directory walk: an archive tool can
  // leave files beside it (macOS tar's `._*` AppleDouble files) that are no source at all.
  const rel = withCopy('features', (dir) => adapter.list(storeOf(adapter, dir))[0].sources.find((x) => x.role === 'main').source_key);
  const r = rewriteCheck(adapter, store, rel, 5);
  assert.equal(r.continuity, 'reset');
  assert.ok(r.equal);
});

test('claude-code: speaker split: a user record holding tool results and text gives a tool message and a <uuid>+1 user message', () => {
  withCopy('features', (dir) => {
    // features: user record …0005 holds two tool_result blocks, then the user's text.
    const recs = Object.values(project(fullReplay(adapter, dir).views())).flat().filter((r) => r.type === 'message');
    const id = '00000000-0000-4000-a000-000000000005';
    const tool = recs.find((m) => m.message_id === id);
    const user = recs.find((m) => m.message_id === `${id}+1`);
    assert.deepEqual([tool.role, tool.source, tool.parts.map((p) => p.kind)], ['tool', null, ['tool_result', 'tool_result']]);
    assert.deepEqual([user.role, user.source, user.parts.map((p) => [p.kind, p.text])], ['user', 'user', [['text', 'also show the image']]]);
    assert.equal(tool.order, user.order, 'both come from the one native record');
  });
});

test('claude-code: an assistant record\'s plain tool_result block (a gateway ran the tool) is a part of the reply', () => {
  withCopy('features', (dir) => {
    // features: assistant record …0014 holds a tool_use, a plain tool_result and the reply's text.
    const recs = Object.values(project(fullReplay(adapter, dir).views())).flat().filter((r) => r.type === 'message');
    const m = recs.find((r) => r.message_id === '00000000-0000-4000-a000-000000000014');
    assert.deepEqual([m.role, m.source, m.parts.map((p) => p.kind)], ['assistant', 'model', ['tool_call', 'tool_result', 'text']]);
    const r = m.parts[1];
    assert.deepEqual([r.call_id, r.is_error, r.output], ['toolu_feat_gw', false, 'two results for the toy repo']);
  });
});

test('claude-code: list names every session and its sources; sub-agent files are agent sources', () => {
  withCopy('basic', (dir) => {
    const sessions = adapter.list(storeOf(adapter, dir));
    assert.equal(sessions.length, 1);
    const [s] = sessions;
    assert.equal(s.incarnation, '');
    assert.equal(s.live, 'unknown');
    assert.deepEqual([...new Set(s.sources.map((x) => x.role))].sort(), ['agent', 'main']);
    for (const x of s.sources) assert.deepEqual([x.mode, x.position_kind], ['stream', 'byte_offset']);
    assert.ok(s.sources.some((x) => x.role === 'main' && x.source_key.endsWith(`${s.session_id}.jsonl`)));
    assert.ok(s.sources.some((x) => x.role === 'agent' && /\/subagents\/agent-[^/]+\.jsonl$/.test(x.source_key)));
    // The hint moves when a source grows.
    const main = s.sources.find((x) => x.role === 'main');
    fs.appendFileSync(path.join(dir, main.source_key), '\n');
    assert.notEqual(adapter.list(storeOf(adapter, dir))[0].updated_hint, s.updated_hint);
  });
});

test('claude-code: errors: an unknown session, an unknown source', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const [s] = adapter.list(store);
    const key = { ...store, session_id: s.session_id, incarnation: '' };
    assert.throws(() => adapter.read(store, { ...key, session_id: '11111111-1111-4111-8111-111111111111' }, s.sources[0].source_key), { code: 'session_unknown' });
    assert.throws(() => adapter.read(store, key, 'projects/x/none.jsonl'), { code: 'source_unknown' });
    // A deleted session: its file removed, list omits it and read says session_unknown.
    fs.rmSync(path.join(dir, s.sources[0].source_key));
    assert.deepEqual(adapter.list(store), []);
    assert.throws(() => adapter.read(store, key, s.sources[0].source_key), { code: 'session_unknown' });
  });
});

test('claude-code: describe states every facet, and each explicit claim has a fixture', () => {
  const d = adapter.describe();
  assert.equal(d.harness, 'claude-code');
  assert.equal(d.model_version, 'sessions-model/1');
  for (const op of ['rewind', 'edit', 'compaction', 'delete', 'archive', 'unarchive', 'rename', 'pin', 'unpin', 'fork', 'clear']) {
    assert.ok(['explicit', 'implicit', 'invisible'].includes(d.facets.lifecycle[op]), op);
  }
  const explicit = Object.entries(d.facets.lifecycle).filter(([, v]) => v === 'explicit').map(([k]) => k).sort();
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'features', 'expected.json'), 'utf8'));
  const ops = new Set(Object.values(expected).flat().filter((r) => r.type === 'lifecycle').map((r) => r.op));
  for (const op of explicit) assert.ok(ops.has(op), `explicit ${op} has no fixture record`);
});

// `held` has the shape of `live` (sessions v1 §2; docs/adapter-interface.md, "derive output"). This
// derive never holds a record (the conformance matrix, S.held), so each of its five lists is empty.
test('claude-code: derive never holds a record: held is the five record types of live, each empty', () => {
  for (const name of CASES) {
    withCopy(name, (dir) => {
      for (const s of fullReplay(adapter, dir).sessions.values()) {
        assert.deepEqual(s.last.held, { session: [], message: [], usage: [], link: [], lifecycle: [] }, name);
      }
    });
  }
});

test('claude-code: a symlinked transcript or project folder is neither listed nor read', () => {
  withCopy('features', (dir) => {
    const store = storeOf(adapter, dir);
    const [s] = adapter.list(store);
    const outside = tmpStore('sa-outside-');
    try {
      const sid = '22222222-2222-4222-8222-222222222222';
      fs.writeFileSync(path.join(outside, `${sid}.jsonl`), '{"type":"user","uuid":"x","message":{"role":"user","content":"outside"}}\n');
      const proj = path.dirname(path.join(dir, s.sources[0].source_key));
      fs.symlinkSync(path.join(outside, `${sid}.jsonl`), path.join(proj, `${sid}.jsonl`));
      fs.symlinkSync(outside, path.join(dir, 'projects', '-linked-project'));
      assert.deepEqual(adapter.list(store).map((x) => x.session_id), [s.session_id]);
      const key = { ...store, session_id: sid, incarnation: '' };
      const rel = path.relative(dir, path.join(proj, `${sid}.jsonl`));
      assert.throws(() => adapter.read(store, key, rel), (e) => e.code === 'session_unknown' || e.code === 'source_unknown');
      assert.throws(() => adapter.read(store, key, `projects/-linked-project/${sid}.jsonl`), (e) => e.code === 'session_unknown' || e.code === 'source_unknown');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('claude-code: one uuid in two main sources keeps the lowest-order copy, whatever the read order', async () => {
  const { derive } = await import('../src/harnesses/claude-code/index.js');
  const line = (text) => JSON.stringify({ type: 'user', uuid: '33333333-3333-4333-8333-333333333333', timestamp: '2026-01-05T10:00:00.000Z', cwd: '/work/toy-repo', message: { role: 'user', content: text } });
  const unit = (sk, body) => ({ source_key: sk, unit_key: '0', enc: 'utf8', bytes: Buffer.byteLength(body), sha256: '', redacted: false, body });
  const a = { source_key: 'projects/-a/s.jsonl', generation: 1, complete: true, units: [unit('projects/-a/s.jsonl', line('from a'))], gone: [] };
  const b = { source_key: 'projects/-b/s.jsonl', generation: 1, complete: true, units: [unit('projects/-b/s.jsonl', line('from b'))], gone: [] };
  const session = { host: 'h', harness: 'claude-code', harness_path: '/x', session_id: 's', incarnation: '' };
  const msg = (out) => out.changed.find((r) => r.type === 'message');
  const ab = derive(session, [a, b], null);
  const ba = derive(session, [b, a], null);
  assert.equal(msg(ab).content_sha, msg(ba).content_sha);
  assert.equal(msg(ab).parts[0].text, 'from a');
  // Split across two derives, b first: a still wins, and the session fingerprint follows it.
  const first = derive(session, [b], null);
  const second = derive(session, [{ ...a, complete: false }], first.state);
  assert.equal(msg(second).parts[0].text, 'from a');
  const fp = (out) => out.changed.find((r) => r.type === 'session').fingerprint.cmp_shas;
  assert.deepEqual(fp(second), fp(ab));
});

test('claude-code: compaction is not deletion: every message derived before the compact_boundary stays, current', () => {
  withCopy('features', (dir) => {
    const rel = 'projects/-work-toy-repo/0f5e1c2a-7b3d-4e8f-a9c1-2d3e4f5a6b7c.jsonl';
    const file = path.join(dir, rel);
    const whole = fs.readFileSync(file, 'utf8');
    const lines = whole.split('\n');
    const at = lines.findIndex((l) => l.includes('"compact_boundary"'));
    assert.ok(at > 0, 'the features transcript holds a compact_boundary');
    // The store as it stood just before the compaction, then as it is after.
    fs.writeFileSync(file, lines.slice(0, at).join('\n') + '\n');
    const before = project(fullReplay(adapter, dir).views());
    fs.writeFileSync(file, whole);
    const after = project(fullReplay(adapter, dir).views());
    const sid = '0f5e1c2a-7b3d-4e8f-a9c1-2d3e4f5a6b7c';
    const msgs = (v) => new Map((v[sid] ?? []).filter((r) => r.type === 'message').map((r) => [r.message_id, r]));
    const pre = msgs(before);
    const post = msgs(after);
    assert.ok(pre.size > 0);
    for (const [id, m] of pre) {
      assert.ok(post.has(id), `${id} is still present after the compaction`);
      assert.equal(post.get(id).state, m.state, `${id} keeps its state`);
    }
    assert.ok([...post.values()].some((m) => (m.parts ?? []).some((p) => p.kind === 'summary')), 'the compaction left a summary');
  });
});
