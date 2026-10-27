// The examples (examples/<nn>-*/) run as their READMEs say: `node examples/<dir>/<script>.js` from
// the package directory, against the package's own fixtures, and exit 0. What they print does not
// depend on the machine: no scratch path, home directory, host name or checkout path, and the same
// output on a second run. Each run gets its own TMPDIR, which must be empty again afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXAMPLES = path.join(PKG, 'examples');
const examples = fs.readdirSync(EXAMPLES).filter((d) => /^\d\d-/.test(d)).sort();

// The one script of an example, as its README runs it: relative to the package directory.
function scriptOf(d) {
  const js = fs.readdirSync(path.join(EXAMPLES, d)).filter((f) => f.endsWith('.js'));
  assert.equal(js.length, 1, `${d} has exactly one script`);
  return path.posix.join('examples', d, js[0]);
}

// On Node 22, loading node:sqlite prints an ExperimentalWarning. It is Node's, not the example's.
const stderrOf = (r) => r.stderr.split('\n').filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l)).join('\n');

const MACHINE = [...new Set([os.tmpdir(), fs.realpathSync.native(os.tmpdir()), os.homedir(), os.hostname(), PKG])]
  .filter((s) => s && s.length >= 4);

// Run one example with a fresh TMPDIR and HOME; return its result, and check what it left behind.
function run(args) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-examples-test-')));
  try {
    const r = spawnSync(process.execPath, args, { cwd: PKG, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp } });
    const left = fs.readdirSync(tmp);
    return { ...r, tmp, left };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('examples: every one has a README and one script, numbered from 01 without gaps, the index lists it, and none ships', () => {
  assert.ok(examples.length >= 5);
  examples.forEach((d, i) => {
    assert.equal(d.slice(0, 2), String(i + 1).padStart(2, '0'), d);
    assert.ok(fs.existsSync(path.join(EXAMPLES, d, 'README.md')), `${d}/README.md`);
    const readme = fs.readFileSync(path.join(EXAMPLES, d, 'README.md'), 'utf8');
    assert.ok(readme.includes(`node ${scriptOf(d)}`), `${d}/README.md shows how to run ${scriptOf(d)}`);
  });
  const index = fs.readFileSync(path.join(EXAMPLES, 'README.md'), 'utf8');
  for (const d of examples) assert.ok(index.includes(`(${d}/)`), `examples/README.md lists ${d}`);
  // The examples need fixtures/ and conformance/, which do not ship: so they do not ship either.
  const { files } = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  for (const f of files) assert.ok(!/^(examples|fixtures|conformance)\b/.test(f), `package.json "files" lists ${f}`);
});

for (const d of examples) {
  test(`examples: ${d} exits 0, prints nothing machine-specific, the same twice, and cleans up`, () => {
    const a = run([scriptOf(d)]);
    assert.equal(a.status, 0, `${d}:\n${a.stdout}\n${a.stderr}`);
    assert.equal(stderrOf(a), '', `${d} wrote to stderr`);
    assert.ok(a.stdout.trim().length > 0, `${d} printed something`);
    assert.deepEqual(a.left, [], `${d} left files in its TMPDIR`);
    for (const s of [...MACHINE, a.tmp]) assert.ok(!a.stdout.includes(s), `${d} printed ${s}`);
    const b = run([scriptOf(d)]);
    assert.equal(b.stdout, a.stdout, `${d} printed something else on a second run`);
  });
}

test('examples: 05-full-pass writes one record per line, as many as it reports', () => {
  const out = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-examples-out-')));
  try {
    const file = path.join(out, 'records.jsonl');
    const r = run([scriptOf('05-full-pass'), file]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const n = Number(/^(\d+) records written as JSON Lines$/m.exec(r.stdout)?.[1]);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
    assert.ok(n > 0);
    assert.equal(lines.length, n);
    const types = new Set(lines.map((l) => JSON.parse(l).type));
    for (const t of ['session', 'message', 'usage', 'link', 'lifecycle']) assert.ok(types.has(t), `a ${t} record`);
    assert.ok(!r.stdout.includes(file), 'the output path is not printed');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('examples: an unknown harness or fixture case ends with the choices, exit 2', () => {
  const h = run([scriptOf('02-list-sessions'), 'no-such-harness']);
  assert.equal(h.status, 2);
  assert.match(h.stderr, /no adapter for no-such-harness: one of claude-code, /);
  const c = run([scriptOf('03-read-and-derive'), 'zed', 'no-such-case']);
  assert.equal(c.status, 2);
  assert.match(c.stderr, /no fixture case zed\/no-such-case: one of features, /);
});
