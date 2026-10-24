// Minimal edits to a JSON file the user owns (design note v0.2 §7.4, persisted hooks): one
// element of one array is inserted, replaced or removed, and every byte outside that element (key
// order, indentation, whitespace, the user's other entries) stays as it was. The file is parsed
// with the span of every value, and only the span being changed is rewritten.

// ---- a JSON parser that keeps spans ------------------------------------------------------------

class Parser {
  constructor(text) {
    this.t = text;
    this.i = 0;
  }
  fail(what) {
    throw new Error(`not JSON: ${what} at position ${this.i}`);
  }
  ws() {
    while (this.i < this.t.length && ' \t\n\r'.includes(this.t[this.i])) this.i++;
  }
  value() {
    this.ws();
    const c = this.t[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    const start = this.i;
    if (c === '"') this.string();
    else if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.t.slice(this.i));
      if (!m) this.fail('a number');
      this.i += m[0].length;
    } else {
      const lit = ['true', 'false', 'null'].find((l) => this.t.startsWith(l, this.i));
      if (!lit) this.fail('a value');
      this.i += lit.length;
    }
    return { type: 'value', start, end: this.i };
  }
  string() {
    if (this.t[this.i] !== '"') this.fail('a string');
    this.i++;
    while (this.i < this.t.length) {
      const c = this.t[this.i];
      if (c === '\\') this.i += 2;
      else if (c === '"') {
        this.i++;
        return;
      } else this.i++;
    }
    this.fail('the end of a string');
  }
  object() {
    const node = { type: 'object', start: this.i, members: [] };
    this.i++;
    this.ws();
    if (this.t[this.i] === '}') {
      this.i++;
      node.end = this.i;
      return node;
    }
    for (;;) {
      this.ws();
      const keyStart = this.i;
      this.string();
      const key = JSON.parse(this.t.slice(keyStart, this.i));
      this.ws();
      if (this.t[this.i] !== ':') this.fail('a colon');
      this.i++;
      const value = this.value();
      node.members.push({ key, keyStart, value });
      this.ws();
      if (this.t[this.i] === ',') {
        this.i++;
        continue;
      }
      if (this.t[this.i] === '}') {
        this.i++;
        node.end = this.i;
        return node;
      }
      this.fail('a comma or a closing brace');
    }
  }
  array() {
    const node = { type: 'array', start: this.i, items: [] };
    this.i++;
    this.ws();
    if (this.t[this.i] === ']') {
      this.i++;
      node.end = this.i;
      return node;
    }
    for (;;) {
      node.items.push(this.value());
      this.ws();
      if (this.t[this.i] === ',') {
        this.i++;
        continue;
      }
      if (this.t[this.i] === ']') {
        this.i++;
        node.end = this.i;
        return node;
      }
      this.fail('a comma or a closing bracket');
    }
  }
}

export function parseSpans(text) {
  const p = new Parser(text);
  const root = p.value();
  p.ws();
  if (p.i !== text.length) p.fail('the end of the file');
  return root;
}

// ---- layout ---------------------------------------------------------------------------------------

// The indentation of the line a position is on.
function lineIndent(text, pos) {
  const nl = text.lastIndexOf('\n', pos - 1);
  const m = /^[ \t]*/.exec(text.slice(nl + 1));
  return m[0];
}

// The indentation unit the file uses, guessed from its first indented line; two spaces otherwise.
function indentUnit(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : '  ';
}

// The line ending the file uses, from its first line break; LF otherwise.
function lineEnding(text) {
  const m = /\r?\n/.exec(text);
  return m ? m[0] : '\n';
}

// A value serialized for insertion at `base` indentation, with the file's unit and line ending.
function render(value, base, unit, eol) {
  return JSON.stringify(value, null, unit).split('\n').map((l, i) => (i === 0 ? l : base + l)).join(eol);
}

