import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnessPath } from '../src/harness-path.js';

function tmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-path-')));
}

test('harness_path: one folder reached by two spellings gives one value', () => {
  const dir = tmp();
  try {
    const folder = path.join(dir, 'Data-Folder');
    fs.mkdirSync(folder);
    fs.symlinkSync(folder, path.join(dir, 'link'));
    assert.equal(harnessPath(folder), folder);
    assert.equal(harnessPath(path.join(dir, 'link')), folder);
    assert.equal(harnessPath(folder + '/'), folder);
    assert.equal(harnessPath(path.join(dir, 'link', '..', 'Data-Folder')), folder);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('harness_path: on a case-insensitive volume, the on-disk case', (t) => {
  const dir = tmp();
  try {
    const folder = path.join(dir, 'Data-Folder');
    fs.mkdirSync(folder);
    const lower = path.join(dir, 'data-folder');
    if (!fs.existsSync(lower)) {
      t.skip('this volume is case-sensitive');
      return;
    }
    assert.equal(harnessPath(lower), folder);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('harness_path: relative, missing and special paths are refused; a database file is accepted', () => {
  const dir = tmp();
  try {
    assert.throws(() => harnessPath('relative/dir'), { code: 'bad_request' });
    assert.throws(() => harnessPath(''), { code: 'bad_request' });
    assert.throws(() => harnessPath(path.join(dir, 'nope')), { code: 'folder_missing' });
    if (process.platform !== 'win32') assert.throws(() => harnessPath('/dev/null'), { code: 'bad_request' });
    // A harness bound to one database file (OpenCode's channel DBs, OPENCODE_DB; sessions-model §1):
    // the file's real path, through a symlink too.
    fs.writeFileSync(path.join(dir, 'opencode-beta.db'), '');
    fs.symlinkSync(path.join(dir, 'opencode-beta.db'), path.join(dir, 'link.db'));
    assert.equal(harnessPath(path.join(dir, 'opencode-beta.db')), path.join(dir, 'opencode-beta.db'));
    assert.equal(harnessPath(path.join(dir, 'link.db')), path.join(dir, 'opencode-beta.db'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
