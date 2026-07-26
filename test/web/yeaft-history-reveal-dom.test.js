// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const storeFactories = new Map();

function defineStore(id, options) {
  return () => {
    if (storeFactories.has(id)) return storeFactories.get(id);
    const instance = Vue.reactive({ ...(typeof options.state === 'function' ? options.state() : {}) });
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, {
        enumerable: true,
        get() { return getter.call(instance, instance); },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    storeFactories.set(id, instance);
    return instance;
  };
}

globalThis.Vue = Vue;
globalThis.Pinia = { defineStore };

let YeaftPage;
let useChatStore;
let mergeYeaftHistoryWindow;
let yeaftHistoryIdentityKey;
let sessionsStore;

const vpStore = {
  vpList: [],
  vpLabel: id => id,
  vpDescription: () => '',
  vpTextColor: () => '',
};

beforeAll(async () => {
  ({ useChatStore } = await import('../../web/stores/chat.js'));
  ({ handleYeaftHistoryWindow: mergeYeaftHistoryWindow } = await import('../../web/stores/helpers/handlers/conversationHandler.js'));
  ({ yeaftHistoryIdentityKey } = await import('../../web/stores/helpers/yeaft-history-identity.js'));
  globalThis.Pinia.useChatStore = useChatStore;
  globalThis.Pinia.useAuthStore = () => ({ token: '' });
  globalThis.Pinia.useVpStore = () => vpStore;
  ({ default: YeaftPage } = await import('../../web/components/YeaftPage.js'));
});

function primeStore() {
  const store = useChatStore();
  store.currentView = 'yeaft';
  store.currentAgent = 'agent-a';
  store.currentAgentInfo = {
    id: 'agent-a',
    online: true,
    version: '1.0.201',
    capabilities: ['session_history_outline', 'session_history_search', 'session_history_window_prefetch'],
  };
  store.agents = [{ ...store.currentAgentInfo }];
  store.activeConversations = ['conv-a'];
  store.yeaftConversationId = 'conv-a';
  store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-a' };
  store.yeaftActiveSessionFilter = 'same';
  store.yeaftSessionAgentById = { same: 'agent-a' };
  store.yeaftMessageWindowState = { same: { visibleTurns: 5 } };
  store.messagesMap = {
    'conv-a': Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    })),
  };
  store.yeaftHistoryOutlineBySession = {
    [yeaftHistoryIdentityKey('agent-a', 'same')]: {
      agentId: 'agent-a',
      sessionId: 'same',
      loaded: true,
      loading: false,
      results: [{ messageId: 'm42', seq: 42, role: 'assistant', snippet: 'old answer' }],
      hasMore: false,
      nextBeforeSeq: null,
      totalCount: 13,
      error: null,
    },
  };
  store.yeaftHistorySearchState = {
    requestId: null,
    agentId: null,
    sessionId: null,
    query: '',
    loading: false,
    results: [],
    hasMore: false,
    nextBeforeSeq: null,
    error: null,
  };
  store.yeaftReflectionCards = {};
  store.processingConversations = {};
  store.executionStatusMap = {};
  store.yeaftVpTyping = {};
  store.vpStatuses = {};
  store.workCenterOpen = false;
  store.sessionSidebarOpen = false;
  store.sidebarCollapsed = false;
  store.workbenchExpanded = false;
  store.workbenchMaximized = false;
  const sent = [];
  store.sendWsMessage = message => sent.push(message);
  store._sent = sent;
  return store;
}

function mountPage() {
  return mount(YeaftPage, {
    attachTo: document.body,
    global: {
      mocks: { $t: key => key },
      stubs: {
        YeaftSidebar: true,
        WorkbenchPanel: true,
        WorkCenterPage: true,
        YeaftSessionActions: true,
        ChatInput: true,
        VpTimelinePane: true,
        YeaftDebugPanel: true,
        SettingsPanel: true,
        SessionInviteModal: true,
        SessionCreateModal: true,
        SessionSettingsModal: true,
        LlmTab: true,
        MessageItem: { template: '<span class="message-item-stub"></span>' },
        UserTurnBlock: { template: '<span class="user-turn-stub"></span>' },
        AssistantTurn: { template: '<span class="assistant-turn-stub"></span>' },
        VpTurnBlock: { template: '<span class="vp-turn-stub"></span>' },
        VpSpeakerHeader: true,
        ReflectionCard: true,
        SubAgentCard: true,
      },
    },
  });
}