// Whether a container is laid out on one line (compact): new entries then go on the same line.
const oneLine = (text, node) => !text.slice(node.start, node.end).includes('\n');

const isEmpty = (node) => (node.type === 'object' ? node.members.length === 0 : node.items.length === 0);

// Insert an entry as the last entry of a container. `entry(indent)` renders it at an indentation.
// Into an empty container, so that taking the entry out again (`removeOnly`) gives back the exact
// bytes the container had: `[]` takes it inside the brackets, `[{ … }]`; a container with
// whitespace inside takes it on a line of its own, and keeps that whitespace after it.
function appendEntry(text, node, entry, base, unit, eol) {
  if (isEmpty(node)) {
    const inside = text.slice(node.start + 1, node.end - 1);
    if (inside === '') return text.slice(0, node.start + 1) + entry(base) + text.slice(node.end - 1);
    return text.slice(0, node.start + 1) + `${eol}${base}${unit}` + entry(base + unit) + inside + text.slice(node.end - 1);
  }
  const first = node.type === 'object' ? node.members[0].keyStart : node.items[0].start;
  const last = node.type === 'object' ? node.members.at(-1).value : node.items.at(-1);
  const indent = lineIndent(text, node.type === 'object' ? node.members.at(-1).keyStart : last.start);
  const sep = oneLine(text, node) ? ', ' : `,${eol}${indent}`;
  return text.slice(0, last.end) + sep + entry(oneLine(text, node) ? lineIndent(text, first) : indent) + text.slice(last.end);
}

// Take out a container's only entry, which ends at `to`: the whitespace before it goes, and what
// follows it stays, which is the container's own whitespace when appendEntry put the entry there.
const removeOnly = (text, node, to) => text.slice(0, node.start + 1) + text.slice(to);

// The one member of an object with this key. A key held twice is refused: JSON readers (Claude
// Code's among them) take the last, so an edit of the first would go where nothing reads it, and a
// read of it would report what is not in effect.
function memberOf(node, key, where) {
  const hits = node.members.filter((m) => m.key === key);
  if (hits.length > 1) throw new Error(`${where || 'the file'} has ${JSON.stringify(key)} ${hits.length} times; JSON readers take the last one, so hs does not edit it; fix the file`);
  return hits[0];
}

// ---- the edit -----------------------------------------------------------------------------------

// Set one element of the array at `keys` (a key path of objects), the one `match(value)` picks:
// replace it with `value`, remove it when `value` is undefined, or append it when none matches.
// Missing objects on the way, and the array itself, are created as needed. Two matching elements,
// a key held twice on the way, or a key on the way that is not an object (or an array at the end),
// refuse. Returns the new text, or the same text when nothing changes.
export function setElement(text, keys, match, value) {
  const root = parseSpans(text);
  if (root.type !== 'object') throw new Error('the file is not a JSON object');
  const unit = indentUnit(text);
  const eol = lineEnding(text);
  let node = root;
  let base = '';
  for (let k = 0; k < keys.length; k++) {
    const member = memberOf(node, keys[k], keys.slice(0, k).join('/'));
    const last = k === keys.length - 1;
    if (!member) {
      if (value === undefined) return text;
      // Create what is missing, from this key down: {"a": {"b": [value]}}.
      let created = [value];
      for (let j = keys.length - 1; j > k; j--) created = { [keys[j]]: created };
      return appendEntry(text, node, (indent) => `${JSON.stringify(keys[k])}: ${render(created, indent, unit, eol)}`, base, unit, eol);
    }
    if (last ? member.value.type !== 'array' : member.value.type !== 'object') {
      throw new Error(`${keys.slice(0, k + 1).join('/')} is not ${last ? 'an array' : 'an object'}`);
    }
    base = lineIndent(text, member.keyStart);
    node = member.value;
  }
  const values = node.items.map((it) => JSON.parse(text.slice(it.start, it.end)));
  const hits = values.map((v, i) => (match(v) ? i : -1)).filter((i) => i >= 0);
  if (hits.length > 1) throw new Error(`${keys.join('/')} holds ${hits.length} entries this edit would take for its own`);
  if (hits.length === 0) {
    if (value === undefined) return text;
    return appendEntry(text, node, (indent) => render(value, indent, unit, eol), base, unit, eol);
  }
  const at = hits[0];
  const it = node.items[at];
  if (value !== undefined) return text.slice(0, it.start) + render(value, lineIndent(text, it.start), unit, eol) + text.slice(it.end);
  // Remove the element and one separator: the comma before it, or after it when it is first.
  if (node.items.length === 1) return removeOnly(text, node, it.end);
  if (at > 0) return text.slice(0, node.items[at - 1].end) + text.slice(it.end);
  return text.slice(0, it.start) + text.slice(node.items[1].start);
}

