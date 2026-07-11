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
const { default: WorkCenterPage } = await import('../../../web/components/WorkCenterPage.js');

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
  it('marks the mode switch to Chat as an explicit persisted selection', () => {
    const store = {
      workCenterReturnView: 'yeaft',
      leaveWorkCenter: vi.fn(),
    };

    WorkCenterPage.methods.onModeFlip.call({ store, agentId: 'agent-1' }, 'chat');

    expect(store.workCenterReturnView).toBe('chat');
    expect(store.leaveWorkCenter).toHaveBeenCalledWith({ persistConversationView: true });
  });

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

  it('persists Chat only for an explicit Work Center mode selection', () => {
    const store = makeStore('work-center');
    store.workCenterReturnView = 'chat';

    store.leaveWorkCenter();
    expect(localStorage.setItem).not.toHaveBeenCalledWith('yeaft-preferred-conversation-view', 'chat');

    store.currentView = 'work-center';
    store.leaveWorkCenter({ persistConversationView: true });
    expect(localStorage.setItem).toHaveBeenCalledWith('yeaft-preferred-conversation-view', 'chat');
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
