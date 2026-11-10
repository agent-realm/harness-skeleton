// `read`'s options: `maxReadBytes` caps one read of a stream file (src/sources.js readCap). Held
// through every adapter that reads a stream file, on fixture streams grown to 10 MiB, and on
// synthetic Claude Code stores for the default, the floor, a value that is not a positive integer
// and a line longer than the cap. Snapshot and database sources ignore it. Every byte is generated
// in a temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ADAPTERS, adapterFor } from '../src/index.js';
import { MAX_READ_BYTES, MIN_READ_BYTES, readCap } from '../src/sources.js';
import { DB_REL } from '../src/harnesses/goose/index.js';
import { storeOf, tmpStore } from '../conformance/runner.js';
import { prepareStore, caseHarnessPath } from '../conformance/sql-store.js';

const MiB = 1024 * 1024;
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const LINE = 1001; // does not divide a MiB, so a cap lands inside a line
// The harnesses whose `read` opens a stream file (`position_kind: byte_offset`).
const STREAM_HARNESSES = ['agy', 'claude-code', 'codex', 'copilot-cli', 'gemini-cli', 'vscode'];
// Values that are not a positive integer: each gives the default.
const NOT_POSITIVE_INTEGERS = [undefined, null, 0, -1, -4 * MiB, 1.5, 4 * MiB + 0.5, NaN, Infinity, -Infinity, '4194304', true, {}, []];

