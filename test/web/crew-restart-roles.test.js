import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

const AGENT_HANDLER_PATH = resolve(__dirname, '../../web/stores/helpers/handlers/agentHandler.js');
const CHAT_HEADER_PATH = resolve(__dirname, '../../web/components/ChatHeader.js');
const CREW_HELPER_PATH = resolve(__dirname, '../../web/stores/helpers/crew.js');

const agentHandlerSource = readFileSync(AGENT_HANDLER_PATH, 'utf-8');
const chatHeaderSource = readFileSync(CHAT_HEADER_PATH, 'utf-8');
const crewHelperSource = readFileSync(CREW_HELPER_PATH, 'utf-8');

// Helper: extract the handleAgentSelected reconnect block (the one with clearSessionLoading)
function getAgentSelectedReconnectBlock() {
  const anchor = 'clearSessionLoading(store)';
  const idx = agentHandlerSource.indexOf(anchor);
  // Go back to find the if statement
  const blockStart = agentHandlerSource.lastIndexOf('if (isSameAgent', idx);
  // Find the matching else
  const elseIdx = agentHandlerSource.indexOf('} else {', idx);
  return agentHandlerSource.substring(blockStart, elseIdx);
}

// Helper: extract refreshSession function body from ChatHeader
function getRefreshSessionBody() {
  const setupSection = chatHeaderSource.split('setup()')[1] || '';
  const fnStart = setupSection.indexOf('const refreshSession');
  // Find the end of the arrow function (next `};` after the start)
  const fnEnd = setupSection.indexOf('};', fnStart) + 2;
  return setupSection.substring(fnStart, fnEnd);
}

// Helper: extract crew_session_restored handler block
function getCrewSessionRestoredBlock() {
  const startMarker = "msg.type === 'crew_session_restored'";
  const startIdx = crewHelperSource.indexOf(startMarker);
  // Find the next top-level `if (msg.type ===` after this handler
  const nextHandler = crewHelperSource.indexOf("if (msg.type === 'crew_output')", startIdx);
  return crewHelperSource.substring(startIdx, nextHandler);
}

