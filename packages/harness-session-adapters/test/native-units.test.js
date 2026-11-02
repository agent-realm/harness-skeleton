// sessions-model v1.4's two optional record fields (§2.7): `native`, the native fields an adapter
// declares, and `units`, the raw units a record was derived from. seal() keeps `units` out of
// `content_sha` and puts the triples in order; validateSession reads a record with either field as
// it reads one without, and holds each field to its shape; the generic checks behind
// M.native-declared and M.units-input each fail on the break they exist for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../src/index.js';
import { seal, nativeOf, normaliseUnits, compareCodePoints } from '../src/records.js';
import { validateSession } from '../src/validate.js';
import { genericChecks } from '../conformance/generic.js';
import { tmpStore, copyTree } from '../conformance/runner.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const KEY = { host: '0d0d3eefb2fba3434590abdc952a7ef7', harness: 'codex', harness_path: '/home/user/.codex', session_id: 's1', incarnation: '' };

// One valid session: a session record and one message, sealed.
function session(extra = {}) {
  const msg = seal({
    type: 'message', ...KEY, message_id: 'm1', parent_id: null, order: '1', agent_id: '', role: 'user', source: 'user',
    to_user: null, to_model: null, status: 'complete', state: 'current', on_active_branch: null, ts: null,
    requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
    parts: [{ part_id: '0', kind: 'text', text: 'hello', ...(extra.part ?? {}) }], ...(extra.message ?? {}),
  });
  const sess = seal({
    type: 'session', ...KEY, engine: null, client: 'codex', harness_version: null, title: null, title_set_by: null,
    cwd: null, last_cwd: null, created_at: null, updated_at: null, state: 'active', pinned: null, mode: null, kind: null,
    reuse: 'impossible', ts_source: 'none', aliases: [], fingerprint: { cmp_shas: [msg.cmp_sha] }, ...(extra.session ?? {}),
  });
  return [sess, msg];
}

test('native and units: seal keeps units out of content_sha, sorted with no triple twice', () => {
  const [, plain] = session();
  const [, withUnits] = session({ message: { units: [['b.jsonl', 1, '20'], ['a.jsonl', 2, '0'], ['a.jsonl', 1, '9'], ['a.jsonl', 1, '9']] } });
  assert.equal(withUnits.content_sha, plain.content_sha, 'units do not move content_sha');
  assert.equal(withUnits.cmp_sha, plain.cmp_sha);
  assert.deepEqual(withUnits.units, [['a.jsonl', 1, '9'], ['a.jsonl', 2, '0'], ['b.jsonl', 1, '20']]);
  // A malformed triple is an adapter bug: seal() throws rather than drop or coerce it.
  for (const bad of [[['x', '3', '7']], [['x', 3, 7]], [['x', 3]], [['', 1, '0']], [['x', -1, '0']], [['x', 1.5, '0']], 'x']) {
    assert.throws(() => normaliseUnits(bad), TypeError, JSON.stringify(bad));
    assert.throws(() => session({ message: { units: bad } }), TypeError, JSON.stringify(bad));
  }
  // native is part of the record: it moves content_sha, and stays out of cmp_sha.
  const [, withNative] = session({ message: { native: { gitBranch: 'main' } } });
  assert.notEqual(withNative.content_sha, plain.content_sha);
  assert.equal(withNative.cmp_sha, plain.cmp_sha);
});

