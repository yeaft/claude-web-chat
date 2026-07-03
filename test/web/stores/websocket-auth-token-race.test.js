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
    parseWsMessage: vi.fn(),
    handleMessage: vi.fn(),
    connect: vi.fn(),
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
    const authStore = {
      token: 'new-token',
      getActiveToken: vi.fn(() => 'old-token'),
      handleAuthFailure: vi.fn((_, failedToken) => {
        if (failedToken !== authStore.token) return false;
        authStore.token = null;
        return false;
      }),
    };
    const sockets = [];
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        sockets.push(this);
      }
      send() {}
      close() {}
    }
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { protocol: 'https:', host: 'example.test' };
    const { connect } = await loadWebsocketHelpers(authStore);
    const store = createStore();

    connect(store);
    authStore.token = 'new-token';
    sockets[0].onclose({ code: 1008, reason: 'Authentication required' });

    expect(sockets[0].url).toContain('token=old-token');
    expect(authStore.handleAuthFailure).toHaveBeenCalledWith(undefined, 'old-token');
    expect(authStore.token).toBe('new-token');
  });
});
