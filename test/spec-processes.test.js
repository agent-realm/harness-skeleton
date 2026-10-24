// The spec digest binds the scripts a process runs from its layer (design note §5.1, §5.4;
// milestone 6a.3): an item's value is only the string `hooks/guard.sh`, so without the file's
// sha256 an edited script would leave the digest, a plan and any receipt unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { createHash } from 'node:crypto';
import { SPEC_FORMAT, canonical, resolve } from '../src/spec/layers.js';
import { layer, tmpdir, write } from './fixtures.js';

const HOOK = '[hook.guard]\nevent = "PreToolUse"\nrun = { exec = "hooks/guard.sh" }\n';

test('a hook, an MCP server and the status line are bound by the files they name in their layer', () => {
  const root = tmpdir();
  try {
    // The fixture writes [spec] first, and a bare key belongs to the table above it: the status line
    // is a table of its own.
    const team = layer(root, 'team', `[statusline]
run = { exec = "bin/status.sh" }

${HOOK}
[mcp.local]
exec = "node"
args = ["server.js", "--port", "1"]

[mcp.tools]
exec = "bin/tools"
`, { 'hooks/guard.sh': '#!/bin/sh\nexit 0\n', 'server.js': 'console.log(1)\n', 'bin/status.sh': 'echo s\n', 'bin/tools/run.sh': 'echo t\n' });
    const r = resolve([team]);
    assert.deepEqual(r.processes.map((p) => [p.id, p.files.map((f) => f.path)]), [
      ['hook.guard', ['hooks/guard.sh']],
      ['mcp.local', ['server.js']],
      ['mcp.tools', ['bin/tools']],
      ['statusline', ['bin/status.sh']],
    ], 'node is on PATH, not a file in the layer; a directory is bound by its digest');
    const before = r.digest;
    assert.equal(resolve([team]).digest, before, 'stable');

    for (const [rel, edit] of [['hooks/guard.sh', '#!/bin/sh\nexit 2\n'], ['server.js', 'console.log(2)\n'], ['bin/status.sh', 'echo t\n'], ['bin/tools/run.sh', 'echo u\n']]) {
      const original = fs.readFileSync(path.join(team, rel), 'utf8');
      fs.writeFileSync(path.join(team, rel), edit);
      assert.notEqual(resolve([team]).digest, before, `editing ${rel} changes the digest`);
      fs.writeFileSync(path.join(team, rel), original);
    }
    assert.equal(resolve([team]).digest, before, 'restored, the same digest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('what is not in the layer is bound by its text only: a command on PATH, an absolute path, a path out of the layer, a shell string', () => {
  const root = tmpdir();
  try {
    const outside = write(root, 'outside.sh', 'echo out\n');
    const team = layer(root, 'team', `[mcp.path]
exec = "db-mcp"

[mcp.abs]
exec = "${outside}"

[mcp.up]
exec = "../outside.sh"

[mcp.sh]
shell = "echo hi"
`);
    const r = resolve([team]);
    assert.deepEqual(r.processes, []);
    const before = r.digest;
    fs.writeFileSync(outside, 'echo changed\n');
    assert.equal(resolve([team]).digest, before, 'a file outside the layer is not content-bound');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the layer that sets the item binds its own file; local.toml binds relative to its directory', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', HOOK, { 'hooks/guard.sh': 'echo base\n' });
    const team = layer(root, 'team', HOOK, { 'hooks/guard.sh': 'echo team\n' });
    const r = resolve([base, team]);
    assert.equal(r.processes[0].layer, 'team');
    const d = r.digest;
    fs.writeFileSync(path.join(base, 'hooks/guard.sh'), 'echo edited base\n');
    assert.equal(resolve([base, team]).digest, d, 'the replaced layer\'s script no longer counts');
    fs.writeFileSync(path.join(team, 'hooks/guard.sh'), 'echo edited team\n');
    assert.notEqual(resolve([base, team]).digest, d);

    const localDir = path.join(root, 'install');
    write(localDir, 'mcp/local.sh', 'echo local\n');
    const local = write(localDir, 'local.toml', '[mcp.mine]\nexec = "mcp/local.sh"\n');
    const withLocal = resolve([team], local);
    assert.deepEqual(withLocal.processes.find((p) => p.id === 'mcp.mine').files.map((f) => f.path), ['mcp/local.sh']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate reports the digest, which moves with an edited hook script', () => {
  const root = tmpdir();
  try {
    const team = layer(root, 'team', HOOK, { 'hooks/guard.sh': 'echo a\n' });
    const digest = () => handle({ protocol: PROTOCOL, op: 'validate', args: { harness: 'claude-code', layers: [team] } }, {}).result.digest;
    const a = digest();
    fs.writeFileSync(path.join(team, 'hooks/guard.sh'), 'echo b\n');
    assert.notEqual(digest(), a);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a path through a symlink in the layer binds the link, never what is past it', () => {
  const root = tmpdir();
  try {
    const outsideDir = path.join(root, 'elsewhere');
    write(outsideDir, 'tool.sh', 'echo outside\n');
    const team = layer(root, 'team', '[mcp.linked]\nexec = "bin/tool.sh"\n');
    fs.symlinkSync(outsideDir, path.join(team, 'bin'));
    const r = resolve([team]);
    assert.deepEqual(r.processes.map((p) => p.files.map((f) => f.path)), [['bin']], 'the link itself, by its target string');
    const before = r.digest;
    fs.writeFileSync(path.join(outsideDir, 'tool.sh'), 'echo changed\n');
    assert.equal(resolve([team]).digest, before, 'nothing past the link is read');
    fs.rmSync(path.join(team, 'bin'));
    const other = path.join(root, 'other');
    write(other, 'tool.sh', 'echo outside\n');
    fs.symlinkSync(other, path.join(team, 'bin'));
    assert.notEqual(resolve([team]).digest, before, 'pointing the link elsewhere changes the digest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a spec with no process file keeps the digest it had before: the key is added only when needed', () => {
  const root = tmpdir();
  try {
    const team = layer(root, 'team', '[mcp.path]\nexec = "db-mcp"\n\n[state]\n', { 'skills/notes/SKILL.md': '---\nname: notes\n---\n' });
    const r = resolve([team]);
    assert.deepEqual(r.processes, []);
    // The digest as §5.1 defined it before 6a.3, computed independently.
    const before = 'sha256:' + createHash('sha256').update(canonical({
      format: SPEC_FORMAT,
      layers: r.layers.map((l) => ({ name: l.name, version: l.version })),
      items: r.items.map((i) => ({ id: i.id, layer: i.layer, value: i.value })),
      permissions: r.permissions,
      agents_md: r.agents_md.map((a) => ({ layer: a.layer, sha256: a.sha256 })),
      files: r.files.map((f) => ({ id: f.id, layer: f.layer, sha256: f.sha256 })),
    })).digest('hex');
    assert.equal(r.digest, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an entry that names the layer itself binds the whole layer: node . with an edited index.js', () => {
  const root = tmpdir();
  try {
    const team = layer(root, 'team', '[mcp.pkg]\nexec = "node"\nargs = ["."]\n', { 'index.js': 'console.log(1)\n', 'package.json': '{"main": "index.js"}\n' });
    const r = resolve([team]);
    assert.deepEqual(r.processes.map((p) => p.files.map((f) => f.path)), [['.']]);
    const before = r.digest;
    fs.writeFileSync(path.join(team, 'index.js'), 'console.log(2)\n');
    assert.notEqual(resolve([team]).digest, before, 'editing index.js changes the digest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
