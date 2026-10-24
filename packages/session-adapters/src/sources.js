// The generic `read` of sessions v1 §2 for file sources: `stream` with `byte_offset` positions,
// and `snapshot`. A harness adapter names its sources and hands each file here; it supplies only a
// redaction hook. Both readers are read-only toward the harness and stateless: everything they
// need comes in `from`.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './jcs.js';
import { SessionsError } from './errors.js';

const ANCHOR_BYTES = 64 * 1024;
// The most one read returns; the rest follows on the next read from the returned position.
export const MAX_READ_BYTES = 64 * 1024 * 1024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
// ignoreBOM keeps a leading byte-order mark in the body, so the body re-encodes to exactly the
// bytes `bytes` and `sha256` describe. jsonOf drops it before parsing.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// A raw unit (sessions-model §3). `body` is the emitted bytes, as text for `utf8` and base64
// for `b64`; `sha256` and `bytes` describe the emitted bytes, after redaction.
export function makeUnit(sourceKey, unitKey, buf, redacted = false) {
  let enc = 'utf8';
  let body;
  try {
    body = utf8.decode(buf);
  } catch {
    enc = 'b64';
    body = buf.toString('base64');
  }
  return { source_key: sourceKey, unit_key: unitKey, enc, bytes: buf.length, sha256: sha256(buf), redacted, body };
}

// True when `rel` names a regular file below `root` with no symlink at any segment: the test
// `list` and any pre-read check use, so nothing is ever opened through a link.
export function isRealFile(root, rel) {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return false;
  let cur = root;
  const segs = rel.split(/[\\/]/);
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return false;
    if (i === segs.length - 1) return st.isFile();
    if (!st.isDirectory()) return false;
  }
  return false;
}

// True when any existing segment of `rel` below `root` is a symlink (a missing segment ends the
// walk). For a check that must refuse a link before anything is opened, without deciding yet
// whether the file exists.
export function throughSymlink(root, rel) {
  let cur = root;
  for (const seg of String(rel).split(/[\\/]/)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

const notThere = (sourceKey, why) => new SessionsError('source_unknown', `source ${sourceKey} ${why}`, [sourceKey]);

// Open a source read-only, never through a symlink: below `root` (the harness_path), no path
// segment may be a symlink, the file is opened with O_NOFOLLOW (and O_NONBLOCK, so a FIFO cannot
// hang the read), and it must be a regular file. This is the rule `list` applies when it walks, so
// `read` never returns what `list` would not name.
function openSource(file, sourceKey, root) {
  if (root) {
    const rel = path.relative(root, file);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw notThere(sourceKey, 'is outside the harness store');
    let cur = root;
    for (const seg of rel.split(path.sep)) {
      cur = path.join(cur, seg);
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw notThere(sourceKey, 'is not there');
        throw e;
      }
      if (st.isSymbolicLink()) throw notThere(sourceKey, 'is reached through a symlink');
    }
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw notThere(sourceKey, 'is not there');
    if (e.code === 'ELOOP') throw notThere(sourceKey, 'is a symlink');
    throw e;
  }
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw notThere(sourceKey, 'is not a regular file');
  }
  return fd;
}

function readRange(fd, start, end) {
  const buf = Buffer.alloc(Math.max(0, end - start));
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return got === buf.length ? buf : buf.subarray(0, got);
}

// sha256 of the first complete line, or null while line 1 is still partial.
function line1Sha(fd, size) {
  const head = readRange(fd, 0, Math.min(size, 1024 * 1024));
  const nl = head.indexOf(0x0a);
  return nl < 0 ? null : sha256(head.subarray(0, nl));
}

// sha256 of the bytes just before `offset`: a same-size rewrite of the tail shows here.
function anchorSha(fd, offset) {
  return sha256(readRange(fd, Math.max(0, offset - ANCHOR_BYTES), offset));
}

// ---- the pure unit-making, shared by `read` and `unitsFromBytes` ------------------------------

// A stream's line split: every complete line of `buf` as a unit, without its newline (and a CR
// before it). `unit_key` is `start` plus the line's offset in `buf`, `start` being the generation
// offset of `buf`'s first byte. Blank lines are skipped, and offsets still count them. `offset` is
// the generation offset just past the last newline: what follows it is a partial line.
export function splitLines(buf, sourceKey, start = 0, redact = null) {
  const units = [];
  let lineStart = 0;
  for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, lineStart)) {
    let line = buf.subarray(lineStart, nl);
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.toString('latin1').trim() !== '') {
      const r = redact ? redact(line) : { buf: line, redacted: false };
      units.push(makeUnit(sourceKey, String(start + lineStart), r.buf, r.redacted));
    }
    lineStart = nl + 1;
  }
  return { units, offset: start + lineStart };
}

// The partial last line, as `held_back`: the bytes from `offset` to `end`, if any.
function tailOf(offset, end) {
  return offset < end ? [{ unit_key: String(offset), bytes: end - offset }] : [];
}

// A snapshot's one unit: the whole file, redacted, keyed by its source_key.
export function snapshotUnit(raw, sourceKey, redact = null) {
  const r = redact ? redact(raw) : { buf: raw, redacted: false };
  return makeUnit(sourceKey, sourceKey, r.buf, r.redacted);
}

const badRequest = (msg, items) => new SessionsError('bad_request', msg, items);

