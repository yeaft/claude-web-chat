import { describe, expect, it, vi } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {
  defineStore: () => () => ({}),
};
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { answerUserQuestion } = await import('../../web/stores/helpers/conversation.js');

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
      answers: { Continue: 'Yes' },
      sessionId: 'session-a',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
    });
    expect(store.messagesMap['yeaft-a'][0].askAnswered).toBe(true);
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
});
