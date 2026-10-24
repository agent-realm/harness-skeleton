// `hs`: request dispatch for the reference adapter (design note v0.2 §7). One envelope in,
// one envelope out; drivers hold everything harness-specific.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './defaults.js';
import { HsError, OPS, PROTOCOLS, checkEnvelope, fail, ok } from './protocol.js';
import * as claudeCode from './drivers/claude-code/index.js';
import * as codex from './drivers/codex/index.js';
import { validateLayers } from './spec/validate.js';
import * as delivery from './deliver.js';
import { launchSpec } from './launch.js';
import * as sessions from './sessions.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const DRIVERS = Object.freeze({ 'claude-code': claudeCode, codex });

// What this build answers. Every other op of §7.1 answers `not_implemented`.
export const IMPLEMENTED = Object.freeze(['describe', 'detect', 'validate', 'observe', 'plan', 'apply', 'recover', 'remove', 'launch-spec', 'sessions.list', 'sessions.read', 'sessions.derive']);

// A harness hs has a driver for, or one the session adapters package reads.
function sessionHarness(args) {
  if (typeof args.harness !== 'string') throw new HsError('bad_request', 'args.harness is required');
  if (DRIVERS[args.harness] || sessions.describeSessions(args.harness)) return args.harness;
  throw new HsError('harness_unknown', `no driver and no session adapter for ${args.harness}`, [args.harness]);
}

function driverFor(args) {
  if (typeof args.harness !== 'string') {
    throw new HsError('bad_request', `args.harness is required; known: ${Object.keys(DRIVERS).join(', ')}`);
  }
  const driver = DRIVERS[args.harness];
  if (!driver) throw new HsError('harness_unknown', `no driver for ${args.harness}; known: ${Object.keys(DRIVERS).join(', ')}`, [args.harness]);
  return driver;
}

// Delivery needs a driver that maps items to native writes; Codex has none yet.
function deliveringDriver(args) {
  const d = driverFor(args);
  if (!d.deliverables) throw new HsError('not_implemented', `this build does not deliver to ${args.harness}`, [args.harness]);
  return d.default ?? d;
}

const handlers = {
  describe(args) {
    const d = driverFor(args);
    return {
      protocols: PROTOCOLS,
      adapter: { name: 'hs', version: pkg.version },
      // Neither profile's operations are all here yet, so this build claims none (§6.2).
      conformance_profile: null,
      operations: [
        'describe', 'detect', 'validate', d.unmanaged ? 'observe' : 'observe --state',
        ...(d.deliverables ? ['plan', 'apply', 'recover', 'remove'] : []),
        ...(d.launchParts ? ['launch-spec'] : []),
        ...(sessions.describeSessions(args.harness) ? ['sessions.list', 'sessions.read', 'sessions.derive'] : []),
      ],
      // sessions@v0's describe, from the session adapters package (§7.1, §7.3).
      sessions: sessions.describeSessions(args.harness),
      delivery_modes: d.deliverables ? d.descriptor.delivery_modes : [],
      not_implemented: OPS.filter((op) => !IMPLEMENTED.includes(op)),
      defaults: DEFAULTS,
      ...d.describeHarness(),
    };
  },
  detect(args) {
    return driverFor(args).detect({ bin: args.bin });
  },
  validate(args) {
    const d = driverFor(args);
    if (!Array.isArray(args.layers) || args.layers.some((l) => typeof l !== 'string' || !path.isAbsolute(l))) {
      throw new HsError('bad_request', 'args.layers must be a list of absolute layer directories, lowest first');
    }
    if (args.local !== undefined && (typeof args.local !== 'string' || !path.isAbsolute(args.local))) {
      throw new HsError('bad_request', 'args.local must be the absolute path of local.toml');
    }
    return validateLayers({ layers: args.layers, local: args.local ?? null }, d.descriptor);
  },
  observe(args, opts) {
    return driverFor(args).observe(args, opts);
  },
  plan(args, opts) {
    return delivery.plan(deliveringDriver(args), args, opts);
  },
  apply(args, opts) {
    return delivery.apply(deliveringDriver(args), args, opts);
  },
  recover(args, opts) {
    return delivery.recover(deliveringDriver(args), args, opts);
  },
  remove(args, opts) {
    return delivery.remove(deliveringDriver(args), args, opts);
  },
  'launch-spec'(args, opts) {
    return launchSpec(deliveringDriver(args), args, opts);
  },
  // The sessions operations need the package's reader, not an hs driver (§7.3): a harness the
  // package reads is served even where hs delivers nothing yet.
  'sessions.list'(args, opts) {
    return sessions.list(sessionHarness(args), args, opts);
  },
  'sessions.read'(args, opts) {
    return sessions.read(sessionHarness(args), args, opts);
  },
  'sessions.derive'(args) {
    return sessions.derive(sessionHarness(args), args);
  },
};

// `opts` reaches the driver only from code (tests); the protocol never carries it.
export function handle(req, opts = {}) {
  try {
    checkEnvelope(req);
    if (!OPS.includes(req.op)) throw new HsError('op_unknown', `unknown op ${JSON.stringify(req.op)}`, [req.op]);
    const handler = handlers[req.op];
    if (!handler) throw new HsError('not_implemented', `${req.op} is not in this build; it answers ${IMPLEMENTED.join(', ')}`, [req.op]);
    return ok(req, handler(req.args ?? {}, opts));
  } catch (e) {
    return fail(req, e);
  }
}
