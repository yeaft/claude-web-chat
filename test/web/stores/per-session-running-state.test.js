import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStorageData = new Map();

globalThis.localStorage = {
  getItem: vi.fn((key) => localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: vi.fn((key, value) => { localStorageData.set(key, String(value)); }),
  removeItem: vi.fn((key) => { localStorageData.delete(key); }),
};

function createStoreFactory(_id, options) {
  let instance = null;
  return () => {
    if (instance) return instance;
    instance = {
      ...(typeof options.state === 'function' ? options.state() : {}),
    };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, {
        enumerable: true,
        get() { return getter(instance); },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    return instance;
  };
}

globalThis.Pinia = { defineStore: createStoreFactory };
globalThis.Vue = globalThis.Vue || {};
globalThis.window = globalThis.window || { addEventListener: vi.fn(), removeEventListener: vi.fn() };
globalThis.document = globalThis.document || { addEventListener: vi.fn(), removeEventListener: vi.fn() };

const { useChatStore } = await import('../../../web/stores/chat.js');
const { visibleSessionStatusTasks } = await import('../../../web/components/YeaftPage.js');
const { yeaftHistoryIdentityKey } = await import('../../../web/stores/helpers/yeaft-history-identity.js');

function freshStore() {
  const store = useChatStore();
  store.currentView = 'chat';
  store.activeConversations = [];
  store.yeaftActiveSessionFilter = null;
  store.yeaftConversationId = null;
  store.processingConversations = {};
  store.compactStatus = null;
  store.yeaftProcessingSessions = {};
  store.activeVpTurns = {};
  store.stoppingVpTurnIds = {};
  store.messagesMap = {};
  store.yeaftActiveTasksBySession = {};
  store.sendWsMessage = vi.fn(() => true);
  return store;
}

describe('per-session running state', () => {
  beforeEach(() => {
    localStorageData.clear();
  });

  it('keeps Chat running state scoped to the active conversation', () => {
    const store = freshStore();
    store.activeConversations = ['chat-a'];
    store.processingConversations = { 'chat-a': true };

    expect(store.isProcessing).toBe(true);
    expect(store.isConversationProcessing('chat-a')).toBe(true);
    expect(store.isConversationProcessing('chat-b')).toBe(false);

    store.activeConversations = ['chat-b'];

    expect(store.isProcessing).toBe(false);
    expect(store.isConversationProcessing('chat-a')).toBe(true);
    expect(store.isConversationProcessing('chat-b')).toBe(false);
  });

  it('keeps Yeaft running state scoped to the selected session', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftProcessingSessions = { 'session-a': true };
    store.yeaftActiveSessionFilter = 'session-a';

    expect(store.isProcessing).toBe(true);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isYeaftSessionProcessing('session-b')).toBe(false);

    store.yeaftActiveSessionFilter = 'session-b';

    expect(store.isProcessing).toBe(false);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isYeaftSessionProcessing('session-b')).toBe(false);
  });

  it('replays and settles the same AskUser card across devices', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-a';
    store.messagesMap['yeaft-conv'] = [{
      type: 'tool-use',
      toolName: 'AskUser',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      isHistory: true,
    }];

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      event: {
        type: 'ask_user_question',
        requestId: 'ask-shared',
        replay: true,
        createdAt: 100,
        expiresAt: 200,
        questions: [{ question: 'Continue?', options: [] }],
      },
    });

    expect(store.messagesMap['yeaft-conv'][0]).toMatchObject({
      toolName: 'AskUserQuestion',
      askRequestId: 'ask-shared',
      askCreatedAt: 100,
      askExpiresAt: 200,
      isHistory: false,
    });

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      event: {
        type: 'ask_user_answered',
        requestId: 'ask-shared',
        answers: { 'Continue?': 'Yes' },
      },
    });

    expect(store.messagesMap['yeaft-conv'][0]).toMatchObject({
      askRequestId: null,
      askAnswered: true,
      selectedAnswers: { 'Continue?': 'Yes' },
    });
  });

  it('does not reactivate a persisted answered card during pending replay', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-a';
    store.messagesMap['yeaft-conv'] = [{
      type: 'tool-use',
      toolId: 'call-1',
      toolName: 'AskUserQuestion',
      askRequestId: null,
      askAnswered: true,
      selectedAnswers: { 'Continue?': 'Yes' },
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      isHistory: true,
    }];

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      event: {
        type: 'ask_user_question',
        requestId: 'ask-replayed-late',
        toolCallId: 'call-1',
        replay: true,
        questions: [{ question: 'Continue?', options: [] }],
      },
    });

    expect(store.messagesMap['yeaft-conv']).toHaveLength(1);
    expect(store.messagesMap['yeaft-conv'][0]).toMatchObject({
      askRequestId: null,
      askAnswered: true,
      selectedAnswers: { 'Continue?': 'Yes' },
      isHistory: true,
    });
  });

  it('restores an unconfirmed local submission when the Agent replays the pending prompt', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.messagesMap['yeaft-conv'] = [{
      type: 'tool-use',
      toolId: 'call-retry',
      toolName: 'AskUserQuestion',
      askRequestId: 'ask-retry',
      askPending: true,
      pendingAnswers: { 'Continue?': 'Yes' },
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
    }];

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      event: {
        type: 'ask_user_question',
        requestId: 'ask-retry',
        toolCallId: 'call-retry',
        replay: true,
        questions: [{ question: 'Continue?', options: [] }],
      },
    });

    expect(store.messagesMap['yeaft-conv'][0]).toMatchObject({
      askRequestId: 'ask-retry',
      askPending: false,
      pendingAnswers: null,
      agentId: 'agent-a',
    });
  });

  it('settles only the AskUser row matching the complete terminal identity', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.messagesMap['yeaft-conv'] = [
      {
        type: 'tool-use', toolName: 'AskUserQuestion', toolId: 'call-shared', askRequestId: 'ask-shared',
        agentId: 'agent-a', sessionId: 'session-a', vpId: 'vp-a', turnId: 'turn-a', threadId: 'thread-a',
      },
      {
        type: 'tool-use', toolName: 'AskUserQuestion', toolId: 'call-shared', askRequestId: 'ask-shared',
        agentId: 'agent-a', sessionId: 'session-a', vpId: 'vp-b', turnId: 'turn-b', threadId: 'thread-b',
      },
    ];

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-b',
      turnId: 'turn-b',
      threadId: 'thread-b',
      event: {
        type: 'ask_user_answered',
        requestId: 'ask-shared',
        toolCallId: 'call-shared',
        answers: { Choice: 'B' },
      },
    });

    expect(store.messagesMap['yeaft-conv'][0].askAnswered).toBeUndefined();
    expect(store.messagesMap['yeaft-conv'][1]).toMatchObject({
      askRequestId: null,
      askAnswered: true,
      selectedAnswers: { Choice: 'B' },
    });
  });

  it('applies a terminal AskUser event that arrives before its replayed row', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.messagesMap['yeaft-conv'] = [];
    const envelope = {
      agentId: 'agent-a',
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
    };

    store.handleYeaftOutput({
      ...envelope,
      event: {
        type: 'ask_user_answered',
        requestId: 'ask-early-terminal',
        toolCallId: 'call-early-terminal',
        answers: { Continue: 'Yes' },
      },
    });
    store.handleYeaftOutput({
      ...envelope,
      event: {
        type: 'ask_user_question',
        requestId: 'ask-early-terminal',
        toolCallId: 'call-early-terminal',
        replay: true,
        questions: [{ question: 'Continue?', options: [] }],
      },
    });

    expect(store.messagesMap['yeaft-conv']).toEqual([
      expect.objectContaining({
        toolId: 'call-early-terminal',
        askRequestId: null,
        askAnswered: true,
        selectedAnswers: { Continue: 'Yes' },
        agentId: 'agent-a',
        sessionId: 'session-a',
        vpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
      }),
    ]);
  });

  it('creates a replayed AskUser card when recent history omitted the tool row', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-a';
    store.messagesMap['yeaft-conv'] = [];

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      event: {
        type: 'ask_user_question',
        requestId: 'ask-replay-only',
        replay: true,
        createdAt: 100,
        expiresAt: 200,
        questions: [{ question: 'Choose', options: [] }],
      },
    });

    expect(store.messagesMap['yeaft-conv']).toEqual([
      expect.objectContaining({
        type: 'tool-use',
        toolName: 'AskUserQuestion',
        askRequestId: 'ask-replay-only',
        sessionId: 'session-a',
        vpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
        isHistory: false,
      }),
    ]);
  });

  it('does not advance the durable cursor past a pending AskUser on later live text', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-a';
    store.yeaftSessionHistoryState = {
      'agent-a\u001fsession-a': { loaded: true, latestSeq: 40 },
    };
    store.messagesMap['yeaft-conv'] = [{
      type: 'tool-use',
      toolName: 'AskUserQuestion',
      toolId: 'call-pending',
      askRequestId: 'ask-pending',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      hasResult: false,
    }];
    const originalOutputHandler = store.handleAssistantOutputFrame;
    store.handleAssistantOutputFrame = vi.fn();

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-b',
      turnId: 'turn-b',
      threadId: 'thread-b',
      data: {
        type: 'assistant',
        message: { id: '000042-assistant', content: [{ type: 'text', text: 'sibling output' }] },
      },
    });

    expect(store.yeaftSessionHistoryState['agent-a\u001fsession-a'].latestSeq).toBe(40);
    store.handleAssistantOutputFrame = originalOutputHandler;
  });

  it('leaves the durable cursor at the last pair-safe row when a tool result arrives', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-a';
    store.yeaftSessionHistoryState = {
      'agent-a\u001fsession-a': { loaded: true, latestSeq: 40 },
    };
    store.messagesMap['yeaft-conv'] = [
      {
        type: 'tool-use',
        id: '000041-tool-use',
        messageId: '000041-tool-use',
        toolName: 'AskUserQuestion',
        toolId: 'call-result',
        askRequestId: 'ask-result',
        sessionId: 'session-a',
        hasResult: false,
      },
      {
        type: 'assistant',
        id: '000042-assistant',
        messageId: '000042-assistant',
        sessionId: 'session-a',
        content: 'sibling output',
      },
    ];
    const originalOutputHandler = store.handleAssistantOutputFrame;
    store.handleAssistantOutputFrame = vi.fn();

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      data: {
        type: 'user',
        message: {
          id: '000043-tool',
          content: [{ type: 'tool_result', tool_use_id: 'call-result', content: '{"answers":{"Continue?":"Yes"}}' }],
        },
      },
    });

    expect(store.yeaftSessionHistoryState['agent-a\u001fsession-a'].latestSeq).toBe(40);
    store.handleAssistantOutputFrame = originalOutputHandler;
  });

  it('does not settle an ambiguous legacy terminal event', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.messagesMap['yeaft-conv'] = [
      { type: 'tool-use', toolName: 'AskUserQuestion', askRequestId: 'ask-legacy', sessionId: 'session-a', vpId: 'vp-a' },
      { type: 'tool-use', toolName: 'AskUserQuestion', askRequestId: 'ask-legacy', sessionId: 'session-a', vpId: 'vp-b' },
    ];

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      event: { type: 'ask_user_answered', requestId: 'ask-legacy', answers: { Continue: 'Yes' } },
    });

    expect(store.messagesMap['yeaft-conv'].every(row => !row.askAnswered)).toBe(true);
    expect(Object.keys(store._yeaftAskTerminalEvents)).toHaveLength(1);
  });

  it('marks an expired AskUser card without moving the visible Session', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-visible';
    store.messagesMap['yeaft-conv'] = [{
      type: 'tool-use',
      toolName: 'AskUserQuestion',
      askRequestId: 'ask-expire',
      sessionId: 'session-background',
    }];

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-background',
      event: { type: 'ask_user_expired', requestId: 'ask-expire' },
    });

    expect(store.yeaftActiveSessionFilter).toBe('session-visible');
    expect(store.messagesMap['yeaft-conv'][0]).toMatchObject({
      askRequestId: null,
      askExpired: true,
      isHistory: true,
    });
  });

  it('does not advance the durable delta cursor on a live tool-use row', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-a';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-a';
    store.yeaftSessionHistoryState = {
      'agent-a\u001fsession-a': { loaded: true, latestSeq: 40 },
    };

    store.handleYeaftOutput({
      agentId: 'agent-a',
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      data: {
        type: 'assistant',
        message: {
          id: '000041-assistant',
          content: [{ type: 'tool_use', id: 'call-41', name: 'AskUser', input: {} }],
        },
      },
    });

    expect(store.yeaftSessionHistoryState['agent-a\u001fsession-a'].latestSeq).toBe(40);
  });

  it('keeps Yeaft active while any VP turn in that session is unfinished', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftActiveSessionFilter = 'session-a';

    store.handleYeaftOutput({ event: { type: 'vp_turn_start', sessionId: 'session-a', vpId: 'vp-a', turnId: 'turn-a', ts: 1 } });
    store.handleYeaftOutput({ event: { type: 'vp_turn_start', sessionId: 'session-a', vpId: 'vp-b', turnId: 'turn-b', ts: 2 } });

    expect(store.isProcessing).toBe(true);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);

    store.handleYeaftOutput({ event: { type: 'vp_turn_end', sessionId: 'session-a', vpId: 'vp-a', turnId: 'turn-a', reason: 'end_turn' } });

    expect(store.isProcessing).toBe(true);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);

    store.handleYeaftOutput({ event: { type: 'vp_turn_end', sessionId: 'session-a', vpId: 'vp-b', turnId: 'turn-b', reason: 'end_turn' } });

    expect(store.isProcessing).toBe(false);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(false);
  });

  it('keeps Yeaft input in stop mode when broker status is running before vp_turn_start', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftActiveSessionFilter = 'session-a';

    store.handleYeaftOutput({ event: {
      type: 'vp_status_changed',
      sessionId: 'session-a',
      vpId: 'vp-a',
      state: 'typing',
      turnId: 'queued-turn-a',
      since: 10,
    } });

    expect(store.activeVpTurns).toEqual({});
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isProcessing).toBe(true);

    store.handleYeaftOutput({ event: {
      type: 'vp_status_changed',
      sessionId: 'session-a',
      vpId: 'vp-a',
      state: 'idle',
      turnId: null,
      since: 20,
    } });

    expect(store.isYeaftSessionProcessing('session-a')).toBe(false);
    expect(store.isProcessing).toBe(false);
  });

  it('keeps Yeaft input in stop mode from a running VP status snapshot', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftActiveSessionFilter = 'session-a';

    store.handleYeaftOutput({ event: {
      type: 'vp_status_snapshot',
      sessionId: 'session-a',
      statuses: [{ sessionId: 'session-a', vpId: 'vp-a', state: 'tool', turnId: 'turn-a', since: 10 }],
    } });

    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isProcessing).toBe(true);

    store.handleYeaftOutput({ event: {
      type: 'vp_status_snapshot',
      sessionId: 'session-a',
      statuses: [{ sessionId: 'session-a', vpId: 'vp-a', state: 'idle', turnId: null, since: 20 }],
    } });

    expect(store.isYeaftSessionProcessing('session-a')).toBe(false);
    expect(store.isProcessing).toBe(false);
  });

  it('keeps the active Agent history cursor intact when history_loaded arrives late for a same-id Session', () => {
    const store = freshStore();
    const sessionId = 'session_default';
    const agentAKey = yeaftHistoryIdentityKey('agent-a', sessionId);
    const agentBKey = yeaftHistoryIdentityKey('agent-b', sessionId);
    store.currentView = 'yeaft';
    store.currentAgent = 'agent-b';
    store.yeaftActiveSessionFilter = sessionId;
    store.yeaftLoadingMoreHistory = true;
    store.yeaftHasMoreHistory = true;
    store.yeaftOldestLoadedSeq = 10;
    store.yeaftSessionHistoryState = {
      [agentAKey]: { loaded: true, loading: true, latestSeq: 7, hasMore: true, oldestSeq: 3 },
      [agentBKey]: { loaded: true, loading: true, latestSeq: 20, hasMore: true, oldestSeq: 10 },
    };

    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: {
        type: 'history_loaded',
        sessionId,
        mode: 'recent',
        latestSeq: 1,
        oldestSeq: 1,
        hasMore: false,
        count: 1,
      },
    });

    expect(store.yeaftSessionHistoryState[agentAKey]).toEqual(expect.objectContaining({
      loading: false, latestSeq: 1, hasMore: false, oldestSeq: 1,
    }));
    expect(store.yeaftSessionHistoryState[agentBKey]).toEqual({
      loaded: true, loading: true, latestSeq: 20, hasMore: true, oldestSeq: 10,
    });
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(10);
    expect(store.yeaftLoadingMoreHistory).toBe(true);
  });

  it('clears Yeaft session running state on terminal result when metadata end is missed', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-a';
    store.processingConversations = { 'yeaft-conv': true };
    store.yeaftProcessingSessions = { 'session-a': true };
    store.activeVpTurns = {
      'turn-a': { sessionId: 'session-a', vpId: 'vp-a', startedAt: 1 },
    };
    store.vpStatuses = {
      'session-a::vp-a': { sessionId: 'session-a', vpId: 'vp-a', state: 'streaming', turnId: 'turn-a' },
    };

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      data: { type: 'result', result_text: '' },
    });

    expect(store.activeVpTurns['turn-a']).toBeUndefined();
    expect(store.vpStatuses['session-a::vp-a']).toEqual(expect.objectContaining({ state: 'idle', turnId: null }));
    expect(store.processingConversations['yeaft-conv']).toBeUndefined();
    expect(store.isYeaftSessionProcessing('session-a')).toBe(false);
    expect(store.isProcessing).toBe(false);
  });

  it('does not clear Yeaft session running state while sibling VP result is still active', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-a';
    store.processingConversations = { 'yeaft-conv': true };
    store.yeaftProcessingSessions = { 'session-a': true };
    store.activeVpTurns = {
      'turn-a': { sessionId: 'session-a', vpId: 'vp-a', startedAt: 1 },
      'turn-b': { sessionId: 'session-a', vpId: 'vp-b', startedAt: 2 },
    };

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      data: { type: 'result', result_text: '' },
    });

    expect(store.activeVpTurns['turn-a']).toBeUndefined();
    expect(store.activeVpTurns['turn-b']).toEqual(expect.objectContaining({ sessionId: 'session-a' }));
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isProcessing).toBe(true);
  });

  it('keeps recently completed task snapshots visible to the Session status pane', () => {
    const store = freshStore();
    store.yeaftActiveSessionFilter = 'session-a';

    store.handleYeaftOutput({ event: { type: 'yeaft_task_event', task: {
      id: 'task-1',
      sessionId: 'session-a',
      kind: 'sub_agent',
      status: 'running',
      createdAt: '2026-06-19T10:00:00.000Z',
      updatedAt: '2026-06-19T10:00:00.000Z',
    } } });
    store.handleYeaftOutput({ event: { type: 'yeaft_task_event', task: {
      id: 'task-1',
      sessionId: 'session-a',
      kind: 'sub_agent',
      status: 'succeeded',
      createdAt: '2026-06-19T10:00:00.000Z',
      updatedAt: '2026-06-19T10:00:02.000Z',
      endedAt: '2026-06-19T10:00:02.000Z',
      result: { summary: 'final answer from task snapshot' },
    } } });

    const paneTasks = visibleSessionStatusTasks(store.yeaftActiveTasksBySession['session-a']);

    expect(paneTasks).toHaveLength(1);
    expect(paneTasks[0]).toMatchObject({
      id: 'task-1',
      status: 'succeeded',
      result: { summary: 'final answer from task snapshot' },
    });
  });

  it('keeps background task stop pending until terminal task event', () => {
    const store = freshStore();
    store.yeaftSessionAgentById = { 'session-a': 'agent-a' };

    const sent = store.cancelYeaftTask({ sessionId: 'session-a', taskId: 'task-1' });

    expect(sent).toBe(true);
    expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_task_cancel',
      agentId: 'agent-a',
      sessionId: 'session-a',
      taskId: 'task-1',
    }));
    expect(store.yeaftStoppingTasksById['session-a::task-1']).toBe(true);

    store.handleYeaftOutput({ event: { type: 'yeaft_task_cancel_result', success: true, taskId: 'task-1', task: {
      id: 'task-1',
      sessionId: 'session-a',
      kind: 'shell',
      status: 'running',
      runtime: { pid: 123, cancelRequestedAt: '2026-06-20T10:00:00.000Z' },
    } } });
    expect(store.yeaftStoppingTasksById['session-a::task-1']).toBe(true);

    store.handleYeaftOutput({ event: { type: 'yeaft_task_event', task: {
      id: 'task-1',
      sessionId: 'session-a',
      kind: 'shell',
      status: 'cancelled',
      runtime: { pid: 123, cancelRequestedAt: '2026-06-20T10:00:00.000Z' },
    } } });
    expect(store.yeaftStoppingTasksById['session-a::task-1']).toBeUndefined();
  });

  it('clears background task stop pending on cancel request failure', () => {
    const store = freshStore();
    store.yeaftStoppingTasksById = { 'session-a::task-1': true };

    store.handleYeaftOutput({ event: {
      type: 'yeaft_task_cancel_result',
      success: false,
      taskId: 'task-1',
      task: { id: 'task-1', sessionId: 'session-a', kind: 'shell', status: 'running' },
    } });

    expect(store.yeaftStoppingTasksById['session-a::task-1']).toBeUndefined();
  });

  it('appends async task completion updates to the originating tool result', () => {
    const store = freshStore();
    store.yeaftConversationId = 'yeaft-conv';
    store.currentView = 'yeaft';

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      data: {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'spawn-1', name: 'SpawnAgent', input: { name: 'worker' } }] },
      },
    });
    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      data: {
        type: 'user',
        tool_use_result: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: 'Started background task task-1.' }],
      },
    });
    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      data: {
        type: 'user',
        tool_use_result: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: '<task-result id="task-1">done</task-result>', is_update: true }],
      },
    });

    const tools = store.messagesMap['yeaft-conv'].filter(msg => msg.type === 'tool-use');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolId: 'spawn-1', toolName: 'SpawnAgent', hasResult: true });
    expect(tools[0].toolResult).toContain('Started background task task-1.');
    expect(tools[0].toolResult).toContain('<task-result id="task-1">done</task-result>');
  });

  it('sorts running tasks before recent terminal task snapshots', () => {
    const tasks = visibleSessionStatusTasks({
      done: { id: 'done', status: 'succeeded', updatedAt: '2026-06-19T10:00:03.000Z' },
      running: { id: 'running', status: 'running', updatedAt: '2026-06-19T10:00:01.000Z' },
    });

    expect(tasks.map(task => task.id)).toEqual(['running', 'done']);
  });

  it('does not expose direct user-to-sub-agent prompt sending from the web store', () => {
    const store = freshStore();

    expect(store.sendYeaftSubAgentPrompt).toBeUndefined();
    expect(store.yeaftSubAgentPromptResults).toBeUndefined();
  });

  it('keeps Chat compacting state scoped to the active conversation', () => {
    const store = freshStore();
    store.currentView = 'chat';
    store.activeConversations = ['chat-a'];
    store.compactStatus = { conversationId: 'chat-a', status: 'compacting', message: 'Compacting...' };

    expect(store.isConversationCompacting('chat-a')).toBe(true);
    expect(store.isConversationCompacting('chat-b')).toBe(false);

    store.activeConversations = ['chat-b'];

    expect(store.isConversationCompacting(store.activeConversationId)).toBe(false);
  });

  it('does not let Chat compacting state leak into Yeaft input state', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-b';
    store.compactStatus = { conversationId: 'chat-a', status: 'compacting', message: 'Compacting...' };
    store.processingConversations = { 'chat-a': true };

    expect(store.isConversationCompacting('chat-a')).toBe(true);
    expect(store.isConversationCompacting(store.yeaftConversationId)).toBe(false);
    expect(store.isProcessing).toBe(false);

    store.yeaftProcessingSessions = { 'session-b': true };

    expect(store.isProcessing).toBe(true);
  });
});
