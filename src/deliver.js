// Delivery (design note v0.2 §7.1, §7.2, §7.4, §9.3): plan, apply, recover, remove, and the
// managed half of observe. Harness-neutral: a driver says what each spec item becomes natively
// (`deliverables`) and whether the harness is busy (`liveCheck`); this file decides what
// changes, refuses what must not change, and writes through `native.js` only.
//
// Plans are data, and a caller never chooses a native effect (§7.2): `apply` does not run the
// operations it is handed. Under the lock it derives them again from the plan's recorded
// arguments (layers, local.toml, owner, flags), the folder and the ledger, and runs them only if
// the result is the plan, byte for byte (`plan_stale` otherwise).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHIM_DIR } from './shim-dir.js';
import { HsError, PROTOCOL } from './protocol.js';
import { harnessPath } from './harness-path.js';
import { hostId } from './host.js';
import { digestPath, resolve } from './spec/layers.js';
import { validate } from './spec/validate.js';
import { checkAddress, handlers, treeLink } from './native.js';
import {
  acquireLock, digestOf, journal, loadRecord, newApplyId, readJournal, readLedger, recordsDir, storeRecord, sweepStaged, unfinished, writeLedger,
} from './records.js';

export const PLAN_FORMAT = 'hs-plan/0.2';
export const RECEIPT_FORMAT = 'hs-receipt/0.2';
export const MODES = Object.freeze(['materialize', 'overlay']); // reconcile later

const WRITES = new Set(['create', 'update', 'reset', 'remove', 'restore', 'clear']);
const OWNER = /^[a-z][a-z0-9-]{0,63}$/;

