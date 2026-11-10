// The Agent Plugins format as the spec package reads it (design note §5.7, [AP]): what a package
// holds, every way it breaks the format, and the two questions a route asks of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cwdBeyondRoot, cwdPlace, frontmatter, literalText, pluginNameValid, readPackage, schemaVersion, skillProblems } from '@agent-realm/skeleton-spec/agent-plugins';

const PLUGIN = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

function pkgDir(files) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'skel-ap-')));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}
const skill = (name, description = `${name} skill`) => `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`;
const codes = (r) => r.problems.map((p) => p.code);

test('a valid package: its name, both versions, its skills; no problems', () => {
  const dir = pkgDir({
    'plugin.json': { $schema: PLUGIN, name: 'notes.kit', version: '1.2.0', author: { name: 'A' }, keywords: ['x'] },
    'skills/notes/SKILL.md': skill('notes'),
    'skills/README.md': 'not a skill',
    'skills/deep/inner/SKILL.md': skill('inner'),
    'mcp.json': { $schema: MCP, mcpServers: {
      local: { type: 'stdio', command: './bin/run', args: ['${PLUGIN_ROOT}/x'], env: { D: '${PLUGIN_DATA}' }, cwd: '${PLUGIN_ROOT}' },
      remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Team': 'a' } },
      dev: { type: 'sse', url: 'http://127.0.0.1:9/sse' },
    } },
  });
  try {
    const r = readPackage(dir);
    assert.deepEqual(r.problems, []);
    assert.equal(r.name, 'notes.kit');
    assert.equal(r.version, '1.0.0');
    assert.equal(r.mcp_version, '1.0.0');
    // `deep` has no SKILL.md of its own, and the format never searches deeper [AP §7.1].
    assert.deepEqual(r.skills.map((s) => s.dir), ['notes']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the manifest: missing, not JSON, no $schema, a bad name, a mistyped metadata field are plugin_malformed; an unknown field is a warning', () => {
  const cases = [
    [{}, /no plugin.json/],
    [{ 'plugin.json': '{not json' }, /not JSON/],
    [{ 'plugin.json': { name: 'a' } }, /no \$schema/],
    [{ 'plugin.json': { $schema: PLUGIN, name: 'Bad--Name' } }, /name is not/],
    [{ 'plugin.json': { $schema: PLUGIN, name: 'a', keywords: 'x' } }, /keywords is not a list of strings/],
    [{ 'plugin.json': { $schema: PLUGIN, name: 'a', author: { name: 'n', phone: '1' } } }, /author is not an object/],
  ];
  for (const [files, re] of cases) {
    const dir = pkgDir(files);
    try {
      const r = readPackage(dir);
      assert.ok(r.problems.some((p) => p.code === 'plugin_malformed' && re.test(p.message)), `${re}: ${JSON.stringify(r.problems)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = pkgDir({ 'plugin.json': { $schema: PLUGIN, name: 'a', colour: 'value-7f3a', extensions: 'x' } });
  try {
    const r = readPackage(dir);
    assert.deepEqual(r.problems.map((p) => [p.code, p.severity]), [['plugin_field_unknown', 'warning'], ['plugin_field_unknown', 'warning']]);
    assert.ok(!r.problems.some((p) => p.message.includes('value-7f3a')), 'no value is echoed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a version is read from the canonical $schema only; anything else names none', () => {
  assert.equal(schemaVersion(PLUGIN, 'plugin'), '1.0.0');
  assert.equal(schemaVersion('https://agent-plugins.org/schemas/9.9.9/plugin.schema.json', 'plugin'), '9.9.9');
  assert.equal(schemaVersion(MCP, 'plugin'), null, 'the mcp schema is not the manifest\'s');
  assert.equal(schemaVersion('http://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'plugin'), null);
  assert.equal(schemaVersion(1, 'plugin'), null);
});

test('plugin names follow [AP §5.5]', () => {
  for (const n of ['a', 'a.b-c', 'x1', 'a'.repeat(64)]) assert.ok(pluginNameValid(n), n);
  for (const n of ['', 'A', '-a', 'a-', 'a--b', 'a..b', '.a', 'a b', 'a/b', 'a'.repeat(65), 7]) assert.ok(!pluginNameValid(n), String(n));
});

test('skills: the Agent Skills rules, each refusal plugin_skill_invalid naming the skill', () => {
  assert.deepEqual(skillProblems(skill('notes'), 'notes'), []);
  assert.deepEqual(skillProblems('no frontmatter', 'x'), ['SKILL.md has no frontmatter']);
  assert.match(skillProblems(skill('Notes'), 'Notes')[0], /lowercase/);
  assert.match(skillProblems(skill('a--b'), 'a--b')[0], /single hyphens/);
  assert.match(skillProblems(skill('other'), 'notes')[0], /differs from its directory/);
  assert.match(skillProblems('---\nname: notes\n---\n', 'notes')[0], /description/);
  assert.match(skillProblems(skill('notes', 'x'.repeat(1025)), 'notes')[0], /description/);
  assert.match(skillProblems(`---\nname: n\ndescription: d\ncompatibility: ${'c'.repeat(501)}\n---\n`, 'n')[0], /compatibility/);
  // Block scalars and quotes are read as YAML writes them.
  assert.deepEqual(skillProblems('---\nname: "notes"\ndescription: >\n  folded\n  text\n---\n', 'notes'), []);
  assert.deepEqual(skillProblems("---\nname: notes\ndescription: 'it''s'\n---\n", 'notes'), []);
  assert.match(skillProblems('---\nname: notes\ndescription:\n  key: v\n---\n', 'notes')[0], /description/, 'a mapping is not a description');

  const dir = pkgDir({ 'plugin.json': { $schema: PLUGIN, name: 'a' }, 'skills/no-desc/SKILL.md': '---\nname: no-desc\n---\n', 'skills/ok/SKILL.md': skill('ok') });
  try {
    const r = readPackage(dir);
    assert.deepEqual(r.problems.map((p) => [p.code, p.skill]), [['plugin_skill_invalid', 'no-desc']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('frontmatter: plain, quoted, folded and literal values; a list or mapping is not a string', () => {
  const fm = frontmatter('---\na: plain # comment\nb: "q"\nc: |\n  l1\n  l2\nd: >-\n  f1\n  f2\ne:\n  - x\nf: [1]\ng: two\n  lines\n---\nbody');
  assert.deepEqual(fm, { a: 'plain', b: 'q', c: 'l1\nl2', d: 'f1 f2', e: null, f: null, g: 'two lines' });
  assert.equal(frontmatter('no frontmatter'), null);
});

test('mcp.json: each closed variant [AP §7.2.1]; a breach is plugin_malformed naming the server, never its value', () => {
  const bad = {
    a: { type: 'stdio', command: 'node srv-5c1e.js' },
    b: { type: 'stdio', command: './../out' },
    c: { type: 'stdio', command: 'bin/x' },
    d: { type: 'stdio', command: 'x', env: { PLUGIN_ROOT: '/r' } },
    e: { type: 'stdio', command: 'x', cwd: '/tmp' },
    f: { type: 'stdio', command: 'x', url: 'https://example.com' },
    g: { type: 'streamable-http', url: 'http://example.com/mcp' },
    h: { type: 'sse', url: 'https://user:pw-9d2b@example.com/mcp' },
    i: { type: 'sse', url: 'https://example.com/mcp#frag-4e8a' },
    j: { type: 'websocket', url: 'wss://example.com' },
    k: { type: 'stdio', command: './' },
  };
  const dir = pkgDir({ 'plugin.json': { $schema: PLUGIN, name: 'a' }, 'mcp.json': { $schema: MCP, mcpServers: bad, extra: 1 } });
  try {
    const r = readPackage(dir);
    assert.ok(r.problems.every((p) => p.code === 'plugin_malformed'));
    for (const id of Object.keys(bad)) assert.ok(r.problems.some((p) => p.message.includes(`server "${id}"`)), id);
    assert.ok(r.problems.some((p) => /"extra"/.test(p.message)));
    assert.ok(!r.problems.some((p) => /pw-9d2b|frag-4e8a|srv-5c1e/.test(p.message)), 'no value is echoed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const none = pkgDir({ 'plugin.json': { $schema: PLUGIN, name: 'a' }, 'mcp.json': { mcpServers: {} } });
  try {
    assert.deepEqual(codes(readPackage(none)), ['plugin_malformed']);
  } finally {
    fs.rmSync(none, { recursive: true, force: true });
  }
});

test('literal text: every ${ the format does not expand, by server and field; the two placeholders are not counted', () => {
  const mcp = { mcpServers: {
    clean: { type: 'stdio', command: 'x', args: ['${PLUGIN_ROOT}/a', '--d=${PLUGIN_DATA}'], env: { D: '${PLUGIN_DATA}/x' } },
    env: { type: 'stdio', command: 'x', env: { TOKEN: '${HOME}' } },
    arg: { type: 'stdio', command: 'x', args: ['${PLUGIN_ROOT}${OTHER}'] },
    name: { type: 'stdio', command: 'x', env: { '${K}': 'v' } },
    remote: { type: 'sse', url: 'https://example.com/${P}', headers: { A: '${TOKEN}' } },
  } };
  assert.deepEqual(literalText(mcp), [
    { server: 'env', where: 'env "TOKEN"' },
    { server: 'arg', where: 'args[0]' },
    { server: 'name', where: 'an env name' },
    { server: 'remote', where: 'url' },
    { server: 'remote', where: 'a header value' },
  ]);
  assert.deepEqual(literalText(null), []);
});

test('cwd: omitted, ${PLUGIN_ROOT}, ${PLUGIN_ROOT}/ and ./ are the root; anything else is beyond it', () => {
  assert.deepEqual(cwdPlace(undefined), { base: 'root', rel: '' });
  for (const c of ['${PLUGIN_ROOT}', '${PLUGIN_ROOT}/', './', './.']) assert.deepEqual(cwdPlace(c), { base: 'root', rel: '' }, c);
  assert.deepEqual(cwdPlace('./sub/'), { base: 'root', rel: 'sub' });
  assert.deepEqual(cwdPlace('${PLUGIN_DATA}/w'), { base: 'data', rel: 'w' });
  for (const c of ['/tmp', '${PLUGIN_ROOT}x', './../up', '.', '${HOME}']) assert.equal(cwdPlace(c), null, c);
  const mcp = { mcpServers: {
    a: { type: 'stdio', command: 'x' }, b: { type: 'stdio', command: 'x', cwd: '${PLUGIN_ROOT}' },
    c: { type: 'stdio', command: 'x', cwd: './sub' }, d: { type: 'stdio', command: 'x', cwd: '${PLUGIN_DATA}' },
  } };
  assert.deepEqual(cwdBeyondRoot(mcp), ['c', 'd']);
});
