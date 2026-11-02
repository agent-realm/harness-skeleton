// The five record types of sessions-model §2 and the helpers every derive uses: the session key,
// the per-type key, `content_sha`, `cmp_sha`, and the fingerprint.
//
// A record carries `type` ('session' | 'message' | 'usage' | 'link' | 'lifecycle'), as
// sessions-model §2 names it.

import { jcs, jcsSha, sha256 } from './jcs.js';

export const RECORD_TYPES = Object.freeze(['session', 'message', 'usage', 'link', 'lifecycle']);

// The session key every record carries (sessions-model §1).
export function sessionKey(store, session) {
  return {
    host: store.host,
    harness: store.harness,
    harness_path: store.harness_path,
    session_id: session.session_id,
    incarnation: session.incarnation ?? '',
  };
}

// A record's own key within its session, as one string: what `live` lists per type.
export function recordKey(r) {
  switch (r.type) {
    case 'session': return '';
    case 'message': return r.message_id;
    case 'usage': return r.usage_id;
    case 'lifecycle': return r.lifecycle_id;
    // A link statement is keyed on (kind, other side's reference, at), sessions-model §2.5.
    case 'link': return jcs([r.kind, r.stated_on === 'origin' ? r.child : r.origin, r.at ?? '']);
    default: throw new TypeError(`unknown record type ${r.type}`);
  }
}

// sha256 of the record's JCS form without the two hashes and `units` (sessions-model §2, v1.4:
// `units` is outside it, so a stream reset that re-keys the units revises no record).
export function contentSha(r) {
  const { content_sha: _c, cmp_sha: _m, units: _u, ...rest } = r;
  return jcsSha(rest);
}

// A record's `units` (sessions-model §2.7): [source_key, generation, unit_key] triples, sorted by
// source_key, then generation, then unit_key, with no triple twice. An adapter hands them in any
// order; seal() puts them in this one. A malformed triple is an adapter bug, and fails loudly.
export function normaliseUnits(units) {
  if (!Array.isArray(units)) throw new TypeError(`units must be a list, not ${JSON.stringify(units)}`);
  const seen = new Set();
  const out = [];
  for (const t of units) {
    const ok = Array.isArray(t) && t.length === 3 && typeof t[0] === 'string' && t[0] !== ''
      && Number.isInteger(t[1]) && t[1] >= 0 && typeof t[2] === 'string' && t[2] !== '';
    if (!ok) throw new TypeError(`a units triple must be [source_key, generation, unit_key], not ${JSON.stringify(t)}`);
    const triple = [t[0], t[1], t[2]];
    const k = JSON.stringify(triple);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(triple);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1] || cmp(a[2], b[2]));
}

// The declared native fields of a native record (sessions-model §2.7): for each declared dotted
// path that the record holds, its value, keyed by the path; nothing else. `{}` when it holds none.
// A path walks objects only, as the redaction paths do (§4).
export function nativeOf(record, paths) {
  const out = {};
  for (const path of paths ?? []) {
    let v = record;
    for (const seg of path.split('.')) {
      if (v === null || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, seg)) { v = undefined; break; }
      v = v[seg];
    }
    if (v !== undefined) out[path] = v;
  }
  return out;
}

// The semantic comparison hash of a message (sessions-model §2): role and parts only, without
// structural identity. `attachmentSha` gives an attachment part's decoded-bytes sha, or null.
export function cmpSha(message) {
  const parts = (message.parts ?? []).map((p) => {
    switch (p.kind) {
      case 'text':
      case 'summary':
      case 'notice':
        return { kind: p.kind, text: p.text ?? null };
      case 'reasoning':
        return p.opaque ? { kind: p.kind, opaque: true } : { kind: p.kind, text: p.text ?? null };
      case 'tool_call':
        return { kind: p.kind, name: p.name ?? null, args: p.args ?? null };
      case 'tool_result':
        return { kind: p.kind, output: p.output ?? null, is_error: p.is_error ?? null };
      case 'attachment':
        // The decoded bytes' sha; a `ref` this derive cannot read counts as null.
        return { kind: p.kind, media_type: p.media_type ?? null, sha256: typeof p.inline === 'string' ? sha256(Buffer.from(p.inline, 'base64')) : null };
      case 'error':
        // The error's own kind is `error_kind`, since the part's `kind` holds 'error'
        // (sessions-model §2.3; cmp_sha takes `error_kind` and `message`).
        return { kind: p.kind, error_kind: p.error_kind ?? null, message: p.message ?? null };
      default:
        return { kind: p.kind };
    }
  });
  return jcsSha({ role: message.role, parts });
}

// Seal a record: set `cmp_sha` on messages, then `content_sha` on every record.
export function seal(r) {
  const out = { ...r };
  delete out.content_sha;
  delete out.cmp_sha;
  // Every tool_result carries `exit_code` (sessions-model §2.3): null unless the adapter read one
  // that the harness store keeps apart from the output.
  if (out.type === 'message' && Array.isArray(out.parts)) {
    out.parts = out.parts.map((p) => (p && p.kind === 'tool_result' && !('exit_code' in p) ? { ...p, exit_code: null } : p));
  }
  // `setup` on a session and `tool_prompt` on usage are null unless the adapter read them
  // (sessions-model §2.1, §2.4).
  if (out.type === 'session' && !('setup' in out)) out.setup = null;
  if (out.type === 'usage' && !('tool_prompt' in out)) out.tool_prompt = null;
  if ('units' in out) out.units = normaliseUnits(out.units);
  if (out.type === 'message') out.cmp_sha = cmpSha(out);
  out.content_sha = contentSha(out);
  return out;
}

// Fold one derive's output into the consumer's view of a session: upsert `changed`, then drop
// every adapter-owned key absent from both `live` and `held` (sessions §4, the tombstoning
// consumer). A held key keeps its last version.
export function applyDerive(view, { changed, live, held = {} }) {
  const next = new Map(view);
  for (const r of changed) next.set(r.type + '\u0000' + recordKey(r), r);
  const keep = new Set();
  for (const set of [live, held]) {
    for (const [type, keys] of Object.entries(set)) for (const k of keys) keep.add(type + '\u0000' + k);
  }
  for (const k of next.keys()) if (!keep.has(k)) next.delete(k);
  return next;
}
