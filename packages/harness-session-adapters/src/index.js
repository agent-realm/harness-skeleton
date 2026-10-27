// The session adapters, one per harness, by sessions-model §1 rule 3's harness id. Each exports
// sessions v1 §2's four operations: describe(), list(store), read(store, session, source_key,
// from, known) and derive(session, input, state), with plain JSON in and out. An adapter with file
// sources also exports unitsFromBytes(source_key, bytes, {start}), dispatched to below.

import * as claudeCode from './harnesses/claude-code/index.js';
import * as copilotCli from './harnesses/copilot-cli/index.js';
import * as geminiCli from './harnesses/gemini-cli/index.js';
import * as vscode from './harnesses/vscode/index.js';
import * as goose from './harnesses/goose/index.js';
import * as opencode from './harnesses/opencode/index.js';
import * as agy from './harnesses/agy/index.js';
import * as cursor from './harnesses/cursor/index.js';
import * as cursorAgent from './harnesses/cursor-agent/index.js';
import * as zed from './harnesses/zed/index.js';
import * as devin from './harnesses/devin/index.js';
import * as codex from './harnesses/codex/index.js';
import { SessionsError } from './errors.js';

export const ADAPTERS = Object.freeze({
  'claude-code': claudeCode,
  codex,
  'copilot-cli': copilotCli,
  'gemini-cli': geminiCli,
  vscode,
  goose,
  opencode,
  agy,
  cursor,
  'cursor-agent': cursorAgent,
  zed,
  devin,
});

export function adapterFor(harness) {
  const a = ADAPTERS[harness];
  if (!a) throw new SessionsError('harness_unknown', `no session adapter for ${harness}`, [harness]);
  return a;
}

// The units `read(store, session, source_key, null, null)` returns from scratch for a file source
// holding `bytes`, as `{units, held_back}`: the same line split, unit keys, redaction and
// post-processing, with no position, no continuity and no file system access. For a consumer that
// archived a source's raw bytes and re-derives from them after the harness deleted the file.
// `start` is the generation offset of the first byte of a stream's `bytes`; a snapshot's is 0.
// A harness or a source with no file bytes (a database's table or key range) is a `bad_request`.
export function unitsFromBytes(harness, source_key, bytes, { start = 0 } = {}) {
  const a = adapterFor(harness);
  if (typeof a.unitsFromBytes !== 'function') {
    throw new SessionsError('bad_request', `${harness} keeps its sessions in databases: none of its sources has file bytes to re-read (read them with read())`, [harness, String(source_key)]);
  }
  return a.unitsFromBytes(source_key, bytes, { start });
}

export { SessionsError, CODES } from './errors.js';
export { host, hostLabel } from './host.js';
export { harnessPath } from './harness-path.js';
export { validateSession } from './validate.js';
