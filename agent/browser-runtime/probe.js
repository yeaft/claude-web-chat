import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_RUNTIME_CHROME_BUILD, resolveBrowserExecutable } from './browser-install.js';
import {
  hashBrowserExtension,
  BROWSER_EXTENSION_DIR,
  BROWSER_EXTENSION_NAME,
  BROWSER_EXTENSION_SHA256,
} from './extension.js';
import { BrowserRuntimeError } from './errors.js';

const PROBE_PAGE = 'data:text/html,<style>body{margin:0;background:%2309637d;color:white;font:48px sans-serif}</style><main>Yeaft Browser Runtime</main>';

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BrowserRuntimeError(code, `Browser Runtime probe exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readProbeResult(worker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A freshly attached MV3 service-worker target can become observable a few
    // milliseconds before Chrome injects the extension APIs. This is a bounded
    // read retry; never retrigger the action/capture side effect.
    const result = await worker.evaluate(() => {
      const storage = globalThis.chrome?.storage?.session;
      return storage ? storage.get('browserRuntimeProbe') : null;
    });
    if (result?.browserRuntimeProbe) return result.browserRuntimeProbe;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new BrowserRuntimeError('probe_result_timeout', 'Browser Runtime extension returned no probe result');
}

/**
 * Launch an isolated Chrome for Testing process and prove the complete primary
 * media path: fixed extension -> action activation -> tabCapture -> offscreen
 * document -> WebRTC encode/decode. The temporary profile is always deleted.
 */
export async function probeBrowserRuntime({
  executablePath = null,
  cacheDir,
  headless = true,
  timeoutMs = 20_000,
  extensionDir = BROWSER_EXTENSION_DIR,
  expectedExtensionDigest = extensionDir === BROWSER_EXTENSION_DIR ? BROWSER_EXTENSION_SHA256 : null,
  launch = null,
  signal = null,
} = {}) {
  const startedAt = Date.now();
  signal?.throwIfAborted();
  const resolvedExecutable = await resolveBrowserExecutable({ executablePath, cacheDir });
  if (!resolvedExecutable) {
    return {
      ok: false,
      code: 'browser_executable_missing',
      buildId: BROWSER_RUNTIME_CHROME_BUILD,
      durationMs: Date.now() - startedAt,
    };
  }

  let extension;
  try {
    extension = await hashBrowserExtension(extensionDir, { expectedDigest: expectedExtensionDigest });
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'extension_probe_failed',
      safeError: String(error?.message || error).slice(0, 500),
      buildId: BROWSER_RUNTIME_CHROME_BUILD,
      durationMs: Date.now() - startedAt,
    };
  }
  const profileDir = await mkdtemp(join(tmpdir(), 'yeaft-browser-probe-'));
  let browser = null;
  let abortClose = null;
  try {
    signal?.throwIfAborted();
    const launchBrowser = launch || (await import('puppeteer-core')).default.launch;
    // Puppeteer owns launch timeout cleanup. Racing launch against an unrelated
    // Promise would lose the eventual Browser handle and could orphan Chromium.
    browser = await launchBrowser({
      executablePath: resolvedExecutable,
      headless,
      userDataDir: profileDir,
      acceptInsecureCerts: false,
      timeout: timeoutMs,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-features=MediaRouter,Translate',
        '--disable-sync',
        '--no-first-run',
      ],
    });
    abortClose = () => { browser?.close().catch(() => {}); };
    signal?.addEventListener('abort', abortClose, { once: true });
    signal?.throwIfAborted();

    const page = await browser.newPage();
    await withTimeout(page.goto(PROBE_PAGE, { waitUntil: 'domcontentloaded' }), timeoutMs, 'probe_page_timeout');
    let installed = null;
    const extensionDeadline = Date.now() + timeoutMs;
    while (!installed && Date.now() < extensionDeadline) {
      const extensions = await browser.extensions();
      installed = [...extensions.values()].find(candidate => candidate.name === BROWSER_EXTENSION_NAME) || null;
      if (!installed) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!installed) throw new BrowserRuntimeError('extension_not_loaded', 'Browser Runtime extension did not load');
    const extensionId = installed.id;

    await withTimeout(page.triggerExtensionAction(installed), timeoutMs, 'extension_action_timeout');
    const workerTarget = await browser.waitForTarget(target => (
      target.type() === 'service_worker' && target.url().startsWith(`chrome-extension://${extensionId}/`)
    ), { timeout: timeoutMs });
    const worker = await workerTarget.worker();
    if (!worker) throw new BrowserRuntimeError('extension_worker_missing', 'Browser Runtime extension worker unavailable');
    const media = await withTimeout(readProbeResult(worker, timeoutMs), timeoutMs, 'media_probe_timeout');
    if (media.ok !== true || media.framesDecoded < 1) {
      throw new BrowserRuntimeError(media.code || 'media_probe_failed', media.safeError || 'Browser Runtime media probe failed');
    }

    return {
      ok: true,
      buildId: BROWSER_RUNTIME_CHROME_BUILD,
      executablePath: resolvedExecutable,
      extensionDigest: extension.digest,
      extensionFileCount: extension.fileCount,
      captureMode: media.captureMode,
      codecBaseline: media.codecBaseline,
      width: media.width,
      height: media.height,
      frameRate: media.frameRate,
      framesDecoded: media.framesDecoded,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'browser_probe_failed',
      safeError: String(error?.message || error).slice(0, 500),
      buildId: BROWSER_RUNTIME_CHROME_BUILD,
      extensionDigest: extension.digest,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (abortClose) signal?.removeEventListener('abort', abortClose);
    try { await browser?.close(); } catch {}
    await rm(profileDir, { recursive: true, force: true });
  }
}
