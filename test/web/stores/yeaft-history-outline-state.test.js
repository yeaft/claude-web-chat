import { beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

function createStoreFactory(_id, options) {
  let instance = null;
  return () => {
    if (instance) return instance;
    instance = { ...(typeof options.state === 'function' ? options.state() : {}) };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, { enumerable: true, get() { return getter(instance); } });
    }
    for (const [name, action] of Object.entries(options.actions || {})) instance[name] = action.bind(instance);
    return instance;
  };
}

globalThis.Pinia = { defineStore: createStoreFactory };
const sessionsStore = {
  sessionById: (id, agentId) => ({ id, agentId: agentId || (id === 'same' ? 'agent-a' : 'agent-a') }),
};
globalThis.window = {
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  Pinia: { useSessionsStore: () => sessionsStore },
};
globalThis.document = { addEventListener: vi.fn(), removeEventListener: vi.fn(), documentElement: { setAttribute() {}, classList: { toggle() {} } } };

const { useChatStore } = await import('../../../web/stores/chat.js');
const { yeaftHistoryIdentityKey } = await import('../../../web/stores/helpers/yeaft-history-identity.js');

function primeStore() {
  const store = useChatStore();
  store.currentView = 'yeaft';
  store.currentAgent = 'agent-a';
  store.currentAgentInfo = { id: 'agent-a', version: '1.0.201', capabilities: ['session_history_outline'] };
  store.agents = [{ id: 'agent-a', version: '1.0.201', capabilities: ['session_history_outline'] }];
  store.yeaftActiveSessionFilter = 'same';
  store.yeaftSessionAgentById = { same: 'agent-a' };
  store.yeaftHistoryOutlineBySession = {};
  store._yeaftHistoryOutlineTimeouts = {};
  store.messagesMap = {};
  store.yeaftConversationId = 'conv-a';
  store.yeaftConversationIdsByAgent = { 'agent-a': 'conv-a' };
  const sent = [];
  store.sendWsMessage = msg => sent.push(msg);
  store._sent = sent;
  return store;
}

describe('Yeaft history outline state', () => {
  beforeEach(() => vi.useFakeTimers());

  it('loads once, pages older rows, and rejects stale responses', () => {
    const store = primeStore();
    expect(store.loadYeaftHistoryOutline()).toBe(true);
    expect(store._sent.at(-1)).toMatchObject({
      type: 'yeaft_load_history_outline', agentId: 'agent-a', sessionId: 'same', limit: 50, includeTotal: true,
    });
    const requestId = store._sent.at(-1).requestId;
    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a', sessionId: 'same', requestId: 'stale', results: [],
    })).toBe(false);
    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a', sessionId: 'same', requestId,
      results: [{ messageId: 'm50', seq: 50, role: 'assistant', snippet: 'latest' }],
      hasMore: true, nextBeforeSeq: 50, totalCount: 75,
    })).toBe(true);
    expect(store.loadYeaftHistoryOutline()).toBe(true);
    expect(store._sent).toHaveLength(1);
    expect(store.loadYeaftHistoryOutline({ append: true })).toBe(true);
    expect(store._sent.at(-1)).toMatchObject({ beforeSeq: 50, includeTotal: false });
  });

  it('merges optimistic and persisted rows by clientMessageId', () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = [{
      id: 'client-1', messageId: 'client-1', clientMessageId: 'client-1', type: 'user', content: 'hello',
      sessionId: 'same', timestamp: 100,
    }];
    store.yeaftHistoryOutlineBySession[yeaftHistoryIdentityKey('agent-a', 'same')] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [{ messageId: 'm1', clientMessageId: 'client-1', seq: 1, role: 'user', snippet: 'hello' }],
      hasMore: false, nextBeforeSeq: null, totalCount: 1, error: null,
    };
    const state = store.getYeaftHistoryOutlineState();
    expect(state.results).toHaveLength(1);
    expect(state.results[0].messageId).toBe('m1');
    expect(state.totalCount).toBe(1);
  });

  it('keeps an authoritative 50-entry page bounded when older persisted rows are cached', () => {
    const store = primeStore();
    const authoritative = Array.from({ length: 50 }, (_, index) => ({
      messageId: `m${index + 51}`,
      seq: index + 51,
      role: index % 2 ? 'assistant' : 'user',
      ...(index % 2 ? { turnId: `response-${index}` } : {}),
      snippet: `recent ${index}`,
    }));
    store.messagesMap['conv-a'] = [
      { id: 'm1', messageId: 'm1', type: 'user', content: 'cached old user', sessionId: 'same', isHistory: true },
      { id: 'm2', messageId: 'm2', type: 'assistant', content: 'cached old assistant', sessionId: 'same', isHistory: true, turnId: 'old-response' },
      { id: 'client-new', messageId: 'client-new', clientMessageId: 'client-new', type: 'user', content: 'optimistic tail', sessionId: 'same' },
    ];
    store.yeaftHistoryOutlineBySession[yeaftHistoryIdentityKey('agent-a', 'same')] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: authoritative, hasMore: true, nextBeforeSeq: 51, totalCount: 75, error: null,
    };

    const state = store.getYeaftHistoryOutlineState();

    expect(state.results).toHaveLength(51);
    expect(state.results.some(result => result.messageId === 'm1' || result.messageId === 'm2')).toBe(false);
    expect(state.results.at(-1)).toMatchObject({ messageId: 'client-new', role: 'user' });
    expect(state.totalCount).toBe(76);
  });

  it('reveals a tool-only response through its persisted anchor', () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = [{
      id: 'm42:tool-summary',
      messageId: 'm42:tool-summary',
      persistedMessageId: 'm42',
      type: 'tool-summary',
      sessionId: 'same',
      turnId: 'response-tool-only',
    }];

    expect(store.revealYeaftMessage('same', 'm42')).toBe(true);
  });

  it('merges only one in-flight assistant response per turn', () => {
    const store = primeStore();
    store.messagesMap['conv-a'] = [
      { id: 'live-a', messageId: 'live-a', type: 'assistant', content: 'working ', sessionId: 'same', turnId: 'response-live', speakerVpId: 'maker', isStreaming: true },
      { id: 'live-b', messageId: 'live-b', type: 'assistant', content: 'done', sessionId: 'same', turnId: 'response-live', speakerVpId: 'maker', isStreaming: true },
    ];
    store.yeaftHistoryOutlineBySession[yeaftHistoryIdentityKey('agent-a', 'same')] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };

    const state = store.getYeaftHistoryOutlineState();

    expect(state.results).toHaveLength(1);
    expect(state.results[0]).toMatchObject({ role: 'assistant', turnId: 'response-live' });
    expect(state.totalCount).toBe(1);
  });
});
