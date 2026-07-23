import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeAtomic } from '../storage/atomic.js';
import { defaultWorkCenterSettings, normalizeWorkCenterSettings } from './workflow.js';

export const WORK_CENTER_SETTINGS_FILE = 'settings.json';
const SETTINGS_LOCK_TIMEOUT_MS = 5_000;

function settingsPath(yeaftDir) {
  return join(yeaftDir, 'work-center', WORK_CENTER_SETTINGS_FILE);
}

function withSettingsTransaction(yeaftDir, fn) {
  const dir = dirname(settingsPath(yeaftDir));
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'work-center.db'), { timeout: SETTINGS_LOCK_TIMEOUT_MS });
  let transactionOpen = false;
  try {
    db.exec(`PRAGMA busy_timeout = ${SETTINGS_LOCK_TIMEOUT_MS};`);
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const result = fn();
    db.exec('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    db.close();
  }
}

export function readWorkCenterSettings(yeaftDir) {
  const file = settingsPath(yeaftDir);
  if (!existsSync(file)) return defaultWorkCenterSettings();
  try {
    return normalizeWorkCenterSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`Failed to read Work Center settings: ${error.message}`);
  }
}

export function writeWorkCenterSettings(yeaftDir, value) {
  return withSettingsTransaction(yeaftDir, () => {
    const current = readWorkCenterSettings(yeaftDir);
    const expectedRevision = Number(value?.revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new Error('Work Center settings changed elsewhere; reload before saving');
    }
    const normalized = normalizeWorkCenterSettings({ ...value, revision: current.revision + 1 });
    const file = settingsPath(yeaftDir);
    writeAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  });
}
