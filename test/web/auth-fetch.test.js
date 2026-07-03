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

    expect(originalFetch).toHaveBeenCalledWith('/api/auth/login', { method: 'POST' });
  });

  it('syncs renewed tokens from response headers into storage and auth store', async () => {
    const authStore = {
      token: 'old-token',
      getActiveToken: vi.fn(() => 'old-token'),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response({ headers: { 'X-New-Token': 'fresh-token' } }));
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/user/profile');

    expect(authStore.token).toBe('fresh-token');
    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith('authToken', 'fresh-token');
  });

  it('reports session validation 401 failures against the token used for that request', async () => {
    const authStore = {
      token: 'new-token',
      getActiveToken: vi.fn(() => 'old-token'),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response({ status: 401 }));
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/user/profile');

    expect(authStore.handleAuthFailure).toHaveBeenCalledWith(undefined, 'old-token');
  });

  it('does not clear the login session when a non-session API returns 401', async () => {
    const authStore = {
      token: 'store-token',
      getActiveToken: vi.fn(() => 'store-token'),
      handleAuthFailure: vi.fn(),
    };
    const originalFetch = vi.fn(async () => response({ status: 401 }));
    const fetch = await loadInstaller({ authStore, fetchImpl: originalFetch });

    await fetch('/api/invitations');

    const headers = originalFetch.mock.calls[0][1].headers;
    expect(headers.get('Authorization')).toBe('Bearer store-token');
    expect(authStore.handleAuthFailure).not.toHaveBeenCalled();
  });

  it('does not clear a newer login when an old no-token request later returns 401', async () => {
    const authStore = {
      token: null,
      getActiveToken: vi.fn(() => null),
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

    expect(originalFetch.mock.calls[0][1]).toBeUndefined();
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
