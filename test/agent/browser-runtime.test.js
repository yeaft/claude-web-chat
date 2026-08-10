import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import WebSocket from 'ws';
import { hostname } from 'node:os';
import { generateSystemdUnit } from '../../agent/service/linux.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRuntimeService } from '../../agent/browser-runtime/service.js';
import { handleBrowserRuntimeMessage } from '../../agent/browser-runtime/messages.js';
import { BrowserExtensionBridge } from '../../agent/browser-runtime/local-bridge.js';
import {
  BROWSER_RUNTIME_DEFAULTS,
  normaliseBrowserRuntimeSection,
  validateBrowserRuntimeUpdate,
} from '../../agent/browser-runtime/config.js';
import { ProducerSequenceState } from '../../agent/browser-runtime/protocol.js';
import { handleBrowserCommand } from '../../agent/browser-runtime/cli.js';
import { BROWSER_EXTENSION_SHA256, hashBrowserExtension } from '../../agent/browser-runtime/extension.js';
import { probeBrowserRuntime } from '../../agent/browser-runtime/probe.js';
import { nextAtomicTmpPathForTest, writeAtomic } from '../../agent/yeaft/storage/atomic.js';
import { mutateAgentConfig } from '../../agent/yeaft/config-store.js';
import {
  getBrowserRuntimeSettings,
  updateBrowserRuntimeSettings,
} from '../../agent/yeaft/config-api.js';
import {
  BROWSER_RUNTIME_CHROME_ARCHIVES,
  BROWSER_RUNTIME_CHROME_BUILD,
  findManagedBrowser,
  installManagedBrowser,
  managedBrowserDownloadInfo,
} from '../../agent/browser-runtime/browser-install.js';

