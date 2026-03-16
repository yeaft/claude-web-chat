import { describe, it, expect } from 'vitest';

/**
 * Tests for crew session restore switch fix (task-85, PR #246).
 *
 * Core business logic:
 * - resumeCrewSession sets _pendingCrewRestore flag
 * - crew_session_restored checks flag to decide whether to switch currentConversation
 * - User-initiated restore → switch (flag matches)
 * - Page refresh restore → no switch (no flag)
 */

// =====================================================================
// Replicate key logic from crew.js for unit testing
// =====================================================================

/**
 * Simulates resumeCrewSession's flag-setting behavior.
 * In the real code, this also sends a WS message.
 */
function simulateResumeCrewSession(store, sessionId) {
  if (!store.crewMessagesMap[sessionId]) store.crewMessagesMap[sessionId] = [];
  store._pendingCrewRestore = sessionId;
}

/**
 * Simulates the crew_session_restored handler's session-switch logic.
 * Extracts the core conditional from handleCrewOutput.
 */
function simulateCrewSessionRestored(store, msg) {
  const sid = msg.sessionId;

  // Ensure conversation exists (simplified)
  let conv = store.conversations.find(c => c.id === sid);
  if (!conv) {
    conv = {
      id: sid,
      type: 'crew',
      name: msg.name || '',
      workDir: msg.projectDir
    };
    store.conversations.push(conv);
  } else {
    conv.type = 'crew';
    conv.name = msg.name || '';
  }

  // ★ The fix: user-initiated restore → switch currentConversation
  if (store._pendingCrewRestore === sid) {
    if (store.currentConversation && store.messages.length > 0) {
      store.messagesCache[store.currentConversation] = store.messages;
    }
    store.currentConversation = sid;
    store.currentWorkDir = msg.projectDir;
    store.messages = [];
    delete store._pendingCrewRestore;
  }

  store.refreshingSession = false;
}

/** Creates a minimal mock store for testing */
function createMockStore(overrides = {}) {
  return {
    currentConversation: null,
    currentWorkDir: null,
    messages: [],
    messagesCache: {},
    conversations: [],
    crewMessagesMap: {},
    _pendingCrewRestore: undefined,
    refreshingSession: false,
    ...overrides
  };
}

// =====================================================================
// 1. resumeCrewSession flag-setting
// =====================================================================
describe('resumeCrewSession sets _pendingCrewRestore flag', () => {

  it('should set _pendingCrewRestore to sessionId', () => {
    const store = createMockStore();
    simulateResumeCrewSession(store, 'crew_abc123');
    expect(store._pendingCrewRestore).toBe('crew_abc123');
  });

  it('should initialize crewMessagesMap for the session if not exists', () => {
    const store = createMockStore();
    simulateResumeCrewSession(store, 'crew_new');
    expect(store.crewMessagesMap['crew_new']).toEqual([]);
  });

  it('should NOT overwrite existing crewMessagesMap', () => {
    const existingMessages = [{ id: 1, text: 'hello' }];
    const store = createMockStore({
      crewMessagesMap: { 'crew_existing': existingMessages }
    });
    simulateResumeCrewSession(store, 'crew_existing');
    expect(store.crewMessagesMap['crew_existing']).toBe(existingMessages);
  });

  it('should overwrite previous _pendingCrewRestore if called again', () => {
    const store = createMockStore();
    simulateResumeCrewSession(store, 'crew_first');
    simulateResumeCrewSession(store, 'crew_second');
    expect(store._pendingCrewRestore).toBe('crew_second');
  });
});

