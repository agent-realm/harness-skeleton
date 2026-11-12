// A plugin hs delivers is a directory inside its layer, never a package source a harness would
// fetch (design note v0.2 §5.7). pi fetches an npm or git source given with -e or in settings.json,
// and re-checks it against the registry on every start (the 1.5.2 package docs: packages), so a spec
// naming one is refused before any launch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { layer, tmpdir, write } from './fixtures.js';
import { linuxHost, ok } from './sandbox.js';

test('pi: a plugin whose source is an npm, git or URL package source is refused by validate and by launch-spec', () => {
  const root = tmpdir();
  try {
    const folder = path.join(root, 'pi-folder');
    fs.mkdirSync(folder);
    const bin = write(root, 'bin/pi', '#!/bin/sh\necho "1.5.2"\n');
    fs.chmodSync(bin, 0o755);
    const opts = { host: linuxHost, home: path.join(root, 'home'), tmpdir: root, state: { managedRoot: null, mdmPlists: [] } };
    const call = (op, args) => handle({ protocol: PROTOCOL, request_id: op, op, args: { harness: 'pi', harness_path: folder, bin, ...args } }, opts);
    for (const [i, source] of ['npm:@example/pi-tools@1.0.0', 'git:github.com/example/pi-tools@v1', 'https://github.com/example/pi-tools'].entries()) {
      const t = layer(root, `t${i}`, `[plugin."pi-tools"]\nsource = ${JSON.stringify(source)}\nformat = "agent-plugins"\n`);
      const v = ok(call('validate', { layers: [t] }));
      assert.equal(v.valid, false, source);
      assert.ok(v.problems.some((p) => p.item === 'plugin.pi-tools' && /source must name a directory inside its layer/.test(p.message)), source);
      assert.equal(call('launch-spec', { layers: [t], headless: true }).error?.code, 'spec_invalid', source);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