const roots = [];
function tempRoot(prefix = 'yeaft-browser-runtime-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForFiles(paths, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (paths.some(path => !existsSync(path))) {
    if (Date.now() >= deadline) throw new Error('children did not reach barrier');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Browser Runtime configuration', () => {
  it('stays disabled by default and clamps hand-edited resource values', () => {
    const config = normaliseBrowserRuntimeSection({
      enabled: 'true',
      maxSessions: 999,
      maxWidth: 1,
      maxBitrate: Infinity,
      headless: false,
    });
    expect(config).toMatchObject({
      enabled: false,
      headless: false,
      maxSessions: 4,
      maxWidth: 320,
      maxBitrate: BROWSER_RUNTIME_DEFAULTS.maxBitrate,
    });
  });

  it('rejects unknown, wrong-type, and out-of-range public updates', () => {
    expect(validateBrowserRuntimeUpdate({ enabled: 'yes' })).toBe('enabled must be a boolean');
    expect(validateBrowserRuntimeUpdate({ maxSessions: 5 })).toContain('between 1 and 4');
    expect(validateBrowserRuntimeUpdate({ surprise: true })).toContain('unknown browser runtime setting');
    expect(validateBrowserRuntimeUpdate({ enabled: true, maxSessions: 2 })).toBeNull();
  });

  it('creates an owner-only first-run data root and config', () => {
    const parent = tempRoot();
    const root = join(parent, 'named-instance');
    const result = updateBrowserRuntimeSettings({ enabled: true }, root);
    expect(result).toMatchObject({ enabled: true, maxSessions: 2 });
    const configPath = join(root, 'config.json');
    expect(JSON.parse(readFileSync(configPath, 'utf8')).browserRuntime)
      .toMatchObject({ enabled: true, maxSessions: 2 });
    if (process.platform !== 'win32') {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });

  it('clamps an overly broad existing config and root mode while preserving tighter modes', () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const configPath = join(root, 'config.json');
    chmodSync(root, 0o755);
    writeFileSync(configPath, '{}', { mode: 0o644 });
    chmodSync(configPath, 0o644);
    expect(updateBrowserRuntimeSettings({ enabled: true }, root).error).toBeUndefined();
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    chmodSync(root, 0o700);
    chmodSync(configPath, 0o400);
    expect(updateBrowserRuntimeSettings({ enabled: false }, root).error).toBeUndefined();
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o400);
  });

  it('preserves an existing non-secret atomic target mode when no maximum is requested', () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const target = join(root, 'public-index');
    writeFileSync(target, 'old', { mode: 0o644 });
    chmodSync(target, 0o644);
    writeAtomic(target, 'new');
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it('refuses a pre-created atomic temp symlink without touching its victim', async () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const configPath = join(root, 'config.json');
    const victim = join(root, 'victim');
    writeFileSync(configPath, '{}');
    writeFileSync(victim, 'KEEP');
    const tmpPath = nextAtomicTmpPathForTest(configPath);
    symlinkSync(victim, tmpPath);
    expect(() => writeAtomic(configPath, 'SECRET')).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('KEEP');
    expect(lstatSync(tmpPath).isSymbolicLink()).toBe(true);
  });

  it('updates only browserRuntime while preserving unrelated config fields', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'https://example.test', models: ['m'] }],
      plugins: { tools: ['Bash'] },
      browserRuntime: { maxSessions: 3 },
    }));
    const result = updateBrowserRuntimeSettings({ enabled: true }, root);
    expect(result).toMatchObject({ enabled: true, maxSessions: 3 });
    const disk = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(disk.providers).toHaveLength(1);
    expect(disk.plugins).toEqual({ tools: ['Bash'] });
    expect(getBrowserRuntimeSettings(root)).toMatchObject({ enabled: true, maxSessions: 3 });
  });

  it('refuses to repair malformed config during a Browser Runtime write', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'config.json'), '{broken');
    expect(updateBrowserRuntimeSettings({ enabled: true }, root).error).toContain('Failed to read config.json');
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe('{broken');
  });

  it('does not steal an old lock whose local owner process is still alive', () => {
    const root = tempRoot();
    const lockDir = join(root, '.config.json.lock');
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: 'live-owner',
      startedAt: Date.now() - 60 * 60_000,
    }), { mode: 0o600 });
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(lockDir, old, old);

    expect(() => mutateAgentConfig(root, config => {
      config.browserRuntime = { enabled: true };
    }, { waitMs: 25 })).toThrow('config.json is busy');
    expect(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token).toBe('live-owner');
    expect(existsSync(join(root, 'config.json'))).toBe(false);
  }, 15_000);

  it('recovers a config lock whose local owner process is dead', () => {
    const root = tempRoot();
    const lockDir = join(root, '.config.json.lock');
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: 999_999,
      host: hostname(),
      startedAt: Date.now(),
    }), { mode: 0o600 });
    mutateAgentConfig(root, config => {
      config.browserRuntime = { enabled: true };
    }, { waitMs: 100 });
    expect(existsSync(lockDir)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({
      browserRuntime: { enabled: true },
    });
  });

  it('waits for an in-flight first config writer instead of overwriting it', async () => {
    const root = tempRoot();
    const barrier = tempRoot('yeaft-config-bootstrap-barrier-');
    const helper = fileURLToPath(new URL('../helpers/config-transaction-child.mjs', import.meta.url));
    const readyPath = join(barrier, 'ready');
    const startPath = join(barrier, 'start');
    const child = spawn(process.execPath, [
      helper,
      root,
      readyPath,
      startPath,
      'hold-browser',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    await waitForFiles([readyPath]);
    writeFileSync(startPath, 'go');
    await waitForFiles([`${readyPath}.locked`]);
    const initResult = new Promise((resolve, reject) => {
      const initChild = spawn(process.execPath, [
        '--input-type=module',
        '-e',
        `import { initYeaftDir } from ${JSON.stringify(new URL('../../agent/yeaft/init.js', import.meta.url).href)}; initYeaftDir(process.argv[1]);`,
        root,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      waitForExit(initChild).then(resolve, reject);
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    writeFileSync(`${startPath}.release`, 'go');
    await Promise.all([waitForExit(child), initResult]);

    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({
      browserRuntime: expect.objectContaining({ enabled: true }),
    });
  });

  it('serializes Browser, plugin, and telemetry writes across processes', async () => {
    const root = tempRoot();
    const barrier = tempRoot('yeaft-config-barrier-');
    const startPath = join(barrier, 'start');
    const helper = fileURLToPath(new URL('../helpers/config-transaction-child.mjs', import.meta.url));
    const operations = ['browser', 'plugins', 'telemetry'];
    const children = operations.map((operation, index) => spawn(process.execPath, [
      helper,
      root,
      join(barrier, `ready-${index}`),
      startPath,
      operation,
    ], { stdio: ['ignore', 'ignore', 'pipe'] }));
    await waitForFiles(operations.map((_, index) => join(barrier, `ready-${index}`)));
    writeFileSync(startPath, 'go');
    await Promise.all(children.map(waitForExit));

    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({
      browserRuntime: expect.objectContaining({ enabled: true }),
      plugins: { tools: ['FileRead'] },
      telemetry: expect.objectContaining({ enabled: false }),
    });
  });
});

describe('Browser Runtime CLI ownership', () => {
  function cliDependencies(overrides = {}) {
    const log = vi.fn();
    const getBrowserRuntimeSettings = vi.fn().mockReturnValue({
      enabled: false,
      executablePath: null,
      cacheDir: null,
      headless: true,
      startupProbeTimeoutMs: 20_000,
    });
    return {
      env: {},
      log,
      warn: vi.fn(),
      resolveManagedYeaftDir: vi.fn((args, _env, instanceId) => {
        const index = args.indexOf('--yeaft-dir');
        return index >= 0 ? args[index + 1] : `/data/${instanceId}`;
      }),
      configApi: {
        getBrowserRuntimeSettings,
        updateBrowserRuntimeSettings: vi.fn().mockReturnValue({ enabled: true }),
      },
      browserModule: {
        BROWSER_RUNTIME_CHROME_BUILD: 'test-build',
        defaultBrowserCacheDir: root => `${root}/managed-browser`,
        findManagedBrowser: vi.fn().mockResolvedValue(null),
        installManagedBrowser: vi.fn().mockResolvedValue({ buildId: 'test-build', executablePath: '/chrome' }),
        probeBrowserRuntime: vi.fn().mockResolvedValue({ ok: true }),
      },
      ...overrides,
    };
  }

  it('scopes status to the selected named Agent instance', async () => {
    const dependencies = cliDependencies();
    await handleBrowserCommand(['status', '--name', 'worker-a'], dependencies);
    expect(dependencies.resolveManagedYeaftDir).toHaveBeenCalledWith(
      ['--name', 'worker-a'],
      dependencies.env,
      'worker-a',
      expect.objectContaining({ loadServiceConfig: undefined, getDefaultYeaftDir: undefined }),
    );
    expect(dependencies.configApi.getBrowserRuntimeSettings).toHaveBeenCalledWith('/data/worker-a');
    expect(JSON.parse(dependencies.log.mock.calls[0][0])).toMatchObject({
      instanceId: 'worker-a',
      yeaftDir: '/data/worker-a',
    });
  });

  it('honours an explicit data root and warns for the legacy instance alias', async () => {
    const dependencies = cliDependencies();
    await handleBrowserCommand([
      'enable', '--instance', 'legacy-worker', '--yeaft-dir', '/custom/worker',
    ], dependencies);
    expect(dependencies.warn).toHaveBeenCalledOnce();
    expect(dependencies.resolveManagedYeaftDir).toHaveBeenCalledWith(
      ['--instance', 'legacy-worker', '--yeaft-dir', '/custom/worker'],
      dependencies.env,
      'legacy-worker',
      expect.objectContaining({ loadServiceConfig: undefined, getDefaultYeaftDir: undefined }),
    );
    expect(dependencies.configApi.updateBrowserRuntimeSettings)
      .toHaveBeenCalledWith({ enabled: true }, '/custom/worker');
  });

  it.each(['install', 'probe', 'enable', 'disable', 'status'])(
    'uses the persisted named-instance data root for %s',
    async action => {
      const dependencies = cliDependencies({
        env: { YEAFT_DIR: '/ambient/wrong-root' },
        resolveManagedYeaftDir: undefined,
        loadServiceConfig: vi.fn(instanceId => (
          instanceId === 'worker-a' ? { yeaftDir: '/persisted/worker-a' } : null
        )),
        getDefaultYeaftDir: vi.fn(instanceId => `/default/${instanceId}`),
      });
      await handleBrowserCommand([action, '--name', 'worker-a'], dependencies);
      expect(dependencies.configApi.getBrowserRuntimeSettings)
        .toHaveBeenCalledWith('/persisted/worker-a');
      if (action === 'enable' || action === 'disable') {
        expect(dependencies.configApi.updateBrowserRuntimeSettings)
          .toHaveBeenCalledWith({ enabled: action === 'enable' }, '/persisted/worker-a');
      }
    },
  );

  it('honours an explicit data root and ambient root only without explicit identity', async () => {
    const explicit = cliDependencies({
      env: { YEAFT_DIR: '/ambient/root' },
      resolveManagedYeaftDir: undefined,
      loadServiceConfig: vi.fn(() => ({ yeaftDir: '/persisted/worker-a' })),
      getDefaultYeaftDir: vi.fn(instanceId => `/default/${instanceId}`),
    });
    await handleBrowserCommand([
      'status', '--name', 'worker-a', '--yeaft-dir', '/flag/root',
    ], explicit);
    expect(explicit.configApi.getBrowserRuntimeSettings).toHaveBeenCalledWith('/flag/root');

    const ambient = cliDependencies({
      env: { YEAFT_DIR: '/ambient/root' },
      resolveManagedYeaftDir: undefined,
      loadServiceConfig: vi.fn(() => ({ yeaftDir: '/persisted/default' })),
      getDefaultYeaftDir: vi.fn(instanceId => `/default/${instanceId}`),
    });
    await handleBrowserCommand(['status'], ambient);
    expect(ambient.configApi.getBrowserRuntimeSettings).toHaveBeenCalledWith('/ambient/root');
  });

  it('reports probe failure without mutating config', async () => {
    const onProbeFailure = vi.fn();
    const dependencies = cliDependencies({ onProbeFailure });
    dependencies.browserModule.probeBrowserRuntime.mockResolvedValue({ ok: false, code: 'media_probe_failed' });
    await handleBrowserCommand(['probe', '--name', 'worker-a'], dependencies);
    expect(onProbeFailure).toHaveBeenCalledWith({ ok: false, code: 'media_probe_failed' });
    expect(dependencies.configApi.updateBrowserRuntimeSettings).not.toHaveBeenCalled();
  });
});

describe('Managed Browser installation', () => {
  function fakeBrowsers() {
    return {
      Browser: { CHROME: 'chrome' },
      detectBrowserPlatform: () => 'linux',
      getInstalledBrowsers: vi.fn(async () => []),
    };
  }

  function archiveResponse(content) {
    return {
      ok: true,
      headers: { get: name => name === 'content-length' ? String(content.length) : null },
      body: (async function* body() { yield content; }()),
    };
  }

  function installerDependencies(cacheDir, executableContent = 'chrome-binary') {
    const browsers = fakeBrowsers();
    const install = vi.fn(async options => {
      const finalDir = join(
        options.cacheDir,
        'chrome',
        `linux-${BROWSER_RUNTIME_CHROME_BUILD}`,
      );
      const executablePath = join(finalDir, 'chrome-linux64', 'chrome');
      await import('node:fs/promises').then(fs => fs.mkdir(join(finalDir, 'chrome-linux64'), { recursive: true }));
      await import('node:fs/promises').then(fs => fs.writeFile(executablePath, executableContent, { mode: 0o755 }));
      return { executablePath };
    });
    return {
      browsers,
      platform: 'linux',
      install,
      versionCheck: vi.fn(async () => `Google Chrome for Testing ${BROWSER_RUNTIME_CHROME_BUILD}`),
      cacheDir,
    };
  }

  it('runs the real executable version reader without an AbortSignal', async () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const executablePath = join(root, 'fake-chrome');
    writeFileSync(executablePath, '#!/bin/sh\nprintf "Google Chrome 151.0.7922.71\\n"\n', { mode: 0o755 });
    if (process.platform !== 'win32') chmodSync(executablePath, 0o755);
    const { readBrowserExecutableVersion } = await import('../../agent/browser-runtime/browser-install.js');
    await expect(readBrowserExecutableVersion(executablePath)).resolves.toContain(BROWSER_RUNTIME_CHROME_BUILD);
  });

  it('keeps standalone Node alive until a successful version descendant is reaped', async () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const pidPath = join(root, 'successful-version-descendant.pid');
    const executablePath = join(root, 'fake-chrome');
    writeFileSync(executablePath, [
      '#!/bin/sh',
      'sh -c \'trap "" TERM; while :; do sleep 1; done\' </dev/null >/dev/null 2>&1 &',
      'printf \'%s\\n\' "$!" > "$YEAFT_TEST_PID_PATH"',
      `printf 'Google Chrome ${BROWSER_RUNTIME_CHROME_BUILD}\\n'`,
      '',
    ].join('\n'), { mode: 0o755 });
    chmodSync(executablePath, 0o755);

    const readerPath = fileURLToPath(new URL('../helpers/browser-version-reader.mjs', import.meta.url));
    let descendantPid = null;
    try {
      const child = spawn(process.execPath, [readerPath, executablePath], {
        env: { ...process.env, YEAFT_TEST_PID_PATH: pidPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
      expect({ code, stdout, stderr }).toMatchObject({
        code: 0,
        stdout: expect.stringContaining(BROWSER_RUNTIME_CHROME_BUILD),
        stderr: '',
      });
      expect(processExists(descendantPid)).toBe(false);
    } finally {
      if (processExists(descendantPid)) process.kill(descendantPid, 'SIGKILL');
    }
  });

  it('bounds direct version reads without relying on an outer probe deadline', async () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const executablePath = join(root, 'fake-chrome');
    writeFileSync(executablePath, '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n', { mode: 0o755 });
    chmodSync(executablePath, 0o755);
    const { readBrowserExecutableVersion } = await import('../../agent/browser-runtime/browser-install.js');
    const startedAt = Date.now();
    await expect(readBrowserExecutableVersion(executablePath, {
      gracefulTerminationDeadline: startedAt + 25,
      terminationDeadline: startedAt + 250,
      processOptions: { killGraceMs: 25, forceSettleMs: 225 },
    })).rejects.toThrow('failed (124)');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('force-settles a real version-check process tree before the probe returns', async () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const pidPath = join(root, 'version-check-pids.json');
    const helperPath = fileURLToPath(new URL('../helpers/browser-version-hang.mjs', import.meta.url));
    const executablePath = join(root, 'fake-chrome');
    writeFileSync(executablePath, [
      '#!/bin/sh',
      'trap "" TERM',
      'sh -c \'trap "" TERM; while :; do sleep 1; done\' &',
      'printf \'{"parentPid":%s,"descendantPid":%s}\\n\' "$$" "$!" > "$YEAFT_TEST_PID_PATH"',
      'exec "$YEAFT_TEST_NODE" "$YEAFT_TEST_HELPER"',
      '',
    ].join('\n'), {
      mode: 0o755,
    });
    chmodSync(executablePath, 0o755);

    const originalEnv = {
      YEAFT_TEST_NODE: process.env.YEAFT_TEST_NODE,
      YEAFT_TEST_HELPER: process.env.YEAFT_TEST_HELPER,
      YEAFT_TEST_PID_PATH: process.env.YEAFT_TEST_PID_PATH,
    };
    process.env.YEAFT_TEST_NODE = process.execPath;
    process.env.YEAFT_TEST_HELPER = helperPath;
    process.env.YEAFT_TEST_PID_PATH = pidPath;
    let pids = null;
    try {
      const startedAt = Date.now();
      const result = await probeBrowserRuntime({
        executablePath,
        cacheDir: root,
        timeoutMs: 250,
        launch: vi.fn(),
      });
      const elapsedMs = Date.now() - startedAt;
      pids = JSON.parse(readFileSync(pidPath, 'utf8'));

      expect(result.ok).toBe(false);
      expect(result.code).toMatch(/^browser_(?:probe|version)_timeout$/);
      expect(elapsedMs).toBeLessThan(1_500);
      expect(processExists(pids.parentPid)).toBe(false);
      expect(processExists(pids.descendantPid)).toBe(false);
    } finally {
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      for (const pid of [pids?.descendantPid, pids?.parentPid]) {
        if (processExists(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  }, 5_000);

  it('uses pre-exit Windows Job ownership for successful version reads', async () => {
    const { readBrowserExecutableVersion } = await import('../../agent/browser-runtime/browser-install.js');
    const windowsVersionReader = vi.fn().mockResolvedValue(`Google Chrome ${BROWSER_RUNTIME_CHROME_BUILD}`);
    await expect(readBrowserExecutableVersion('chrome.exe', {
      terminationDeadline: Date.now() + 500,
      processOptions: { platform: 'win32' },
      windowsVersionReader,
    })).resolves.toContain(BROWSER_RUNTIME_CHROME_BUILD);
    expect(windowsVersionReader).toHaveBeenCalledWith('chrome.exe', expect.objectContaining({
      signal: null,
      terminationDeadline: expect.any(Number),
    }));
  });

  it('keeps the Windows Job wrapper and worker arguments shell-free and bounded', async () => {
    const { readWindowsBrowserExecutableVersion } = await import('../../agent/browser-runtime/windows-version.js');
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: `${JSON.stringify({
        ok: true,
        code: 0,
        stdout: `Google Chrome ${BROWSER_RUNTIME_CHROME_BUILD}\\r\\n`,
        stderr: '',
        truncated: false,
      })}\n`,
      stderr: '',
      truncated: false,
      timedOut: false,
    });
    await expect(readWindowsBrowserExecutableVersion('C:\\Program Files\\Chrome\\chrome.exe', {
      run,
      powershellPath: 'powershell.exe',
      nodePath: 'node.exe',
      workerPath: 'worker.js',
      jobScriptPath: 'job.ps1',
      terminationDeadline: Date.now() + 500,
    })).resolves.toContain(BROWSER_RUNTIME_CHROME_BUILD);
    expect(run).toHaveBeenCalledWith('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'job.ps1',
      '-NodePath',
      'node.exe',
      '-WorkerPath',
      'worker.js',
      '-ExecutablePath',
      'C:\\Program Files\\Chrome\\chrome.exe',
      '-CleanupTimeoutMs',
      expect.any(String),
    ], expect.objectContaining({
      requireExitConfirmation: true,
      timeoutMs: expect.any(Number),
      maxBytes: 128 * 1024,
    }));
  });

  it('rejects Windows Job wrapper failures instead of trusting a post-exit PID', async () => {
    const { readWindowsBrowserExecutableVersion } = await import('../../agent/browser-runtime/windows-version.js');
    const run = vi.fn().mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'AssignProcessToJobObject failed with Win32 error 5',
      truncated: false,
      timedOut: false,
    });
    await expect(readWindowsBrowserExecutableVersion('chrome.exe', {
      run,
      terminationDeadline: Date.now() + 50,
    })).rejects.toThrow('AssignProcessToJobObject failed');
  });

  it('runs a real Windows Job-owned no-descendant version check', async () => {
    if (process.platform !== 'win32') return;
    const { readWindowsBrowserExecutableVersion } = await import('../../agent/browser-runtime/windows-version.js');
    await expect(readWindowsBrowserExecutableVersion(process.execPath, {
      terminationDeadline: Date.now() + 10_000,
    })).resolves.toContain(process.version);
  });

  it('reaps a real Windows Job-owned descendant before version success settles', async () => {
    if (process.platform !== 'win32') return;
    const root = tempRoot();
    const pidPath = join(root, 'windows-version-descendant.pid');
    const executablePath = join(root, 'fake-chrome.js');
    const descendantScript = join(root, 'descendant.js');
    writeFileSync(descendantScript, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); if (process.send) process.send("ready"); setInterval(() => {}, 1000);\n');
    writeFileSync(executablePath, [
      `const { fork } = require('node:child_process');`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.once('data', () => {`,
      `  const child = fork(${JSON.stringify(descendantScript)}, [${JSON.stringify(pidPath)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
      `  child.once('message', () => {`,
      `    const result = { ok: true, code: 0, stdout: 'Google Chrome ${BROWSER_RUNTIME_CHROME_BUILD}\\n', stderr: '', truncated: false };`,
      `    process.stdout.write(JSON.stringify(result) + '\\n', () => process.exit(0));`,
      `  });`,
      `});`,
      `process.stdin.resume();`,
      '',
    ].join('\n'));
    const { readWindowsBrowserExecutableVersion } = await import('../../agent/browser-runtime/windows-version.js');
    let descendantPid = null;
    try {
      await expect(readWindowsBrowserExecutableVersion(process.execPath, {
        terminationDeadline: Date.now() + 10_000,
        workerPath: executablePath,
      })).resolves.toContain(BROWSER_RUNTIME_CHROME_BUILD);
      descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
      expect(processExists(descendantPid)).toBe(false);
    } finally {
      if (processExists(descendantPid)) {
        spawn('taskkill.exe', ['/pid', String(descendantPid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      }
    }
  });

  it('rejects a managed archive whose pinned digest does not match', async () => {
    const cacheDir = tempRoot();
    const dependencies = installerDependencies(cacheDir);
    await expect(installManagedBrowser({
      cacheDir,
      fetchFn: vi.fn().mockResolvedValue(archiveResponse(Buffer.from('tampered'))),
      dependencies,
    })).rejects.toThrow('checksum mismatch');
    expect(dependencies.install).not.toHaveBeenCalled();
  });

  it('recovers a partial final install through staging and atomic publish', async () => {
    const cacheDir = tempRoot();
    const partialDir = join(cacheDir, 'chrome', `linux-${BROWSER_RUNTIME_CHROME_BUILD}`);
    await import('node:fs/promises').then(fs => fs.mkdir(partialDir, { recursive: true }));
    writeFileSync(join(partialDir, 'partial'), 'broken');
    const archive = Buffer.from('verified-archive');
    const dependencies = installerDependencies(cacheDir);
    dependencies.archives = {
      ...BROWSER_RUNTIME_CHROME_ARCHIVES,
      linux: {
        ...BROWSER_RUNTIME_CHROME_ARCHIVES.linux,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
    };
    const result = await installManagedBrowser({
      cacheDir,
      fetchFn: vi.fn().mockResolvedValue(archiveResponse(archive)),
      dependencies,
    });
    expect(result).toMatchObject({ status: 'installed', buildId: BROWSER_RUNTIME_CHROME_BUILD });
    expect(existsSync(join(partialDir, 'partial'))).toBe(false);
    expect(existsSync(result.executablePath)).toBe(true);
    expect(await findManagedBrowser(cacheDir, {
      ...dependencies,
      executablePath: result.executablePath,
    })).toBe(result.executablePath);
  });

  it('removes interrupted staging without publishing a partial final', async () => {
    const cacheDir = tempRoot();
    const archive = Buffer.from('verified-archive');
    const dependencies = installerDependencies(cacheDir);
    dependencies.archives = {
      ...BROWSER_RUNTIME_CHROME_ARCHIVES,
      linux: {
        ...BROWSER_RUNTIME_CHROME_ARCHIVES.linux,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
    };
    dependencies.install.mockRejectedValue(new Error('synthetic extraction interruption'));
    await expect(installManagedBrowser({
      cacheDir,
      fetchFn: vi.fn().mockResolvedValue(archiveResponse(archive)),
      dependencies,
    })).rejects.toThrow('synthetic extraction interruption');
    expect(existsSync(join(cacheDir, 'chrome', `linux-${BROWSER_RUNTIME_CHROME_BUILD}`))).toBe(false);
    await expect((await import('node:fs/promises')).readdir(cacheDir)).resolves.not.toEqual(
      expect.arrayContaining([expect.stringContaining('-staging-')]),
    );
  });

  it('recovers a lock and staging directory left by a dead installer', async () => {
    const cacheDir = tempRoot();
    const archive = Buffer.from('verified-archive');
    const dependencies = installerDependencies(cacheDir);
    dependencies.archives = {
      ...BROWSER_RUNTIME_CHROME_ARCHIVES,
      linux: {
        ...BROWSER_RUNTIME_CHROME_ARCHIVES.linux,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
    };
    const lockDir = join(cacheDir, `.chrome-${BROWSER_RUNTIME_CHROME_BUILD}.lock`);
    await import('node:fs/promises').then(fs => fs.mkdir(lockDir));
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: 999_999,
      host: hostname(),
      startedAt: Date.now(),
    }));
    const orphanedStaging = join(cacheDir, `.chrome-${BROWSER_RUNTIME_CHROME_BUILD}-staging-orphaned`);
    await import('node:fs/promises').then(fs => fs.mkdir(orphanedStaging));
    writeFileSync(join(orphanedStaging, 'owner.json'), JSON.stringify({
      pid: 999_999,
      host: hostname(),
      token: 'dead-staging',
      startedAt: Date.now(),
    }));

    const result = await installManagedBrowser({
      cacheDir,
      fetchFn: vi.fn().mockResolvedValue(archiveResponse(archive)),
      dependencies,
    });
    expect(result.status).toBe('installed');
    expect(existsSync(lockDir)).toBe(false);
    expect(existsSync(orphanedStaging)).toBe(false);
  });

  it('does not steal an aged install lock whose local owner process is still alive', async () => {
    const cacheDir = tempRoot();
    const lockDir = join(cacheDir, `.chrome-${BROWSER_RUNTIME_CHROME_BUILD}.lock`);
    await import('node:fs/promises').then(fs => fs.mkdir(lockDir));
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: 'live-installer',
      startedAt: Date.now() - 60 * 60_000,
    }));
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(lockDir, old, old);
    const dependencies = installerDependencies(cacheDir);

    await expect(installManagedBrowser({
      cacheDir,
      fetchFn: vi.fn(),
      dependencies: { ...dependencies, waitMs: 25, staleMs: 1 },
    })).rejects.toThrow('Managed Chrome install is busy');
    expect(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token).toBe('live-installer');
    expect(dependencies.install).not.toHaveBeenCalled();
  });

  it('ignores an orphan staging directory with no ownership proof', async () => {
    const cacheDir = tempRoot();
    const unowned = join(cacheDir, `.chrome-${BROWSER_RUNTIME_CHROME_BUILD}-staging-unowned`);
    mkdirSync(unowned);
    writeFileSync(join(unowned, 'keep'), 'unowned');
    const archive = Buffer.from('verified-archive');
    const dependencies = installerDependencies(cacheDir);
    dependencies.archives = {
      ...BROWSER_RUNTIME_CHROME_ARCHIVES,
      linux: {
        ...BROWSER_RUNTIME_CHROME_ARCHIVES.linux,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
    };
    await installManagedBrowser({
      cacheDir,
      fetchFn: vi.fn().mockResolvedValue(archiveResponse(archive)),
      dependencies,
    });
    expect(readFileSync(join(unowned, 'keep'), 'utf8')).toBe('unowned');
  });

  it('does not sweep another active installer staging directory', async () => {
    const cacheDir = tempRoot();
    const archive = Buffer.from('verified-archive');
    const firstDependencies = installerDependencies(cacheDir, 'first-browser');
    const secondDependencies = installerDependencies(cacheDir, 'second-browser');
    const archives = {
      ...BROWSER_RUNTIME_CHROME_ARCHIVES,
      linux: {
        ...BROWSER_RUNTIME_CHROME_ARCHIVES.linux,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
    };
    firstDependencies.archives = archives;
    secondDependencies.archives = archives;
    let releaseFirst;
    const firstEntered = new Promise(resolve => {
      firstDependencies.install.mockImplementation(async options => {
        const finalDir = join(options.cacheDir, 'chrome', `linux-${BROWSER_RUNTIME_CHROME_BUILD}`);
        const executablePath = join(finalDir, 'chrome-linux64', 'chrome');
        await import('node:fs/promises').then(fs => fs.mkdir(join(finalDir, 'chrome-linux64'), { recursive: true }));
        await import('node:fs/promises').then(fs => fs.writeFile(executablePath, 'first-browser', { mode: 0o755 }));
        resolve();
        await new Promise(done => { releaseFirst = done; });
        return { executablePath };
      });
    });
    const first = installManagedBrowser({
      cacheDir,
      fetchFn: vi.fn().mockResolvedValue(archiveResponse(archive)),
      dependencies: { ...firstDependencies, staleMs: 1 },
    });
    await firstEntered;
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = installManagedBrowser({
      cacheDir,
      fetchFn: vi.fn().mockResolvedValue(archiveResponse(archive)),
      dependencies: { ...secondDependencies, staleMs: 1, waitMs: 25 },
    });
    await expect(second).rejects.toThrow('Managed Chrome install is busy');
    const stagingEntries = (await import('node:fs/promises')).readdir(cacheDir, { withFileTypes: true });
    expect((await stagingEntries).some(entry => (
      entry.isDirectory() && entry.name.startsWith(`.chrome-${BROWSER_RUNTIME_CHROME_BUILD}-staging-`)
    ))).toBe(true);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: 'installed' });
    expect(secondDependencies.install).not.toHaveBeenCalled();
  });

  it('serializes concurrent installers and reuses the verified result', async () => {
    const cacheDir = tempRoot();
    const archive = Buffer.from('verified-archive');
    const dependencies = installerDependencies(cacheDir);
    dependencies.archives = {
      ...BROWSER_RUNTIME_CHROME_ARCHIVES,
      linux: {
        ...BROWSER_RUNTIME_CHROME_ARCHIVES.linux,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
    };
    dependencies.browsers.getInstalledBrowsers.mockImplementation(async () => {
      const executablePath = join(
        cacheDir,
        'chrome',
        `linux-${BROWSER_RUNTIME_CHROME_BUILD}`,
        'chrome-linux64',
        'chrome',
      );
      return existsSync(executablePath) ? [{
        browser: 'chrome',
        buildId: BROWSER_RUNTIME_CHROME_BUILD,
        platform: 'linux',
        executablePath,
      }] : [];
    });
    const fetchFn = vi.fn().mockImplementation(async () => archiveResponse(archive));
    const first = installManagedBrowser({ cacheDir, fetchFn, dependencies });
    const second = installManagedBrowser({ cacheDir, fetchFn, dependencies });
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.status).sort()).toEqual(['available', 'installed']);
    expect(dependencies.install).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe('Browser Runtime extension bridge', () => {
  it('accepts only the per-session token and fences the Browser Session id', async () => {
    const bridge = new BrowserExtensionBridge();
    const messages = [];
    const registration = await bridge.registerSession('session-a', {
      onMessage: message => messages.push(message),
    });
    const invalid = new WebSocket(registration.bridgeUrl.replace(/[^/]+$/, 'invalid-token'));
    const invalidClose = new Promise(resolve => invalid.once('close', (code) => resolve(code)));
    await expect(invalidClose).resolves.toBe(1008);

    const socket = new WebSocket(registration.bridgeUrl);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'runtime_ready', browserSessionId: 'session-b' }));
    const mismatchedClose = await new Promise(resolve => socket.once('close', (code) => resolve(code)));
    expect(mismatchedClose).toBe(1008);

    const valid = new WebSocket(registration.bridgeUrl);
    await new Promise((resolve, reject) => {
      valid.once('open', resolve);
      valid.once('error', reject);
    });
    valid.send(JSON.stringify({ type: 'runtime_ready', browserSessionId: 'session-a' }));
    await expect(registration.waitUntilReady(500)).resolves.toMatchObject({ type: 'runtime_ready' });
    valid.send(JSON.stringify({ type: 'peer_state', browserSessionId: 'session-a', state: 'connected' }));
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ state: 'connected' })));
    expect(bridge.send('session-a', { type: 'peer_close' })).toBe(true);
    await bridge.close();
  });
});

describe('Browser Runtime sequence fencing', () => {
  it('keeps reliable control and lossy pointer sequence spaces independent', () => {
    const state = new ProducerSequenceState({ producerId: 'p1', producerGeneration: 1 });
    expect(state.acceptPointer({ producerId: 'p1', producerGeneration: 1, pointerSeq: 12 }).accepted).toBe(true);
    expect(state.acceptPointer({ producerId: 'p1', producerGeneration: 1, pointerSeq: 11 })).toMatchObject({
      accepted: false,
      code: 'pointer_stale',
      pointerHighWater: 12,
    });
    expect(state.acceptControl({ producerId: 'p1', producerGeneration: 1, controlSeq: 1 }).accepted).toBe(true);
    expect(state.snapshot()).toMatchObject({ lastAcceptedControlSeq: 1, lastAcceptedPointerSeq: 12 });
  });

  it('rejects reliable gaps without advancing the high-water mark', () => {
    const state = new ProducerSequenceState({ producerId: 'p1', producerGeneration: 2 });
    expect(state.acceptControl({ producerId: 'p1', producerGeneration: 2, controlSeq: 2 })).toMatchObject({
      accepted: false,
      code: 'control_gap',
      expectedControlSeq: 1,
    });
    expect(state.acceptControl({ producerId: 'p1', producerGeneration: 2, controlSeq: 1 }).accepted).toBe(true);
    expect(state.acceptControl({ producerId: 'p1', producerGeneration: 1, controlSeq: 2 }).code).toBe('producer_stale');
  });
});

describe('Browser Runtime service containment', () => {
  it('gives Agent cleanup a deadline and then kills the whole service cgroup', () => {
    const unit = generateSystemdUnit({
      instanceId: 'browser-test',
      serverUrl: 'wss://example.test',
      agentName: 'browser-test',
      agentSecret: 'secret',
      workDir: '/tmp',
      yeaftDir: '/tmp/yeaft-browser-test',
    });
    expect(unit).toContain('KillMode=mixed');
    expect(unit).toContain('TimeoutStopSec=15');
    expect(unit).not.toContain('KillMode=process');
  });
});

describe('Browser Runtime lifecycle', () => {
  it('requires a Server-stamped owner identity before setup reads or writes execute', async () => {
    const runtime = {
      setupStatus: vi.fn(),
      installAndEnable: vi.fn(),
      enableAndProbe: vi.fn(),
    };
    const send = vi.fn();
    for (const type of ['browser_runtime_status', 'browser_runtime_install', 'browser_runtime_enable']) {
      expect(await handleBrowserRuntimeMessage({
        type,
        requestId: `request-${type}`,
        confirmedBuildId: BROWSER_RUNTIME_CHROME_BUILD,
        confirmedDownloadBytes: 193_285_407,
      }, { runtime, send })).toBe(true);
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'browser_runtime_error',
        requestId: `request-${type}`,
        code: 'browser_identity_required',
      }));
    }
    expect(runtime.setupStatus).not.toHaveBeenCalled();
    expect(runtime.installAndEnable).not.toHaveBeenCalled();
    expect(runtime.enableAndProbe).not.toHaveBeenCalled();
  });

  it('reports pinned download metadata without installing and rejects stale explicit confirmation', async () => {
    expect(managedBrowserDownloadInfo({ platform: 'linux', arch: 'x64' })).toMatchObject({
      supported: true,
      buildId: BROWSER_RUNTIME_CHROME_BUILD,
      platform: 'linux',
      downloadBytes: 193_285_407,
    });
    expect(managedBrowserDownloadInfo({ platform: 'linux', arch: 'arm64' })).toMatchObject({
      supported: false,
      downloadBytes: 0,
    });

    const installBrowser = vi.fn();
    const runtime = new BrowserRuntimeService({
      yeaftDir: tempRoot(),
      config: {},
      findBrowser: vi.fn().mockResolvedValue(null),
      resolveBrowser: vi.fn().mockResolvedValue(null),
      installBrowser,
      platform: 'linux',
      arch: 'x64',
    });
    await expect(runtime.setupStatus()).resolves.toMatchObject({
      state: 'not_installed', installed: false, enabled: false, ready: false,
      downloadBytes: 193_285_407,
    });
    expect(installBrowser).not.toHaveBeenCalled();
    await expect(runtime.installAndEnable({
      confirmedBuildId: BROWSER_RUNTIME_CHROME_BUILD,
      confirmedDownloadBytes: 1,
    })).rejects.toMatchObject({ code: 'browser_install_confirmation_stale' });
    expect(installBrowser).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it('single-flights an explicit install, persists enablement, probes, and refreshes capabilities', async () => {
    let finishInstall;
    const installBrowser = vi.fn(({ onProgress }) => new Promise(resolve => {
      onProgress(96, 193_285_407);
      finishInstall = () => resolve({ status: 'installed', executablePath: '/managed/chrome' });
    }));
    const saveSettings = vi.fn().mockReturnValue({ enabled: true, executablePath: null });
    const onCapabilitiesChanged = vi.fn();
    const probe = vi.fn().mockResolvedValue({ ok: true, captureMode: 'tab' });
    const runtime = new BrowserRuntimeService({
      yeaftDir: tempRoot(),
      config: {},
      findBrowser: vi.fn().mockResolvedValue(null),
      resolveBrowser: vi.fn().mockResolvedValue('/managed/chrome'),
      installBrowser,
      saveSettings,
      onCapabilitiesChanged,
      probe,
      platform: 'linux',
      arch: 'x64',
    });
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const confirmation = {
      confirmedBuildId: BROWSER_RUNTIME_CHROME_BUILD,
      confirmedDownloadBytes: 193_285_407,
    };
    const first = runtime.installAndEnable({ ...confirmation, onProgress: firstProgress });
    await vi.waitFor(() => expect(installBrowser).toHaveBeenCalledOnce());
    const second = runtime.installAndEnable({ ...confirmation, onProgress: secondProgress });
    expect(runtime.setupCapabilities()).toEqual(['browser_runtime_setup']);
    expect(await runtime.setupStatus()).toMatchObject({ state: 'installing' });
    finishInstall();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: 'ready', installed: true, ready: true }),
      expect.objectContaining({ state: 'ready', installed: true, ready: true }),
    ]);
    expect(installBrowser).toHaveBeenCalledOnce();
    expect(firstProgress).toHaveBeenCalledWith({ downloadedBytes: 96, totalBytes: 193_285_407 });
    expect(saveSettings).toHaveBeenCalledWith({ enabled: true, executablePath: null });
    expect(probe).toHaveBeenCalledOnce();
    expect(onCapabilitiesChanged).toHaveBeenCalledOnce();
    expect(runtime.capabilities()).toEqual(['browser_runtime', 'browser_webrtc', 'browser_capture_tab']);
    await runtime.shutdown();
  });

  it('does not run a probe while disabled', async () => {
    const probe = vi.fn();
    const runtime = new BrowserRuntimeService({ yeaftDir: tempRoot(), config: {}, probe });
    await expect(runtime.startupProbe()).resolves.toEqual({ ok: false, code: 'browser_runtime_disabled' });
    expect(probe).not.toHaveBeenCalled();
    expect(runtime.capabilities()).toEqual([]);
  });

  it('advertises only a probe-ready Linux tab-capture runtime and enforces live Session capacity', async () => {
    const page = Object.assign(new EventEmitter(), {
      url: vi.fn(() => 'about:blank'),
      title: vi.fn().mockResolvedValue(''),
      mainFrame: vi.fn(() => null),
    });
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      registerSession: vi.fn(async () => ({
        bridgeUrl: 'ws://127.0.0.1:1/browser-runtime/token',
        waitUntilReady: vi.fn().mockResolvedValue({ type: 'runtime_ready' }),
      })),
      send: vi.fn(() => true),
      unregisterSession: vi.fn(() => true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new BrowserRuntimeService({
      yeaftDir: tempRoot(),
      config: { enabled: true, maxSessions: 1 },
      probe: vi.fn().mockResolvedValue({ ok: true, captureMode: 'tab', buildId: 'test' }),
      bridge,
      launchSession: vi.fn().mockResolvedValue({
        page,
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        captureMode: 'tab',
        close: closeSession,
      }),
      send: vi.fn(() => 'sent'),
      platform: 'linux',
    });
    expect(runtime.capabilities()).toEqual([]);
    await expect(runtime.startupProbe()).resolves.toMatchObject({ ok: true });
    expect(runtime.capabilities()).toEqual(['browser_runtime', 'browser_webrtc', 'browser_capture_tab']);
    const identity = {
      ownerUserId: 'owner-1', clientId: 'client-1',
      webConnectionId: 'connection-1', webConnectionGeneration: 'generation-1',
    };
    const created = await runtime.createSession({
      requestId: 'request-1', serverIdentity: identity, options: { initialUrl: 'about:blank' },
    });
    expect(created).toMatchObject({ type: 'browser_session_created', state: 'ready' });
    await expect(runtime.createSession({
      requestId: 'request-2', serverIdentity: identity, options: { initialUrl: 'about:blank' },
    })).rejects.toMatchObject({ code: 'browser_session_limit' });
    await runtime.handleTransportDisconnect();
    expect(closeSession).toHaveBeenCalledOnce();
    expect(runtime.snapshot()).toMatchObject({ activeSessions: 0 });
    await runtime.shutdown();
    expect(runtime.snapshot()).toMatchObject({ state: 'closed', activeSessions: 0 });
  });

  it('rejects local and privileged initial URLs even when a Server command bypasses validation', async () => {
    const runtime = new BrowserRuntimeService({
      yeaftDir: tempRoot(), config: { enabled: true }, platform: 'linux',
      probe: vi.fn().mockResolvedValue({ ok: true, captureMode: 'tab' }),
      bridge: { close: vi.fn() }, launchSession: vi.fn(), send: vi.fn(),
    });
    await runtime.startupProbe();
    await expect(runtime.createSession({
      requestId: 'file-create',
      serverIdentity: {
        ownerUserId: 'owner-1', clientId: 'client-1',
        webConnectionId: 'connection-1', webConnectionGeneration: 'generation-1',
      },
      options: { initialUrl: 'file:///etc/passwd' },
    })).rejects.toMatchObject({ code: 'browser_url_invalid' });
    await runtime.shutdown();
  });

  it('keeps Browser Session ownership immutable and fences peer operations to the exact Web connection', async () => {
    let bridgeHandlers;
    const page = Object.assign(new EventEmitter(), {
      url: vi.fn(() => 'about:blank'), title: vi.fn().mockResolvedValue(''), mainFrame: vi.fn(() => null),
    });
    const bridge = {
      registerSession: vi.fn(async (_id, handlers) => {
        bridgeHandlers = handlers;
        return {
          bridgeUrl: 'ws://127.0.0.1:1/browser-runtime/token',
          waitUntilReady: vi.fn().mockResolvedValue({ type: 'runtime_ready' }),
        };
      }),
      send: vi.fn(() => true), unregisterSession: vi.fn(() => true), close: vi.fn(),
    };
    const runtime = new BrowserRuntimeService({
      yeaftDir: tempRoot(), config: { enabled: true }, platform: 'linux', bridge,
      probe: vi.fn().mockResolvedValue({ ok: true, captureMode: 'tab' }),
      launchSession: vi.fn().mockResolvedValue({
        page, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, captureMode: 'tab', close: vi.fn(),
      }),
      send: vi.fn(() => 'sent'),
    });
    await runtime.startupProbe();
    const owner = {
      ownerUserId: 'owner-1', clientId: 'client-a',
      webConnectionId: 'connection-a', webConnectionGeneration: 'web-generation-a',
    };
    const created = await runtime.createSession({ requestId: 'create-a', serverIdentity: owner });
    await expect(runtime.preparePeer({
      browserSessionId: created.browserSessionId,
      peerId: 'peer-wrong-owner', connectionGeneration: 1,
      serverIdentity: { ...owner, ownerUserId: 'owner-2' },
    })).rejects.toMatchObject({ code: 'browser_owner_mismatch' });

    await runtime.preparePeer({
      browserSessionId: created.browserSessionId,
      peerId: 'peer-a', connectionGeneration: 1,
      serverIdentity: owner,
    });
    bridgeHandlers.onMessage({
      type: 'peer_prepared', browserSessionId: created.browserSessionId,
      peerId: 'peer-a', connectionGeneration: 1,
    });
    expect(() => runtime.answerPeer({
      browserSessionId: created.browserSessionId,
      peerId: 'peer-a', connectionGeneration: 1,
      description: { type: 'answer', sdp: 'v=0' },
      serverIdentity: { ...owner, clientId: 'client-b' },
    })).toThrowError(expect.objectContaining({ code: 'browser_peer_owner_mismatch' }));
    runtime.answerPeer({
      browserSessionId: created.browserSessionId,
      peerId: 'peer-a', connectionGeneration: 1,
      description: { type: 'answer', sdp: 'v=0' }, serverIdentity: owner,
    });
    expect(bridge.send).toHaveBeenLastCalledWith(created.browserSessionId, expect.objectContaining({
      type: 'peer_answer', peerId: 'peer-a', connectionGeneration: 1,
    }));
    bridgeHandlers.onMessage({
      type: 'peer_state', browserSessionId: created.browserSessionId,
      peerId: 'peer-a', connectionGeneration: 1, state: 'connected',
    });
    bridgeHandlers.onMessage({
      type: 'peer_state', browserSessionId: created.browserSessionId,
      peerId: 'peer-a', connectionGeneration: 1, state: 'failed',
    });
    await vi.waitFor(() => expect(bridge.send).toHaveBeenCalledWith(
      created.browserSessionId,
      expect.objectContaining({ type: 'peer_close', reason: 'peer_failed' }),
    ));
    await runtime.shutdown();
  });

  it('contains peer errors to the exact peer generation without closing single or multi-viewer Sessions', async () => {
    let bridgeHandlers;
    const page = Object.assign(new EventEmitter(), {
      url: vi.fn(() => 'about:blank'), title: vi.fn().mockResolvedValue(''), mainFrame: vi.fn(() => null),
    });
    const bridge = {
      registerSession: vi.fn(async (_id, handlers) => {
        bridgeHandlers = handlers;
        return {
          bridgeUrl: 'ws://127.0.0.1:1/browser-runtime/token',
          waitUntilReady: vi.fn().mockResolvedValue({ type: 'runtime_ready' }),
        };
      }),
      send: vi.fn(() => true), unregisterSession: vi.fn(() => true), close: vi.fn(),
    };
    const send = vi.fn(() => 'sent');
    const runtime = new BrowserRuntimeService({
      yeaftDir: tempRoot(), config: { enabled: true, maxPeersPerSession: 2 }, platform: 'linux', bridge, send,
      probe: vi.fn().mockResolvedValue({ ok: true, captureMode: 'tab' }),
      launchSession: vi.fn().mockResolvedValue({
        page, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, captureMode: 'tab', close: vi.fn(),
      }),
    });
    await runtime.startupProbe();
    const owner = {
      ownerUserId: 'owner-1', clientId: 'client-a',
      webConnectionId: 'connection-a', webConnectionGeneration: 'web-generation-a',
    };
    const created = await runtime.createSession({ requestId: 'create-peer-errors', serverIdentity: owner });
    await runtime.preparePeer({
      browserSessionId: created.browserSessionId, peerId: 'peer-a', connectionGeneration: 1, serverIdentity: owner,
    });
    await runtime.preparePeer({
      browserSessionId: created.browserSessionId, peerId: 'peer-b', connectionGeneration: 2, serverIdentity: owner,
    });

    bridgeHandlers.onMessage({
      type: 'peer_error', peerId: 'peer-a', connectionGeneration: 1,
      code: `peer_${'x'.repeat(200)}`, safeError: `failure ${'y'.repeat(800)}`,
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'browser_peer_error', browserSessionId: created.browserSessionId,
      peerId: 'peer-a', connectionGeneration: 1,
    })));
    const firstError = send.mock.calls.find(([message]) => message.type === 'browser_peer_error')[0];
    expect(firstError.code).toHaveLength(128);
    expect(firstError.safeError).toHaveLength(500);
    expect(runtime.sessions.get(created.browserSessionId)?.peers.has('peer-a')).toBe(false);
    expect(runtime.sessions.get(created.browserSessionId)?.peers.has('peer-b')).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ activeSessions: 1 });
    expect(bridge.unregisterSession).not.toHaveBeenCalled();

    await runtime.preparePeer({
      browserSessionId: created.browserSessionId, peerId: 'peer-a', connectionGeneration: 3, serverIdentity: owner,
    });
    send.mockClear();
    bridge.send.mockClear();
    bridgeHandlers.onMessage({
      type: 'peer_error', peerId: 'peer-a', connectionGeneration: 1,
      code: 'late_old_peer_failure', safeError: 'late old peer failure',
    });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_peer_error' }));
    expect(bridge.send).not.toHaveBeenCalledWith(created.browserSessionId, expect.objectContaining({
      type: 'peer_close', peerId: 'peer-a', connectionGeneration: 1,
    }));
    expect(runtime.sessions.get(created.browserSessionId)?.peers.get('peer-a'))
      .toMatchObject({ connectionGeneration: 3 });

    bridgeHandlers.onMessage({
      type: 'peer_error', peerId: 'peer-a', connectionGeneration: 3,
      code: 'replacement_failed', safeError: 'replacement failed',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'browser_peer_error', peerId: 'peer-a', connectionGeneration: 3,
    })));
    expect(runtime.sessions.get(created.browserSessionId)?.peers.has('peer-b')).toBe(true);
    bridgeHandlers.onMessage({
      type: 'peer_error', peerId: 'peer-b', connectionGeneration: 2,
      code: 'last_viewer_failed', safeError: 'last viewer failed',
    });
    await vi.waitFor(() => expect(runtime.sessions.get(created.browserSessionId)?.peers.size).toBe(0));
    expect(runtime.snapshot()).toMatchObject({ activeSessions: 1 });
    expect(bridge.unregisterSession).not.toHaveBeenCalled();

    bridgeHandlers.onMessage({ type: 'capture_ended' });
    await vi.waitFor(() => expect(runtime.snapshot()).toMatchObject({ activeSessions: 0 }));
    expect(bridge.unregisterSession).toHaveBeenCalledWith(created.browserSessionId, 'capture_ended');
    await runtime.shutdown();
  });

  it('cancels an in-flight Session launch on transport disconnect and closes a late runtime', async () => {
    let resolveLaunch;
    let observedSignal;
    const close = vi.fn().mockResolvedValue(undefined);
    const page = Object.assign(new EventEmitter(), {
      url: vi.fn(() => 'about:blank'), title: vi.fn().mockResolvedValue(''), mainFrame: vi.fn(() => null),
    });
    const bridge = {
      registerSession: vi.fn(async () => ({
        bridgeUrl: 'ws://127.0.0.1:1/browser-runtime/token',
        waitUntilReady: vi.fn().mockResolvedValue({ type: 'runtime_ready' }),
      })),
      send: vi.fn(() => true), unregisterSession: vi.fn(() => true), close: vi.fn(),
    };
    const send = vi.fn(() => 'sent');
    const runtime = new BrowserRuntimeService({
      yeaftDir: tempRoot(), config: { enabled: true }, platform: 'linux', bridge, send,
      probe: vi.fn().mockResolvedValue({ ok: true, captureMode: 'tab' }),
      launchSession: vi.fn(({ signal }) => {
        observedSignal = signal;
        return new Promise(resolve => { resolveLaunch = resolve; });
      }),
    });
    await runtime.startupProbe();
    const create = runtime.createSession({
      requestId: 'late-create',
      serverIdentity: {
        ownerUserId: 'owner-1', clientId: 'client-1',
        webConnectionId: 'connection-1', webConnectionGeneration: 'generation-1',
      },
    });
    await vi.waitFor(() => expect(resolveLaunch).toBeTypeOf('function'));
    const cleanup = runtime.handleTransportDisconnect();
    expect(observedSignal.aborted).toBe(true);
    resolveLaunch({
      page, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, captureMode: 'tab', close,
    });
    await cleanup;
    await expect(create).rejects.toMatchObject({ code: 'browser_session_cancelled' });
    expect(close).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_session_created' }));
    expect(runtime.snapshot()).toMatchObject({ activeSessions: 0 });
    await runtime.shutdown();
  });

  it('aborts and awaits an in-flight startup probe during shutdown', async () => {
    let observedSignal;
    const probe = vi.fn(({ signal }) => {
      observedSignal = signal;
      return new Promise(resolve => signal.addEventListener('abort', () => resolve({
        ok: false,
        code: 'browser_runtime_shutdown',
      }), { once: true }));
    });
    const runtime = new BrowserRuntimeService({ yeaftDir: tempRoot(), config: { enabled: true }, probe });
    const startup = runtime.startupProbe();
    await runtime.shutdown();
    await startup;
    expect(observedSignal.aborted).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ state: 'closed', activeSessions: 0 });
  });

  it('coalesces concurrent probes and fails closed on probe failure', async () => {
    let resolveProbe;
    const probe = vi.fn(() => new Promise(resolve => { resolveProbe = resolve; }));
    const runtime = new BrowserRuntimeService({ yeaftDir: tempRoot(), config: { enabled: true }, probe });
    const first = runtime.startupProbe();
    const second = runtime.startupProbe();
    expect(probe).toHaveBeenCalledTimes(1);
    resolveProbe({ ok: false, code: 'media_probe_failed' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: false }),
      expect.objectContaining({ ok: false }),
    ]);
    expect(runtime.ready).toBe(false);
    expect(runtime.capabilities()).toEqual([]);
  });
});

