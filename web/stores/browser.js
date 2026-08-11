const { defineStore } = Pinia;

const REQUEST_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 60 * 60_000;
const PEER_ATTACH_TIMEOUT_MS = 20_000;
const PEER_DISCONNECTED_GRACE_MS = 5_000;
const CANCELLED_PEER_TTL_MS = 60 * 60_000;
const MAX_CANCELLED_PEERS = 256;

function id() {
  return globalThis.crypto?.randomUUID?.()
    || `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sessionKey(agentId, browserSessionId) {
  return `${String(agentId || '')}\0${String(browserSessionId || '')}`;
}

function cancelledPeerKey(agentId, browserSessionId, requestId, connectionGeneration) {
  return `${sessionKey(agentId, browserSessionId)}\0${String(requestId || '')}\0${String(connectionGeneration || '')}`;
}

function safeError(message, fallback = 'Browser Runtime request failed') {
  return message?.safeError || message?.code || fallback;
}

function nonReactive(value) {
  return globalThis.Vue?.markRaw?.(value) || value;
}

export const useBrowserStore = defineStore('browser', {
  state: () => ({
    sessions: {},
    pending: {},
    peers: {},
    cancelledPeers: {},
    errors: {},
    errorCodes: {},
    runtimeStatus: {},
    installProgress: {},
    protocolSupported: null,
    connectionEpoch: 0,
    lastError: null,
    _cancelledPeerCleanupTimer: null,
    _messageListenerInstalled: false,
  }),

  actions: {
    chatStore() {
      return window.Pinia?.useChatStore?.() || null;
    },

    installMessageListener() {
      if (this._messageListenerInstalled || typeof window === 'undefined') return;
      this._messageListenerInstalled = true;
      const chat = this.chatStore();
      this.protocolSupported = chat?.browserRuntimeProtocolSupported ?? null;
      window.addEventListener('browser-runtime-message', event => this.handleMessage(event.detail));
      window.addEventListener('browser-runtime-transport-reset', () => this.handleTransportReset());
    },

    send(message) {
      const chat = this.chatStore();
      if (!chat?.sendWsMessage?.(message)) throw new Error('Browser Runtime transport unavailable');
    },

    beginRequest(type, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
      const requestId = id();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          delete this.pending[requestId];
          reject(new Error(`${type} timed out`));
        }, timeoutMs);
        this.pending[requestId] = { type, resolve, reject, timer, payload };
        try {
          this.send({ type, requestId, ...payload });
        } catch (error) {
          clearTimeout(timer);
          delete this.pending[requestId];
          reject(error);
        }
      });
    },

    completeRequest(requestId, value, error = null) {
      const pending = requestId ? this.pending[requestId] : null;
      if (!pending) return false;
      clearTimeout(pending.timer);
      delete this.pending[requestId];
      if (error) pending.reject(error);
      else pending.resolve(value);
      return true;
    },

    clearCancelledPeers() {
      clearTimeout(this._cancelledPeerCleanupTimer);
      this._cancelledPeerCleanupTimer = null;
      this.cancelledPeers = {};
    },

    pruneCancelledPeers(now = Date.now()) {
      clearTimeout(this._cancelledPeerCleanupTimer);
      this._cancelledPeerCleanupTimer = null;
      for (const [key, cancelled] of Object.entries(this.cancelledPeers)) {
        if (Number(cancelled.expiresAt) <= now) delete this.cancelledPeers[key];
      }
      const nextExpiry = Math.min(...Object.values(this.cancelledPeers)
        .map(cancelled => Number(cancelled.expiresAt)).filter(Number.isFinite));
      if (Number.isFinite(nextExpiry)) {
        this._cancelledPeerCleanupTimer = setTimeout(
          () => this.pruneCancelledPeers(), Math.max(1, nextExpiry - Date.now()),
        );
      }
    },

    rememberCancelledPeer(peer) {
      const now = Date.now();
      this.pruneCancelledPeers(now);
      while (Object.keys(this.cancelledPeers).length >= MAX_CANCELLED_PEERS) {
        delete this.cancelledPeers[Object.keys(this.cancelledPeers)[0]];
      }
      this.cancelledPeers[cancelledPeerKey(
        peer.agentId, peer.browserSessionId, peer.requestId, peer.connectionGeneration,
      )] = {
        agentId: peer.agentId,
        browserSessionId: peer.browserSessionId,
        requestId: peer.requestId,
        connectionGeneration: peer.connectionGeneration,
        expiresAt: now + CANCELLED_PEER_TTL_MS,
      };
      this.pruneCancelledPeers(now);
    },

    takeCancelledPeer(message) {
      const key = cancelledPeerKey(
        message.agentId, message.browserSessionId, message.requestId, message.connectionGeneration,
      );
      const cancelled = this.cancelledPeers[key];
      if (!cancelled) return null;
      delete this.cancelledPeers[key];
      this.pruneCancelledPeers();
      if (Number(cancelled.expiresAt) <= Date.now()) return null;
      return cancelled;
    },

    async getRuntimeStatus(agentId) {
      const result = await this.beginRequest('browser_runtime_status', { agentId });
      this.runtimeStatus[agentId] = result;
      return result;
    },

    async installRuntime(agentId, status) {
      const result = await this.beginRequest('browser_runtime_install', {
        agentId,
        confirmedBuildId: status?.buildId,
        confirmedDownloadBytes: Number(status?.downloadBytes) || 0,
      }, INSTALL_TIMEOUT_MS);
      this.runtimeStatus[agentId] = result;
      delete this.installProgress[agentId];
      return result;
    },

    async enableRuntime(agentId) {
      const result = await this.beginRequest('browser_runtime_enable', { agentId }, 60_000);
      this.runtimeStatus[agentId] = result;
      return result;
    },

    async setupRuntime(agentId, status) {
      if (!status?.installed) return this.installRuntime(agentId, status);
      return this.enableRuntime(agentId);
    },

    async createSession({ agentId, sourceRef = null, initialUrl = 'about:blank', viewport = null, locale = 'en-US' }) {
      const result = await this.beginRequest('browser_session_create', {
        agentId,
        sourceRef,
        options: {
          initialUrl,
          viewport: viewport || { width: 1280, height: 720, deviceScaleFactor: 1 },
          locale,
          capturePreference: 'auto',
        },
      }, 45_000);
      this.sessions[sessionKey(agentId, result.browserSessionId)] = result;
      return result;
    },

    async listSessions(agentId) {
      const result = await this.beginRequest('browser_session_list', { agentId });
      const live = new Set((result.sessions || []).map(snapshot => sessionKey(agentId, snapshot.browserSessionId)));
      for (const key of Object.keys(this.sessions)) {
        if (key.startsWith(`${agentId}\0`) && !live.has(key)) delete this.sessions[key];
      }
      for (const snapshot of result.sessions || []) {
        this.sessions[sessionKey(agentId, snapshot.browserSessionId)] = { ...snapshot, agentId };
      }
      return result.sessions || [];
    },

    async closeSession(agentId, browserSessionId, expectedRevision) {
      await this.beginRequest('browser_session_close', {
        agentId,
        browserSessionId,
        expectedRevision,
      });
    },

    async attach({ agentId, browserSessionId, videoElement }) {
      if (!videoElement) throw new Error('Browser video element required');
      const localKey = sessionKey(agentId, browserSessionId);
      delete this.errors[localKey];
      delete this.errorCodes[localKey];
      const connectionGeneration = Number(this.connectionEpoch || 0) + 1;
      this.connectionEpoch = connectionGeneration;
      const requestId = id();
      const peer = {
        localKey,
        agentId,
        browserSessionId,
        requestId,
        peerId: null,
        connectionGeneration,
        connection: null,
        videoElement: nonReactive(videoElement),
        state: 'preparing',
        remoteState: null,
        pendingCandidates: [],
        iceServerCount: null,
        attachTimer: null,
        disconnectedTimer: null,
      };
      this.peers[localKey] = peer;
      peer.attachTimer = setTimeout(() => {
        peer.attachTimer = null;
        if (this.peers[localKey] !== peer || peer.connection?.connectionState === 'connected') return;
        const code = peer.iceServerCount === 0
          ? 'browser_ice_servers_missing'
          : 'browser_peer_attach_timeout';
        this.failPeer(peer, new Error(code), code);
      }, PEER_ATTACH_TIMEOUT_MS);
      this.send({
        type: 'browser_peer_attach',
        agentId,
        browserSessionId,
        requestId,
        connectionGeneration,
        role: 'viewer',
        clientCapabilities: {
          codecs: ['video/VP8'],
          maxWidth: 1920,
          maxHeight: 1080,
          maxFps: 30,
        },
      });
      return peer;
    },

    async preparePeer(peer, message) {
      if (this.peers[peer.localKey] !== peer || peer.connectionGeneration !== message.connectionGeneration) return;
      if (peer.connection) {
        if (peer.peerId === message.peerId) return;
        throw new Error('Browser peer identity changed during preparation');
      }
      peer.peerId = message.peerId;
      const iceServers = Array.isArray(message.iceServers) ? message.iceServers : [];
      peer.iceServerCount = iceServers.length;
      const connection = nonReactive(new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: message.iceTransportPolicy === 'relay' ? 'relay' : 'all',
      }));
      peer.connection = connection;
      peer.state = 'prepared';
      connection.ontrack = event => {
        if (this.peers[peer.localKey] !== peer) return;
        peer.videoElement.srcObject = event.streams[0] || new MediaStream([event.track]);
        void peer.videoElement.play().catch(() => {});
      };
      connection.onicecandidate = event => {
        if (this.peers[peer.localKey] !== peer) return;
        try {
          this.send({
            type: 'browser_peer_ice_candidate',
            agentId: peer.agentId,
            browserSessionId: peer.browserSessionId,
            peerId: peer.peerId,
            connectionGeneration: peer.connectionGeneration,
            candidate: event.candidate ? event.candidate.toJSON() : null,
          });
        } catch {}
      };
      connection.onconnectionstatechange = () => {
        if (this.peers[peer.localKey] !== peer) return;
        peer.state = connection.connectionState;
        if (connection.connectionState === 'connected') {
          clearTimeout(peer.attachTimer);
          peer.attachTimer = null;
          clearTimeout(peer.disconnectedTimer);
          peer.disconnectedTimer = null;
          return;
        }
        if (connection.connectionState === 'disconnected') {
          if (!peer.disconnectedTimer) {
            peer.disconnectedTimer = setTimeout(() => {
              peer.disconnectedTimer = null;
              if (this.peers[peer.localKey] !== peer || connection.connectionState === 'connected') return;
              const code = peer.iceServerCount === 0
                ? 'browser_ice_servers_missing'
                : 'browser_ice_connection_failed';
              this.failPeer(peer, new Error(code), code);
            }, PEER_DISCONNECTED_GRACE_MS);
          }
          return;
        }
        if (['failed', 'closed'].includes(connection.connectionState)) {
          const code = peer.iceServerCount === 0
            ? 'browser_ice_servers_missing'
            : 'browser_ice_connection_failed';
          this.failPeer(peer, new Error(code), code);
        }
      };
    },

    async acceptOffer(peer, message) {
      if (!peer.connection || peer.peerId !== message.peerId
          || peer.connectionGeneration !== message.connectionGeneration) return;
      await peer.connection.setRemoteDescription(message.description);
      await peer.connection.setLocalDescription(await peer.connection.createAnswer());
      this.send({
        type: 'browser_peer_answer',
        agentId: peer.agentId,
        browserSessionId: peer.browserSessionId,
        peerId: peer.peerId,
        connectionGeneration: peer.connectionGeneration,
        description: peer.connection.localDescription,
      });
      for (const candidate of peer.pendingCandidates.splice(0)) {
        await peer.connection.addIceCandidate(candidate);
      }
    },

    async acceptCandidate(peer, message) {
      if (!peer.connection || peer.peerId !== message.peerId
          || peer.connectionGeneration !== message.connectionGeneration || !message.candidate) return;
      if (!peer.connection.remoteDescription) peer.pendingCandidates.push(message.candidate);
      else await peer.connection.addIceCandidate(message.candidate);
    },

    detach(agentId, browserSessionId, { notify = true } = {}) {
      const localKey = sessionKey(agentId, browserSessionId);
      const peer = this.peers[localKey];
      if (!peer) return;
      delete this.peers[localKey];
      clearTimeout(peer.attachTimer);
      peer.attachTimer = null;
      clearTimeout(peer.disconnectedTimer);
      peer.disconnectedTimer = null;
      if (notify && !peer.peerId) this.rememberCancelledPeer(peer);
      if (notify && peer.peerId) {
        try {
          this.send({
            type: 'browser_peer_detach',
            requestId: id(),
            agentId,
            browserSessionId,
            peerId: peer.peerId,
            connectionGeneration: peer.connectionGeneration,
          });
        } catch {}
      }
      try { peer.connection?.close(); } catch {}
      if (peer.videoElement) peer.videoElement.srcObject = null;
    },

    failPeer(peer, error, code = null) {
      if (this.peers[peer.localKey] !== peer) return;
      this.lastError = error?.message || String(error);
      this.errors[peer.localKey] = this.lastError;
      if (code) this.errorCodes[peer.localKey] = code;
      else delete this.errorCodes[peer.localKey];
      this.detach(peer.agentId, peer.browserSessionId, { notify: true });
    },

    handleTransportReset() {
      this.protocolSupported = null;
      this.connectionEpoch += 1;
      for (const pending of Object.values(this.pending)) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Browser Runtime connection changed'));
      }
      this.pending = {};
      for (const peer of Object.values(this.peers)) {
        this.detach(peer.agentId, peer.browserSessionId, { notify: false });
      }
      this.peers = {};
      this.runtimeStatus = {};
      this.installProgress = {};
      this.errors = {};
      this.errorCodes = {};
      this.clearCancelledPeers();
    },

    handleMessage(message) {
      if (!message?.type) return;
      if (message.type === 'client_hello_ack') {
        this.protocolSupported = message.browserRuntimeProtocol === 1;
        return;
      }
      if (message.type === 'auth_result') {
        this.protocolSupported = false;
        return;
      }
      if (message.type === 'browser_runtime_error') {
        const error = new Error(safeError(message));
        error.code = message.code;
        if (!this.completeRequest(message.requestId, null, error)) this.lastError = error.message;
        return;
      }
      if (message.type === 'browser_runtime_install_progress') {
        this.installProgress[message.agentId] = {
          downloadedBytes: Number(message.downloadedBytes) || 0,
          totalBytes: Number(message.totalBytes) || 0,
        };
        return;
      }
      if (message.type === 'browser_runtime_status_result') {
        this.runtimeStatus[message.agentId] = message;
        this.completeRequest(message.requestId, message);
        if (message.state !== 'installing') delete this.installProgress[message.agentId];
        return;
      }
      if (message.type === 'browser_session_error') {
        const error = new Error(safeError(message));
        error.code = message.code;
        if (!this.completeRequest(message.requestId, null, error)) this.lastError = error.message;
        return;
      }
      if (message.type === 'browser_session_created') {
        this.sessions[sessionKey(message.agentId, message.browserSessionId)] = message;
        this.completeRequest(message.requestId, message);
        return;
      }
      if (message.type === 'browser_session_list_result') {
        this.completeRequest(message.requestId, message);
        return;
      }
      if (message.type === 'browser_session_snapshot') {
        const key = sessionKey(message.agentId, message.browserSessionId);
        this.sessions[key] = message;
        this.completeRequest(message.requestId, message);
        if (['closed', 'failed'].includes(message.state)) this.detach(message.agentId, message.browserSessionId, { notify: false });
        return;
      }
      const localKey = sessionKey(message.agentId, message.browserSessionId);
      const peer = this.peers[localKey];
      if (!peer || peer.connectionGeneration !== Number(message.connectionGeneration)) {
        if (message.type === 'browser_peer_prepared' || message.type === 'browser_peer_error'
            || (message.type === 'browser_peer_state'
              && ['failed', 'disconnected', 'closed'].includes(message.state))) {
          const cancelled = this.takeCancelledPeer(message);
          if (cancelled && message.type === 'browser_peer_prepared') {
            try {
              this.send({
                type: 'browser_peer_detach',
                requestId: id(),
                agentId: cancelled.agentId,
                browserSessionId: cancelled.browserSessionId,
                peerId: message.peerId,
                connectionGeneration: cancelled.connectionGeneration,
              });
            } catch {}
          }
        }
        return;
      }
      if (message.type === 'browser_peer_error') {
        this.failPeer(peer, new Error(safeError(message, 'Browser peer failed')), message.code || null);
      } else if (message.type === 'browser_peer_prepared') {
        this.preparePeer(peer, message).catch(error => this.failPeer(peer, error));
      } else if (message.type === 'browser_peer_offer') {
        this.acceptOffer(peer, message).catch(error => this.failPeer(peer, error));
      } else if (message.type === 'browser_peer_ice_candidate') {
        this.acceptCandidate(peer, message).catch(error => this.failPeer(peer, error));
      } else if (message.type === 'browser_peer_state' && message.state) {
        peer.remoteState = message.state;
        if (['failed', 'disconnected', 'closed'].includes(message.state)) {
          const code = peer.iceServerCount === 0
            ? 'browser_ice_servers_missing'
            : 'browser_ice_connection_failed';
          this.failPeer(peer, new Error(code), code);
        }
      }
    },
  },
});
