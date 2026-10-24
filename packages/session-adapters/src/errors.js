// Typed errors. A caller (harness-skeleton's §7.3 shim, memhouse's engine) maps `code` to its own
// envelope; the codes are sessions v1 §2's read errors plus the ones host and harness_path raise.

export const CODES = Object.freeze([
  'session_unknown',
  'incarnation_gone',
  'source_unknown',
  // Retryable (sessions §2): a lock past the wait, a torn view, a damaged page or row.
  'busy',
  'inconsistent',
  'damaged',
  'harness_unknown',
  'bad_request',
  'folder_missing',
  'host_unreadable',
  'platform_unsupported',
]);

export class SessionsError extends Error {
  constructor(code, message, items = []) {
    super(message);
    this.name = 'SessionsError';
    this.code = code;
    this.items = items;
  }
}
