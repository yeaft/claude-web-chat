import { afterEach, describe, expect, it, vi } from 'vitest';

const originalLocation = globalThis.location;
const originalWebSocket = globalThis.WebSocket;
const originalPinia = globalThis.Pinia;

async function loadWebsocketHelpers(authStore) {
  vi.resetModules();
  globalThis.Pinia = {
    defineStore: () => () => ({}),
  };
  vi.doMock('../../../web/stores/auth.js', () => ({
    useAuthStore: () => authStore,
  }));
  return import('../../../web/stores/helpers/websocket.js');
}

function createStore() {
  return {
    ws: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    connectionState: 'disconnected',
    authenticated: false,
    currentView: 'chat',
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    parseWsMessage: vi.fn(data => JSON.parse(data)),
    handleMessage: vi.fn(),
    connect: vi.fn(),
  };
}

function installFakeWebSocket() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  return sockets;
}

function createRaceAuthStore() {
  return {
    token: 'old-token',
    authGeneration: 1,
    getActiveToken: vi.fn(function getActiveToken() { return this.token; }),
    handleAuthFailure: vi.fn(function handleAuthFailure(_, failedToken, failedGeneration = this.authGeneration) {
      if (failedToken !== this.token || failedGeneration !== this.authGeneration) return false;
      this.token = null;
      this.authGeneration += 1;
      return false;
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  globalThis.location = originalLocation;
  globalThis.WebSocket = originalWebSocket;
  globalThis.Pinia = originalPinia;
});

describe('websocket auth token races', () => {
  it('ignores 1008 close events from an older token after a newer login wins', async () => {
    const authStore = createRaceAuthStore();
    const sockets = installFakeWebSocket();
    globalThis.location = { protocol: 'https:', host: 'example.test' };
    const { connect } = await loadWebsocketHelpers(authStore);
    const store = createStore();

    connect(store);
    authStore.token = 'new-token';
    authStore.authGeneration = 2;
    sockets[0].onclose({ code: 1008, reason: 'Authentication required' });

    expect(sockets[0].url).toContain('token=old-token');
    expect(authStore.handleAuthFailure).toHaveBeenCalledWith(undefined, 'old-token', 1);
    expect(authStore.token).toBe('new-token');
  });

  it('ignores auth_result failures from an older socket after a newer login wins', async () => {
    const authStore = createRaceAuthStore();
    const sockets = installFakeWebSocket();
    globalThis.location = { protocol: 'https:', host: 'example.test' };
    const { connect } = await loadWebsocketHelpers(authStore);
    const store = createStore();
    store.handleMessage = vi.fn(msg => {
      if (msg.type === 'auth_result' && msg.success === false) {
        authStore.handleAuthFailure(undefined, msg._wsAuthToken, msg._wsAuthGeneration);
      }
    });

    connect(store);
    const staleOnMessage = sockets[0].onmessage;
    authStore.token = 'new-token';
    connect(store);
    staleOnMessage({ data: JSON.stringify({ type: 'auth_result', success: false, error: 'bad token' }) });

    expect(sockets[0].url).toContain('token=old-token');
    expect(sockets[1].url).toContain('token=new-token');
    expect(sockets[0].onmessage).toBe(null);
    expect(store.handleMessage).not.toHaveBeenCalled();
    expect(authStore.handleAuthFailure).not.toHaveBeenCalled();
    expect(authStore.token).toBe('new-token');
  });

  it('passes the socket-local token to auth_result failures from the active socket', async () => {
    const authStore = createRaceAuthStore();
    const sockets = installFakeWebSocket();
    globalThis.location = { protocol: 'https:', host: 'example.test' };
    const { connect } = await loadWebsocketHelpers(authStore);
    const store = createStore();
    store.handleMessage = vi.fn(msg => {
      if (msg.type === 'auth_result' && msg.success === false) {
        authStore.handleAuthFailure(undefined, msg._wsAuthToken, msg._wsAuthGeneration);
      }
    });

    connect(store);
    sockets[0].onmessage({ data: JSON.stringify({ type: 'auth_result', success: false, error: 'bad token' }) });

    expect(store.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'auth_result',
      success: false,
      _wsAuthToken: 'old-token',
    }));
    expect(authStore.handleAuthFailure).toHaveBeenCalledWith(undefined, 'old-token', 1);
    expect(authStore.token).toBe(null);
  });
});
