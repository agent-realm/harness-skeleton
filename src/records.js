// The skeleton's own records under <harness_path>/.harness-skeleton/ (design note v0.2 §9.3):
// the lock, the ledger, a journal per apply, every applied plan and every receipt. They are
// retained: nothing here deletes a record. Temporary files for atomic writes live in tmp/,
// on the same filesystem as the folder, so a rename into place is atomic and a half-written
// file is never visible where the harness looks.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HsError } from './protocol.js';
import { readBytes, readJson } from './files.js';
import { canonical } from './spec/layers.js';
import { hostId } from './host.js';

export const RECORDS = '.harness-skeleton';
export const LEDGER_FORMAT = 'hs-ledger/0.2';

export function recordsDir(folder) {
  return path.join(folder, RECORDS);
}

// Every existing segment of `rel` must be a real directory or file inside the folder, never a
// symlink: a write through a linked parent would land outside the data folder.
export function linkInPath(folder, rel) {
  let cur = folder;
  for (const seg of rel.split(/[\\/]/)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      return `${path.relative(folder, cur)} cannot be read (${e.code})`;
    }
    if (st.isSymbolicLink()) return `${path.relative(folder, cur)} is a symlink; hs never writes through one`;
  }
  return null;
}

// Refuse any path of the folder (a record, a staging file, a native address) that leaves the
// folder or has a symlink on its way, before it is read or written.
export function guard(folder, abs) {
  const rel = path.relative(folder, abs);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new HsError('write_refused', `${abs} is outside the data folder`, [abs]);
  }
  const link = linkInPath(folder, rel);
  if (link) throw new HsError('write_refused', link, [rel]);
  return abs;
}

