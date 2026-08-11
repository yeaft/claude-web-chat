import { createHash, randomUUID } from 'node:crypto';
import { normaliseBrowserRuntimeSection } from './config.js';
import {
  defaultBrowserCacheDir,
  installManagedBrowser,
  managedBrowserDownloadInfo,
  resolveBrowserExecutable,
} from './browser-install.js';
import { probeBrowserRuntime } from './probe.js';
import { BrowserRuntimeError } from './errors.js';
import { BrowserExtensionBridge } from './local-bridge.js';
import { launchBrowserSession } from './chromium.js';
import { ProducerSequenceState } from './protocol.js';

const REQUEST_TTL_MS = 10 * 60_000;
const MAX_INSTALL_PROGRESS_LISTENERS = 8;

function clean(value, max = 512) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safeInitialUrl(value) {
  const raw = clean(value, 4096) || 'about:blank';
  if (raw === 'about:blank') return raw;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new BrowserRuntimeError('browser_url_invalid');
    }
    return url.href;
  } catch (error) {
    if (error instanceof BrowserRuntimeError) throw error;
    throw new BrowserRuntimeError('browser_url_invalid');
  }
}

function stableDigest(value) {
  return createHash('sha256').update(JSON.stringify(value || null)).digest('hex');
}

function normalizeIdentity(value) {
  const identity = value && typeof value === 'object' ? value : {};
  const result = Object.freeze({
    ownerUserId: clean(identity.ownerUserId),
    clientId: clean(identity.clientId),
    webConnectionId: clean(identity.webConnectionId),
    webConnectionGeneration: clean(identity.webConnectionGeneration),
  });
  if (!result.ownerUserId || !result.clientId || !result.webConnectionId || !result.webConnectionGeneration) {
    throw new BrowserRuntimeError('browser_identity_required');
  }
  return result;
}

function sameOwner(a, b) {
  return a?.ownerUserId === b?.ownerUserId;
}

function sameConnection(a, b) {
  return sameOwner(a, b)
    && a?.clientId === b?.clientId
    && a?.webConnectionId === b?.webConnectionId
    && a?.webConnectionGeneration === b?.webConnectionGeneration;
}

function publicIceServers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(server => ({
    urls: Array.isArray(server?.urls)
      ? server.urls.slice(0, 8).map(url => clean(url, 2048)).filter(Boolean)
      : clean(server?.urls, 2048),
    ...(clean(server?.username, 512) ? { username: clean(server.username, 512) } : {}),
    ...(clean(server?.credential, 1024) ? { credential: clean(server.credential, 1024) } : {}),
  })).filter(server => Array.isArray(server.urls) ? server.urls.length > 0 : !!server.urls);
}

function sourceRef(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = ['yeaft-session', 'chat-conversation', 'work-item'].includes(value.kind) ? value.kind : null;
  if (!kind) return null;
  return Object.freeze({
    kind,
    ...(clean(value.sessionId) ? { sessionId: clean(value.sessionId) } : {}),
    ...(clean(value.conversationId) ? { conversationId: clean(value.conversationId) } : {}),
    ...(clean(value.workItemId) ? { workItemId: clean(value.workItemId) } : {}),
  });
}

/** Agent-local owner for Browser Session, Chromium and WebRTC peer lifecycles. */
export class BrowserRuntimeService {
  constructor({
    yeaftDir,
    config,
    probe = probeBrowserRuntime,
    resolveBrowser = resolveBrowserExecutable,
    installBrowser = installManagedBrowser,
    downloadInfo = managedBrowserDownloadInfo,
    saveSettings = null,
    onCapabilitiesChanged = null,
    bridge = new BrowserExtensionBridge(),
    launchSession = launchBrowserSession,
    send = null,
    platform = process.platform,
    arch = process.arch,
  } = {}) {
    if (!yeaftDir) throw new Error('yeaftDir required');
    this.yeaftDir = yeaftDir;
    this.config = normaliseBrowserRuntimeSection(config);
    this.config.cacheDir ||= defaultBrowserCacheDir(yeaftDir);
    this.probe = probe;
    this.resolveBrowser = resolveBrowser;
    this.installBrowser = installBrowser;
    this.downloadInfo = downloadInfo;
    this.saveSettings = typeof saveSettings === 'function' ? saveSettings : null;
    this.onCapabilitiesChanged = typeof onCapabilitiesChanged === 'function' ? onCapabilitiesChanged : null;
    this.bridge = bridge;
    this.launchSession = launchSession;
    this.send = typeof send === 'function' ? send : () => 'dropped';
    this.platform = platform;
    this.arch = arch;
    const download = this.downloadInfo({ platform, arch });
    this.setupInfo = Object.freeze({
      ...download,
      // Phase 1 advertises only the real Linux tab-capture data plane. The CLI
      // may manage pinned binaries on more platforms, but Web must not offer an
      // install that can never produce a ready capability.
      supported: download.supported === true && platform === 'linux' && arch === 'x64',
    });
    this.sessions = new Map();
    this.requests = new Map();
    this.probeResult = null;
    this.installProgress = null;
    this.lastSetupError = null;
    this.state = this.config.enabled ? 'unprobed' : 'disabled';
    this.#probePromise = null;
    this.#probeAbort = null;
    this.#installPromise = null;
    this.#installAbort = null;
    this.#installListeners = new Set();
    this.#lastInstallProgressAt = 0;
    this.#shutdownPromise = null;
  }

