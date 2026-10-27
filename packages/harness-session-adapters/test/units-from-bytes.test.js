// unitsFromBytes (src/index.js): the units `read(store, session, source_key, null, null)` returns
// from scratch, from a file source's bytes alone. Held to `read` over every file source of every
// fixture case of every adapter, whole, cut inside its last line, continued from a non-zero start,
// and (for snapshots) cut short; held to a hand-computed split, so a fault in the split that `read`
// shares is caught too; and run with the file system unreachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, unitsFromBytes } from '../src/index.js';
import { storeOf, tmpStore } from '../conformance/runner.js';
import { prepareStore, caseHarnessPath } from '../conformance/sql-store.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const HARNESSES = Object.keys(ADAPTERS).sort();
// What the fixtures must exercise per harness: file sources by mode, database sources, and units
// `read` redacted. A harness missing here keeps its sessions in databases only.
const EXPECT = {
  'claude-code': { stream: true },
  codex: { stream: true },
  'copilot-cli': { stream: true, snapshot: true },
  'gemini-cli': { stream: true, snapshot: true },
  vscode: { stream: true, snapshot: true, redacted: true },
  agy: { stream: true, snapshot: true, db: true },
  'cursor-agent': { snapshot: true, db: true },
  opencode: { snapshot: true, db: true },
};

