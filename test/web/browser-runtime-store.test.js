// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map();
let useBrowserStore;
let browserSessionMatchesSource;
let normalizeBrowserAddress;
let browserPointerPosition;
let createBrowserInputController;
let createBrowserInputSinkHandlers;
let sent;
let peerConnections;

function defineStore(id, options = {}) {
  return () => {
    if (stores.has(id)) return stores.get(id);
    const store = { ...(typeof options.state === 'function' ? options.state() : {}) };
    for (const [name, action] of Object.entries(options.actions || {})) store[name] = action.bind(store);
    stores.set(id, store);
    return store;
  };
}

class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'new';
    this.addedCandidates = [];
    peerConnections.push(this);
  }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\no=web-answer' }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async addIceCandidate(candidate) { this.addedCandidates.push(candidate); }
  close() { this.connectionState = 'closed'; }
  emitDataChannel(channel) { this.ondatachannel?.({ channel }); }
}

beforeAll(async () => {
  globalThis.Pinia = { defineStore };
  globalThis.Vue = { markRaw: value => value };
  globalThis.RTCPeerConnection = FakePeerConnection;
  globalThis.MediaStream = class MediaStream { constructor(tracks = []) { this.tracks = tracks; } };
  ({ useBrowserStore } = await import('../../web/stores/browser.js'));
  ({
    browserSessionMatchesSource, normalizeBrowserAddress, browserPointerPosition,
    createBrowserInputController, createBrowserInputSinkHandlers,
  } = await import('../../web/components/BrowserPanel.js'));
});