export function ensureDir(folder, dir) {
  if (dir !== folder) guard(folder, dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Make a rename durable: fsync the directory that holds the new name. Without it a power loss
// can keep a journal's fsynced `op-done` and lose the rename it records.
export function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (e) {
    // some filesystems refuse fsync on a directory; the rename is then as durable as they make it
    if (e.code !== 'EINVAL' && e.code !== 'EPERM' && e.code !== 'EISDIR') throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function digestOf(value) {
  return sha256(canonical(value));
}

// Write a file atomically: a temp file in the folder's own tmp/, fsync, rename into place, then
// read it back. `mode` defaults to the existing file's mode, else 0o644.
const STAGE_PREFIX = 'stage.';

// Staged copies a crash left behind. The caller holds the lock with nothing pending, so none is
// in use; recover removes them.
export function sweepStaged(folder) {
  const tmpDir = path.join(recordsDir(folder), 'tmp');
  let n = 0;
  for (const f of fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []) {
    if (!f.startsWith(STAGE_PREFIX)) continue;
    const p = path.join(tmpDir, f);
    guard(folder, p);
    fs.rmSync(p, { force: true });
    n++;
  }
  return n;
}

// `beforeRename`, when given, runs after the staged copy is written and synced, right before it
// replaces the target; a throw there removes the staged copy and leaves the target as it is.
export function atomicWrite(folder, target, data, mode, { beforeRename } = {}) {
  guard(folder, target);
  const tmpDir = path.join(recordsDir(folder), 'tmp');
  ensureDir(folder, tmpDir);
  // `stage.` marks a staged copy, which recover sweeps; locks and tree swaps use other names.
  const tmp = path.join(tmpDir, `${STAGE_PREFIX}${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}`);
  let fileMode = mode;
  if (fileMode === undefined) {
    try {
      fileMode = fs.statSync(target).mode & 0o777;
    } catch {
      fileMode = 0o644;
    }
  }
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fileMode);
  // A staged copy that never reaches its target is removed, so no copy outlives a failed write.
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    ensureDir(folder, path.dirname(target));
    guard(folder, target);
    if (beforeRename) beforeRename();
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(path.dirname(target));
  const back = readBytes(target);
  if (!back.bytes || !back.bytes.equals(Buffer.from(data))) {
    throw new HsError('write_unverified', `${target} does not read back as written`, [target]);
  }
}

// ---- lock -------------------------------------------------------------------------------

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Take the folder's lock, exclusively. A lock held by a live process is `folder_busy`. A lock
// whose process is gone (same host), or one that cannot be read, is stale: `apply` refuses it
// and points at `recover`; `recover` takes it over, since finishing an interrupted apply is its
// job. The lock is written whole to a temp file and link()ed into place, so it never exists
// empty, and it carries a nonce: a taker proceeds, and a holder releases, only while the lock
// on disk holds its own nonce.
// The holder's host is the sessions-model `host`, not the hostname, which changes with a rename
// or a network (a host and its `.local` name).
// `beforeTakeover` is a test hook: it runs between reading a stale lock and moving it aside.
export function acquireLock(folder, { op, takeStale = false, host = hostId().host, beforeTakeover } = {}) {
  // The records must be the folder's own: a link anywhere under .harness-skeleton/ would send
  // records, and the staging of every write, somewhere else.
  for (const sub of ['', 'lock', 'ledger.json', 'tmp', 'journal', 'plans', 'receipts', 'replaced']) guard(folder, path.join(recordsDir(folder), sub));
  ensureDir(folder, path.join(recordsDir(folder), 'tmp'));
  const file = path.join(recordsDir(folder), 'lock');
  const nonce = randomBytes(16).toString('hex');
  const mine = path.join(recordsDir(folder), 'tmp', `lock.${process.pid}.${nonce}`);
  fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, host, op, nonce, at: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
  const holds = () => readJson(file).value?.nonce === nonce;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(mine, file);
        fsyncDir(recordsDir(folder));
        if (holds()) return { file, release: () => { if (holds()) fs.rmSync(file, { force: true }); } };
        continue;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const raw = readBytes(file).bytes ?? null;
      const r = { ...readJson(file), raw };
      const held = r.value ?? {};
      const readable = Number.isInteger(held.pid) && typeof held.host === 'string';
      if (readable && (held.host !== host || pidAlive(held.pid))) {
        // Held by a live process: transient, so a resend may succeed.
        throw new HsError('folder_busy', `${file} is held by pid ${held.pid} on host ${held.host} (${held.op ?? '?'})`, [file], { retryable: true });
      }
      const why = readable ? `pid ${held.pid} is not running` : 'it cannot be read';
      if (!takeStale) {
        // Stale: only recover clears it, so the same request fails again (not retryable).
        throw new HsError('folder_busy', `${file} is stale (${why}); run recover, which finishes an interrupted apply and takes the lock over`, [file]);
      }
      // Move the stale lock aside by rename, to a name of this taker's own, then check that the
      // moved file is the stale lock read above. Between that read and the rename another taker
      // may have replaced it with a fresh lock; a fresh lock moved by mistake is linked back,
      // and this taker stands down.
      const moved = path.join(recordsDir(folder), 'tmp', `stale-lock.${nonce}`);
      beforeTakeover?.();
      try {
        fs.renameSync(file, moved);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        continue;
      }
      const movedBytes = readBytes(moved).bytes;
      if (!movedBytes || !r.raw || !movedBytes.equals(r.raw)) {
        try {
          fs.linkSync(moved, file);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
        throw new HsError('folder_busy', `${file} was taken by another process while this one took the stale lock over`, [file], { retryable: true });
      }
    }
    throw new HsError('folder_busy', `${file} could not be taken`, [file], { retryable: true });
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

// ---- ledger -----------------------------------------------------------------------------

// The ledger, by native address: who delivered what there, what it was before the first
// owner, and the digest each owner installed. An address two owners deliver is shared, and
// restored only when the last one removes it.
//   { format, addresses: { "<address>": { previous, owners: { "<owner>": { item, installed, plan, at } } } } }
export function readLedger(folder) {
  const r = readJson(guard(folder, path.join(recordsDir(folder), 'ledger.json')));
  if (!r.present) return { format: LEDGER_FORMAT, addresses: {} };
  if (r.error || r.value.format !== LEDGER_FORMAT || typeof r.value.addresses !== 'object') {
    throw new HsError('ledger_unreadable', `${path.join(recordsDir(folder), 'ledger.json')}: ${r.error ?? 'not a ' + LEDGER_FORMAT + ' ledger'}`);
  }
  return r.value;
}

export function writeLedger(folder, ledger) {
  atomicWrite(folder, path.join(recordsDir(folder), 'ledger.json'), JSON.stringify(ledger, null, 2) + '\n', 0o600);
}

export function ownedBy(ledger, owner) {
  return Object.entries(ledger.addresses)
    .filter(([, a]) => a.owners[owner])
    .map(([address, a]) => ({ address, ...a.owners[owner], previous: a.previous, owners: Object.keys(a.owners) }));
}

// ---- journal, plans, receipts --------------------------------------------------------------

export function newApplyId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
}

export function journalFile(folder, applyId) {
  return path.join(recordsDir(folder), 'journal', `${applyId}.jsonl`);
}

// One line per event, appended and fsynced, so an interrupted apply leaves an exact record. A
// crash during an append can leave a last line without its newline: the next append ends that
// line first and marks its own event `after_torn`, so the fragment stays a line of its own and
// readJournal knows to skip it.
export function journal(folder, applyId, event) {
  const file = guard(folder, journalFile(folder, applyId));
  ensureDir(folder, path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
  try {
    const size = fs.fstatSync(fd).size;
    let torn = false;
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      torn = last[0] !== 0x0a;
    }
    const line = JSON.stringify({ at: new Date().toISOString(), ...event, ...(torn ? { after_torn: true } : {}) }) + '\n';
    fs.writeFileSync(fd, (torn ? '\n' : '') + line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// A journal's events. A partial line from a crash during an append was never confirmed: it is
// dropped and reported (`torn`) when it is the last line, or when the next event carries the
// `after_torn` mark journal() puts on the append that follows it. A bad line anywhere else
// is recover_failed.
export function readJournal(folder, applyId) {
  const r = readBytes(guard(folder, journalFile(folder, applyId)));
  if (!r.bytes) return [];
  const lines = r.bytes.toString('utf8').split('\n').filter(Boolean);
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return undefined;
    }
  });
  return parsed.map((e, i) => {
    if (e !== undefined) return e;
    const last = i === lines.length - 1;
    if (last || parsed[i + 1]?.after_torn === true) return { event: 'torn', line: i + 1 };
    throw new HsError('recover_failed', `journal ${applyId}: line ${i + 1} is not JSON`, [applyId]);
  });
}

// Journals with a `begin` and no `complete`: applies that did not finish.
export function unfinished(folder) {
  let names = [];
  try {
    names = fs.readdirSync(guard(folder, path.join(recordsDir(folder), 'journal'))).filter((n) => n.endsWith('.jsonl')).sort();
  } catch (e) {
    if (e instanceof HsError) throw e;
    return [];
  }
  return names
    .map((n) => n.slice(0, -'.jsonl'.length))
    .filter((id) => {
      const events = readJournal(folder, id);
      return events.some((e) => e.event === 'begin') && !events.some((e) => e.event === 'complete');
    });
}

export function storeRecord(folder, kind, digest, value) {
  const file = guard(folder, path.join(recordsDir(folder), kind, `${digest.replace(/^sha256:/, '')}.json`));
  if (!fs.existsSync(file)) atomicWrite(folder, file, JSON.stringify(value, null, 2) + '\n', 0o600);
  return file;
}

export function loadRecord(folder, kind, digest) {
  const r = readJson(guard(folder, path.join(recordsDir(folder), kind, `${digest.replace(/^sha256:/, '')}.json`)));
  return r.value ?? null;
}
