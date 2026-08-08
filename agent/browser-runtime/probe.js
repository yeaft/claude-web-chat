import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_RUNTIME_CHROME_BUILD,
  readBrowserExecutableVersion,
  resolveBrowserExecutable,
} from './browser-install.js';
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
const VERSION_PROCESS_FORCE_MS = 500;

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof BrowserRuntimeError) return reason;
  return new BrowserRuntimeError(
    'browser_probe_aborted',
    reason instanceof Error ? reason.message : 'Browser Runtime probe aborted',
  );
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
  const match = String(version || '').match(/(?:Chrome(?:\s+for\s+Testing)?|Chromium)(?:\/|\s+)(\d+(?:\.\d+){0,3})/i);
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

async function settleWithin(promise, { deadline, signal, maxWaitMs = CLEANUP_GRACE_MS }) {
  if (signal?.aborted) return false;
  const budget = Math.min(maxWaitMs, Math.max(0, deadline - Date.now()));
  if (budget <= 0) return false;
  let timer;
  let abortHandler;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), budget); }),
      new Promise(resolve => {
        abortHandler = () => resolve(false);
        signal?.addEventListener('abort', abortHandler, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
  }
}

async function waitForProcessExit(child, boundary) {
  if (!child || child.exitCode !== null) return true;
  if (typeof child.once !== 'function') return false;
  const exited = new Promise(resolve => {
    const onExit = () => {
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      resolve(true);
    };
    child.once('exit', onExit);
    child.once('close', onExit);
    if (child.exitCode !== null) onExit();
  });
  return settleWithin(exited, boundary);
}

async function cleanupBrowser(browser, profileDir, boundary, removeProfile = rm) {
  if (browser) {
    let closeCompletion;
    try {
      closeCompletion = Promise.resolve(browser.close()).then(() => true, () => false);
    } catch {
      closeCompletion = Promise.resolve(false);
    }
    const closed = await settleWithin(closeCompletion, boundary);
    if (!closed) {
      const child = forceKillBrowser(browser);
      if (Math.max(0, boundary.deadline - Date.now()) > 0) {
        await waitForProcessExit(child, boundary);
      }
    }
  }
  if (profileDir) {
    let removal;
    try {
      removal = Promise.resolve(removeProfile(profileDir, { recursive: true, force: true }))
        .then(() => true, () => false);
    } catch {
      removal = Promise.resolve(false);
    }
    if (!await settleWithin(removal, boundary)) removal.catch(() => {});
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
  versionCheck = readBrowserExecutableVersion,
  hashExtension = hashBrowserExtension,
  createProfile = mkdtemp,
  removeProfile = rm,
  profileParent = tmpdir(),
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1, Number(timeoutMs) || 1);
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(deadlineError()), Math.max(1, deadline - Date.now()));
  const probeController = new AbortController();
  const abortProbe = reason => {
    if (!probeController.signal.aborted) probeController.abort(reason);
  };
  const abortFromCaller = () => abortProbe(signal?.reason || abortError(signal));
  const abortFromDeadline = () => abortProbe(deadlineController.signal.reason || deadlineError());
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  deadlineController.signal.addEventListener('abort', abortFromDeadline, { once: true });
  if (signal?.aborted) abortFromCaller();
  const boundarySignal = probeController.signal;
  let extension = null;
  let actualBuildId = null;
  let profileDir = null;
  let browser = null;
  let launchPromise = null;
  let launchBoundaryFailed = false;

  try {
    boundarySignal.throwIfAborted();
    const resolvedExecutable = await raceBoundary(
      resolveExecutable({ executablePath, cacheDir }),
      { deadline, signal: boundarySignal, code: 'browser_executable_timeout' },
    );
    if (!resolvedExecutable) {
      return {
        ok: false,
        code: 'browser_executable_missing',
        ...baseResult(startedAt, null),
      };
    }

    let version;
    const versionTerminationDeadline = deadline + VERSION_PROCESS_FORCE_MS;
    const versionPromise = Promise.resolve().then(() => versionCheck(resolvedExecutable, {
      signal: boundarySignal,
      gracefulTerminationDeadline: deadline,
      terminationDeadline: versionTerminationDeadline,
    }));
    try {
      version = await raceBoundary(
        versionPromise,
        { deadline, signal: boundarySignal, code: 'browser_version_timeout' },
      );
    } catch (error) {
      if (!boundarySignal.aborted) abortProbe(error);
      await Promise.race([
        versionPromise.catch(() => {}),
        new Promise(resolve => setTimeout(
          resolve,
          Math.max(0, versionTerminationDeadline - Date.now()),
        )),
      ]);
      throw error;
    } finally {
      if (Date.now() >= deadline && !boundarySignal.aborted) abortProbe(deadlineError());
    }
    actualBuildId = actualChromeBuild(version);
    if (actualBuildId !== BROWSER_RUNTIME_CHROME_BUILD) {
      throw new BrowserRuntimeError(
        'browser_version_mismatch',
        `Browser Runtime requires Chrome ${BROWSER_RUNTIME_CHROME_BUILD}, got ${version || 'unknown'}`,
      );
    }

    extension = await raceBoundary(
      hashExtension(extensionDir, { expectedDigest: expectedExtensionDigest }),
      { deadline, signal: boundarySignal, code: 'extension_probe_timeout' },
    );
    await raceBoundary(mkdir(profileParent, { recursive: true, mode: 0o700 }), {
      deadline,
      signal: boundarySignal,
      code: 'probe_profile_timeout',
    });
    if (timeoutMs >= 1_000) {
      const profiles = await raceBoundary(readdir(profileParent, { withFileTypes: true }), {
        deadline,
        signal: boundarySignal,
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
        })), { deadline, signal: boundarySignal, code: 'probe_profile_timeout' });
    }
    profileDir = await raceBoundary(
      createProfile(join(profileParent, 'probe-')),
      { deadline, signal: boundarySignal, code: 'probe_profile_timeout' },
    );

    const launchBrowser = launch || (await raceBoundary(
      import('puppeteer-core').then(module => module.default.launch),
      { deadline, signal: boundarySignal, code: 'browser_launch_import_timeout' },
    ));
    const launchTimeout = remaining(deadline);
    launchPromise = Promise.resolve(launchBrowser({
      executablePath: resolvedExecutable,
      headless,
      userDataDir: profileDir,
      acceptInsecureCerts: false,
      timeout: launchTimeout,
      protocolTimeout: launchTimeout,
      signal: boundarySignal,
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
      browser = await raceBoundary(launchPromise, { deadline, signal: boundarySignal, code: 'browser_launch_timeout' });
    } catch (error) {
      launchBoundaryFailed = true;
      throw error;
    }

    const launchedVersion = await raceBoundary(browser.version(), {
      deadline,
      signal: boundarySignal,
      code: 'browser_version_timeout',
    });
    const launchedBuildId = actualChromeBuild(launchedVersion);
    if (launchedBuildId !== actualBuildId) {
      throw new BrowserRuntimeError(
        'browser_version_mismatch',
        `Browser Runtime executable changed after preflight: expected ${actualBuildId}, got ${launchedVersion || 'unknown'}`,
      );
    }

    const page = await raceBoundary(browser.newPage(), {
      deadline,
      signal: boundarySignal,
      code: 'probe_page_create_timeout',
    });
    await raceBoundary(page.goto(PROBE_PAGE, {
      waitUntil: 'domcontentloaded',
      timeout: remaining(deadline),
    }), { deadline, signal: boundarySignal, code: 'probe_page_timeout' });

    let installed = null;
    while (!installed) {
      const extensions = await raceBoundary(browser.extensions(), {
        deadline,
        signal: boundarySignal,
        code: 'extension_list_timeout',
      });
      installed = [...extensions.values()].find(candidate => candidate.name === BROWSER_EXTENSION_NAME) || null;
      if (!installed) await delay(100, { deadline, signal: boundarySignal });
    }

    await raceBoundary(page.triggerExtensionAction(installed), {
      deadline,
      signal: boundarySignal,
      code: 'extension_action_timeout',
    });
    const workerTarget = await raceBoundary(browser.waitForTarget(target => (
      target.type() === 'service_worker' && target.url().startsWith(`chrome-extension://${installed.id}/`)
    ), { timeout: remaining(deadline), signal: boundarySignal }), {
      deadline,
      signal: boundarySignal,
      code: 'extension_worker_timeout',
    });
    const worker = await raceBoundary(workerTarget.worker(), {
      deadline,
      signal: boundarySignal,
      code: 'extension_worker_timeout',
    });
    if (!worker) throw new BrowserRuntimeError('extension_worker_missing', 'Browser Runtime extension worker unavailable');
    const media = await readProbeResult(worker, { deadline, signal: boundarySignal });
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
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', abortFromCaller);
    deadlineController.signal.removeEventListener('abort', abortFromDeadline);
    if (!browser && launchBoundaryFailed && launchPromise) {
      const lateBudget = Math.min(CLEANUP_GRACE_MS, Math.max(0, deadline - Date.now()));
      if (lateBudget > 0) {
        try {
          browser = await Promise.race([
            launchPromise,
            new Promise(resolve => setTimeout(() => resolve(null), lateBudget)),
          ]);
        } catch {}
      }
    }
    await cleanupBrowser(browser, profileDir, {
      deadline,
      signal: (signal?.aborted || Date.now() >= deadline) ? boundarySignal : null,
    }, removeProfile);
    if (!browser && launchBoundaryFailed && launchPromise) {
      launchPromise.then(lateBrowser => {
        forceKillBrowser(lateBrowser);
        void cleanupBrowser(lateBrowser, profileDir, {
          deadline: Date.now(),
          signal: boundarySignal,
        }, removeProfile);
      }, () => {});
    }
  }
}
