import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import {
  getBrowserRuntimeSettings,
  updateBrowserRuntimeSettings,
} from '../../agent/yeaft/config-api.js';

const roots = [];
function tempRoot(prefix = 'yeaft-browser-runtime-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
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

  it('creates a first-run data root and stores the normalized Browser Runtime section', () => {
    const parent = tempRoot();
    const root = join(parent, 'named-instance');
    const result = updateBrowserRuntimeSettings({ enabled: true }, root);
    expect(result).toMatchObject({ enabled: true, maxSessions: 2 });
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).browserRuntime)
      .toMatchObject({ enabled: true, maxSessions: 2 });
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
      resolveYeaftDir: vi.fn((args, _env, instanceId) => {
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
    expect(dependencies.resolveYeaftDir).toHaveBeenCalledWith(
      ['--name', 'worker-a'], dependencies.env, 'worker-a',
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
    expect(dependencies.resolveYeaftDir).toHaveBeenCalledWith(
      ['--instance', 'legacy-worker', '--yeaft-dir', '/custom/worker'],
      dependencies.env,
      'legacy-worker',
    );
    expect(dependencies.configApi.updateBrowserRuntimeSettings)
      .toHaveBeenCalledWith({ enabled: true }, '/custom/worker');
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

  it('closes the browser and removes the temporary profile after a failed probe', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    let profileDir;
    const launch = vi.fn(async options => {
      profileDir = options.userDataDir;
      return {
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
