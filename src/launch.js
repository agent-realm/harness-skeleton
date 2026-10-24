// launch-spec (design note v0.2 §4, §7.1): what a tool runs to start the harness on a bound data
// folder with a spec's launch-time items. It writes nothing into the folder: generated overlay
// files go into a fresh temp directory of their own, which the caller removes after the launch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HsError } from './protocol.js';
import { harnessPath } from './harness-path.js';
import { digestPath, resolve } from './spec/layers.js';
import { validate } from './spec/validate.js';
import { digestOf, sha256 } from './records.js';
import { hostId } from './host.js';

export const LAUNCH_FORMAT = 'hs-launch/0.2';
export const RECEIPT_FORMAT = 'hs-receipt/0.2';

// The launch digest (§7.5): what the launch would run, without temp paths, so two calls for the
// same launch give the same digest. A generated file is its role and sha256; a generated tree its
// role, its manifest's sha256 and each entry's path and sha256 (the copy is checked against it).
function launchDigest(body) {
  return 'sha256:' + digestOf(body);
}

// A receipt is the caller's record of consent, not an authorization hs can verify (§7.4): hs checks
// that it names this launch's digest and allows every risky item, and nothing more.
function checkReceipt(digest, risks, receipt) {
  const ok = receipt && receipt.format === RECEIPT_FORMAT && receipt.launch_digest === digest
    && Array.isArray(receipt.allows) && risks.every((r) => receipt.allows.includes(r.item));
  if (!ok) {
    throw new HsError('receipt_required', `this launch carries ${risks.length} item(s) that run code or send data; launch-spec needs a ${RECEIPT_FORMAT} receipt for launch ${digest} that allows ${risks.map((r) => r.item).join(', ')}`, [{ launch_digest: digest, risks }]);
  }
}

