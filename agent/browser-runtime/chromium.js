import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BROWSER_RUNTIME_CHROME_BUILD,
  readBrowserExecutableVersion,
  resolveBrowserExecutable,
} from './browser-install.js';
import { BROWSER_EXTENSION_DIR } from './extension.js';
import { BrowserRuntimeError } from './errors.js';

const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const BROWSER_FORCE_EXIT_TIMEOUT_MS = 1_000;

function browserProcess(browser) {
  try { return browser?.process?.() || null; } catch { return null; }
}

function forceKillBrowser(browser) {
  const child = browserProcess(browser);
  if (!child || child.exitCode !== null) return child;
  try {
    if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
  return child;
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || typeof child.once !== 'function') return;
  let timer;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

async function cleanupBrowser(browser, profileDir) {
  if (browser) {
    let closePromise;
    try { closePromise = browser.close(); } catch { closePromise = Promise.reject(new Error('Browser close failed')); }
    if (!await settleWithin(closePromise, BROWSER_CLOSE_TIMEOUT_MS)) {
      const child = forceKillBrowser(browser);
      await waitForExit(child, BROWSER_FORCE_EXIT_TIMEOUT_MS);
    }
  }
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

function actualChromeBuild(version) {
  return String(version || '').match(/(?:Chrome(?:\s+for\s+Testing)?|Chromium)(?:\/|\s+)(\d+(?:\.\d+){0,3})/i)?.[1] || null;
}

function boundedViewport(value, config) {
  const width = Math.min(config.maxWidth, Math.max(320, Math.floor(Number(value?.width) || 1280)));
  const height = Math.min(config.maxHeight, Math.max(240, Math.floor(Number(value?.height) || 720)));
  const deviceScaleFactor = Math.min(2, Math.max(1, Number(value?.deviceScaleFactor) || 1));
  return Object.freeze({ width, height, deviceScaleFactor });
}

async function prepareExtensionRuntime(browser, installed, page, launchConfig, timeoutMs) {
  // Loading the bundled popup in bootstrap mode starts the MV3 worker without
  // consuming the extension-action gesture required by tabCapture.
  const bootstrap = await browser.newPage();
  try {
    await bootstrap.goto(`chrome-extension://${installed.id}/popup.html?bootstrap=1`, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    const target = await browser.waitForTarget(candidate => (
      candidate.type() === 'service_worker'
        && candidate.url().startsWith(`chrome-extension://${installed.id}/`)
    ), { timeout: timeoutMs });
    const worker = await target.worker();
    if (!worker) throw new BrowserRuntimeError('browser_extension_worker_missing');
    await worker.evaluate(async value => {
      await chrome.storage.session.set({ browserRuntimeLaunch: value });
    }, launchConfig);
  } finally {
    await bootstrap.close().catch(() => {});
  }
  await page.bringToFront();
  await page.triggerExtensionAction(installed);
}

/** Launch one isolated Chromium process and page owned by one Browser Session. */
export async function launchBrowserSession({
  browserSessionId,
  bridgeUrl,
  config,
  initialUrl = 'about:blank',
  viewport,
  locale = 'en-US',
  launch = null,
  signal = null,
} = {}) {
  if (!browserSessionId || !bridgeUrl) throw new BrowserRuntimeError('browser_session_invalid');
  const cacheDir = config.cacheDir;
  const profilesDir = `${cacheDir}-profiles`;
  await mkdir(profilesDir, { recursive: true, mode: 0o700 });
  const profileDir = await mkdtemp(join(profilesDir, 'session-'));
  let browser = null;
  try {
    signal?.throwIfAborted();
    const executablePath = await resolveBrowserExecutable({
      executablePath: config.executablePath,
      cacheDir,
    });
    if (!executablePath) throw new BrowserRuntimeError('browser_executable_missing');
    signal?.throwIfAborted();
    const version = await readBrowserExecutableVersion(executablePath, { signal });
    if (actualChromeBuild(version) !== BROWSER_RUNTIME_CHROME_BUILD) {
      throw new BrowserRuntimeError('browser_version_mismatch');
    }
    const launchBrowser = launch || (await import('puppeteer-core')).default.launch;
    const resolvedViewport = boundedViewport(viewport, config);
    browser = await launchBrowser({
      executablePath,
      headless: config.headless,
      userDataDir: profileDir,
      acceptInsecureCerts: false,
      timeout: config.startupProbeTimeoutMs,
      protocolTimeout: config.maxActionRuntimeMs,
      defaultViewport: resolvedViewport,
      signal,
      args: [
        `--disable-extensions-except=${BROWSER_EXTENSION_DIR}`,
        `--load-extension=${BROWSER_EXTENSION_DIR}`,
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-features=MediaRouter,Translate',
        '--disable-sync',
        '--no-first-run',
        `--lang=${String(locale || 'en-US').slice(0, 32)}`,
      ],
    });
    signal?.throwIfAborted();
    const installed = [...(await browser.extensions()).values()]
      .find(candidate => candidate.name === 'Yeaft Browser Runtime');
    if (!installed?.id) throw new BrowserRuntimeError('browser_extension_missing');

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.setViewport(resolvedViewport);
    signal?.throwIfAborted();
    await page.goto(String(initialUrl || 'about:blank').slice(0, 4096), {
      waitUntil: 'domcontentloaded',
      timeout: config.maxActionRuntimeMs,
    });

    signal?.throwIfAborted();
    await prepareExtensionRuntime(browser, installed, page, {
      browserSessionId,
      bridgeUrl,
      targetTabId: page.target()?._targetId || null,
    }, config.maxActionRuntimeMs);

    return {
      browser,
      page,
      profileDir,
      viewport: resolvedViewport,
      captureMode: 'tab',
      extensionId: installed.id,
      async close() {
        const ownedBrowser = browser;
        browser = null;
        await cleanupBrowser(ownedBrowser, profileDir);
      },
    };
  } catch (error) {
    const ownedBrowser = browser;
    browser = null;
    await cleanupBrowser(ownedBrowser, profileDir);
    throw error;
  }
}
