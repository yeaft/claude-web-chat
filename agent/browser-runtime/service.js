import { createHash, randomUUID } from 'node:crypto';
import { normaliseBrowserRuntimeSection } from './config.js';
import { defaultBrowserCacheDir } from './browser-install.js';
import { probeBrowserRuntime } from './probe.js';
import { BrowserRuntimeError } from './errors.js';
import { BrowserExtensionBridge } from './local-bridge.js';
import { launchBrowserSession } from './chromium.js';

const REQUEST_TTL_MS = 10 * 60_000;

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
    bridge = new BrowserExtensionBridge(),
    launchSession = launchBrowserSession,
    send = null,
    platform = process.platform,
  } = {}) {
    if (!yeaftDir) throw new Error('yeaftDir required');
    this.yeaftDir = yeaftDir;
    this.config = normaliseBrowserRuntimeSection(config);
    this.config.cacheDir ||= defaultBrowserCacheDir(yeaftDir);
    this.probe = probe;
    this.bridge = bridge;
    this.launchSession = launchSession;
    this.send = typeof send === 'function' ? send : () => 'dropped';
    this.platform = platform;
    this.sessions = new Map();
    this.requests = new Map();
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
    if (!this.ready || this.platform !== 'linux' || this.probeResult?.captureMode !== 'tab') return [];
    return ['browser_runtime', 'browser_webrtc', 'browser_capture_tab'];
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
    });
    return this.#probePromise;
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
      interactivePeerCount: 0,
      authorizedProducerCount: 0,
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
    const peer = {
      peerId,
      connectionGeneration,
      identity,
      state: 'preparing',
      webCandidateCount: 0,
      agentCandidateCount: 0,
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

  #handleBridgeMessage(session, message) {
    if (this.sessions.get(session.browserSessionId) !== session) return;
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
    this.#shutdownPromise = Promise.resolve(this.#probePromise).catch(() => {}).then(async () => {
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
