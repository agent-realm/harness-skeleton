// Native write handlers: the only code that changes a data folder (design note v0.2 §7.2).
// Two kinds of address:
//   json-key  one key in a JSON settings file: top-level (`settings.json#cleanupPeriodDays`), or
//             nested, segments joined by '/' (`settings.json#env/CLAUDE_CODE_SUBAGENT_MODEL`)
//   tree      a directory installed whole, one level under a declared root (`skills/notes`)
//
// Every handler holds a floor of its own, whatever operation it is handed: the address is a
// normalized relative path, it classes as `config`, and the descriptor declares it writable.
// Writes are atomic, never go through a symlink, and are read back. A tree that is replaced or
// removed is moved into the records (`replaced/`), never deleted.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HsError } from './protocol.js';
import { readBytes } from './files.js';
import { classify } from './inventory.js';
import { digestPath } from './spec/layers.js';
import { getElement, pathBlocked, setElement, setKey } from './json-edit.js';
import { atomicWrite, digestOf, ensureDir, fsyncDir, guard, linkInPath, recordsDir } from './records.js';

export { linkInPath };

function refuse(reason, address) {
  throw new HsError('write_refused', reason, [address]);
}

// A normalized relative path: no absolute path, no empty, `.` or `..` segment, no backslash.
function normalized(rel) {
  return typeof rel === 'string' && rel !== '' && !rel.includes('\\') && !path.isAbsolute(rel)
    && rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const STATE_CLASSES = new Set(['sessions', 'history', 'credentials']);

// A state path is refused as `state_write_refused` (§7.2), before any other check.
function refuseState(cls, rel) {
  if (STATE_CLASSES.has(cls)) throw new HsError('state_write_refused', `${rel} is a ${cls} path; no operation writes one`, [rel]);
}

// Edit a JSON file in place (src/json-edit.js): only what `change` rewrites differs. The file is
// checked unchanged once the new copy is staged and synced, right before the rename, so a
// concurrent edit by the user or the harness is refused, never overwritten, except one landing
// in the instant between that last read and the rename, which no check can tell apart (§7.4). A
// file that is not valid UTF-8 is refused: decoding it would rewrite the bytes that are not.
// An absent file starts as an empty object.
function editInPlace(folder, file, rel, change, { onStaged } = {}) {
  const r = readBytes(file);
  if (r.error) refuse(`${rel}: ${r.error}`, rel);
  const text = r.present ? utf8(r.bytes) : '{\n}\n';
  if (text === null) refuse(`${rel} is not valid UTF-8; hs edits it only when every byte would stay as it is`, rel);
  let out;
  try {
    out = change(text);
  } catch (e) {
    refuse(`${rel}: ${e.message}`, rel);
  }
  if (out === text && r.present) return;
  atomicWrite(folder, file, out, undefined, {
    beforeRename: () => {
      onStaged?.();
      const again = readBytes(file);
      if (again.present !== r.present || (again.present && !again.bytes.equals(r.bytes))) {
        throw new HsError('precondition_failed', `${rel} changed while it was being written; plan again`, [rel]);
      }
    },
  });
}

// The bytes as text, or null when they are not valid UTF-8: decoding would replace what is not.
function utf8(bytes) {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

// The element an address names: the one the descriptor says is hs's for that id, by its shape,
// never by a string found anywhere in it.
const elementMatch = (descriptor, folder, a) => (v) => descriptor.writable.element_owner(v, { id: a.id, folder, key: a.key });

// A key delivery only ever clears (a mixed file's state keys, §7.2): `clear_only` is true for a
// whole file, or the list of such keys.
const clearOnly = (decl, key) => decl?.clear_only === true || (Array.isArray(decl?.clear_only) && decl.clear_only.includes(key));

// Owner-only modes for a staged tree (a private root, §7.5): directories 0700, files 0700 if any
// execute bit is set, else 0600.
function ownerOnly(p) {
  const st = fs.lstatSync(p);
  if (st.isDirectory()) {
    fs.chmodSync(p, 0o700);
    for (const name of fs.readdirSync(p)) ownerOnly(path.join(p, name));
  } else if (st.isFile()) {
    fs.chmodSync(p, st.mode & 0o111 ? 0o700 : 0o600);
  }
}

export function checkAddress(descriptor, handler, a) {
  const w = descriptor.writable ?? { json: {}, trees: [] };
  if (handler === 'json-key') {
    if (!normalized(a?.file) || typeof a.key !== 'string' || a.key.split('/').some((seg) => seg === '')) refuse(`${JSON.stringify(a)} is not a JSON key address`, a?.file);
    refuseState(classify(a.file, descriptor.paths), a.file);
    const decl = w.json[a.file];
    if (!decl) refuse(`${a.file} is not a file ${descriptor.name} delivery may write`, a.file);
    // A prefix admits one more segment of an id's characters, never deeper: `mcpServers/<id>`.
    const prefixed = (decl.prefixes ?? []).some((p) => a.key.startsWith(p) && /^[A-Za-z0-9_-]+$/.test(a.key.slice(p.length)));
    if (decl.keys !== '*' && !decl.keys.includes(a.key) && !prefixed) refuse(`${a.file}#${a.key} is not a key delivery may write in ${a.file}`, a.file);
    if (Array.isArray(decl.never)) {
      if (decl.never.some((k) => a.key === k || a.key.startsWith(k + '/'))) refuse(`${a.file}#${a.key} is never written by delivery`, a.file);
      // Nor an object that holds one: a whole-object value could carry the key in it.
      const held = decl.never.filter((k) => k.startsWith(a.key + '/'));
      if (held.length) refuse(`${a.file}#${a.key} holds keys delivery never writes (${held.join(', ')}); write its keys one by one`, a.file);
    }
    if (classify(a.file, descriptor.paths) !== 'config') refuse(`${a.file} is not a config path`, a.file);
    return `${a.file}#${a.key}`;
  }
  // One element of an array the user may also use (persisted hooks): the file and the array key
  // as for json-key, the key among the descriptor's `elements` patterns, and the element named by
  // an id, which the element itself carries in its marker (descriptor.writable.element_marker).
  if (handler === 'json-element') {
    if (!normalized(a?.file) || typeof a.key !== 'string' || a.key.split('/').some((seg) => seg === '')) refuse(`${JSON.stringify(a)} is not a JSON element address`, a?.file);
    refuseState(classify(a.file, descriptor.paths), a.file);
    const decl = w.json[a.file];
    if (!decl) refuse(`${a.file} is not a file ${descriptor.name} delivery may write`, a.file);
    const allowed = (decl.elements ?? []).some((p) => (p.endsWith('/*') ? a.key.startsWith(p.slice(0, -1)) && /^[A-Za-z0-9_-]+$/.test(a.key.slice(p.length - 1)) : a.key === p));
    if (!allowed) refuse(`${a.file}#${a.key} is not an array whose entries delivery may set`, a.file);
    if (typeof a.id !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(a.id) || a.id.startsWith('.')) refuse(`${JSON.stringify(a.id)} is not an element id`, a.file);
    if (classify(a.file, descriptor.paths) !== 'config') refuse(`${a.file} is not a config path`, a.file);
    return `${a.file}#${a.key}[${a.id}]`;
  }
  if (handler === 'tree') {
    if (!normalized(a?.path)) refuse(`${JSON.stringify(a?.path)} is not a normalized relative path`, a?.path);
    refuseState(classify(a.path, descriptor.paths, { isDir: true }), a.path);
    const segs = a.path.split('/');
    if (segs.length !== 2 || !w.trees.includes(segs[0])) refuse(`${a.path} is not one level under a root delivery may write (${w.trees.join(', ')})`, a.path);
    // A hidden name, or one the harness keeps for itself, is never a delivered tree, whatever plan
    // asks: the harness skips the one and owns the other.
    if (segs[1].startsWith('.') || (w.reserved?.[segs[0]] ?? []).includes(segs[1])) refuse(`${a.path} is a hidden or reserved name under ${segs[0]}/ (${descriptor.name} keeps ${(w.reserved?.[segs[0]] ?? []).join(', ') || 'none'}, and skips or owns every name starting with .)`, a.path);
    if (classify(a.path, descriptor.paths, { isDir: true }) !== 'config') refuse(`${a.path} is not a config path`, a.path);
    return a.path;
  }
  throw new HsError('write_refused', `no handler ${handler}`, [handler]);
}

// The first symlink inside a tree, relative to it, or null. A link in a skill would make the
// harness read whatever it points at, and the digest shows only the link's target string, so
// v0 installs no tree that holds one.
export function treeLink(dir, rel = '') {
  const abs = path.join(dir, rel);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return rel || '.';
  if (!st.isDirectory()) return null;
  for (const n of fs.readdirSync(abs).sort()) {
    const hit = treeLink(dir, rel ? `${rel}/${n}` : n);
    if (hit) return hit;
  }
  return null;
}

export function readDoc(file) {
  const r = readBytes(file);
  if (!r.present) return { doc: null };
  if (r.error) return { blocked: `${path.basename(file)}: ${r.error}` };
  try {
    const text = r.bytes.toString('utf8');
    const doc = JSON.parse(text);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { blocked: `${path.basename(file)} is not a JSON object` };
    return { doc, text, bytes: r.bytes };
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    return { blocked: `${path.basename(file)} is not JSON${m ? ` (at position ${m[1]})` : ''}` };
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A nested key's value: present when every segment exists; blocked when a segment on the way is
// not an object (a key that cannot be addressed is never written through).
function getPath(doc, segs) {
  if (doc === null || doc === undefined) return { present: false };
  let cur = doc;
  for (let i = 0; i < segs.length; i++) {
    if (!isObject(cur)) return { blocked: `${segs.slice(0, i).join('/')} is not an object` };
    if (!Object.hasOwn(cur, segs[i])) return { present: false };
    cur = cur[segs[i]];
  }
  return { present: true, value: cur };
}

// Where a replaced or removed tree goes: the records, retained like every other record.
export function replacedPath(folder, applyId, opId, a) {
  return path.join(recordsDir(folder), 'replaced', applyId, opId, path.basename(a.path));
}

function moveAside(folder, target, dest) {
  ensureDir(folder, path.dirname(dest));
  guard(folder, dest);
  fs.renameSync(target, dest);
  fsyncDir(path.dirname(target));
  fsyncDir(path.dirname(dest));
}

export const handlers = {
  'json-key': {
    // The state of one key; `digest` is null when the key is absent. Checked before reading.
    current(folder, descriptor, a) {
      checkAddress(descriptor, 'json-key', a);
      const link = linkInPath(folder, a.file);
      if (link) return { blocked: link };
      const r = readDoc(path.join(folder, a.file));
      if (r.blocked) return r;
      // A key held twice on the way: JSON.parse reads the last, and an edit would refuse (§7.4).
      if (r.doc && utf8(r.bytes) === null) return { blocked: `${a.file} is not valid UTF-8` };
      const twice = r.doc ? pathBlocked(r.text, a.key.split('/')) : null;
      if (twice) return { blocked: `${a.file}#${a.key}: ${twice}` };
      const got = getPath(r.doc, a.key.split('/'));
      if (got.blocked) return { blocked: `${a.file}#${a.key}: ${got.blocked}` };
      return { present: got.present, digest: got.present ? digestOf(got.value) : null, value: got.value };
    },
    // Clear several keys of one clear-only file in a single write (§7.2): the copy staged for it
    // holds none of the values being cleared. A key already gone is skipped; nothing to clear,
    // no write.
    clear(folder, descriptor, file, keys) {
      for (const key of keys) checkAddress(descriptor, 'json-key', { file, key });
      for (const key of keys) if (!clearOnly(descriptor.writable?.json[file], key)) refuse(`${file}#${key} is not a clear-only key`, file);
      const link = linkInPath(folder, file);
      if (link) refuse(link, file);
      const abs = path.join(folder, file);
      const r = readDoc(abs);
      if (r.blocked) refuse(r.blocked, file);
      if (!r.doc) return;
      const gone = keys.filter((k) => Object.hasOwn(r.doc, k));
      if (!gone.length) return;
      editInPlace(folder, abs, file, (text) => gone.reduce((t, k) => setKey(t, [k], undefined), text));
    },
    // Set the key, or delete it when `value` is undefined. Only the key's span is rewritten
    // (src/json-edit.js), so every other byte of the user's file stays as it was (§7.4).
    write(folder, descriptor, a, value) {
      checkAddress(descriptor, 'json-key', a);
      // A clear-only file (a mixed file's state keys): its keys are deleted, never set.
      if (clearOnly(descriptor.writable?.json[a.file], a.key) && value !== undefined) refuse(`${a.file}#${a.key} is only ever cleared by delivery, never written`, a.file);
      const link = linkInPath(folder, a.file);
      if (link) refuse(link, a.file);
      const file = path.join(folder, a.file);
      const r = readDoc(file);
      if (r.blocked) refuse(r.blocked, a.file);
      editInPlace(folder, file, a.file, (text) => setKey(text, a.key.split('/'), value));
    },
  },

  // One element of an array in a file the user owns (persisted hooks, §7.5): only its span is
  // rewritten (src/json-edit.js), so every other byte of the file stays as it was. The file is
  // read, edited and checked unchanged right before the rename (editInPlace).
  'json-element': {
    current(folder, descriptor, a) {
      checkAddress(descriptor, 'json-element', a);
      const link = linkInPath(folder, a.file);
      if (link) return { blocked: link };
      const r = readBytes(path.join(folder, a.file));
      if (!r.present) return { present: false, digest: null };
      if (r.error) return { blocked: `${a.file}: ${r.error}` };
      const text = utf8(r.bytes);
      if (text === null) return { blocked: `${a.file} is not valid UTF-8` };
      let got;
      try {
        got = getElement(text, a.key.split('/'), elementMatch(descriptor, folder, a));
      } catch (e) {
        return { blocked: `${a.file}: ${e.message}` };
      }
      if (got.blocked) return { blocked: `${a.file}#${a.key}: ${got.blocked}` };
      return { present: got.present, digest: got.present ? digestOf(got.value) : null, value: got.value };
    },
    write(folder, descriptor, a, value, opts = {}) {
      checkAddress(descriptor, 'json-element', a);
      const link = linkInPath(folder, a.file);
      if (link) refuse(link, a.file);
      editInPlace(folder, path.join(folder, a.file), a.file, (text) => setElement(text, a.key.split('/'), elementMatch(descriptor, folder, a), value), opts);
    },
  },

  tree: {
    current(folder, descriptor, a) {
      checkAddress(descriptor, 'tree', a);
      const link = linkInPath(folder, a.path);
      if (link) return { blocked: link };
      const abs = path.join(folder, a.path);
      if (!fs.existsSync(abs)) return { present: false, digest: null };
      return { present: true, digest: digestPath(abs) };
    },
    // Install `source` at the address. The copy is staged in tmp/ and checked against the
    // digest the plan was made with; `onStage` journals the staging and the aside paths before
    // the swap, so recover can finish a swap a crash interrupted. With `source` null, the tree
    // is moved aside and not replaced.
    write(folder, descriptor, a, source, expected, ctx) {
      checkAddress(descriptor, 'tree', a);
      const link = linkInPath(folder, a.path);
      if (link) refuse(link, a.path);
      const target = path.join(folder, a.path);
      const aside = replacedPath(folder, ctx.applyId, ctx.opId, a);
      if (source === null) {
        ctx.onStage({ replaced: path.relative(folder, aside) });
        if (fs.existsSync(target)) moveAside(folder, target, aside);
        return { replaced: fs.existsSync(aside) ? path.relative(folder, aside) : null };
      }
      const inner = treeLink(source);
      if (inner !== null) refuse(`${source} holds a symlink (${inner}); hs installs no tree with one`, a.path);
      const tmp = path.join(recordsDir(folder), 'tmp');
      ensureDir(folder, tmp);
      const staged = path.join(tmp, `new-${path.basename(a.path)}-${randomBytes(4).toString('hex')}`);
      fs.cpSync(source, staged, { recursive: true, errorOnExist: true, force: false });
      // A private root holds owner-only copies: directories 0700, files 0700 if executable, else
      // 0600. The digest does not cover modes, so this changes no binding.
      if ((descriptor.writable?.private ?? []).includes(a.path.split('/')[0])) ownerOnly(staged);
      if (digestPath(staged) !== expected) {
        fs.rmSync(staged, { recursive: true, force: true });
        throw new HsError('precondition_failed', `${source} changed since the plan was made`, [a.path]);
      }
      ctx.onStage({ staged: path.relative(folder, staged), replaced: path.relative(folder, aside) });
      ensureDir(folder, path.dirname(target));
      if ((descriptor.writable?.private ?? []).includes(a.path.split('/')[0])) fs.chmodSync(path.dirname(target), 0o700);
      if (fs.existsSync(target)) moveAside(folder, target, aside);
      if (ctx.crashMidSwap) throw new Error('crash injected between the two renames');
      fs.renameSync(staged, target);
      fsyncDir(path.dirname(target));
      if (digestPath(target) !== expected) throw new HsError('write_unverified', `${a.path} does not read back as written`, [a.path]);
      return { replaced: fs.existsSync(aside) ? path.relative(folder, aside) : null };
    },
    // Finish a swap a crash left half done: the address is absent, and the journal named the
    // staged copy and the aside path. Returns 'done', 'pending' (back at the precondition) or null.
    resume(folder, descriptor, a, stage, op) {
      checkAddress(descriptor, 'tree', a);
      const target = path.join(folder, a.path);
      if (fs.existsSync(target) || !stage) return null;
      const staged = stage.staged && path.join(folder, stage.staged);
      const aside = stage.replaced && path.join(folder, stage.replaced);
      if (staged && fs.existsSync(guard(folder, staged)) && digestPath(staged) === op.desired_sha256) {
        return () => {
          fs.renameSync(staged, target);
          fsyncDir(path.dirname(target));
          return 'done';
        };
      }
      if (aside && fs.existsSync(guard(folder, aside)) && digestPath(aside) === op.precondition.sha256) {
        return () => {
          fs.renameSync(aside, target);
          fsyncDir(path.dirname(target));
          return 'pending';
        };
      }
      return null;
    },
  },
};