  #probePromise;
  #probeAbort;
  #installPromise;
  #installAbort;
  #installListeners;
  #lastInstallProgressAt;
  #shutdownPromise;

  get enabled() { return this.config.enabled === true; }
  get ready() { return this.state === 'ready' && this.probeResult?.ok === true; }

  setupCapabilities() {
    return this.setupInfo.supported ? ['browser_runtime_setup'] : [];
  }

  capabilities() {
    if (!this.ready || this.platform !== 'linux' || this.probeResult?.captureMode !== 'tab') return [];
    return ['browser_runtime', 'browser_webrtc', 'browser_capture_tab'];
  }

  async #notifyCapabilitiesChanged() {
    try {
      await this.onCapabilitiesChanged?.();
    } catch (error) {
      console.warn(`[BrowserRuntime] capability refresh failed: ${error?.message || error}`);
    }
  }

  async #persistEnabled({ managed = false } = {}) {
    const update = {
      enabled: true,
      ...(managed ? { executablePath: null } : {}),
    };
    if (this.saveSettings) {
      const saved = await this.saveSettings(update);
      if (saved?.error) {
        throw new BrowserRuntimeError('browser_config_update_failed', saved.error);
      }
      this.config = {
        ...this.config,
        ...normaliseBrowserRuntimeSection(saved),
        cacheDir: this.config.cacheDir,
      };
    } else {
      this.config = { ...this.config, ...update };
    }
    this.config.enabled = true;
    if (managed) this.config.executablePath = null;
  }

  async setupStatus() {
    let executablePath = null;
    if (this.setupInfo.supported) {
      try {
        executablePath = await this.resolveBrowser({
          executablePath: this.config.executablePath,
          cacheDir: this.config.cacheDir,
        });
        if (this.lastSetupError?.source === 'status') this.lastSetupError = null;
      } catch (error) {
        if (!this.lastSetupError || this.lastSetupError.source === 'status') {
          this.lastSetupError = {
            source: 'status',
            code: error?.code || 'browser_status_failed',
            safeError: String(error?.message || error).slice(0, 500),
          };
        }
      }
    }
    const installed = !!executablePath;
    if (this.ready) this.lastSetupError = null;
    const state = !this.setupInfo.supported ? 'unsupported'
      : this.ready ? 'ready'
        : this.#installPromise ? 'installing'
          : this.state === 'probing' ? 'probing'
            : this.probeResult && this.config.enabled ? 'unavailable'
              : installed ? 'disabled'
                : 'not_installed';
    return Object.freeze({
      supported: this.setupInfo.supported,
      state,
      installed,
      enabled: this.enabled,
      ready: this.ready,
      buildId: this.setupInfo.buildId,
      platform: this.setupInfo.platform,
      downloadBytes: this.setupInfo.downloadBytes,
      downloadedBytes: Number(this.installProgress?.downloadedBytes) || 0,
      totalBytes: Number(this.installProgress?.totalBytes) || this.setupInfo.downloadBytes,
      probeCode: this.probeResult?.code || null,
      safeError: this.lastSetupError?.safeError || this.probeResult?.safeError || null,
    });
  }

  async startupProbe({ force = false } = {}) {
    if (!this.enabled) return { ok: false, code: 'browser_runtime_disabled' };
    if (this.#probePromise) return this.#probePromise;
    if (!force && this.ready) return this.probeResult;
    this.state = 'probing';
    this.#probeAbort = new AbortController();
    const probePromise = this.probe({
      executablePath: this.config.executablePath,
      cacheDir: this.config.cacheDir,
      headless: this.config.headless,
      timeoutMs: this.config.startupProbeTimeoutMs,
      profileParent: `${this.config.cacheDir}-profiles`,
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
    }).finally(() => {
      if (this.#probePromise === probePromise) this.#probePromise = null;
      this.#probeAbort = null;
    });
    this.#probePromise = probePromise;
    return probePromise;
  }

  async enableAndProbe() {
    if (!this.setupInfo.supported) throw new BrowserRuntimeError('browser_platform_unsupported');
    this.lastSetupError = null;
    try {
      const executablePath = await this.resolveBrowser({
        executablePath: this.config.executablePath,
        cacheDir: this.config.cacheDir,
      });
      if (!executablePath) throw new BrowserRuntimeError('browser_executable_missing');
      await this.#persistEnabled();
      this.probeResult = null;
      const probe = await this.startupProbe({ force: true });
      await this.#notifyCapabilitiesChanged();
      return { ...(await this.setupStatus()), probeCode: probe.code || null };
    } catch (error) {
      this.lastSetupError = {
        source: 'enable',
        code: error?.code || 'browser_enable_failed',
        safeError: String(error?.message || error).slice(0, 500),
      };
      throw error;
    }
  }

  async installAndEnable({ confirmedBuildId, confirmedDownloadBytes, onProgress = null } = {}) {
    if (!this.setupInfo.supported) throw new BrowserRuntimeError('browser_platform_unsupported');
    if (confirmedBuildId !== this.setupInfo.buildId
        || Number(confirmedDownloadBytes) !== this.setupInfo.downloadBytes) {
      throw new BrowserRuntimeError('browser_install_confirmation_stale');
    }
    if (typeof onProgress === 'function') {
      if (this.#installListeners.size >= MAX_INSTALL_PROGRESS_LISTENERS) {
        throw new BrowserRuntimeError('browser_install_observer_limit');
      }
      this.#installListeners.add(onProgress);
    }
    if (!this.#installPromise) {
      this.state = 'installing';
      this.lastSetupError = null;
      this.installProgress = Object.freeze({
        downloadedBytes: 0,
        totalBytes: this.setupInfo.downloadBytes,
      });
      this.#installAbort = new AbortController();
      const installPromise = (async () => {
        await this.installBrowser({
          cacheDir: this.config.cacheDir,
          signal: this.#installAbort.signal,
          onProgress: (downloadedBytes, totalBytes) => {
            const total = Number(totalBytes) || this.setupInfo.downloadBytes;
            this.installProgress = Object.freeze({
              downloadedBytes: Number(downloadedBytes) || 0,
              totalBytes: total,
            });
            const now = Date.now();
            if (now - this.#lastInstallProgressAt < 250 && downloadedBytes < total) return;
            this.#lastInstallProgressAt = now;
            for (const listener of this.#installListeners) {
              try {
                Promise.resolve(listener(this.installProgress)).catch(() => {});
              } catch {}
            }
          },
        });
        await this.#persistEnabled({ managed: true });
        this.probeResult = null;
        await this.startupProbe({ force: true });
        await this.#notifyCapabilitiesChanged();
        return this.setupStatus();
      })().catch(error => {
        this.lastSetupError = {
          source: 'install',
          code: error?.code || 'browser_install_failed',
          safeError: String(error?.message || error).slice(0, 500),
        };
        this.state = 'unavailable';
        throw error;
      }).finally(() => {
        if (this.#installPromise === installPromise) {
          this.#installPromise = null;
          this.#installAbort = null;
        }
        this.#installListeners.clear();
      });
      this.#installPromise = installPromise;
    }
    try {
      return await this.#installPromise;
    } finally {
      if (typeof onProgress === 'function') this.#installListeners.delete(onProgress);
    }
  }

  #emit(message) {
    return this.send(message);
  }

  #pruneRequests(now = Date.now()) {
    for (const [key, request] of this.requests) {
      if (request.expiresAt <= now) this.requests.delete(key);
    }
  }

  #requestKey(identity, requestId) {
    return `${identity.ownerUserId}\0${identity.webConnectionId}\0${clean(requestId)}`;
  }

  #snapshot(session, extra = {}) {
    return {
      browserSessionId: session.browserSessionId,
      revision: session.revision,
      state: session.state,
      activeUrl: session.activeUrl,
      title: session.title,
      pageRevision: session.pageRevision,
      captureMode: session.captureMode,
      viewport: session.viewport,
      viewerCount: session.peers.size,
      interactivePeerCount: [...session.peers.values()].filter(peer => peer.role === 'interactive').length,
      authorizedProducerCount: [...session.peers.values()].filter(peer => (
        peer.role === 'interactive' && peer.state === 'connected'
      )).length,
      expiresAt: session.expiresAt,
      terminalReason: session.terminalReason || null,
      safeError: session.safeError || null,
      sourceRef: session.sourceRef,
      ...extra,
    };
  }

  #emitSnapshot(session, extra = {}) {
    return this.#emit({ type: 'browser_session_snapshot', ...this.#snapshot(session, extra) });
  }

  #dropPeer(session, peer, reason = 'peer_closed') {
    if (!peer || session.peers.get(peer.peerId) !== peer) return false;
    if (peer.role === 'interactive') {
      void peer.actionChain.finally(async () => {
        const page = session.runtime?.page;
        for (const key of ['Alt', 'Control', 'Meta', 'Shift']) {
          try { await page?.keyboard?.up?.(key); } catch {}
        }
        for (const button of ['left', 'middle', 'right']) {
          try { await page?.mouse?.up?.({ button }); } catch {}
        }
      });
    }
    clearTimeout(peer.expiryTimer);
    peer.expiryTimer = null;
    session.peers.delete(peer.peerId);
    this.bridge.send(session.browserSessionId, {
      type: 'peer_close',
      peerId: peer.peerId,
      connectionGeneration: peer.connectionGeneration,
      reason,
    });
    session.revision += 1;
    this.#scheduleNoViewerCleanup(session);
    return true;
  }

  #scheduleNoViewerCleanup(session) {
    clearTimeout(session.noViewerTimer);
    session.noViewerTimer = null;
    if (session.state !== 'ready' || session.peers.size > 0) return;
    const delay = Math.max(10_000, Number(this.config.noViewerIdleMs) || 120_000);
    session.expiresAt = Date.now() + delay;
    session.noViewerTimer = setTimeout(() => {
      if (this.sessions.get(session.browserSessionId) === session && session.peers.size === 0) {
        void this.closeSessionRecord(session, 'no_viewer_timeout');
      }
    }, delay);
    session.noViewerTimer.unref?.();
  }

  assertCanCreateSession() {
    if (!this.ready) throw new BrowserRuntimeError('browser_runtime_unavailable');
    if (this.sessions.size >= this.config.maxSessions) throw new BrowserRuntimeError('browser_session_limit');
  }

  async createSession(message) {
    const identity = normalizeIdentity(message?.serverIdentity);
    const requestId = clean(message?.requestId);
    if (!requestId) throw new BrowserRuntimeError('browser_request_id_required');
    const options = {
      initialUrl: safeInitialUrl(message?.options?.initialUrl),
      viewport: message?.options?.viewport || null,
      locale: clean(message?.options?.locale, 32) || 'en-US',
      capturePreference: clean(message?.options?.capturePreference, 16) || 'auto',
    };
    if (!['auto', 'tab'].includes(options.capturePreference)) {
      throw new BrowserRuntimeError('browser_capture_mode_unsupported');
    }
    this.#pruneRequests();
    const requestKey = this.#requestKey(identity, requestId);
    const digest = stableDigest({ options, sourceRef: sourceRef(message?.sourceRef) });
    const existing = this.requests.get(requestKey);
    if (existing) {
      if (existing.digest !== digest) throw new BrowserRuntimeError('browser_request_conflict');
      return existing.promise;
    }
    this.assertCanCreateSession();

    const browserSessionId = randomUUID();
    const session = {
      browserSessionId,
      owner: identity,
      sourceRef: sourceRef(message?.sourceRef),
      revision: 1,
      pageRevision: 1,
      state: 'starting',
      activeUrl: options.initialUrl,
      title: '',
      captureMode: 'tab',
      viewport: null,
      peers: new Map(),
      runtime: null,
      bridgeRegistration: null,
      noViewerTimer: null,
      expiresAt: null,
      terminalReason: null,
      safeError: null,
      closingPromise: null,
      startupAbort: new AbortController(),
    };
    this.sessions.set(browserSessionId, session);
    const promise = this.#startSession(session, options, requestId);
    this.requests.set(requestKey, { digest, promise, expiresAt: Date.now() + REQUEST_TTL_MS });
    return promise;
  }

  async #startSession(session, options, requestId) {
    try {
      session.bridgeRegistration = await this.bridge.registerSession(session.browserSessionId, {
        onMessage: message => this.#handleBridgeMessage(session, message),
        onDisconnect: () => {
          if (session.state === 'ready') void this.closeSessionRecord(session, 'extension_disconnected');
        },
      });
      session.runtime = await this.launchSession({
        browserSessionId: session.browserSessionId,
        bridgeUrl: session.bridgeRegistration.bridgeUrl,
        config: this.config,
        initialUrl: options.initialUrl,
        viewport: options.viewport,
        locale: options.locale,
        signal: session.startupAbort.signal,
      });
      if (this.sessions.get(session.browserSessionId) !== session || session.state !== 'starting') {
        await session.runtime.close?.().catch(() => {});
        session.runtime = null;
        throw new BrowserRuntimeError('browser_session_cancelled');
      }
      await session.bridgeRegistration.waitUntilReady(this.config.startupProbeTimeoutMs);
      if (this.sessions.get(session.browserSessionId) !== session || session.state !== 'starting') {
        throw new BrowserRuntimeError('browser_session_cancelled');
      }
      session.viewport = session.runtime.viewport;
      session.captureMode = session.runtime.captureMode;
      session.activeUrl = session.runtime.page.url();
      session.title = await session.runtime.page.title().catch(() => '');
      session.state = 'ready';
      session.revision += 1;
      session.runtime.page.on('framenavigated', frame => {
        if (frame !== session.runtime?.page?.mainFrame?.()) return;
        session.pageRevision += 1;
        session.revision += 1;
        session.activeUrl = frame.url();
        void session.runtime.page.title().then(title => { session.title = title; }).catch(() => {});
        this.#emitSnapshot(session);
      });
      session.runtime.page.on('close', () => {
        if (session.state === 'ready') void this.closeSessionRecord(session, 'page_closed');
      });
      this.#scheduleNoViewerCleanup(session);
      const created = {
        type: 'browser_session_created',
        requestId,
        ...this.#snapshot(session),
      };
      await this.#emit(created);
      return created;
    } catch (error) {
      session.state = 'failed';
      session.revision += 1;
      session.terminalReason = error?.code || 'browser_session_start_failed';
      session.safeError = String(error?.message || error).slice(0, 500);
      await this.#emit({
        type: 'browser_session_error',
        requestId,
        browserSessionId: session.browserSessionId,
        code: session.terminalReason,
        safeError: session.safeError,
      });
      await this.closeSessionRecord(session, session.terminalReason, { emit: false });
      throw error;
    }
  }

  #sessionFor(message, { exactConnection = false } = {}) {
    const session = this.sessions.get(clean(message?.browserSessionId));
    if (!session) throw new BrowserRuntimeError('browser_session_not_found');
    const identity = normalizeIdentity(message?.serverIdentity);
    if (!sameOwner(session.owner, identity)) throw new BrowserRuntimeError('browser_owner_mismatch');
    if (exactConnection && !sameConnection(session.owner, identity)) {
      // Peer messages are checked against the peer's connection below. Session
      // creation ownership alone must not grant a sibling browser tab control.
    }
    return { session, identity };
  }

  async preparePeer(message) {
    const { session, identity } = this.#sessionFor(message);
    if (session.state !== 'ready') throw new BrowserRuntimeError('browser_session_unavailable');
    const peerId = clean(message?.peerId);
    const connectionGeneration = Number(message?.connectionGeneration);
    if (!peerId || !positiveInteger(connectionGeneration)) throw new BrowserRuntimeError('browser_peer_invalid');
    const existing = session.peers.get(peerId);
    if (existing) {
      if (existing.connectionGeneration !== connectionGeneration || !sameConnection(existing.identity, identity)) {
        throw new BrowserRuntimeError('browser_peer_conflict');
      }
      if (existing.state === 'prepared' || existing.state === 'offered' || existing.state === 'connected') {
        return this.#emit({
          type: 'browser_peer_prepared',
          browserSessionId: session.browserSessionId,
          peerId,
          connectionGeneration,
        });
      }
      return true;
    }
    if (session.peers.size >= this.config.maxPeersPerSession) throw new BrowserRuntimeError('browser_peer_limit');
    const role = message?.role === 'interactive' ? 'interactive' : 'viewer';
    if (role === 'interactive' && [...session.peers.values()].some(item => item.role === 'interactive')) {
      throw new BrowserRuntimeError('browser_interactive_peer_limit');
    }
    const peer = {
      peerId,
      connectionGeneration,
      identity,
      role,
      state: 'preparing',
      webCandidateCount: 0,
      agentCandidateCount: 0,
      sequences: new ProducerSequenceState({ producerId: peerId, producerGeneration: connectionGeneration }),
      actionChain: Promise.resolve(),
      pendingControlCount: 0,
      pendingPointer: null,
      pointerDrainScheduled: false,
      expiresAt: Number(message?.routeExpiresAt) || Date.now() + 10 * 60_000,
      expiryTimer: null,
    };
    session.peers.set(peerId, peer);
    peer.expiryTimer = setTimeout(() => {
      if (this.#dropPeer(session, peer, 'peer_route_expired')) this.#emitSnapshot(session);
    }, Math.max(1, peer.expiresAt - Date.now()));
    peer.expiryTimer.unref?.();
    clearTimeout(session.noViewerTimer);
    session.noViewerTimer = null;
    session.expiresAt = null;
    const sent = this.bridge.send(session.browserSessionId, {
      type: 'peer_prepare',
      peerId,
      connectionGeneration,
      role: peer.role,
      iceServers: publicIceServers(message?.agentIceServers),
      iceTransportPolicy: message?.iceTransportPolicy === 'relay' ? 'relay' : 'all',
      maxBitrate: this.config.maxBitrate,
      maxFps: this.config.maxFps,
    });
    if (!sent) {
      clearTimeout(peer.expiryTimer);
      session.peers.delete(peerId);
      this.#scheduleNoViewerCleanup(session);
      throw new BrowserRuntimeError('browser_extension_unavailable');
    }
    return true;
  }

  #peerFor(message) {
    const { session, identity } = this.#sessionFor(message);
    const peer = session.peers.get(clean(message?.peerId));
    if (!peer || peer.connectionGeneration !== Number(message?.connectionGeneration)) {
      throw new BrowserRuntimeError('browser_peer_stale');
    }
    if (!sameConnection(peer.identity, identity)) throw new BrowserRuntimeError('browser_peer_owner_mismatch');
    return { session, peer };
  }

  answerPeer(message) {
    const { session, peer } = this.#peerFor(message);
    const description = message?.description;
    if (description?.type !== 'answer' || typeof description.sdp !== 'string' || description.sdp.length > 96 * 1024) {
      throw new BrowserRuntimeError('browser_sdp_invalid');
    }
    if (!this.bridge.send(session.browserSessionId, {
      type: 'peer_answer',
      peerId: peer.peerId,
      connectionGeneration: peer.connectionGeneration,
      description: { type: 'answer', sdp: description.sdp },
    })) throw new BrowserRuntimeError('browser_extension_unavailable');
  }

  addPeerIceCandidate(message) {
    const { session, peer } = this.#peerFor(message);
    if (peer.webCandidateCount >= 128) throw new BrowserRuntimeError('browser_candidate_limit');
    const candidate = message?.candidate;
    if (candidate != null && (typeof candidate !== 'object'
      || typeof candidate.candidate !== 'string'
      || candidate.candidate.length > 4096)) {
      throw new BrowserRuntimeError('browser_candidate_invalid');
    }
    peer.webCandidateCount += 1;
    if (!this.bridge.send(session.browserSessionId, {
      type: 'peer_ice_candidate',
      peerId: peer.peerId,
      connectionGeneration: peer.connectionGeneration,
      candidate: candidate == null ? null : {
        candidate: candidate.candidate,
        sdpMid: clean(candidate.sdpMid, 256) || null,
        sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
        usernameFragment: clean(candidate.usernameFragment, 256) || null,
      },
    })) throw new BrowserRuntimeError('browser_extension_unavailable');
  }

  detachPeer(message, reason = 'peer_detached') {
    const { session, peer } = this.#peerFor(message);
    const dropped = this.#dropPeer(session, peer, reason);
    if (dropped) this.#emitSnapshot(session);
    return dropped;
  }

  async closeSession(message) {
    const { session } = this.#sessionFor(message);
    if (message?.expectedRevision != null && Number(message.expectedRevision) !== session.revision) {
      throw new BrowserRuntimeError('browser_revision_conflict');
    }
    await this.closeSessionRecord(session, 'user_closed', { emit: false });
    return this.#emit({
      type: 'browser_session_snapshot',
      requestId: clean(message?.requestId) || null,
      ...this.#snapshot(session),
    });
  }

  async closeSessionRecord(session, reason = 'closed', { emit = true } = {}) {
    if (!session || this.sessions.get(session.browserSessionId) !== session) return false;
    if (session.closingPromise) return session.closingPromise;
    session.closingPromise = (async () => {
      session.state = 'closing';
      session.revision += 1;
      session.startupAbort?.abort(new BrowserRuntimeError('browser_session_cancelled'));
      session.terminalReason = reason;
      clearTimeout(session.noViewerTimer);
      session.noViewerTimer = null;
      for (const peer of session.peers.values()) clearTimeout(peer.expiryTimer);
      session.peers.clear();
      this.bridge.send(session.browserSessionId, { type: 'session_close', reason });
      this.bridge.unregisterSession(session.browserSessionId, reason);
      try { await session.runtime?.close?.(); } catch {}
      session.runtime = null;
      if (this.sessions.get(session.browserSessionId) === session) {
        this.sessions.delete(session.browserSessionId);
      }
      session.state = 'closed';
      session.revision += 1;
      session.expiresAt = null;
      if (emit) await this.#emitSnapshot(session);
      return true;
    })();
    return session.closingPromise;
  }

  getSession(message) {
    const { session } = this.#sessionFor(message);
    return this.#emit({
      type: 'browser_session_snapshot',
      requestId: clean(message?.requestId) || null,
      ...this.#snapshot(session),
    });
  }

  listSessions(message) {
    const identity = normalizeIdentity(message?.serverIdentity);
    const sessions = [...this.sessions.values()]
      .filter(session => sameOwner(session.owner, identity))
      .map(session => this.#snapshot(session));
    return this.#emit({
      type: 'browser_session_list_result',
      requestId: clean(message?.requestId) || null,
      sessions,
    });
  }

  async #executeInteractiveAction(session, peer, envelope, pointer = false) {
    if (session.state !== 'ready' || peer.role !== 'interactive' || peer.state !== 'connected') return;
    const sequenceEnvelope = {
      producerId: peer.peerId,
      producerGeneration: peer.connectionGeneration,
      ...(pointer ? { pointerSeq: Number(envelope?.pointerSeq) } : { controlSeq: Number(envelope?.controlSeq) }),
    };
    const accepted = pointer
      ? peer.sequences.acceptPointer(sequenceEnvelope)
      : peer.sequences.acceptControl(sequenceEnvelope);
    if (!accepted.accepted) return;
    const action = envelope?.action;
    if (!action || typeof action !== 'object') return;
    const page = session.runtime?.page;
    if (!page) return;
    if (pointer) {
      const x = Math.min(session.viewport?.width || 1920, Math.max(0, Number(action.x) || 0));
      const y = Math.min(session.viewport?.height || 1080, Math.max(0, Number(action.y) || 0));
      if (action.type === 'pointerMove') await page.mouse.move(x, y);
      return;
    }
    if (action.type === 'navigate') {
      const url = safeInitialUrl(action.url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.maxActionRuntimeMs });
    } else if (action.type === 'mouse') {
      const hasPosition = Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y));
      const x = Math.min(session.viewport?.width || 1920, Math.max(0, Number(action.x) || 0));
      const y = Math.min(session.viewport?.height || 1080, Math.max(0, Number(action.y) || 0));
      const button = ['left', 'middle', 'right'].includes(action.button) ? action.button : 'left';
      if (hasPosition) await page.mouse.move(x, y);
      if (action.event === 'down') await page.mouse.down({ button });
      else if (action.event === 'up') await page.mouse.up({ button });
      else if (action.event === 'click') await page.mouse.click(x, y, { button, clickCount: Math.min(3, Math.max(1, Number(action.clickCount) || 1)) });
    } else if (action.type === 'wheel') {
      await page.mouse.wheel({
        deltaX: Math.max(-4000, Math.min(4000, Number(action.deltaX) || 0)),
        deltaY: Math.max(-4000, Math.min(4000, Number(action.deltaY) || 0)),
      });
    } else if (action.type === 'key') {
      const key = clean(action.key, 128);
      if (!key) return;
      if (action.event === 'down') await page.keyboard.down(key);
      else if (action.event === 'up') await page.keyboard.up(key);
      else await page.keyboard.press(key);
    } else if (action.type === 'text') {
      const text = typeof action.text === 'string' ? action.text.slice(0, 16 * 1024) : '';
      if (text) await page.keyboard.type(text);
    } else if (action.type === 'resetInput') {
      for (const key of ['Alt', 'Control', 'Meta', 'Shift']) {
        try { await page.keyboard.up(key); } catch {}
      }
      for (const button of ['left', 'middle', 'right']) {
        try { await page.mouse.up({ button }); } catch {}
      }
    }
  }

  #handleBridgeMessage(session, message) {
    if (this.sessions.get(session.browserSessionId) !== session) return;
    if (message.type === 'peer_input') {
      const peer = session.peers.get(clean(message.peerId));
      if (!peer || peer.connectionGeneration !== Number(message.connectionGeneration)) return;
      if (message.channel === 'pointer') {
        peer.pendingPointer = message.envelope;
        if (peer.pointerDrainScheduled) return;
        peer.pointerDrainScheduled = true;
        peer.actionChain = peer.actionChain.then(async () => {
          const envelope = peer.pendingPointer;
          peer.pendingPointer = null;
          if (envelope) await this.#executeInteractiveAction(session, peer, envelope, true);
        }).catch(() => {}).finally(() => { peer.pointerDrainScheduled = false; });
        return;
      }
      const maxPending = Math.max(1, Number(this.config.maxQueuedActionsPerProducer) || 32);
      if (peer.pendingControlCount >= maxPending) {
        this.#dropPeer(session, peer, 'control_queue_saturated');
        void this.#emit({
          type: 'browser_peer_error',
          browserSessionId: session.browserSessionId,
          peerId: peer.peerId,
          connectionGeneration: peer.connectionGeneration,
          code: 'browser_control_queue_saturated',
          safeError: 'Browser input queue saturated; reconnect required',
        });
        void this.#emitSnapshot(session);
        return;
      }
      peer.pendingControlCount += 1;
      peer.actionChain = peer.actionChain
        .then(() => this.#executeInteractiveAction(session, peer, message.envelope, false))
        .catch(() => {})
        .finally(() => { peer.pendingControlCount = Math.max(0, peer.pendingControlCount - 1); });
      return;
    }
    if (message.type === 'peer_prepared' || message.type === 'peer_offer'
        || message.type === 'peer_ice_candidate' || message.type === 'peer_state'
        || message.type === 'peer_error') {
      const peer = session.peers.get(clean(message.peerId));
      if (!peer || peer.connectionGeneration !== Number(message.connectionGeneration)) return;
      if (message.type === 'peer_prepared') {
        peer.state = 'prepared';
        void this.#emit({
          type: 'browser_peer_prepared',
          browserSessionId: session.browserSessionId,
          peerId: peer.peerId,
          connectionGeneration: peer.connectionGeneration,
        });
      } else if (message.type === 'peer_offer') {
        const description = message.description;
        if (description?.type !== 'offer' || typeof description.sdp !== 'string' || description.sdp.length > 96 * 1024) {
          void this.closeSessionRecord(session, 'invalid_extension_offer');
          return;
        }
        peer.state = 'offered';
        void this.#emit({
          type: 'browser_peer_offer',
          browserSessionId: session.browserSessionId,
          peerId: peer.peerId,
          connectionGeneration: peer.connectionGeneration,
          description: { type: 'offer', sdp: description.sdp },
        });
      } else if (message.type === 'peer_ice_candidate') {
        if (peer.agentCandidateCount >= 128) return;
        peer.agentCandidateCount += 1;
        void this.#emit({
          type: 'browser_peer_ice_candidate',
          browserSessionId: session.browserSessionId,
          peerId: peer.peerId,
          connectionGeneration: peer.connectionGeneration,
          candidate: message.candidate || null,
        });
      } else if (message.type === 'peer_error') {
        this.#dropPeer(session, peer, 'peer_failed');
        void this.#emit({
          type: 'browser_peer_error',
          browserSessionId: session.browserSessionId,
          peerId: peer.peerId,
          connectionGeneration: peer.connectionGeneration,
          code: clean(message.code, 128) || 'peer_failed',
          safeError: clean(message.safeError, 500) || 'Browser peer failed',
        });
        void this.#emitSnapshot(session);
      } else {
        const nextState = clean(message.state, 32) || peer.state;
        if (nextState === 'connected') {
          clearTimeout(peer.expiryTimer);
          peer.expiryTimer = null;
          peer.expiresAt = null;
          peer.state = nextState;
        } else if (['failed', 'disconnected', 'closed'].includes(nextState)) {
          this.#dropPeer(session, peer, `peer_${nextState}`);
        } else {
          peer.state = nextState;
        }
        void this.#emit({
          type: 'browser_peer_state',
          browserSessionId: session.browserSessionId,
          peerId: peer.peerId,
          connectionGeneration: peer.connectionGeneration,
          state: nextState,
        });
      }
      return;
    }
    if (message.type === 'capture_ended') void this.closeSessionRecord(session, 'capture_ended');
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

  async handleTransportDisconnect() {
    await Promise.allSettled([...this.sessions.values()]
      .map(session => this.closeSessionRecord(session, 'agent_transport_disconnected', { emit: false })));
  }

  async shutdown() {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#probeAbort?.abort(new BrowserRuntimeError('browser_runtime_shutdown'));
    this.#installAbort?.abort(new BrowserRuntimeError('browser_runtime_shutdown'));
    this.#shutdownPromise = Promise.allSettled([
      Promise.resolve(this.#probePromise),
      Promise.resolve(this.#installPromise),
    ]).then(async () => {
      await Promise.allSettled([...this.sessions.values()]
        .map(session => this.closeSessionRecord(session, 'browser_runtime_shutdown', { emit: false })));
      await this.bridge.close();
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
