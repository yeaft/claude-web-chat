import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { generateSystemdUnit } from '../../agent/service/linux.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRuntimeService } from '../../agent/browser-runtime/service.js';
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
import {
  getBrowserRuntimeSettings,
  updateBrowserRuntimeSettings,
} from '../../agent/yeaft/config-api.js';
import {
  BROWSER_RUNTIME_CHROME_ARCHIVES,
  BROWSER_RUNTIME_CHROME_BUILD,
  findManagedBrowser,
  installManagedBrowser,
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

  it('preserves a tighter existing config mode across Browser updates', () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{}', { mode: 0o600 });
    chmodSync(configPath, 0o600);
    expect(updateBrowserRuntimeSettings({ enabled: true }, root).error).toBeUndefined();
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
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

  it('serializes Browser, plugin, and telemetry writes across processes', async () => {
    const root = tempRoot();
    const barrier = tempRoot('yeaft-config-barrier-');
    const startPath = join(barrier, 'start');
    const helper = new URL('../helpers/config-transaction-child.mjs', import.meta.url);
    const operations = ['browser', 'plugins', 'telemetry'];
    const children = operations.map((operation, index) => spawn(process.execPath, [
      helper.pathname,
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

    const result = await installManagedBrowser({
      cacheDir,
      fetchFn: vi.fn().mockResolvedValue(archiveResponse(archive)),
      dependencies,
    });
    expect(result.status).toBe('installed');
    expect(existsSync(lockDir)).toBe(false);
    expect(existsSync(orphanedStaging)).toBe(false);
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
    let publishedExecutable = null;
    dependencies.browsers.getInstalledBrowsers.mockImplementation(async () => (
      publishedExecutable ? [{
        browser: 'chrome',
        buildId: BROWSER_RUNTIME_CHROME_BUILD,
        platform: 'linux',
        executablePath: publishedExecutable,
      }] : []
    ));
    const fetchFn = vi.fn().mockImplementation(async () => archiveResponse(archive));
    const first = installManagedBrowser({ cacheDir, fetchFn, dependencies }).then(result => {
      publishedExecutable = result.executablePath;
      return result;
    });
    const second = installManagedBrowser({ cacheDir, fetchFn, dependencies });
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.status).sort()).toEqual(['available', 'installed']);
    expect(dependencies.install).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce();
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
  it('does not run a probe while disabled', async () => {
    const probe = vi.fn();
    const runtime = new BrowserRuntimeService({ yeaftDir: tempRoot(), config: {}, probe });
    await expect(runtime.startupProbe()).resolves.toEqual({ ok: false, code: 'browser_runtime_disabled' });
    expect(probe).not.toHaveBeenCalled();
    expect(runtime.capabilities()).toEqual([]);
  });

  it('keeps Phase 0 unadvertised after a successful probe and enforces capacity', async () => {
    const runtime = new BrowserRuntimeService({
      yeaftDir: tempRoot(),
      config: { enabled: true, maxSessions: 1 },
      probe: vi.fn().mockResolvedValue({ ok: true, captureMode: 'tab', buildId: 'test' }),
    });
    expect(runtime.capabilities()).toEqual([]);
    await expect(runtime.startupProbe()).resolves.toMatchObject({ ok: true });
    expect(runtime.ready).toBe(true);
    expect(runtime.capabilities()).toEqual([]);
    const reservation = runtime.reserveSession('owner-1');
    expect(reservation.ownerUserId).toBe('owner-1');
    expect(() => runtime.reserveSession('owner-1')).toThrowError(expect.objectContaining({ code: 'browser_session_limit' }));
    expect(runtime.releaseSession(reservation.browserSessionId)).toBe(true);
    await runtime.shutdown();
    expect(runtime.snapshot()).toMatchObject({ state: 'closed', activeSessions: 0 });
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
  it('has a pinned content digest and includes the complete offscreen endpoint', async () => {
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
      expectedExtensionDigest: '0'.repeat(64),
      launch,
    });
    expect(result).toMatchObject({ ok: false, code: 'extension_digest_mismatch' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects a mismatched Chrome build before creating a page or triggering the extension', async () => {
    const browser = {
      version: vi.fn().mockResolvedValue('Chrome/150.0.7871.24'),
      newPage: vi.fn(),
      extensions: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'browser_version_mismatch',
      expectedBuildId: '151.0.7922.71',
      actualBuildId: '150.0.7871.24',
    });
    expect(browser.newPage).not.toHaveBeenCalled();
    expect(browser.extensions).not.toHaveBeenCalled();
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
      timeoutMs: 70,
      resolveExecutable: () => slow(process.execPath),
      hashExtension: () => slow({ digest: 'test', fileCount: 1 }),
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result).toMatchObject({ ok: false });
    expect(['browser_probe_timeout', 'browser_version_timeout']).toContain(result.code);
    expect(Date.now() - startedAt).toBeLessThan(250);
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
      timeoutMs: 50,
      launch: vi.fn().mockResolvedValue(browser),
    });
    expect(result).toMatchObject({ ok: false, code: 'extension_list_timeout' });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes a Browser handle that resolves after launch timeout', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const browser = { close };
    const launch = vi.fn(() => new Promise(resolve => setTimeout(() => resolve(browser), 70)));
    const result = await probeBrowserRuntime({
      executablePath: process.execPath,
      cacheDir: tempRoot(),
      timeoutMs: 40,
      launch,
    });
    expect(result).toMatchObject({ ok: false, code: 'browser_launch_timeout' });
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
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
      timeoutMs: 1_000,
      launch,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    controller.abort(new Error('shutdown'));
    await expect(probe).resolves.toMatchObject({ ok: false, safeError: 'shutdown' });
    expect(launchOptions.signal).toBe(controller.signal);
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
      timeoutMs: 1_000,
      launch,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(browser.extensions).toHaveBeenCalledOnce());
    controller.abort(new Error('shutdown-after-launch'));
    await expect(probe).resolves.toMatchObject({ ok: false, safeError: 'shutdown-after-launch' });
    expect(close).toHaveBeenCalledOnce();
    expect(existsSync(profileDir)).toBe(false);
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
      launch,
    });
    expect(result).toMatchObject({ ok: false, code: 'browser_probe_failed' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(profileDir)).toThrow();
  });
});
