import { describe, expect, it, vi } from 'vitest';

globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
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
  it('returns to Chat when opened from Chat', () => {
    const store = makeStore('chat');

    store.enterWorkCenter('agent-1');
    expect(store.currentView).toBe('work-center');
    expect(store.workCenterReturnView).toBe('chat');

    store.leaveWorkCenter();
    expect(store.currentView).toBe('chat');
  });

  it('returns to Yeaft when opened from a Yeaft Session', () => {
    const store = makeStore('yeaft');
    store.enterYeaft = vi.fn(function enterYeaft() {
      this.currentView = 'yeaft';
    });

    store.enterWorkCenter('agent-1');
    expect(store.currentView).toBe('work-center');
    expect(store.workCenterReturnView).toBe('yeaft');

    store.leaveWorkCenter();
    expect(store.enterYeaft).toHaveBeenCalledWith('agent-1');
    expect(store.currentView).toBe('yeaft');
  });

  it('does not overwrite the return surface when switching Agents inside Work Center', () => {
    const store = makeStore('yeaft');
    store.enterWorkCenter('agent-1');

    store.agents.push({ id: 'agent-2', online: true });
    store.selectAgent = vi.fn();
    store.enterWorkCenter('agent-2');

    expect(store.workCenterReturnView).toBe('yeaft');
    expect(store.workCenterAgentId).toBe('agent-2');
  });
});
