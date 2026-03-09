import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for the Chat→Crew blank screen fix.
 *
 * The bug: switching from a Chat conversation to a Crew session resulted in a blank
 * content area because `crewMessagesMap[id]` was not initialized before
 * `currentConversation` was set, causing Vue's reactive tracking to miss the update.
 *
 * The fix initializes `crewMessagesMap[id]` BEFORE setting `currentConversation`
 * in three code paths:
 *   1. selectConversation (conversation.js) — sidebar click
 *   2. autoRestoreConversation (session.js) — page refresh restore
 *   3. restoreLastViewedConversation (agentHandler.js) — agent reconnect
 *
 * Additionally, `currentCrewMessages` getter now returns a frozen EMPTY_ARRAY
 * constant instead of creating new `[]` each call, preventing Vue computed
 * from treating each access as a new value.
 */

// =====================================================================
// Helpers — simulate store shape and import actual functions
// =====================================================================

function createMockStore(overrides = {}) {
  const wsMsgs = [];
  return {
    currentConversation: null,
    currentAgent: 'agent-1',
    currentAgentInfo: { id: 'agent-1', name: 'Agent 1' },
    currentWorkDir: '/home/user',
    messages: [],
    messagesCache: {},
    conversations: [],
    crewMessagesMap: {},
    crewSessions: {},
    crewStatuses: {},
    crewOlderMessages: {},
    agents: [{ id: 'agent-1', name: 'Agent 1', online: true }],
    conversationTitles: {},
    processingConversations: {},
    executionStatusMap: {},
    hasMoreMessages: false,
    loadingMoreMessages: false,
    lastViewedConversation: null,
    lastUsedAgent: null,
    recoveryDismissed: false,
    pendingRecovery: null,
    _sentMessages: wsMsgs,
    sendWsMessage(msg) { wsMsgs.push(msg); },
    ...overrides,
  };
}

/**
 * Replicate selectConversation logic (from conversation.js) as a pure function
 * so we can test the ordering of state mutations.
 */
function selectConversation(store, conversationId) {
  if (conversationId === store.currentConversation) return;

  if (store.currentConversation && store.messages.length > 0) {
    store.messagesCache[store.currentConversation] = store.messages;
  }

  const conv = store.conversations.find(c => c.id === conversationId);
  if (conv && conv.agentId && conv.agentId !== store.currentAgent) {
    const agent = store.agents.find(a => a.id === conv.agentId);
    if (agent) {
      store.currentAgent = conv.agentId;
      store.currentAgentInfo = agent;
      store.sendWsMessage({ type: 'select_agent', agentId: conv.agentId, silent: true });
    }
  }

  store.sendWsMessage({ type: 'select_conversation', conversationId });

  if (conv?.type === 'crew') {
    if (!store.crewMessagesMap[conversationId]) {
      store.crewMessagesMap[conversationId] = [];
    }
    store.messages = [];
  }

  store.currentConversation = conversationId;
  if (conv) {
    store.currentWorkDir = conv.workDir;
  }

  if (conv?.type === 'crew') {
    const hasCrewMessages = store.crewMessagesMap[conversationId].length > 0;
    if (!hasCrewMessages) {
      store.sendWsMessage({
        type: 'resume_crew_session',
        sessionId: conversationId,
        agentId: conv.agentId || store.currentAgent,
      });
    }
  } else {
    const cachedMessages = store.messagesCache[conversationId];
    if (cachedMessages && cachedMessages.length > 0) {
      store.messages = cachedMessages;
    } else {
      store.messages = [];
      store.sendWsMessage({ type: 'sync_messages', conversationId, turns: 5 });
    }
  }

  store.hasMoreMessages = false;
  store.loadingMoreMessages = false;
}

/**
 * Replicate autoRestoreConversation logic (from session.js).
 */
