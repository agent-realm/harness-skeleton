import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnessPath } from '../src/harness-path.js';

function tmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-path-')));
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

test('harness_path: relative, missing and non-directory paths are refused', () => {
  const dir = tmp();
  try {
    assert.throws(() => harnessPath('relative/dir'), { code: 'bad_request' });
    assert.throws(() => harnessPath(''), { code: 'bad_request' });
    assert.throws(() => harnessPath(path.join(dir, 'nope')), { code: 'folder_missing' });
    fs.writeFileSync(path.join(dir, 'file'), '');
    assert.throws(() => harnessPath(path.join(dir, 'file')), { code: 'bad_request' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
