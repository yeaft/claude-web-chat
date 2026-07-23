import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPinia = globalThis.Pinia;
const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

function createLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(key => values.get(key) || null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn(key => values.delete(key)),
  };
}

async function loadAuthStore(initial = {}) {
  vi.resetModules();
  globalThis.localStorage = createLocalStorage(initial);
  globalThis.Pinia = {
    defineStore: (_id, options) => () => {
      const store = options.state();
      for (const [name, action] of Object.entries(options.actions || {})) {
        store[name] = action.bind(store);
      }
      return store;
    },
  };
  const mod = await import('../../web/stores/auth.js');
  return mod.useAuthStore();
}

function response({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    headers: { get: name => headers[name] || null },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.Pinia = originalPinia;
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalLocalStorage;
});

describe('authentication state policy', () => {
  it('keeps bootstrap pending until a stored login is validated', async () => {
    let resolveProfile;
    globalThis.fetch = vi.fn(async url => {
      if (url === '/api/auth/mode') return response({ body: { skipAuth: false } });
      if (url === '/api/user/profile') return new Promise(resolve => { resolveProfile = resolve; });
      throw new Error(`Unexpected fetch ${url}`);
    });
    const auth = await loadAuthStore({ authToken: 'stored-token' });

    const initializing = auth.initialize();
    for (let i = 0; i < 10 && !resolveProfile; i += 1) await Promise.resolve();

    expect(resolveProfile).toBeTypeOf('function');
    expect(auth.initialized).toBe(false);
    expect(auth.isAuthenticated).toBe(false);

    resolveProfile(response({ body: { username: 'dev', role: 'pro' } }));
    await initializing;

    expect(auth.initialized).toBe(true);
    expect(auth.isAuthenticated).toBe(true);
  });

  it('does not clear login for a permission denial', async () => {
    const auth = await loadAuthStore({ authToken: 'valid-token' });
    auth.token = 'valid-token';
    auth.isAuthenticated = true;

    expect(auth.handleAuthResponse({ status: 403 }, 'valid-token')).toBe(false);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.token).toBe('valid-token');
  });

  it('clears login for an active token authentication failure', async () => {
    const auth = await loadAuthStore({ authToken: 'expired-token' });
    auth.token = 'expired-token';
    auth.isAuthenticated = true;

    expect(auth.handleAuthResponse({ status: 401 }, 'expired-token')).toBe(true);
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.token).toBe(null);
  });
});
