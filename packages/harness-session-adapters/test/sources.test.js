import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStream, readSnapshot } from '../src/sources.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-src-'));
}

test('stream: a first read is reset with every complete line; offsets are unit keys', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, '{"a":1}\n\n{"b":2}\n');
    const r = readStream(f, 's.jsonl', null);
    assert.equal(r.continuity, 'reset');
    assert.deepEqual(r.units.map((u) => [u.unit_key, u.body]), [['0', '{"a":1}'], ['9', '{"b":2}']]);
    assert.equal(r.position.offset, 17);
    assert.deepEqual(r.held_back, []);
    assert.equal(r.units[0].enc, 'utf8');
    assert.equal(r.units[0].bytes, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stream: an append gives exactly the new lines; nothing new gives unchanged', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, 'one\n');
    const r1 = readStream(f, 's', null);
    fs.appendFileSync(f, 'two\nthree\n');
    const r2 = readStream(f, 's', r1.position);
    assert.equal(r2.continuity, 'appended');
    assert.deepEqual(r2.units.map((u) => [u.unit_key, u.body]), [['4', 'two'], ['8', 'three']]);
    const r3 = readStream(f, 's', r2.position);
    assert.equal(r3.continuity, 'unchanged');
    assert.deepEqual(r3.units, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stream: a partial last line is held back, then returned whole', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, 'one\n{"half":');
    const r1 = readStream(f, 's', null);
    assert.deepEqual(r1.units.map((u) => u.body), ['one']);
    assert.deepEqual(r1.held_back, [{ unit_key: '4', bytes: 8 }]);
    fs.appendFileSync(f, '1}\n');
    const r2 = readStream(f, 's', r1.position);
    assert.equal(r2.continuity, 'appended');
    assert.deepEqual(r2.units.map((u) => [u.unit_key, u.body]), [['4', '{"half":1}']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stream: a new inode, a shrink, a changed line 1 or a same-size tail rewrite is a reset', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, 'one\ntwo\nthree\n');
    const base = readStream(f, 's', null).position;

    // Temp-and-rename: new inode, shorter (a Copilot rewind).
    const t = path.join(dir, 't');
    fs.writeFileSync(t, 'one\n');
    fs.renameSync(t, f);
    const shrunk = readStream(f, 's', base);
    assert.equal(shrunk.continuity, 'reset');
    assert.deepEqual(shrunk.units.map((u) => u.body), ['one']);

    // Same inode, line 1 rewritten in place to the same length (droid).
    fs.writeFileSync(f, 'one\ntwo\n');
    const p1 = readStream(f, 's', null).position;
    const fd = fs.openSync(f, 'r+');
    fs.writeSync(fd, 'ONE', 0);
    fs.closeSync(fd);
    assert.equal(readStream(f, 's', p1).continuity, 'reset');

    // Same inode, same size, the tail rewritten.
    const p2 = readStream(f, 's', null).position;
    const fd2 = fs.openSync(f, 'r+');
    fs.writeSync(fd2, 'TWO', 4);
    fs.closeSync(fd2);
    assert.equal(readStream(f, 's', p2).continuity, 'reset');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stream: invalid UTF-8 is carried as b64; a CRLF line loses its CR', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe, 0x41, 0x0a]), Buffer.from('x\r\n')]));
    const r = readStream(f, 's', null);
    assert.equal(r.units[0].enc, 'b64');
    assert.equal(Buffer.from(r.units[0].body, 'base64').toString('hex'), 'fffe41');
    assert.equal(r.units[1].body, 'x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stream and snapshot: a missing source is source_unknown', () => {
  assert.throws(() => readStream('/nonexistent-sa/s.jsonl', 's', null), { code: 'source_unknown' });
  assert.throws(() => readSnapshot('/nonexistent-sa/m.json', 'm', null), { code: 'source_unknown' });
});

test('snapshot: reset first, unchanged on the same sha, snapshot when it changes', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 'm.json');
    fs.writeFileSync(f, '{"v":1}');
    const r1 = readSnapshot(f, 'm.json', null);
    assert.equal(r1.continuity, 'reset');
    assert.equal(r1.units[0].unit_key, 'm.json');
    assert.equal(readSnapshot(f, 'm.json', r1.position).continuity, 'unchanged');
    fs.writeFileSync(f, '{"v":2}');
    const r3 = readSnapshot(f, 'm.json', r1.position);
    assert.equal(r3.continuity, 'snapshot');
    assert.equal(r3.units[0].body, '{"v":2}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stream: redaction applies per line and marks the unit', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, '{"k":"secret-value"}\n');
    const redact = (buf) => ({ buf: Buffer.from('{"k":"<redacted len=12>"}'), redacted: true });
    const r = readStream(f, 's', null, { redact });
    assert.equal(r.units[0].redacted, true);
    assert.equal(r.units[0].body, '{"k":"<redacted len=12>"}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stream: one read returns at most maxBytes, cut at a line boundary, then says more', () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, 'aaaa\nbbbb\ncccccccccccccccccccc\ndd\n' + 'e'.repeat(40) + '\n');
    const r1 = readStream(f, 's', null, { maxBytes: 12 });
    assert.equal(r1.continuity, 'reset');
    assert.deepEqual(r1.units.map((u) => u.body), ['aaaa', 'bbbb']);
    assert.equal(r1.more, true);
    assert.deepEqual(r1.held_back, []);
    // A line longer than the cap is read whole; the read then stops at the last newline it has.
    const r2 = readStream(f, 's', r1.position, { maxBytes: 12 });
    assert.equal(r2.continuity, 'appended');
    assert.deepEqual(r2.units.map((u) => u.body), ['cccccccccccccccccccc', 'dd']);
    assert.equal(r2.more, true);
    const r3 = readStream(f, 's', r2.position, { maxBytes: 12 });
    assert.deepEqual(r3.units.map((u) => u.body), ['e'.repeat(40)]);
    assert.equal(r3.more, false);
    assert.equal(readStream(f, 's', r3.position, { maxBytes: 12 }).continuity, 'unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stream and snapshot: a symlink is refused, as a file or anywhere below the root', () => {
  const dir = tmpdir();
  try {
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.jsonl'), '{"x":1}\n');
    const root = path.join(dir, 'store');
    fs.mkdirSync(path.join(root, 'p'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'secret.jsonl'), path.join(root, 'p', 'link.jsonl'));
    fs.symlinkSync(outside, path.join(root, 'd'));
    assert.throws(() => readStream(path.join(root, 'p', 'link.jsonl'), 'p/link.jsonl', null, { root }), { code: 'source_unknown', message: /symlink/ });
    assert.throws(() => readStream(path.join(root, 'd', 'secret.jsonl'), 'd/secret.jsonl', null, { root }), { code: 'source_unknown', message: /symlink/ });
    assert.throws(() => readSnapshot(path.join(root, 'p', 'link.jsonl'), 'p/link.jsonl', null, { root }), { code: 'source_unknown' });
    // Without a root, O_NOFOLLOW still refuses the final symlink.
    assert.throws(() => readStream(path.join(root, 'p', 'link.jsonl'), 'p/link.jsonl', null), { code: 'source_unknown' });
    // A directory is not a source.
    assert.throws(() => readStream(path.join(root, 'p'), 'p', null, { root }), { code: 'source_unknown' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stream: a UTF-8 BOM stays in the body, so the body re-encodes to its bytes and sha256', async () => {
  const dir = tmpdir();
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"type":"user"}\n')]));
    const [u] = readStream(f, 's', null).units;
    const { sha256 } = await import('../src/jcs.js');
    const { jsonOf } = await import('../src/sources.js');
    assert.equal(Buffer.byteLength(u.body, 'utf8'), u.bytes);
    assert.equal(sha256(Buffer.from(u.body, 'utf8')), u.sha256);
    assert.deepEqual(jsonOf(u), { type: 'user' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
