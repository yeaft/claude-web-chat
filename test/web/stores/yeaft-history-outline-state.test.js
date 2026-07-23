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
const { handleAssistantOutputFrame } = await import('../../../web/stores/helpers/assistantOutput.js');
const { handleYeaftHistoryWindow: mergeYeaftHistoryWindow } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');
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

  it('merges an old anchor into the authoritative conversation and expands its render window', async () => {
    const store = primeStore();
    store.currentAgentInfo.capabilities.push('session_history_search');
    store.agents[0].capabilities.push('session_history_search');
    store.messagesMap['conv-a'] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 50}`,
      messageId: `m${index + 50}`,
      type: index % 2 ? 'assistant' : 'user',
      content: `recent ${index}`,
      sessionId: 'same',
      timestamp: index + 50,
    }));

    const pending = store.loadYeaftHistoryWindow({ messageId: 'm42', seq: 42 });
    const request = store._sent.at(-1);
    const response = {
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: request.requestId,
      messages: [{ id: 'm42', role: 'assistant', content: 'old answer', createdAt: 42 }],
    };
    const conversationId = mergeYeaftHistoryWindow(store, response);

    expect(conversationId).toBe('conv-a');
    expect(store.messagesMap['conv-a'].some(row => row.persistedMessageId === 'm42' || row.messageId === 'm42')).toBe(true);
    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(store.yeaftMessageWindowState[store.getYeaftMessageWindowKey('same')].visibleTurns).toBeGreaterThan(5);
  });

  it('rejects a history window when the merged conversation lacks the requested anchor', async () => {
    const store = primeStore();
    const pending = store.loadYeaftHistoryWindow({ messageId: 'm42', seq: 42 });
    const request = store._sent.at(-1);
    const response = {
      agentId: 'agent-a',
      sessionId: 'same',
      requestId: request.requestId,
      messages: [{ id: 'm41', role: 'assistant', content: 'neighbor', createdAt: 41 }],
    };
    const conversationId = mergeYeaftHistoryWindow(store, response);

    expect(store.handleYeaftHistoryWindow(response, conversationId)).toBe(false);
    await expect(pending).resolves.toBe(false);
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

  it('promotes a completed assistant response into the loaded authoritative cache', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.messagesMap['conv-a'] = [
      {
        id: 'm41', messageId: 'm41', type: 'assistant', content: 'first part',
        sessionId: 'same', turnId: 'response-live', speakerVpId: 'maker', isStreaming: true, status: 'pending',
      },
      {
        id: 'm42', messageId: 'm42', type: 'assistant', content: 'finished answer',
        sessionId: 'same', turnId: 'response-live', speakerVpId: 'maker', isStreaming: true, status: 'pending',
      },
    ];
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };
    store._currentYeaftSessionId = 'same';
    store._currentYeaftTurnId = 'response-live';
    store._currentYeaftVpId = 'maker';
    store.processingConversations = { 'conv-a': true };
    store.activeVpTurns = {};
    store.executionStatusMap = {};
    store.conversations = [];
    store.vpStatuses = {};
    store._turnCompletedConvs = new Set();

    expect(store.getYeaftHistoryOutlineState().results).toHaveLength(1);
    handleAssistantOutputFrame(store, 'conv-a', { type: 'result', result_text: '' });

    expect(store.messagesMap['conv-a'][0].isStreaming).toBe(false);
    expect(store.yeaftHistoryOutlineBySession[key].results).toEqual([
      expect.objectContaining({
        messageId: 'm42', seq: 42, role: 'assistant', turnId: 'response-live', snippet: 'first part finished answer',
      }),
    ]);
    expect(store.getYeaftHistoryOutlineState().results).toHaveLength(1);
    expect(store.loadYeaftHistoryOutline()).toBe(true);
    expect(store._sent).toHaveLength(0);
  });

  it('force-refreshes a loaded visible outline when a completed response has no durable anchor yet', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.messagesMap['conv-a'] = [{
      id: 'local-answer', messageId: 'local-answer', type: 'assistant', content: 'finished answer',
      sessionId: 'same', turnId: 'response-local', speakerVpId: 'maker', isStreaming: true, status: 'pending',
    }];
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };
    store._currentYeaftSessionId = 'same';
    store._currentYeaftTurnId = 'response-local';
    store._currentYeaftVpId = 'maker';
    store.processingConversations = { 'conv-a': true };
    store.activeVpTurns = {};
    store.executionStatusMap = {};
    store.conversations = [];
    store.vpStatuses = {};
    store._turnCompletedConvs = new Set();

    handleAssistantOutputFrame(store, 'conv-a', { type: 'result', result_text: '' });

    expect(store._sent).toHaveLength(1);
    expect(store._sent[0]).toMatchObject({
      type: 'yeaft_load_history_outline', agentId: 'agent-a', sessionId: 'same', includeTotal: true,
    });
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({ loaded: false, loading: true });
  });

  it('queues one fresh first-page request after an older-page request settles', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.messagesMap['conv-a'] = [{
      id: 'local-answer', messageId: 'local-answer', type: 'assistant', content: 'finished answer',
      sessionId: 'same', turnId: 'response-local', speakerVpId: 'maker', isStreaming: true, status: 'pending',
    }];
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: true,
      requestId: 'older-request', requestAppend: true, refreshPending: false,
      results: [{ messageId: 'm50', seq: 50, role: 'user', snippet: 'cached row' }],
      hasMore: true, nextBeforeSeq: 50, totalCount: 75, error: null,
    };
    store._currentYeaftSessionId = 'same';
    store._currentYeaftTurnId = 'response-local';
    store._currentYeaftVpId = 'maker';
    store.processingConversations = { 'conv-a': true };
    store.activeVpTurns = {};
    store.executionStatusMap = {};
    store.conversations = [];
    store.vpStatuses = {};
    store._turnCompletedConvs = new Set();

    handleAssistantOutputFrame(store, 'conv-a', { type: 'result', result_text: '' });

    expect(store._sent).toHaveLength(0);
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      loaded: true, loading: true, refreshPending: true, requestId: 'older-request',
    });

    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a', sessionId: 'same', requestId: 'older-request',
      results: [{ messageId: 'm25', seq: 25, role: 'user', snippet: 'older row' }],
      hasMore: false, nextBeforeSeq: null,
    })).toBe(true);

    expect(store._sent).toHaveLength(1);
    expect(store._sent[0]).toMatchObject({
      type: 'yeaft_load_history_outline', agentId: 'agent-a', sessionId: 'same', includeTotal: true,
    });
    expect(store._sent[0]).not.toHaveProperty('beforeSeq');
    const freshRequestId = store._sent[0].requestId;
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      loaded: false, loading: true, refreshPending: false, requestId: freshRequestId,
    });

    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a', sessionId: 'same', requestId: freshRequestId,
      results: [{ messageId: 'm51', seq: 51, role: 'assistant', turnId: 'response-local', snippet: 'finished answer' }],
      hasMore: false, nextBeforeSeq: null, totalCount: 76,
    })).toBe(true);

    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      loaded: true, loading: false, refreshPending: false, totalCount: 76,
    });
    expect(store.yeaftHistoryOutlineBySession[key].results).toEqual([
      expect.objectContaining({ messageId: 'm51', turnId: 'response-local' }),
    ]);
    expect(store.loadYeaftHistoryOutline()).toBe(true);
    expect(store._sent).toHaveLength(1);
  });

  it('marks an in-flight outline dirty when a durable user echo cannot promote immediately', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.messagesMap['conv-a'] = [{
      id: 'client-1', messageId: 'client-1', clientMessageId: 'client-1', type: 'user', content: 'hello',
      sessionId: 'same', turnId: 'client-1', timestamp: 100,
    }];
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: true,
      requestId: 'older-request', requestAppend: true, refreshPending: false,
      results: [], hasMore: true, nextBeforeSeq: 50, totalCount: 75, error: null,
    };
    store.executionStatusMap = {};
    store.conversations = [];
    store.processingConversations = {};

    handleAssistantOutputFrame(store, 'conv-a', {
      type: 'user',
      message: { id: 'm76', clientMessageId: 'client-1', content: 'hello' },
      dbMessageId: 'm76',
      clientMessageId: 'client-1',
      ts: '2026-07-23T00:00:00Z',
    });

    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      loading: true, refreshPending: true, requestId: 'older-request',
    });
    expect(store._sent).toHaveLength(0);
  });

  it('queues a refresh during the initial in-flight load without looping', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: false, loading: true,
      requestId: 'initial-request', requestAppend: false, refreshPending: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: null, error: null,
    };

    expect(store.invalidateYeaftHistoryOutline('same')).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[key].refreshPending).toBe(true);
    expect(store._sent).toHaveLength(0);

    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a', sessionId: 'same', requestId: 'initial-request',
      results: [{ messageId: 'm40', seq: 40, role: 'user', snippet: 'stale initial row' }],
      hasMore: false, nextBeforeSeq: null, totalCount: 1,
    })).toBe(true);

    expect(store._sent).toHaveLength(1);
    const freshRequestId = store._sent[0].requestId;
    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a', sessionId: 'same', requestId: freshRequestId,
      results: [{ messageId: 'm41', seq: 41, role: 'user', snippet: 'fresh row' }],
      hasMore: false, nextBeforeSeq: null, totalCount: 1,
    })).toBe(true);
    expect(store._sent).toHaveLength(1);
    expect(store.yeaftHistoryOutlineBySession[key].results).toEqual([
      expect.objectContaining({ messageId: 'm41' }),
    ]);
  });

  it('keeps pending refresh state isolated by agent and Session identity', () => {
    const store = primeStore();
    const keyA = yeaftHistoryIdentityKey('agent-a', 'same');
    const keyB = yeaftHistoryIdentityKey('agent-b', 'other');
    store.agents.push({ id: 'agent-b', version: '1.0.201', capabilities: ['session_history_outline'] });
    store.yeaftSessionAgentById.other = 'agent-b';
    store.yeaftHistoryOutlineBySession[keyA] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: true,
      requestId: 'request-a', requestAppend: true, refreshPending: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };
    store.yeaftHistoryOutlineBySession[keyB] = {
      agentId: 'agent-b', sessionId: 'other', loaded: true, loading: true,
      requestId: 'request-b', requestAppend: true, refreshPending: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };

    expect(store.invalidateYeaftHistoryOutline('same')).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[keyA].refreshPending).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[keyB].refreshPending).toBe(false);

    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-b', sessionId: 'other', requestId: 'request-b', results: [],
      hasMore: false, nextBeforeSeq: null,
    })).toBe(true);
    expect(store._sent).toHaveLength(0);

    expect(store.handleYeaftHistoryOutline({
      agentId: 'agent-a', sessionId: 'same', requestId: 'request-a', results: [],
      hasMore: false, nextBeforeSeq: null,
    })).toBe(true);
    expect(store._sent).toHaveLength(1);
    expect(store._sent[0]).toMatchObject({ agentId: 'agent-a', sessionId: 'same' });
  });

  it('consumes one pending refresh after the in-flight request times out', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    expect(store.loadYeaftHistoryOutline()).toBe(true);
    expect(store.invalidateYeaftHistoryOutline('same')).toBe(true);
    expect(store.yeaftHistoryOutlineBySession[key].refreshPending).toBe(true);

    vi.advanceTimersByTime(10000);

    expect(store._sent).toHaveLength(2);
    expect(store._sent[1]).toMatchObject({
      type: 'yeaft_load_history_outline', agentId: 'agent-a', sessionId: 'same', includeTotal: true,
    });
    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      loaded: false, loading: true, refreshPending: false, error: null,
    });
  });

  it('keeps the promoted recent page bounded and exposes the displaced older cursor', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: Array.from({ length: 50 }, (_, index) => ({
        messageId: `m${index + 1}`, seq: index + 1, role: 'user', snippet: `row ${index + 1}`,
      })),
      hasMore: false, nextBeforeSeq: null, totalCount: 50, error: null,
    };

    expect(store.promoteYeaftHistoryOutlineRow({
      id: 'm51', messageId: 'm51', type: 'assistant', content: 'new response',
      sessionId: 'same', turnId: 'response-51', speakerVpId: 'maker',
    })).toBe(true);

    expect(store.yeaftHistoryOutlineBySession[key]).toMatchObject({
      hasMore: true, nextBeforeSeq: 2, totalCount: 51,
    });
    expect(store.yeaftHistoryOutlineBySession[key].results).toHaveLength(50);
    expect(store.yeaftHistoryOutlineBySession[key].results[0].messageId).toBe('m2');
    expect(store.yeaftHistoryOutlineBySession[key].results.at(-1).messageId).toBe('m51');
  });

  it('promotes a durable user echo over its optimistic overlay', () => {
    const store = primeStore();
    const key = yeaftHistoryIdentityKey('agent-a', 'same');
    store.messagesMap['conv-a'] = [{
      id: 'client-1', messageId: 'client-1', clientMessageId: 'client-1', type: 'user', content: 'hello',
      sessionId: 'same', turnId: 'client-1', timestamp: 100,
    }];
    store.yeaftHistoryOutlineBySession[key] = {
      agentId: 'agent-a', sessionId: 'same', loaded: true, loading: false,
      results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0, error: null,
    };
    store.executionStatusMap = {};
    store.conversations = [];
    store.processingConversations = {};

    handleAssistantOutputFrame(store, 'conv-a', {
      type: 'user',
      message: { id: 'm43', clientMessageId: 'client-1', content: 'hello' },
      dbMessageId: 'm43',
      clientMessageId: 'client-1',
      ts: '2026-07-23T00:00:00Z',
    });

    expect(store.yeaftHistoryOutlineBySession[key].results).toEqual([
      expect.objectContaining({ messageId: 'm43', clientMessageId: 'client-1', seq: 43, role: 'user' }),
    ]);
    expect(store.getYeaftHistoryOutlineState().results).toHaveLength(1);
    expect(store.getYeaftHistoryOutlineState().results[0].messageId).toBe('m43');
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