const casesOf = (h) => fs.readdirSync(path.join(FIX, h), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const sessionKey = (store, s) => ({ ...store, session_id: s.session_id, incarnation: s.incarnation ?? '' });
const isByteStream = (src) => src.mode === 'stream' && src.position_kind === 'byte_offset';

// One JSON line of exactly `len` bytes, its newline included.
function filler(len) {
  const head = '{"type":"toy.pad","pad":"';
  const tail = '"}\n';
  return head + 'z'.repeat(len - head.length - tail.length) + tail;
}

// Grow `file` to exactly `total` bytes with LINE-byte lines; the last line takes the rest.
function padTo(file, total) {
  if (!fs.readFileSync(file).subarray(-1).equals(Buffer.from('\n'))) fs.appendFileSync(file, '\n');
  const rest = total - fs.statSync(file).size;
  const n = Math.floor(rest / LINE) - 1;
  fs.appendFileSync(file, filler(LINE).repeat(n) + filler(rest - n * LINE));
  assert.equal(fs.statSync(file).size, total);
}

// Every read of a source from scratch, each from the position the last returned, until `more`
// is no longer true.
function readAll(adapter, store, key, sk, options) {
  const reads = [];
  let from = null;
  do {
    const r = options === undefined ? adapter.read(store, key, sk, from, null) : adapter.read(store, key, sk, from, null, options);
    reads.push(r);
    from = r.position;
  } while (reads.at(-1).more && reads.length < 1000);
  return reads;
}

// Each read ends just past a newline, returns at most `cap` bytes (when no line is longer), and
// says `more` on every read but the last.
function checkBoundaries(reads, bytes, cap) {
  let prev = 0;
  reads.forEach((r, i) => {
    const end = r.position.offset;
    assert.equal(bytes[end - 1], 0x0a, `read ${i + 1} ends at a line boundary`);
    if (cap) assert.ok(end - prev <= cap, `read ${i + 1} returns ${end - prev} bytes, at most ${cap}`);
    assert.equal(r.more, i < reads.length - 1, `read ${i + 1} says more only while bytes remain`);
    prev = end;
  });
  assert.equal(prev, bytes.length, 'the reads cover the source');
}

// A fixture case built in a temp directory, as the golden tests build it.
function withCase(h, c, fn) {
  const dir = tmpStore('sa-rs-');
  try {
    const caseDir = path.join(FIX, h, c);
    prepareStore(caseDir, dir);
    const adapter = ADAPTERS[h];
    return fn({ adapter, dir, store: storeOf(adapter, caseHarnessPath(caseDir, dir)) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The first fixture case of a harness with a stream file, and its first one.
function firstStream(h) {
  for (const c of casesOf(h)) {
    const hit = withCase(h, c, ({ adapter, store }) => {
      for (const s of adapter.list(store)) {
        const src = s.sources.find(isByteStream);
        if (src) return { session_id: s.session_id, source_key: src.source_key };
      }
      return null;
    });
    if (hit) return { case: c, ...hit };
  }
  return null;
}

// A synthetic Claude Code store with one session whose main file holds `content`.
const TOY_SID = 'a0a0a0a0-0000-4000-8000-0000000000aa';
const TOY_KEY = `projects/-home-user-toy/${TOY_SID}.jsonl`;
function withToyStream(content, fn) {
  const dir = tmpStore('sa-rs-');
  try {
    const file = path.join(dir, TOY_KEY);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const adapter = adapterFor('claude-code');
    const store = storeOf(adapter, dir);
    return fn({ adapter, store, key: sessionKey(store, { session_id: TOY_SID }), file });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// `total` bytes of LINE-byte lines, the last line taking the rest.
const toyLines = (total) => {
  const n = Math.floor(total / LINE) - 1;
  return filler(LINE).repeat(n) + filler(total - n * LINE);
};

// ---- the normalisation --------------------------------------------------------------------------

test('readCap: the default is 64 MiB, the floor 1 MiB, and a value at or above the floor stands', () => {
  assert.equal(MAX_READ_BYTES, 64 * MiB);
  assert.equal(MIN_READ_BYTES, MiB);
  assert.equal(readCap(), MAX_READ_BYTES);
  for (const v of [1, 1000, MIN_READ_BYTES - 1]) assert.equal(readCap(v), MIN_READ_BYTES, `${v} is raised to the floor`);
  for (const v of [MIN_READ_BYTES, MIN_READ_BYTES + 1, 4 * MiB, MAX_READ_BYTES, 256 * MiB]) assert.equal(readCap(v), v);
});

test('readCap: a value that is not a positive integer gives the default', () => {
  for (const v of NOT_POSITIVE_INTEGERS) assert.equal(readCap(v), MAX_READ_BYTES, `${typeof v} ${String(v)}`);
});

// ---- every adapter that reads a stream file -----------------------------------------------------

test('the fixtures give every stream-reading adapter a stream file to grow', () => {
  const found = Object.keys(ADAPTERS).filter((h) => firstStream(h)).sort();
  assert.deepEqual(found, STREAM_HARNESSES);
});

for (const h of STREAM_HARNESSES) {
  test(`${h}: a 10 MiB stream read with maxReadBytes 4 MiB arrives in 3 reads, at line boundaries, with one read's units`, () => {
    const pick = firstStream(h);
    withCase(h, pick.case, ({ adapter, store }) => {
      const file = path.join(store.harness_path, pick.source_key);
      padTo(file, 10 * MiB);
      const key = sessionKey(store, adapter.list(store).find((s) => s.session_id === pick.session_id));
      const one = readAll(adapter, store, key, pick.source_key);
      assert.equal(one.length, 1, 'the default reads 10 MiB at once');
      const capped = readAll(adapter, store, key, pick.source_key, { maxReadBytes: 4 * MiB });
      assert.equal(capped.length, Math.ceil(10 / 4));
      checkBoundaries(capped, fs.readFileSync(file), 4 * MiB);
      assert.deepEqual(capped.map((r) => r.continuity), ['reset', 'appended', 'appended']);
      assert.deepEqual(capped.flatMap((r) => r.units), one[0].units);
      assert.deepEqual(capped.at(-1).position, one[0].position);
      assert.deepEqual(capped.at(-1).held_back, one[0].held_back);
    });
  });
}

test('codex: a rollout found by the full scan (no session id in its name) takes maxReadBytes too', () => {
  withCase('codex', 'basic', ({ adapter, store }) => {
    const [s] = adapter.list(store);
    const named = path.join(store.harness_path, s.sources[0].source_key);
    const sk = 'sessions/2026/01/03/rollout-2026-01-03T14-00-00.jsonl';
    fs.renameSync(named, path.join(store.harness_path, sk));
    const listed = adapter.list(store).find((x) => x.session_id === s.session_id);
    assert.deepEqual(listed.sources.map((x) => x.source_key), [sk], 'the session id now comes from line 1');
    padTo(path.join(store.harness_path, sk), 10 * MiB);
    const key = sessionKey(store, listed);
    const one = readAll(adapter, store, key, sk);
    const capped = readAll(adapter, store, key, sk, { maxReadBytes: 4 * MiB });
    assert.equal(one.length, 1);
    assert.equal(capped.length, 3);
    checkBoundaries(capped, fs.readFileSync(path.join(store.harness_path, sk)), 4 * MiB);
    assert.deepEqual(capped.flatMap((r) => r.units), one[0].units);
  });
});

// ---- the default, the floor, a value that is not a positive integer ---------------------------

test('the default stays 64 MiB: with no options, the first read of a 65 MiB stream stops at 64 MiB', () => {
  withToyStream(filler(MiB).repeat(65), ({ adapter, store, key }) => {
    const r1 = adapter.read(store, key, TOY_KEY, null, null);
    assert.equal(r1.position.offset, 64 * MiB);
    assert.equal(r1.units.length, 64);
    assert.equal(r1.more, true);
    const r2 = adapter.read(store, key, TOY_KEY, r1.position, null);
    assert.equal(r2.units.length, 1);
    assert.equal(r2.more, false);
  });
});

test('a value below 1 MiB is raised to the floor: each read returns about 1 MiB', () => {
  withToyStream(toyLines(2.5 * MiB), ({ adapter, store, key, file }) => {
    const one = readAll(adapter, store, key, TOY_KEY);
    for (const v of [1, 1000, MIN_READ_BYTES - 1]) {
      const reads = readAll(adapter, store, key, TOY_KEY, { maxReadBytes: v });
      assert.equal(reads.length, 3, `${v}: ceil(2.5 MiB / 1 MiB) reads`);
      const first = reads[0].position.offset;
      assert.ok(first <= MIN_READ_BYTES && first > MIN_READ_BYTES - LINE, `${v}: the first read stops at the last line boundary within 1 MiB, not ${first}`);
      checkBoundaries(reads, fs.readFileSync(file), MIN_READ_BYTES);
      assert.deepEqual(reads.flatMap((r) => r.units), one[0].units);
    }
  });
});

test('a value that is not a positive integer, or no options object, gives the default', () => {
  withToyStream(toyLines(2.5 * MiB), ({ adapter, store, key }) => {
    const one = adapter.read(store, key, TOY_KEY, null, null);
    assert.equal(one.more, false);
    const cases = [...NOT_POSITIVE_INTEGERS.map((v) => ({ maxReadBytes: v })), {}, null, 'options', 5];
    for (const options of cases) {
      const r = adapter.read(store, key, TOY_KEY, null, null, options);
      assert.equal(r.more, false, `${JSON.stringify(options)}: one read, as the default`);
      assert.deepEqual(r, one);
    }
  });
});

// ---- a line longer than the cap -----------------------------------------------------------------

test('a line longer than the cap arrives whole, and the reads still cut at line boundaries', () => {
  const long = filler(1.5 * MiB + 7);
  withToyStream('{"type":"toy.short"}\n' + long + toyLines(2 * MiB), ({ adapter, store, key, file }) => {
    const one = readAll(adapter, store, key, TOY_KEY);
    for (const v of [MIN_READ_BYTES, 1]) {
      const reads = readAll(adapter, store, key, TOY_KEY, { maxReadBytes: v });
      checkBoundaries(reads, fs.readFileSync(file), null);
      assert.deepEqual(reads[0].units.map((u) => u.body), ['{"type":"toy.short"}'], 'the cap stops the first read before the long line');
      const whole = reads[1].units[0];
      assert.equal(whole.unit_key, '21');
      assert.equal(whole.bytes, long.length - 1);
      assert.equal(whole.body, long.slice(0, -1));
      assert.deepEqual(reads.flatMap((r) => r.units), one[0].units);
    }
  });
});

test('a partial line longer than the cap is held back whole, then arrives whole', () => {
  const long = filler(1.5 * MiB);
  withToyStream('{"type":"toy.short"}\n' + long.slice(0, -1), ({ adapter, store, key, file }) => {
    const r1 = readAll(adapter, store, key, TOY_KEY, { maxReadBytes: MIN_READ_BYTES });
    assert.deepEqual(r1.at(-1).held_back, [{ unit_key: '21', bytes: long.length - 1 }]);
    fs.appendFileSync(file, '\n');
    const r2 = adapter.read(store, key, TOY_KEY, r1.at(-1).position, null, { maxReadBytes: MIN_READ_BYTES });
    assert.equal(r2.continuity, 'appended');
    assert.deepEqual(r2.units.map((u) => [u.unit_key, u.bytes]), [['21', long.length - 1]]);
    assert.equal(r2.more, false);
  });
});

// ---- snapshot and database sources ignore it ----------------------------------------------------

test('a snapshot larger than the cap is one unit, read alike with and without maxReadBytes', () => {
  withCase('copilot-cli', 'basic', ({ adapter, store }) => {
    const [s] = adapter.list(store);
    const src = s.sources.find((x) => x.mode === 'snapshot');
    const file = path.join(store.harness_path, src.source_key);
    fs.appendFileSync(file, `# ${'z'.repeat(2 * MiB)}\n`);
    const key = sessionKey(store, s);
    const plain = adapter.read(store, key, src.source_key, null, null);
    const capped = adapter.read(store, key, src.source_key, null, null, { maxReadBytes: 1 });
    assert.deepEqual(capped, plain);
    assert.equal(capped.units.length, 1);
    assert.equal(capped.units[0].bytes, fs.statSync(file).size);
    assert.ok(capped.units[0].bytes > MIN_READ_BYTES);
  });
});

test('a SQLite source with a row larger than the cap reads alike with and without maxReadBytes', () => {
  withCase('goose', 'features', ({ adapter, dir, store }) => {
    const s = adapter.list(store).find((x) => x.sources.some((y) => y.source_key.endsWith('#table:messages')));
    const sk = s.sources.find((y) => y.source_key.endsWith('#table:messages')).source_key;
    const w = new DatabaseSync(path.join(dir, DB_REL));
    try {
      const { id } = w.prepare('SELECT min(id) AS id FROM messages WHERE session_id = ?').get(s.session_id);
      w.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(JSON.stringify([{ type: 'text', text: 'z'.repeat(2 * MiB) }]), id);
    } finally {
      w.close();
    }
    const key = sessionKey(store, s);
    const plain = adapter.read(store, key, sk, null, null);
    const capped = adapter.read(store, key, sk, null, null, { maxReadBytes: 1 });
    assert.deepEqual(capped, plain);
    assert.ok(capped.units.some((u) => u.bytes > 2 * MiB), 'the large row is one unit');
  });
});

test('every source that is not a stream file reads alike with and without maxReadBytes, in every adapter', () => {
  let n = 0;
  for (const h of Object.keys(ADAPTERS).sort()) {
    withCase(h, casesOf(h)[0], ({ adapter, store }) => {
      for (const s of adapter.list(store)) {
        const key = sessionKey(store, s);
        for (const src of s.sources.filter((x) => !isByteStream(x))) {
          assert.deepEqual(adapter.read(store, key, src.source_key, null, null, { maxReadBytes: 1 }), adapter.read(store, key, src.source_key, null, null), `${h} ${src.source_key}`);
          n += 1;
        }
      }
    });
  }
  assert.ok(n > 0);
});
