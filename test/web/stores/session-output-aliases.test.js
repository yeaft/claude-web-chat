import { describe, it, expect, vi } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {
  defineStore: () => () => ({}),
};

const { handleMessage } = await import('../../../web/stores/helpers/messageHandler.js');

function mkStore() {
  return {
    _lastPongAt: 0,
    handleAssistantOutputFrame: vi.fn(),
    handleYeaftOutput: vi.fn(),
  };
}

describe('assistant/session output aliases', () => {
  it('routes legacy claude_output through the provider-neutral assistant handler', () => {
    const store = mkStore();
    const data = { type: 'assistant', message: { content: 'hi' } };

    handleMessage(store, { type: 'claude_output', conversationId: 'conv-1', data });

    expect(store.handleAssistantOutputFrame).toHaveBeenCalledWith('conv-1', data);
    expect(store.handleYeaftOutput).not.toHaveBeenCalled();
  });

  it('routes neutral Yeaft Session output aliases through the Yeaft handler', () => {
    for (const type of ['yeaft_output', 'yeaft_session_output', 'session_output']) {
      const store = mkStore();
      const msg = { type, conversationId: 'yeaft-1', data: { type: 'assistant' } };

      handleMessage(store, msg);

      expect(store.handleYeaftOutput).toHaveBeenCalledWith(msg);
      expect(store.handleAssistantOutputFrame).not.toHaveBeenCalled();
    }
  });

  it('adds a ready Session asset once and keeps it scoped to its turn', () => {
    const store = {
      ...mkStore(),
      yeaftConversationId: 'yeaft-1',
      messagesMap: { 'yeaft-1': [] },
      addMessageToConversation: vi.fn((conversationId, message) => store.messagesMap[conversationId].push(message)),
    };
    const msg = {
      type: 'yeaft_asset_ready',
      conversationId: 'yeaft-1',
      sessionId: 'session-1',
      vpId: 'maker',
      turnId: 'turn-1',
      image: { assetId: 'asset-1', mimeType: 'image/png', filename: 'result.png', src: '/api/yeaft/assets/scope/asset?token=secret' },
    };

    handleMessage(store, msg);
    handleMessage(store, msg);

    expect(store.addMessageToConversation).toHaveBeenCalledTimes(1);
    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({ type: 'chat-image', assetId: 'asset-1', sessionId: 'session-1', vpId: 'maker', turnId: 'turn-1' }),
    ]);
  });

  it('hydrates persisted Yeaft Session pins from the top-level server replay', () => {
    const applySnapshot = vi.fn();
    globalThis.window = {
      Pinia: {
        useSessionsStore: () => ({ applySnapshot }),
      },
    };
    const store = mkStore();
    const sessions = [
      { id: 'session_default', agentId: 'agent-a', pinned: true },
    ];

    handleMessage(store, {
      type: 'yeaft_session_hydrate',
      agentId: 'agent-a',
      sessions,
      fromDb: true,
    });

    expect(applySnapshot).toHaveBeenCalledWith(sessions, 'agent-a');
  });

  it('applies session_pinned acknowledgements through the chat pin cache owner', () => {
    const applyPinState = vi.fn();
    globalThis.window = {
      Pinia: {
        useSessionsStore: () => ({ applyPinState }),
      },
    };
    const store = {
      ...mkStore(),
      setSessionPinned: vi.fn(),
    };

    handleMessage(store, { type: 'session_pinned', conversationId: 'session-1', pinned: true });

    expect(store.setSessionPinned).toHaveBeenCalledWith('session-1', true, {});
    expect(applyPinState).not.toHaveBeenCalled();
  });

  it('falls back to Yeaft session row metadata when the chat pin cache owner is unavailable', () => {
    const applyPinState = vi.fn();
    globalThis.window = {
      Pinia: {
        useSessionsStore: () => ({ applyPinState }),
      },
    };
    const store = mkStore();

    handleMessage(store, { type: 'session_pinned', conversationId: 'session-1', pinned: false });

    expect(applyPinState).toHaveBeenCalledWith('session-1', false, null);
  });
});
