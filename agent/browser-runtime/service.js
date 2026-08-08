import { randomUUID } from 'node:crypto';
import { normaliseBrowserRuntimeSection } from './config.js';
import { defaultBrowserCacheDir } from './browser-install.js';
import { probeBrowserRuntime } from './probe.js';
import { BrowserRuntimeError } from './errors.js';

/**
 * Agent-local Browser Runtime lifecycle owner. Phase 0 exposes startup probe and
 * capacity semantics only; Browser Sessions remain unavailable until the later
 * owner-checked control-plane phase lands.
 */
export class BrowserRuntimeService {
  constructor({ yeaftDir, config, probe = probeBrowserRuntime } = {}) {
    if (!yeaftDir) throw new Error('yeaftDir required');
    this.yeaftDir = yeaftDir;
    this.config = normaliseBrowserRuntimeSection(config);
    this.config.cacheDir ||= defaultBrowserCacheDir(yeaftDir);
    this.probe = probe;
    this.sessions = new Map();
    this.probeResult = null;
    this.state = this.config.enabled ? 'unprobed' : 'disabled';
    this.#probePromise = null;
    this.#probeAbort = null;
    this.#shutdownPromise = null;
  }

  #probePromise;
  #probeAbort;
  #shutdownPromise;

  get enabled() { return this.config.enabled === true; }
  get ready() { return this.state === 'ready' && this.probeResult?.ok === true; }

  capabilities() {
    // Phase 0 is a local spike only. Advertising the Phase 1 feature before
    // owner-checked create/attach/signaling exists would expose a dead route.
    return [];
  }

  async startupProbe() {
    if (!this.enabled) return { ok: false, code: 'browser_runtime_disabled' };
    if (this.#probePromise) return this.#probePromise;
    this.state = 'probing';
    this.#probeAbort = new AbortController();
    this.#probePromise = this.probe({
      executablePath: this.config.executablePath,
      cacheDir: this.config.cacheDir,
      headless: this.config.headless,
      timeoutMs: this.config.startupProbeTimeoutMs,
      signal: this.#probeAbort.signal,
    }).then(result => {
      this.probeResult = Object.freeze({ ...result });
      this.state = result.ok ? 'ready' : 'unavailable';
      return this.probeResult;
    }).catch(error => {
      this.probeResult = Object.freeze({
        ok: false,
        code: error?.code || 'browser_probe_failed',
        safeError: String(error?.message || error).slice(0, 500),
      });
      this.state = 'unavailable';
      return this.probeResult;
    });
    return this.#probePromise;
  }

  assertCanCreateSession() {
    if (!this.ready) throw new BrowserRuntimeError('browser_runtime_unavailable');
    if (this.sessions.size >= this.config.maxSessions) {
      throw new BrowserRuntimeError('browser_session_limit');
    }
  }

  /** Phase 0 test hook for lifecycle/capacity ownership. */
  reserveSession(ownerUserId) {
    this.assertCanCreateSession();
    if (!ownerUserId) throw new BrowserRuntimeError('browser_owner_required');
    const browserSessionId = randomUUID();
    this.sessions.set(browserSessionId, Object.freeze({
      browserSessionId,
      ownerUserId,
      state: 'reserved',
      createdAt: Date.now(),
    }));
    return this.sessions.get(browserSessionId);
  }

  releaseSession(browserSessionId) {
    return this.sessions.delete(browserSessionId);
  }

  snapshot() {
    return Object.freeze({
      enabled: this.enabled,
      ready: this.ready,
      state: this.state,
      activeSessions: this.sessions.size,
      maxSessions: this.config.maxSessions,
      probe: this.probeResult,
    });
  }

  async shutdown() {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#probeAbort?.abort(new BrowserRuntimeError('browser_runtime_shutdown'));
    this.#shutdownPromise = Promise.resolve(this.#probePromise).catch(() => {}).then(() => {
      this.sessions.clear();
      this.state = 'closed';
    });
    return this.#shutdownPromise;
  }
}

let runtime = null;

export function getBrowserRuntime() {
  return runtime;
}

export async function bootBrowserRuntime(options) {
  if (runtime) return runtime;
  runtime = new BrowserRuntimeService(options);
  await runtime.startupProbe();
  return runtime;
}

export async function shutdownBrowserRuntime() {
  const current = runtime;
  runtime = null;
  await current?.shutdown();
}
