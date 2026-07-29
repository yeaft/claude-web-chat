import { describe, expect, it, vi } from 'vitest';

globalThis.Pinia = { defineStore: () => () => ({}) };

const { handleSyncMessagesResult } = await import('../../web/stores/helpers/handlers/conversationHandler.js');

function makeStore() {
  const store = {
    messagesMap: { a: [], b: [] },
    activeConversations: ['b'],
    currentConversation: 'b',
    loadingMoreMessages: true,
    refreshingSessionMap: { a: true, b: true },
    chatSessionState: {},
    hasMoreMessages: false,
    chatHistoryRequests: {
      'chat:a': { requestId: 'request-a', catalogKey: 'chat:a', generation: 1, loading: true },
      'chat:b': { requestId: 'request-b', catalogKey: 'chat:b', generation: 1, loading: true },
    },
    formatDbMessageForHistoryHydration: vi.fn(row => ({
      id: `row-${row.id}`,
      dbMessageId: row.id,
      type: row.role,
      content: row.content,
    })),
    isCurrentChatHistoryResponse(msg) {
      const pending = this.chatHistoryRequests[msg.catalogKey];
      return msg.catalogKey === `chat:${msg.conversationId}` && pending?.requestId === msg.requestId;
    },
    finishChatHistoryRequest(msg) {
      if (!this.isCurrentChatHistoryResponse(msg)) return false;
      this.chatHistoryRequests[msg.catalogKey] = {
        ...this.chatHistoryRequests[msg.catalogKey],
        loading: false,
      };
      return true;
    },
    setRefreshingSession(conversationId, value) {
      this.refreshingSessionMap[conversationId] = value;
    },
  };
  return store;
}

describe('Chat history request generation', () => {
  it('ignores a stale response for the same catalog key', () => {
    const store = makeStore();
    const applied = handleSyncMessagesResult(store, {
      type: 'sync_messages_result',
      conversationId: 'a',
      catalogKey: 'chat:a',
      requestId: 'stale-request',
      mode: 'recent',
      messages: [{ id: 1, role: 'user', content: 'stale' }],
      hasMore: false,
    });

    expect(applied).toBe(false);
    expect(store.messagesMap.a).toEqual([]);
    expect(store.refreshingSessionMap.a).toBe(true);
    expect(store.loadingMoreMessages).toBe(true);
  });

  it('updates an inactive cache without clearing the active Session spinner', () => {
    const store = makeStore();
    const applied = handleSyncMessagesResult(store, {
      type: 'sync_messages_result',
      conversationId: 'a',
      catalogKey: 'chat:a',
      requestId: 'request-a',
      mode: 'recent',
      messages: [{ id: 1, role: 'user', content: 'cached' }],
      hasMore: true,
    });

    expect(applied).toBe(true);
    expect(store.messagesMap.a).toHaveLength(0);
    expect(store.chatHistoryRequests['chat:a'].loading).toBe(false);
    expect(store.loadingMoreMessages).toBe(true);
    expect(store.refreshingSessionMap.a).toBe(false);
    expect(store.refreshingSessionMap.b).toBe(true);
  });
});
