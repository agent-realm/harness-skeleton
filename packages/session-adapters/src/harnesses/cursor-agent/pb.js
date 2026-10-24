// The protobuf wire format cursor-agent stores its blobs in, read by field number, and the
// `pb-json` form `read` gives a blob that carries a value it must redact (sessions-model §3, §4.4).
// Ported from memhouse's v4 normaliser (its cursor-agent module: the varint
// reader, the field parser and the message walker). The field numbers follow the cursor-agent
// 2026.10.19 descriptors, as
// extracted into the fixture captures (synthetic, captured on a test VM).
//
// New here:
// - `Msg` reads either raw bytes or a pb-json tree, so derive treats a redacted unit like any
//   other;
// - `toPbJson()`: a blob decoded only along the paths a plan names, every other field kept as its
//   stored bytes (base64), and the planned values replaced by the marker. Bytes are never
//   re-encoded, and `orig_sha256` keeps the content address (the blob id).
//
// pb-json: {"orig_sha256": <hex>, "fields": [entry, …]}, the entries in wire order, each
//   {"n": <field>, "w": <wire type>, and one of:
//     "v": <varint, a number; a decimal string beyond 2^53>
//     "b64": <the stored bytes of a length-delimited or fixed field>
//     "fields": [entry, …]   a length-delimited field decoded, because the plan goes inside it
//     "redacted": "<redacted len=N>"   N = the byte length of the field's value}

import { sha256 } from '../../jcs.js';

export class Malformed extends Error {}
const EMPTY = Buffer.alloc(0);

function varint(buf, pos) {
  let n = 0;
  let mul = 1;
  for (let i = 0; i < 7; i++) {
    if (pos >= buf.length) throw new Malformed('varint');
    const b = buf[pos++];
    n += (b & 0x7f) * mul;
    if (b < 0x80) return [n, pos];
    mul *= 128;
  }
  let big = BigInt(n);
  for (let i = 7; i < 10; i++) {
    if (pos >= buf.length) throw new Malformed('varint');
    const b = buf[pos++];
    big += BigInt(b & 0x7f) << BigInt(7 * i);
    if (b < 0x80) return [big, pos];
  }
  throw new Malformed('varint');
}
const toNum = (v) => (typeof v === 'bigint' ? Number(BigInt.asIntN(64, v)) : v);

// [field number, wire type, value, start, end]: value a number or BigInt (w0), else the bytes.
function* wire(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    let key;
    [key, pos] = varint(buf, pos);
    key = toNum(key);
    const n = Math.floor(key / 8);
    const w = key % 8;
    if (n < 1) throw new Malformed('field 0');
    let v;
    if (w === 0) [v, pos] = varint(buf, pos);
    else if (w === 2) {
      let len;
      [len, pos] = varint(buf, pos);
      len = toNum(len);
      if (len < 0 || pos + len > buf.length) throw new Malformed('length');
      v = buf.subarray(pos, pos + len);
      pos += len;
    } else if (w === 1 || w === 5) {
      const k = w === 1 ? 8 : 4;
      if (pos + k > buf.length) throw new Malformed('fixed');
      v = buf.subarray(pos, pos + k);
      pos += k;
    } else throw new Malformed(`wire type ${w}`);
    yield [n, w, v, start, pos];
  }
}

const REDACTED = Symbol('redacted');
export const marker = (n) => `<redacted len=${n}>`;
export const isMarker = (v) => typeof v === 'string' && /^<redacted len=\d+>$/.test(v);

// A decoded message: field number -> [{w, v}]. A length-delimited value is the stored bytes, a
// decoded `Msg` (pb-json `fields`), or {[REDACTED]: marker}. Singular reads take the last value.
export class Msg {
  constructor(f = new Map()) {
    this.f = f;
  }

  static from(buf) {
    const f = new Map();
    for (const [n, w, v] of wire(buf || EMPTY)) {
      if (!f.has(n)) f.set(n, []);
      f.get(n).push({ w, v });
    }
    return new Msg(f);
  }

  // A pb-json tree (its `fields`).
  static fromTree(entries) {
    const f = new Map();
    for (const e of entries || []) {
      let v;
      if ('v' in e) v = typeof e.v === 'string' ? BigInt(e.v) : e.v;
      else if ('fields' in e) v = Msg.fromTree(e.fields);
      else if ('redacted' in e) v = { [REDACTED]: e.redacted };
      else v = Buffer.from(e.b64 || '', 'base64');
      if (!f.has(e.n)) f.set(e.n, []);
      f.get(e.n).push({ w: e.w, v });
    }
    return new Msg(f);
  }

  has(n) { return this.f.has(n); }
  get size() { return this.f.size; }
  keys() { return [...this.f.keys()]; }
  last(n) { const a = this.f.get(n); return a ? a[a.length - 1] : null; }
  lens(n) { return (this.f.get(n) || []).filter((x) => x.w === 2).map((x) => x.v); }
  str(n) { const x = this.last(n); return x && x.w === 2 ? textOf(x.v) : ''; }
  strs(n) { return this.lens(n).map(textOf); }
  num(n) { const x = this.last(n); return x && x.w === 0 ? toNum(x.v) : null; }
  bool(n) { return !!this.num(n); }
  double(n) { const x = this.last(n); return x && x.w === 1 && Buffer.isBuffer(x.v) ? x.v.readDoubleLE(0) : null; }
  msg(n) { const x = this.last(n); return x && x.w === 2 ? msgOf(x.v) : null; }
  msgs(n) { return this.lens(n).map(msgOf).filter(Boolean); }
  ref(n) { const x = this.last(n); return x && x.w === 2 && Buffer.isBuffer(x.v) ? x.v.toString('hex') : ''; }
  refs(n) { return this.lens(n).filter(Buffer.isBuffer).map((v) => v.toString('hex')); }
  // The byte length of a length-delimited field's value, as stored.
  lenOf(n) { const x = this.last(n); return x && x.w === 2 && Buffer.isBuffer(x.v) ? x.v.length : null; }
  // The first field present among `cases` (a oneof), with its message (empty when redacted).
  oneof(cases) {
    for (const c of cases) if (this.has(c)) return [c, this.msg(c) || new Msg()];
    return [0, null];
  }
}

function textOf(v) {
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (v && typeof v === 'object' && REDACTED in v) return v[REDACTED];
  return '';
}
function msgOf(v) {
  if (v instanceof Msg) return v;
  if (Buffer.isBuffer(v)) return Msg.from(v);
  return null; // redacted
}

// The fields of `buf`, or null when it does not parse.
export function tryWire(buf) {
  try {
    return [...wire(buf)];
  } catch {
    return null;
  }
}

// Decode `buf` along `plan` into a pb-json `fields` list. A plan maps a field number (or '*', any
// other field) to 'redact', 'keep' (its stored bytes) or a nested plan. 'redact' on a varint or
// fixed field keeps it (a number holds no secret); on a length-delimited one it puts the marker.
// Throws Malformed.
function planned(buf, plan) {
  const out = [];
  for (const [n, w, v] of wire(buf)) {
    const p = plan[n] ?? plan['*'];
    if (w === 0) out.push({ n, w, v: typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v });
    else if (w !== 2 || !p || p === 'keep') out.push({ n, w, b64: v.toString('base64') });
    else if (p === 'redact') out.push({ n, w, redacted: marker(v.length) });
    else out.push({ n, w, fields: planned(v, p) });
  }
  return out;
}

// The pb-json body of `buf` redacted along `plan`, as an object (the caller serialises it).
export function toPbJson(buf, plan) {
  return { orig_sha256: sha256(buf), fields: planned(buf, plan) };
}