// The value of the one element `match` picks in the array at `keys`, or why it cannot be told.
export function getElement(text, keys, match) {
  const root = parseSpans(text);
  let node = root;
  for (let k = 0; k < keys.length; k++) {
    if (node.type !== 'object') return { blocked: `${keys.slice(0, k).join('/')} is not an object` };
    let member;
    try {
      member = memberOf(node, keys[k], keys.slice(0, k).join('/'));
    } catch (e) {
      return { blocked: e.message };
    }
    if (!member) return { present: false };
    node = member.value;
  }
  if (node.type !== 'array') return { blocked: `${keys.join('/')} is not an array` };
  const hits = node.items.map((it) => JSON.parse(text.slice(it.start, it.end))).filter(match);
  if (hits.length > 1) return { blocked: `${keys.join('/')} holds ${hits.length} entries for one address` };
  return hits.length ? { present: true, value: hits[0] } : { present: false };
}

// Why the key path cannot be edited in place, or null: a key on it held twice (memberOf).
export function pathBlocked(text, keys) {
  let node = parseSpans(text);
  for (let k = 0; k < keys.length && node.type === 'object'; k++) {
    let member;
    try {
      member = memberOf(node, keys[k], keys.slice(0, k).join('/'));
    } catch (e) {
      return e.message;
    }
    if (!member) return null;
    node = member.value;
  }
  return null;
}

// Set the value at `keys` (a key path of objects), creating the objects on the way, or delete the
// member when `value` is undefined (the objects on the way stay). Only the member's span changes.
export function setKey(text, keys, value) {
  const root = parseSpans(text);
  if (root.type !== 'object') throw new Error('the file is not a JSON object');
  const unit = indentUnit(text);
  const eol = lineEnding(text);
  let node = root;
  let base = '';
  for (let k = 0; k < keys.length; k++) {
    const member = memberOf(node, keys[k], keys.slice(0, k).join('/'));
    const last = k === keys.length - 1;
    if (!member) {
      if (value === undefined) return text;
      let created = value;
      for (let j = keys.length - 1; j > k; j--) created = { [keys[j]]: created };
      return appendEntry(text, node, (indent) => `${JSON.stringify(keys[k])}: ${render(created, indent, unit, eol)}`, base, unit, eol);
    }
    const at = node.members.indexOf(member);
    if (last) {
      if (value !== undefined) return text.slice(0, member.value.start) + render(value, lineIndent(text, member.keyStart), unit, eol) + text.slice(member.value.end);
      // Remove the member and one separator: the comma before it, or after it when it is first.
      if (node.members.length === 1) return removeOnly(text, node, member.value.end);
      if (at > 0) return text.slice(0, node.members[at - 1].value.end) + text.slice(member.value.end);
      return text.slice(0, member.keyStart) + text.slice(node.members[1].keyStart);
    }
    if (member.value.type !== 'object') throw new Error(`${keys.slice(0, k + 1).join('/')} is not an object`);
    base = lineIndent(text, member.keyStart);
    node = member.value;
  }
  return text;
}