// =====================================================================
// Bug 1: handleAgentSelected sends resume_crew_session for Crew
// =====================================================================
describe('Bug 1: handleAgentSelected Crew resume (source)', () => {
  const block = getAgentSelectedReconnectBlock();

  it('reconnect block contains resume_crew_session', () => {
    expect(block).toContain("type: 'resume_crew_session'");
  });

  it('checks conv type is crew before sending resume', () => {
    expect(block).toContain("currentConv?.type === 'crew'");
  });

  it('passes sessionId and agentId in resume message', () => {
    expect(block).toContain('sessionId: store.currentConversation');
    expect(block).toContain('agentId: msg.agentId');
  });

  it('sends select_conversation BEFORE resume_crew_session', () => {
    const selectIdx = block.indexOf("type: 'select_conversation'");
    const resumeIdx = block.indexOf("type: 'resume_crew_session'");
    expect(selectIdx).toBeGreaterThan(-1);
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(selectIdx).toBeLessThan(resumeIdx);
  });

  it('crew type check gates the resume message', () => {
    const crewCheck = block.indexOf("currentConv?.type === 'crew'");
    const resumeMsg = block.indexOf("type: 'resume_crew_session'");
    expect(crewCheck).toBeGreaterThan(-1);
    expect(crewCheck).toBeLessThan(resumeMsg);
  });
});

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
// Bug 2: ChatHeader refreshSession Crew branch (source)
// =====================================================================
describe('Bug 2: ChatHeader refreshSession Crew support (source)', () => {
  const fnBody = getRefreshSessionBody();

  it('checks currentConversationIsCrew', () => {
    expect(fnBody).toContain('currentConversationIsCrew');
  });

  it('sends resume_crew_session for Crew', () => {
    expect(fnBody).toContain("type: 'resume_crew_session'");
  });

  it('sends sync_messages for non-Crew in else branch', () => {
    expect(fnBody).toContain("type: 'sync_messages'");
  });

  it('passes sessionId for Crew resume', () => {
    expect(fnBody).toContain('sessionId: store.currentConversation');
  });

  it('passes agentId for Crew resume', () => {
    expect(fnBody).toContain('agentId: store.currentAgent');
  });

  it('clears messages only in non-Crew branch', () => {
    const crewCheck = fnBody.indexOf('currentConversationIsCrew');
    const messagesClear = fnBody.indexOf('store.messages = []');
    // messages clear is in the else branch, after the crew check
    expect(messagesClear).toBeGreaterThan(crewCheck);
  });

  it('has if/else structure for Crew vs non-Crew', () => {
    // Should have both resume_crew_session and sync_messages in same function
    expect(fnBody).toContain("type: 'resume_crew_session'");
    expect(fnBody).toContain("type: 'sync_messages'");
    expect(fnBody).toContain('} else {');
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
// Bug 3: crew_session_restored resets refreshingSession (source)
// =====================================================================
describe('Bug 3: crew_session_restored resets refreshingSession (source)', () => {
  const block = getCrewSessionRestoredBlock();

  it('handler contains refreshingSession = false', () => {
    expect(block).toContain('store.refreshingSession = false');
  });

  it('reset comes after saveOpenSessions', () => {
    const saveIdx = block.indexOf('saveOpenSessions');
    const resetIdx = block.indexOf('store.refreshingSession = false');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(saveIdx);
  });

  it('reset comes before return', () => {
    const resetIdx = block.indexOf('store.refreshingSession = false');
    const returnIdx = block.indexOf('return;', resetIdx);
    expect(resetIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(resetIdx);
  });

  it('crew_session_created does NOT reset refreshingSession', () => {
    const createdStart = crewHelperSource.indexOf("msg.type === 'crew_session_created'");
    const restoredStart = crewHelperSource.indexOf("msg.type === 'crew_session_restored'");
    const createdBlock = crewHelperSource.substring(createdStart, restoredStart);
    expect(createdBlock).not.toContain('refreshingSession');
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

// =====================================================================
// Consistency: existing reconnect paths already handle Crew
// =====================================================================
describe('Consistency: existing Crew reconnect paths', () => {
  it('agent_list reconnect sends resume_crew_session for crew', () => {
    const reconnectSection = agentHandlerSource.substring(
      agentHandlerSource.indexOf('// ★ Reconnect 恢复')
    );
    expect(reconnectSection).toContain("conv?.type === 'crew'");
    expect(reconnectSection).toContain("type: 'resume_crew_session'");
  });

  it('restoreLastViewedConversation sends resume_crew_session for crew', () => {
    const restoreStart = agentHandlerSource.indexOf('export function restoreLastViewedConversation');
    const restoreEnd = agentHandlerSource.indexOf('export function handleAgentList');
    const restoreSection = agentHandlerSource.substring(restoreStart, restoreEnd);
    expect(restoreSection).toContain("conv.type === 'crew'");
    expect(restoreSection).toContain("type: 'resume_crew_session'");
  });
});

// =====================================================================
// Crew header refresh button wiring
// =====================================================================
describe('Crew header refresh button wiring', () => {
  it('crew-header-right has refresh button', () => {
    const crewSection = chatHeaderSource.substring(chatHeaderSource.indexOf('crew-header-right'));
    expect(crewSection).toContain('@click="refreshSession"');
  });

  it('crew refresh button shows loading state', () => {
    const crewSection = chatHeaderSource.substring(chatHeaderSource.indexOf('crew-header-right'));
    expect(crewSection).toContain('store.refreshingSession');
  });

  it('refreshSession is exported from setup()', () => {
    const returnStatement = chatHeaderSource.substring(chatHeaderSource.indexOf('return {'));
    expect(returnStatement).toContain('refreshSession');
  });
});