async function settleWindow(store, revealWindow = null) {
  const request = store._sent.find(message => message.type === 'yeaft_load_history_window');
  expect(request).toMatchObject({
    agentId: 'agent-a',
    sessionId: 'same',
    anchorMessageId: 'm42',
    beforeTurns: 5,
    afterTurns: 5,
  });
  const response = {
    agentId: 'agent-a',
    sessionId: 'same',
    requestId: request.requestId,
    messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
  };
  const conversationId = mergeYeaftHistoryWindow(store, response);
  expect(conversationId).toBe('conv-a');
  expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
  await flushPromises();
  await Vue.nextTick();
  if (revealWindow) {
    await expect(revealWindow.mock.results.at(-1)?.value).resolves.toBe(true);
    expect(store.messagesMap['conv-a'].map(row => row.messageId || row.id)).toEqual([
      'm42', 'm50', 'm51', 'm52', 'm53', 'm54', 'm55', 'm56', 'm57', 'm58', 'm59', 'm60', 'm61',
    ]);
  }
}

async function expectRenderedReveal(wrapper, store, scrollToKey) {
  expect(store.yeaftMessageWindowState.same.visibleTurns).toBeGreaterThan(5);
  await flushPromises();
  await Vue.nextTick();

  expect(scrollToKey).toHaveBeenCalledTimes(1);
  const blockId = scrollToKey.mock.calls[0][0];
  expect(scrollToKey).toHaveBeenCalledWith(blockId, { align: 'center' });
  const virtualRow = wrapper.get(`[data-virtual-id="${blockId}"]`);
  expect(virtualRow.exists()).toBe(true);
  // Assistant history rows are grouped into a rendered turn, so their DOM
  // row id is the turn id rather than the persisted message id (m42).
  // The real navigation path resolves that mapping before scroll/flash.
  const row = virtualRow.get('.msg-row');
  expect(row.attributes('data-msg-id')).toBeTruthy();
  expect(row.classes()).toContain('msg-flash');
}

function observeVirtualScroll(wrapper) {
  const virtualTranscript = wrapper.getComponent({ name: 'VirtualTranscript' });
  const scrollToKey = vi.fn(virtualTranscript.vm.$.exposed.scrollToKey);
  virtualTranscript.vm.$.exposed.scrollToKey = scrollToKey;
  return scrollToKey;
}

describe('Yeaft history result rendered reveal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    sessionsStore = Vue.reactive({
      activeSessionId: 'same',
      activeNeedsInvite: false,
      hasLoadedSnapshot: true,
      isEmpty: false,
      sessions: [{ id: 'same', agentId: 'agent-a', title: 'Session', roster: ['omni'] }],
      sessionById(id, agentId) {
        return this.sessions.find(session => session.id === id && (!agentId || session.agentId === agentId)) || null;
      },
      get activeSession() { return this.sessionById(this.activeSessionId); },
    });
    globalThis.window.Pinia = {
      ...globalThis.Pinia,
      useSessionsStore: () => sessionsStore,
    };
  });

  it('clicks an uncached outline row, expands it, and reveals the real virtual DOM row', async () => {
    const store = primeStore();
    const revealWindow = vi.spyOn(store, 'revealYeaftHistoryResult');
    const wrapper = mountPage();
    wrapper.vm.toggleHistorySearch();
    await Vue.nextTick();

    const scrollToKey = observeVirtualScroll(wrapper);
    const option = wrapper.get('[role="option"]');
    expect(wrapper.find('[data-msg-id="m42"]').exists()).toBe(false);

    await option.trigger('click');
    expect(revealWindow).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm42' }));
    await settleWindow(store, revealWindow);
    await expectRenderedReveal(wrapper, store, scrollToKey);

    wrapper.unmount();
  });

  it('keeps hover prefetch cache-only, then reveals the cached row with Enter without a second request', async () => {
    const store = primeStore();
    const revealWindow = vi.spyOn(store, 'revealYeaftHistoryResult');
    const wrapper = mountPage();
    wrapper.vm.toggleHistorySearch();
    await Vue.nextTick();

    const scrollToKey = observeVirtualScroll(wrapper);
    const option = wrapper.get('[role="option"]');

    await option.trigger('mouseenter');
    await settleWindow(store);
    expect(store.yeaftMessageWindowState.same.visibleTurns).toBe(5);
    expect(wrapper.find('[data-msg-id="m42"]').exists()).toBe(false);
    expect(store._sent.filter(message => message.type === 'yeaft_load_history_window')).toHaveLength(1);

    const searchInput = wrapper.get('input[type="search"]');
    await searchInput.trigger('keydown', { key: 'Enter' });
    expect(revealWindow).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm42' }));
    await flushPromises();
    await Vue.nextTick();

    expect(store._sent.filter(message => message.type === 'yeaft_load_history_window')).toHaveLength(1);
    await expectRenderedReveal(wrapper, store, scrollToKey);

    wrapper.unmount();
  });
});
