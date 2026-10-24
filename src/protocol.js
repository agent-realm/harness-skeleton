// The hs/0.2 envelope (design note v0.2 §7.1): one JSON request in, one JSON response out.

export const PROTOCOL = 'hs/0.2';
export const PROTOCOLS = Object.freeze([PROTOCOL]);

// Every op the protocol defines (§7.1). An op in this list that a build does not carry
// yet answers `not_implemented`; anything else is `op_unknown`.
export const OPS = Object.freeze([
  'describe', 'detect', 'validate', 'observe', 'plan', 'apply', 'recover', 'remove',
  'import', 'launch-spec', 'sessions.list', 'sessions.read', 'sessions.derive', 'login-status',
]);

// Lists in a response are cut at this length and marked `truncated` (§7.1: output is bounded).
export const LIST_LIMIT = 200;

// `retryable`: the same request may succeed if sent again unchanged (a store busy or caught
// mid-write); the envelope carries it on every error (§7.1).
export class HsError extends Error {
  constructor(code, message, items = [], { retryable = false } = {}) {
    super(message);
    this.code = code;
    this.items = items;
    this.retryable = retryable;
  }
}

export function parseRequest(text) {
  let req;
  try {
    req = JSON.parse(text);
  } catch (e) {
    throw new HsError('bad_request', `request is not JSON: ${e.message}`);
  }
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    throw new HsError('bad_request', 'request must be a JSON object');
  }
  return req;
}

export function checkEnvelope(req) {
  if (!PROTOCOLS.includes(req.protocol)) {
    throw new HsError('protocol_unsupported',
      `protocol ${JSON.stringify(req.protocol)} is not spoken; this adapter speaks ${PROTOCOLS.join(', ')}`);
  }
  if (typeof req.op !== 'string') throw new HsError('bad_request', 'op must be a string');
  if (req.args !== undefined && (req.args === null || typeof req.args !== 'object' || Array.isArray(req.args))) {
    throw new HsError('bad_request', 'args must be a JSON object');
  }
}

export function ok(req, result) {
  return { protocol: PROTOCOL, request_id: req?.request_id ?? null, ok: true, result };
}

export function fail(req, err) {
  const known = err instanceof HsError;
  return {
    protocol: PROTOCOL,
    request_id: req?.request_id ?? null,
    ok: false,
    error: {
      code: known ? err.code : 'internal',
      message: err.message,
      items: known ? err.items : [],
      retryable: known ? err.retryable === true : false,
    },
  };
}

export function bounded(list, limit = LIST_LIMIT) {
  return list.length > limit
    ? { items: list.slice(0, limit), truncated: true, total: list.length }
    : { items: list, truncated: false, total: list.length };
}
