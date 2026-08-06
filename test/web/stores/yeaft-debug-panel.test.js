// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';
import { reactive } from 'vue';

// chat.js reads `Pinia.defineStore` at import time, so install a minimal
// store factory before importing the real store definition. We only need
// the chat store instance; sibling stores are stubbed as empty objects.
let useChatStore;
let sessionsStore;

beforeAll(async () => {
  globalThis.Pinia = {
    defineStore: (id, def) => {
      if (id !== 'chat') return () => ({});
      return () => {
        const store = reactive(def.state());
        for (const [key, fn] of Object.entries(def.actions || {})) {
          store[key] = fn.bind(store);
        }
        return store;
      };
    },
  };
  ({ useChatStore } = await import('../../../web/stores/chat.js'));
});

let store;

beforeEach(() => {
  store = useChatStore();
  store.currentAgent = 'agent-1';
  sessionsStore = {
    activeSessionKey: 'agent-1\u001fsession-1',
    sessions: {
      'agent-1\u001fsession-1': { id: 'session-1', agentId: 'agent-1' },
    },
    sessionById(id, agentId) {
      return Object.values(this.sessions).find(session => session.id === id && (!agentId || session.agentId === agentId)) || null;
    },
  };
  globalThis.window.Pinia = {
    ...(globalThis.window.Pinia || {}),
    useSessionsStore: () => sessionsStore,
  };
  store.loadYeaftDebugHistory = vi.fn();
});

describe('YeaftDebugPanel store actions', () => {
  it('opens turn-scoped panel with loading status and issues a detail fetch', () => {
    store.openYeaftTurnDebug({ sessionId: 'session-1', turnId: 'turn-abc' });

    expect(store.yeaftDebugPanel.open).toBe(true);
    expect(store.yeaftDebugPanel.status).toBe('loading');
    expect(store.yeaftDebugPanel.agentId).toBe('agent-1');
    expect(store.yeaftDebugPanel.sessionId).toBe('session-1');
    expect(store.yeaftDebugPanel.turnId).toBe('turn-abc');
    expect(store.yeaftDebugPanel.error).toBeNull();
    expect(store.loadYeaftDebugHistory).toHaveBeenCalledWith({
      groupId: 'session-1',
      limit: 1,
      dreamLimit: 5,
      detailTurnId: 'turn-abc',
    });
  });

  it('uses the Session owner rather than a stale page-level Agent pointer', () => {
    sessionsStore.activeSessionKey = 'agent-2\u001fsession-1';
    sessionsStore.sessions = {
      'agent-2\u001fsession-1': { id: 'session-1', agentId: 'agent-2' },
    };
    store.currentAgent = 'agent-1';

    store.openYeaftTurnDebug({ sessionId: 'session-1', turnId: 'turn-abc' });

    expect(store.yeaftDebugPanel.agentId).toBe('agent-2');
    expect(store.loadYeaftDebugHistory).toHaveBeenCalledWith({
      groupId: 'session-1',
      limit: 1,
      dreamLimit: 5,
      detailTurnId: 'turn-abc',
    });
  });

  it('is a no-op without a resolvable agent', () => {
    store.currentAgent = null;
    sessionsStore.activeSessionKey = null;
    sessionsStore.sessions = {};
    store.yeaftDebugPanel = {
      open: false,
      status: 'idle',
      requestId: null,
      agentId: null,
      sessionId: null,
      turnId: null,
      error: null,
    };

    store.openYeaftTurnDebug({ sessionId: 'session-1', turnId: 'turn-abc' });

    expect(store.yeaftDebugPanel.open).toBe(false);
    expect(store.loadYeaftDebugHistory).not.toHaveBeenCalled();
  });

  it('closing a turn-scoped panel releases the cached turn payload', () => {
    store.openYeaftTurnDebug({ sessionId: 'session-1', turnId: 'turn-abc' });
    store.yeaftDebugTurnsById = { 'turn-abc': { turnId: 'turn-abc', loops: [] } };
    store.yeaftDebugTurnOrder = ['turn-abc'];
    store.yeaftDebugLoops = [{ turnId: 'turn-abc' }, { turnId: 'other' }];

    store.closeYeaftDebugPanel();

    expect(store.yeaftDebugPanel.open).toBe(false);
    expect(store.yeaftDebugPanel.turnId).toBeNull();
    expect(store.yeaftDebugTurnsById['turn-abc']).toBeUndefined();
    expect(store.yeaftDebugTurnOrder).not.toContain('turn-abc');
    expect(store.yeaftDebugLoops.some(l => l && l.turnId === 'turn-abc')).toBe(false);
    expect(store.yeaftDebugLoops.some(l => l && l.turnId === 'other')).toBe(true);
  });

  it('closing an already empty panel leaves the turn cache untouched', () => {
    store.yeaftDebugPanel = {
      open: true,
      status: 'idle',
      requestId: null,
      agentId: 'agent-1',
      sessionId: null,
      turnId: null,
      error: null,
    };
    store.yeaftDebugTurnsById = { 'turn-xyz': { turnId: 'turn-xyz', loops: [] } };
    store.yeaftDebugTurnOrder = ['turn-xyz'];
    store.yeaftDebugLoops = [{ turnId: 'turn-xyz' }];

    store.closeYeaftDebugPanel();

    expect(store.yeaftDebugPanel.open).toBe(false);
    expect(store.yeaftDebugTurnsById['turn-xyz']).toBeDefined();
    expect(store.yeaftDebugTurnOrder).toContain('turn-xyz');
  });
});
