// Package launchers that fetch the code they run when they start (design note §5.4, `fetches-code`).
// These are package-manager facts, not a harness's: `npx` and `bunx` fetch from npm, `uvx` and
// `pipx run` from PyPI. Binding such an item's text binds package names, not code.
//
// Each launcher's options are parsed by its own semantics, so an option's value is never taken for
// a package. Sources: `npx --help` (npm 12.0.1) and `uvx --help` (uv 0.11.2), read locally on
// 2026-10-22; bunx and `pipx run` from their usage lines (best effort, not observed). An option a
// table does not know may take a value hs cannot see, so the parse is then `ambiguous`, and an
// ambiguous parse never counts as pinned.

import path from 'node:path';

// `packages`: options that name the package the command comes from, so the command then names
// none; `extras`: options that add packages beside the command's.
const NPM = {
  eco: 'npm',
  packages: new Set(['--package', '-p']),
  extras: new Set(),
  // A value follows these; `-c|--call` runs a command string, which names no package.
  values: new Set(['-c', '--call', '-w', '--workspace', '--allow-scripts']),
  flags: new Set(['-y', '--yes', '--no', '--workspaces', '--include-workspace-root', '--strict-allow-scripts', '--dangerously-allow-all-scripts', '-q', '--quiet']),
  call: new Set(['-c', '--call']),
};
const LAUNCHERS = Object.freeze({
  npx: NPM,
  bunx: { eco: 'npm', packages: new Set(['--package', '-p']), extras: new Set(), values: new Set(), flags: new Set(['--bun', '--silent', '--verbose']), call: new Set() },
  uvx: {
    eco: 'pypi',
    packages: new Set(['--from']),
    extras: new Set(['-w', '--with']),
    // Every uvx option that takes a value (uv 0.11.2), the package ones above apart.
    values: new Set(['--with-editable', '--with-requirements', '-c', '--constraints', '-b', '--build-constraints', '--overrides', '--env-file',
      '--python-platform', '--torch-backend', '--index', '--default-index', '-i', '--index-url', '--extra-index-url', '-f', '--find-links',
      '--index-strategy', '--keyring-provider', '-P', '--upgrade-package', '--resolution', '--prerelease', '--fork-strategy', '--exclude-newer',
      '--exclude-newer-package', '--no-sources-package', '--reinstall-package', '--link-mode', '-C', '--config-setting', '--config-settings-package',
      '--no-build-isolation-package', '--no-build-package', '--no-binary-package', '--cache-dir', '--refresh-package', '-p', '--python', '--color',
      '--allow-insecure-host', '--directory', '--project', '--config-file']),
    // Every uvx option that takes no value (uv 0.11.2). Any other is unknown, and makes the parse
    // ambiguous: a newer uv may add an option that takes one.
    flags: new Set(['--isolated', '--no-env-file', '--lfs', '-V', '--version', '--no-index', '-U', '--upgrade', '--no-sources', '--reinstall',
      '--compile-bytecode', '--no-build-isolation', '--no-build', '--no-binary', '-n', '--no-cache', '--refresh', '--managed-python',
      '--no-managed-python', '--no-python-downloads', '--system-certs', '--offline', '--no-progress', '--no-config', '-q', '--quiet', '-v', '--verbose']),
    call: new Set(),
  },
  pipx: { eco: 'pypi', packages: new Set(['--spec']), extras: new Set(), values: new Set(['--python', '--pip-args', '--index-url']), flags: new Set(['--no-cache', '--verbose', '--quiet']), call: new Set(), sub: 'run' },
});

// A spec is pinned when it names one exact version: `name@1.2.3`, `@scope/name@1.2.3` (npm),
// `name==1.2.3` or `name@1.2.3` (PyPI). A range, a tag or no version is unpinned. Pinned is not
// content-bound.
function pinned(spec, eco) {
  if (eco === 'npm') return /^(@[^/@\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
  return /^[A-Za-z0-9._-]+(?:\[[^\]]*\])?(?:==|@)\d+(?:\.\d+)*(?:[a-z]+\d*)?$/i.test(spec);
}

// The packages a process fetches, or null when its `exec` is no launcher or fetches nothing:
// `{packages: [{package, pinned}], ambiguous}`. Packages are every value of the launcher's package
// options; without one, the first argument that is not an option (the command, which names its
// package).
export function fetchedPackages(exec, args = []) {
  if (typeof exec !== 'string') return null;
  const L = LAUNCHERS[path.basename(exec)];
  if (!L) return null;
  let rest = [...args];
  if (L.sub) {
    if (rest[0] !== L.sub) return null;
    rest = rest.slice(1);
  }
  const specs = [];
  const extras = [];
  let ambiguous = false;
  let called = false;
  let positional = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      positional = rest[i + 1] ?? null;
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      positional = a;
      break;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const value = eq > 0 ? a.slice(eq + 1) : null;
    if (L.packages.has(name) || L.extras.has(name)) {
      const v = value ?? rest[++i];
      if (v !== undefined) (L.packages.has(name) ? specs : extras).push(v);
    } else if (L.values.has(name)) {
      if (L.call.has(name)) called = true;
      if (value === null) i++;
    } else if (!L.flags.has(name)) {
      // An option this table does not know: it may take a value hs cannot see, so nothing after
      // it is read as the command, and only explicit package options are reported.
      ambiguous = true;
      break;
    }
  }
  if (!specs.length && positional !== null && !called && !ambiguous) specs.push(positional);
  specs.push(...extras);
  // A launcher whose packages cannot be read still fetches code: an empty, ambiguous list.
  if (!specs.length && !ambiguous) return null;
  return { packages: specs.map((s) => ({ package: s, pinned: pinned(s, L.eco) })), ambiguous };
}
