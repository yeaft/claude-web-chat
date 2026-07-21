import { afterEach, describe, expect, it, vi } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {
  defineStore: () => () => ({}),
};
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { answerUserQuestion } = await import('../../web/stores/helpers/conversation.js');

afterEach(() => {
  vi.useRealTimers();
});

describe('Yeaft AskUser card routing', () => {
  it('submits the answer with the exact Session and VP turn context', () => {
    const sendWsMessage = vi.fn();
    const store = {
      currentView: 'yeaft',
      currentConversation: null,
      currentAgent: 'agent-a',
      yeaftAgentId: 'agent-a',
      yeaftActiveSessionFilter: 'session-a',
      messagesMap: {
        'yeaft-a': [{
          type: 'tool-use',
          toolName: 'AskUserQuestion',
          toolId: 'call-1',
          askRequestId: 'ask-1',
          sessionId: 'session-a',
          vpId: 'vp-a',
          turnId: 'turn-a',
          threadId: 'thread-a',
        }],
      },
      processingConversations: {},
      _closedAt: {},
      sendWsMessage,
      getOrCreateExecutionStatus: vi.fn(),
    };

    answerUserQuestion(store, 'ask-1', { Continue: 'Yes' }, 'yeaft-a');

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'yeaft_ask_user_answer',
      agentId: 'agent-a',
      conversationId: 'yeaft-a',
      requestId: 'ask-1',
      toolCallId: 'call-1',
      answers: { Continue: 'Yes' },
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
    });
    expect(store.messagesMap['yeaft-a'][0].askAnswered).toBeUndefined();
  });

  it('routes a Session card through its owning Agent after the page switches Agents', () => {
    const sendWsMessage = vi.fn(() => true);
    const row = {
      type: 'tool-use',
      toolName: 'AskUserQuestion',
      toolId: 'call-owned',
      askRequestId: 'ask-owned',
      sessionId: 'session-owned',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
    };
    const store = {
      currentView: 'yeaft',
      currentAgent: 'agent-visible',
      yeaftAgentId: 'agent-visible',
      yeaftActiveSessionFilter: 'session-visible',
      messagesMap: { 'yeaft-owner': [row] },
      processingConversations: {},
      _closedAt: {},
      agentIdForSession: vi.fn(() => 'agent-owner'),
      sendWsMessage,
      getOrCreateExecutionStatus: vi.fn(),
    };

    answerUserQuestion(store, 'ask-owned', { Continue: 'Yes' }, 'yeaft-owner');

    expect(store.agentIdForSession).toHaveBeenCalledWith('session-owned');
    expect(sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_ask_user_answer',
      agentId: 'agent-owner',
      sessionId: 'session-owned',
    }));
  });

  it('keeps the Claude Code provider protocol unchanged', () => {
    const sendWsMessage = vi.fn();
    const store = {
      currentView: 'chat',
      currentConversation: 'chat-a',
      messagesMap: { 'chat-a': [] },
      processingConversations: {},
      _closedAt: {},
      sendWsMessage,
      getOrCreateExecutionStatus: vi.fn(),
    };

    answerUserQuestion(store, 'ask-chat', { Continue: 'Yes' }, 'chat-a');

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'ask_user_answer',
      conversationId: 'chat-a',
      requestId: 'ask-chat',
      answers: { Continue: 'Yes' },
    });
  });

  it('keeps a Yeaft card pending until the agent broadcasts the winning answer', () => {
    const sendWsMessage = vi.fn();
    const row = {
      type: 'tool-use',
      toolName: 'AskUserQuestion',
      toolId: 'call-shared',
      askRequestId: 'ask-shared',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
    };
    const store = {
      currentView: 'yeaft',
      currentAgent: 'agent-a',
      yeaftAgentId: 'agent-a',
      yeaftActiveSessionFilter: 'session-a',
      messagesMap: { 'yeaft-a': [row] },
      processingConversations: {},
      _closedAt: {},
      sendWsMessage,
      getOrCreateExecutionStatus: vi.fn(),
    };

    answerUserQuestion(store, 'ask-shared', { Continue: 'Yes' }, 'yeaft-a');

    expect(row.askAnswered).toBeUndefined();
    expect(row.selectedAnswers).toBeUndefined();
    expect(row.askRequestId).toBe('ask-shared');
  });

  it('keeps the submitted answer on the message row while the agent confirms it', () => {
    const sendWsMessage = vi.fn(() => true);
    const row = {
      type: 'tool-use',
      toolName: 'AskUserQuestion',
      toolId: 'call-pending',
      askRequestId: 'ask-pending',
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
    };
    const store = {
      currentView: 'yeaft',
      currentAgent: 'agent-a',
      yeaftAgentId: 'agent-a',
      yeaftActiveSessionFilter: 'session-a',
      messagesMap: { 'yeaft-a': [row] },
      processingConversations: {},
      _closedAt: {},
      sendWsMessage,
      getOrCreateExecutionStatus: vi.fn(),
    };

    answerUserQuestion(store, 'ask-pending', { Continue: 'Yes' }, 'yeaft-a');

    expect(row).toMatchObject({
      askPending: true,
      pendingAnswers: { Continue: 'Yes' },
      askRequestId: 'ask-pending',
    });
    expect(Number.isFinite(row.askSubmitGeneration)).toBe(true);

    answerUserQuestion(store, 'ask-pending', { Continue: 'No' }, 'yeaft-a');
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
    expect(row.pendingAnswers).toEqual({ Continue: 'Yes' });
  });

  it('keeps the card interactive when the answer could not be sent', () => {
    const row = {
      type: 'tool-use',
      toolName: 'AskUserQuestion',
      toolId: 'call-unsent',
      askRequestId: 'ask-unsent',
      sessionId: 'session-a',
    };
    const store = {
      currentView: 'yeaft',
      currentAgent: 'agent-a',
      yeaftActiveSessionFilter: 'session-a',
      messagesMap: { 'yeaft-a': [row] },
      processingConversations: {},
      _closedAt: {},
      sendWsMessage: vi.fn(() => false),
      getOrCreateExecutionStatus: vi.fn(),
    };

    answerUserQuestion(store, 'ask-unsent', { Continue: 'Yes' }, 'yeaft-a');

    expect(row.askPending).toBeUndefined();
    expect(row.pendingAnswers).toBeUndefined();
  });

  it('rolls back an unconfirmed submission after the acknowledgement window', () => {
    vi.useFakeTimers();
    const row = {
      type: 'tool-use',
      toolName: 'AskUserQuestion',
      toolId: 'call-timeout',
      askRequestId: 'ask-timeout',
      sessionId: 'session-a',
    };
    const store = {
      currentView: 'yeaft',
      currentAgent: 'agent-a',
      messagesMap: { 'yeaft-a': [row] },
      processingConversations: {},
      _closedAt: {},
      agentIdForSession: vi.fn(() => 'agent-a'),
      sendWsMessage: vi.fn(() => true),
      getOrCreateExecutionStatus: vi.fn(),
    };

    answerUserQuestion(store, 'ask-timeout', { Continue: 'Yes' }, 'yeaft-a');
    expect(row.askPending).toBe(true);

    vi.advanceTimersByTime(10_000);

    expect(row.askPending).toBe(false);
    expect(row.pendingAnswers).toBeNull();
    expect(row.askSubmitGeneration).toBeNull();
    expect(row.askRequestId).toBe('ask-timeout');
  });
});
