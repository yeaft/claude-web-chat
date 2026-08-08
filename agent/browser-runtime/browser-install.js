import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';

import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Chrome 151 is the first pinned Chrome for Testing build in this project that
// exposes the Extensions CDP domain required for safe action activation.
export const BROWSER_RUNTIME_CHROME_BUILD = '151.0.7922.71';
const MANIFEST_FILE = '.yeaft-browser-manifest.json';
const INSTALL_LOCK_WAIT_MS = 120_000;
const INSTALL_LOCK_STALE_MS = 30 * 60_000;
const INSTALL_RETRY_MS = 100;

export const BROWSER_RUNTIME_CHROME_ARCHIVES = Object.freeze({
  linux: Object.freeze({
    fileName: 'chrome-linux64.zip',
    sha256: '6bd04aab53fba1544ce6027d9daddb24137295033124a61ecdf9840d785792e9',
  }),
  mac: Object.freeze({
    fileName: 'chrome-mac-x64.zip',
    sha256: 'bedcd79ae533fed218c26232b74e73cffec2a7277fce42cafcf5ec7280e4f81c',
  }),
  mac_arm: Object.freeze({
    fileName: 'chrome-mac-arm64.zip',
    sha256: '1c516b5d6c00a074034d5ce03dc1cc9bd2cde2a09293d9613244e0bc153cb80f',
  }),
  win32: Object.freeze({
    fileName: 'chrome-win32.zip',
    sha256: '338f15dcf19d457f93f692c279843477a92324f0f91f78bf5380d3fe00a9796f',
  }),
  win64: Object.freeze({
    fileName: 'chrome-win64.zip',
    sha256: '7ea2e94833ef710026c8cb08d0d2dafcb13f5d304d9c475ac07a3fa8c11d846c',
  }),
});

export function defaultBrowserCacheDir(yeaftDir) {
  if (!yeaftDir) throw new Error('yeaftDir required');
  return join(yeaftDir, 'managed-browser');
}

