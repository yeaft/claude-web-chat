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
    const ownedDraft = JSON.stringify({
      ownerId: 'user-a',
      records: { 'agent-a:item-a': { text: 'same owner survives reload' } },
    });
    globalThis.localStorage = createLocalStorage({
      authToken: 'old-token',
      'yeaft-work-center-composer-drafts-v1': ownedDraft,
    });
    globalThis.fetch = vi.fn(async () => jsonResponse({
      body: { userId: 'user-a', username: 'dev', role: 'admin' },
      headers: { 'X-New-Token': 'new-token' },
    }));
    const auth = await loadAuthStore();

    const restored = await auth.restoreSession();

    expect(restored).toBe(true);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.token).toBe('new-token');
    expect(auth.role).toBe('admin');
    expect(auth.userId).toBe('user-a');
    expect(globalThis.localStorage.getItem('yeaft-work-center-composer-drafts-v1')).toBe(ownedDraft);
    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith('authToken', 'new-token');
  });

  it('does not let stale restore renewals overwrite a newer login token', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'old-token' });
    globalThis.fetch = vi.fn(async () => {
      globalThis.localStorage.setItem('authToken', 'qr-login-token');
      return jsonResponse({
        body: { userId: 'stale-owner', username: 'dev', role: 'admin' },
        headers: { 'X-New-Token': 'renewed-old-token' },
      });
    });
    const auth = await loadAuthStore();

    const restored = await auth.restoreSession();

    expect(restored).toBe(false);
    expect(auth.token).toBe('qr-login-token');
    expect(auth.userId).toBe(null);
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

  it('preserves Yeaft history on same-owner refresh and clears it on owner replacement', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'owner-token' });
    const profiles = ['owner-a', 'owner-b'];
    globalThis.fetch = vi.fn(async () => jsonResponse({
      body: { userId: profiles.shift(), username: 'dev', role: 'pro' },
    }));
    const historyState = {
      messages: [{ sessionId: 'session-a', content: 'private history' }],
      history: { loaded: true },
      cache: { ranges: [[1, 2]] },
      window: { visibleTurns: 40 },
      hydration: { token: 'hydrate-a' },
      reveal: { key: 'reveal-a' },
    };
    const originalHistoryState = structuredClone(historyState);
    const clearYeaftHistoryMemory = vi.fn(() => {
      Object.keys(historyState).forEach(key => { historyState[key] = null; });
    });
    globalThis.Pinia = {
      defineStore: createStoreFactory(),
      useChatStore: () => ({ clearYeaftHistoryMemory }),
    };
    vi.resetModules();
    const { useAuthStore } = await import('../../../web/stores/auth.js');
    const auth = useAuthStore();
    auth.token = 'owner-token';
    auth.isAuthenticated = true;
    auth.userId = 'owner-a';

    expect(await auth.refreshSession()).toBe(true);
    expect(clearYeaftHistoryMemory).not.toHaveBeenCalled();
    expect(historyState).toEqual(originalHistoryState);

    expect(await auth.refreshSession()).toBe(true);
    expect(clearYeaftHistoryMemory).toHaveBeenCalledOnce();
    expect(historyState).toEqual({
      messages: null,
      history: null,
      cache: null,
      window: null,
      hydration: null,
      reveal: null,
    });
    expect(auth.userId).toBe('owner-b');
  });

  it('does not let stale refresh renewals overwrite a newer login token', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'old-token' });
    let auth;
    globalThis.fetch = vi.fn(async () => {
      auth.token = 'qr-login-token';
      globalThis.localStorage.setItem('authToken', 'qr-login-token');
      return jsonResponse({
        body: { userId: 'stale-owner', username: 'dev', role: 'pro' },
        headers: { 'X-New-Token': 'renewed-old-token' },
      });
    });
    auth = await loadAuthStore();
    auth.token = 'old-token';

    const ok = await auth.refreshSession();

    expect(ok).toBe(false);
    expect(auth.token).toBe('qr-login-token');
    expect(auth.userId).toBe(null);
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

  it('restores a cookie-only browser session without a local token', async () => {
    globalThis.localStorage = createLocalStorage();
    globalThis.fetch = vi.fn(async () => jsonResponse({
      body: { username: 'mobile-user', role: 'pro' },
    }));
    const auth = await loadAuthStore();

    const restored = await auth.restoreSession();

    expect(restored).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/user/profile', { headers: {} });
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.token).toBe(null);
    expect(auth.role).toBe('pro');
  });

  it('clears an authenticated cookie-only session on a current 401', async () => {
    globalThis.localStorage = createLocalStorage({
      'yeaft-work-center-composer-drafts-v1': JSON.stringify({ ownerId: 'user-a', records: { draft: {} } }),
      'yeaft-work-center-message-outbox-v1': JSON.stringify({ ownerId: 'user-a', records: { outbox: {} } }),
    });
    const auth = await loadAuthStore();
    auth.isAuthenticated = true;
    auth.authGeneration = 4;

    const handled = auth.handleAuthResponse(
      jsonResponse({ ok: false, status: 401 }),
      null,
      4,
      true,
    );

    expect(handled).toBe(true);
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.authGeneration).toBe(5);
    expect(globalThis.localStorage.removeItem).toHaveBeenCalledWith('authToken');
    expect(globalThis.localStorage.removeItem)
      .toHaveBeenCalledWith('yeaft-work-center-composer-drafts-v1');
    expect(globalThis.localStorage.removeItem)
      .toHaveBeenCalledWith('yeaft-work-center-message-outbox-v1');
  });

  it('ignores a cookie-only 401 from an older auth generation', async () => {
    globalThis.localStorage = createLocalStorage();
    const auth = await loadAuthStore();
    auth.isAuthenticated = true;
    auth.authGeneration = 8;

    const handled = auth.handleAuthResponse(
      jsonResponse({ ok: false, status: 401 }),
      null,
      7,
      true,
    );

    expect(handled).toBe(false);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.authGeneration).toBe(8);
    expect(globalThis.localStorage.removeItem).not.toHaveBeenCalled();
  });

  it('clears in-memory Yeaft history before reset and direct owner replacement', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'owner-b-token' });
    globalThis.fetch = vi.fn(async () => jsonResponse({
      body: { userId: 'owner-b', username: 'owner-b', role: 'pro' },
    }));
    const clearYeaftHistoryMemory = vi.fn();
    globalThis.Pinia = {
      defineStore: createStoreFactory(),
      useChatStore: () => ({ clearYeaftHistoryMemory }),
    };
    vi.resetModules();
    const { useAuthStore } = await import('../../../web/stores/auth.js');
    const auth = useAuthStore();
    auth.isAuthenticated = true;
    auth.userId = 'owner-a';

    expect(await auth.restoreSession()).toBe(true);
    expect(clearYeaftHistoryMemory).toHaveBeenCalledOnce();
    expect(auth.userId).toBe('owner-b');

    await auth.clearStoredSession();
    expect(clearYeaftHistoryMemory).toHaveBeenCalledTimes(2);
    expect(auth.userId).toBe(null);
  });

  it('posts logout and clears browser-owned state without transcript storage', async () => {
    globalThis.localStorage = createLocalStorage({
      'yeaft-work-center-composer-drafts-v1': JSON.stringify({ ownerId: 'user-a', records: {} }),
      'yeaft-work-center-message-outbox-v1': JSON.stringify({ ownerId: 'user-a', records: {} }),
    });
    globalThis.fetch = vi.fn(async () => jsonResponse());
    const clearYeaftHistoryMemory = vi.fn();
    globalThis.Pinia = {
      defineStore: createStoreFactory(),
      useChatStore: () => ({ clearYeaftHistoryMemory }),
    };
    vi.resetModules();
    const { useAuthStore } = await import('../../../web/stores/auth.js');
    const auth = useAuthStore();
    auth.isAuthenticated = true;
    auth.userId = 'user-a';

    await auth.logout();

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(auth.isAuthenticated).toBe(false);
    expect(clearYeaftHistoryMemory).toHaveBeenCalledOnce();
    expect(globalThis.localStorage.removeItem).toHaveBeenCalledWith('authToken');
    expect(globalThis.localStorage.removeItem)
      .toHaveBeenCalledWith('yeaft-work-center-composer-drafts-v1');
    expect(globalThis.localStorage.removeItem)
      .toHaveBeenCalledWith('yeaft-work-center-message-outbox-v1');
  });

  it('loads and unbinds identities for an authenticated cookie-only session', async () => {
    globalThis.localStorage = createLocalStorage();
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/auth/identities') {
        return jsonResponse({
          body: {
            success: true,
            identities: [{ provider: 'github' }],
            hasPassword: true,
          },
        });
      }
      if (url === '/api/auth/identities/github') {
        return jsonResponse({ body: { success: true } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    const auth = await loadAuthStore();
    auth.isAuthenticated = true;

    await auth.loadIdentities();
    const unbound = await auth.unbindIdentity('github');

    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, '/api/auth/identities');
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, '/api/auth/identities/github', {
      method: 'DELETE',
    });
    expect(unbound).toBe(true);
    expect(auth.hasPassword).toBe(true);
    expect(auth.linkedIdentities).toEqual([]);
  });

  it('deletes an account and clears the in-memory transcript', async () => {
    globalThis.localStorage = createLocalStorage();
    globalThis.fetch = vi.fn(async () => jsonResponse({ body: { success: true } }));
    const clearYeaftHistoryMemory = vi.fn();
    globalThis.Pinia = {
      defineStore: createStoreFactory(),
      useChatStore: () => ({ clearYeaftHistoryMemory }),
    };
    vi.resetModules();
    const { useAuthStore } = await import('../../../web/stores/auth.js');
    const auth = useAuthStore();
    auth.isAuthenticated = true;
    auth.userId = 'user-a';

    const result = await auth.deleteAccount({ confirm: 'DELETE' });

    expect(result).toEqual({ success: true });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/user/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: undefined, confirm: 'DELETE' }),
    });
    expect(auth.isAuthenticated).toBe(false);
    expect(clearYeaftHistoryMemory).toHaveBeenCalledOnce();
  });

  it('starts SSO binding for a cookie-only session without putting a token in the URL', async () => {
    const ownerARecords = {
      ownerId: 'user-a',
      records: { 'agent-a:item-a': { text: 'same owner QR draft' } },
    };
    globalThis.localStorage = createLocalStorage({
      'yeaft-work-center-composer-drafts-v1': JSON.stringify(ownerARecords),
    });
    const responses = [
      jsonResponse({
        body: { success: true, authorizeUrl: 'https://provider.test/auth', state: 'state-bind' },
      }),
      jsonResponse({
        body: {
          status: 'login', token: 'token-a', sessionKey: null, userId: 'user-a', role: 'pro',
        },
      }),
      jsonResponse({
        body: {
          status: 'login', token: 'token-b', sessionKey: null, userId: 'user-b', role: 'pro',
        },
      }),
    ];
    globalThis.fetch = vi.fn(async () => responses.shift());
    const auth = await loadAuthStore();
    auth.isAuthenticated = true;

    const started = await auth.startSsoQr('github', { intent: 'bind' });

    expect(started).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/sso/github/start-qr?intent=bind');
    expect(globalThis.fetch.mock.calls[0][0]).not.toContain('token=');

    auth.qrPanel = {
      provider: 'github', intent: 'login', state: 'state-user-a', status: 'pending', error: null,
    };
    auth._startQrPoll();
    await auth._qrPollTick();
    expect(auth).toMatchObject({
      isAuthenticated: true, token: 'token-a', userId: 'user-a', loginStep: 'authenticated',
    });
    expect(globalThis.localStorage.getItem('yeaft-work-center-composer-drafts-v1'))
      .toBe(JSON.stringify(ownerARecords));
    const browserState = await import('../../../web/stores/helpers/work-center-browser-state.js');
    const ownerAFence = browserState.currentWorkCenterBrowserOwner();
    expect(ownerAFence).toMatchObject({ ownerId: 'user-a' });
    expect(browserState.readWorkCenterBrowserState(ownerAFence).drafts)
      .toEqual(ownerARecords.records);

    auth.qrPanel = {
      provider: 'github', intent: 'login', state: 'state-user-b', status: 'pending', error: null,
    };
    auth._startQrPoll();
    await auth._qrPollTick();
    expect(auth).toMatchObject({
      isAuthenticated: true, token: 'token-b', userId: 'user-b', loginStep: 'authenticated',
    });
    expect(globalThis.localStorage.getItem('yeaft-work-center-composer-drafts-v1')).toBe(null);
    const ownerBFence = browserState.currentWorkCenterBrowserOwner();
    expect(ownerBFence).toMatchObject({ ownerId: 'user-b' });
    expect(browserState.readWorkCenterBrowserState(ownerBFence).drafts).toEqual({});
    expect(globalThis.localStorage.removeItem)
      .toHaveBeenCalledWith('yeaft-work-center-message-outbox-v1');
    auth.cancelSsoQr();
  });

  it('hydrates the active token from storage before authenticated requests', async () => {
    globalThis.localStorage = createLocalStorage({ authToken: 'stored-token' });
    const auth = await loadAuthStore();

    const token = auth.getActiveToken();

    expect(token).toBe('stored-token');
    expect(auth.token).toBe('stored-token');
  });
});
