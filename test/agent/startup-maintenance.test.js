import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveNpmInvocation,
  shouldRunPeriodicCheck,
  writePeriodicCheckMarker,
} from '../../agent/startup-maintenance.js';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'yeaft-startup-maintenance-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('startup maintenance helpers', () => {
  it('runs npm through node+npm-cli on Windows instead of a shell wrapper', () => {
    const invocation = resolveNpmInvocation({
      platform: 'win32',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      resolveWindowsNpmCliPathFn: () => 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    });

    expect(invocation).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      argsPrefix: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
    });
  });

  it('throttles repeated startup update checks with a marker file', () => {
    const markerPath = join(makeTempDir(), 'update-check.json');
    const now = 1_700_000_000_000;

    expect(shouldRunPeriodicCheck(markerPath, 1000, () => now)).toBe(true);
    writePeriodicCheckMarker(markerPath, () => now);

    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ checkedAt: now });
    expect(shouldRunPeriodicCheck(markerPath, 1000, () => now + 999)).toBe(false);
    expect(shouldRunPeriodicCheck(markerPath, 1000, () => now + 1000)).toBe(true);
  });
});
