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
// `units: false` leaves each record's `units` out; `units: 'keys'` keeps each triple's source_key
// and unit_key only. A generation is the engine's count of a source's resets, so two engines that
// read a source through different resets number it differently (staleUnits checks it instead).
// A source keyed by an absolute path beside a file-bound harness store (OpenCode's spilled
// `tool-output/`, sessions §1) is written `<harness dir>/…`, as `harness_path` itself is left out:
// a golden holds no machine's path.
export function project(views, { units = true } = {}) {
  const out = {};
  for (const sid of Object.keys(views).sort()) {
    out[sid] = [...views[sid].values()]
      .sort((a, b) => (a.type + '\u0000' + recordKey(a) < b.type + '\u0000' + recordKey(b) ? -1 : 1))
      .map(({ host: _h, harness_path: hp, content_sha: _c, units: u, ...r }) => {
        if (!units || u === undefined) return r;
        const dir = typeof hp === 'string' ? path.dirname(hp) + path.sep : null;
        const rel = (x) => (dir && x.startsWith(dir) ? `<harness dir>/${x.slice(dir.length).split(path.sep).join('/')}` : x);
        return { ...r, units: u.map(([sk, g, uk]) => (units === 'keys' ? [rel(sk), rel(uk)] : [rel(sk), g, rel(uk)])) };
      });
  }
  return out;
}

function compareViews(a, b, opts) {
  const pa = JSON.stringify(project(a, opts));
  const pb = JSON.stringify(project(b, opts));
  return pa === pb;
}

// The units triples of an engine's views that name no unit its sources hold now, in the generation
// they are at: after a reset, every record must name the new generation.
export function staleUnits(e) {
  const out = [];
  for (const [id, held] of e.sessions) {
    for (const r of held.view.values()) {
      for (const [sk, gen, uk] of r.units ?? []) {
        const cur = held.sources.get(sk);
        if (!cur || cur.generation !== gen || !cur.units.has(uk)) out.push(`${id.split('\u0000')[0]}: ${r.type}: [${sk}, ${gen}, ${uk}]`);
      }
    }
  }
  return out;
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
// `units: 'exact'` holds `units` to the full replay's too: the same source and unit keys, and each
// triple at the generation the engine holds the source in. The generation is checked against the
// engine, never against the full replay: it counts the engine's resets of the source, and a fresh
// replay cannot know how many resets a torn read caused in the growing engine (a snapshot read torn
// in 30 passes is at generation 31 there, at 1 in the replay). `units: 'valid'` is for an adapter whose units can move while a record's content does
// not (sessions-model §2.7: a units-only change is not a revision, so the view keeps the triples of
// the record's last write): the records are compared without them, and every triple must still
// name a unit the engine holds.
export function growthCheck(adapter, fixtureStore, { steps = 24, units = 'exact' } = {}) {
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
    const opts = { units: units === 'exact' ? 'keys' : false };
    const stale = staleUnits(e);
    const equal = compareViews(e.views(), whole.views(), opts) && !stale.length;
    e.pass();
    const notUnchanged = e.log.filter((l) => l.continuity !== 'unchanged');
    return { equal, notUnchanged, stale, incremental: project(e.views(), opts), full: project(whole.views(), opts) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Negative control: rewrite one stream file shorter, through a new inode, between two passes.
// The read must be `reset`, and the re-derived view must equal a full replay of the shorter
// store: exactly the vanished keys are gone. `units` are compared apart: the engine's source is at
// a new generation, where a full replay's is at its first, so each record's triples must name units
// of the new generation instead (sessions-model §2.7: a reset re-keys the units, not the records).
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
    const stale = staleUnits(e);
    return { continuity, equal: compareViews(e.views(), whole.views(), { units: false }) && !stale.length, stale };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A resume (sessions-model §2.7 units): one source grows in a later launch. The store is copied
// with `rel` cut after its first `lines` lines, read in one pass, then made whole and read again.
// Returns each pass's session records, projected, by session id: their `units` must follow the
// fields that moved, and the second view must equal a full replay.
export function resumeCheck(adapter, fixtureStore, rel, lines) {
  const dir = tmpStore();
  try {
    copyTree(fixtureStore, dir);
    const file = path.join(dir, rel);
    const whole = fs.readFileSync(file, 'utf8');
    const head = whole.split('\n').slice(0, lines).map((l) => l + '\n').join('');
    if (!whole.startsWith(head)) throw new Error(`${rel} has fewer than ${lines} whole lines`);
    fs.writeFileSync(file, head);
    const e = new MiniEngine(adapter, storeOf(adapter, dir));
    const sessions = () => Object.fromEntries(Object.entries(project(e.views())).map(([sid, rs]) => [sid, rs.find((r) => r.type === 'session')]));
    e.pass();
    const before = sessions();
    fs.appendFileSync(file, whole.slice(head.length));
    e.pass();
    return { before, after: sessions(), equal: compareViews(e.views(), fullReplay(adapter, dir).views()) };
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