export function launchSpec(driver, args, opts = {}) {
  const descriptor = driver.descriptor;
  if (!descriptor.launch) throw new HsError('not_implemented', `launch-spec is not in this build for ${descriptor.name}`);
  if (!Array.isArray(args.layers) || args.layers.some((l) => typeof l !== 'string' || !path.isAbsolute(l))) {
    throw new HsError('bad_request', 'args.layers must be a list of absolute layer directories, lowest first');
  }
  if (args.local !== undefined && (typeof args.local !== 'string' || !path.isAbsolute(args.local))) {
    throw new HsError('bad_request', 'args.local must be the absolute path of local.toml');
  }
  const folder = harnessPath(args.harness_path);
  const resolved = resolve(args.layers, args.local ?? null);
  const checked = validate(resolved, descriptor);
  const errors = checked.problems.filter((p) => p.severity === 'error');
  if (errors.length) throw new HsError('spec_invalid', `the spec has ${errors.length} error(s); run validate`, errors);

  const headless = args.headless === true;
  const parts = driver.launchParts(resolved, {
    headless, descriptor, folder, given: args.harness_path, home: opts.home,
    platform: opts.host?.platform ?? process.platform, keychain: opts.keychain,
  });
  if (parts.not_implemented.length) {
    throw new HsError('not_implemented', `this build does not carry ${parts.not_implemented.join(', ')} at launch`, parts.not_implemented);
  }

  // The digest and the receipt come before any write: a refused launch makes no temp dir. The
  // temp root is checked first, since even the version probe a risky launch needs makes a scratch
  // dir under it: it must lie outside the data folder, or TMPDIR pointing into it would make
  // launch-spec write there (§7.5). Before the check nothing is written in the folder; outside it,
  // only the probe's scratch (under this root, removed after) and the package's `r-` host id file
  // (sessions-model host/v0, made only where the machine id cannot be read).
  const trees = parts.trees ?? [];
  const risks = parts.risks ?? [];
  let root = null;
  if (risks.length || parts.files.length || trees.length) {
    try {
      root = fs.realpathSync.native(opts.tmpdir ?? os.tmpdir());
    } catch (e) {
      throw new HsError('bad_request', `the temp root ${opts.tmpdir ?? os.tmpdir()} cannot be resolved (${e.code})`);
    }
    if (root === folder || root.startsWith(folder + path.sep)) {
      throw new HsError('write_refused', `the temp root ${root} is inside the data folder; point TMPDIR elsewhere`, [root]);
    }
  }
  const roleArgv = parts.argv(Object.fromEntries([...parts.files, ...trees].map((f) => [f.role, `<${f.role}>`])));
  // A launch that needs a receipt binds the version of the binary it runs: it probes that binary
  // (args.bin, else the harness's name on PATH) and names it by its path in argv. A binary that
  // cannot be found has no version to bind, and the launch is refused.
  const detected = risks.length ? driver.detect({ bin: args.bin, root }) : null;
  if (detected && !detected.present) {
    throw new HsError('version_unsupported', `the ${descriptor.binary} binary was not found; a launch that needs a receipt binds the version of the binary it runs`, []);
  }
  const binary = detected ? detected.binary : descriptor.binary;
  const env_set = { [descriptor.binding.env_set]: folder, ...parts.env };
  const env_unset = [...descriptor.binding.env_unset, ...(parts.unset ?? [])];
  const env_from_refs = parts.env_from_refs ?? {};
  const generated = [
    ...parts.files.map((f) => ({ role: f.role, sha256: sha256(Buffer.from(f.content)) })),
    ...trees.map((t) => ({ role: t.role, manifest: sha256(Buffer.from(t.manifest.content)), entries: t.entries.map((e) => ({ path: e.rel, sha256: e.sha256 })) })),
  ];
  const digest = launchDigest({
    format: LAUNCH_FORMAT,
    harness: descriptor.harness,
    // Only a risky launch asks the binary its version; a plain one needs no receipt to bind.
    harness_version: detected?.version ?? null,
    host: hostId(opts.host).host,
    harness_path: folder,
    spec_digest: resolved.digest,
    argv: [binary, ...roleArgv],
    env_set, env_unset, env_from_refs,
    generated,
    risks,
  });
  if (risks.length) checkReceipt(digest, risks, args.receipt);

  // Generated files: a fresh directory, mode 700, files 600. Never in the data folder.
  let tempDir = null;
  const files = [];
  if (parts.files.length || trees.length) {
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'hs-launch-')));
    for (const f of parts.files) {
      const p = path.join(tempDir, f.name);
      fs.writeFileSync(p, f.content, { mode: 0o600, flag: 'wx' });
      files.push({ path: p, role: f.role, sha256: sha256(Buffer.from(f.content)) });
    }
    // A tree: its manifest, and each entry copied from its layer, then checked against the
    // digest the receipt bound. A copy that differs is a source that changed since resolve.
    for (const t of trees) {
      const root = path.join(tempDir, t.name);
      fs.mkdirSync(path.join(root, path.dirname(t.manifest.rel)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(root, t.manifest.rel), t.manifest.content, { mode: 0o600, flag: 'wx' });
      for (const e of t.entries) {
        const dst = path.join(root, e.rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.cpSync(e.source, dst, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        if (digestPath(dst) !== e.sha256) {
          fs.rmSync(tempDir, { recursive: true, force: true });
          throw new HsError('precondition_failed', `${e.source} changed while the launch was built; ask again`, [e.rel]);
        }
      }
      files.push({ path: root, role: t.role, sha256: digestPath(root) });
    }
  }
  const argv = [binary, ...parts.argv(Object.fromEntries(files.map((f) => [f.role, f.path])))];
  return {
    harness: descriptor.harness,
    harness_path: folder,
    argv,
    env_set,
    // Credentials as references, by variable: the caller resolves each one into its variable at
    // launch (for example with a wrapper that resolves the reference into VAR, then execs argv);
    // hs never resolves a value.
    env_from_refs,
    env_unset,
    files,
    // What a receipt binds (§7.5), and the items it had to allow.
    launch_digest: digest,
    risks,
    ...(risks.length ? { receipt: { by: args.receipt.by ?? null, at: args.receipt.at ?? null } } : {}),
    temp_dir: tempDir,
    cwd_requirements: descriptor.launch.cwd,
    ...(headless ? { headless: { result: descriptor.launch.headless.result, source: descriptor.launch.headless.source } } : {}),
    launch_items: parts.items,
    skipped: parts.skipped,
    // What hs could not check and the caller must know, such as a login store hs never queries.
    unverified: parts.unverified ?? [],
    notes: [
      'argv is a prefix: the caller appends its own arguments (a prompt, for a headless run)',
      ...(parts.notes ?? []),
      ...(tempDir ? [`remove ${tempDir} after the launch ends`] : []),
    ],
  };
}
