// Symlinks are never followed: a session reached through one is neither listed nor read, for
// every adapter whose store is a folder of files (the rule src/sources.js openSource enforces).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from '../src/index.js';
import { tmpStore, copyTree, storeOf } from '../conformance/runner.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

// For each harness: a fixture case, and how to plant a symlinked session file and a symlinked
// folder that would each hold one more session if links were followed.
const CASES = {
  'gemini-cli': {
    fixture: 'features',
    file: (dir) => path.join(dir, 'tmp', 'toyshop', 'chats', 'session-2026-03-01T00-00-99999999.jsonl'),
    folder: (dir) => path.join(dir, 'tmp', 'linked-project'),
    body: '{"sessionId":"99999999-9999-4999-8999-999999999999","projectHash":"x","startTime":"2026-03-01T00:00:00.000Z","lastUpdated":"2026-03-01T00:00:00.000Z","kind":"main"}\n',
    folderLayout: (outside, body) => {
      fs.mkdirSync(path.join(outside, 'chats'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'chats', 'session-2026-03-01T00-00-99999999.jsonl'), body);
    },
  },
  'copilot-cli': {
    fixture: 'basic',
    file: (dir) => path.join(dir, 'session-state', '99999999-9999-4999-8999-999999999999', 'events.jsonl'),
    folder: (dir) => path.join(dir, 'session-state', '88888888-8888-4888-8888-888888888888'),
    body: '{"type":"session.start","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2026-03-01T00:00:00.000Z","data":{"sessionId":"99999999-9999-4999-8999-999999999999"}}\n',
    folderLayout: (outside, body) => fs.writeFileSync(path.join(outside, 'events.jsonl'), body.replaceAll('99999999-9999-4999-8999-999999999999', '88888888-8888-4888-8888-888888888888')),
  },
  vscode: {
    fixture: 'lab',
    // A linked chat file in a real chatSessions folder, and a linked workspaceStorage/<ws> folder.
    file: (dir) => path.join(dir, 'User', 'workspaceStorage', 'ef73fdb910bc7d73f611948f243bc8c5', 'chatSessions', '99999999-9999-4999-8999-999999999999.jsonl'),
    folder: (dir) => path.join(dir, 'User', 'workspaceStorage', 'linked-ws'),
    body: '{"kind":0,"v":{"version":3,"creationDate":1767693599000,"sessionId":"99999999-9999-4999-8999-999999999999","requests":[]}}\n',
    folderLayout: (outside, body) => {
      fs.mkdirSync(path.join(outside, 'chatSessions'));
      fs.writeFileSync(path.join(outside, 'chatSessions', '88888888-8888-4888-8888-888888888888.jsonl'), body.replaceAll('99999999-9999-4999-8999-999999999999', '88888888-8888-4888-8888-888888888888'));
      fs.writeFileSync(path.join(outside, 'workspace.json'), '{"folder":"file:///home/user/elsewhere"}\n');
    },
  },
  // A DB-less brain transcript, linked as a file and through a linked brain/<id> folder. A linked
  // conversation DB is in test/agy.test.js (the DBs are built, not copied from store/).
  agy: {
    fixture: 'transcript',
    file: (dir) => path.join(dir, 'brain', '99999999-9999-4999-8999-999999999999', '.system_generated', 'logs', 'transcript_full.jsonl'),
    folder: (dir) => path.join(dir, 'brain', '88888888-8888-4888-8888-888888888888'),
    body: '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-03-01T00:00:00Z","content":"outside"}\n',
    folderLayout: (outside, body) => {
      fs.mkdirSync(path.join(outside, '.system_generated', 'logs'), { recursive: true });
      fs.writeFileSync(path.join(outside, '.system_generated', 'logs', 'transcript_full.jsonl'), body);
    },
  },
};

for (const [harness, c] of Object.entries(CASES)) {
  test(`${harness}: a symlinked session file or folder is neither listed nor read`, () => {
    const adapter = adapterFor(harness);
    const dir = tmpStore();
    const outside = tmpStore('sa-outside-');
    try {
      copyTree(path.join(FIX, harness, c.fixture, 'store'), dir);
      const store = storeOf(adapter, dir);
      const before = adapter.list(store).map((s) => s.session_id);

      fs.writeFileSync(path.join(outside, 'target.jsonl'), c.body);
      const file = c.file(dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(path.join(outside, 'target.jsonl'), file);
      const folderTarget = path.join(outside, 'folder');
      fs.mkdirSync(folderTarget);
      c.folderLayout(folderTarget, c.body);
      fs.symlinkSync(folderTarget, c.folder(dir));

      assert.deepEqual(adapter.list(store).map((s) => s.session_id), before);
      for (const sid of ['99999999-9999-4999-8999-999999999999', '88888888-8888-4888-8888-888888888888']) {
        const key = { ...store, session_id: sid, incarnation: '' };
        assert.throws(() => adapter.read(store, key, path.relative(dir, file)), (e) => e.code === 'session_unknown' || e.code === 'source_unknown');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
}

test('gemini-cli: read opens nothing, not even a header, through a symlinked project folder', async () => {
  const adapter = adapterFor('gemini-cli');
  const dir = tmpStore();
  const outside = tmpStore('sa-outside-');
  try {
    copyTree(path.join(FIX, 'gemini-cli', 'features', 'store'), dir);
    fs.mkdirSync(path.join(outside, 'chats'));
    fs.writeFileSync(path.join(outside, 'chats', 'session-2026-03-01T00-00-77777777.jsonl'), '{"sessionId":"77777777-7777-4777-8777-777777777777","startTime":"2026-03-01T00:00:00.000Z","kind":"main"}\n');
    fs.symlinkSync(outside, path.join(dir, 'tmp', 'linked'));
    const store = storeOf(adapter, dir);
    const key = { ...store, session_id: '77777777-7777-4777-8777-777777777777', incarnation: '' };
    // Watch for any open of the outside file: none may happen.
    const opened = [];
    const realOpen = fs.openSync;
    fs.openSync = (p, ...rest) => { if (String(p).includes('77777777')) opened.push(String(p)); return realOpen(p, ...rest); };
    try {
      assert.throws(() => adapter.read(store, key, 'tmp/linked/chats/session-2026-03-01T00-00-77777777.jsonl'), (e) => e.code === 'session_unknown' || e.code === 'source_unknown');
    } finally {
      fs.openSync = realOpen;
    }
    assert.deepEqual(opened, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
