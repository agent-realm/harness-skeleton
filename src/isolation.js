// Strict isolation (design note v0.2 §8, question 7). A spec that says `isolation = "strict"` asks
// that only the instructions and skills it names reach the launched agent: none from $HOME, from
// the working directory and its parents, from the system config, or from the folder itself unless
// a plan of this spec put them there. A driver closes each inbound escape it can, by the switch its
// descriptor names (`strict` on the escape, `isolation.strict` on the descriptor), and refuses the
// launch for every other inbound escape that applies here, naming its path. An escape that names a
// path applies when that path exists; one that names a walk of the working directory and its
// parents applies wherever the agent runs, since a launch does not know where that is. Paths are
// stat'ed only: no escape's content is read. The project's own AGENTS.md is never added back: a
// caller who wants it names it in the spec.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HsError } from './protocol.js';
import { escapesHere } from './driver-common.js';

export const ISOLATION = Object.freeze(['default', 'strict']);

// Whether the spec asks for strict isolation.
export function strictIsolation(resolved) {
  return resolved.items.some((i) => i.kind === 'isolation' && i.value === 'strict');
}

const expand = (p, home) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
const present = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// The inbound escapes no switch of this driver closes and that apply here.
export function unclosable(descriptor, { home, platform = process.platform } = {}) {
  const h = home ?? os.homedir();
  return escapesHere(descriptor, platform).filter((e) => {
    if (e.kind !== 'inbound-read' || e.closable || e.strict) return false;
    const located = e.path.startsWith('/') || e.path.startsWith('~/');
    return located ? present(expand(e.path.replace(/\/$/, ''), h)) : true;
  });
}

// Why a strict launch or plan cannot be kept isolated here, or null when it can.
export function unisolatedReason(descriptor, opts) {
  const left = unclosable(descriptor, opts);
  if (!left.length) return null;
  const why = descriptor.isolation?.reason ? `: ${descriptor.isolation.reason}` : '';
  return { paths: left.map((e) => e.path), message: `isolation = "strict": ${descriptor.name} would still read ${left.map((e) => e.path).join('; ')}, which this build cannot keep out${why}; deliver without strict isolation, or on a harness that can` };
}

// Refuses a strict launch the driver cannot keep isolated.
export function refuseUnisolated(descriptor, opts) {
  const r = unisolatedReason(descriptor, opts);
  if (r) throw new HsError('isolation_unmet', r.message, r.paths);
}

// What `describe` says about isolation.
export function describeIsolation(descriptor, platform = process.platform) {
  const S = descriptor.isolation?.strict ?? null;
  const all = escapesHere(descriptor, platform).filter((e) => e.kind === 'inbound-read' && !e.closable);
  return {
    values: [...ISOLATION],
    default: 'the harness\'s own discovery: the known limits are what reaches a launch that the spec did not name',
    strict: S
      ? {
        supported: true,
        how: S.how,
        closes: all.filter((e) => e.strict).map((e) => ({ path: e.path, by: e.strict })),
        refused_when_present: all.filter((e) => !e.strict).map((e) => e.path),
        ...(S.refuses ? { refused_when_the_folder_holds: S.refuses_text } : {}),
        folder: S.folder,
        launch_only: 'only hs\'s own launches are isolated: a start of the folder by other means reads what the harness reads',
      }
      : { supported: false, reason: descriptor.isolation?.reason ?? 'no switch is measured', refused: all.filter((e) => !e.strict).map((e) => e.path) },
    project_instructions: 'under strict, a caller who wants the project\'s instructions names them in the spec: the project\'s own AGENTS.md, which the switches keep out, is never added back',
  };
}

const DEFAULT_REASON = 'isolation = "default": the harness\'s own discovery, nothing to deliver; describe names the known limits';

// The isolation item in a plan: the default has nothing to deliver; strict is launch only where the
// driver keeps it, and refused where it cannot.
export function isolationPlan(resolved, descriptor, opts) {
  const it = resolved.items.find((i) => i.kind === 'isolation');
  if (!it) return {};
  if (it.value !== 'strict') return { skipped: { item: it.id, reason: DEFAULT_REASON } };
  const S = descriptor.isolation?.strict;
  const r = unisolatedReason(descriptor, opts);
  if (!S || r) return { refused: { item: it.id, code: 'isolation_unmet', reason: r ? r.message : `isolation = "strict": ${descriptor.isolation?.reason}` } };
  return { launch_only: { item: it.id, value: 'strict', via: `launch-spec: ${S.how}; only hs's own launches are isolated: a start of the folder by other means reads what ${descriptor.name} reads` } };
}

// The isolation item at launch: refused before anything else when strict cannot be kept here.
export function isolationLaunch(resolved, descriptor, opts) {
  const it = resolved.items.find((i) => i.kind === 'isolation');
  if (!it) return {};
  if (it.value !== 'strict') return { skipped: { item: it.id, reason: DEFAULT_REASON } };
  refuseUnisolated(descriptor, opts);
  const S = descriptor.isolation?.strict;
  if (!S) throw new HsError('isolation_unmet', `isolation = "strict": ${descriptor.isolation?.reason}`, [it.id]);
  return { item: { item: it.id, value: 'strict', via: S.how }, note: `isolation = "strict": ${S.folder}; ${describeIsolation(descriptor, opts?.platform).project_instructions}` };
}