const casesOf = (h) => fs.readdirSync(path.join(FIX, h), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const code = (c) => (e) => e && e.code === c;

// A fixture case built in a temp directory, as the golden tests build it.
function withCase(h, c, fn) {
  const dir = tmpStore('sa-ufb-');
  try {
    const caseDir = path.join(FIX, h, c);
    prepareStore(caseDir, dir);
    const adapter = ADAPTERS[h];
    return fn({ adapter, store: storeOf(adapter, caseHarnessPath(caseDir, dir)) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sessionKey = (store, s) => ({ ...store, session_id: s.session_id, incarnation: s.incarnation ?? '' });

// `read` from scratch, in the shape unitsFromBytes returns.
function scratch(adapter, store, s, sk) {
  const r = adapter.read(store, sessionKey(store, s), sk, null, null);
  assert.equal(r.more ?? false, false, `${sk}: a fixture fits one read`);
  return { units: r.units, held_back: r.held_back };
}

// The file a source key names, or null: a database's table or key range names none. An OpenCode
// spill's key is absolute; every other key is relative to the harness_path.
function fileOf(store, sk) {
  const f = path.resolve(store.harness_path, sk);
  try {
    return fs.lstatSync(f).isFile() ? f : null;
  } catch {
    return null;
  }
}

// Every source of every session, with its file (or null).
function sourcesOf(adapter, store) {
  return adapter.list(store).flatMap((s) => s.sources.map((src) => ({ s, src, file: fileOf(store, src.source_key) })));
}

// The session as list names it now, after a file changed, or null when the source is gone.
function relisted(adapter, store, s, sk) {
  const now = adapter.list(store).find((x) => x.session_id === s.session_id);
  return now && now.sources.some((x) => x.source_key === sk) ? now : null;
}

for (const h of HARNESSES) {
  test(`unitsFromBytes/${h}: every file source of every fixture case equals read() from scratch; a database source is a bad_request`, () => {
    const seen = { stream: 0, snapshot: 0, db: 0, redacted: 0 };
    for (const c of casesOf(h)) {
      withCase(h, c, ({ adapter, store }) => {
        for (const { s, src, file } of sourcesOf(adapter, store)) {
          const sk = src.source_key;
          if (!file) {
            assert.throws(() => unitsFromBytes(h, sk, Buffer.alloc(0)), code('bad_request'), `${h}/${c}: ${sk}`);
            seen.db += 1;
            continue;
          }
          const got = unitsFromBytes(h, sk, fs.readFileSync(file));
          assert.deepStrictEqual(got, scratch(adapter, store, s, sk), `${h}/${c}: ${sk}`);
          seen[src.mode] += 1;
          seen.redacted += got.units.filter((u) => u.redacted).length;
        }
      });
    }
    const want = EXPECT[h];
    if (!want) {
      assert.equal(seen.stream + seen.snapshot, 0, `${h} has no file source`);
      assert.ok(seen.db > 0, `${h}: its database sources were checked`);
      return;
    }
    for (const k of ['stream', 'snapshot', 'db', 'redacted']) {
      if (want[k]) assert.ok(seen[k] > 0, `${h}: the fixtures exercise ${k} (${JSON.stringify(seen)})`);
    }
    if (!want.stream) assert.equal(seen.stream, 0);
  });
}

// A stream source cut inside its last line: the partial line is held back, alike in both.
for (const h of Object.keys(EXPECT).filter((x) => EXPECT[x].stream)) {
  test(`unitsFromBytes/${h}: a stream cut inside its last line holds that line back, as read() does`, () => {
    let checked = 0;
    for (const c of casesOf(h)) {
      withCase(h, c, ({ adapter, store }) => {
        for (const { s, src, file } of sourcesOf(adapter, store)) {
          if (!file || src.mode !== 'stream') continue;
          const whole = fs.readFileSync(file);
          const last = whole.lastIndexOf(0x0a, whole.length - 2) + 1;
          if (last === 0 || whole.length - last < 2) continue; // one line only: line 1 names the session
          const cut = whole.subarray(0, last + Math.max(1, Math.floor((whole.length - last) / 2)));
          fs.truncateSync(file, cut.length);
          try {
            const now = relisted(adapter, store, s, src.source_key);
            if (!now) continue;
            const got = unitsFromBytes(h, src.source_key, cut);
            assert.equal(got.held_back.length, 1, src.source_key);
            assert.deepEqual(got.held_back[0], { unit_key: String(last), bytes: cut.length - last });
            assert.deepStrictEqual(got, scratch(adapter, store, now, src.source_key), `${h}/${c}: ${src.source_key}`);
            checked += 1;
          } finally {
            fs.writeFileSync(file, whole);
          }
        }
      });
    }
    assert.ok(checked > 0, `${h}: a partial last line was checked`);
  });

  // `start`: the bytes from a line start on, as `read` returns them appended after a read that
  // stopped there (same inode, the rest appended).
  test(`unitsFromBytes/${h}: from a non-zero start, the units read() returns appended from that offset`, () => {
    let checked = 0;
    for (const c of casesOf(h)) {
      withCase(h, c, ({ adapter, store }) => {
        for (const { s, src, file } of sourcesOf(adapter, store)) {
          if (!file || src.mode !== 'stream') continue;
          const whole = fs.readFileSync(file);
          const all = unitsFromBytes(h, src.source_key, whole);
          if (all.units.length < 2) continue;
          const k = Number(all.units[Math.ceil(all.units.length / 2)].unit_key); // a line start past line 1
          fs.truncateSync(file, k);
          try {
            const now = relisted(adapter, store, s, src.source_key);
            if (!now) continue;
            const first = adapter.read(store, sessionKey(store, now), src.source_key, null, null);
            assert.equal(first.position.offset, k);
            fs.appendFileSync(file, whole.subarray(k));
            const next = adapter.read(store, sessionKey(store, now), src.source_key, first.position, null);
            assert.equal(next.continuity, 'appended');
            const got = unitsFromBytes(h, src.source_key, whole.subarray(k), { start: k });
            assert.deepStrictEqual(got, { units: next.units, held_back: next.held_back }, `${h}/${c}: ${src.source_key} from ${k}`);
            // ...which is the tail of the whole file's units.
            assert.deepStrictEqual(got.units, all.units.filter((u) => Number(u.unit_key) >= k));
            assert.ok(got.units.every((u) => Number(u.unit_key) >= k));
            checked += 1;
          } finally {
            fs.writeFileSync(file, whole);
          }
        }
      });
    }
    assert.ok(checked > 0, `${h}: a non-zero start was checked`);
  });
}

// A snapshot cut short or emptied: whatever `read` makes of it (a unit, or a torn document held
// back: VS Code's JSON, Gemini's legacy .json), unitsFromBytes makes the same.
for (const h of Object.keys(EXPECT).filter((x) => EXPECT[x].snapshot)) {
  test(`unitsFromBytes/${h}: a snapshot cut short or emptied gives what read() gives, torn writes held back alike`, () => {
    let checked = 0;
    let held = 0;
    for (const c of casesOf(h)) {
      withCase(h, c, ({ adapter, store }) => {
        for (const { s, src, file } of sourcesOf(adapter, store)) {
          if (!file || src.mode !== 'snapshot') continue;
          const whole = fs.readFileSync(file);
          for (const n of [Math.floor(whole.length / 2), 0]) {
            fs.truncateSync(file, n);
            try {
              const now = relisted(adapter, store, s, src.source_key);
              if (!now) continue;
              const got = unitsFromBytes(h, src.source_key, whole.subarray(0, n));
              assert.deepStrictEqual(got, scratch(adapter, store, now, src.source_key), `${h}/${c}: ${src.source_key} cut to ${n}`);
              checked += 1;
              held += got.held_back.length;
            } finally {
              fs.writeFileSync(file, whole);
            }
          }
        }
      });
    }
    assert.ok(checked > 0, `${h}: a cut snapshot was checked`);
    if (h === 'vscode' || h === 'gemini-cli') assert.ok(held > 0, `${h}: a torn document was held back`);
  });
}

// The split itself, against offsets and bodies worked out by hand: a CRLF line, a blank and a
// whitespace-only line (skipped, still counted), a line that is no UTF-8 (base64), a partial last
// line. `read` shares this split, so comparing the two alone could not catch a fault in it.
const SID = '0f5e1c2a-7b3d-4e8f-a9c1-2d3e4f5a6b7c';
const CC_KEY = `projects/-home-user-toy/${SID}.jsonl`;
const BYTES = Buffer.concat([
  Buffer.from('{"a":1}\r\n'), // 0..9
  Buffer.from('\n'), // 9
  Buffer.from('  \t\n'), // 10..14
  Buffer.from('{"b":"x"}\n'), // 14..24
  Buffer.from([0xff, 0xfe, 0x7b, 0x0a]), // 24..28
  Buffer.from('{"c":'), // 28..33, partial
]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
function handUnits(start) {
  const u = (at, buf, enc, body) => ({ source_key: CC_KEY, unit_key: String(start + at), enc, bytes: buf.length, sha256: sha(buf), redacted: false, body });
  const bad = Buffer.from([0xff, 0xfe, 0x7b]);
  return {
    units: [u(0, Buffer.from('{"a":1}'), 'utf8', '{"a":1}'), u(14, Buffer.from('{"b":"x"}'), 'utf8', '{"b":"x"}'), u(24, bad, 'b64', bad.toString('base64'))],
    held_back: [{ unit_key: String(start + 28), bytes: 5 }],
  };
}

test('unitsFromBytes: the line split matches offsets and bodies worked out by hand, and read() on the same file', () => {
  assert.deepStrictEqual(unitsFromBytes('claude-code', CC_KEY, BYTES), handUnits(0));
  assert.deepStrictEqual(unitsFromBytes('claude-code', CC_KEY, BYTES, { start: 1000 }), handUnits(1000));
  // A Uint8Array view is taken as its bytes, offset and all.
  const backing = Buffer.concat([Buffer.from('xx'), BYTES]); // a slice of Node's shared pool
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 2, BYTES.length);
  assert.deepStrictEqual(unitsFromBytes('claude-code', CC_KEY, view), handUnits(0));
  const dir = tmpStore('sa-ufb-');
  try {
    fs.mkdirSync(path.join(dir, 'projects', '-home-user-toy'), { recursive: true });
    fs.writeFileSync(path.join(dir, CC_KEY), BYTES);
    const adapter = ADAPTERS['claude-code'];
    const store = storeOf(adapter, dir);
    assert.deepStrictEqual(scratch(adapter, store, { session_id: SID, incarnation: '' }, CC_KEY), handUnits(0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// VS Code redacts in `read`, per op: a secret under `selectedModel.metadata.auth` becomes a marker,
// and a line that does not parse becomes one marker as a whole. unitsFromBytes redacts alike.
test('unitsFromBytes/vscode: a redacted op and an unparseable line are redacted exactly as read() redacts them', () => {
  const sid = '0a0a0a0a-0000-4000-8000-0000000000ff';
  const key = `User/globalStorage/emptyWindowChatSessions/${sid}.jsonl`;
  const lines = [
    { kind: 0, v: { sessionId: sid, requests: [], inputState: { selectedModel: { identifier: 'm', metadata: { auth: { token: 'synthetic-not-a-secret' } } } } } },
    { kind: 1, k: ['inputState', 'selectedModel'], v: { identifier: 'm2', metadata: { auth: 'synthetic-value' } } },
  ].map((o) => JSON.stringify(o));
  const bytes = Buffer.from(`${lines[0]}\n${lines[1]}\n{not json\n`);
  const got = unitsFromBytes('vscode', key, bytes);
  assert.deepEqual(got.units.map((u) => u.redacted), [true, true, true]);
  assert.ok(got.units.every((u) => !u.body.includes('synthetic')));
  assert.equal(JSON.parse(got.units[2].body), '<redacted len=9>');
  const dir = tmpStore('sa-ufb-');
  try {
    fs.mkdirSync(path.join(dir, 'User', 'globalStorage', 'emptyWindowChatSessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, key), bytes);
    const adapter = ADAPTERS.vscode;
    assert.deepStrictEqual(got, scratch(adapter, storeOf(adapter, dir), { session_id: sid, incarnation: '' }, key));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unitsFromBytes: the snapshot unit is keyed by its source_key; cursor-agent meta.json is read as {cwd} only', () => {
  const ws = 'User/workspaceStorage/ws1/workspace.json';
  const r = unitsFromBytes('vscode', ws, Buffer.from('{"folder":"file:///home/user/toy"}'));
  assert.deepEqual(r.units.map((u) => [u.source_key, u.unit_key, u.body]), [[ws, ws, '{"folder":"file:///home/user/toy"}']]);
  const meta = 'chats/fca83931bbc72705a958b0f3662eff69/c4a1e0de-5a7e-4000-8000-000000000001/meta.json';
  const m = unitsFromBytes('cursor-agent', meta, Buffer.from('{"cwd":"/home/user/toy","updatedAtMs":1,"other":"x"}'));
  assert.deepEqual(m.units.map((u) => [u.unit_key, u.body]), [[meta, '{"cwd":"/home/user/toy"}']]);
  // A torn VS Code document and a torn Gemini legacy session are held back whole.
  assert.deepEqual(unitsFromBytes('vscode', ws, Buffer.from('{"folder":')), { units: [], held_back: [{ unit_key: ws, bytes: 10 }] });
  const legacy = 'tmp/old-proj/chats/session-2025-09-01T10-00-c1d2e3f4.json';
  assert.deepEqual(unitsFromBytes('gemini-cli', legacy, Buffer.from('{"sessionId":"c1')), { units: [], held_back: [{ unit_key: legacy, bytes: 16 }] });
  // .project_root is a side snapshot: not JSON, and never held back.
  assert.equal(unitsFromBytes('gemini-cli', 'tmp/old-proj/.project_root', Buffer.from('/home/user/old')).units.length, 1);
});

test('unitsFromBytes: errors', () => {
  const none = Buffer.alloc(0);
  assert.throws(() => unitsFromBytes('no-such-harness', 'x.jsonl', none), code('harness_unknown'));
  for (const h of ['goose', 'cursor', 'zed', 'devin']) assert.throws(() => unitsFromBytes(h, 'any.db#table:x', none), code('bad_request'), h);
  // Database sources of harnesses that also have files.
  for (const [h, sk] of [
    ['agy', 'conversations/63e1ede9-38a7-420a-a1da-f43eabc90713.db#table:steps'],
    ['agy', 'conversation_summaries.db#table:conversation_summaries'],
    ['cursor-agent', 'chats/fca83931bbc72705a958b0f3662eff69/c4a1e0de-5a7e-4000-8000-000000000001/store.db#table:blobs'],
    ['cursor-agent', 'acp-sessions/7a7a7a7a-5a7e-4000-8000-000000000004/store.db#table:meta'],
    ['opencode', 'table:message'],
    ['opencode', 'table:event'],
  ]) assert.throws(() => unitsFromBytes(h, sk, none), code('bad_request'), `${h} ${sk}`);
  // Keys no list names.
  for (const [h, sk] of [
    ['claude-code', 'projects/p/not-a-uuid.jsonl'],
    ['claude-code', `projects/../${SID}.jsonl`],
    ['claude-code', `projects/p/${SID}/notes/agent-a.jsonl`],
    ['codex', 'sessions/2026/01/03/other-2026.jsonl'],
    ['codex', 'elsewhere/rollout-x.jsonl'],
    ['copilot-cli', 'session-state/s1/other.jsonl'],
    ['copilot-cli', 'session-state/../events.jsonl'],
    ['gemini-cli', 'tmp/slug/chats/notes.jsonl'],
    ['gemini-cli', 'tmp/slug/checkpoint-x.json'],
    ['vscode', 'User/workspaceStorage/ws/chatSessions/notes.txt'],
    ['vscode', 'User/workspaceStorage/ws/state.vscdb'],
    ['agy', 'brain/not-a-uuid/.system_generated/logs/transcript_full.jsonl'],
    ['agy', 'conversations/63e1ede9-38a7-420a-a1da-f43eabc90713.db#table:nope'],
    ['cursor-agent', 'projects/home-user-toy/agent-transcripts/x/x.jsonl'],
    ['opencode', 'tool-output/tool_15e9c52d6001gtLJ6eFdyy7OyL'], // a spill's key is absolute
    ['opencode', '/data/other/tool_15e9c52d6001gtLJ6eFdyy7OyL'],
    ['opencode', 'table:nope'],
  ]) assert.throws(() => unitsFromBytes(h, sk, none), code('source_unknown'), `${h} ${sk}`);
  // Arguments.
  assert.throws(() => unitsFromBytes('claude-code', CC_KEY, 'text'), code('bad_request'));
  assert.throws(() => unitsFromBytes('claude-code', CC_KEY, none, { start: -1 }), code('bad_request'));
  assert.throws(() => unitsFromBytes('claude-code', CC_KEY, none, { start: 1.5 }), code('bad_request'));
  assert.throws(() => unitsFromBytes('vscode', 'User/workspaceStorage/ws/workspace.json', none, { start: 7 }), code('bad_request'), 'a snapshot starts at 0');
  // An opencode spill, from its absolute key.
  assert.equal(unitsFromBytes('opencode', '/data/opencode/tool-output/tool_15e9c52d6001gtLJ6eFdyy7OyL', Buffer.from('out')).units[0].body, 'out');
});

// No file system: the bytes are all it reads. Every synchronous fs entry point the adapters use
// throws while it runs, and the results do not change.
test('unitsFromBytes: touches no file system', () => {
  const inputs = [];
  for (const h of Object.keys(EXPECT)) {
    withCase(h, casesOf(h)[0], ({ adapter, store }) => {
      for (const { src, file } of sourcesOf(adapter, store)) {
        if (file) inputs.push({ h, sk: src.source_key, bytes: fs.readFileSync(file), want: unitsFromBytes(h, src.source_key, fs.readFileSync(file)) });
      }
    });
  }
  assert.ok(inputs.length > 10);
  const names = ['openSync', 'readSync', 'readFileSync', 'lstatSync', 'statSync', 'fstatSync', 'readdirSync', 'existsSync', 'closeSync', 'realpathSync'];
  const saved = Object.fromEntries(names.map((n) => [n, fs[n]]));
  for (const n of names) {
    fs[n] = () => {
      throw new Error(`fs.${n} called`);
    };
  }
  try {
    for (const x of inputs) assert.deepStrictEqual(unitsFromBytes(x.h, x.sk, x.bytes), x.want, `${x.h} ${x.sk}`);
  } finally {
    Object.assign(fs, saved);
  }
});
