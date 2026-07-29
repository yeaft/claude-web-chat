import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  addMessageToConversation,
  appendToAssistantMessageForConversation,
  finishStreamingForConversation,
  maxDbMessageId,
} from '../../web/stores/helpers/messages.js';
import UnifiedSessionList from '../../web/components/UnifiedSessionList.js';
import {
  catalogKeyForRoute,
  chatCatalogKey,
  chatRouteRef,
  normalizeChatRuntimeProvider,
  yeaftCatalogKey,
  yeaftRouteRef,
} from '../../web/stores/helpers/session-catalog.js';
globalThis.Pinia = globalThis.Pinia || { defineStore: () => () => ({}) };
const { handleSyncMessagesResult } = await import('../../web/stores/helpers/handlers/conversationHandler.js');

import {
  buildYeaftMessageTurnSpans,
  hasHiddenYeaftMessageTurns,
  sliceYeaftMessagesByRecentTurns,
} from '../../web/stores/helpers/yeaft-message-window.js';

function makeStore() {
  return {
    yeaftConversationId: 'conv-1',
    _currentYeaftSessionId: 'session-1',
    _currentYeaftVpId: 'vp-1',
    _currentYeaftTurnId: 'turn-1',
    messagesMap: { 'conv-1': [] },
    yeaftSessionHistoryState: {},
  };
}

