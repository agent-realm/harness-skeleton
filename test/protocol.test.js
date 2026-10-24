import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IMPLEMENTED, handle } from '../src/hs.js';
import { OPS, PROTOCOL, parseRequest } from '../src/protocol.js';
import { DEFAULT_RETENTION_DAYS } from '../src/defaults.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hs = path.join(repo, 'bin', 'hs.js');

test('envelope: request_id is echoed, the protocol is checked', () => {
  let res = handle({ protocol: PROTOCOL, request_id: 'r-1', op: 'describe', args: { harness: 'claude-code' } });
  assert.equal(res.ok, true);
  assert.equal(res.request_id, 'r-1');
  assert.equal(res.protocol, PROTOCOL);
  res = handle({ protocol: 'hs/0.1', request_id: 'r-2', op: 'describe', args: {} });
  assert.deepEqual([res.ok, res.error.code, res.request_id], [false, 'protocol_unsupported', 'r-2']);
});

test('envelope: bad requests are typed errors', () => {
  assert.throws(() => parseRequest('{'), { code: 'bad_request' });
  assert.throws(() => parseRequest('[]'), { code: 'bad_request' });
  const cases = [
    [{ protocol: PROTOCOL, op: 7 }, 'bad_request'],
    [{ protocol: PROTOCOL, op: 'describe', args: [] }, 'bad_request'],
    [{ protocol: PROTOCOL, op: 'describe', args: {} }, 'bad_request'],
    [{ protocol: PROTOCOL, op: 'describe', args: { harness: 'nope' } }, 'harness_unknown'],
    [{ protocol: PROTOCOL, op: 'frobnicate', args: {} }, 'op_unknown'],
  ];
  for (const [req, code] of cases) assert.equal(handle(req).error.code, code, JSON.stringify(req));
});

test('every op of §7.1 outside this build answers not_implemented', () => {
  assert.deepEqual([...IMPLEMENTED].sort(), ['apply', 'describe', 'detect', 'launch-spec', 'observe', 'plan', 'recover', 'remove', 'sessions.derive', 'sessions.list', 'sessions.read', 'validate']);
  for (const op of OPS.filter((o) => !IMPLEMENTED.includes(o))) {
    const res = handle({ protocol: PROTOCOL, op, args: { harness: 'claude-code' } });
    assert.equal(res.error.code, 'not_implemented', op);
  }
});

test('describe: protocols, no profile claimed yet, path classes and the skeleton default', () => {
  const r = handle({ protocol: PROTOCOL, op: 'describe', args: { harness: 'claude-code' } }).result;
  assert.deepEqual(r.protocols, [PROTOCOL]);
  assert.equal(r.conformance_profile, null);
  assert.ok(r.not_implemented.includes('import'));
  assert.deepEqual(r.delivery_modes, ['materialize', 'overlay']);
  assert.equal(r.defaults.retention_days.value, DEFAULT_RETENTION_DAYS);
  assert.ok(r.path_classes.every((p) => p.class && p.source), 'every path rule has a class and a source');
  assert.ok(r.capabilities.every((c) => c.evidence === null && c.readiness === 'untested'), 'nothing is certified before a conformance run');
});

test('the retention default is set in one place only', () => {
  const offenders = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js') && /\b9999\b/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(repo, p));
    }
  };
  walk(path.join(repo, 'src'));
  walk(path.join(repo, 'bin'));
  assert.deepEqual(offenders, ['src/defaults.js']);
});

test('cli: flags build the same request; stdin takes an envelope; exit codes', () => {
  let p = spawnSync(process.execPath, [hs, 'describe', '--harness', 'claude-code'], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).result.harness, 'claude-code');

  p = spawnSync(process.execPath, [hs], { input: JSON.stringify({ protocol: PROTOCOL, request_id: 'x', op: 'import', args: {} }), encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.equal(JSON.parse(p.stdout).error.code, 'not_implemented');

  p = spawnSync(process.execPath, [hs], { input: 'not json', encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.equal(JSON.parse(p.stdout).error.code, 'bad_request');

  p = spawnSync(process.execPath, [hs, 'describe', '--bogus'], { encoding: 'utf8' });
  assert.equal(p.status, 2);
});