// sessions-model v1.4.2: the strings of a triple sort in code-point order, the byte order of their
// UTF-8, where `<` compares UTF-16 code units. U+FF61 is below U+1F600 as a code point, and above
// its lead surrogate U+D83D as a code unit.
test('native and units: units strings sort in code-point order, as their UTF-8 bytes do', () => {
  const bmp = 'chats/\uff61.jsonl';
  const astral = 'chats/\u{1f600}.jsonl';
  assert.ok(astral < bmp, 'the pair sorts the other way by UTF-16 code units');
  assert.deepEqual(normaliseUnits([[astral, 1, '0'], [bmp, 1, '0']]), [[bmp, 1, '0'], [astral, 1, '0']]);
  assert.deepEqual(normaliseUnits([['s', 1, '\u{1f600}'], ['s', 1, '\uff61']]), [['s', 1, '\uff61'], ['s', 1, '\u{1f600}']]);
  // generation compares as a number: 10 after 9.
  assert.deepEqual(normaliseUnits([['s', 10, '0'], ['s', 9, '0']]), [['s', 9, '0'], ['s', 10, '0']]);
  const sign = (n) => Math.sign(n);
  const words = ['', 'a', 'ab', 'z', '\u00e9', '\u07ff', '\u0800', '\ud7ff', '\ue000', '\uff61', '\uffff', '\u{10000}', '\u{1f600}', '\u{10ffff}', 'a\u{1f600}', 'a\uffff'];
  for (const a of words) {
    for (const b of words) {
      assert.equal(sign(compareCodePoints(a, b)), sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  }
  // The validator holds a record to the same order.
  const [s, m] = session();
  const problems = (units) => validateSession([s, { ...m, units }]).filter((f) => !f.warning).map((f) => f.problem);
  assert.deepEqual(problems([[bmp, 1, '0'], [astral, 1, '0']]), []);
  assert.ok(problems([[astral, 1, '0'], [bmp, 1, '0']]).some((p) => p.startsWith('units is not sorted')));
});

test('native and units: nativeOf carries the declared paths a record holds, and nothing else', () => {
  const rec = { gitBranch: 'main', env: { TOKEN: 'x' }, turn: { sandbox_policy: { mode: 'read-only', writable_roots: ['/home/user/p'] }, cwd: '/home/user/p' }, n: null, list: [{ a: 1 }], ok: true, k: 3 };
  assert.deepEqual(nativeOf(rec, ['gitBranch', 'turn.sandbox_policy.mode', 'n', 'ok', 'k', 'missing', 'list.0.a']), {
    gitBranch: 'main', 'turn.sandbox_policy.mode': 'read-only', n: null, ok: true, k: 3,
  });
  // Leaf values only: a declared object or list is dropped, so its subtree (writable_roots, paths)
  // never rides along on an allowlisted path.
  assert.deepEqual(nativeOf(rec, ['turn.sandbox_policy', 'env', 'list', 'turn']), {});
  assert.deepEqual(nativeOf(rec, []), {}, 'no declared path: an empty object');
  assert.deepEqual(nativeOf(rec, undefined), {});
  assert.ok(!('env' in nativeOf(rec, ['gitBranch'])), 'an undeclared field is dropped');
});

test('native and units: a v1.3 reader validates records with both fields as it does records without', () => {
  assert.deepEqual(validateSession(session()), []);
  const both = session({
    session: { native: { originator: 'cli' }, units: [['rollout.jsonl', 1, '0']] },
    message: { native: { gitBranch: 'main' }, units: [['rollout.jsonl', 1, '120']] },
    part: { native: { 'content.type': 'input_text' } },
  });
  // A reader that knows nothing of the adapter's declarations: shape only.
  assert.deepEqual(validateSession(both), []);
  assert.deepEqual(validateSession(both, { harness: 'codex', sessionId: 's1' }), []);
  // A reader that holds them to the adapter's declared paths.
  const declared = { session: ['originator'], message: ['gitBranch'], part: ['content.type'] };
  assert.deepEqual(validateSession(both, { native: declared }), []);
});

test('native and units: validateSession finds malformed units and undeclared or misplaced native', () => {
  const problems = (records, expect) => validateSession(records, expect).filter((f) => !f.warning).map((f) => f.problem);
  // units: not sorted, a triple twice, not a triple, a negative generation.
  for (const units of [[['b', 1, '0'], ['a', 1, '0']], [['a', 1, '0'], ['a', 1, '0']], [['a', 1]], [['a', -1, '0']], 'a']) {
    const [s, m] = session();
    assert.ok(problems([s, { ...m, units }]).some((p) => p.startsWith('units')), JSON.stringify(units));
  }
  // native: not an object, a value that is not a leaf, on a usage record, a path not declared, a
  // type that declares none.
  const [s, m] = session();
  assert.ok(problems([s, { ...m, native: ['x'] }]).some((p) => p.startsWith('native')));
  assert.ok(problems([s, { ...m, native: { 'turn.sandbox_policy': { writable_roots: ['/home/user/p'] } } }]).some((p) => p.includes('not a leaf value')));
  assert.ok(problems([s, { ...m, native: { tags: ['a'] } }]).some((p) => p.includes('not a leaf value')));
  const usage = seal({ type: 'usage', ...KEY, usage_id: 'u1', granularity: 'per_response', anchor: { response_id: 'r1' }, input: 1, output: 1, cache_read: null, cache_write: null, reasoning: null, cost: null, native: {} });
  assert.ok(problems([s, m, usage]).some((p) => p.startsWith('native on a usage record')));
  const declared = { session: [], message: ['gitBranch'], part: [] };
  assert.ok(problems([s, { ...m, native: { gitBranch: 'main', env: {} } }], { native: declared }).some((p) => p.includes('"env"')));
  assert.ok(problems([{ ...s, native: {} }, m], { native: declared }).some((p) => p.includes('declares no paths')));
  assert.ok(problems([s, { ...m, parts: [{ ...m.parts[0], native: { x: 1 } }] }], { native: declared }).some((p) => p.includes('declares no paths')));
});

// The generic checks fail on the break they exist for: a native key the adapter does not declare,
// and a units triple that names no unit of the input. Correct triples pass.
test('native and units: the generic checks catch an undeclared native path and a triple naming no unit of the input', () => {
  const store = tmpStore('native-units-');
  try {
    copyTree(path.join(FIXTURES, 'claude-code', 'basic', 'store'), store);
    const a = ADAPTERS['claude-code'];
    assert.deepEqual(genericChecks(a, store), {}, 'the adapter as shipped');
    const withRecords = (fn) => ({ ...a, derive: (session, input, state) => {
      const r = a.derive(session, input, state);
      return { ...r, changed: r.changed.map((rec) => seal(fn(rec, input))) };
    } });
    // Every record names the first unit of the first source of its derive input: a real unit.
    const real = withRecords((rec, input) => {
      const src = input.find((s) => (s.units ?? []).length);
      return src ? { ...rec, units: [[src.source_key, src.generation, src.units[0].unit_key]] } : rec;
    });
    const ok = genericChecks(real, store);
    assert.equal(ok['M.units-input'], undefined, JSON.stringify(ok['M.units-input']));
    // A unit key no read returned, and a generation the input never had.
    const bogus = withRecords((rec, input) => ({ ...rec, units: [[input[0].source_key, input[0].generation, 'no-such-unit']] }));
    assert.ok(genericChecks(bogus, store)['M.units-input']?.length > 0);
    const staleGen = withRecords((rec, input) => ({ ...rec, units: [[input[0].source_key, input[0].generation + 5, (input[0].units ?? [])[0]?.unit_key ?? '0']] }));
    assert.ok(genericChecks(staleGen, store)['M.units-input']?.length > 0);
    // A native value that is not a leaf fails it even where the path is declared.
    const subtree = withRecords((rec) => (rec.type === 'message' ? { ...rec, native: { gitBranch: { name: 'main' } } } : rec));
    const declaresSubtree = { ...subtree, describe: () => ({ ...a.describe(), native: { session: [], message: ['gitBranch'], part: [] } }) };
    assert.ok(genericChecks(declaresSubtree, store)['M.native-declared']?.some((f) => f.includes('not a leaf value')));
    // A native object on a message, where claude-code declares no native paths.
    const undeclared = withRecords((rec) => (rec.type === 'message' ? { ...rec, native: { gitBranch: 'main' } } : rec));
    assert.ok(genericChecks(undeclared, store)['M.native-declared']?.length > 0);
    // Declared, it passes.
    const declares = { ...undeclared, describe: () => ({ ...a.describe(), native: { session: [], message: ['gitBranch'], part: [] } }) };
    assert.equal(genericChecks(declares, store)['M.native-declared'], undefined);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});
