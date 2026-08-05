// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

function indexedHistoryResult(overrides = {}) {
  return {
    entryId: 'entry-m42',
    indexGeneration: 7,
    entryStartSeq: 42,
    messageId: 'm42',
    seq: 42,
    sourceMessageIds: ['m42'],
    ...overrides,
  };
}

function primeStore() {
  const store = useChatStore();
  store._hasHandledAgentList = true;
  store._hasHandledYeaftSessionHydrate = true;
  store.yeaftSessionHydrateError = null;
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
  store.yeaftMessageWindowState = { [yeaftHistoryIdentityKey('agent-a', 'same')]: { visibleTurns: 5 } };
  store.yeaftHistoryCacheState = {};
  store._yeaftHistoryWindowPendingByKey = {};
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
      results: [indexedHistoryResult({ role: 'assistant', snippet: 'old answer' })],
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
    senderKey: '',
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

async function openDefaultUserSearch(wrapper, store) {
  wrapper.vm.toggleHistorySearch();
  await Vue.nextTick();
  const request = store._sent.find(message => message.type === 'yeaft_search_history');
  expect(request).toMatchObject({
    agentId: 'agent-a',
    sessionId: 'same',
    query: '',
    senderKey: 'user',
  });
  expect(store.handleYeaftHistorySearchResult({
    agentId: 'agent-a',
    sessionId: 'same',
    requestId: request.requestId,
    query: '',
    senderKey: 'user',
    results: [indexedHistoryResult({ role: 'user', snippet: 'old question' })],
    hasMore: false,
    nextBeforeSeq: null,
  })).toBe(true);
  await Vue.nextTick();
}

function mountPage({ renderComposer = false } = {}) {
  const stubs = {
    YeaftSidebar: true,
    WorkbenchPanel: true,
    WorkCenterPage: true,
    YeaftSessionActions: true,
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
    VpTurnBlock: {
      props: ['turn'],
      template: '<span class="vp-turn-stub" :data-vp-id="turn.speakerVpId" :data-turn-id="turn.turnId" :data-message-count="turn.messages.length">{{ turn.textContent }}</span>',
    },
    VpSpeakerHeader: true,
    ReflectionCard: true,
    SubAgentCard: true,
  };
  if (!renderComposer) stubs.ChatInput = true;
  return mount(YeaftPage, {
    attachTo: document.body,
    global: {
      mocks: { $t: key => key },
      stubs,
    },
  });
}

async function settleWindow(store, revealWindow = null) {
  const request = store._sent.filter(message => message.type === 'yeaft_load_history_window').at(-1);
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
    entryId: request.entryId,
    indexGeneration: request.indexGeneration,
    entryStartSeq: request.entryStartSeq,
    entryEndSeq: request.anchorSeq,
    sourceMessageIds: [request.anchorMessageId],
    anchorMessageId: request.anchorMessageId,
    anchorSeq: request.anchorSeq,
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
  expect(store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')].visibleTurns).toBeGreaterThan(5);
  await flushPromises();
  await Vue.nextTick();

  expect(scrollToKey).toHaveBeenCalledTimes(1);
  const blockId = scrollToKey.mock.calls[0][0];
  expect(scrollToKey).toHaveBeenCalledWith(blockId, { align: 'start' });
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

async function expectSilentTransportPromotion(wrapper, store) {
  await flushPromises();
  await Vue.nextTick();

  const before = wrapper.getComponent({ name: 'VirtualTranscript' });
  const beforeElement = before.element;
  const beforeRow = before.get('.virtual-transcript-item').element;
  const existingRows = store.messagesMap['conv-a'];
  const sessionKey = yeaftHistoryIdentityKey('agent-a', 'same');
  store.yeaftSessionHistoryState = {
    [sessionKey]: {
      loaded: true,
      loading: true,
      mode: 'recent',
      hasMore: true,
      oldestSeq: 50,
      latestSeq: 61,
      count: existingRows.length,
    },
  };
  store.yeaftLoadingMoreHistory = true;
  expect(wrapper.find('.loading-more').exists()).toBe(false);

  store.messagesMap['conv-b'] = existingRows.slice();
  store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-b' };
  store.yeaftConversationId = 'conv-b';
  store.activeConversations = ['conv-b'];
  await flushPromises();
  await Vue.nextTick();

  const after = wrapper.getComponent({ name: 'VirtualTranscript' });
  expect(after.element).toBe(beforeElement);
  expect(after.get('.virtual-transcript-item').element).toBe(beforeRow);
  expect(wrapper.find('.loading-more').exists()).toBe(false);
  expect(store.messages.map(row => row.content)).toEqual(existingRows.slice(-5).map(row => row.content));

  store.yeaftSessionHistoryState[sessionKey].mode = 'older';
  await Vue.nextTick();
  expect(wrapper.find('.loading-more').exists()).toBe(true);

  store.yeaftSessionHistoryState[sessionKey] = {
    ...store.yeaftSessionHistoryState[sessionKey],
    loading: false,
    mode: 'recent',
  };
  store.yeaftLoadingMoreHistory = false;
  store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-a' };
  store.yeaftConversationId = 'conv-a';
  store.activeConversations = ['conv-a'];
  delete store.messagesMap['conv-b'];
  await flushPromises();
  await Vue.nextTick();
}

const consolidatedHistoryScenarios = [];
function historyScenario(name, run) { consolidatedHistoryScenarios.push({ name, run }); }
async function runConsolidatedHistoryScenarios() {
  for (const scenario of consolidatedHistoryScenarios) {
    try { await scenario.run(); }
    catch (error) { error.message = `[${scenario.name}] ${error.message}`; throw error; }
  }
}

describe('Yeaft history result rendered reveal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    storeFactories.clear();
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

  afterEach(() => {
    vi.useRealTimers();
  });

  historyScenario('keeps existing virtual block keys stable when older history is prepended', async () => {
    const store = primeStore();
    store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')] = { visibleTurns: 20 };
    const wrapper = mountPage();
    await flushPromises();
    await Vue.nextTick();

    const before = wrapper.findAll('[data-virtual-id]').map(row => row.attributes('data-virtual-id'));
    store.messagesMap['conv-a'].unshift({
      id: 'm49',
      messageId: 'm49',
      type: 'user',
      content: 'older row',
      sessionId: 'same',
      timestamp: 49,
    });
    await flushPromises();
    await Vue.nextTick();

    const after = wrapper.findAll('[data-virtual-id]').map(row => row.attributes('data-virtual-id'));
    expect(after[0]).toBe('block_m49');
    expect(after.slice(1)).toEqual(before.slice(0, after.length - 1));
    wrapper.unmount();
  });

  async function expectInterleavedVpExecutionBlocks({ isHistory }) {
    const history = isHistory ? { isHistory: true } : {};
    const store = primeStore();
    store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')] = { visibleTurns: 20 };
    store.messagesMap['conv-a'] = [
      { id: 'u1', type: 'user', content: '@martin @grace inspect', sessionId: 'same', timestamp: 1 },
      { id: 'grace-plan', type: 'tool-use', toolName: 'StartPlan', sessionId: 'same', speakerVpId: 'grace', turnId: 'turn-grace-1', timestamp: 2, ...history },
      { id: 'martin-plan', type: 'tool-use', toolName: 'StartPlan', sessionId: 'same', speakerVpId: 'martin', turnId: 'turn-martin-1', timestamp: 3, ...history },
    ];

    const wrapper = mountPage();
    const readTurns = () => wrapper.findAll('.vp-turn-stub').map(row => ({
      vpId: row.attributes('data-vp-id'),
      turnId: row.attributes('data-turn-id'),
      messageCount: Number(row.attributes('data-message-count')),
      text: row.text(),
    }));
    await flushPromises();
    await Vue.nextTick();
    expect(readTurns()).toHaveLength(2);

    store.messagesMap['conv-a'].push(
      { id: 'grace-text', type: 'assistant', content: 'Grace result', sessionId: 'same', speakerVpId: 'grace', turnId: 'turn-grace-1', status: 'completed', timestamp: 4, ...history },
      { id: 'grace-route', type: 'tool-use', toolName: 'RouteForward', toolInput: { to: 'martin', text: 'Continue the review' }, sessionId: 'same', speakerVpId: 'grace', turnId: 'turn-grace-1', timestamp: 5, ...history },
      { id: 'martin-text', type: 'assistant', content: 'Martin result', sessionId: 'same', speakerVpId: 'martin', turnId: 'turn-martin-1', status: 'completed', timestamp: 6, ...history },
    );
    await flushPromises();
    await Vue.nextTick();
    expect(readTurns()).toEqual([
      { vpId: 'grace', turnId: 'turn-grace-1', messageCount: 3, text: 'Grace result' },
      { vpId: 'martin', turnId: 'turn-martin-1', messageCount: 2, text: 'Martin result' },
    ]);

    store.messagesMap['conv-a'].push(
      {
        id: 'martin-handoff',
        type: 'assistant',
        content: 'Martin follow-up',
        sessionId: 'same',
        speakerVpId: 'martin',
        turnId: 'turn-martin-2',
        status: 'completed',
        timestamp: 7,
        ...(isHistory ? { isHistory: true, executionOrigin: 'route_forward' } : {}),
      },
    );
    await flushPromises();
    await Vue.nextTick();
    expect(readTurns()).toEqual([
      { vpId: 'grace', turnId: 'turn-grace-1', messageCount: 3, text: 'Grace result' },
      { vpId: 'martin', turnId: 'turn-martin-1', messageCount: 2, text: 'Martin result' },
      { vpId: 'martin', turnId: 'turn-martin-2', messageCount: 1, text: 'Martin follow-up' },
    ]);
    wrapper.unmount();
  }

  historyScenario('keeps interleaved live fan-out frames in one block per VP execution and splits a later handoff', async () => {
    await expectInterleavedVpExecutionBlocks({ isHistory: false });
  });

  historyScenario('keeps interleaved history frames in one block per VP execution and splits a later handoff', async () => {
    await expectInterleavedVpExecutionBlocks({ isHistory: true });
  });

  it('opens composer model menus only through real click events', async () => {
    const store = primeStore();
    store.yeaftModel = 'provider/model-a';
    store.yeaftModelEffort = 'medium';
    store.yeaftAvailableModels = [
      { id: 'model-a', provider: 'provider', ref: 'provider/model-a', effortOptions: ['low', 'medium', 'high'] },
      { id: 'model-b', provider: 'provider', ref: 'provider/model-b', effortOptions: ['medium', 'high'] },
    ];
    store.switchYeaftModel = vi.fn();
    store.inputDrafts = {};
    sessionsStore.sessions = [{
      id: 'same',
      agentId: 'agent-a',
      title: 'Session',
      roster: ['omni'],
      config: { model: 'provider/model-a', modelEffort: 'medium' },
    }];

    const wrapper = mountPage({ renderComposer: true });
    await flushPromises();
    await Vue.nextTick();

    const modelChoice = wrapper.get('.yeaft-composer-model-choice');
    const modelButton = wrapper.get('.yeaft-composer-model');
    await modelChoice.trigger('mouseenter');
    await Vue.nextTick();
    expect(wrapper.find('.yeaft-composer-model-dropdown').exists()).toBe(false);

    await modelButton.trigger('focusin');
    await Vue.nextTick();
    expect(wrapper.find('.yeaft-composer-model-dropdown').exists()).toBe(false);

    await modelButton.trigger('click');
    await Vue.nextTick();
    expect(wrapper.get('.yeaft-composer-model-dropdown').isVisible()).toBe(true);

    await modelChoice.trigger('mouseleave');
    await Vue.nextTick();
    expect(wrapper.find('.yeaft-composer-model-dropdown').exists()).toBe(true);

    await modelButton.trigger('click');
    await Vue.nextTick();
    expect(wrapper.find('.yeaft-composer-model-dropdown').exists()).toBe(false);

    await modelButton.trigger('click');
    await Vue.nextTick();
    expect(wrapper.find('.yeaft-composer-model-dropdown').exists()).toBe(true);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Vue.nextTick();
    expect(wrapper.find('.yeaft-composer-model-dropdown').exists()).toBe(false);

    const effortButton = wrapper.get('.yeaft-composer-effort');
    await effortButton.trigger('click');
    await Vue.nextTick();
    expect(wrapper.find('.yeaft-composer-effort-dropdown').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Vue.nextTick();
    expect(wrapper.find('.yeaft-composer-effort-dropdown').exists()).toBe(false);

    wrapper.unmount();
  });

  it('clicks an uncached outline row, expands it, and reveals the real virtual DOM row', async () => {
    await runConsolidatedHistoryScenarios();
    const store = primeStore();
    const revealWindow = vi.spyOn(store, 'revealYeaftHistoryResult');
    const wrapper = mountPage();
    await expectSilentTransportPromotion(wrapper, store);
    const messageList = wrapper.getComponent({ name: 'MessageList' });
    const scroller = messageList.get('main.chat-container').element;
    let scrollTop = 920;
    let scrollHeight = 1000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 60 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: value => { scrollTop = Math.max(0, Number(value) || 0); },
      },
    });

    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    scrollTop = 920;
    scroller.dispatchEvent(new Event('scroll'));
    await Vue.nextTick();
    expect(messageList.get('.scroll-to-latest').classes()).not.toContain('is-hidden');

    // Moving down by 1px while still 3..80px from the bottom must not resume
    // live following. A new tail row and delayed virtual measurement must also
    // leave the reader where they are.
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
    scrollTop = 921;
    scroller.dispatchEvent(new Event('scroll'));
    await Vue.nextTick();
    expect(messageList.get('.scroll-to-latest').classes()).not.toContain('is-hidden');
    await new Promise(resolve => setTimeout(resolve, 275));
    const pausedTop = scrollTop;
    store.messagesMap['conv-a'].push({
      id: 'm62',
      messageId: 'm62',
      type: 'user',
      content: 'new live row',
      sessionId: 'same',
      timestamp: 62,
    });
    scrollHeight = 1040;
    await Vue.nextTick();
    await flushPromises();
    expect(scrollTop).toBe(pausedTop);
    expect(messageList.get('.scroll-to-latest').classes()).not.toContain('is-hidden');

    // Only the strict 2px boundary or the explicit latest button can resume.
    scrollTop = 950;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
    scrollTop = 978;
    scroller.dispatchEvent(new Event('scroll'));
    await Vue.nextTick();
    expect(messageList.get('.scroll-to-latest').classes()).toContain('is-hidden');
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    scrollTop = 940;
    scroller.dispatchEvent(new Event('scroll'));
    await Vue.nextTick();
    expect(messageList.get('.scroll-to-latest').classes()).not.toContain('is-hidden');
    await messageList.get('.scroll-to-latest').trigger('click');
    await Vue.nextTick();
    expect(scrollTop).toBe(scrollHeight);
    expect(messageList.get('.scroll-to-latest').classes()).toContain('is-hidden');
    store.messagesMap['conv-a'].pop();

    await openDefaultUserSearch(wrapper, store);

    const scrollToKey = observeVirtualScroll(wrapper);
    const option = wrapper.get('[role="option"]');
    expect(wrapper.find('[data-msg-id="m42"]').exists()).toBe(false);

    await option.trigger('click');
    expect(revealWindow).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm42' }),
      expect.objectContaining({ token: expect.any(Number), sessionId: 'same', agentId: 'agent-a' }),
    );
    await settleWindow(store, revealWindow);
    await expectRenderedReveal(wrapper, store, scrollToKey);

    wrapper.unmount();
  });

  it('keeps hover prefetch cache-only, then reveals the cached row with Enter without a second request', async () => {
    const store = primeStore();
    const revealWindow = vi.spyOn(store, 'revealYeaftHistoryResult');
    const wrapper = mountPage();
    await openDefaultUserSearch(wrapper, store);

    const scrollToKey = observeVirtualScroll(wrapper);
    const option = wrapper.get('[role="option"]');

    await option.trigger('mouseenter');
    await settleWindow(store);
    expect(store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')].visibleTurns).toBe(5);
    expect(wrapper.find('[data-msg-id="m42"]').exists()).toBe(false);
    expect(store._sent.filter(message => message.type === 'yeaft_load_history_window')).toHaveLength(1);

    const searchInput = wrapper.get('input[type="search"]');
    await searchInput.trigger('keydown', { key: 'Enter' });
    expect(revealWindow).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm42' }),
      expect.objectContaining({ token: expect.any(Number), sessionId: 'same', agentId: 'agent-a' }),
    );
    expect(store._sent.filter(message => message.type === 'yeaft_load_history_window')).toHaveLength(2);
    await settleWindow(store, revealWindow);
    await flushPromises();
    await Vue.nextTick();

    await expectRenderedReveal(wrapper, store, scrollToKey);

    store.messagesMap['conv-a'] = [
      { type: 'user', content: 'identical idless sibling', sessionId: 'same' },
      { type: 'user', content: 'identical idless sibling', sessionId: 'same' },
      { type: 'system', content: 'idless system', sessionId: 'same' },
      { type: 'legacy-unknown', content: 'idless unknown', sessionId: 'same' },
    ];
    store.yeaftMessageWindowState[yeaftHistoryIdentityKey('agent-a', 'same')] = { visibleTurns: 20 };
    await flushPromises();
    await Vue.nextTick();
    const idlessBefore = wrapper.findAll('[data-virtual-id]')
      .map(row => row.attributes('data-virtual-id'));
    expect(new Set(idlessBefore).size).toBe(idlessBefore.length);
    store.messagesMap['conv-a'].unshift({
      type: 'user', content: 'older idless row', sessionId: 'same',
    });
    await flushPromises();
    await Vue.nextTick();
    const idlessAfter = wrapper.findAll('[data-virtual-id]')
      .map(row => row.attributes('data-virtual-id'));
    expect(idlessAfter.slice(1)).toEqual(idlessBefore);
    expect(idlessAfter.join(' ')).not.toMatch(/(?:u|s|x)_\d+/);

    wrapper.unmount();
  });
});