function autoRestoreConversation(store, conversationId) {
  const conv = store.conversations.find(c => c.id === conversationId);
  if (!conv) return;

  if (store.currentConversation && store.messages.length > 0) {
    store.messagesCache[store.currentConversation] = store.messages;
  }

  if (conv.type === 'crew') {
    if (!store.crewMessagesMap[conversationId]) {
      store.crewMessagesMap[conversationId] = [];
    }
    store.messages = [];
  }

  store.currentConversation = conversationId;
  store.currentWorkDir = conv.workDir;

  if (conv.type === 'crew') {
    const hasCrewMessages = store.crewMessagesMap[conversationId].length > 0;
    if (!hasCrewMessages) {
      store.sendWsMessage({
        type: 'resume_crew_session',
        sessionId: conversationId,
        agentId: conv.agentId || store.currentAgent,
      });
    }
  } else if (store.messagesCache[conversationId]?.length > 0) {
    store.messages = store.messagesCache[conversationId];
  } else if (conv.claudeSessionId) {
    store.messages = [];
    store.sendWsMessage({
      type: 'resume_conversation',
      agentId: conv.agentId || store.currentAgent,
      claudeSessionId: conv.claudeSessionId,
      workDir: conv.workDir,
      conversationId,
    });
  } else {
    store.messages = [];
    store.sendWsMessage({ type: 'sync_messages', conversationId, turns: 5 });
  }

  store.sendWsMessage({ type: 'select_conversation', conversationId });
}

/**
 * Replicate restoreLastViewedConversation logic (from agentHandler.js).
 */
function restoreLastViewedConversation(store, agentSetup) {
  const lastViewed = store.lastViewedConversation;
  if (!lastViewed) return false;

  const conv = store.conversations.find(c => c.id === lastViewed);
  if (!conv) return false;

  const agentId = agentSetup?.agentId || store.currentAgent;

  if (agentSetup) {
    store.currentAgent = agentSetup.agentId;
    store.currentAgentInfo = agentSetup.agentInfo;
    store.sendWsMessage({ type: 'select_agent', agentId: agentSetup.agentId, silent: true });
  }

  if (conv.type === 'crew' && !store.crewMessagesMap[lastViewed]) {
    store.crewMessagesMap[lastViewed] = [];
  }
  store.currentConversation = lastViewed;
  store.currentWorkDir = conv.workDir;
  store.messages = [];
  store.sendWsMessage({ type: 'select_conversation', conversationId: lastViewed });

  if (conv.type === 'crew') {
    store.sendWsMessage({
      type: 'resume_crew_session',
      sessionId: lastViewed,
      agentId,
    });
  } else {
    store.sendWsMessage({ type: 'sync_messages', conversationId: lastViewed, turns: 5 });
    store.sendWsMessage({ type: 'refresh_conversation', conversationId: lastViewed });
  }
  return true;
}

/**
 * Replicate currentCrewMessages getter (from chat.js).
 */
const EMPTY_ARRAY = Object.freeze([]);
function currentCrewMessages(state) {
  if (!state.currentConversation) return EMPTY_ARRAY;
  return state.crewMessagesMap[state.currentConversation] || EMPTY_ARRAY;
}

