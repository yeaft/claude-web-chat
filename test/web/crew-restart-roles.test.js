import { describe, it, expect } from 'vitest';

/**
 * Tests for task-37: Fix Crew roles lost after server restart + refresh button ineffective.
 *
 * Bug 1: handleAgentSelected — isSameAgent + currentConversation path only sent
 *   select_conversation, missing resume_crew_session for Crew conversations.
 *
 * Bug 2: ChatHeader refreshSession — sent sync_messages for all types including Crew,
 *   should send resume_crew_session for Crew conversations.
 *
 * Bug 3: crew_session_restored handler — did not reset store.refreshingSession,
 *   causing the refresh button to stay in loading state permanently.
 */

// =====================================================================
// Bug 1: Functional test — handleAgentSelected
// =====================================================================
describe('Bug 1: handleAgentSelected functional', () => {
  // Simulate the reconnect logic extracted from the source
  function simulateAgentSelectedReconnect(store, msg) {
    const isSameAgent = store.currentAgent === msg.agentId;
    store.currentAgent = msg.agentId;

    const serverConvs = msg.conversations || [];
    const activeConvs = serverConvs.map(c => ({ ...c, agentId: msg.agentId }));
    const otherAgentConvs = store.conversations.filter(c => c.agentId !== msg.agentId);
    store.conversations = [...otherAgentConvs, ...activeConvs];

    if (isSameAgent && store.currentConversation) {
      const currentConv = store.conversations.find(c => c.id === store.currentConversation);
      store.currentWorkDir = currentConv?.workDir || store.currentWorkDir || msg.workDir;
      store.sendWsMessage({ type: 'select_conversation', conversationId: store.currentConversation });
      // ★ The fix: send resume for Crew
      if (currentConv?.type === 'crew') {
        store.sendWsMessage({
          type: 'resume_crew_session',
          sessionId: store.currentConversation,
          agentId: msg.agentId
        });
      }
    }
  }

  function createStore(overrides = {}) {
    const msgs = [];
    return {
      currentConversation: null,
      currentAgent: 'agent-1',
      currentWorkDir: '/home',
      conversations: [],
      _sent: msgs,
      sendWsMessage(m) { msgs.push(m); },
      ...overrides,
    };
  }

  it('sends resume_crew_session for crew conversation on same agent reconnect', () => {
    const store = createStore({
      currentAgent: 'agent-1',
      currentConversation: 'crew_abc',
      conversations: [{ id: 'crew_abc', type: 'crew', workDir: '/p', agentId: 'agent-1' }],
    });
    simulateAgentSelectedReconnect(store, {
      agentId: 'agent-1',
      conversations: [{ id: 'crew_abc', type: 'crew', workDir: '/p' }],
    });
    const resume = store._sent.find(m => m.type === 'resume_crew_session');
    expect(resume).toBeDefined();
    expect(resume.sessionId).toBe('crew_abc');
    expect(resume.agentId).toBe('agent-1');
  });

  it('does NOT send resume_crew_session for normal conversation', () => {
    const store = createStore({
      currentAgent: 'agent-1',
      currentConversation: 'conv_1',
      conversations: [{ id: 'conv_1', type: 'chat', workDir: '/p', agentId: 'agent-1' }],
    });
    simulateAgentSelectedReconnect(store, {
      agentId: 'agent-1',
      conversations: [{ id: 'conv_1', type: 'chat', workDir: '/p' }],
    });
    expect(store._sent.find(m => m.type === 'resume_crew_session')).toBeUndefined();
  });

  it('does NOT send resume when switching to different agent', () => {
    const store = createStore({
      currentAgent: 'agent-1',
      currentConversation: 'crew_abc',
      conversations: [{ id: 'crew_abc', type: 'crew', workDir: '/p', agentId: 'agent-1' }],
    });
    simulateAgentSelectedReconnect(store, {
      agentId: 'agent-2',
      conversations: [],
    });
    expect(store._sent.find(m => m.type === 'resume_crew_session')).toBeUndefined();
  });

  it('sends select_conversation before resume_crew_session', () => {
    const store = createStore({
      currentAgent: 'agent-1',
      currentConversation: 'crew_abc',
      conversations: [{ id: 'crew_abc', type: 'crew', workDir: '/p', agentId: 'agent-1' }],
    });
    simulateAgentSelectedReconnect(store, {
      agentId: 'agent-1',
      conversations: [{ id: 'crew_abc', type: 'crew', workDir: '/p' }],
    });
    const selectIdx = store._sent.findIndex(m => m.type === 'select_conversation');
    const resumeIdx = store._sent.findIndex(m => m.type === 'resume_crew_session');
    expect(selectIdx).toBeLessThan(resumeIdx);
  });
});

