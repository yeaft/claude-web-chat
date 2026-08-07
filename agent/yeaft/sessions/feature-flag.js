/**
 * feature-flag.js — Reads `config.yeaft.multiVp.enabled` from ~/.yeaft/config.json.
 *
 * Per architecture §11: multi-VP Sessions are opt-in for MVP. The flag
 * gates UI entry points and (later) migration. The reader returns a plain
 * boolean and never throws — missing/corrupt config falls back to `false`.
 *
 * The exported writer rejects an existing malformed config or invalid Plugin
 * schema rather than replacing it, so it cannot reopen a fail-closed Agent
 * capability policy through an unrelated feature-flag update.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { normalizePluginConfig } from '../plugins.js';
import { writeAtomic } from '../storage/index.js';

const CONFIG_FILE = 'config.json';
const FLAG_PATH = ['yeaft', 'multiVp', 'enabled'];

function readConfig(yeaftDir) {
  const path = join(yeaftDir, CONFIG_FILE);
  if (!existsSync(path)) return {};
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  } catch {
    return {};
  }
}

/**
 * Strict precondition for writes to the Agent-owned config document. Reads can
 * remain tolerant because the flag is optional, but no mutation may replace a
 * malformed root or a Plugin policy that the runtime must keep fail-closed.
 */
function readConfigForWrite(yeaftDir) {
  const path = join(yeaftDir, CONFIG_FILE);
  if (!existsSync(path)) return {};
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.getPrototypeOf(config) !== Object.prototype) {
    throw new Error('config.json must contain an object');
  }
  if (Object.prototype.hasOwnProperty.call(config, 'plugins')) {
    normalizePluginConfig(config.plugins);
  }
  return config;
}

export function isMultiVpEnabled(yeaftDir) {
  const cfg = readConfig(yeaftDir);
  let cur = cfg;
  for (const seg of FLAG_PATH) {
    if (!cur || typeof cur !== 'object') return false;
    cur = cur[seg];
  }
  return Boolean(cur);
}

export function setMultiVpEnabled(yeaftDir, enabled) {
  let cfg;
  try {
    cfg = readConfigForWrite(yeaftDir);
  } catch (err) {
    return { error: `Failed to read config.json: ${err?.message || err}` };
  }
  let cur = cfg;
  for (let i = 0; i < FLAG_PATH.length - 1; i++) {
    const seg = FLAG_PATH[i];
    if (!cur[seg] || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  const nextValue = Boolean(enabled);
  cur[FLAG_PATH[FLAG_PATH.length - 1]] = nextValue;
  try {
    writeAtomic(join(yeaftDir, CONFIG_FILE), JSON.stringify(cfg, null, 2));
  } catch (err) {
    return { error: `Failed to write config.json: ${err?.message || err}` };
  }
  return { enabled: nextValue };
}