export async function isExecutable(path) {
  if (!path) return false;
  try {
    const details = await stat(path);
    if (!details.isFile()) return false;
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(path) {
  const handle = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
}

function archiveForPlatform(platform, archives = BROWSER_RUNTIME_CHROME_ARCHIVES) {
  const archive = archives[platform];
  if (!archive) throw new Error(`Managed Chrome is unsupported on platform ${platform}`);
  const folder = {
    linux: 'linux64',
    mac: 'mac-x64',
    mac_arm: 'mac-arm64',
    win32: 'win32',
    win64: 'win64',
  }[platform];
  return {
    ...archive,
    platform,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${BROWSER_RUNTIME_CHROME_BUILD}/${folder}/${archive.fileName}`,
  };
}

async function readManifest(cacheDir) {
  try {
    const parsed = JSON.parse(await readFile(join(cacheDir, MANIFEST_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeManifest(cacheDir, manifest) {
  const target = join(cacheDir, MANIFEST_FILE);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function inspectManagedBrowser(cacheDir, dependencies = {}) {
  const browsers = dependencies.browsers || await import('@puppeteer/browsers');
  const platform = dependencies.platform || browsers.detectBrowserPlatform();
  if (!platform) return { valid: false, reason: 'platform_unsupported' };
  const archive = archiveForPlatform(platform, dependencies.archives);
  let executablePath = dependencies.executablePath || null;
  if (!executablePath) {
    const installed = await browsers.getInstalledBrowsers({ cacheDir });
    const browser = installed.find(candidate => (
      candidate.browser === browsers.Browser.CHROME
        && candidate.buildId === BROWSER_RUNTIME_CHROME_BUILD
        && candidate.platform === platform
    ));
    executablePath = browser?.executablePath || null;
  }
  if (!await isExecutable(executablePath)) {
    return { valid: false, reason: 'executable_missing', executablePath, platform, archive };
  }
  const manifest = await readManifest(cacheDir);
  if (!manifest
    || manifest.buildId !== BROWSER_RUNTIME_CHROME_BUILD
    || manifest.platform !== platform
    || manifest.archiveSha256 !== archive.sha256
    || manifest.executablePath !== executablePath
    || typeof manifest.executableSha256 !== 'string') {
    return { valid: false, reason: 'manifest_missing', executablePath, platform, archive };
  }
  const executableSha256 = await hashFile(executablePath);
  if (executableSha256 !== manifest.executableSha256) {
    return { valid: false, reason: 'executable_digest_mismatch', executablePath, platform, archive };
  }
  return { valid: true, executablePath, platform, archive, executableSha256 };
}

/** Resolve only a verified exact managed Chrome for Testing build. */
export async function findManagedBrowser(cacheDir, dependencies = {}) {
  const inspected = await inspectManagedBrowser(cacheDir, dependencies);
  return inspected.valid ? inspected.executablePath : null;
}

/** Explicit executables are version-fenced by the probe after launch. */
export async function resolveBrowserExecutable({ executablePath, cacheDir }) {
  if (executablePath) return await isExecutable(executablePath) ? executablePath : null;
  return findManagedBrowser(cacheDir);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function lockOwnerIsStale(lockDir, staleMs) {
  const details = await stat(lockDir);
  if (!details.isDirectory()) throw new Error('Managed Chrome install lock is not a directory');
  if (Date.now() - details.mtimeMs > staleMs) return true;
  try {
    const owner = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8'));
    return owner?.host === hostname() && !processIsAlive(Number(owner.pid));
  } catch {
    return false;
  }
}

async function acquireInstallLock(cacheDir, {
  waitMs = INSTALL_LOCK_WAIT_MS,
  staleMs = INSTALL_LOCK_STALE_MS,
  ready = null,
} = {}) {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const lockDir = join(cacheDir, `.chrome-${BROWSER_RUNTIME_CHROME_BUILD}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (typeof ready === 'function' && await ready()) return null;
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt: Date.now(),
      }), { flag: 'wx', mode: 0o600 });
      return () => rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (await lockOwnerIsStale(lockDir, staleMs)) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionError) {
        if (inspectionError?.code !== 'ENOENT') throw inspectionError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Managed Chrome install is busy');
      await delay(Math.min(INSTALL_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

async function downloadVerifiedArchive(asset, destination, { fetchFn, onProgress, signal }) {
  const requestOptions = {
    redirect: 'follow',
    signal,
    headers: { 'User-Agent': 'yeaft-agent-browser-runtime' },
  };
  let response = await fetchFn(asset.url, requestOptions);
  if (!response.ok) throw new Error(`Managed Chrome download returned HTTP ${response.status}`);
  if (response.body && typeof response.body[Symbol.asyncIterator] !== 'function') {
    if (!response.url || response.url === asset.url) {
      throw new Error('Managed Chrome downloader returned an unreadable response body');
    }
    const resolved = await fetchFn(response.url, requestOptions);
    if (!resolved.ok) throw new Error(`Managed Chrome download returned HTTP ${resolved.status}`);
    response = resolved;
  }
  const handle = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let downloaded = 0;
  const total = Number(response.headers?.get?.('content-length')) || 0;
  try {
    for await (const raw of response.body || []) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      downloaded += chunk.length;
      hash.update(chunk);
      await handle.write(chunk);
      onProgress?.(downloaded, total);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const actual = hash.digest('hex');
  if (actual !== asset.sha256) throw new Error(`Managed Chrome archive checksum mismatch for ${asset.fileName}`);
  return actual;
}

async function executableVersion(executablePath, dependencies = {}) {
  if (typeof dependencies.versionCheck === 'function') return dependencies.versionCheck(executablePath);
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Managed Chrome version check failed (${code}): ${stderr.slice(0, 200)}`));
    });
  });
}

function installedDirectory(cacheDir, platform) {
  return join(cacheDir, 'chrome', `${platform}-${BROWSER_RUNTIME_CHROME_BUILD}`);
}

export async function installManagedBrowser({
  cacheDir,
  onProgress,
  fetchFn = globalThis.fetch,
  signal = null,
  dependencies = {},
} = {}) {
  if (!cacheDir) throw new Error('cacheDir required');
  if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable');
  const release = await acquireInstallLock(cacheDir, {
    ...dependencies,
    ready: async () => (await inspectManagedBrowser(cacheDir, dependencies)).valid,
  });
  let stagingRoot = null;
  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith(`.chrome-${BROWSER_RUNTIME_CHROME_BUILD}-staging-`))
      .map(entry => rm(join(cacheDir, entry.name), { recursive: true, force: true })));
    const existing = await inspectManagedBrowser(cacheDir, dependencies);
    if (existing.valid) {
      return {
        buildId: BROWSER_RUNTIME_CHROME_BUILD,
        executablePath: existing.executablePath,
        executableSha256: existing.executableSha256,
        cacheDir,
        status: 'available',
      };
    }

    const browsers = dependencies.browsers || await import('@puppeteer/browsers');
    const platform = dependencies.platform || browsers.detectBrowserPlatform();
    if (!platform) throw new Error('Cannot detect a supported Browser Runtime platform');
    const asset = archiveForPlatform(platform, dependencies.archives);
    const finalDir = installedDirectory(cacheDir, platform);

    stagingRoot = await mkdtemp(join(cacheDir, `.chrome-${BROWSER_RUNTIME_CHROME_BUILD}-staging-`));
    if (process.platform !== 'win32') await chmod(stagingRoot, 0o700);
    const archivePath = join(stagingRoot, asset.fileName);
    await downloadVerifiedArchive(asset, archivePath, { fetchFn, onProgress, signal });

    const stagingCache = join(stagingRoot, 'cache');
    await mkdir(join(stagingCache, 'chrome'), { recursive: true });
    await rename(
      archivePath,
      join(stagingCache, 'chrome', `${BROWSER_RUNTIME_CHROME_BUILD}-${basename(asset.fileName)}`),
    );
    const installBrowser = dependencies.install || browsers.install;
    const installed = await installBrowser({
      browser: browsers.Browser.CHROME,
      buildId: BROWSER_RUNTIME_CHROME_BUILD,
      platform,
      cacheDir: stagingCache,
      installDeps: false,
    });
    if (!await isExecutable(installed.executablePath)) throw new Error('Managed Chrome executable missing after extraction');
    const version = await executableVersion(installed.executablePath, dependencies);
    if (!version.includes(BROWSER_RUNTIME_CHROME_BUILD)) {
      throw new Error(`Managed Chrome build mismatch: expected ${BROWSER_RUNTIME_CHROME_BUILD}, got ${version}`);
    }
    const executableSha256 = await hashFile(installed.executablePath);
    await mkdir(dirname(finalDir), { recursive: true });
    await rm(finalDir, { recursive: true, force: true });
    await rename(installedDirectory(stagingCache, platform), finalDir);
    const executablePath = installed.executablePath.replace(
      installedDirectory(stagingCache, platform),
      finalDir,
    );
    await writeManifest(cacheDir, {
      version: 1,
      buildId: BROWSER_RUNTIME_CHROME_BUILD,
      platform,
      archiveFileName: asset.fileName,
      archiveSha256: asset.sha256,
      executablePath,
      executableSha256,
    });
    return {
      buildId: BROWSER_RUNTIME_CHROME_BUILD,
      executablePath,
      executableSha256,
      cacheDir,
      status: 'installed',
    };
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    await release?.();
  }
}