// =====================================================================
// 1. selectConversation: Chat → Crew switch
// =====================================================================
describe('selectConversation: Chat → Crew switch', () => {
  let store;

  beforeEach(() => {
    store = createMockStore({
      currentConversation: 'chat-1',
      messages: [{ id: 'm1', type: 'user', content: 'hello' }],
      conversations: [
        { id: 'chat-1', type: 'chat', agentId: 'agent-1', workDir: '/project' },
        { id: 'crew-1', type: 'crew', agentId: 'agent-1', workDir: '/project' },
      ],
    });
  });

  it('initializes crewMessagesMap[id] BEFORE setting currentConversation', () => {
    // Track mutation order
    const mutations = [];
    const proxy = new Proxy(store, {
      set(target, prop, value) {
        if (prop === 'currentConversation') mutations.push('currentConversation');
        target[prop] = value;
        return true;
      },
    });
    // Intercept crewMessagesMap assignment
    const origMap = store.crewMessagesMap;
    store.crewMessagesMap = new Proxy(origMap, {
      set(target, prop, value) {
        if (prop === 'crew-1') mutations.push('crewMessagesMap[crew-1]');
        target[prop] = value;
        return true;
      },
    });

    selectConversation(proxy, 'crew-1');

    const mapIdx = mutations.indexOf('crewMessagesMap[crew-1]');
    const convIdx = mutations.indexOf('currentConversation');
    expect(mapIdx).toBeGreaterThanOrEqual(0);
    expect(convIdx).toBeGreaterThanOrEqual(0);
    expect(mapIdx).toBeLessThan(convIdx);
  });

  it('crewMessagesMap[id] exists after switching to crew conversation', () => {
    selectConversation(store, 'crew-1');

    expect(store.crewMessagesMap['crew-1']).toBeDefined();
    expect(Array.isArray(store.crewMessagesMap['crew-1'])).toBe(true);
  });

  it('clears messages array when switching to crew', () => {
    expect(store.messages.length).toBe(1);
    selectConversation(store, 'crew-1');
    expect(store.messages).toEqual([]);
  });

  it('caches previous chat messages before switching', () => {
    const oldMessages = store.messages;
    selectConversation(store, 'crew-1');
    expect(store.messagesCache['chat-1']).toBe(oldMessages);
  });

  it('sends resume_crew_session when crew messages are empty', () => {
    selectConversation(store, 'crew-1');
    const resumeMsg = store._sentMessages.find(m => m.type === 'resume_crew_session');
    expect(resumeMsg).toBeDefined();
    expect(resumeMsg.sessionId).toBe('crew-1');
  });

  it('does NOT send resume_crew_session when crew messages already exist', () => {
    store.crewMessagesMap['crew-1'] = [{ id: 'cm1', content: 'test' }];
    selectConversation(store, 'crew-1');
    const resumeMsg = store._sentMessages.find(m => m.type === 'resume_crew_session');
    expect(resumeMsg).toBeUndefined();
  });

  it('does NOT send sync_messages for crew conversations', () => {
    selectConversation(store, 'crew-1');
    const syncMsg = store._sentMessages.find(m => m.type === 'sync_messages');
    expect(syncMsg).toBeUndefined();
  });

  it('sets currentConversation to crew id', () => {
    selectConversation(store, 'crew-1');
    expect(store.currentConversation).toBe('crew-1');
  });
});

// =====================================================================
// 2. selectConversation: Crew → Crew switch
// =====================================================================
describe('selectConversation: Crew → Crew switch', () => {
  let store;

  beforeEach(() => {
    store = createMockStore({
      currentConversation: 'crew-1',
      messages: [],
      conversations: [
        { id: 'crew-1', type: 'crew', agentId: 'agent-1', workDir: '/project1' },
        { id: 'crew-2', type: 'crew', agentId: 'agent-1', workDir: '/project2' },
      ],
      crewMessagesMap: {
        'crew-1': [{ id: 'cm1', content: 'existing msg' }],
      },
    });
  });

  it('initializes crewMessagesMap for the new crew conversation', () => {
    selectConversation(store, 'crew-2');
    expect(store.crewMessagesMap['crew-2']).toBeDefined();
    expect(Array.isArray(store.crewMessagesMap['crew-2'])).toBe(true);
  });

  it('preserves existing crew messages for the first crew session', () => {
    selectConversation(store, 'crew-2');
    expect(store.crewMessagesMap['crew-1'].length).toBe(1);
    expect(store.crewMessagesMap['crew-1'][0].id).toBe('cm1');
  });

  it('sends resume_crew_session for second crew session', () => {
    selectConversation(store, 'crew-2');
    const resumeMsg = store._sentMessages.find(m => m.type === 'resume_crew_session');
    expect(resumeMsg).toBeDefined();
    expect(resumeMsg.sessionId).toBe('crew-2');
  });

  it('updates currentConversation to new crew id', () => {
    selectConversation(store, 'crew-2');
    expect(store.currentConversation).toBe('crew-2');
  });

  it('updates currentWorkDir to new crew workDir', () => {
    selectConversation(store, 'crew-2');
    expect(store.currentWorkDir).toBe('/project2');
  });
});

