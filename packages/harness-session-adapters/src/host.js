// `host`, by the rule sessions-model/host/v0 (sessions-model §1). Every reader on one machine must give the same value, so this follows the contract to
// the byte and never invents its own variant. This is the one implementation: harness-skeleton
// and memhouse import it rather than keep their own.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionsError } from './errors.js';

export const HOST_SALT = 'sessions-model/host/v0:';
export const HOST_PLATFORMS = Object.freeze(['darwin', 'linux', 'win32']);

const LINUX_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const RANDOM_ID = /^[0-9a-f]{32}$/;

// The first 32 hex digits, lowercase, of sha256(salt + machine id), the input as UTF-8.
export function hostFromMachineId(machineId) {
  return createHash('sha256').update(HOST_SALT + machineId, 'utf8').digest('hex').slice(0, 32);
}

// A machine id has its OS's form: Linux exactly 32 lowercase hex digits; macOS and Windows a UUID.
// An empty value or systemd's first-boot placeholder `uninitialized` never does.
export function machineIdOk(id, platform = process.platform) {
  if (!id || id === 'uninitialized') return false;
  return platform === 'linux' ? LINUX_ID.test(id) : UUID.test(id);
}

// The OS machine id exactly as stored (only surrounding whitespace stripped), or null when none
// is readable in its OS's form.
// - Linux: /etc/machine-id only. /var/lib/dbus/machine-id is never read: a clone whose
//   /etc/machine-id was emptied can still hold its source's D-Bus copy (sessions-model §1).
// - macOS: IOPlatformUUID from ioreg, the quoted value without its quotes.
// - Windows: MachineGuid from the 64-bit registry view, so a 32-bit reader is not redirected.
export function readMachineId({ platform = process.platform, readFile = readText, ioreg = runIoreg, reg = runReg } = {}) {
  let id = null;
  if (platform === 'linux') {
    id = readFile('/etc/machine-id')?.trim();
  } else if (platform === 'darwin') {
    id = /"IOPlatformUUID"\s*=\s*"([^"]*)"/.exec(ioreg() ?? '')?.[1].trim();
  } else if (platform === 'win32') {
    id = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(reg() ?? '')?.[1].trim();
  }
  return machineIdOk(id, platform) ? id : null;
}

// Where the `r-` id lives: $XDG_STATE_HOME/sessions-model/host-id when XDG_STATE_HOME is absolute
// (the XDG spec ignores a relative one), else ~/.local/state/...; on Windows
// %LOCALAPPDATA%\sessions-model\host-id.
export function randomHostFile({ platform = process.platform, env = process.env, home } = {}) {
  if (platform === 'win32') {
    const p = path.win32;
    const base = env.LOCALAPPDATA && p.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : p.join(home ?? env.USERPROFILE ?? os.homedir(), 'AppData', 'Local');
    return p.join(base, 'sessions-model', 'host-id');
  }
  const p = path.posix;
  const base = env.XDG_STATE_HOME && p.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : p.join(home ?? env.HOME ?? os.homedir(), '.local', 'state');
  return p.join(base, 'sessions-model', 'host-id');
}

// Read the persisted id: null only when the file does not exist. Any other failure (a directory
// there, no permission) is `host_unreadable`, never a retry.
function readHostFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new SessionsError('host_unreadable', `${file} exists but cannot be read (${e.code})`, [file]);
  }
}

// The `r-` fallback. The first reader creates the file exclusively; a reader that loses the race
// reads the winner's. A stored value in the wrong form is refused and never overwritten: another
// reader may already key sessions by it.
export function readOrCreateRandomHost(file) {
  let existing = readHostFile(file);
  if (existing === null) {
    // Write to a temp file, then link() it into place: link fails with EEXIST atomically, so the
    // path never exists without its content, and a reader killed midway leaves only a temp file.
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // 32 hex digits and nothing else, as harness-skeleton and memhouse write it.
      fs.writeFileSync(tmp, randomBytes(16).toString('hex'), { flag: 'wx', mode: 0o600 });
      try {
        fs.linkSync(tmp, file);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    } catch (e) {
      throw new SessionsError('host_unreadable', `cannot create ${file} (${e.code})`, [file]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    existing = readHostFile(file);
    if (existing === null) throw new SessionsError('host_unreadable', `${file} vanished right after it was created`, [file]);
  }
  const id = existing.trim();
  if (!RANDOM_ID.test(id)) {
    throw new SessionsError('host_unreadable', `${file} does not hold 32 lowercase hex digits`, [file]);
  }
  return 'r-' + id;
}

// This machine's `host`: { host, source: 'machine-id' | 'random' }.
export function host(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (!HOST_PLATFORMS.includes(platform)) {
    throw new SessionsError('platform_unsupported', `host is defined on ${HOST_PLATFORMS.join(', ')} only, not ${platform}`, [platform]);
  }
  const machineId = readMachineId({ ...opts, platform });
  if (machineId !== null) return { host: hostFromMachineId(machineId), source: 'machine-id' };
  return { host: readOrCreateRandomHost(randomHostFile({ ...opts, platform })), source: 'random' };
}

// The display label beside `host`: the machine's short hostname. Never part of a key.
export function hostLabel(hostname = os.hostname()) {
  return (hostname || '').split('.')[0].replace(/[^A-Za-z0-9_-]/g, '') || 'host';
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function runIoreg() {
  try {
    return execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
  } catch {
    return null;
  }
}

function runReg() {
  try {
    // By absolute path, so a `reg` earlier on PATH is never run.
    const reg = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    return execFileSync(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
  } catch {
    return null;
  }
}
