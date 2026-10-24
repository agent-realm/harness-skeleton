import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/hs.js';
import { PROTOCOL } from '../src/protocol.js';
import { resolve } from '../src/spec/layers.js';
import { agentsMdProblems } from '../src/spec/validate.js';
import { layer, skillMd, tmpdir, write } from './fixtures.js';

function validate(layers, local, harness = 'claude-code') {
  const res = handle({ protocol: PROTOCOL, op: 'validate', args: { harness, layers, ...(local ? { local } : {}) } });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return res.result;
}

const codes = (r) => r.problems.map((p) => p.code).sort();

test('resolve: per-kind merge, provenance, tombstones, file items', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', `
[model.roles]
primary = "toy-model"
small = "toy-model-small"

[mcp.db]
exec = "db-mcp"
env = { DB_HOST = "localhost" }

[mcp.legacy]
exec = "old"

[env]
LANG = "C"

[[permissions.rule]]
action = "deny"
tool = "read"
path_glob = "~/.ssh/**"
`, { 'skills/notes/SKILL.md': 'a', 'agents/reviewer.md': 'r', 'AGENTS.md': 'base rules\n' });
    const team = layer(root, 'team', `
[remove]
items = ["mcp.legacy", "skill.notes"]

[model.roles]
primary = "toy-model-large"

[mcp.db]
exec = "db-mcp-2"

[[permissions.rule]]
action = "allow"
tool = "shell"
argv_prefix = ["git", "diff"]
`, { 'agents/reviewer.md': 'r2', 'AGENTS.md': 'team rules\n' });
    const r = resolve([base, team]);
    assert.deepEqual(r.problems, []);
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    assert.deepEqual([byId['model.roles.primary'].value, byId['model.roles.primary'].layer], ['toy-model-large', 'team']);
    assert.deepEqual([byId['model.roles.small'].value, byId['model.roles.small'].layer], ['toy-model-small', 'base']);
    // a later layer replaces the whole keyed item, never a field of it
    assert.deepEqual({ ...byId['mcp.db'].value }, { exec: 'db-mcp-2' }); // smol-toml tables have a null prototype
    assert.equal(byId['mcp.legacy'], undefined);
    assert.deepEqual(r.removed.map((x) => x.id).sort(), ['mcp.legacy', 'skill.notes']);
    assert.ok(r.replaced.some((x) => x.id === 'mcp.db' && x.by === 'team' && x.from === 'base'));
    assert.deepEqual(r.files.map((f) => [f.id, f.layer]), [['agent.reviewer', 'team']]);
    assert.deepEqual(r.permissions.map((p) => p.layer), ['base', 'team']);
    assert.deepEqual(r.agents_md.map((a) => a.layer), ['base', 'team']);
    assert.match(r.digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolve: the digest is stable, ignores key order, and moves with content and provenance', () => {
  const root = tmpdir();
  try {
    const a = layer(root, 'a', '[mcp.x]\nexec = "x"\nargs = ["1"]\n', { 'skills/s/SKILL.md': 'one' });
    const d1 = resolve([a]).digest;
    assert.equal(resolve([a]).digest, d1);
    write(a, 'spec.toml', '[spec]\nformat = "0.2"\nversion = "1.0.0"\nname = "a"\n[mcp.x]\nargs = ["1"]\nexec = "x"\n');
    assert.equal(resolve([a]).digest, d1, 'key order does not matter');
    write(a, 'skills/s/SKILL.md', 'two');
    assert.notEqual(resolve([a]).digest, d1, 'a skill file change moves the digest');
    const b = layer(root, 'b', '[mcp.x]\nexec = "x"\nargs = ["1"]\n', { 'skills/s/SKILL.md': 'two' });
    assert.notEqual(resolve([b]).digest, resolve([a]).digest, 'another layer setting the same content is another spec');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: a clean spec, with refs declared and bound', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', `
[refs.SENTRY_TOKEN]
description = "Sentry MCP token"

[mcp.sentry]
url = "https://mcp.sentry.dev/mcp"
bearer_ref = "SENTRY_TOKEN"
`);
    const local = write(root, 'local.toml', '[refs]\nSENTRY_TOKEN = "keychain:example/sentry-token"\n\n[state]\nretention_days = 9000\n');
    const r = validate([base], local);
    assert.equal(r.valid, true, JSON.stringify(r.problems));
    assert.deepEqual(r.layers.map((l) => [l.name, l.local]), [['base', false], ['local', true]]);
    assert.ok(!r.unchecked_kinds.includes('mcp'), 'MCP items are validated since 6a.4');
    assert.doesNotMatch(JSON.stringify(r), /keychain:example/, 'validate lists items, never their values');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: unbound, undeclared, and a binding that is not a reference, never echoed', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', `
[refs.DB_PASSWORD]
description = "db"
[refs.SENTRY_TOKEN]
description = "sentry"

[mcp.db]
exec = "db-mcp"
env_refs = { DB_PASS = "DB_PASSWORD" }

[hook.guard]
event = "PreToolUse"
run = { exec = "hooks/guard.sh", env_refs = { K = "GUARD_KEY" } }
`);
    const local = write(root, 'local.toml', '[refs]\nDB_PASSWORD = "sk-live-PASTED-SECRET-0123"\n');
    const r = validate([base], local);
    assert.equal(r.valid, false);
    assert.deepEqual(codes(r), ['ref_not_reference', 'ref_unbound', 'ref_undeclared']);
    assert.equal(r.problems.find((p) => p.code === 'ref_unbound').item, 'refs.SENTRY_TOKEN');
    assert.equal(r.problems.find((p) => p.code === 'ref_undeclared').item, 'hook.guard');
    assert.doesNotMatch(JSON.stringify(r), /PASTED-SECRET/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: install-local items outside local.toml', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', `
[state]
retention_days = 3

[endpoints.anthropic-messages]
base_url = "https://gateway.example/anthropic"

[login]
mode = "endpoint"

[refs]
X = "keychain:example/x"
`);
    const r = validate([base]);
    const misplaced = r.problems.filter((p) => p.code === 'install_local_misplaced').map((p) => p.item).sort();
    assert.deepEqual(misplaced, ['binding.X', 'endpoints.anthropic-messages', 'login.mode', 'state.retention_days']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: [state] values, and what the harness cannot express', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', '');
    let local = write(root, 'local.toml', '[state]\nretention_days = 0\nsessions = "maybe"\nkeep_forever = true\n');
    let r = validate([base], local);
    assert.deepEqual(codes(r), ['state_value_invalid', 'state_value_invalid', 'state_value_invalid']);

    local = write(root, 'local.toml', '[state]\nprompt_history = "none"\n');
    r = validate([base], local);
    assert.equal(r.valid, true, 'unexpressible state is a warning: state items are if-supported');
    assert.deepEqual(r.problems.map((p) => [p.code, p.severity]), [['state_unexpressible', 'warning']]);
    assert.match(r.problems[0].message, /also stops transcripts/);

    local = write(root, 'local.toml', '[state]\nretention_days = 90\n');
    r = validate([base], local, 'codex');
    assert.deepEqual(r.problems.map((p) => p.code), ['state_unexpressible']);
    assert.equal(validate([base], write(root, 'local.toml', '[state]\nprompt_history = "none"\n'), 'codex').problems.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: AGENTS.md without @imports or block comments, outside fences and spans', () => {
  const text = [
    '# Rules',
    'See @docs/style.md for style.',           // 2: import
    'Mail me at someone@example.com.',          // not an import
    'Use `@decorator` syntax.',                 // inside a code span
    '<!-- hidden -->',                          // 5: block comment
    '```',
    '@not/an/import',
    '<!-- in a fence -->',
    '```',
    '@final',                                   // 10: import
  ].join('\n');
  assert.deepEqual(agentsMdProblems(text), { imports: [2, 10], comments: [5] });

  const root = tmpdir();
  try {
    const base = layer(root, 'base', '', { 'AGENTS.md': text });
    const r = validate([base]);
    assert.deepEqual(codes(r), ['agents_md_comment', 'agents_md_import']);
    assert.deepEqual(r.problems.find((p) => p.code === 'agents_md_import').lines, [2, 10]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: header, format, duplicate names, bad TOML without excerpts, unknown kinds', () => {
  const root = tmpdir();
  try {
    const noHeader = path.join(root, 'nohead');
    write(noHeader, 'spec.toml', '[mcp.x]\nexec = "x"\n');
    const future = path.join(root, 'future');
    write(future, 'spec.toml', '[spec]\nname = "future"\nversion = "1.0.0"\nformat = "0.9"\n');
    const broken = path.join(root, 'broken');
    write(broken, 'spec.toml', 'token = TOP_SECRET_VALUE\n');
    const one = layer(root, 'same', '[mystery]\nx = 1\n');
    const two = path.join(root, 'same-again');
    write(two, 'spec.toml', '[spec]\nname = "same"\nversion = "1.0.0"\nformat = "0.2"\n');
    const r = validate([noHeader, future, broken, one, two]);
    assert.deepEqual(codes(r), ['format_unsupported', 'layer_name_duplicate', 'layer_unreadable', 'spec_header_missing', 'unknown_kind']);
    assert.match(r.problems.find((p) => p.code === 'layer_unreadable').message, /not TOML \(line 1, column \d+\)/);
    assert.doesNotMatch(JSON.stringify(r), /TOP_SECRET/);
    assert.equal(r.problems.find((p) => p.code === 'unknown_kind').severity, 'warning');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: layers must be absolute; a missing local.toml is reported', () => {
  let res = handle({ protocol: PROTOCOL, op: 'validate', args: { harness: 'claude-code', layers: ['relative'] } });
  assert.equal(res.error.code, 'bad_request');
  const root = tmpdir();
  try {
    const r = validate([layer(root, 'base', '')], path.join(root, 'nope.toml'));
    assert.deepEqual(codes(r), ['layer_unreadable']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolve: the digest does not depend on the locale; ids sort by code unit', () => {
  const root = tmpdir();
  try {
    const dir = layer(root, 'base', '[env]\nia = "1"\nIB = "2"\nib = "3"\nIA = "4"\n');
    const layersJs = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'spec', 'layers.js');
    const script = `import(${JSON.stringify(layersJs)}).then((m) => { const r = m.resolve([${JSON.stringify(dir)}]); console.log(JSON.stringify([r.digest, r.items.map((i) => i.id)])); })`;
    const run = (locale) => {
      const p = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, LC_ALL: locale, LANG: locale }, encoding: 'utf8' });
      assert.equal(p.status, 0, p.stderr);
      return JSON.parse(p.stdout);
    };
    const en = run('en_US.UTF-8');
    const tr = run('tr_TR.UTF-8');
    assert.equal(tr[0], en[0]);
    assert.deepEqual(en[1], ['env.IA', 'env.IB', 'env.ia', 'env.ib']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolve: file digests cover bytes, so binary assets that differ never share one', () => {
  const root = tmpdir();
  try {
    const a = layer(root, 'a', '');
    const b = layer(root, 'b', '');
    write(a, 'skills/s/SKILL.md', 'x');
    write(b, 'skills/s/SKILL.md', 'x');
    fs.writeFileSync(path.join(a, 'skills/s/icon.bin'), Buffer.from([0xff]));
    fs.writeFileSync(path.join(b, 'skills/s/icon.bin'), Buffer.from([0xfe]));
    assert.notEqual(resolve([a]).files[0].sha256, resolve([b]).files[0].sha256);
    write(a, 'AGENTS.md', '');
    fs.writeFileSync(path.join(a, 'AGENTS.md'), Buffer.from([0x80]));
    const d1 = resolve([a]).agents_md[0].sha256;
    fs.writeFileSync(path.join(a, 'AGENTS.md'), Buffer.from([0x81]));
    assert.notEqual(resolve([a]).agents_md[0].sha256, d1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: install-local placement is caught even when a later layer or a tombstone hides it', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', '[state]\nretention_days = 3\n\n[login]\nmode = "isolated"\n');
    const top = layer(root, 'top', '[remove]\nitems = ["login"]\n');
    const local = write(root, 'local.toml', '[state]\nretention_days = 9000\n');
    const r = validate([base, top], local);
    assert.deepEqual(r.problems.filter((p) => p.code === 'install_local_misplaced').map((p) => [p.item, p.layer]).sort(),
      [['login.mode', 'base'], ['state.retention_days', 'base']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: permissions and file kinds count as unchecked', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', '[[permissions.rule]]\naction = "deny"\ntool = "read"\npath_glob = "~/.ssh/**"\n',
      { 'skills/s/SKILL.md': skillMd('s'), 'agents/a.md': 'x', 'commands/c.md': 'x' });
    assert.deepEqual(validate([base]).unchecked_kinds, ['agent', 'command', 'permissions'], 'skills are checked since milestone 3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: a [state] value never appears in a message', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', '');
    let r = validate([base], write(root, 'local.toml', '[state]\nretention_days = "PASTED-SECRET-XYZ"\n'), 'codex');
    assert.deepEqual(codes(r), ['state_value_invalid'], 'an invalid value is not also checked for expressibility');
    assert.doesNotMatch(JSON.stringify(r), /PASTED-SECRET/);
    r = validate([base], write(root, 'local.toml', '[state]\nretention_days = 4321\n'), 'codex');
    assert.deepEqual(codes(r), ['state_unexpressible']);
    assert.doesNotMatch(JSON.stringify(r), /4321/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: a fence closes only on a run of the same character at least as long', () => {
  const text = ['````', '```', '@inside', '````', '@outside', '~~~', '```', '@inside-tilde', '~~~ ', '@after'].join('\n');
  assert.deepEqual(agentsMdProblems(text), { imports: [5, 10], comments: [] });
});

test('resolve: __proto__ and constructor keys are refused', () => {
  const root = tmpdir();
  try {
    const dir = path.join(root, 'evil');
    write(dir, 'spec.toml', '[spec]\nname = "evil"\nversion = "1"\nformat = "0.2"\n[mcp.__proto__]\nexec = "x"\n');
    const r = resolve([dir]);
    assert.deepEqual(r.problems.map((p) => p.code), ['layer_unreadable']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate: a skill\'s frontmatter name equals its directory (§5.7)', () => {
  const root = tmpdir();
  try {
    const base = layer(root, 'base', '', {
      'skills/good/SKILL.md': skillMd('good'),
      'skills/quoted/SKILL.md': '---\nname: "quoted"\ndescription: q\n---\nbody\n',
      'skills/renamed/SKILL.md': skillMd('other-name'),
      'skills/bare/SKILL.md': 'no frontmatter\n',
      'skills/empty/README.md': 'no SKILL.md\n',
    });
    const r = validate([base]);
    assert.deepEqual(r.problems.map((p) => [p.code, p.item]).sort(), [
      ['skill_malformed', 'skill.bare'], ['skill_malformed', 'skill.empty'], ['skill_name_mismatch', 'skill.renamed'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
