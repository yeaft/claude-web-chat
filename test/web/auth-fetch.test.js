import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalHeaders = globalThis.Headers;

function createLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(key => values.get(key) || null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn(key => values.delete(key)),
  };
}

function response({ status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name] || headers[name.toLowerCase()] || null },
  };
}

async function loadInstaller({ authStore, fetchImpl, origin = 'https://dev-cc.yeaft.com' } = {}) {
  vi.resetModules();
  globalThis.Headers = originalHeaders || Headers;
  globalThis.localStorage = createLocalStorage({ authToken: 'stored-token' });
  globalThis.window = {
    location: { href: `${origin}/`, origin },
    fetch: fetchImpl,
    Pinia: { useAuthStore: () => authStore },
  };
  const mod = await import('../../web/utils/auth-fetch.js');
  mod.installAuthFetch();
  return globalThis.window.fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
  globalThis.Headers = originalHeaders;
});

describe('auth fetch interceptor', () => {
  it('adds the active bearer token to same-origin protected API requests', async () => {
    const authStore = {
      token: 'store-token',
      getActiveToken: vi.fn(() => 'store-token'),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response());
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/user/profile');

    expect(originalFetch).toHaveBeenCalledWith('/api/user/profile', {
      credentials: 'same-origin',
      headers: expect.any(Headers),
    });
    const headers = originalFetch.mock.calls[0][1].headers;
    expect(headers.get('Authorization')).toBe('Bearer store-token');
  });

  it('does not overwrite an explicit Authorization header', async () => {
    const authStore = {
      token: 'store-token',
      getActiveToken: vi.fn(() => 'store-token'),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response());
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/user/profile', { headers: { Authorization: 'Bearer explicit-token' } });

    const headers = new Headers(originalFetch.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer explicit-token');
  });

  it('leaves public login endpoints unauthenticated', async () => {
    const authStore = {
      token: 'store-token',
      getActiveToken: vi.fn(() => 'store-token'),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response());
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/auth/login', { method: 'POST' });

    expect(originalFetch).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
    });
  });

  it('syncs renewed tokens from response headers into storage and auth store', async () => {
    const authStore = {
      token: 'old-token',
      getActiveToken: vi.fn(function getActiveToken() { return this.token; }),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response({ headers: { 'X-New-Token': 'fresh-token' } }));
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/user/profile');

    expect(authStore.token).toBe('fresh-token');
    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith('authToken', 'fresh-token');
  });

  it('does not let stale renewal headers overwrite a newer login token', async () => {
    const authStore = {
      token: 'old-token',
      getActiveToken: vi.fn(function getActiveToken() { return this.token; }),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => {
      authStore.token = 'qr-login-token';
      globalThis.localStorage.setItem('authToken', 'qr-login-token');
      return response({ headers: { 'X-New-Token': 'renewed-old-token' } });
    });
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/user/profile');

    expect(authStore.token).toBe('qr-login-token');
    expect(globalThis.localStorage.getItem('authToken')).toBe('qr-login-token');
    expect(globalThis.localStorage.setItem).not.toHaveBeenCalledWith('authToken', 'renewed-old-token');
  });

  it('reports protected API 401 failures through the shared auth policy', async () => {
    const authStore = {
      token: 'old-token',
      authGeneration: 3,
      isAuthenticated: true,
      getActiveToken: vi.fn(() => 'old-token'),
      handleAuthResponse: vi.fn(),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response({ status: 401 }));
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/user/profile');

    expect(authStore.handleAuthResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 }),
      'old-token',
      3,
      true,
    );
    expect(authStore.handleAuthFailure).not.toHaveBeenCalled();
  });

  it('routes a file upload 401 through the same auth policy', async () => {
    const authStore = {
      token: 'store-token',
      authGeneration: 5,
      isAuthenticated: true,
      getActiveToken: vi.fn(() => 'store-token'),
      handleAuthResponse: vi.fn(),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response({ status: 401 }));
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/upload', { method: 'POST', body: 'file-data' });

    const request = originalFetch.mock.calls[0][1];
    expect(request.credentials).toBe('same-origin');
    expect(request.headers.get('Authorization')).toBe('Bearer store-token');
    expect(authStore.handleAuthResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 }),
      'store-token',
      5,
      true,
    );
  });

  it('does not clear a newer login when an old no-token request later returns 401', async () => {
    const authStore = {
      token: null,
      authGeneration: 1,
      isAuthenticated: false,
      getActiveToken: vi.fn(() => null),
      handleAuthResponse: vi.fn(),
      handleAuthFailure: vi.fn(),
    };
    globalThis.localStorage = createLocalStorage();
    const originalFetch = vi.fn(async () => {
      authStore.token = 'new-token';
      globalThis.localStorage.setItem('authToken', 'new-token');
      return response({ status: 401 });
    });
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });
    globalThis.localStorage.removeItem('authToken');

    await fetch('/api/user/profile');

    expect(originalFetch.mock.calls[0][1]).toEqual({ credentials: 'same-origin' });
    expect(authStore.handleAuthResponse).toHaveBeenCalledWith(expect.anything(), null, 1, false);
    expect(authStore.handleAuthFailure).not.toHaveBeenCalled();
    expect(authStore.token).toBe('new-token');
    expect(globalThis.localStorage.getItem('authToken')).toBe('new-token');
  });

  it('does not treat authorization denials as expired login sessions', async () => {
    const authStore = {
      token: 'pro-token',
      getActiveToken: vi.fn(() => 'pro-token'),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response({ status: 403 }));
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/admin/dashboard');

    expect(authStore.handleAuthFailure).not.toHaveBeenCalled();
  });
});