function planDigest(plan) {
  const { digest, ...body } = plan;
  return 'sha256:' + digestOf(body);
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function parseAddress(addr) {
  const el = /^([^#]+)#(.+)\[([^\]]+)\]$/.exec(addr);
  if (el) return { handler: 'json-element', address: { file: el[1], key: el[2], id: el[3] } };
  return addr.includes('#')
    ? { handler: 'json-key', address: { file: addr.slice(0, addr.indexOf('#')), key: addr.slice(addr.indexOf('#') + 1) } }
    : { handler: 'tree', address: { path: addr } };
}

// The arguments a plan records, checked; apply derives from these and nothing else.
function planArgs(args) {
  const mode = args.mode ?? 'materialize';
  if (!MODES.includes(mode)) throw new HsError('not_implemented', `delivery mode ${mode} is not in this build; it plans ${MODES.join(', ')}`, [mode]);
  if (typeof args.owner !== 'string' || !OWNER.test(args.owner)) {
    throw new HsError('bad_request', 'owner must be lowercase letters, digits and dashes, starting with a letter');
  }
  if (!Array.isArray(args.layers) || args.layers.some((l) => typeof l !== 'string' || !path.isAbsolute(l))) {
    throw new HsError('bad_request', 'args.layers must be a list of absolute layer directories, lowest first');
  }
  if (args.local !== undefined && args.local !== null && (typeof args.local !== 'string' || !path.isAbsolute(args.local))) {
    throw new HsError('bad_request', 'args.local must be the absolute path of local.toml');
  }
  return {
    layers: [...args.layers], local: args.local ?? null, owner: args.owner, mode,
    prune: args.prune === true, adopt: args.adopt === true, strict_version: args.strict_version === true,
    no_persist_state: args.no_persist_state === true,
    // The folder path as the caller spelled it: a login's keychain item is keyed to a spelling
    // (§7.5), and apply re-derives with the one the plan asked about.
    given_path: typeof args.given_path === 'string' ? args.given_path : (typeof args.harness_path === 'string' ? args.harness_path : null),
  };
}

// Inside `certified` everything runs; inside `compatible`, with a warning unless strict;
// outside both, or unknown, writes refuse (§7.2).
function versionGate(detected, strict) {
  if (!detected.present) throw new HsError('version_unsupported', 'the harness binary was not found; writes need a known version', []);
  if (detected.range === 'certified') return [];
  if (detected.range === 'compatible' && !strict) return [`uncertified_version: ${detected.version} is compatible, not certified`];
  throw new HsError('version_unsupported', `${detected.version ?? 'an unknown version'} is ${detected.range}${strict ? ' and --strict-version is set' : ''}`, [detected.version]);
}

// ---- plan ------------------------------------------------------------------------------

function derive(driver, folder, pargs, opts, bin) {
  const descriptor = driver.descriptor;
  if (!(descriptor.delivery_modes ?? []).includes(pargs.mode)) {
    throw new HsError('not_implemented', `this build plans ${(descriptor.delivery_modes ?? []).join(', ') || 'nothing'} for ${descriptor.name}, not ${pargs.mode}`, [pargs.mode]);
  }
  const resolved = resolve(pargs.layers, pargs.local);
  const checked = validate(resolved, descriptor);
  const errors = checked.problems.filter((p) => p.severity === 'error');
  if (errors.length) throw new HsError('spec_invalid', `the spec has ${errors.length} error(s); run validate`, errors);
  const warnings = checked.problems.filter((p) => p.severity === 'warning').map((p) => `${p.code}: ${p.message}`);
  const detected = driver.detect({ bin });
  warnings.push(...versionGate(detected, pargs.strict_version));

  const d = driver.deliverables(resolved, {
    folder, mode: pargs.mode, home: opts.home, state: opts.state, noPersist: pargs.no_persist_state,
    platform: opts.host?.platform ?? process.platform, keychain: opts.keychain, given: pargs.given_path,
    version: detected.version, owner: pargs.owner,
  });
  if (d.not_implemented.length) {
    throw new HsError('not_implemented', `this build does not deliver ${d.not_implemented.join(', ')}; remove them, or wait for the milestone that delivers them`, d.not_implemented);
  }

  const { owner } = pargs;
  const ledger = readLedger(folder);
  const refused = [...(d.refused ?? [])];
  const operations = [];
  const wanted = new Set(d.keep ?? []);
  for (const item of d.deliverables) {
    let addr;
    try {
      addr = checkAddress(descriptor, item.handler, item.address);
    } catch (e) {
      refused.push({ item: item.item, code: e.code, reason: e.message });
      continue;
    }
    wanted.add(addr);
    const cur = handlers[item.handler].current(folder, descriptor, item.address);
    if (cur.blocked) {
      refused.push({ item: item.item, code: 'write_refused', reason: cur.blocked });
      continue;
    }
    const want = item.handler === 'tree' ? item.source_sha256 : digestOf(item.value);
    const base = {
      item: item.item, handler: item.handler, address: item.address, address_id: addr, class: 'config',
      ...(item.handler === 'tree' ? { source: item.source, source_sha256: item.source_sha256 } : { value: item.value }),
      desired_sha256: want, precondition: { sha256: cur.digest }, risk: item.risk ?? [],
      ...(item.note ? { note: item.note } : {}),
    };
    const entry = ledger.addresses[addr];
    const mine = entry?.owners[owner];
    const others = entry ? Object.keys(entry.owners).filter((o) => o !== owner) : [];
    if (others.some((o) => entry.owners[o].installed !== want)) {
      refused.push({ item: item.item, code: 'owner_conflict', reason: `${addr} is delivered by ${others.join(', ')} with other content` });
      continue;
    }
    if (!entry) {
      if (!cur.present) {
        operations.push({ ...base, action: 'create', previous: { present: false } });
      } else if (pargs.adopt || item.adopt_implicit) {
        const previous = item.handler !== 'tree' ? { present: true, value: cur.value } : { present: true, adopted: true };
        operations.push({ ...base, action: cur.digest === want ? 'adopt' : 'update', previous, adopted: true });
      } else {
        refused.push({ item: item.item, code: 'unowned_conflict', reason: `${addr} exists and is in no ledger; --adopt records it under ${owner}` });
      }
    } else if (mine) {
      if (cur.digest === want && mine.installed === want) continue; // already delivered
      if (cur.digest === want) operations.push({ ...base, action: 'adopt', previous: entry.previous });
      else if (cur.digest === mine.installed) operations.push({ ...base, action: 'update', previous: entry.previous });
      else operations.push({ ...base, action: 'reset', previous: entry.previous, note: `${addr} drifted from what ${owner} installed; materialize resets it, and keeps what it replaces in the records` });
    } else if (cur.digest === want) {
      operations.push({ ...base, action: 'share', previous: entry.previous, risk: [] });
    } else {
      refused.push({ item: item.item, code: 'owner_conflict', reason: `${addr} is not what ${others.join(', ')} installed` });
    }
  }
  // Clears (§7.2): single state keys of a mixed file, deleted one way. No ledger entry, so no
  // remove restores them, and no value in the plan or the records: only that the key was there.
  for (const c of d.clears ?? []) {
    let addr;
    try {
      addr = checkAddress(descriptor, 'json-key', c.address);
    } catch (e) {
      refused.push({ item: c.item, code: e.code, reason: e.message });
      continue;
    }
    const cur = handlers['json-key'].current(folder, descriptor, c.address);
    if (cur.blocked) {
      refused.push({ item: c.item, code: 'write_refused', reason: cur.blocked });
      continue;
    }
    if (!cur.present) continue;
    if (pargs.mode === 'overlay' && pargs.no_persist_state) {
      d.skipped.push({ item: c.item, reason: `no_persist_state: ${addr} is left in place` });
      continue;
    }
    operations.push({
      item: c.item, handler: 'json-key', address: c.address, address_id: addr, class: 'state', action: 'clear',
      desired_sha256: null, precondition: { sha256: cur.digest }, risk: ['clears-state'], note: c.note,
    });
  }
  if (refused.length) throw new HsError(refused[0].code, `the plan is refused: ${refused.map((r) => `${r.item} (${r.code})`).join(', ')}`, refused);

  // --prune: this owner's items that the spec no longer wants.
  // Under overlay a removal is a write too: with no_persist_state none is made, and an address
  // holding a [state] value is never removed, since restoring an earlier value could lower it.
  if (pargs.prune) {
    for (const [addr, entry] of Object.entries(ledger.addresses)) {
      if (!entry.owners[owner] || wanted.has(addr)) continue;
      if (pargs.mode === 'overlay' && (pargs.no_persist_state || (d.state_addresses ?? []).includes(addr))) {
        d.skipped.push({ item: entry.owners[owner].item, reason: pargs.no_persist_state ? 'no_persist_state: --prune writes nothing under overlay' : 'under overlay a --prune never removes a [state] value: restoring an earlier one could lower it' });
        continue;
      }
      operations.push(removalOp(folder, descriptor, addr, entry, owner));
    }
  }

  const body = {
    format: PLAN_FORMAT,
    protocol: PROTOCOL,
    harness: descriptor.harness,
    harness_version: detected.version,
    range: detected.range,
    host: hostId(opts.host).host,
    harness_path: folder,
    args: pargs,
    spec_digest: resolved.digest,
    ledger_sha256: 'sha256:' + digestOf(ledger),
    operations: operations.map((op, i) => ({ id: `op-${i + 1}`, ...op, risk: WRITES.has(op.action) ? op.risk : [] })),
    skipped: d.skipped,
    launch_only: d.launch_only ?? [],
    reduces_capture: d.reduces_capture,
    overridden_by_managed: d.overridden_by_managed,
    warnings,
    ...(d.unverified?.length ? { unverified: d.unverified } : {}),
    unchanged: operations.length === 0,
  };
  return { ...body, digest: planDigest(body) };
}

export function plan(driver, args, opts = {}) {
  const pargs = planArgs(args);
  return derive(driver, harnessPath(args.harness_path), pargs, opts, args.bin);
}

// The operation that takes `owner`'s item at `addr` back out (§7.2, §7.4): only where the
// installed digest still matches, and only for the last owner of a shared address. An adopted
// tree that was replaced comes back from the records; an adopted tree that was not is released.
function removalOp(folder, descriptor, addr, entry, owner) {
  const mine = entry.owners[owner];
  const others = Object.keys(entry.owners).filter((o) => o !== owner);
  const { handler, address } = parseAddress(addr);
  const base = { item: mine.item, handler, address, address_id: addr, class: 'config', risk: [] };
  if (others.length) return { ...base, action: 'unshare', desired_sha256: mine.installed, precondition: { sha256: null }, skip_check: true };
  const cur = handlers[handler].current(folder, descriptor, address);
  if (cur.blocked || cur.digest !== mine.installed) {
    return { ...base, action: 'skip', reason: cur.blocked ?? `${addr} changed since ${owner} installed it; it is left as it is`, precondition: { sha256: cur.digest ?? null }, skip_check: true };
  }
  const prev = entry.previous ?? { present: false };
  if (handler === 'tree' && prev.adopted) {
    const copy = prev.tree && path.join(folder, prev.tree);
    if (!copy) return { ...base, action: 'release', desired_sha256: mine.installed, precondition: { sha256: cur.digest } };
    if (!fs.existsSync(copy)) {
      return { ...base, action: 'skip', reason: `the user's original of ${addr} is no longer in the records (${prev.tree}); it is left as it is`, precondition: { sha256: cur.digest }, skip_check: true };
    }
    return { ...base, action: 'restore', source: copy, source_sha256: digestPath(copy), desired_sha256: digestPath(copy), precondition: { sha256: cur.digest } };
  }
  if ((handler === 'json-key' || handler === 'json-element') && prev.present) {
    return { ...base, action: 'remove', value: prev.value, desired_sha256: digestOf(prev.value), precondition: { sha256: cur.digest } };
  }
  return { ...base, action: 'remove', desired_sha256: null, precondition: { sha256: cur.digest } };
}

// ---- apply, recover, remove -----------------------------------------------------------------

// A tree's source is a skill directory of one of the plan's layers, or a copy the records keep.
function checkSource(folder, planBody, op, descriptor) {
  if (!op.source) return;
  // hs's own shim (src/shim/), copied into the one tree persisted hooks run it from: the only
  // source outside the plan's layers, and only for that address (§7.5).
  const shimTree = descriptor?.launch?.hooks?.persist?.shim_tree;
  if (shimTree && op.address?.path === shimTree) {
    if (fs.realpathSync.native(op.source) !== fs.realpathSync.native(SHIM_DIR)) throw new HsError('write_refused', `${op.source} is not hs's hook shim; ${shimTree} is copied from it only`, [op.id]);
    const link = treeLink(op.source);
    if (link !== null) throw new HsError('write_refused', `${op.source} holds a symlink (${link})`, [op.id]);
    return;
  }
  // A source is in one of the plan's layers, the install-local layer's directory (where
  // local.toml sits: the user's own layer, §5.1), or the records' replaced trees.
  const local = planBody.args?.local ? [path.dirname(planBody.args.local)] : [];
  const roots = [...(planBody.args?.layers ?? []), ...local, path.join(recordsDir(folder), 'replaced')];
  const real = fs.realpathSync.native(op.source);
  if (!roots.some((r) => inside(real, fs.existsSync(r) ? fs.realpathSync.native(r) : r))) {
    throw new HsError('write_refused', `${op.source} is in none of the plan's layers`, [op.id]);
  }
  const link = treeLink(op.source);
  if (link !== null) throw new HsError('write_refused', `${op.source} holds a symlink (${link})`, [op.id]);
}

function perform(folder, descriptor, planBody, op, ctx) {
  const h = handlers[op.handler];
  if (!WRITES.has(op.action)) return {}; // adopt, share, unshare, release, skip: the ledger only
  if (op.action === 'clear') {
    // Every clear of this file in the plan, in one write: a staged copy never holds a value due
    // for deletion. The later clears of the file then find their keys gone.
    const keys = planBody.operations.filter((o) => o.action === 'clear' && o.address.file === op.address.file).map((o) => o.address.key);
    h.clear(folder, descriptor, op.address.file, keys);
    return {};
  }
  checkSource(folder, planBody, op, descriptor);
  if (op.handler === 'tree') {
    const source = op.action === 'remove' ? null : op.source;
    return h.write(folder, descriptor, op.address, source, op.desired_sha256, ctx) ?? {};
  }
  h.write(folder, descriptor, op.address, Object.hasOwn(op, 'value') ? op.value : undefined);
  return {};
}

function updateLedger(folder, planBody, owner, replaced, at) {
  const ledger = readLedger(folder);
  for (const op of planBody.operations) {
    const addr = op.address_id;
    if (op.action === 'skip' || op.action === 'clear') continue;
    if (['remove', 'unshare', 'release', 'restore'].includes(op.action)) {
      const entry = ledger.addresses[addr];
      if (!entry) continue;
      delete entry.owners[owner];
      if (Object.keys(entry.owners).length === 0) delete ledger.addresses[addr];
      continue;
    }
    let previous = op.previous;
    // An adopted tree the apply replaced is kept in the records, and the ledger says where.
    if (op.adopted && op.handler === 'tree' && replaced[op.id]) previous = { ...previous, tree: replaced[op.id] };
    const entry = (ledger.addresses[addr] ??= { previous, owners: {} });
    entry.owners[owner] = { item: op.item, installed: op.desired_sha256, plan: planBody.digest, at };
  }
  writeLedger(folder, ledger);
}

function checkReceipt(planBody, receipt) {
  if (!receipt || receipt.format !== RECEIPT_FORMAT || receipt.plan_digest !== planBody.digest) {
    throw new HsError('receipt_required', `apply needs a ${RECEIPT_FORMAT} receipt for plan ${planBody.digest}`);
  }
  const allows = new Set(Array.isArray(receipt.allows) ? receipt.allows : []);
  const missing = planBody.operations.filter((op) => op.risk.length && !allows.has(op.id));
  if (missing.length) {
    throw new HsError('receipt_required', `the receipt does not allow ${missing.map((op) => `${op.id} (${op.item}: ${op.risk.join(', ')})`).join(', ')}`, missing.map((op) => op.id));
  }
}

function journalCtx(folder, applyId, op, opts, suffix = '') {
  return {
    applyId,
    opId: op.id + suffix,
    crashMidSwap: opts.crashMidSwap === op.id,
    onStage: (paths) => journal(folder, applyId, { event: 'op-stage', op: op.id, ...paths }),
  };
}

// Run a derived plan's operations, journaled, then update the ledger. The caller holds the
// lock. `opts.crashAfter` and `opts.crashMidSwap` (tests only) stop as a crash would.
function execute(driver, folder, planBody, owner, opts, receipt = null) {
  const descriptor = driver.descriptor;
  const busy = driver.liveCheck(folder, opts.home ?? os.homedir());
  // The harness running in the folder is transient: the same request may succeed once it exits.
  if (busy) throw new HsError('folder_busy', busy, [folder], { retryable: true });
  if (unfinished(folder).length) throw new HsError('recover_first', `an earlier apply did not finish (${unfinished(folder).join(', ')}); run recover`);
  for (const op of planBody.operations) {
    if (op.skip_check) continue;
    const cur = handlers[op.handler].current(folder, descriptor, op.address);
    if (cur.blocked || cur.digest !== op.precondition.sha256) {
      throw new HsError('precondition_failed', `${op.address_id} is not what the plan saw; plan again`, [op.id]);
    }
    checkSource(folder, planBody, op, descriptor);
    if (op.source && digestPath(op.source) !== op.source_sha256) throw new HsError('precondition_failed', `${op.source} changed since the plan was made; plan again`, [op.id]);
  }
  // Stored only once the plan is cleared to run: the records list what an apply ran under.
  storeRecord(folder, 'plans', planBody.digest, planBody);
  if (receipt) storeRecord(folder, 'receipts', planBody.digest, receipt);
  const applyId = newApplyId();
  journal(folder, applyId, { event: 'begin', plan: planBody.digest, owner, operations: planBody.operations.length });
  const replaced = {};
  let done = 0;
  for (const op of planBody.operations) {
    if (opts.crashAfter !== undefined && done >= opts.crashAfter) throw new Error(`crash injected after ${done} operation(s)`);
    // A JSON key's value before a write is journaled, so a reset never loses what it replaced.
    // A cleared key is state: only that it was there is journaled, never its value.
    const before = (op.handler === 'json-key' || op.handler === 'json-element') && WRITES.has(op.action) ? handlers[op.handler].current(folder, descriptor, op.address) : null;
    const kept = before && (op.action === 'clear' ? { present: before.present } : { present: before.present, value: before.value });
    journal(folder, applyId, { event: 'op-begin', op: op.id, ...(kept ? { before: kept } : {}) });
    const out = perform(folder, descriptor, planBody, op, journalCtx(folder, applyId, op, opts));
    if (out.replaced) replaced[op.id] = out.replaced;
    journal(folder, applyId, { event: 'op-done', op: op.id, ...(out.replaced ? { replaced: out.replaced } : {}) });
    done++;
  }
  if (opts.crashAfter !== undefined && done >= opts.crashAfter) throw new Error(`crash injected after ${done} operation(s), before the ledger`);
  updateLedger(folder, planBody, owner, replaced, new Date().toISOString());
  journal(folder, applyId, { event: 'complete' });
  return { apply_id: applyId, plan: planBody.digest, operations: planBody.operations.map((op) => ({ id: op.id, item: op.item, action: op.action })) };
}

function staleSummary(given, fresh) {
  const ops = (p) => (p.operations ?? []).map((o) => `${o.id} ${o.item} ${o.action} ${o.address_id} ${o.precondition?.sha256 ?? 'absent'}`);
  const a = new Set(ops(given));
  const b = ops(fresh);
  const changed = b.filter((x) => !a.has(x)).concat([...a].filter((x) => !b.includes(x)));
  const fields = ['harness_version', 'range', 'host', 'spec_digest', 'ledger_sha256'].filter((k) => given[k] !== fresh[k]);
  return [...fields.map((f) => `${f} differs`), ...changed.slice(0, 10)];
}

export function apply(driver, args, opts = {}) {
  const given = args.plan;
  if (!given || given.format !== PLAN_FORMAT) throw new HsError('bad_request', `args.plan must be a ${PLAN_FORMAT} plan`);
  if (planDigest(given) !== given.digest) throw new HsError('plan_tampered', 'the plan does not match its digest');
  if (given.harness !== driver.descriptor.harness) throw new HsError('bad_request', `the plan is for ${given.harness}`);
  const folder = harnessPath(args.harness_path);
  if (folder !== given.harness_path) throw new HsError('bad_request', `the plan is for ${given.harness_path}, not ${folder}`);
  const pargs = planArgs(given.args ?? {});
  // A plan with no operations changes nothing, so its apply writes nothing either: no lock, no
  // records, no .harness-skeleton/ in a folder that may be the user's own. It is still checked.
  if (given.operations.length === 0) {
    const fresh = derive(driver, folder, pargs, opts, args.bin);
    if (fresh.digest !== given.digest) throw new HsError('plan_stale', 'the plan is not what its arguments give for this folder now; plan again', staleSummary(given, fresh));
    checkReceipt(fresh, args.receipt);
    return { apply_id: null, plan: fresh.digest, operations: [], unchanged: true, warnings: fresh.warnings };
  }
  const lock = acquireLock(folder, { op: 'apply', host: hostId(opts.host).host });
  try {
    const fresh = derive(driver, folder, pargs, opts, args.bin);
    if (fresh.digest !== given.digest) {
      throw new HsError('plan_stale', 'the plan is not what its arguments give for this folder now; plan again', staleSummary(given, fresh));
    }
    checkReceipt(fresh, args.receipt);
    return { ...execute(driver, folder, fresh, pargs.owner, opts, args.receipt), warnings: fresh.warnings };
  } finally {
    lock.release();
  }
}

// Finish every apply that did not complete, from its journal and stored plan. Every write
// operation is classified first, the ones the journal says are done included: at its desired
// digest it is done; at its precondition it is pending; a tree swap a crash interrupted can be
// resumed. Anything else stops recovery before a single write (§7.4).
export function recover(driver, args, opts = {}) {
  const folder = harnessPath(args.harness_path);
  const descriptor = driver.descriptor;
  const lock = acquireLock(folder, { op: 'recover', takeStale: true, host: hostId(opts.host).host });
  try {
    const busy = driver.liveCheck(folder, opts.home ?? os.homedir());
    if (busy) throw new HsError('folder_busy', busy, [folder], { retryable: true });
    const results = [];
    for (const applyId of unfinished(folder)) {
      const events = readJournal(folder, applyId);
      const begin = events.find((e) => e.event === 'begin');
      const planBody = loadRecord(folder, 'plans', begin.plan);
      if (!planBody || planDigest(planBody) !== begin.plan) throw new HsError('recover_failed', `${applyId}: plan ${begin.plan} is missing from the records or does not match its digest`, [applyId]);
      const stage = {};
      const replaced = {};
      for (const e of events) {
        if (e.event === 'op-stage') stage[e.op] = e;
        if (e.event === 'op-done' && e.replaced) replaced[e.op] = e.replaced;
      }

      const verdicts = [];
      for (const op of planBody.operations) {
        if (!WRITES.has(op.action)) continue;
        const cur = handlers[op.handler].current(folder, descriptor, op.address);
        if (!cur.blocked && cur.digest === op.desired_sha256) verdicts.push({ op, state: 'done' });
        else if (!cur.blocked && cur.digest === op.precondition.sha256) verdicts.push({ op, state: 'pending' });
        else {
          const resume = op.handler === 'tree' && !cur.blocked ? handlers.tree.resume(folder, descriptor, op.address, stage[op.id], op) : null;
          if (resume) verdicts.push({ op, state: 'resume', resume });
          else verdicts.push({ op, state: 'conflict' });
        }
      }
      const conflicts = verdicts.filter((v) => v.state === 'conflict');
      if (conflicts.length) {
        throw new HsError('recover_failed', `${applyId}: ${conflicts.map((v) => v.op.address_id).join(', ')} is neither what the plan expected nor what it installs; nothing was written`, conflicts.map((v) => v.op.id));
      }

      const finished = [];
      for (const v of verdicts) {
        let state = v.state;
        if (state === 'resume') state = v.resume();
        if (state === 'pending') {
          journal(folder, applyId, { event: 'op-begin', op: v.op.id, by: 'recover' });
          const out = perform(folder, descriptor, planBody, v.op, journalCtx(folder, applyId, v.op, {}, '.recover'));
          if (out.replaced) replaced[v.op.id] = out.replaced;
          finished.push(v.op.id);
        } else if (v.state === 'resume') {
          finished.push(v.op.id);
        }
        journal(folder, applyId, { event: 'op-done', op: v.op.id, by: 'recover', ...(replaced[v.op.id] ? { replaced: replaced[v.op.id] } : {}) });
      }
      updateLedger(folder, planBody, begin.owner, replaced, new Date().toISOString());
      journal(folder, applyId, { event: 'complete', by: 'recover' });
      results.push({ apply_id: applyId, plan: planBody.digest, finished, ...(events.some((e) => e.event === 'torn') ? { torn_journal_line: true } : {}) });
    }
    // Nothing is pending now, so any staged copy a crash left is an orphan.
    const staged = sweepStaged(folder);
    return { recovered: results, ...(staged ? { staged_copies_removed: staged } : {}) };
  } finally {
    lock.release();
  }
}

// Remove one owner's items (all, or `items`), each only where the installed digest matches.
// The operations are derived here, under the lock, from the ledger; nothing is taken from the caller.
export function remove(driver, args, opts = {}) {
  if (typeof args.owner !== 'string' || !OWNER.test(args.owner)) {
    throw new HsError('bad_request', 'owner must be lowercase letters, digits and dashes, starting with a letter');
  }
  const folder = harnessPath(args.harness_path);
  const lock = acquireLock(folder, { op: 'remove', host: hostId(opts.host).host });
  try {
    const ledger = readLedger(folder);
    const only = Array.isArray(args.items) ? new Set(args.items) : null;
    const operations = [];
    for (const [addr, entry] of Object.entries(ledger.addresses)) {
      const mine = entry.owners[args.owner];
      if (!mine || (only && !only.has(mine.item))) continue;
      operations.push(removalOp(folder, driver.descriptor, addr, entry, args.owner));
    }
    const body = {
      format: PLAN_FORMAT, protocol: PROTOCOL, harness: driver.descriptor.harness, host: hostId(opts.host).host,
      harness_path: folder, args: { mode: 'remove', owner: args.owner, layers: [] },
      ledger_sha256: 'sha256:' + digestOf(ledger),
      operations: operations.map((op, i) => ({ id: `op-${i + 1}`, ...op })),
      unchanged: operations.length === 0,
    };
    const planBody = { ...body, digest: planDigest(body) };
    const result = execute(driver, folder, planBody, args.owner, opts);
    return { ...result, skipped: planBody.operations.filter((op) => op.action === 'skip').map((op) => ({ item: op.item, reason: op.reason })) };
  } finally {
    lock.release();
  }
}

// The managed half of observe: every ledger address with its owners and drift.
export function managedItems(folder, descriptor) {
  const ledger = readLedger(folder);
  return Object.entries(ledger.addresses).map(([addr, entry]) => {
    const { handler, address } = parseAddress(addr);
    let cur;
    try {
      cur = handlers[handler].current(folder, descriptor, address);
    } catch (e) {
      cur = { blocked: e.message };
    }
    const installed = [...new Set(Object.values(entry.owners).map((o) => o.installed))];
    const drift = cur.blocked ? 'unreadable' : cur.digest === null ? 'missing' : installed.includes(cur.digest) ? 'none' : 'changed';
    // Drift in words: what the folder holds now is not what any owner's plan installed under its
    // receipt; for a bound copy (hs-run/), the process it runs is no longer the one consented to.
    const words = drift === 'none' ? null : drift === 'unreadable' ? `${addr} cannot be read: ${cur.blocked}` : `${addr} ${drift === 'missing' ? 'is gone' : 'changed'}: it is not what the plan installed under its receipt${addr.startsWith('hs-run/') ? '; the persisted process no longer runs what was consented to' : ''}`;
    return { address: addr, owners: Object.fromEntries(Object.entries(entry.owners).map(([o, v]) => [o, v.item])), drift, ...(words ? { note: words } : {}) };
  });
}
