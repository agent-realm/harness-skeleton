// pi's session directory (design note v0.2 §8): given the working directory, a launch passes
// --session-dir with pi's own path for it, so a project's .pi/settings.json sessionDir cannot move
// the session out of the folder. No test starts a real harness: the binary is a stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { layer, tmpdir, write } from './fixtures.js';
import { linuxHost, ok } from './sandbox.js';

function box() {
  const root = fs.realpathSync.native(tmpdir());
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folder = path.join(root, 'pi-folder');
  fs.mkdirSync(folder);
  const bin = write(root, 'bin/pi', '#!/bin/sh\necho "1.5.2"\n');
  fs.chmodSync(bin, 0o755);
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const opts = { host: linuxHost, home, tmpdir: tmp, state: { managedRoot: null, mdmPlists: [] } };
  const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'pi', harness_path: folder, bin, ...args } }, opts);
  return { root, home, folder, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
// pi 1.5.2's own encoding (dist/core/session-manager.js getDefaultSessionDirPath), written out here
// so the test fails if the descriptor's copy drifts from it.
const group = (cwd) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
const plain = (s) => layer(s.root, 'plain', '[model.roles]\nprimary = "pi-model"\n');

test('pi launch given cwd: --session-dir is pi\'s own path for it, also for spaces, a colon and unicode; the result names the cwd it is bound to', () => {
  const s = box();
  try {
    for (const name of ['work', 'with space', 'co:lon', 'ünïcødé-日本']) {
      const cwd = path.join(s.root, 'proj', name);
      fs.mkdirSync(cwd, { recursive: true });
      const spec = ok(s.call('launch-spec', { layers: [plain(s)], headless: true, cwd }));
      const i = spec.argv.indexOf('--session-dir');
      assert.ok(i > 0, name);
      assert.equal(spec.argv[i + 1], path.join(s.folder, 'sessions', group(cwd)), name);
      assert.equal(spec.cwd, cwd, name);
      assert.match(spec.launch_items.find((x) => x.item === 'sessions').via, /which a project's sessionDir cannot outrank/);
      assert.ok(spec.notes.some((n) => n === `argv is bound to the working directory ${cwd}: run pi there`));
      assert.ok(!spec.unverified.some((u) => /no cwd was given/.test(u)));
    }
  } finally {
    s.done();
  }
});

test('pi launch given a cwd through a symlink: the group is the real path\'s, as pi sees its working directory', () => {
  const s = box();
  try {
    const real = path.join(s.root, 'real-work');
    fs.mkdirSync(real);
    const link = path.join(s.root, 'link-work');
    fs.symlinkSync(real, link);
    const spec = ok(s.call('launch-spec', { layers: [plain(s)], headless: true, cwd: link }));
    assert.equal(spec.argv[spec.argv.indexOf('--session-dir') + 1], path.join(s.folder, 'sessions', group(real)));
    assert.equal(spec.cwd, real);
  } finally {
    s.done();
  }
});

test('pi launch: the cwd is bound by the digest; without one there is no --session-dir and the caller is told why', () => {
  const s = box();
  try {
    const a = path.join(s.root, 'a');
    const b = path.join(s.root, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const sa = ok(s.call('launch-spec', { layers: [plain(s)], headless: true, cwd: a }));
    const sb = ok(s.call('launch-spec', { layers: [plain(s)], headless: true, cwd: b }));
    assert.notEqual(sa.launch_digest, sb.launch_digest);
    const none = ok(s.call('launch-spec', { layers: [plain(s)], headless: true }));
    assert.ok(!none.argv.includes('--session-dir'));
    assert.equal(none.cwd, undefined);
    assert.ok(none.unverified.some((u) => /no cwd was given.*give launch-spec the cwd to close it/.test(u)));
  } finally {
    s.done();
  }
});

test('pi launch: a folder whose own settings.json sets sessionDir keeps it; no --session-dir is passed', () => {
  const s = box();
  try {
    write(s.folder, 'settings.json', JSON.stringify({ sessionDir: '/elsewhere-for-test' }));
    const cwd = path.join(s.root, 'w');
    fs.mkdirSync(cwd);
    const spec = ok(s.call('launch-spec', { layers: [plain(s)], headless: true, cwd }));
    assert.ok(!spec.argv.includes('--session-dir'));
    assert.equal(spec.cwd, undefined, 'nothing is bound to the cwd');
    assert.ok(spec.notes.some((n) => /the folder's settings.json sets sessionDir, which this launch leaves as it is/.test(n)));
  } finally {
    s.done();
  }
});

test('launch-spec: cwd must be an absolute, existing directory', () => {
  const s = box();
  try {
    const f = write(s.root, 'a-file', 'x');
    for (const cwd of ['relative/dir', path.join(s.root, 'missing'), f]) {
      assert.equal(s.call('launch-spec', { layers: [plain(s)], headless: true, cwd }).error?.code, 'bad_request', cwd);
    }
  } finally {
    s.done();
  }
});

test('describe and observe: the coupling to pi\'s encoding is named; observe --state --cwd says whether the project moves sessions', () => {
  const s = box();
  try {
    const d = ok(s.call('describe', {}));
    assert.equal(d.session_dir.flag, '--session-dir');
    assert.match(d.session_dir.coupling, /pi internal hs computes: it holds for the 1\.5 line.*tier 1 \(pi-session-dir\) fails/);
    assert.deepEqual(d.session_dir.versions, d.versions.compatible);
    assert.match(d.known_limits.find((k) => k.path.startsWith('.pi/settings.json sessionDir')).closed_by, /launch-spec given the working directory/);
    const cwd = path.join(s.root, 'proj');
    fs.mkdirSync(cwd);
    assert.equal(ok(s.call('observe', { state: true, cwd })).project_trust.cwd.project_session_dir, false);
    write(cwd, '.pi/settings.json', JSON.stringify({ sessionDir: './elsewhere' }));
    assert.equal(ok(s.call('observe', { state: true, cwd })).project_trust.cwd.project_session_dir, true);
  } finally {
    s.done();
  }
});
