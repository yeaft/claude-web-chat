import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPinia = globalThis.Pinia;
const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

function createStoreFactory() {
  let instance = null;
  return (_id, options) => () => {
    if (!instance) {
      instance = {
        ...(options.state ? options.state() : {}),
      };
      for (const [name, action] of Object.entries(options.actions || {})) {
        instance[name] = action.bind(instance);
      }
    }
    return instance;
  };
}

function createLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(key => values.get(key) || null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn(key => values.delete(key)),
  };
}

function jsonResponse({ ok = true, status = 200, body = {}, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: name => headers[name] || headers[name.toLowerCase()] || null },
    json: vi.fn(async () => body),
  };
}

async function loadAuthStore() {
  vi.resetModules();
  globalThis.Pinia = { defineStore: createStoreFactory() };
  const mod = await import('../../../web/stores/auth.js');
  return mod.useAuthStore();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.Pinia = originalPinia;
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalLocalStorage;
});

describe('auth store session restore and refresh', () => {
  it('verifies stored tokens with the server before marking the user authenticated', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'stale-token' });
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: false, status: 401, body: { error: 'expired' } }));
    const auth = await loadAuthStore();

    const restored = await auth.restoreSession();

    expect(restored).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/user/profile', {
      headers: { Authorization: 'Bearer stale-token' },
    });
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.token).toBe(null);
    expect(globalThis.localStorage.removeItem).toHaveBeenCalledWith('authToken');
  });

  it('uses renewed tokens returned while restoring a valid session', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'old-token' });
    globalThis.fetch = vi.fn(async () => jsonResponse({
      body: { username: 'dev', role: 'admin' },
      headers: { 'X-New-Token': 'new-token' },
    }));
    const auth = await loadAuthStore();

    const restored = await auth.restoreSession();

    expect(restored).toBe(true);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.token).toBe('new-token');
    expect(auth.role).toBe('admin');
    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith('authToken', 'new-token');
  });

  it('does not let stale restore renewals overwrite a newer login token', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'old-token' });
    globalThis.fetch = vi.fn(async () => {
      globalThis.localStorage.setItem('authToken', 'qr-login-token');
      return jsonResponse({
        body: { username: 'dev', role: 'admin' },
        headers: { 'X-New-Token': 'renewed-old-token' },
      });
    });
    const auth = await loadAuthStore();

    const restored = await auth.restoreSession();

    expect(restored).toBe(true);
    expect(auth.token).toBe('qr-login-token');
    expect(globalThis.localStorage.getItem('authToken')).toBe('qr-login-token');
    expect(globalThis.localStorage.setItem).not.toHaveBeenCalledWith('authToken', 'renewed-old-token');
  });

  it('keeps active sessions alive by refreshing the current token periodically', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'old-token' });
    globalThis.fetch = vi.fn(async () => jsonResponse({
      body: { username: 'dev', role: 'pro' },
      headers: { 'X-New-Token': 'renewed-token' },
    }));
    const auth = await loadAuthStore();
    auth.token = 'old-token';

    const ok = await auth.refreshSession();

    expect(ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/user/profile', {
      headers: { Authorization: 'Bearer old-token' },
    });
    expect(auth.token).toBe('renewed-token');
    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith('authToken', 'renewed-token');
  });

  it('does not clear an active session when refresh is forbidden', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'valid-token' });
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: false, status: 403 }));
    const auth = await loadAuthStore();
    auth.token = 'valid-token';
    auth.isAuthenticated = true;

    const ok = await auth.refreshSession();

    expect(ok).toBe(false);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.token).toBe('valid-token');
    expect(globalThis.localStorage.removeItem).not.toHaveBeenCalledWith('authToken');
  });

  it('does not let stale refresh renewals overwrite a newer login token', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'old-token' });
    let auth;
    globalThis.fetch = vi.fn(async () => {
      auth.token = 'qr-login-token';
      globalThis.localStorage.setItem('authToken', 'qr-login-token');
      return jsonResponse({
        body: { username: 'dev', role: 'pro' },
        headers: { 'X-New-Token': 'renewed-old-token' },
      });
    });
    auth = await loadAuthStore();
    auth.token = 'old-token';

    const ok = await auth.refreshSession();

    expect(ok).toBe(true);
    expect(auth.token).toBe('qr-login-token');
    expect(globalThis.localStorage.getItem('authToken')).toBe('qr-login-token');
    expect(globalThis.localStorage.setItem).not.toHaveBeenCalledWith('authToken', 'renewed-old-token');
  });

  it('does not let stale auth failures clear a newer login token', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'new-token' });
    const auth = await loadAuthStore();
    auth.token = 'new-token';
    auth.isAuthenticated = true;

    const ok = auth.handleAuthFailure('expired', 'old-token');

    expect(ok).toBe(false);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.token).toBe('new-token');
    expect(globalThis.localStorage.removeItem).not.toHaveBeenCalledWith('authToken');
  });

  it('hydrates the active token from storage before authenticated requests', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'stored-token' });
    const auth = await loadAuthStore();

    const token = auth.getActiveToken();

    expect(token).toBe('stored-token');
    expect(auth.token).toBe('stored-token');
  });
});