// The bytes and start an adapter's `unitsFromBytes` was given, checked: a Buffer (a Uint8Array is
// taken as one, without a copy) and a non-negative integer. A snapshot unit is the whole file, so
// its `start` is 0.
function checkedBytes(bytes, sourceKey, start, snapshot) {
  if (!(bytes instanceof Uint8Array)) throw badRequest(`${sourceKey}: bytes must be a Buffer or a Uint8Array`, [sourceKey]);
  if (!Number.isSafeInteger(start) || start < 0) throw badRequest(`${sourceKey}: start must be a non-negative integer, not ${start}`, [sourceKey]);
  if (snapshot && start !== 0) throw badRequest(`${sourceKey} is a snapshot source: its unit is the whole file, so start must be 0, not ${start}`, [sourceKey]);
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// What `readStream` returns from scratch for a file holding `bytes` (sessions §1, `byte_offset`):
// the units and the partial last line as `held_back`, with no position, no continuity and no file
// opened. `start` is the generation offset of the first byte, as in `read` from a position there.
// Unlike one `read`, there is no MAX_READ_BYTES cap: the result is every unit of `bytes` at once.
export function streamUnits(bytes, sourceKey, { start = 0, redact = null } = {}) {
  const buf = checkedBytes(bytes, sourceKey, start, false);
  const { units, offset } = splitLines(buf, sourceKey, start, redact);
  return { units, held_back: tailOf(offset, start + buf.length) };
}

// What `readSnapshot` returns from scratch for a file holding `bytes`: its one unit.
export function snapshotUnits(bytes, sourceKey, { start = 0, redact = null } = {}) {
  return { units: [snapshotUnit(checkedBytes(bytes, sourceKey, start, true), sourceKey, redact)], held_back: [] };
}

// A source key `unitsFromBytes` cannot re-read: a table, a key range or another slice of a
// database. It has no file bytes; its units come from rows.
export function databaseSource(sourceKey) {
  return badRequest(`${sourceKey} is a database source: it has no file bytes, and its units come from rows (read it with read())`, [sourceKey]);
}

// A source key that is not a file source of the harness, as list would name it.
export function unknownSource(harness, sourceKey) {
  return new SessionsError('source_unknown', `${sourceKey} is not a file source key of ${harness}`, [String(sourceKey)]);
}

// True when a relative source key has only plain segments: none empty, `.` or `..`.
export function plainRel(sourceKey) {
  return typeof sourceKey === 'string' && sourceKey !== '' && !sourceKey.startsWith('/')
    && sourceKey.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// A stream source: an append-only file of lines (sessions §1, `byte_offset`).
// - The unit is one complete line without its newline; `unit_key` is its start offset in the
//   generation, as a decimal string. Blank lines are skipped, and offsets still count them.
// - A partial last line is never returned: it is `held_back` until its newline arrives.
// - Reset evidence: another `{dev, inode}`, a file shorter than `from.offset`, a changed line 1,
//   or changed bytes just before `from.offset`. Any of them gives `reset` with every unit.
// - One read returns at most `maxBytes`, cut at a line boundary, and says `more: true`; the next
//   read from the returned position continues. A single line longer than the cap is read whole.
// `redact(buf)` returns `{buf, redacted}` for one line. `root` is the harness_path (see openSource).
export function readStream(file, sourceKey, from, { redact, root, maxBytes = MAX_READ_BYTES } = {}) {
  const fd = openSource(file, sourceKey, root);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const size = Number(st.size);
    const dev = String(st.dev);
    const inode = String(st.ino);
    const first = line1Sha(fd, size);

    let start = 0;
    let continuity = 'reset';
    if (from && from.dev === dev && from.inode === inode && from.offset <= size
      && (from.line1_sha === null || from.line1_sha === first)
      && anchorSha(fd, from.offset) === from.anchor_sha) {
      start = from.offset;
      continuity = 'appended';
    }

    // Up to the cap, then on to the next newline when the cap cut a line.
    let end = Math.min(size, start + maxBytes);
    let buf = readRange(fd, start, end);
    while (end < size && buf.lastIndexOf(0x0a) < 0) {
      const next = Math.min(size, end + maxBytes);
      buf = Buffer.concat([buf, readRange(fd, end, next)]);
      end = next;
    }
    if (end < size) buf = buf.subarray(0, buf.lastIndexOf(0x0a) + 1);
    const { units, offset } = splitLines(buf, sourceKey, start, redact);
    const more = end < size;
    const heldBack = more ? [] : tailOf(offset, size);
    if (continuity === 'appended' && units.length === 0) continuity = 'unchanged';
    return {
      continuity,
      units,
      gone: [],
      position: { dev, inode, offset, line1_sha: first, anchor_sha: anchorSha(fd, offset) },
      held_back: heldBack,
      more,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// A snapshot source: one unit replaced whole (sessions §1, `snapshot`). The position is the
// emitted unit's sha256. A first read, with no `from`, is `reset` (sessions §2, rule 1).
export function readSnapshot(file, sourceKey, from, { redact, root } = {}) {
  const fd = openSource(file, sourceKey, root);
  let raw;
  try {
    raw = readRange(fd, 0, Number(fs.fstatSync(fd).size));
  } finally {
    fs.closeSync(fd);
  }
  const u = snapshotUnit(raw, sourceKey, redact);
  if (from && from.sha256 === u.sha256) {
    return { continuity: 'unchanged', units: [], gone: [], position: from, held_back: [] };
  }
  return { continuity: from ? 'snapshot' : 'reset', units: [u], gone: [], position: { sha256: u.sha256 }, held_back: [] };
}

// A JSON line's text, for a derive: the unit body when it is UTF-8 JSON, else null (a line that
// does not parse is skipped by the fold, never fatal; `read` already returned it whole).
export function jsonOf(u) {
  if (u.enc !== 'utf8' && u.enc !== 'row-json' && u.enc !== 'rows-json') return null;
  try {
    return JSON.parse(u.body.charCodeAt(0) === 0xfeff ? u.body.slice(1) : u.body);
  } catch {
    return null;
  }
}
