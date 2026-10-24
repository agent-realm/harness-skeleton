// The conformance runner: the adapter-side checks of sessions v1 and sessions-model v1, run
// against a fixture harness store. Every check copies the fixture to a temp directory first; a
// fixture is never written.
//
// A fixture case is a directory with:
//   store/          a harness store tree, bound as `harness_path`
//   expected.json   the folded final records of every session, as `project()` prints them

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MiniEngine } from './engine.js';
import { recordKey } from '../src/records.js';
import { hostFromMachineId } from '../src/host.js';

// A synthetic machine id; the fixtures never carry a real one.
export const FIXTURE_HOST = hostFromMachineId('00000000000040008000000000000001');

export function tmpStore(prefix = 'sa-conf-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

export function filesOf(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

export function storeOf(adapter, harnessPath) {
  return { host: FIXTURE_HOST, harness: adapter.HARNESS, harness_path: harnessPath };
}

// The records of every session, sorted by type and key, without the fields that depend on where
// the fixture was copied: `host`, `harness_path`, and `content_sha` (which hashes both).
export function project(views) {
  const out = {};
  for (const sid of Object.keys(views).sort()) {
    out[sid] = [...views[sid].values()]
      .sort((a, b) => (a.type + '\u0000' + recordKey(a) < b.type + '\u0000' + recordKey(b) ? -1 : 1))
      .map(({ host: _h, harness_path: _p, content_sha: _c, ...r }) => r);
  }
  return out;
}

function compareViews(a, b) {
  const pa = JSON.stringify(project(a));
  const pb = JSON.stringify(project(b));
  return pa === pb;
}

// Full replay: one pass of a fresh engine over the whole store.
export function fullReplay(adapter, harnessPath) {
  const e = new MiniEngine(adapter, storeOf(adapter, harnessPath));
  e.pass();
  return e;
}

// Grow every file of the fixture from empty to whole in `steps` passes, each file cut at the same
// fraction of its length, so cuts land inside lines too. The final view must equal the full
// replay (sessions-model §3: every incremental path folds to the same state), a further pass must
// read `unchanged` everywhere, and no partial line may ever be returned.
export function growthCheck(adapter, fixtureStore, { steps = 24 } = {}) {
  const dir = tmpStore();
  try {
    const files = filesOf(fixtureStore).map((rel) => ({ rel, data: fs.readFileSync(path.join(fixtureStore, rel)) }));
    for (const f of files) fs.mkdirSync(path.dirname(path.join(dir, f.rel)), { recursive: true });
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    for (let t = 1; t <= steps; t++) {
      for (const f of files) {
        const cut = t === steps ? f.data.length : Math.floor((f.data.length * t) / steps);
        fs.writeFileSync(path.join(dir, f.rel), f.data.subarray(0, cut));
      }
      e.pass();
    }
    const whole = fullReplay(adapter, dir);
    const equal = compareViews(e.views(), whole.views());
    e.pass();
    const notUnchanged = e.log.filter((l) => l.continuity !== 'unchanged');
    return { equal, notUnchanged, incremental: project(e.views()), full: project(whole.views()) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Negative control: rewrite one stream file shorter, through a new inode, between two passes.
// The read must be `reset`, and the re-derived view must equal a full replay of the shorter
// store: exactly the vanished keys are gone.
export function rewriteCheck(adapter, fixtureStore, rel, keepLines) {
  const dir = tmpStore();
  try {
    copyTree(fixtureStore, dir);
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    e.pass();
    const file = path.join(dir, rel);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
    const tmp = `${file}.rewrite`;
    fs.writeFileSync(tmp, lines.slice(0, keepLines).map((l) => l + '\n').join(''));
    fs.renameSync(tmp, file);
    e.pass();
    const continuity = e.log.find((l) => file.endsWith(l.source_key))?.continuity;
    const whole = fullReplay(adapter, dir);
    return { continuity, equal: compareViews(e.views(), whole.views()) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// An exemption path matches the value's path exactly or as a suffix; `[]` in it matches any
// array index (`parameters[].key` covers `parameters[3].key`).
function matchesPath(p, e) {
  const norm = p.replace(/\[\d+\]/g, '[]');
  return norm === e || norm.endsWith('.' + e);
}

// sessions-model §4.3: string values under a secret-looking key name, outside every declared
// path and exemption. Numbers are exempt by definition, and so are key names themselves.
const SECRETISH = /key|token|secret|auth|password|credential|cookie|csrf/i;
export function nameLint(value, exempt = [], at = '') {
  const hits = [];
  const walk = (v, p, name) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`, name));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, k);
    else if (typeof v === 'string' && name && SECRETISH.test(name) && v !== '' && !/^<redacted len=\d+>$/.test(v)
      && !exempt.some((e) => matchesPath(p, e) || name === e)) hits.push(`${at}${p}`);
  };
  walk(value, '', '');
  return hits;
}
