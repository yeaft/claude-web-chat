import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
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
const PROFILE_STALE_MS = 30 * 60_000;
const CLEANUP_GRACE_MS = 250;
const FORCE_KILL_WAIT_MS = 250;

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new BrowserRuntimeError('browser_probe_aborted', 'Browser Runtime probe aborted');
}

function deadlineError() {
  return new BrowserRuntimeError('browser_probe_timeout', 'Browser Runtime probe exceeded its total deadline');
}

function remaining(deadline) {
  const value = deadline - Date.now();
  if (value <= 0) throw deadlineError();
  return value;
}

function raceBoundary(promise, { deadline, signal, code = 'browser_probe_timeout' }) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const timeoutMs = remaining(deadline);
  let timer;
  let abortHandler;
  const boundary = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BrowserRuntimeError(
      code,
      `Browser Runtime probe exceeded its total deadline after ${timeoutMs}ms`,
    )), timeoutMs);
    abortHandler = () => reject(abortError(signal));
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
  return Promise.race([Promise.resolve(promise), boundary]).finally(() => {
    clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
  });
}

function delay(ms, boundary) {
  return raceBoundary(new Promise(resolve => setTimeout(resolve, ms)), boundary);
}

function actualChromeBuild(version) {
  const match = String(version || '').match(/(?:Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/i);
  return match?.[1] || null;
}

async function readProbeResult(worker, boundary) {
  for (;;) {
    const result = await raceBoundary(worker.evaluate(() => {
      const storage = globalThis.chrome?.storage?.session;
      return storage ? storage.get('browserRuntimeProbe') : null;
    }), { ...boundary, code: 'probe_result_timeout' });
    if (result?.browserRuntimeProbe) return result.browserRuntimeProbe;
    await delay(100, boundary);
  }
}

function forceKillBrowser(browser) {
  const child = browser?.process?.();
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function cleanupBrowser(browser, profileDir) {
  if (browser) {
    let closed = false;
    try {
      await Promise.race([
        Promise.resolve(browser.close()).then(() => { closed = true; }),
        new Promise(resolve => setTimeout(resolve, CLEANUP_GRACE_MS)),
      ]);
    } catch {}
    if (!closed) {
      forceKillBrowser(browser);
      await new Promise(resolve => setTimeout(resolve, FORCE_KILL_WAIT_MS));
    }
  }
  if (profileDir) {
    await Promise.race([
      rm(profileDir, { recursive: true, force: true }),
      new Promise(resolve => setTimeout(resolve, CLEANUP_GRACE_MS)),
    ]);
  }
}

function baseResult(startedAt, extension, actualBuildId = null) {
  return {
    expectedBuildId: BROWSER_RUNTIME_CHROME_BUILD,
    actualBuildId,
    ...(extension ? {
      extensionDigest: extension.digest,
      extensionFileCount: extension.fileCount,
    } : {}),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Launch an isolated Chrome for Testing process and prove the complete primary
 * media path under one total deadline. The profile and process are owned until
 * cleanup finishes, including late launch completion after timeout/abort.
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
  resolveExecutable = resolveBrowserExecutable,
  hashExtension = hashBrowserExtension,
  createProfile = mkdtemp,
  profileParent = tmpdir(),
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1, Number(timeoutMs) || 1);
  let extension = null;
  let actualBuildId = null;
  let profileDir = null;
  let browser = null;
  let launchPromise = null;
  let launchBoundaryFailed = false;

  try {
    signal?.throwIfAborted();
    const resolvedExecutable = await raceBoundary(
      resolveExecutable({ executablePath, cacheDir }),
      { deadline, signal, code: 'browser_executable_timeout' },
    );
    if (!resolvedExecutable) {
      return {
        ok: false,
        code: 'browser_executable_missing',
        ...baseResult(startedAt, null),
      };
    }

    extension = await raceBoundary(
      hashExtension(extensionDir, { expectedDigest: expectedExtensionDigest }),
      { deadline, signal, code: 'extension_probe_timeout' },
    );
    await raceBoundary(mkdir(profileParent, { recursive: true, mode: 0o700 }), {
      deadline,
      signal,
      code: 'probe_profile_timeout',
    });
    if (timeoutMs >= 1_000) {
      const profiles = await raceBoundary(readdir(profileParent, { withFileTypes: true }), {
        deadline,
        signal,
        code: 'probe_profile_timeout',
      });
      await raceBoundary(Promise.all(profiles
        .filter(entry => entry.isDirectory() && entry.name.startsWith('probe-'))
        .map(async entry => {
          const profilePath = join(profileParent, entry.name);
          const details = await stat(profilePath);
          if (Date.now() - details.mtimeMs > PROFILE_STALE_MS) {
            await rm(profilePath, { recursive: true, force: true });
          }
        })), { deadline, signal, code: 'probe_profile_timeout' });
    }
    profileDir = await raceBoundary(
      createProfile(join(profileParent, 'probe-')),
      { deadline, signal, code: 'probe_profile_timeout' },
    );

    const launchBrowser = launch || (await raceBoundary(
      import('puppeteer-core').then(module => module.default.launch),
      { deadline, signal, code: 'browser_launch_import_timeout' },
    ));
    const launchTimeout = remaining(deadline);
    launchPromise = Promise.resolve(launchBrowser({
      executablePath: resolvedExecutable,
      headless,
      userDataDir: profileDir,
      acceptInsecureCerts: false,
      timeout: launchTimeout,
      protocolTimeout: launchTimeout,
      signal,
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
    }));
    try {
      browser = await raceBoundary(launchPromise, { deadline, signal, code: 'browser_launch_timeout' });
    } catch (error) {
      launchBoundaryFailed = true;
      throw error;
    }

    const version = await raceBoundary(browser.version(), {
      deadline,
      signal,
      code: 'browser_version_timeout',
    });
    actualBuildId = actualChromeBuild(version);
    if (actualBuildId !== BROWSER_RUNTIME_CHROME_BUILD) {
      throw new BrowserRuntimeError(
        'browser_version_mismatch',
        `Browser Runtime requires Chrome ${BROWSER_RUNTIME_CHROME_BUILD}, got ${version || 'unknown'}`,
      );
    }

    const page = await raceBoundary(browser.newPage(), {
      deadline,
      signal,
      code: 'probe_page_create_timeout',
    });
    await raceBoundary(page.goto(PROBE_PAGE, {
      waitUntil: 'domcontentloaded',
      timeout: remaining(deadline),
    }), { deadline, signal, code: 'probe_page_timeout' });

    let installed = null;
    while (!installed) {
      const extensions = await raceBoundary(browser.extensions(), {
        deadline,
        signal,
        code: 'extension_list_timeout',
      });
      installed = [...extensions.values()].find(candidate => candidate.name === BROWSER_EXTENSION_NAME) || null;
      if (!installed) await delay(100, { deadline, signal });
    }

    await raceBoundary(page.triggerExtensionAction(installed), {
      deadline,
      signal,
      code: 'extension_action_timeout',
    });
    const workerTarget = await raceBoundary(browser.waitForTarget(target => (
      target.type() === 'service_worker' && target.url().startsWith(`chrome-extension://${installed.id}/`)
    ), { timeout: remaining(deadline), signal }), {
      deadline,
      signal,
      code: 'extension_worker_timeout',
    });
    const worker = await raceBoundary(workerTarget.worker(), {
      deadline,
      signal,
      code: 'extension_worker_timeout',
    });
    if (!worker) throw new BrowserRuntimeError('extension_worker_missing', 'Browser Runtime extension worker unavailable');
    const media = await readProbeResult(worker, { deadline, signal });
    if (media.ok !== true || media.framesDecoded < 1) {
      throw new BrowserRuntimeError(media.code || 'media_probe_failed', media.safeError || 'Browser Runtime media probe failed');
    }

    return {
      ok: true,
      executablePath: resolvedExecutable,
      captureMode: media.captureMode,
      codecBaseline: media.codecBaseline,
      width: media.width,
      height: media.height,
      frameRate: media.frameRate,
      framesDecoded: media.framesDecoded,
      ...baseResult(startedAt, extension, actualBuildId),
    };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || (signal?.aborted ? 'browser_probe_aborted' : 'browser_probe_failed'),
      safeError: String(error?.message || error).slice(0, 500),
      ...baseResult(startedAt, extension, actualBuildId),
    };
  } finally {
    if (!browser && launchBoundaryFailed && launchPromise) {
      try {
        browser = await Promise.race([
          launchPromise,
          new Promise(resolve => setTimeout(() => resolve(null), CLEANUP_GRACE_MS)),
        ]);
      } catch {}
    }
    await cleanupBrowser(browser, profileDir);
    if (!browser && launchBoundaryFailed && launchPromise) {
      launchPromise.then(lateBrowser => cleanupBrowser(lateBrowser, profileDir), () => {});
    }
  }
}
