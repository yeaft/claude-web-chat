import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { normalizePluginConfig } from './plugins.js';
import { writeAtomic } from './storage/atomic.js';

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_RETRY_MS = 10;

function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function ensureOwnerDirectory(path) {
  if (existsSync(path)) {
    const details = lstatSync(path);
    if (!details.isDirectory()) throw new Error('Yeaft data root is not a directory');
    if (process.platform !== 'win32') {
      const currentMode = details.mode & 0o777;
      const restrictedMode = currentMode & 0o700;
      if (currentMode !== restrictedMode) chmodSync(path, restrictedMode);
    }
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function readConfigForWrite(configPath) {
  if (!existsSync(configPath)) return {};
  const json = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!json || typeof json !== 'object' || Array.isArray(json)
    || Object.getPrototypeOf(json) !== Object.prototype) {
    throw new Error('config.json must contain an object');
  }
  if (Object.prototype.hasOwnProperty.call(json, 'plugins')) {
    normalizePluginConfig(json.plugins);
  }
  return json;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readConfigLockOwner(lockDir) {
  const lockStat = lstatSync(lockDir);
  if (!lockStat.isDirectory()) throw new Error('config.json lock path is not a directory');
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    return { owner, lockStat };
  } catch {
    return { owner: null, lockStat };
  }
}

function configLockCanBeTaken(lockDir) {
  const { owner, lockStat } = readConfigLockOwner(lockDir);
  if (owner?.host === hostname()) return !processIsAlive(Number(owner.pid));
  if (owner) return false;
  return Date.now() - lockStat.mtimeMs > LOCK_STALE_MS;
}

function lockIsOwned(lockDir, token) {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    return owner?.token === token;
  } catch {
    return false;
  }
}

function removeConfigLockIfOwned(lockDir, token) {
  if (!lockIsOwned(lockDir, token)) return false;
  const claimed = `${lockDir}.release-${token}`;
  try {
    renameSync(lockDir, claimed);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!lockIsOwned(claimed, token)) {
    try { renameSync(claimed, lockDir); } catch {}
    return false;
  }
  rmSync(claimed, { recursive: true, force: true });
  return true;
}

function lockOwnerIdentity(owner) {
  if (!owner) return null;
  if (typeof owner.token === 'string' && owner.token) return `token:${owner.token}`;
  return `legacy:${owner.host || ''}:${Number(owner.pid) || 0}:${Number(owner.startedAt) || 0}`;
}

function takeConfigLock(lockDir) {
  const observed = readConfigLockOwner(lockDir).owner;
  if (!configLockCanBeTaken(lockDir)) return false;
  const observedIdentity = lockOwnerIdentity(observed);
  const claimed = `${lockDir}.stale-${randomUUID()}`;
  try {
    renameSync(lockDir, claimed);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  const claimedOwner = readConfigLockOwner(claimed).owner;
  const ownerChanged = lockOwnerIdentity(claimedOwner) !== observedIdentity;
  const ownerRevived = claimedOwner?.host === hostname()
    && processIsAlive(Number(claimedOwner.pid));
  if (ownerChanged || ownerRevived) {
    try { renameSync(claimed, lockDir); } catch {}
    return false;
  }
  rmSync(claimed, { recursive: true, force: true });
  return true;
}

function acquireConfigLock(root, { waitMs = LOCK_WAIT_MS } = {}) {
  ensureOwnerDirectory(root);
  const lockDir = join(root, '.config.json.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = randomUUID();
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token,
        startedAt: Date.now(),
      }), { flag: 'wx', mode: 0o600 });
      return () => removeConfigLockIfOwned(lockDir, token);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (takeConfigLock(lockDir)) continue;
      } catch (inspectionError) {
        if (inspectionError?.code === 'ENOENT') continue;
        throw inspectionError;
      }
      if (Date.now() >= deadline) throw new Error('config.json is busy');
      sleepSync(Math.min(LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

/**
 * Mutate one Agent-owned config.json under a cross-process lock.
 * The callback runs after the file is re-read and validated inside the lock.
 */
export function mutateAgentConfig(root, mutate, options = {}) {
  if (!root) throw new Error('Yeaft data root required');
  if (typeof mutate !== 'function') throw new Error('config mutator required');
  const release = acquireConfigLock(root, options);
  const configPath = join(root, 'config.json');
  try {
    const exists = existsSync(configPath);
    const current = readConfigForWrite(configPath);
    const result = mutate(current, { exists, configPath });
    writeAtomic(configPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    return result;
  } finally {
    release();
  }
}

export function mutateAgentConfigPath(configPath, mutate, options = {}) {
  return mutateAgentConfig(dirname(configPath), mutate, options);
}

export function readAgentConfigForWrite(configPath) {
  return readConfigForWrite(configPath);
}
