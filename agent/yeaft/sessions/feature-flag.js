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
import { mutateAgentConfig } from '../config-store.js';

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
  const nextValue = Boolean(enabled);
  try {
    return mutateAgentConfig(yeaftDir, config => {
      let current = config;
      for (let index = 0; index < FLAG_PATH.length - 1; index += 1) {
        const segment = FLAG_PATH[index];
        if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
          current[segment] = {};
        }
        current = current[segment];
      }
      current[FLAG_PATH.at(-1)] = nextValue;
      return { enabled: nextValue };
    });
  } catch (error) {
    return { error: `Failed to read config.json or persist update: ${error?.message || error}` };
  }
}
