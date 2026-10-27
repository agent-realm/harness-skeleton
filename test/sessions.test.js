// Milestone 5: hs's sessions.* operations are the §7.3 shim over @agent-realm/harness-session-adapters.
// They must give exactly what the package gives, refuse a session key of another harness store,
// and map the package's errors onto the envelope. The package's own fixture is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '@agent-realm/harness-session-adapters';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { toHsError } from '../src/sessions.js';
import { SessionsError } from '@agent-realm/harness-session-adapters';
import { tmpdir } from './fixtures.js';
import { linuxHost } from './sandbox.js';
import { ADAPTERS } from '@agent-realm/harness-session-adapters';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(repo, 'packages', 'harness-session-adapters', 'fixtures', 'claude-code', 'basic', 'store');
const HOST = 'd1073ef8de4b1a552a089f5890c636a2';

function call(op, args) {
  return handle({ protocol: PROTOCOL, op, args }, { host: linuxHost });
}
function ok(res) {
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return res.result;
}

test('sessions.list, read and derive pass the package\'s answers through unchanged', () => {
  const root = tmpdir();
  try {
    const folder = path.join(root, 'claude-data');
    fs.cpSync(FIXTURE, folder, { recursive: true });
    const store = { host: HOST, harness: 'claude-code', harness_path: folder };
    const adapter = adapterFor('claude-code');

    const listed = ok(call('sessions.list', { harness: 'claude-code', harness_path: folder }));
    assert.deepEqual(listed.store, store);
    assert.deepEqual(listed.sessions, adapter.list(store));
    assert.ok(listed.sessions.length > 0);

    const s = listed.sessions[0];
    const session = { ...store, session_id: s.session_id, incarnation: s.incarnation };
    const src = s.sources[0].source_key;
    const read = ok(call('sessions.read', { harness: 'claude-code', harness_path: folder, session, source_key: src }));
    const direct = adapter.read(store, session, src, null, null);
    assert.deepEqual({ ...read, store: undefined }, { ...direct, store: undefined });
    assert.ok(read.units.length > 0);

    const input = [{ source_key: src, generation: 1, complete: true, units: read.units, gone: [] }];
    const derived = ok(call('sessions.derive', { harness: 'claude-code', session, input, state: null }));
    assert.deepEqual(derived, adapter.derive(session, input, null));

    // the folder is untouched: readers are read-only
    const before = fs.readdirSync(folder, { recursive: true }).sort();
    call('sessions.list', { harness: 'claude-code', harness_path: folder });
    assert.deepEqual(fs.readdirSync(folder, { recursive: true }).sort(), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sessions.read refuses a session of another harness store, and maps the package\'s errors', () => {
  const root = tmpdir();
  try {
    const folder = path.join(root, 'claude-data');
    fs.cpSync(FIXTURE, folder, { recursive: true });
    const s = ok(call('sessions.list', { harness: 'claude-code', harness_path: folder })).sessions[0];
    const session = { host: HOST, harness: 'claude-code', harness_path: folder, session_id: s.session_id, incarnation: s.incarnation };
    const src = s.sources[0].source_key;

    let res = call('sessions.read', { harness: 'claude-code', harness_path: folder, session: { ...session, host: 'f'.repeat(32) }, source_key: src });
    assert.equal(res.error.code, 'session_unknown', 'another host is another session');
    res = call('sessions.read', { harness: 'claude-code', harness_path: folder, session: { ...session, session_id: '00000000-0000-0000-0000-000000000000' }, source_key: src });
    assert.equal(res.error.code, 'session_unknown', 'the package\'s own error, through the envelope');
    res = call('sessions.read', { harness: 'claude-code', harness_path: folder, session, source_key: path.join(folder, 'nope.jsonl') });
    assert.equal(res.error.code, 'source_unknown');
    assert.equal(call('sessions.read', { harness: 'claude-code', harness_path: folder, session }).error.code, 'bad_request');
    assert.equal(call('sessions.read', { harness: 'claude-code', harness_path: folder, session: { session_id: 'x' }, source_key: src }).error.code, 'bad_request');
    assert.equal(call('sessions.list', { harness: 'no-such-harness', harness_path: folder }).error.code, 'harness_unknown');
    assert.equal(call('sessions.list', { harness: 'opencode', harness_path: folder }).error.code, 'folder_missing', 'a reader the package has: its default store is not in this folder');
    assert.equal(call('sessions.list', { harness: 'claude-code', harness_path: path.join(root, 'missing') }).error.code, 'folder_missing');

    const busy = toHsError(new SessionsError('busy', 'locked'));
    assert.deepEqual([busy.code, busy.items, busy.retryable], ['busy', [], true]);
    for (const code of ['inconsistent', 'damaged']) assert.equal(toHsError(new SessionsError(code, 'x')).retryable, true, code);
    assert.equal(toHsError(new SessionsError('session_unknown', 'x')).retryable, false);
    // A review finding: derive is pure, so its damaged comes from the request's units and recurs.
    assert.equal(toHsError(new SessionsError('damaged', 'x'), { reads: false }).retryable, false);
    const bad = call('sessions.derive', { harness: 'agy', session: { host: HOST, harness: 'agy', harness_path: folder, session_id: 's', incarnation: '' },
      input: [{ source_key: 'conversations/s.db#table:steps', generation: 1, complete: true, gone: [], units: [{ unit_key: '1', enc: 'row-json', body: JSON.stringify({ idx: 1, step_payload: 'gA==' }) }] }], state: null });
    assert.deepEqual([bad.error.code, bad.error.retryable], ['damaged', false], 'pb: truncated varint, on every resend');
    // The envelope carries it on every error, false where the same request would fail again.
    const missing = call('sessions.list', { harness: 'claude-code', harness_path: path.join(root, 'missing') });
    assert.deepEqual([missing.error.code, missing.error.retryable], ['folder_missing', false]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('describe carries the package\'s sessions describe for both harnesses', () => {
  for (const harness of ['claude-code', 'codex']) {
    const d = ok(call('describe', { harness }));
    assert.deepEqual(d.sessions, adapterFor(harness).describe());
    assert.ok(d.operations.includes('sessions.read'));
  }
});

// ---- database-file stores (OpenCode; sessions-model §1) -------------------------------------

const OC = path.join(repo, 'packages', 'harness-session-adapters', 'fixtures', 'opencode');
async function opencodeFolder(root, name) {
  const { prepareStore } = await import('../packages/harness-session-adapters/conformance/sql-store.js');
  const folder = path.join(root, 'opencode-data');
  prepareStore(path.join(OC, name), folder);
  return fs.realpathSync.native(folder);
}

test('OpenCode: the binding is the data folder; each store is keyed by its database file\'s real path', async () => {
  const root = tmpdir();
  try {
    const folder = await opencodeFolder(root, 'channels');
    const alias = path.join(root, 'alias');
    fs.symlinkSync(folder, alias);
    const adapter = adapterFor('opencode');
    const byDefault = ok(call('sessions.list', { harness: 'opencode', harness_path: alias }));
    const want = { host: HOST, harness: 'opencode', harness_path: path.join(folder, 'opencode.db') };
    assert.deepEqual(byDefault.store, want, 'the default store, by its real path, never the folder');
    assert.deepEqual(byDefault.sessions, adapter.list(want));
    assert.ok(byDefault.sessions.length > 0);

    const beta = ok(call('sessions.list', { harness: 'opencode', harness_path: alias, store: 'opencode-beta.db' }));
    assert.equal(beta.store.harness_path, path.join(folder, 'opencode-beta.db'));
    const custom = ok(call('sessions.list', { harness: 'opencode', harness_path: alias, store: path.join(alias, 'custom-oc.db') }));
    assert.equal(custom.store.harness_path, path.join(folder, 'custom-oc.db'), 'an absolute store, resolved');

    // A read through the shim gives what the package gives, for the store's session.
    const s = byDefault.sessions[0];
    const session = { ...want, session_id: s.session_id, incarnation: s.incarnation };
    const src = s.sources[0].source_key;
    const read = ok(call('sessions.read', { harness: 'opencode', harness_path: alias, session, source_key: src }));
    assert.deepEqual({ ...read, store: undefined }, { ...adapter.read(want, session, src, null, null), store: undefined });
    // The same session asked of another store is another session.
    assert.equal(call('sessions.read', { harness: 'opencode', harness_path: alias, store: 'opencode-beta.db', session, source_key: src }).error.code, 'session_unknown');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode stores: the binding stays a folder, and a store must be a database file', async () => {
  const root = tmpdir();
  try {
    const folder = await opencodeFolder(root, 'basic');
    const db = path.join(folder, 'opencode.db');
    const code = (args) => call('sessions.list', { harness: 'opencode', ...args }).error?.code;
    assert.equal(code({ harness_path: db }), 'bad_request', 'the binding is the data folder, never a file');
    for (const store of ['../opencode.db', 'sub/opencode.db', '', '.', '..']) assert.equal(code({ harness_path: folder, store }), 'bad_request', store);
    assert.equal(code({ harness_path: folder, store: 'opencode-missing.db' }), 'folder_missing');
    fs.mkdirSync(path.join(folder, 'dir.db'));
    assert.equal(code({ harness_path: folder, store: 'dir.db' }), 'bad_request');
    // A harness that keeps its sessions in the folder takes no store.
    const cc = path.join(root, 'claude-data');
    fs.cpSync(FIXTURE, cc, { recursive: true });
    assert.equal(call('sessions.list', { harness: 'claude-code', harness_path: cc, store: 'x.db' }).error.code, 'bad_request');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode stores, review round: the layout is descriptor data; a relative name stays in the folder; only an absent store is the default', async () => {
  const root = tmpdir();
  try {
    const folder = await opencodeFolder(root, 'channels');
    // The layout is the package's store_shape (sessions v1 §2), not hs's own.
    const shape = ADAPTERS.opencode.describe().store_shape;
    assert.equal(shape.kind, 'file');
    assert.equal(shape.default, 'opencode.db');
    assert.equal(ok(call('sessions.list', { harness: 'opencode', harness_path: folder })).store.harness_path, path.join(folder, shape.default));
    const code = (args) => call('sessions.list', { harness: 'opencode', harness_path: folder, ...args }).error?.code;

    // A relative name that a link carries out of the folder is refused; the absolute route stays.
    const outside = path.join(root, 'outside.db');
    fs.copyFileSync(path.join(folder, 'opencode-beta.db'), outside);
    fs.symlinkSync(outside, path.join(folder, 'alias.db'));
    const escaped = call('sessions.list', { harness: 'opencode', harness_path: folder, store: 'alias.db' });
    assert.equal(escaped.error.code, 'bad_request');
    assert.match(escaped.error.message, /resolves outside the data folder/);
    assert.equal(ok(call('sessions.list', { harness: 'opencode', harness_path: folder, store: outside })).store.harness_path, fs.realpathSync.native(outside));
    // A link that stays inside resolves to its target.
    fs.symlinkSync('opencode-beta.db', path.join(folder, 'beta-link.db'));
    assert.equal(ok(call('sessions.list', { harness: 'opencode', harness_path: folder, store: 'beta-link.db' })).store.harness_path, path.join(folder, 'opencode-beta.db'));
    // A name that only starts with two dots is a name, not a parent.
    fs.copyFileSync(path.join(folder, 'opencode-beta.db'), path.join(folder, '..dots.db'));
    assert.equal(ok(call('sessions.list', { harness: 'opencode', harness_path: folder, store: '..dots.db' })).store.harness_path, path.join(folder, '..dots.db'));

    // Only an absent store is the default: null is a bad selection, for every harness.
    assert.equal(code({ store: null }), 'bad_request');
    const cc = path.join(root, 'claude-data');
    fs.cpSync(FIXTURE, cc, { recursive: true });
    assert.equal(call('sessions.list', { harness: 'claude-code', harness_path: cc, store: null }).error.code, 'bad_request');

    // A missing store says it is a store.
    const missing = call('sessions.list', { harness: 'opencode', harness_path: folder, store: 'opencode-gone.db' });
    assert.equal(missing.error.code, 'folder_missing');
    assert.match(missing.error.message, /no opencode store at/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
