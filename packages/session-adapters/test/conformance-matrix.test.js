// The conformance matrix (conformance/matrix.js) holds: every checklist item has a proof, or a
// reason it does not apply, for every harness; every named test exists; the generic checks pass
// over every fixture case; and docs/conformance-matrix.md is current.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../src/index.js';
import { ITEMS } from '../conformance/checklist.js';
import { MATRIX, HARNESSES, report, REPORT_FILE } from '../conformance/matrix.js';
import { genericChecks } from '../conformance/generic.js';
import { tmpStore, copyTree } from '../conformance/runner.js';
import { prepareStore, caseHarnessPath } from '../conformance/sql-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

// Every test title in test/<file>, as written in the source.
const titlesCache = new Map();
function titlesOf(file) {
  if (!titlesCache.has(file)) {
    const src = fs.readFileSync(path.join(HERE, file), 'utf8');
    const titles = [...src.matchAll(/^\s*test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm)].map((m) => m[2].replace(/\\(.)/g, '$1'));
    titlesCache.set(file, titles);
  }
  return titlesCache.get(file);
}

test('matrix: the harnesses are the package\'s twelve', () => {
  assert.deepEqual([...HARNESSES].sort(), Object.keys(ADAPTERS).sort());
});

test('matrix: every item has a proof or a reason, for every harness', () => {
  const missing = [];
  for (const item of ITEMS) {
    for (const h of HARNESSES) {
      const cell = MATRIX[item.id]?.[h];
      const reason = cell && (cell.na ?? cell.open);
      const ok = cell && (reason !== undefined ? typeof reason === 'string' && reason.length > 0 : Array.isArray(cell) && cell.length > 0);
      if (!ok) missing.push(`${item.id} ${h}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('matrix: no unknown item or harness, so a typo cannot hide a cell', () => {
  const items = new Set(ITEMS.map((i) => i.id));
  const harnesses = new Set(HARNESSES);
  const unknown = [];
  for (const [id, row] of Object.entries(MATRIX)) {
    if (!items.has(id)) unknown.push(`item ${id}`);
    for (const h of Object.keys(row)) if (!harnesses.has(h)) unknown.push(`${id}: harness ${h}`);
  }
  assert.deepEqual(unknown, []);
});

test('matrix: every named test exists, and each match names exactly one test', () => {
  const absent = [];
  for (const [id, row] of Object.entries(MATRIX)) {
    for (const [h, cell] of Object.entries(row)) {
      if (!Array.isArray(cell)) continue;
      for (const p of cell) {
        if (p.generic) continue;
        if (!fs.existsSync(path.join(HERE, p.test))) absent.push(`${id} ${h}: no file ${p.test}`);
        else {
          const n = titlesOf(p.test).filter((t) => t.includes(p.match)).length;
          if (n !== 1) absent.push(`${id} ${h}: ${n} tests in ${p.test} titled “…${p.match}…”, not exactly 1`);
        }
      }
    }
  }
  assert.deepEqual(absent, []);
});

test('matrix: docs/conformance-matrix.md is current', () => {
  assert.equal(fs.readFileSync(REPORT_FILE, 'utf8'), report(), 'run node conformance/matrix.js --write');
});

// The generic checks, over every fixture case of every adapter.
for (const h of HARNESSES) {
  const dir = path.join(FIXTURES, h);
  const cases = fs.existsSync(dir) ? fs.readdirSync(dir).filter((c) => fs.existsSync(path.join(dir, c, 'expected.json'))) : [];
  test(`matrix: generic checks hold on every ${h} fixture case`, () => {
    assert.ok(cases.length > 0, `${h} has fixture cases`);
    for (const c of cases) {
      const caseDir = path.join(dir, c);
      const store = tmpStore('matrix-');
      try {
        if (fs.existsSync(path.join(caseDir, 'store-sql'))) prepareStore(caseDir, store);
        else copyTree(path.join(caseDir, 'store'), store);
        assert.deepEqual(genericChecks(ADAPTERS[h], caseHarnessPath(caseDir, store)), {}, `${h}/${c}`);
      } finally {
        fs.rmSync(store, { recursive: true, force: true });
      }
    }
  });
}

// The generic checks find what they are for: each one fails on a store built to break it.
test('matrix: the generic checks catch a broken record', async () => {
  const { validateSession } = await import('../src/validate.js');
  const base = { harness: 'claude-code', session_id: 's', incarnation: '' };
  const session = { ...base, type: 'session', state: 'active', reuse: 'impossible', ts_source: 'event', created_at: null, updated_at: null, setup: null, fingerprint: { cmp_shas: [] } };
  const sha = 'a'.repeat(64);
  const msg = (id, parts) => ({ ...base, type: 'message', message_id: id, order: id, agent_id: '', role: 'assistant', source: 'model', status: 'complete', state: 'current', to_user: null, to_model: null, on_active_branch: null, ts: null, cmp_sha: sha, parts });
  assert.deepEqual(validateSession([session, msg('m1', [])], { harness: 'claude-code', sessionId: 's' }), []);
  // A tool_result without exit_code, a time in an id, a retired basis, a second session record
  // (with no setup), a usage record with no tool_prompt.
  const { setup: _s, ...noSetup } = session;
  const bad = [
    session, noSetup,
    msg('2026-01-01T10:00', [{ part_id: '0', kind: 'tool_result', call_id: 'c', is_error: null, status: 'completed', output: '' }]),
    { ...base, type: 'usage', usage_id: 'u', anchor: { session: true }, input: 1, output: 1, cache_read: null, cache_write: null, reasoning: null, cost: null, basis: 'net', input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_session' },
  ];
  const problems = validateSession(bad, { harness: 'claude-code', sessionId: 's' }).map((f) => f.problem).join('\n');
  for (const want of ['no exit_code', 'carries a time', 'basis is retired', '2 session records', 'session has no setup', 'usage has no tool_prompt']) assert.match(problems, new RegExp(want));
  // An empty key, a call with no call_id, an error part with no error_kind; parts that are not a
  // list give one finding, not one per character.
  const keyless = validateSession([session, msg('', [{ part_id: '0', kind: 'tool_call', name: 'shell' }, { part_id: '1', kind: 'error', text: 'x' }]), msg('m2', 'abc')], { harness: 'claude-code', sessionId: 's' }).map((f) => f.problem);
  for (const want of ['message_id is not a non-empty string', 'tool_call has no non-empty string call_id', 'an error part has no error_kind']) assert.ok(keyless.some((p) => p.includes(want)), want);
  assert.equal(keyless.filter((p) => p.startsWith('part_id')).length, 0);
  assert.equal(keyless.filter((p) => p === 'parts is not a list').length, 1);
  // Every key and call_id the validator requires, each missing or not a string.
  const usage = { ...base, type: 'usage', usage_id: 'u', anchor: { session: true }, input: 1, output: 1, cache_read: null, cache_write: null, reasoning: null, tool_prompt: null, cost: null, input_includes_cache: null, output_includes_reasoning: null, granularity: 'per_session' };
  const lifecycle = { ...base, type: 'lifecycle', lifecycle_id: 'l', op: 'rename', evidence: 'explicit', ts: null };
  assert.deepEqual(validateSession([session, usage, lifecycle], { harness: 'claude-code', sessionId: 's' }), []);
  const { usage_id: _u, ...noUsageId } = usage;
  const { lifecycle_id: _l, ...noLifecycleId } = lifecycle;
  const { session_id: _sid, ...noSessionId } = msg('m3', []);
  const cases = [
    [noUsageId, 'usage_id is not a non-empty string'],
    [noLifecycleId, 'lifecycle_id is not a non-empty string'],
    [noSessionId, 'session_id is not a non-empty string'],
    [{ ...usage, usage_id: 42 }, 'usage_id is not a non-empty string'],
    [{ ...lifecycle, lifecycle_id: 42 }, 'lifecycle_id is not a non-empty string'],
    [msg(42, []), 'message_id is not a non-empty string'],
    [{ ...msg('m4', []), session_id: 42 }, 'session_id is not a non-empty string'],
    [msg('m5', [{ part_id: '0', kind: 'tool_result', is_error: null, status: 'completed', output: '', exit_code: null }]), 'tool_result has no non-empty string call_id'],
    [msg('m6', [{ part_id: '0', kind: 'tool_call', call_id: 42, name: 'shell' }]), 'tool_call has no non-empty string call_id'],
  ];
  for (const [rec, want] of cases) {
    const found = validateSession([session, rec]).map((f) => f.problem);
    assert.ok(found.includes(want), `${want}: got ${JSON.stringify(found)}`);
  }
});

// Registries (sessions-model §8, sessions §5) grow in v1.x: a reader accepts a value it does not
// know. The validator warns on an unknown harness or ts_source and refuses neither; the reference
// consumer passes a unit of an unknown enc to derive and keeps a position of an unknown kind verbatim.
test('registries: an unknown harness, ts_source, enc and position_kind are accepted, with a warning where the validator checks', async () => {
  const { validateSession } = await import('../src/validate.js');
  const { MiniEngine } = await import('../conformance/engine.js');
  const base = { harness: 'brand-new-harness', session_id: 's', incarnation: '' };
  const session = { ...base, type: 'session', state: 'active', reuse: 'impossible', ts_source: 'sundial', created_at: null, updated_at: null, setup: null, fingerprint: { cmp_shas: [] } };
  const found = validateSession([session], { harness: 'brand-new-harness', sessionId: 's' });
  assert.deepEqual(found.map((f) => [f.problem.split(' ')[0], f.warning]), [['harness', true], ['ts_source', true]]);
  // An empty or non-string registry value is still refused.
  assert.ok(validateSession([{ ...session, ts_source: '' }]).some((f) => !f.warning));
  // A harness of unknown enc and position_kind, read by the reference consumer.
  const seen = [];
  const adapter = {
    HARNESS: 'brand-new-harness',
    list: () => [{ session_id: 's', incarnation: '', updated_hint: '1', live: true, sources: [{ source_key: 'tape', role: 'main', mode: 'stream', position_kind: 'tape-head' }] }],
    read: (_store, _session, _sk, from) => ({ continuity: from ? 'unchanged' : 'reset', units: from ? [] : [{ source_key: 'tape', unit_key: 'u1', enc: 'clay-tablet', bytes: 2, sha256: '0'.repeat(64), redacted: false, body: 'ab' }], gone: [], position: { kind: 'tape-head', reel: 7 }, held_back: 0 }),
    derive: (sess, input) => {
      for (const src of input) for (const u of src.units) seen.push(u.enc);
      return { changed: [{ ...session, host: sess.host, harness_path: sess.harness_path }], live: { session: [''], message: [], usage: [], link: [], lifecycle: [] }, held: { session: [], message: [], usage: [], link: [], lifecycle: [] }, state: {}, checkpoint: true };
    },
  };
  const e = new MiniEngine(adapter, { host: 'h', harness: 'brand-new-harness', harness_path: '/x' });
  e.pass();
  assert.deepEqual(seen, ['clay-tablet']);
  assert.deepEqual([...e.sessions.values()][0].sources.get('tape').position, { kind: 'tape-head', reel: 7 });
  e.pass();
  assert.equal(e.log[0].continuity, 'unchanged');
});

// Three review cases: each generic check must fail on the break it exists for.
test('matrix: generic checks catch broken tool links, foreign usage shapes and units on an unchanged read', async () => {
  const { recordChecks, genericChecks } = await import('../conformance/generic.js');
  const { fullReplay } = await import('../conformance/runner.js');
  const store = tmpStore('matrix-break-');
  try {
    copyTree(path.join(FIXTURES, 'claude-code', 'features', 'store'), store);
    const views = fullReplay(ADAPTERS['claude-code'], store).views();
    assert.deepEqual(recordChecks('claude-code', views), {});
    // Every result's call_id pointing at no call.
    const relink = Object.fromEntries(Object.entries(views).map(([sid, v]) => [sid, new Map([...v].map(([k, r]) => [k, r.type !== 'message' ? r : { ...r, parts: (r.parts ?? []).map((p) => (p.kind === 'tool_result' ? { ...p, call_id: `wrong:${p.call_id}` } : p)) }]))]));
    assert.ok(recordChecks('claude-code', relink)['M.tool-linkage']?.length > 0);
    // Claude Code usage recast as per-session totals.
    const recast = Object.fromEntries(Object.entries(views).map(([sid, v]) => [sid, new Map([...v].map(([k, r]) => [k, r.type !== 'usage' ? r : { ...r, granularity: 'per_session', anchor: { session: true } }]))]));
    assert.ok(recordChecks('claude-code', recast)['M.usage']?.length > 0);
    // A reader that returns a unit on every read with nothing new.
    const a = ADAPTERS['claude-code'];
    const noisy = { ...a, read: (...args) => { const r = a.read(...args); return r.continuity === 'unchanged' ? { ...r, units: [{ source_key: args[2], unit_key: 'x', enc: 'utf8', bytes: 1, sha256: '0'.repeat(64), redacted: false, body: 'x' }] } : r; } };
    assert.ok(genericChecks(noisy, store)['S.unchanged']?.length > 0);
    // A listed orphan is excused in its own session only: the same call_id in another session of
    // the same harness is still a finding.
    const orphan = (sid) => ({ [sid]: new Map([['m', { type: 'message', message_id: 'm', parts: [{ part_id: '0', kind: 'tool_result', call_id: 'lost_call_1' }] }]]) });
    assert.deepEqual(recordChecks('gemini-cli', orphan('7f3e9a10-5c2d-4b8e-9f01-2a3b4c5d6e7f')), {});
    assert.ok(recordChecks('gemini-cli', orphan('another-session'))['M.tool-linkage']?.length > 0);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

// The is_error check (M.is-error, sessions-model v1.3) fails on each break it exists for: a flag on
// a result that did not complete, a false beside a non-zero exit_code, and a true beside one that
// no failure flag backs. A listed failure flag is excused in its own session only.
test('matrix: the is_error check catches a flag on a cancelled or denied result, and a false or an unlisted true beside a non-zero exit_code', async () => {
  const { recordChecks, FAILURE_FLAGS } = await import('../conformance/generic.js');
  const view = (sid, parts) => ({ [sid]: new Map([['m', { type: 'message', message_id: 'm', parts: parts.map((p, i) => ({ part_id: String(i), kind: 'tool_result', call_id: `c${i}`, output: '', exit_code: null, ...p })) }]]) });
  const check = (h, sid, parts) => recordChecks(h, view(sid, parts))['M.is-error'] ?? [];
  const fine = [
    { status: 'cancelled', is_error: null }, { status: 'denied', is_error: null }, { status: 'completed', is_error: null, exit_code: 2 },
    { status: 'completed', is_error: false, exit_code: 0 }, { status: 'completed', is_error: true, exit_code: null }, { status: 'completed', is_error: true, exit_code: 0 },
  ];
  assert.deepEqual(check('claude-code', 's', fine), []);
  for (const bad of [
    { status: 'cancelled', is_error: false }, { status: 'cancelled', is_error: true }, { status: 'denied', is_error: true },
    { status: 'completed', is_error: false, exit_code: 1 }, { status: 'completed', is_error: true, exit_code: 1 },
  ]) assert.equal(check('claude-code', 's', [bad]).length, 1, JSON.stringify(bad));
  // A listed failure flag: excused in its session, not in another, and never for a cancelled result.
  assert.equal(FAILURE_FLAGS.goose['20261021_1']['call-1'], 'isError true');
  const listed = { call_id: 'call-1', status: 'completed', is_error: true, exit_code: 1 };
  assert.deepEqual(check('goose', '20261021_1', [listed]), []);
  assert.equal(check('goose', 'another-session', [listed]).length, 1);
  assert.equal(check('goose', '20261021_1', [{ ...listed, status: 'cancelled' }]).length, 1);
});