// =====================================================================
// Bug 2: Functional test — refreshSession
// =====================================================================
describe('Bug 2: refreshSession functional', () => {
  function simulateRefreshSession(store) {
    if (store.refreshingSession || !store.currentConversation) return;
    store.refreshingSession = true;
    if (store.currentConversationIsCrew) {
      store.sendWsMessage({
        type: 'resume_crew_session',
        sessionId: store.currentConversation,
        agentId: store.currentAgent
      });
    } else {
      store.messages = [];
      store.sendWsMessage({
        type: 'sync_messages',
        conversationId: store.currentConversation,
        turns: 5
      });
    }
  }

  function createStore(overrides = {}) {
    const msgs = [];
    return {
      currentConversation: 'conv_1',
      currentAgent: 'agent-1',
      currentConversationIsCrew: false,
      refreshingSession: false,
      messages: [{ id: 1 }],
      _sent: msgs,
      sendWsMessage(m) { msgs.push(m); },
      ...overrides,
    };
  }

  it('sends resume_crew_session for Crew conversation', () => {
    const store = createStore({ currentConversationIsCrew: true });
    simulateRefreshSession(store);
    expect(store._sent[0].type).toBe('resume_crew_session');
    expect(store._sent[0].sessionId).toBe('conv_1');
  });

  it('sends sync_messages for non-Crew conversation', () => {
    const store = createStore({ currentConversationIsCrew: false });
    simulateRefreshSession(store);
    expect(store._sent[0].type).toBe('sync_messages');
    expect(store._sent[0].conversationId).toBe('conv_1');
  });

  it('does NOT clear messages for Crew', () => {
    const store = createStore({ currentConversationIsCrew: true, messages: [{ id: 1 }] });
    simulateRefreshSession(store);
    expect(store.messages).toHaveLength(1);
  });

  it('clears messages for non-Crew', () => {
    const store = createStore({ currentConversationIsCrew: false, messages: [{ id: 1 }] });
    simulateRefreshSession(store);
    expect(store.messages).toHaveLength(0);
  });

  it('sets refreshingSession to true', () => {
    const store = createStore();
    simulateRefreshSession(store);
    expect(store.refreshingSession).toBe(true);
  });

  it('guards against double refresh', () => {
    const store = createStore({ refreshingSession: true });
    simulateRefreshSession(store);
    expect(store._sent).toHaveLength(0);
  });

  it('guards against missing conversation', () => {
    const store = createStore({ currentConversation: null });
    simulateRefreshSession(store);
    expect(store._sent).toHaveLength(0);
  });
});

// =====================================================================
// Bug 3: Functional test — crew_session_restored resets refreshingSession
// =====================================================================
describe('Bug 3: crew_session_restored functional', () => {
  // Simulate the crew_session_restored handler logic
  function simulateCrewSessionRestored(store, msg) {
    const sid = msg.sessionId;
    store.crewSessions[sid] = {
      id: sid,
      projectDir: msg.projectDir,
      roles: msg.roles,
      decisionMaker: msg.decisionMaker,
    };
    if (msg.uiMessages && msg.uiMessages.length > 0) {
      store.crewMessagesMap[sid] = msg.uiMessages;
    } else {
      if (!store.crewMessagesMap[sid]) store.crewMessagesMap[sid] = [];
    }
    let conv = store.conversations.find(c => c.id === sid);
    if (!conv) {
      conv = { id: sid, type: 'crew', workDir: msg.projectDir };
      store.conversations.push(conv);
    }
    // ★ The fix
    store.refreshingSession = false;
  }

  it('resets refreshingSession to false', () => {
    const store = {
      refreshingSession: true,
      crewSessions: {},
      crewMessagesMap: {},
      conversations: [],
    };
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_1',
      projectDir: '/p',
      roles: [{ name: 'pm' }],
      decisionMaker: 'pm',
      uiMessages: [],
    });
    expect(store.refreshingSession).toBe(false);
  });

  it('restores crewSessions data', () => {
    const store = {
      refreshingSession: true,
      crewSessions: {},
      crewMessagesMap: {},
      conversations: [],
    };
    const roles = [{ name: 'pm' }, { name: 'dev-1' }];
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_1',
      projectDir: '/p',
      roles,
      decisionMaker: 'pm',
      uiMessages: [{ role: 'system', content: 'hi' }],
    });
    expect(store.crewSessions['crew_1']).toBeDefined();
    expect(store.crewSessions['crew_1'].roles).toEqual(roles);
    expect(store.crewMessagesMap['crew_1']).toHaveLength(1);
    expect(store.refreshingSession).toBe(false);
  });
});