describe('Browser Runtime extension package', () => {
  it('has a pinned LF content digest and includes the complete offscreen endpoint', async () => {
    const manifest = JSON.parse(readFileSync(new URL(
      '../../agent/browser-runtime/extension/manifest.json',
      import.meta.url,
    ), 'utf8'));
    expect(manifest.permissions).not.toContain('tabs');
    const first = await hashBrowserExtension(undefined, { expectedDigest: BROWSER_EXTENSION_SHA256 });
    const second = await hashBrowserExtension();
    expect(first.digest).toBe(BROWSER_EXTENSION_SHA256);
    expect(first).toEqual(second);
    expect(first.fileCount).toBeGreaterThanOrEqual(6);

    const attributes = spawnSync('git', [
      'check-attr',
      'eol',
      '--',
      'agent/browser-runtime/extension/manifest.json',
      'agent/browser-runtime/extension/service-worker.js',
    ], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' });
    expect(attributes.status).toBe(0);
    expect(attributes.stdout).toContain('manifest.json: eol: lf');
    expect(attributes.stdout).toContain('service-worker.js: eol: lf');
  });

  it('keeps actual offscreen peers independent while sharing one Session capture stream', async () => {
    const sockets = [];
    const connections = [];
    let runtimeListener;
    const track = {
      stop: vi.fn(),
      addEventListener: vi.fn(),
      getSettings: vi.fn(() => ({ width: 1280, height: 720, frameRate: 30 })),
    };
    const stream = {
      getVideoTracks: vi.fn(() => [track]),
      getTracks: vi.fn(() => [track]),
    };
    const getUserMedia = vi.fn(async () => stream);
    class FakeWebSocket {
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        this.closed = false;
        sockets.push(this);
      }
      send(payload) { this.sent.push(JSON.parse(payload)); }
      close() { this.closed = true; this.readyState = 3; }
    }
    class FakePeerConnection {
      constructor(config) {
        this.config = config;
        this.closed = false;
        this.connectionState = 'new';
        this.localDescription = null;
        this.remoteDescription = null;
        this.addedCandidates = [];
        this.sender = {
          getParameters: vi.fn(() => ({ encodings: [{}] })),
          setParameters: vi.fn(async () => {}),
        };
        this.transceiver = { sender: this.sender, setCodecPreferences: vi.fn() };
        connections.push(this);
      }
      addTrack() { return this.sender; }
      getTransceivers() { return [this.transceiver]; }
      async createOffer() { return { type: 'offer', sdp: `offer-${connections.indexOf(this) + 1}` }; }
      async setLocalDescription(description) { this.localDescription = description; }
      async setRemoteDescription(description) { this.remoteDescription = description; }
      async addIceCandidate(candidate) {
        if (candidate?.candidate === 'candidate-failure') throw new Error('candidate failure');
        this.addedCandidates.push(candidate);
      }
      close() { this.closed = true; this.connectionState = 'closed'; }
    }
    const source = readFileSync(new URL(
      '../../agent/browser-runtime/extension/offscreen.js',
      import.meta.url,
    ), 'utf8');
    runInNewContext(source, {
      chrome: { runtime: { onMessage: { addListener: listener => { runtimeListener = listener; } } } },
      navigator: { mediaDevices: { getUserMedia } },
      document: { querySelector: vi.fn(() => ({ srcObject: null, play: vi.fn(async () => {}) })) },
      RTCPeerConnection: FakePeerConnection,
      RTCRtpSender: { getCapabilities: vi.fn(() => ({ codecs: [{ mimeType: 'video/VP8' }] })) },
      MediaStream: class MediaStream {},
      WebSocket: FakeWebSocket,
      setTimeout,
      clearTimeout,
      console,
    }, { filename: 'browser-runtime-offscreen.js' });
    expect(runtimeListener).toBeTypeOf('function');
    const start = new Promise(resolve => runtimeListener({
      target: 'browser_runtime_offscreen',
      type: 'browser_runtime_start',
      browserSessionId: 'browser-session-a',
      bridgeUrl: 'ws://127.0.0.1/browser-runtime/token',
      streamId: 'stream-a',
    }, null, resolve));
    await expect(start).resolves.toEqual({ ok: true });
    expect(getUserMedia).toHaveBeenCalledOnce();
    const socket = sockets[0];
    const receive = message => socket.onmessage({
      data: JSON.stringify({ browserSessionId: 'browser-session-a', ...message }),
    });

    receive({ type: 'peer_prepare', peerId: 'peer-a', connectionGeneration: 1 });
    await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'peer_offer', peerId: 'peer-a', connectionGeneration: 1,
    })));
    receive({ type: 'peer_prepare', peerId: 'peer-b', connectionGeneration: 2 });
    await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'peer_offer', peerId: 'peer-b', connectionGeneration: 2,
    })));
    expect(connections).toHaveLength(2);
    expect(connections[0].closed).toBe(false);
    expect(connections[1].closed).toBe(false);
    receive({ type: 'peer_prepare', peerId: 'peer-b', connectionGeneration: 2 });
    await Promise.resolve();
    expect(connections).toHaveLength(2);
    expect(connections[1].closed).toBe(false);

    receive({
      type: 'peer_ice_candidate', peerId: 'peer-a', connectionGeneration: 1,
      candidate: { candidate: 'candidate-a' },
    });
    receive({
      type: 'peer_ice_candidate', peerId: 'peer-b', connectionGeneration: 2,
      candidate: { candidate: 'candidate-b' },
    });
    receive({
      type: 'peer_answer', peerId: 'peer-a', connectionGeneration: 1,
      description: { type: 'answer', sdp: 'answer-a' },
    });
    receive({
      type: 'peer_answer', peerId: 'peer-b', connectionGeneration: 2,
      description: { type: 'answer', sdp: 'answer-b' },
    });
    await vi.waitFor(() => {
      expect(connections[0].remoteDescription?.sdp).toBe('answer-a');
      expect(connections[1].remoteDescription?.sdp).toBe('answer-b');
      expect(connections[0].addedCandidates.map(candidate => candidate.candidate)).toEqual(['candidate-a']);
      expect(connections[1].addedCandidates.map(candidate => candidate.candidate)).toEqual(['candidate-b']);
    });

    receive({
      type: 'peer_ice_candidate', peerId: 'peer-a', connectionGeneration: 1,
      candidate: { candidate: 'candidate-failure' },
    });
    await vi.waitFor(() => {
      expect(connections[0].closed).toBe(true);
      expect(socket.sent).toContainEqual(expect.objectContaining({
        type: 'peer_error', peerId: 'peer-a', connectionGeneration: 1,
      }));
    });
    expect(connections[1].closed).toBe(false);

    receive({ type: 'peer_prepare', peerId: 'peer-a', connectionGeneration: 3 });
    await vi.waitFor(() => expect(connections).toHaveLength(3));
    expect(connections[1].closed).toBe(false);
    receive({
      type: 'peer_answer', peerId: 'peer-a', connectionGeneration: 1,
      description: { type: 'answer', sdp: 'stale-answer-a' },
    });
    await Promise.resolve();
    expect(connections[2].remoteDescription).toBeNull();
    receive({
      type: 'peer_answer', peerId: 'peer-a', connectionGeneration: 3,
      description: { type: 'answer', sdp: 'replacement-answer-a' },
    });
    await vi.waitFor(() => expect(connections[2].remoteDescription?.sdp).toBe('replacement-answer-a'));
    receive({ type: 'peer_close', peerId: 'peer-b', connectionGeneration: 2 });
    await vi.waitFor(() => expect(connections[1].closed).toBe(true));
    expect(connections[2].closed).toBe(false);

    receive({ type: 'session_close' });
    await vi.waitFor(() => {
      expect(connections[2].closed).toBe(true);
      expect(track.stop).toHaveBeenCalledOnce();
      expect(socket.closed).toBe(true);
    });
    socket.onclose();
    receive({ type: 'peer_prepare', peerId: 'late-peer', connectionGeneration: 4 });
    await Promise.resolve();
    expect(connections).toHaveLength(3);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('retries only the extension storage read while MV3 APIs finish attaching', async () => {
    let reads = 0;
    const worker = {
      evaluate: vi.fn(async callback => {
        reads += 1;
        if (reads === 1) return null;
        return { browserRuntimeProbe: { ok: true, framesDecoded: 1 } };
      }),
    };
    const close = vi.fn().mockResolvedValue(undefined);
    const triggerExtensionAction = vi.fn().mockResolvedValue(undefined);
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      triggerExtensionAction,
    };
    const browser = {
      version: vi.fn().mockResolvedValue('Chrome/151.0.7922.71'),
      newPage: vi.fn().mockResolvedValue(page),
      extensions: vi.fn().mockResolvedValue(new Map([[
        'extension-id',
        { id: 'extension-id', name: 'Yeaft Browser Runtime' },
      ]])),
      waitForTarget: vi.fn().mockResolvedValue({ worker: vi.fn().mockResolvedValue(worker) }),
      close,
    };
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result).toMatchObject({ ok: true, framesDecoded: 1 });
    expect(worker.evaluate).toHaveBeenCalledTimes(2);
    expect(triggerExtensionAction).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed before launch when the extension digest does not match', async () => {
    const launch = vi.fn();
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      expectedExtensionDigest: '0'.repeat(64),
      launch,
    });
    expect(result).toMatchObject({ ok: false, code: 'extension_digest_mismatch' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects a mismatched Chrome build before any extension-bearing launch', async () => {
    const launch = vi.fn();
    const versionCheck = vi.fn().mockResolvedValue('Google Chrome 150.0.7871.24');
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      launch,
      versionCheck,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'browser_version_mismatch',
      expectedBuildId: '151.0.7922.71',
      actualBuildId: '150.0.7871.24',
    });
    expect(versionCheck).toHaveBeenCalledWith(process.execPath, expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(launch).not.toHaveBeenCalled();
  });

  it('enforces one cumulative deadline across otherwise successful stages', async () => {
    const slow = async value => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return value;
    };
    const browser = {
      version: vi.fn(() => slow('Chrome/151.0.7922.71')),
      newPage: vi.fn(() => slow({
        goto: vi.fn(() => slow(undefined)),
        triggerExtensionAction: vi.fn(),
      })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const startedAt = Date.now();
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      timeoutMs: 70,
      resolveExecutable: () => slow(process.execPath),
      hashExtension: () => slow({ digest: 'test', fileCount: 1 }),
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.code).toMatch(/_timeout$/);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('returns within the same total deadline when Browser close never settles', async () => {
    const browser = {
      version: vi.fn().mockResolvedValue('Chrome/151.0.7922.71'),
      newPage: vi.fn().mockRejectedValue(new Error('synthetic probe failure')),
      close: vi.fn(() => new Promise(() => {})),
      process: vi.fn(() => null),
    };
    const startedAt = Date.now();
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      timeoutMs: 50,
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result).toMatchObject({ ok: false });
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('does not spend cleanup grace after the probe deadline is already exhausted', async () => {
    const close = vi.fn(() => new Promise(() => {}));
    const browser = {
      newPage: vi.fn().mockResolvedValue({ goto: vi.fn().mockResolvedValue(undefined) }),
      extensions: vi.fn(() => new Promise(() => {})),
      close,
      process: vi.fn(() => ({ pid: 999_999, exitCode: null, killed: false, kill: vi.fn() })),
    };
    const startedAt = Date.now();
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      timeoutMs: 40,
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(120);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps profile cleanup inside the total deadline when removal never settles', async () => {
    const profileParent = tempRoot();
    const removeProfile = vi.fn(() => new Promise(() => {}));
    const browser = {
      newPage: vi.fn().mockRejectedValue(new Error('synthetic probe failure')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const startedAt = Date.now();
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      timeoutMs: 50,
      profileParent,
      createProfile: async prefix => {
        const path = `${prefix}hung-cleanup`;
        mkdirSync(path);
        return path;
      },
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      launch: vi.fn().mockResolvedValue(browser),
      removeProfile,
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(removeProfile).toHaveBeenCalledOnce();
  });

  it('aborts a non-settling executable version check at the total deadline', async () => {
    let observedSignal;
    const launch = vi.fn();
    const versionCheck = vi.fn((_path, { signal }) => {
      observedSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const startedAt = Date.now();
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      timeoutMs: 40,
      versionCheck,
      launch,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toMatch(/_timeout$/);
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(observedSignal.aborted).toBe(true);
    expect(launch).not.toHaveBeenCalled();
  });

  it('settles a never-resolving CDP stage within the total timeout', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const browser = {
      version: vi.fn().mockResolvedValue('Chrome/151.0.7922.71'),
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
      }),
      extensions: vi.fn(() => new Promise(() => {})),
      close,
    };
    const startedAt = Date.now();
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      timeoutMs: 50,
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toMatch(/_timeout$/);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes a Browser handle that resolves after launch timeout', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const kill = vi.fn();
    const browser = {
      close,
      process: vi.fn(() => ({ pid: 999_999, exitCode: null, killed: false, kill })),
    };
    const launch = vi.fn(() => new Promise(resolve => setTimeout(() => resolve(browser), 70)));
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      timeoutMs: 40,
      launch,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toMatch(/_timeout$/);
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 5_000 });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('passes abort into launch and settles abort during launch', async () => {
    const controller = new AbortController();
    let launchOptions;
    const launch = vi.fn(options => {
      launchOptions = options;
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    });
    const probe = probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      timeoutMs: 1_000,
      launch,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    controller.abort(new Error('shutdown'));
    await expect(probe).resolves.toMatchObject({
      ok: false,
      code: 'browser_probe_aborted',
      safeError: 'shutdown',
    });
    expect(launchOptions.signal).not.toBe(controller.signal);
    expect(launchOptions.signal.aborted).toBe(true);
    expect(launchOptions.signal.reason).toEqual(new Error('shutdown'));
    expect(launchOptions.protocolTimeout).toBeLessThanOrEqual(1_000);
  });

  it('aborts a post-launch CDP wait and cleans the profile', async () => {
    const controller = new AbortController();
    let profileDir;
    const close = vi.fn().mockResolvedValue(undefined);
    const browser = {
      version: vi.fn().mockResolvedValue('Chrome/151.0.7922.71'),
      newPage: vi.fn().mockResolvedValue({ goto: vi.fn().mockResolvedValue(undefined) }),
      extensions: vi.fn(() => new Promise(() => {})),
      close,
    };
    const launch = vi.fn(async options => {
      profileDir = options.userDataDir;
      return browser;
    });
    const probe = probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      timeoutMs: 1_000,
      launch,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(browser.extensions).toHaveBeenCalledOnce());
    controller.abort(new Error('shutdown-after-launch'));
    const abortStartedAt = Date.now();
    await expect(probe).resolves.toMatchObject({
      ok: false,
      code: 'browser_probe_aborted',
      safeError: 'shutdown-after-launch',
    });
    expect(Date.now() - abortStartedAt).toBeLessThan(150);
    expect(close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(existsSync(profileDir)).toBe(false));
  });

  it('bounds the wait for process exit after force-kill', async () => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 999_999, exitCode: null, killed: false, kill: vi.fn() });
    const browser = {
      newPage: vi.fn().mockRejectedValue(new Error('synthetic probe failure')),
      close: vi.fn(() => new Promise(() => {})),
      process: vi.fn(() => child),
    };
    const startedAt = Date.now();
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      timeoutMs: 50,
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('force-kills when graceful Browser close never settles', async () => {
    const kill = vi.fn();
    const child = { pid: 999_999, exitCode: null, killed: false, kill };
    const browser = {
      version: vi.fn().mockRejectedValue(new Error('fail before probe')),
      close: vi.fn(() => new Promise(() => {})),
      process: vi.fn(() => child),
    };
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      timeoutMs: 1_000,
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result.ok).toBe(false);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('closes the browser and removes the temporary profile after a failed probe', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    let profileDir;
    const launch = vi.fn(async options => {
      profileDir = options.userDataDir;
      return {
        version: vi.fn().mockResolvedValue('Chrome/151.0.7922.71'),
        newPage: vi.fn().mockRejectedValue(new Error('synthetic page failure')),
        close,
      };
    });
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      versionCheck: vi.fn().mockResolvedValue('Google Chrome 151.0.7922.71'),
      launch,
    });
    expect(result).toMatchObject({ ok: false, code: 'browser_probe_failed' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(profileDir)).toThrow();
  });
});