beforeEach(() => {
  stores.clear();
  sent = [];
  peerConnections = [];
  window.Pinia = {
    useChatStore: () => ({
      browserRuntimeProtocolSupported: true,
      sendWsMessage(message) { sent.push(message); return true; },
    }),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Browser Runtime Web store', () => {
  it('matches reusable Browser sessions to the exact Workbench Session source', () => {
    const yeaftSource = { kind: 'yeaft-session', sessionId: 'session-a' };
    expect(browserSessionMatchesSource({ sourceRef: yeaftSource }, yeaftSource)).toBe(true);
    expect(browserSessionMatchesSource({
      sourceRef: { kind: 'yeaft-session', sessionId: 'session-b' },
    }, yeaftSource)).toBe(false);
    expect(browserSessionMatchesSource({
      sourceRef: { kind: 'chat-conversation', conversationId: 'session-a' },
    }, yeaftSource)).toBe(false);
    expect(browserSessionMatchesSource({ sourceRef: null }, yeaftSource)).toBe(false);

    const chatSource = { kind: 'chat-conversation', conversationId: 'conversation-a' };
    expect(browserSessionMatchesSource({ sourceRef: chatSource }, chatSource)).toBe(true);
    expect(browserSessionMatchesSource({
      sourceRef: { kind: 'chat-conversation', conversationId: 'conversation-b' },
    }, chatSource)).toBe(false);
  });

  it('normalizes safe browser addresses and maps contained video coordinates', () => {
    expect(normalizeBrowserAddress('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeBrowserAddress('http://example.com')).toBe('http://example.com/');
    expect(normalizeBrowserAddress('file:///etc/passwd')).toBeNull();
    expect(normalizeBrowserAddress('https://user:pass@example.com')).toBeNull();
    const element = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    };
    expect(browserPointerPosition({ clientX: 500, clientY: 500 }, element, {
      width: 1280, height: 720,
    })).toEqual({ x: 640, y: 360 });
    expect(browserPointerPosition({ clientX: 500, clientY: 100 }, element, {
      width: 1280, height: 720,
    })).toBeNull();
  });

  it('uses an editable textarea event path to commit IME text exactly once', () => {
    const actions = [];
    const input = createBrowserInputController(action => { actions.push(action); return true; });
    const handlers = createBrowserInputSinkHandlers(input);
    const sink = document.createElement('textarea');
    for (const [type, handler] of Object.entries(handlers)) sink.addEventListener(type, handler);
    document.body.appendChild(sink);
    sink.focus();

    sink.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    const composingEvent = new KeyboardEvent('keydown', { key: 'Process', isComposing: true, bubbles: true, cancelable: true });
    sink.addEventListener('keydown', event => {
      if (input.keyDown(event)) event.preventDefault();
    });
    sink.dispatchEvent(composingEvent);
    expect(composingEvent.defaultPrevented).toBe(false);
    sink.value = '中文';
    sink.dispatchEvent(new InputEvent('input', { data: '中文', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
    expect(actions).toEqual([]);
    expect(sink.value).toBe('中文');
    sink.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true }));
    sink.dispatchEvent(new InputEvent('input', { data: '中文', inputType: 'insertText', bubbles: true }));

    expect(actions).toEqual([{ type: 'text', text: '中文' }]);
    expect(sink.value).toBe('');
    expect(document.activeElement).toBe(sink);
    sink.remove();
  });

  it('releases pressed input on cancellation', () => {
    const actions = [];
    const input = createBrowserInputController(action => { actions.push(action); return true; });
    expect(input.pointerDown('left', { x: 12, y: 34 })).toBe(true);
    expect(input.keyDown({ key: 'Shift', isComposing: false })).toBe(true);
    expect(input.reset()).toBe(true);
    expect(actions).toEqual([
      { type: 'mouse', event: 'down', button: 'left', x: 12, y: 34 },
      { type: 'key', event: 'down', key: 'Shift' },
      { type: 'resetInput' },
    ]);
    expect(input.snapshot()).toEqual({ buttons: [], modifiers: [], composing: false });
  });

  it('sends mouse-up even when a captured pointer leaves the rendered video', () => {
    const actions = [];
    const input = createBrowserInputController(action => { actions.push(action); return true; });
    input.pointerDown('left', { x: 10, y: 20 });
    expect(input.pointerUp('left', null)).toBe(true);
    expect(actions.at(-1)).toEqual({ type: 'mouse', event: 'up', button: 'left' });
    expect(input.reset()).toBe(false);
  });

  it('queries setup status and sends the exact explicit install confirmation with progress', async () => {
    const store = useBrowserStore();
    const statusPromise = store.getRuntimeStatus('agent-a');
    const statusRequest = sent.at(-1);
    expect(statusRequest).toMatchObject({
      type: 'browser_runtime_status', agentId: 'agent-a', requestId: expect.any(String),
    });
    store.handleMessage({
      type: 'browser_runtime_status_result',
      requestId: statusRequest.requestId,
      agentId: 'agent-a',
      supported: true,
      state: 'not_installed',
      installed: false,
      enabled: false,
      ready: false,
      buildId: '151.0.7922.71',
      downloadBytes: 193_285_407,
    });
    const status = await statusPromise;
    expect(store.runtimeStatus['agent-a']).toBe(status);

    const installPromise = store.setupRuntime('agent-a', status);
    const installRequest = sent.at(-1);
    expect(installRequest).toMatchObject({
      type: 'browser_runtime_install',
      agentId: 'agent-a',
      confirmedBuildId: '151.0.7922.71',
      confirmedDownloadBytes: 193_285_407,
    });
    store.handleMessage({
      type: 'browser_runtime_install_progress',
      requestId: installRequest.requestId,
      agentId: 'agent-a',
      downloadedBytes: 1024,
      totalBytes: 193_285_407,
    });
    expect(store.installProgress['agent-a']).toEqual({
      downloadedBytes: 1024,
      totalBytes: 193_285_407,
    });
    store.handleMessage({
      type: 'browser_runtime_status_result',
      requestId: installRequest.requestId,
      agentId: 'agent-a',
      supported: true,
      state: 'ready',
      installed: true,
      enabled: true,
      ready: true,
      buildId: '151.0.7922.71',
      downloadBytes: 193_285_407,
    });
    await expect(installPromise).resolves.toMatchObject({ state: 'ready', ready: true });
    expect(store.installProgress['agent-a']).toBeUndefined();

    const disabled = { ...status, state: 'disabled', installed: true };
    const enablePromise = store.setupRuntime('agent-a', disabled);
    const enableRequest = sent.at(-1);
    expect(enableRequest).toMatchObject({
      type: 'browser_runtime_enable', agentId: 'agent-a', requestId: expect.any(String),
    });
    expect(enableRequest).not.toHaveProperty('confirmedBuildId');
    store.handleMessage({
      type: 'browser_runtime_status_result',
      requestId: enableRequest.requestId,
      agentId: 'agent-a',
      supported: true,
      state: 'ready',
      installed: true,
      enabled: true,
      ready: true,
    });
    await expect(enablePromise).resolves.toMatchObject({ state: 'ready', ready: true });
  });

  it('creates a generation-fenced peer and answers only its exact offer', async () => {
    const store = useBrowserStore();
    store.installMessageListener();
    const video = { srcObject: null, play: vi.fn().mockResolvedValue(undefined) };
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a', videoElement: video,
    });
    expect(sent[0]).toMatchObject({
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-a',
      connectionGeneration: peer.connectionGeneration, role: 'interactive',
    });

    store.handleMessage({
      type: 'browser_peer_prepared', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceTransportPolicy: 'relay',
      iceServers: [{ urls: ['turns:turn.example.test:443'], username: 'u', credential: 'c' }],
    });
    await vi.waitFor(() => expect(peerConnections).toHaveLength(1));
    expect(peerConnections[0].config.iceTransportPolicy).toBe('relay');

    store.handleMessage({
      type: 'browser_peer_offer', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration - 1,
      description: { type: 'offer', sdp: 'stale' },
    });
    expect(peerConnections[0].remoteDescription).toBeNull();

    store.handleMessage({
      type: 'browser_peer_offer', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      description: { type: 'offer', sdp: 'v=0\no=agent-offer' },
    });
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: 'browser_peer_answer', peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      description: { type: 'answer', sdp: 'v=0\no=web-answer' },
    })));
  });

  it('replays an offer and candidates delivered before peer preparation', async () => {
    const store = useBrowserStore();
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    const generation = peer.connectionGeneration;
    store.handleMessage({
      type: 'browser_peer_offer', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: generation,
      description: { type: 'offer', sdp: 'v=0\\no=agent-offer' },
    });
    store.handleMessage({
      type: 'browser_peer_ice_candidate', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: generation,
      candidate: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(peer.pendingOffer).toMatchObject({ peerId: 'peer-a' });
    expect(peer.pendingCandidates).toHaveLength(1);

    store.handleMessage({
      type: 'browser_peer_prepared', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: generation,
      iceServers: [], iceTransportPolicy: 'all',
    });
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: 'browser_peer_answer', peerId: 'peer-a', connectionGeneration: generation,
    })));
    expect(peer.pendingOffer).toBeNull();
    expect(peerConnections[0].addedCandidates).toEqual([
      { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    ]);
  });

  it('uses independent ordered control and lossy pointer channels after interactive attach', async () => {
    const store = useBrowserStore();
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    await store.preparePeer(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceServers: [], iceTransportPolicy: 'all',
    });
    const connection = peerConnections[0];
    connection.connectionState = 'connected';
    connection.onconnectionstatechange();
    const control = { label: 'browser.control.v1', readyState: 'open', send: vi.fn(), close: vi.fn() };
    const pointer = { label: 'browser.pointer.v1', readyState: 'open', send: vi.fn(), close: vi.fn() };
    connection.emitDataChannel(control);
    connection.emitDataChannel(pointer);

    expect(store.interactiveReady('agent-a', 'browser-a')).toBe(true);
    expect(store.sendPointer('agent-a', 'browser-a', { type: 'pointerMove', x: 12, y: 34 })).toBe(true);
    expect(store.sendControl('agent-a', 'browser-a', { type: 'navigate', url: 'https://example.com/' })).toBe(true);
    expect(JSON.parse(pointer.send.mock.calls[0][0])).toMatchObject({
      version: 1, connectionGeneration: peer.connectionGeneration, pointerSeq: 1,
      action: { type: 'pointerMove', x: 12, y: 34 },
    });
    expect(JSON.parse(control.send.mock.calls[0][0])).toMatchObject({
      version: 1, connectionGeneration: peer.connectionGeneration, controlSeq: 1,
      action: { type: 'navigate', url: 'https://example.com/' },
    });
    store.detach('agent-a', 'browser-a', { notify: false });
    expect(control.close).toHaveBeenCalledOnce();
    expect(pointer.close).toHaveBeenCalledOnce();
    expect(store.sendControl('agent-a', 'browser-a', { type: 'key', key: 'Enter' })).toBe(false);
  });

  it('records ICE state and candidate errors for a stuck relay connection', async () => {
    const store = useBrowserStore();
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    await store.preparePeer(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceServers: [{ urls: ['turn:turn.example.test:3478?transport=udp'] }],
      iceTransportPolicy: 'relay',
    });
    const connection = peerConnections[0];
    connection.iceGatheringState = 'complete';
    connection.onicegatheringstatechange();
    connection.iceConnectionState = 'checking';
    connection.oniceconnectionstatechange();
    connection.onicecandidateerror({
      address: 'turn.example.test', port: 3478,
      url: 'turn:turn.example.test:3478?transport=udp',
      errorCode: 701, errorText: 'STUN server unreachable',
    });

    expect(store.peerDiagnostics['agent-a\0browser-a']).toMatchObject({
      connectionState: 'new',
      iceConnectionState: 'checking',
      iceGatheringState: 'complete',
      candidateErrors: 1,
      lastCandidateError: expect.objectContaining({ errorCode: 701 }),
    });
  });

  it('reports missing ICE infrastructure instead of a generic peer failure', async () => {
    const store = useBrowserStore();
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    await store.preparePeer(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceServers: [], iceTransportPolicy: 'all',
    });

    const connection = peerConnections[0];
    connection.connectionState = 'failed';
    connection.onconnectionstatechange();

    expect(store.peers['agent-a\0browser-a']).toBeUndefined();
    expect(store.errorCodes['agent-a\0browser-a']).toBe('browser_ice_servers_missing');
  });

  it('cleans up a locally disconnected peer after a bounded recovery grace', async () => {
    vi.useFakeTimers();
    const store = useBrowserStore();
    const video = {
      srcObject: { id: 'remote-stream' },
      play: vi.fn().mockResolvedValue(undefined),
    };
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a', videoElement: video,
    });
    await store.preparePeer(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceServers: [{ urls: ['turns:turn.example.test:443'] }], iceTransportPolicy: 'relay',
    });

    const connection = peerConnections[0];
    connection.connectionState = 'connected';
    connection.onconnectionstatechange();
    connection.connectionState = 'disconnected';
    connection.onconnectionstatechange();

    expect(store.peers['agent-a\0browser-a']).toBe(peer);
    expect(connection.connectionState).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.peers['agent-a\0browser-a']).toBe(peer);
    connection.connectionState = 'connecting';
    connection.onconnectionstatechange();

    await vi.advanceTimersByTimeAsync(1);
    expect(store.peers['agent-a\0browser-a']).toBeUndefined();
    expect(store.errorCodes['agent-a\0browser-a']).toBe('browser_ice_connection_failed');
    expect(connection.connectionState).toBe('closed');
    expect(video.srcObject).toBeNull();
    expect(peer.attachTimer).toBeNull();
    expect(peer.disconnectedTimer).toBeNull();
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'browser_peer_detach', peerId: 'peer-a',
      connectionGeneration: peer.connectionGeneration,
    }));
  });

  it('cancels the disconnected grace when the local peer reconnects', async () => {
    vi.useFakeTimers();
    const store = useBrowserStore();
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    await store.preparePeer(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceServers: [{ urls: ['turns:turn.example.test:443'] }], iceTransportPolicy: 'relay',
    });

    const connection = peerConnections[0];
    connection.connectionState = 'connected';
    connection.onconnectionstatechange();
    connection.connectionState = 'disconnected';
    connection.onconnectionstatechange();
    connection.connectionState = 'connected';
    connection.onconnectionstatechange();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(store.peers['agent-a\0browser-a']).toBe(peer);
    expect(peer.state).toBe('connected');
    expect(store.errorCodes['agent-a\0browser-a']).toBeUndefined();
  });

  it('does not let an Agent connected frame mask a local disconnected timeout', async () => {
    vi.useFakeTimers();
    const store = useBrowserStore();
    const video = {
      srcObject: { id: 'remote-stream' },
      play: vi.fn().mockResolvedValue(undefined),
    };
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a', videoElement: video,
    });
    await store.preparePeer(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceServers: [{ urls: ['turns:turn.example.test:443'] }], iceTransportPolicy: 'relay',
    });

    const connection = peerConnections[0];
    connection.connectionState = 'connected';
    connection.onconnectionstatechange();
    connection.connectionState = 'disconnected';
    connection.onconnectionstatechange();
    store.handleMessage({
      type: 'browser_peer_state', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration, state: 'connected',
    });

    expect(connection.connectionState).toBe('disconnected');
    expect(peer.state).toBe('disconnected');
    expect(peer.remoteState).toBe('connected');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(store.peers['agent-a\0browser-a']).toBeUndefined();
    expect(store.errorCodes['agent-a\0browser-a']).toBe('browser_ice_connection_failed');
    expect(connection.connectionState).toBe('closed');
    expect(video.srcObject).toBeNull();
    expect(peer.attachTimer).toBeNull();
    expect(peer.disconnectedTimer).toBeNull();
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'browser_peer_detach', peerId: 'peer-a',
      connectionGeneration: peer.connectionGeneration,
    }));
  });

  it('turns Agent-side terminal peer state into an actionable ICE failure', async () => {
    const store = useBrowserStore();
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    store.handleMessage({
      type: 'browser_peer_prepared', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceServers: [{ urls: ['turns:turn.example.test:443'] }], iceTransportPolicy: 'relay',
    });
    await vi.waitFor(() => expect(peerConnections).toHaveLength(1));

    store.handleMessage({
      type: 'browser_peer_state', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration, state: 'failed',
    });

    expect(store.peers['agent-a\0browser-a']).toBeUndefined();
    expect(store.errorCodes['agent-a\0browser-a']).toBe('browser_ice_connection_failed');
  });

  it('buffers early ICE until the offer and drops a stale peer after transport reset', async () => {
    const store = useBrowserStore();
    const video = { srcObject: null, play: vi.fn() };
    const peer = await store.attach({ agentId: 'agent-a', browserSessionId: 'browser-a', videoElement: video });
    await store.preparePeer(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceServers: [], iceTransportPolicy: 'all',
    });
    await store.acceptCandidate(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      candidate: { candidate: 'candidate:1' },
    });
    expect(peer.pendingCandidates).toHaveLength(1);
    await store.acceptOffer(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      description: { type: 'offer', sdp: 'v=0' },
    });
    expect(peerConnections[0].addedCandidates).toEqual([{ candidate: 'candidate:1' }]);

    store.handleTransportReset();
    expect(store.peers).toEqual({});
    expect(peerConnections[0].connectionState).toBe('closed');
    expect(video.srcObject).toBeNull();
    const sentBefore = sent.length;
    store.handleMessage({
      type: 'browser_peer_offer', agentId: 'agent-a', browserSessionId: 'browser-a',
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      description: { type: 'offer', sdp: 'late-old-offer' },
    });
    expect(sent).toHaveLength(sentBefore);
  });

  it('retains cancelled attach identities across replacement and detaches the matching late peer', async () => {
    const store = useBrowserStore();
    const first = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    store.detach('agent-a', 'browser-a', { notify: true });
    expect(store.peers).toEqual({});
    expect(Object.values(store.cancelledPeers)).toContainEqual(expect.objectContaining({
      requestId: first.requestId,
      connectionGeneration: first.connectionGeneration,
    }));

    const replacement = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    expect(Object.values(store.cancelledPeers)).toContainEqual(expect.objectContaining({
      requestId: first.requestId,
      connectionGeneration: first.connectionGeneration,
    }));
    store.handleMessage({
      type: 'browser_peer_prepared',
      agentId: 'agent-a', browserSessionId: 'browser-a',
      requestId: first.requestId,
      peerId: 'late-peer',
      connectionGeneration: first.connectionGeneration,
    });
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'browser_peer_detach', peerId: 'late-peer',
      connectionGeneration: first.connectionGeneration,
    }));
    expect(store.peers['agent-a\0browser-a']).toBe(replacement);
    expect(store.cancelledPeers).toEqual({});
  });

  it('consumes only the exact cancelled attach terminal event and resets tombstones with transport', async () => {
    const store = useBrowserStore();
    const first = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    store.detach('agent-a', 'browser-a', { notify: true });
    const replacement = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });

    store.handleMessage({
      type: 'browser_peer_error',
      agentId: 'agent-a', browserSessionId: 'browser-a',
      requestId: 'not-the-cancelled-request', peerId: 'unrelated-peer',
      connectionGeneration: first.connectionGeneration,
      code: 'unrelated_failure', safeError: 'unrelated failure',
    });
    expect(Object.values(store.cancelledPeers)).toHaveLength(1);
    expect(store.peers['agent-a\0browser-a']).toBe(replacement);

    store.handleMessage({
      type: 'browser_peer_error',
      agentId: 'agent-a', browserSessionId: 'browser-a',
      requestId: first.requestId, peerId: 'late-peer',
      connectionGeneration: first.connectionGeneration,
      code: 'cancelled_peer_failed', safeError: 'cancelled peer failed',
    });
    expect(store.cancelledPeers).toEqual({});
    expect(store.peers['agent-a\0browser-a']).toBe(replacement);

    store.detach('agent-a', 'browser-a', { notify: true });
    expect(Object.values(store.cancelledPeers)).toHaveLength(1);
    store.handleTransportReset();
    expect(store.cancelledPeers).toEqual({});
  });

  it('bounds and expires cancelled attach tombstones', async () => {
    vi.useFakeTimers();
    const store = useBrowserStore();
    try {
      for (let index = 0; index < 260; index += 1) {
        await store.attach({
          agentId: 'agent-a', browserSessionId: 'browser-a',
          videoElement: { srcObject: null, play: vi.fn() },
        });
        store.detach('agent-a', 'browser-a', { notify: true });
      }
      expect(Object.keys(store.cancelledPeers)).toHaveLength(256);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(store.cancelledPeers).toEqual({});
    } finally {
      store.clearCancelledPeers();
      vi.useRealTimers();
    }
  });

  it('rejects pending requests and closes every peer when the Web socket changes', async () => {
    vi.useFakeTimers();
    const store = useBrowserStore();
    const request = store.beginRequest('browser_session_list', { agentId: 'agent-a' });
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a',
      videoElement: { srcObject: null, play: vi.fn() },
    });
    await store.preparePeer(peer, {
      peerId: 'peer-a', connectionGeneration: peer.connectionGeneration,
      iceServers: [], iceTransportPolicy: 'all',
    });
    store.handleTransportReset();
    await expect(request).rejects.toThrow('connection changed');
    expect(store.protocolSupported).toBeNull();
    expect(store.peers).toEqual({});
    vi.useRealTimers();
  });
});