// =====================================================================
// 2. User-initiated restore → switch session
// =====================================================================
describe('crew_session_restored: user-initiated restore switches session', () => {

  it('should switch currentConversation to restored session', () => {
    const store = createMockStore();
    simulateResumeCrewSession(store, 'crew_abc');
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_abc',
      projectDir: '/home/user/project',
      name: 'My Crew'
    });
    expect(store.currentConversation).toBe('crew_abc');
  });

  it('should set currentWorkDir from restored session', () => {
    const store = createMockStore();
    simulateResumeCrewSession(store, 'crew_abc');
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_abc',
      projectDir: '/home/user/project',
      name: ''
    });
    expect(store.currentWorkDir).toBe('/home/user/project');
  });

  it('should clear messages for the new session view', () => {
    const store = createMockStore({
      messages: [{ id: 1, content: 'old message' }]
    });
    simulateResumeCrewSession(store, 'crew_abc');
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_abc',
      projectDir: '/project',
      name: ''
    });
    expect(store.messages).toEqual([]);
  });

  it('should cache previous messages before switching', () => {
    const oldMessages = [{ id: 1, content: 'old msg' }];
    const store = createMockStore({
      currentConversation: 'conv_old',
      messages: oldMessages
    });
    simulateResumeCrewSession(store, 'crew_abc');
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_abc',
      projectDir: '/project',
      name: ''
    });
    expect(store.messagesCache['conv_old']).toBe(oldMessages);
  });

  it('should NOT cache messages if current conversation has no messages', () => {
    const store = createMockStore({
      currentConversation: 'conv_old',
      messages: []
    });
    simulateResumeCrewSession(store, 'crew_abc');
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_abc',
      projectDir: '/project',
      name: ''
    });
    expect(store.messagesCache['conv_old']).toBeUndefined();
  });

  it('should delete _pendingCrewRestore flag after switching', () => {
    const store = createMockStore();
    simulateResumeCrewSession(store, 'crew_abc');
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_abc',
      projectDir: '/project',
      name: ''
    });
    expect(store._pendingCrewRestore).toBeUndefined();
  });
});

// =====================================================================
// 3. Page refresh → no switch (no flag set)
// =====================================================================
describe('crew_session_restored: page refresh does NOT switch session', () => {

  it('should NOT change currentConversation when no flag is set', () => {
    const store = createMockStore({
      currentConversation: 'conv_current'
    });
    // No call to resumeCrewSession — simulates page refresh path
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_restored',
      projectDir: '/project',
      name: 'Crew'
    });
    expect(store.currentConversation).toBe('conv_current');
  });

  it('should NOT clear messages when no flag is set', () => {
    const existingMessages = [{ id: 1, content: 'keep me' }];
    const store = createMockStore({
      currentConversation: 'conv_current',
      messages: existingMessages
    });
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_restored',
      projectDir: '/project',
      name: ''
    });
    expect(store.messages).toBe(existingMessages);
  });

  it('should NOT switch when flag exists but for a different session', () => {
    const store = createMockStore({
      currentConversation: 'conv_current',
      _pendingCrewRestore: 'crew_other_session'
    });
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_restored',
      projectDir: '/project',
      name: ''
    });
    expect(store.currentConversation).toBe('conv_current');
    // Flag should remain for the other session
    expect(store._pendingCrewRestore).toBe('crew_other_session');
  });
});

// =====================================================================
// 4. Conversation list management
// =====================================================================
describe('crew_session_restored: conversation list', () => {

  it('should create conversation entry if not exists', () => {
    const store = createMockStore();
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_new',
      projectDir: '/project',
      name: 'New Crew'
    });
    const conv = store.conversations.find(c => c.id === 'crew_new');
    expect(conv).toBeDefined();
    expect(conv.type).toBe('crew');
    expect(conv.name).toBe('New Crew');
  });

  it('should update existing conversation type and name', () => {
    const store = createMockStore({
      conversations: [{ id: 'crew_existing', type: 'chat', name: 'Old Name' }]
    });
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_existing',
      projectDir: '/project',
      name: 'Updated Crew'
    });
    const conv = store.conversations.find(c => c.id === 'crew_existing');
    expect(conv.type).toBe('crew');
    expect(conv.name).toBe('Updated Crew');
  });

  it('should always reset refreshingSession to false', () => {
    const store = createMockStore({ refreshingSession: true });
    simulateCrewSessionRestored(store, {
      sessionId: 'crew_abc',
      projectDir: '/project',
      name: ''
    });
    expect(store.refreshingSession).toBe(false);
  });
});
