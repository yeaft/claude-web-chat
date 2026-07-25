// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import ChatInput from '../../web/components/ChatInput.js';
import {
  addMessageToConversation,
  appendToAssistantMessageForConversation,
} from '../../web/stores/helpers/messages.js';
import {
  buildYeaftMessageTurnSpans,
  hasHiddenYeaftMessageTurns,
  sliceYeaftMessagesByRecentTurns,
} from '../../web/stores/helpers/yeaft-message-window.js';

let chatInputStore;

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

function makeChatInputStore() {
  return Vue.reactive({
    activeConversationId: 'conversation-a',
    btwMode: false,
    cancelExecution: vi.fn(),
    compactStatus: null,
    currentAgent: 'agent-a',
    currentConversation: 'conversation-a',
    currentView: 'yeaft',
    customExpertRoles: [],
    expertSelections: [],
    inputDrafts: {},
    isProcessing: true,
    sendMessage: vi.fn(),
    slashCommandDescriptions: {},
    yeaftActiveSessionFilter: 'session-1',
  });
}

function mountChatInput(props = {}) {
  return mount(ChatInput, {
    props,
    global: { mocks: { $t: key => key } },
    attachTo: document.body,
  });
}

beforeAll(() => {
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useAuthStore: () => ({ getActiveToken: () => null }),
    useChatStore: () => chatInputStore,
    useSessionsStore: () => ({
      activeSessionId: 'session-1',
      sessions: { 'session-1': { id: 'session-1', roster: ['omni'] } },
      sessionById: sessionId => (sessionId === 'session-1' ? { id: 'session-1', roster: ['omni'] } : null),
    }),
    useVpStore: () => ({
      vpList: [{ vpId: 'omni' }],
      vpDescription: () => '',
      vpTextColor: () => 'var(--text-primary)',
    }),
  };
  globalThis.window.Pinia = globalThis.Pinia;
});

beforeEach(() => {
  chatInputStore = makeChatInputStore();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('message flow regressions', () => {
  it('keeps same-id streaming deltas and full snapshots on one assistant message', () => {
    const deltaStore = makeStore();

    appendToAssistantMessageForConversation(deltaStore, 'conv-1', 'hello ', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });
    appendToAssistantMessageForConversation(deltaStore, 'conv-1', 'world', {
      id: 'msg-1',
      sessionId: 'session-1',
      vpId: 'vp-1',
      turnId: 'turn-1',
    });

    expect(deltaStore.messagesMap['conv-1']).toHaveLength(1);
    expect(deltaStore.messagesMap['conv-1'][0]).toMatchObject({
      type: 'assistant',
      content: 'hello world',
      isStreaming: true,
      speakerVpId: 'vp-1',
      turnId: 'turn-1',
    });

    const snapshotStore = makeStore();
    appendToAssistantMessageForConversation(snapshotStore, 'conv-1', 'hello', { id: 'msg-1', turnId: 'turn-1' });
    appendToAssistantMessageForConversation(snapshotStore, 'conv-1', 'hello world', { id: 'msg-1', turnId: 'turn-1' });

    expect(snapshotStore.messagesMap['conv-1']).toHaveLength(1);
    expect(snapshotStore.messagesMap['conv-1'][0].content).toBe('hello world');
  });

  it('keeps stop and follow-up send controls available while a turn is running', async () => {
    const sendYeaft = vi.fn();
    const cancelYeaft = vi.fn();
    const yeaftInput = mountChatInput({ sendFn: sendYeaft, cancelFn: cancelYeaft, showStop: true });

    await yeaftInput.get('textarea').setValue('queued Yeaft follow-up');

    expect(yeaftInput.get('.stop-btn').attributes('aria-label')).toBe('chatInput.stop');
    expect(yeaftInput.get('.send-btn:not(.stop-btn)').attributes('disabled')).toBeUndefined();

    await yeaftInput.get('.send-btn:not(.stop-btn)').trigger('click');
    expect(sendYeaft).toHaveBeenCalledWith('queued Yeaft follow-up', undefined);
    await yeaftInput.get('.stop-btn').trigger('click');
    expect(cancelYeaft).toHaveBeenCalledOnce();
    yeaftInput.unmount();

    chatInputStore.currentView = 'chat';
    const chatInput = mountChatInput();
    await chatInput.get('textarea').setValue('queued Chat follow-up');
    await chatInput.get('.send-btn:not(.stop-btn)').trigger('click');

    expect(chatInputStore.sendMessage).toHaveBeenCalledWith('queued Chat follow-up', [], { expertSelections: [] });
    chatInput.unmount();
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