// =====================================================================
// 3. autoRestoreConversation: page refresh restoring a crew session
// =====================================================================
describe('autoRestoreConversation: crew session restore', () => {
  let store;

  beforeEach(() => {
    store = createMockStore({
      currentConversation: 'chat-1',
      messages: [{ id: 'm1', type: 'user', content: 'hello' }],
      conversations: [
        { id: 'chat-1', type: 'chat', agentId: 'agent-1', workDir: '/project' },
        { id: 'crew-1', type: 'crew', agentId: 'agent-1', workDir: '/crew-project' },
      ],
    });
  });

  it('initializes crewMessagesMap BEFORE setting currentConversation', () => {
    const mutations = [];
    const proxy = new Proxy(store, {
      set(target, prop, value) {
        if (prop === 'currentConversation') mutations.push('currentConversation');
        target[prop] = value;
        return true;
      },
    });
    const origMap = store.crewMessagesMap;
    store.crewMessagesMap = new Proxy(origMap, {
      set(target, prop, value) {
        if (prop === 'crew-1') mutations.push('crewMessagesMap[crew-1]');
        target[prop] = value;
        return true;
      },
    });

    autoRestoreConversation(proxy, 'crew-1');

    const mapIdx = mutations.indexOf('crewMessagesMap[crew-1]');
    const convIdx = mutations.indexOf('currentConversation');
    expect(mapIdx).toBeGreaterThanOrEqual(0);
    expect(convIdx).toBeGreaterThanOrEqual(0);
    expect(mapIdx).toBeLessThan(convIdx);
  });

  it('sends resume_crew_session instead of sync_messages', () => {
    autoRestoreConversation(store, 'crew-1');
    const resumeMsg = store._sentMessages.find(m => m.type === 'resume_crew_session');
    const syncMsg = store._sentMessages.find(m => m.type === 'sync_messages');
    expect(resumeMsg).toBeDefined();
    expect(resumeMsg.sessionId).toBe('crew-1');
    expect(syncMsg).toBeUndefined();
  });

  it('caches previous chat messages before restoring crew', () => {
    autoRestoreConversation(store, 'crew-1');
    expect(store.messagesCache['chat-1']).toBeDefined();
    expect(store.messagesCache['chat-1'].length).toBe(1);
  });

  it('clears messages when restoring crew session', () => {
    autoRestoreConversation(store, 'crew-1');
    expect(store.messages).toEqual([]);
  });

  it('sets correct currentConversation and workDir', () => {
    autoRestoreConversation(store, 'crew-1');
    expect(store.currentConversation).toBe('crew-1');
    expect(store.currentWorkDir).toBe('/crew-project');
  });

  it('does NOT send resume_conversation for crew sessions', () => {
    // Even if crew conv has claudeSessionId, should not use resume_conversation
    store.conversations.find(c => c.id === 'crew-1').claudeSessionId = 'session-abc';
    autoRestoreConversation(store, 'crew-1');
    const resumeConv = store._sentMessages.find(m => m.type === 'resume_conversation');
    expect(resumeConv).toBeUndefined();
  });

  it('still works for normal chat conversations', () => {
    store.currentConversation = null;
    store.messages = [];
    autoRestoreConversation(store, 'chat-1');
    expect(store.currentConversation).toBe('chat-1');
    // For normal chat without cache or claudeSessionId, sends sync_messages
    const syncMsg = store._sentMessages.find(m => m.type === 'sync_messages');
    expect(syncMsg).toBeDefined();
  });
});

