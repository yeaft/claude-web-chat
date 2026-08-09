// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map();
let useBrowserStore;
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
    this.addedCandidates = [];
    peerConnections.push(this);
  }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\no=web-answer' }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async addIceCandidate(candidate) { this.addedCandidates.push(candidate); }
  close() { this.connectionState = 'closed'; }
}

beforeAll(async () => {
  globalThis.Pinia = { defineStore };
  globalThis.Vue = { markRaw: value => value };
  globalThis.RTCPeerConnection = FakePeerConnection;
  globalThis.MediaStream = class MediaStream { constructor(tracks = []) { this.tracks = tracks; } };
  ({ useBrowserStore } = await import('../../web/stores/browser.js'));
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
  vi.restoreAllMocks();
});

describe('Browser Runtime Web store', () => {
  it('creates a generation-fenced peer and answers only its exact offer', async () => {
    const store = useBrowserStore();
    store.installMessageListener();
    const video = { srcObject: null, play: vi.fn().mockResolvedValue(undefined) };
    const peer = await store.attach({
      agentId: 'agent-a', browserSessionId: 'browser-a', videoElement: video,
    });
    expect(sent[0]).toMatchObject({
      type: 'browser_peer_attach', agentId: 'agent-a', browserSessionId: 'browser-a',
      connectionGeneration: peer.connectionGeneration,
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