describe('message flow regressions', () => {
  it('keeps same-id streaming updates in one assistant message', () => {
    const store = makeStore();

    appendToAssistantMessageForConversation(store, 'conv-1', 'hello ', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });
    appendToAssistantMessageForConversation(store, 'conv-1', 'world', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });

    expect(store.messagesMap['conv-1']).toHaveLength(1);
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });

    appendToAssistantMessageForConversation(store, 'conv-1', 'hello world!', {
      id: 'msg-1',
      turnId: 'turn-1',
    });

    expect(store.messagesMap['conv-1']).toHaveLength(1);
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world!',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });

    finishStreamingForConversation(store, 'conv-1', { completeLifecycle: false });
    expect(store.messagesMap['conv-1'][0]).toMatchObject({
      content: 'hello world!',
      isStreaming: false,
      status: 'pending',
      turnId: 'turn-1',
    });
    expect(store.messagesMap['conv-1'][0]).not.toHaveProperty('turnEndAt');
  });

  it('uses the largest persisted DB id when a streaming row is at the tail', () => {
    expect(maxDbMessageId([
      { id: 'optimistic-user', dbMessageId: 17 },
      { id: 'streaming-assistant-uuid', isStreaming: true },
    ])).toBe(17);
  });

  it('keeps Work Center inputs available and detail layouts responsive', () => {
    const component = readFileSync(resolve(import.meta.dirname, '../../web/components/ChatInput.js'), 'utf8');
    const websocket = readFileSync(resolve(import.meta.dirname, '../../web/stores/helpers/websocket.js'), 'utf8');
    const chatStoreSource = readFileSync(resolve(import.meta.dirname, '../../web/stores/chat.js'), 'utf8');
    const chatPageSource = readFileSync(resolve(import.meta.dirname, '../../web/components/ChatPage.js'), 'utf8');
    const yeaftSidebarSource = readFileSync(resolve(import.meta.dirname, '../../web/components/YeaftSidebar.js'), 'utf8');

    const first = chatRouteRef({ id: 'conversation-1', agentId: 'agent-a', provider: 'copilot' });
    const moved = chatRouteRef({ id: 'conversation-1', agentId: 'agent-b', provider: 'copilot' });
    expect(catalogKeyForRoute(first)).toBe('chat:conversation-1');
    expect(catalogKeyForRoute(moved)).toBe('chat:conversation-1');
    expect(yeaftCatalogKey('agent-a', 'same-id')).not.toBe(yeaftCatalogKey('agent-b', 'same-id'));
    expect(catalogKeyForRoute(yeaftRouteRef({ id: 'same-id', agentId: 'agent-b' }))).toBe('yeaft:agent-b:same-id');
    expect(normalizeChatRuntimeProvider(null)).toBe('claude-code');
    expect(normalizeChatRuntimeProvider('copilot')).toBe('copilot');
    expect(() => normalizeChatRuntimeProvider('unknown')).toThrow(/Unknown Chat runtime provider/);
    expect(() => chatCatalogKey('')).toThrow(/conversationId/);

    expect(UnifiedSessionList.template).toContain(':key="row.catalogKey"');
    expect(UnifiedSessionList.emits).toContain('create-chat');
    expect(UnifiedSessionList.emits).toContain('create-yeaft');
    expect(UnifiedSessionList.template).toContain("$emit('create-yeaft')");
    expect(UnifiedSessionList.template).toContain("emitAction('pin', row)");
    expect(UnifiedSessionList.template).toContain(":tabindex=\"isAvailable(row) ? 0 : -1\"");
    expect(UnifiedSessionList.methods.isAvailable({ availability: 'offline' })).toBe(false);
    expect(UnifiedSessionList.template).toContain("emitAction('remove', row)");
    expect(UnifiedSessionList.methods.providerLabel({ runtimeProvider: 'copilot' })).toBe('Copilot');
    expect(chatPageSource).toContain('@create-chat="openConversationModal"');
    expect(chatPageSource).toContain('@action="onUnifiedSessionAction"');
    expect(yeaftSidebarSource).toContain('@create-yeaft="onOpenSessionCreate"');
    expect(websocket).toContain('store.sessionCatalogLoaded = false;');
    expect(websocket).toContain('store.sessionCatalog = [];');
    expect(chatStoreSource).toContain("this.setActiveSessionFilter(sessionId, { agentId, force: true });");
    expect(chatStoreSource).toContain('requestChatHistory(conversationId');
    expect(chatStoreSource).toContain("type: 'set_session_ui_metadata'");
    expect(chatStoreSource).toContain("type: 'reorder_session_catalog'");
    expect((chatStoreSource.match(/type: 'sync_messages'/g) || [])).toHaveLength(1);
    expect(readFileSync(resolve(import.meta.dirname, '../../web/components/ChatHeader.js'), 'utf8')).not.toContain("type: 'sync_messages'");
    expect(readFileSync(resolve(import.meta.dirname, '../../web/stores/helpers/handlers/agentHandler.js'), 'utf8')).not.toContain("type: 'sync_messages'");

    const historyStore = {
      messagesMap: { a: [], b: [] },
      activeConversations: ['b'],
      currentConversation: 'b',
      loadingMoreMessages: true,
      refreshingSessionMap: { a: true, b: true },
      chatSessionState: {},
      hasMoreMessages: false,
      chatHistoryRequests: {
        'chat:a': { requestId: 'request-a', catalogKey: 'chat:a', loading: true },
        'chat:b': { requestId: 'request-b', catalogKey: 'chat:b', loading: true },
      },
      formatDbMessageForHistoryHydration: vi.fn(row => ({ id: `row-${row.id}`, dbMessageId: row.id, type: row.role, content: row.content })),
      isCurrentChatHistoryResponse(msg) {
        return msg.catalogKey === `chat:${msg.conversationId}`
          && this.chatHistoryRequests[msg.catalogKey]?.requestId === msg.requestId;
      },
      finishChatHistoryRequest(msg) {
        if (!this.isCurrentChatHistoryResponse(msg)) return false;
        this.chatHistoryRequests[msg.catalogKey].loading = false;
        return true;
      },
      setRefreshingSession(id, value) { this.refreshingSessionMap[id] = value; },
    };
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'a', catalogKey: 'chat:a', requestId: 'stale', mode: 'recent', messages: [], hasMore: false,
    })).toBe(false);
    expect(historyStore.refreshingSessionMap.a).toBe(true);
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'a', catalogKey: 'chat:a', requestId: 'request-a', mode: 'recent', messages: [], hasMore: false,
    })).toBe(true);
    expect(historyStore.loadingMoreMessages).toBe(true);
    expect(historyStore.refreshingSessionMap.a).toBe(false);

    historyStore.chatHistoryRequestIdSupported = null;
    historyStore.chatHistoryRequests['chat:b'] = {
      requestId: 'legacy-b', catalogKey: 'chat:b', mode: 'recent', loading: true,
    };
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'b', messages: [], hasMore: false,
    })).toBe(true);
    expect(historyStore.chatHistoryRequests['chat:b'].loading).toBe(false);
    expect(handleSyncMessagesResult(historyStore, {
      conversationId: 'b', messages: [{ id: 99, role: 'assistant', content: 'late' }], hasMore: false,
    })).toBe(false);
    expect(historyStore.messagesMap.b).toEqual([]);
    const workCenter = readFileSync(resolve(import.meta.dirname, '../../web/components/WorkCenterPage.js'), 'utf8');
    const workCenterCss = readFileSync(resolve(import.meta.dirname, '../../web/styles/work-center.css'), 'utf8');
    const variables = readFileSync(resolve(import.meta.dirname, '../../web/styles/variables.css'), 'utf8');

    expect(component).toContain('v-if="isStopVisible"');
    expect(component).not.toContain('v-else\n          type="button"\n          class="send-btn"');
    expect(component).toContain('if (isCompacting.value) return false;');
    expect(component).not.toContain('if (isCompacting.value || isStopVisible.value) return false;');
    expect(component).toContain('if (!canSend.value) return;');
    expect(component).not.toContain('if (isStopVisible.value || !canSend.value) return;');
    expect(workCenter).toContain('@change="onWorkItemMessageAttachmentInput"');
    expect(workCenter).toContain('workItemMessageAttachments.length === 0');
    expect(workCenter).toContain('work-center-detail-close');
    expect(workCenter).not.toContain('class="work-center-action-content-summary"');
    expect(workCenterCss).toContain('grid-template-columns: minmax(0, 1fr) minmax(400px, 440px);');
    expect(workCenterCss).toMatch(/\.work-center-detail-close\s*\{[\s\S]*?position: absolute;[\s\S]*?right: 16px;/);
    expect(workCenterCss).toMatch(/\.work-center-action-description\s*\{[\s\S]*?white-space: nowrap;/);
    expect(workCenter).not.toContain('coordinatorRequestedSelectedActionInput');
    expect(workCenter).not.toContain("next?.routedTo === 'coordinator'");
    expect(workCenter).not.toContain("[...(this.selected.messages || [])].reverse().some");
    expect(workCenter).not.toContain("message.recovery?.actionId === this.selectedAction.id");
    expect(workCenter).toContain(":class=\"{ 'showing-detail': narrowPane !== 'items' }\"");
    expect(workCenterCss).toMatch(/\.work-center-shell\.showing-detail\s*\{[\s\S]*?padding-top: 10px;/);
    expect(workCenterCss).toMatch(/\.work-center-detail-heading\s*\{[\s\S]*?padding: 10px 56px 12px 24px;/);
    expect(workCenterCss).toMatch(/\.work-center-action-detail-header,[\s\S]*?\.work-center-action-composer\s*\{[\s\S]*?width: 100%;/);
    expect(workCenterCss).not.toContain('width: min(100%, 1120px);');
    expect(variables).toContain('--work-center-conversation-column-width: 1200px;');
    expect(variables).toContain('--work-center-conversation-gutter: clamp(20px, 3vw, 40px);');
    expect(workCenterCss).toMatch(/@container work-center \(max-width: 1120px\)\s*\{[\s\S]*?\.work-center-detail-layout\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
    expect(workCenterCss).toMatch(/@media \(max-width: 768px\)\s*\{[\s\S]*?\.work-center-action-detail-pane\s*\{[\s\S]*?--work-center-conversation-gutter: var\(--work-center-conversation-gutter-compact\);/);

    const turnBlock = readFileSync(resolve(import.meta.dirname, '../../web/components/VpTurnBlock.js'), 'utf8');
    const chatStore = readFileSync(resolve(import.meta.dirname, '../../web/stores/chat.js'), 'utf8');
    const bridge = readFileSync(resolve(import.meta.dirname, '../../agent/yeaft/web-bridge.js'), 'utf8');
    const en = readFileSync(resolve(import.meta.dirname, '../../web/i18n/en.js'), 'utf8');
    const zh = readFileSync(resolve(import.meta.dirname, '../../web/i18n/zh-CN.js'), 'utf8');
    expect(bridge).toContain("RUNNING_THREAD_STATES = new Set(['queued', 'typing', 'thinking', 'retrying', 'streaming', 'tool'])");
    expect(bridge).toContain("recoveryMode: event.recoveryMode || 'restart'");
    expect(chatStore).toContain("case 'llm_retry': {");
    expect(chatStore).toContain('retryAttempt: event.attempt || 0');
    expect(chatStore).toContain('if (msg.turnId && this.activeVpTurns?.[msg.turnId]?.retryAttempt)');
    expect(chatStore).toContain('retryRecoveryMode: _retryRecoveryMode');
    expect(chatStore).toContain("'thinking', 'retrying', 'streaming'");
    expect(turnBlock).toContain('turn.isStreaming && retryText');
    expect(turnBlock).toContain("'yeaft.vp.turnBlock.retryingContinue'");
    expect(en).toContain("'yeaft.vp.turnBlock.retryingRequest': 'Response stalled;");
    expect(zh).toContain("'yeaft.vp.turnBlock.retryingRequest': '响应停滞");
  });

  it('stamps background agent messages without promoting that conversation', () => {
    const store = makeStore();
    store.yeaftConversationIdsByAgent = {
      'agent-1': 'conv-1',
      'agent-2': 'conv-2',
    };
    store.messagesMap['conv-2'] = [];
    store._currentYeaftSessionId = 'session-2';
    store._currentYeaftVpId = 'vp-2';
    store._currentYeaftTurnId = 'turn-2';

    addMessageToConversation(store, 'conv-2', {
      id: 'msg-2',
      type: 'assistant',
      content: 'background',
    });

    expect(store.yeaftConversationId).toBe('conv-1');
    expect(store.messagesMap['conv-2'][0]).toMatchObject({
      sessionId: 'session-2',
      vpId: 'vp-2',
      turnId: 'turn-2',
      speakerVpId: 'vp-2',
    });
  });

  it('counts hyphenated tool-use/tool-result events as part of Yeaft assistant turns', () => {
    const messages = [
      { type: 'user', content: 'u1' },
      { type: 'tool-use', toolName: 'Bash', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'tool-result', toolUseId: 't1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'assistant', content: 'a1', turnId: 'a', speakerVpId: 'vp-1' },
      { type: 'user', content: 'u2' },
      { type: 'assistant', content: 'a2', turnId: 'b', speakerVpId: 'vp-1' },
    ];

    expect(buildYeaftMessageTurnSpans(messages).map(s => s.kind)).toEqual([
      'user',
      'user',
    ]);
    expect(hasHiddenYeaftMessageTurns(messages, 1)).toBe(true);
    expect(sliceYeaftMessagesByRecentTurns(messages, 1)).toEqual(messages.slice(4));
  });
});