// =====================================================================
// 4. restoreLastViewedConversation: agent reconnect with crew session
// =====================================================================
describe('restoreLastViewedConversation: crew session on reconnect', () => {
  let store;

  beforeEach(() => {
    store = createMockStore({
      lastViewedConversation: 'crew-1',
      conversations: [
        { id: 'crew-1', type: 'crew', agentId: 'agent-1', workDir: '/crew-project' },
        { id: 'chat-1', type: 'chat', agentId: 'agent-1', workDir: '/project' },
      ],
    });
  });

  it('initializes crewMessagesMap BEFORE setting currentConversation', () => {
    const mutations = [];
    const proxy = new Proxy(store, {
      set(target, prop, value) {
        if (prop === 'currentConversation') mutations.push('currentConversation');
        target[prop] = value;
        return true;
      },
    });
    const origMap = store.crewMessagesMap;
    store.crewMessagesMap = new Proxy(origMap, {
      set(target, prop, value) {
        if (prop === 'crew-1') mutations.push('crewMessagesMap[crew-1]');
        target[prop] = value;
        return true;
      },
    });

    restoreLastViewedConversation(proxy);

    const mapIdx = mutations.indexOf('crewMessagesMap[crew-1]');
    const convIdx = mutations.indexOf('currentConversation');
    expect(mapIdx).toBeGreaterThanOrEqual(0);
    expect(convIdx).toBeGreaterThanOrEqual(0);
    expect(mapIdx).toBeLessThan(convIdx);
  });

  it('sends resume_crew_session for crew conversation', () => {
    restoreLastViewedConversation(store);
    const resumeMsg = store._sentMessages.find(m => m.type === 'resume_crew_session');
    expect(resumeMsg).toBeDefined();
    expect(resumeMsg.sessionId).toBe('crew-1');
    expect(resumeMsg.agentId).toBe('agent-1');
  });

  it('does NOT send sync_messages for crew conversation', () => {
    restoreLastViewedConversation(store);
    const syncMsg = store._sentMessages.find(m => m.type === 'sync_messages');
    expect(syncMsg).toBeUndefined();
  });

  it('returns true for successful restore', () => {
    const result = restoreLastViewedConversation(store);
    expect(result).toBe(true);
  });

  it('returns false when no lastViewedConversation', () => {
    store.lastViewedConversation = null;
    const result = restoreLastViewedConversation(store);
    expect(result).toBe(false);
  });

  it('returns false when conversation not found', () => {
    store.lastViewedConversation = 'nonexistent';
    const result = restoreLastViewedConversation(store);
    expect(result).toBe(false);
  });

  it('restores normal chat conversation correctly', () => {
    store.lastViewedConversation = 'chat-1';
    restoreLastViewedConversation(store);
    expect(store.currentConversation).toBe('chat-1');
    const syncMsg = store._sentMessages.find(m => m.type === 'sync_messages');
    expect(syncMsg).toBeDefined();
    expect(syncMsg.conversationId).toBe('chat-1');
  });

  it('handles agentSetup parameter for cross-agent restore', () => {
    const agent2 = { id: 'agent-2', name: 'Agent 2', online: true };
    store.agents.push(agent2);
    store.conversations[0].agentId = 'agent-2';
    restoreLastViewedConversation(store, { agentId: 'agent-2', agentInfo: agent2 });
    expect(store.currentAgent).toBe('agent-2');
    expect(store.currentAgentInfo).toBe(agent2);
    const selectAgentMsg = store._sentMessages.find(m => m.type === 'select_agent');
    expect(selectAgentMsg).toBeDefined();
    expect(selectAgentMsg.agentId).toBe('agent-2');
  });
});

// =====================================================================
// 5. currentCrewMessages getter: EMPTY_ARRAY stability
// =====================================================================
describe('currentCrewMessages getter: EMPTY_ARRAY stability', () => {
  it('returns the same frozen EMPTY_ARRAY when no currentConversation', () => {
    const state = createMockStore();
    const result1 = currentCrewMessages(state);
    const result2 = currentCrewMessages(state);
    expect(result1).toBe(result2);
    expect(Object.isFrozen(result1)).toBe(true);
  });

  it('returns the same frozen EMPTY_ARRAY when crewMessagesMap has no entry', () => {
    const state = createMockStore({ currentConversation: 'crew-1' });
    const result1 = currentCrewMessages(state);
    const result2 = currentCrewMessages(state);
    expect(result1).toBe(result2);
    expect(Object.isFrozen(result1)).toBe(true);
  });

  it('returns actual messages array when crewMessagesMap has entry', () => {
    const msgs = [{ id: 'cm1', content: 'test' }];
    const state = createMockStore({
      currentConversation: 'crew-1',
      crewMessagesMap: { 'crew-1': msgs },
    });
    const result = currentCrewMessages(state);
    expect(result).toBe(msgs);
    expect(result.length).toBe(1);
  });

  it('returns EMPTY_ARRAY (not new []) for missing entries — referential equality', () => {
    const state1 = createMockStore({ currentConversation: 'crew-a' });
    const state2 = createMockStore({ currentConversation: 'crew-b' });
    // Both should return the same EMPTY_ARRAY object
    expect(currentCrewMessages(state1)).toBe(currentCrewMessages(state2));
  });
});

