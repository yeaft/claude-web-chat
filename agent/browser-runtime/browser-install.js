import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

// Chrome 151 is the first pinned Chrome for Testing build in this project that
// exposes the Extensions CDP domain required for safe action activation.
export const BROWSER_RUNTIME_CHROME_BUILD = '151.0.7922.71';

export function defaultBrowserCacheDir(yeaftDir) {
  if (!yeaftDir) throw new Error('yeaftDir required');
  return join(yeaftDir, 'managed-browser');
}

export async function isExecutable(path) {
  if (!path) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve only the exact managed Chrome for Testing build pinned by Puppeteer. */
export async function findManagedBrowser(cacheDir) {
  const { Browser, getInstalledBrowsers } = await import('@puppeteer/browsers');
  const installed = await getInstalledBrowsers({ cacheDir });
  const browser = installed.find(candidate => (
    candidate.browser === Browser.CHROME
      && candidate.buildId === BROWSER_RUNTIME_CHROME_BUILD
  ));
  return browser?.executablePath || null;
}

/**
 * Resolve an explicitly configured executable or the exact managed build. No
 * PATH fallback is allowed: branded Chrome may reject extension installation,
 * and protocol skew can make extension commands silently unavailable.
 */
export async function resolveBrowserExecutable({ executablePath, cacheDir }) {
  if (executablePath) return await isExecutable(executablePath) ? executablePath : null;
  const managed = await findManagedBrowser(cacheDir);
  return await isExecutable(managed) ? managed : null;
}

export async function installManagedBrowser({ cacheDir, onProgress } = {}) {
  if (!cacheDir) throw new Error('cacheDir required');
  const { Browser, install } = await import('@puppeteer/browsers');
  const installed = await install({
    browser: Browser.CHROME,
    buildId: BROWSER_RUNTIME_CHROME_BUILD,
    cacheDir,
    installDeps: false,
    downloadProgressCallback: onProgress,
  });
  return {
    buildId: installed.buildId,
    executablePath: installed.executablePath,
    cacheDir,
  };
}
