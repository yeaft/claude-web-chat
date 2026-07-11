import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyEnterYeaftTransition,
  applyLeaveYeaftTransition,
  createInitialConversationViewState,
  persistPreferredConversationView,
  readPreferredConversationView,
} from '../../../web/stores/helpers/yeaft-view.js';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(key => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    value(key) {
      return values.get(key) ?? null;
    },
  };
}

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = createStorage();

const { useChatStore } = await import('../../../web/stores/chat.js');
const { handleAgentList } = await import('../../../web/stores/helpers/handlers/agentHandler.js');
const { default: WorkCenterPage } = await import('../../../web/components/WorkCenterPage.js');

function createChatStore() {
  const schema = useChatStore();
  const store = { ...schema.state(), sent: [] };
  for (const [name, action] of Object.entries(schema.actions)) {
    store[name] = action.bind(store);
  }
  store.sendWsMessage = function sendWsMessage(message) {
    this.sent.push(message);
  };
  store.loadOpenedYeaftSessionsForConnectedAgents = vi.fn();
  store.listWorkItems = vi.fn().mockResolvedValue([]);
  return store;
}

describe('Yeaft conversation view preference', () => {
  let storage;

  beforeEach(() => {
    storage = createStorage();
  });

  it('restores Yeaft Session after refresh when it was the last selected surface', () => {
    storage.setItem('yeaft-preferred-conversation-view', 'yeaft');

    expect(readPreferredConversationView(storage)).toBe('yeaft');
  });

  it('falls back to Chat for missing or invalid persisted values', () => {
    expect(readPreferredConversationView(storage)).toBe('chat');

    storage.setItem('yeaft-preferred-conversation-view', 'work-center');
    expect(readPreferredConversationView(storage)).toBe('chat');
  });

  it('persists only Chat and Yeaft Session surfaces', () => {
    expect(persistPreferredConversationView('yeaft', storage)).toBe(true);
    expect(storage.value('yeaft-preferred-conversation-view')).toBe('yeaft');

    expect(persistPreferredConversationView('work-center', storage)).toBe(false);
    expect(storage.value('yeaft-preferred-conversation-view')).toBe('yeaft');

    expect(persistPreferredConversationView('chat', storage)).toBe(true);
    expect(storage.value('yeaft-preferred-conversation-view')).toBe('chat');
  });

  it('restores the last Chat conversation after a cold Yeaft bootstrap', () => {
    const initial = createInitialConversationViewState(createStorage({
      'yeaft-preferred-conversation-view': 'yeaft',
      lastViewedConversation: 'chat-conversation',
    }));
    const store = {
      ...initial,
      activeConversations: [],
      yeaftConversationId: 'yeaft-local-agent-1',
    };

    // Cold startup renders Yeaft before agent_list. The later bootstrap writes
    // the agent conversation id without calling enterYeaft first.
    store.activeConversations = ['yeaft-real-agent-1'];
    applyLeaveYeaftTransition(store);

    expect(store.activeConversations).toEqual([]);
    expect(store._pendingChatRestoreConversationId).toBe('chat-conversation');
    expect(store._savedActiveConversations).toBeNull();
    expect(store._yeaftTransitionActive).toBe(false);
  });

  it('keeps the Chat snapshot through agent_list bootstrap and session_ready', () => {
    const store = createChatStore();
    Object.assign(store, createInitialConversationViewState(createStorage({
      'yeaft-preferred-conversation-view': 'yeaft',
      lastViewedConversation: 'chat-conversation',
    })));
    store.lastViewedConversation = 'chat-conversation';
    store.conversations = [{
      id: 'chat-conversation',
      agentId: 'agent-1',
      type: 'chat',
      workDir: '/workspace/chat',
    }];

    handleAgentList(store, {
      type: 'agent_list',
      agents: [{ id: 'agent-1', name: 'Agent 1', online: true, conversations: store.conversations }],
    });
    expect(store.currentAgent).toBe('agent-1');
    expect(store.sent.some(message => message.type === 'yeaft_load_history')).toBe(true);

    store.handleYeaftOutput({
      agentId: 'agent-1',
      event: {
        type: 'session_ready',
        conversationId: 'yeaft-real-agent-1',
        model: 'test-model',
        availableModels: [],
        skills: [],
        mcpServers: [],
        tools: [],
      },
    });
    expect(store.activeConversations).toEqual(['yeaft-real-agent-1']);

    store.sent = [];
    store.leaveYeaft();
    expect(store.currentView).toBe('chat');
    expect(store.activeConversations).toEqual(['chat-conversation']);
    expect(store.currentWorkDir).toBe('/workspace/chat');
    expect(store.sessionLoading).toBe(false);
    expect(store.sent).toEqual([
      { type: 'sync_messages', conversationId: 'chat-conversation', turns: 5 },
      { type: 'select_conversation', conversationId: 'chat-conversation' },
      { type: 'refresh_conversation', conversationId: 'chat-conversation' },
    ]);
    expect(store._pendingChatRestoreConversationId).toBeNull();
  });

  it('keeps Work Center inside a cold-restored Yeaft provider', () => {
    const store = createChatStore();
    Object.assign(store, createInitialConversationViewState(createStorage({
      'yeaft-preferred-conversation-view': 'yeaft',
      lastViewedConversation: 'chat-conversation',
    })));
    store.currentAgent = 'agent-1';
    store.agents = [{ id: 'agent-1', online: true }];
    store.listWorkItems = vi.fn().mockResolvedValue([]);
    localStorage.setItem.mockClear();

    store.enterWorkCenter('agent-1');

    expect(store.currentView).toBe('yeaft');
    expect(store.workCenterOpen).toBe(true);
    expect(store._pendingChatRestoreConversationId).toBe('chat-conversation');
    expect(localStorage.setItem).not.toHaveBeenCalledWith('yeaft-preferred-conversation-view', 'chat');
  });

  it('uses the normal loading path when the pending Chat restore has an agent session', () => {
    const store = createChatStore();
    Object.assign(store, createInitialConversationViewState(createStorage({
      'yeaft-preferred-conversation-view': 'yeaft',
      lastViewedConversation: 'chat-conversation',
    })));
    store.conversations = [{
      id: 'chat-conversation',
      agentId: 'agent-1',
      claudeSessionId: 'claude-session-1',
      workDir: '/workspace/chat',
    }];
    store.currentAgent = 'agent-1';

    store.leaveYeaft();

    expect(store.currentWorkDir).toBe('/workspace/chat');
    expect(store.sessionLoading).toBe(true);
    expect(store.sent).toEqual([
      {
        type: 'resume_conversation',
        agentId: 'agent-1',
        claudeSessionId: 'claude-session-1',
        workDir: '/workspace/chat',
        conversationId: 'chat-conversation',
      },
      { type: 'select_conversation', conversationId: 'chat-conversation' },
      { type: 'refresh_conversation', conversationId: 'chat-conversation' },
    ]);
  });

  it('keeps the shared mobile sidebar state across Chat and Yeaft view switches', () => {
    const store = createChatStore();
    store.sessionSidebarOpen = true;
    store.currentView = 'chat';
    store.activeConversations = ['chat-conversation'];
    store.yeaftConversationId = 'yeaft-local-agent-1';

    store.enterYeaft();
    expect(store.currentView).toBe('yeaft');
    expect(store.sessionSidebarOpen).toBe(true);

    store.leaveYeaft();
    expect(store.currentView).toBe('chat');
    expect(store.sessionSidebarOpen).toBe(true);
  });

  it('does not overwrite the Chat snapshot on repeated Yeaft entry', () => {
    const store = {
      currentView: 'chat',
      activeConversations: ['chat-conversation'],
      _yeaftTransitionActive: false,
      _savedActiveConversations: null,
      yeaftConversationId: 'yeaft-local-agent-1',
    };

    expect(applyEnterYeaftTransition(store)).toBe(true);
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-real-agent-1';
    expect(applyEnterYeaftTransition(store)).toBe(false);
    applyLeaveYeaftTransition(store);

    expect(store.activeConversations).toEqual(['chat-conversation']);
  });

  it('does not fail startup when browser storage is unavailable', () => {
    const blockedStorage = {
      getItem: vi.fn(() => { throw new Error('blocked'); }),
      setItem: vi.fn(() => { throw new Error('blocked'); }),
    };

    expect(readPreferredConversationView(blockedStorage)).toBe('chat');
    expect(persistPreferredConversationView('yeaft', blockedStorage)).toBe(false);
  });
});