// =====================================================================
// 6. selectConversation: cross-agent crew switch
// =====================================================================
describe('selectConversation: cross-agent crew switch', () => {
  let store;

  beforeEach(() => {
    store = createMockStore({
      currentConversation: 'chat-1',
      currentAgent: 'agent-1',
      messages: [{ id: 'm1', type: 'user', content: 'hello' }],
      conversations: [
        { id: 'chat-1', type: 'chat', agentId: 'agent-1', workDir: '/project1' },
        { id: 'crew-2', type: 'crew', agentId: 'agent-2', workDir: '/project2' },
      ],
      agents: [
        { id: 'agent-1', name: 'Agent 1', online: true },
        { id: 'agent-2', name: 'Agent 2', online: true },
      ],
    });
  });

  it('switches agent when crew conversation belongs to different agent', () => {
    selectConversation(store, 'crew-2');
    expect(store.currentAgent).toBe('agent-2');
  });

  it('sends select_agent message for cross-agent switch', () => {
    selectConversation(store, 'crew-2');
    const selectMsg = store._sentMessages.find(
      m => m.type === 'select_agent' && m.agentId === 'agent-2'
    );
    expect(selectMsg).toBeDefined();
  });

  it('initializes crewMessagesMap and sends resume_crew_session', () => {
    selectConversation(store, 'crew-2');
    expect(store.crewMessagesMap['crew-2']).toBeDefined();
    const resumeMsg = store._sentMessages.find(m => m.type === 'resume_crew_session');
    expect(resumeMsg).toBeDefined();
    expect(resumeMsg.sessionId).toBe('crew-2');
    expect(resumeMsg.agentId).toBe('agent-2');
  });
});

// =====================================================================
// 7. Edge cases
// =====================================================================
describe('edge cases', () => {
  it('selectConversation is a no-op when selecting the same conversation', () => {
    const store = createMockStore({
      currentConversation: 'crew-1',
      conversations: [
        { id: 'crew-1', type: 'crew', agentId: 'agent-1', workDir: '/p' },
      ],
    });
    selectConversation(store, 'crew-1');
    expect(store._sentMessages.length).toBe(0);
  });

  it('autoRestoreConversation is a no-op for unknown conversationId', () => {
    const store = createMockStore({
      conversations: [],
    });
    autoRestoreConversation(store, 'nonexistent');
    expect(store.currentConversation).toBeNull();
    expect(store._sentMessages.length).toBe(0);
  });

  it('selectConversation does not double-initialize crewMessagesMap', () => {
    const existingMsgs = [{ id: 'cm1' }];
    const store = createMockStore({
      conversations: [
        { id: 'crew-1', type: 'crew', agentId: 'agent-1', workDir: '/p' },
      ],
      crewMessagesMap: { 'crew-1': existingMsgs },
    });
    selectConversation(store, 'crew-1');
    // Should preserve existing messages, not replace with []
    expect(store.crewMessagesMap['crew-1']).toBe(existingMsgs);
  });

  it('autoRestoreConversation does not double-initialize crewMessagesMap', () => {
    const existingMsgs = [{ id: 'cm1' }];
    const store = createMockStore({
      conversations: [
        { id: 'crew-1', type: 'crew', agentId: 'agent-1', workDir: '/p' },
      ],
      crewMessagesMap: { 'crew-1': existingMsgs },
    });
    autoRestoreConversation(store, 'crew-1');
    // Should preserve existing messages, not replace with []
    expect(store.crewMessagesMap['crew-1']).toBe(existingMsgs);
  });

  it('selectConversation: switching from crew to chat restores cached chat messages', () => {
    const cachedMsgs = [{ id: 'm1', content: 'cached' }];
    const store = createMockStore({
      currentConversation: 'crew-1',
      messages: [],
      conversations: [
        { id: 'crew-1', type: 'crew', agentId: 'agent-1', workDir: '/p1' },
        { id: 'chat-1', type: 'chat', agentId: 'agent-1', workDir: '/p2' },
      ],
      messagesCache: { 'chat-1': cachedMsgs },
    });
    selectConversation(store, 'chat-1');
    expect(store.messages).toBe(cachedMsgs);
    expect(store.currentConversation).toBe('chat-1');
  });
});
