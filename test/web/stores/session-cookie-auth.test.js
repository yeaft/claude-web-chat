import { afterEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;
const originalPinia = globalThis.Pinia;

async function loadSessionHelpers(authStore) {
  vi.resetModules();
  globalThis.Pinia = { defineStore: () => () => ({}) };
  vi.doMock('../../../web/stores/auth.js', () => ({
    useAuthStore: () => authStore,
  }));
  return import('../../../web/stores/helpers/session.js');
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.Pinia = originalPinia;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('global sessions with cookie authentication', () => {
  it('loads sessions for an authenticated store without a bearer token', async () => {
    const authStore = { isAuthenticated: true, token: null };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessions: [{ id: 'session-cookie' }] }),
    }));
    const { loadGlobalSessions } = await loadSessionHelpers(authStore);
    const store = { globalSessions: [], globalSessionsLoading: false };

    await loadGlobalSessions(store, 12);

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions?limit=12');
    expect(store.globalSessions).toEqual([{ id: 'session-cookie' }]);
    expect(store.globalSessionsLoading).toBe(false);
  });

  it('deletes sessions for an authenticated store without a bearer token', async () => {
    const authStore = { isAuthenticated: true, token: null };
    globalThis.fetch = vi.fn(async () => ({ ok: true }));
    const { deleteGlobalSession } = await loadSessionHelpers(authStore);
    const store = {
      globalSessions: [{ id: 'keep' }, { id: 'remove' }],
    };

    const deleted = await deleteGlobalSession(store, 'remove');

    expect(deleted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/remove', { method: 'DELETE' });
    expect(store.globalSessions).toEqual([{ id: 'keep' }]);
  });
});
