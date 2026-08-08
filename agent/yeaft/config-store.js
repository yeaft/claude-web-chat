import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
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

function configLockIsStale(lockDir) {
  const lockStat = lstatSync(lockDir);
  if (!lockStat.isDirectory()) throw new Error('config.json lock path is not a directory');
  if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) return true;
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    return owner?.host === hostname() && !processIsAlive(Number(owner.pid));
  } catch {
    return false;
  }
}

function acquireConfigLock(root, { waitMs = LOCK_WAIT_MS } = {}) {
  ensureOwnerDirectory(root);
  const lockDir = join(root, '.config.json.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt: Date.now(),
      }), { flag: 'wx', mode: 0o600 });
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (configLockIsStale(lockDir)) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionError) {
        if (inspectionError?.code !== 'ENOENT') throw inspectionError;
        continue;
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
    const current = readConfigForWrite(configPath);
    const result = mutate(current);
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
