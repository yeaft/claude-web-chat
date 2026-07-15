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
globalThis.Vue = globalThis.Vue || {
  ref: vi.fn(),
  computed: vi.fn(),
  watch: vi.fn(),
  onMounted: vi.fn(),
  onBeforeUnmount: vi.fn(),
  nextTick: vi.fn(),
};

const { useChatStore } = await import('../../../web/stores/chat.js');
const { default: ChatPage } = await import('../../../web/components/ChatPage.js');

function makeStore(view) {
  const store = useChatStore();
  store.currentView = view;
  store.currentAgent = 'agent-1';
  store.currentAgentInfo = { id: 'agent-1', online: true, capabilities: ['work_center'] };
  store.agents = [store.currentAgentInfo];
  store.listWorkItems = vi.fn().mockResolvedValue([]);
  return store;
}

describe('Work Center navigation', () => {
  it('leaves Work Center when a split-panel Session is selected', () => {
    const store = {
      isSplitMode: true,
      activePanelId: 'panel-1',
      leaveWorkCenter: vi.fn(),
      setPanelConversation: vi.fn(),
      closeSessionSidebar: vi.fn(),
    };

    ChatPage.methods.onSessionClick.call({ store }, {
      id: 'conversation-2',
      agentId: 'agent-1',
      agentOnline: true,
    });

    expect(store.leaveWorkCenter).toHaveBeenCalledOnce();
    expect(store.setPanelConversation).toHaveBeenCalledWith('panel-1', 'conversation-2');
    expect(store.closeSessionSidebar).toHaveBeenCalledOnce();
  });

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
    store.agents.push({ id: 'agent-2', online: true, capabilities: ['work_center'] });
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
    expect(store.workCenterCreateDraft.sourceAgentId).toBe('agent-1');
    expect(store.workCenterCreateDraft.linkedSessionIds).toEqual(['session-1']);
  });

  it('refetches detail once when an event advances to an Action missing locally', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': {
        id: 'wi-1', revision: 1, currentActionId: 'action-1', actionCount: 1,
        actionSummary: 'triage', actions: [{ id: 'action-1', type: 'triage' }],
      },
    };
    let resolveDetail;
    store.workCenterRequest = vi.fn(() => new Promise(resolve => { resolveDetail = resolve; }));
    const summary = {
      id: 'wi-1', revision: 2, currentActionId: 'action-2', actionCount: 2,
      actionSummary: 'triage → implement', actions: [],
    };

    store.applyWorkCenterEvent('agent-1', { workItem: summary });
    store.applyWorkCenterEvent('agent-1', { workItem: summary });
    expect(store.workCenterRequest).toHaveBeenCalledTimes(1);
    expect(store.workCenterRequest).toHaveBeenCalledWith('get', { id: 'wi-1' }, 'agent-1');

    resolveDetail({
      ...summary,
      actions: [{ id: 'action-1', type: 'triage' }, { id: 'action-2', type: 'implement' }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({
      currentActionId: 'action-2', actionCount: 2, actionSummary: 'triage → implement',
    });
    expect(store.workCenterDetailByAgent['agent-1'].actions.map(action => action.id))
      .toEqual(['action-1', 'action-2']);
  });

  it('does not let a delayed Action refresh overwrite a newly selected Work Item', async () => {
    const store = makeStore('yeaft');
    store.workCenterItemsByAgent = { 'agent-1': [] };
    store.workCenterDetailByAgent = {
      'agent-1': { id: 'wi-1', revision: 1, currentActionId: 'action-1', actions: [{ id: 'action-1' }] },
    };
    let resolveDetail;
    store.workCenterRequest = vi.fn(() => new Promise(resolve => { resolveDetail = resolve; }));

    store.applyWorkCenterEvent('agent-1', {
      workItem: { id: 'wi-1', revision: 2, currentActionId: 'action-2' },
    });
    store.workCenterDetailByAgent = {
      'agent-1': { id: 'wi-2', revision: 1, currentActionId: 'other-action', actions: [] },
    };
    resolveDetail({ id: 'wi-1', revision: 2, currentActionId: 'action-2', actions: [{ id: 'action-2' }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.workCenterDetailByAgent['agent-1']).toMatchObject({ id: 'wi-2' });
  });
});
