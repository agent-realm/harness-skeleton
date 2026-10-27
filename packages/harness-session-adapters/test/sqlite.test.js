import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadOnly, withRead, readDelta, readRowsSnapshot, hasTable, textOf } from '../src/sqlite.js';
import { tmpStore } from '../conformance/runner.js';
import { buildDb } from '../conformance/sql-store.js';

function walStore(dir) {
  const db = { rel: 'data/s.db', schema: 'PRAGMA journal_mode=WAL; CREATE TABLE m (id TEXT PRIMARY KEY, body TEXT, b BLOB);', ops: [
    { sql: 'INSERT INTO m VALUES (?, ?, ?)', params: ['a', 'one', { $b64: Buffer.from('xy').toString('base64') }] },
    { sql: 'INSERT INTO m VALUES (?, ?, ?)', params: ['b', 'two', null] },
  ] };
  buildDb(dir, db);
  return db;
}

test('sqlite: a WAL store with no -wal opens immutable and creates nothing beside it', () => {
  const dir = tmpStore();
  try {
    walStore(dir);
    const before = fs.readdirSync(path.join(dir, 'data')).sort();
    const db = openReadOnly(dir, 'data/s.db');
    assert.equal(withRead(db, 'data/s.db', (d) => d.prepare('SELECT count(*) AS n FROM m').get().n), 2);
    assert.equal(hasTable(db, 'm'), true);
    assert.equal(hasTable(db, 'nope'), false);
    db.close();
    assert.deepEqual(fs.readdirSync(path.join(dir, 'data')).sort(), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite: a WAL-only committed row is read while a writer holds the -wal', () => {
  const dir = tmpStore();
  try {
    walStore(dir);
    const w = new DatabaseSync(path.join(dir, 'data/s.db'));
    w.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO m VALUES ('c', 'three', NULL)");
    assert.ok(fs.existsSync(path.join(dir, 'data/s.db-wal')));
    const db = openReadOnly(dir, 'data/s.db');
    const ids = withRead(db, 'data/s.db', (d) => d.prepare('SELECT id FROM m ORDER BY id').all().map((r) => r.id));
    db.close();
    w.close();
    assert.deepEqual(ids, ['a', 'b', 'c']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite: a symlinked database is refused; a damaged one is `damaged`', () => {
  const dir = tmpStore();
  try {
    walStore(dir);
    fs.symlinkSync(path.join(dir, 'data/s.db'), path.join(dir, 'data/link.db'));
    assert.throws(() => openReadOnly(dir, 'data/link.db'), { code: 'source_unknown' });
    fs.writeFileSync(path.join(dir, 'data/bad.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(200, 7)]));
    assert.throws(() => {
      const db = openReadOnly(dir, 'data/bad.db');
      withRead(db, 'data/bad.db', (d) => d.prepare('SELECT * FROM sqlite_master').all());
    }, (e) => e.code === 'damaged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite: readDelta diffs against known; gone lists vanished keys; blobs are base64', () => {
  const rows = [{ unit_key: 'm:a', row: { id: 'a', body: 'one', b: new Uint8Array([120, 121]) } }, { unit_key: 'm:b', row: { id: 'b', body: 'two', b: null } }];
  const r1 = readDelta('table:m', rows, null, null);
  assert.equal(r1.continuity, 'reset');
  assert.equal(r1.units.length, 2);
  assert.equal(r1.units[0].enc, 'row-json');
  assert.deepEqual(JSON.parse(r1.units[0].body), { b: 'eHk=', body: 'one', id: 'a' });
  const known = Object.fromEntries(r1.units.map((u) => [u.unit_key, u.sha256]));
  assert.equal(readDelta('table:m', rows, r1.position, known).continuity, 'unchanged');
  const r3 = readDelta('table:m', [{ unit_key: 'm:a', row: { id: 'a', body: 'ONE', b: null } }], r1.position, known);
  assert.equal(r3.continuity, 'delta');
  assert.deepEqual(r3.units.map((u) => u.unit_key), ['m:a']);
  assert.deepEqual(r3.gone, ['m:b']);
});

test('sqlite: a rows snapshot is one rows-json unit, unchanged on the same sha', () => {
  const r1 = readRowsSnapshot('table:t', { t: [{ id: 1 }], u: [{ id: 2 }] }, null);
  assert.equal(r1.continuity, 'reset');
  assert.equal(r1.units[0].enc, 'rows-json');
  assert.equal(readRowsSnapshot('table:t', { t: [{ id: 1 }], u: [{ id: 2 }] }, r1.position).continuity, 'unchanged');
  assert.equal(readRowsSnapshot('table:t', { t: [{ id: 1 }] }, r1.position).continuity, 'snapshot');
  assert.equal(textOf(new Uint8Array([104, 105])), 'hi');
});

test('sqlite: a WAL store with a -wal but no -shm is `busy`: nothing created beside it, and no copy is made', () => {
  const dir = tmpStore();
  const live = tmpStore('sa-live-');
  try {
    // A live writer's database and WAL, copied without the -shm (a crash, a copied store).
    walStore(live);
    const w = new DatabaseSync(path.join(live, 'data/s.db'));
    w.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO m VALUES ('c', 'wal-only', NULL)");
    fs.mkdirSync(path.join(dir, 'data'));
    fs.copyFileSync(path.join(live, 'data/s.db'), path.join(dir, 'data/s.db'));
    fs.copyFileSync(path.join(live, 'data/s.db-wal'), path.join(dir, 'data/s.db-wal'));
    w.close();
    const before = fs.readdirSync(path.join(dir, 'data')).sort();
    assert.deepEqual(before, ['s.db', 's.db-wal']);
    assert.throws(() => openReadOnly(dir, 'data/s.db'), { code: 'busy' });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'data')).sort(), before, 'no -shm and nothing else created');
    // Once the harness opens it again (its -shm is back), the WAL-only row reads.
    const h = new DatabaseSync(path.join(dir, 'data/s.db'));
    h.prepare('SELECT 1').get();
    const db = openReadOnly(dir, 'data/s.db');
    const ids = withRead(db, 'data/s.db', (d) => d.prepare('SELECT id FROM m ORDER BY id').all().map((r) => r.id));
    db.close();
    h.close();
    assert.deepEqual(ids, ['a', 'b', 'c']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  }
});
