import { describe, expect, it, vi } from 'vitest';

globalThis.localStorage = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => ({
  ...(options.state ? options.state() : {}),
  ...(options.actions || {}),
});
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

const { useChatStore } = await import('../../../web/stores/chat.js');

function makeStore(view) {
  const store = useChatStore();
  store.currentView = view;
  store.currentAgent = 'agent-1';
  store.currentAgentInfo = { id: 'agent-1', online: true };
  store.agents = [store.currentAgentInfo];
  store.listWorkItems = vi.fn().mockResolvedValue([]);
  return store;
}

describe('Work Center navigation', () => {
  it('opens and closes inside the Chat provider without replacing it', () => {
    const store = makeStore('chat');

    store.enterWorkCenter('agent-1');
    expect(store.currentView).toBe('chat');
    expect(store.workCenterOpen).toBe(true);

    store.leaveWorkCenter();
    expect(store.currentView).toBe('chat');
    expect(store.workCenterOpen).toBe(false);
  });

  it('opens and closes inside Yeaft without tearing down the Session view', () => {
    const store = makeStore('yeaft');
    store.yeaftActiveSessionFilter = 'session-1';

    store.enterWorkCenter('agent-1');
    expect(store.currentView).toBe('yeaft');
    expect(store.yeaftActiveSessionFilter).toBe('session-1');
    expect(store.workCenterOpen).toBe(true);

    store.leaveWorkCenter();
    expect(store.currentView).toBe('yeaft');
    expect(store.yeaftActiveSessionFilter).toBe('session-1');
  });

  it('switches Work Center Agents without changing the provider', () => {
    const store = makeStore('yeaft');
    store.enterWorkCenter('agent-1');
    store.agents.push({ id: 'agent-2', online: true });
    store.selectAgent = vi.fn();

    store.enterWorkCenter('agent-2');

    expect(store.currentView).toBe('yeaft');
    expect(store.workCenterOpen).toBe(true);
    expect(store.workCenterAgentId).toBe('agent-2');
  });

  it('opens a Session-linked draft without changing the active provider', () => {
    const store = makeStore('yeaft');
    store.yeaftActiveSessionFilter = 'session-1';

    store.enterWorkCenterFromSession({ id: 'session-1', title: 'Investigate', agentId: 'agent-1' }, 'Fix it');

    expect(store.currentView).toBe('yeaft');
    expect(store.yeaftActiveSessionFilter).toBe('session-1');
    expect(store.workCenterOpen).toBe(true);
    expect(store.workCenterCreateDraft.linkedSessionIds).toEqual(['session-1']);
  });
});
