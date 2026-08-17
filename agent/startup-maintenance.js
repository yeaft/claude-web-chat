import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolveWindowsNpmCliPath } from './upgrade-command.js';

const execFileAsync = promisify(execFile);

export const YEAFT_SKILLS_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function execHiddenFileAsync(command, args = [], options = {}) {
  return execFileAsync(command, args, {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

export function resolveNpmInvocation({
  platform = process.platform,
  nodePath = process.execPath,
  resolveWindowsNpmCliPathFn = resolveWindowsNpmCliPath,
} = {}) {
  if (platform === 'win32') {
    const npmCliPath = resolveWindowsNpmCliPathFn(nodePath);
    if (!npmCliPath) {
      throw new Error('npm JavaScript CLI entry point could not be resolved');
    }
    return { command: nodePath, argsPrefix: [npmCliPath] };
  }
  return { command: 'npm', argsPrefix: [] };
}

export function shouldRunPeriodicCheck(
  markerPath,
  intervalMs = YEAFT_SKILLS_UPDATE_CHECK_INTERVAL_MS,
  now = Date.now,
) {
  try {
    const checkedAt = JSON.parse(readFileSync(markerPath, 'utf8'))?.checkedAt;
    return !Number.isFinite(checkedAt) || now() - checkedAt >= intervalMs;
  } catch {
    return true;
  }
}

export function writePeriodicCheckMarker(markerPath, now = Date.now) {
  const checkedAt = now();
  writeFileSync(markerPath, JSON.stringify({
    checkedAt,
    checkedAtIso: new Date(checkedAt).toISOString(),
  }, null, 2));
}
