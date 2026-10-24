// Reading the few files an adapter parses (settings, config, spec layers). A message from a
// parser can quote the file, and the file may hold a secret, so a failure is reported by
// position only. Opens never follow a final symlink unless asked, never hang on a FIFO, and
// read regular files only.

import fs from 'node:fs';
import { parse as parseToml } from 'smol-toml';

// A regular file's bytes, as a Buffer: what a digest covers (§5.1), so two files that differ
// in any byte never share one.
export function readBytes(file, { noFollow = true } = {}) {
  try {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (noFollow ? fs.constants.O_NOFOLLOW : 0);
    const fd = fs.openSync(file, flags);
    try {
      if (!fs.fstatSync(fd).isFile()) return { present: true, error: 'not a regular file' };
      return { present: true, bytes: fs.readFileSync(fd) };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e.code === 'ENOENT') return { present: false };
    return { present: true, error: `unreadable: ${e.code}` };
  }
}

export function readText(file, opts) {
  const r = readBytes(file, opts);
  return r.bytes === undefined ? r : { present: true, text: r.bytes.toString('utf8') };
}

function jsonFailure(e) {
  const m = /position (\d+)/.exec(e.message);
  return m ? `not JSON (at position ${m[1]})` : 'not JSON';
}

function tomlFailure(e) {
  return Number.isInteger(e.line) ? `not TOML (line ${e.line}, column ${e.column})` : 'not TOML';
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function readJson(file, opts) {
  const r = readText(file, opts);
  if (r.text === undefined) return r;
  try {
    const value = JSON.parse(r.text);
    return isObject(value) ? { present: true, value } : { present: true, error: 'not a JSON object' };
  } catch (e) {
    return { present: true, error: jsonFailure(e) };
  }
}

export function readToml(file, opts) {
  const r = readText(file, opts);
  if (r.text === undefined) return r;
  try {
    // `__proto__` and `constructor` keys are refused, not kept: no spec or config needs them.
    return { present: true, value: parseToml(r.text, { unsafeKeyBehaviour: 'throw' }) };
  } catch (e) {
    return { present: true, error: tomlFailure(e) };
  }
}
