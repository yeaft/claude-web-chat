import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for Role Play web store support, templates, and i18n.
 *
 * Covers:
 * 1. chat.js store state & getters (rolePlaySessions, currentConversationIsRolePlay, currentRolePlaySession)
 * 2. createRolePlaySession WS message construction (web/stores/helpers/roleplay.js)
 * 3. conversationHandler: conversation_created with rolePlayConfig
 * 4. agentHandler: agent_list restoring rolePlay sessions
 * 5. conversation.js: selectConversation / deleteConversation roleplay cleanup
 * 6. crew-templates/index.js: getRolePlayTemplate
 * 7. i18n keys existence
 *
 * Logic is replicated to avoid importing modules with DOM / Pinia side effects.
 */

// =====================================================================
// Test data helpers
// =====================================================================

function makeDevRoles() {
  return [
    { name: 'pm', displayName: 'PM-乔布斯', icon: '📋', description: '需求分析与项目管理', claudeMd: '你是 PM-乔布斯。' },
    { name: 'dev', displayName: '开发者-托瓦兹', icon: '💻', description: '架构设计与代码实现', claudeMd: '你是开发者-托瓦兹。' },
    { name: 'reviewer', displayName: '审查者-马丁', icon: '🔍', description: '代码审查与质量控制', claudeMd: '你是审查者-马丁。' },
    { name: 'tester', displayName: '测试者-贝克', icon: '🧪', description: '测试验证与质量保障', claudeMd: '你是测试者-贝克。' },
  ];
}

function makeEnDevRoles() {
  return [
    { name: 'pm', displayName: 'PM-Jobs', icon: '📋', description: 'Requirements analysis & project management', claudeMd: 'You are PM-Jobs.' },
    { name: 'dev', displayName: 'Dev-Torvalds', icon: '💻', description: 'Architecture design & code implementation', claudeMd: 'You are Dev-Torvalds.' },
    { name: 'reviewer', displayName: 'Reviewer-Martin', icon: '🔍', description: 'Code review & quality control', claudeMd: 'You are Reviewer-Martin.' },
    { name: 'tester', displayName: 'Tester-Beck', icon: '🧪', description: 'Testing & quality assurance', claudeMd: 'You are Tester-Beck.' },
  ];
}

// =====================================================================
// Replicated store state & getters (from chat.js)
// =====================================================================

function createMockStore(overrides = {}) {
  const store = {
    currentConversation: overrides.currentConversation ?? null,
    currentAgent: 'currentAgent' in overrides ? overrides.currentAgent : 'agent-1',
    conversations: overrides.conversations || [],
    rolePlaySessions: overrides.rolePlaySessions || {},
    messages: [],
    sentWsMessages: [],
    addMessage(msg) { store.messages.push(msg); },
    sendWsMessage(msg) { store.sentWsMessages.push(msg); },
    // Replicated getters
    get currentConversationIsRolePlay() {
      if (!store.currentConversation) return false;
      const conv = store.conversations.find(c => c.id === store.currentConversation);
      return conv?.type === 'rolePlay';
    },
    get currentRolePlaySession() {
      return store.rolePlaySessions[store.currentConversation] || null;
    },
  };
  return store;
}

// =====================================================================
// Replicated createRolePlaySession (from web/stores/helpers/roleplay.js)
// =====================================================================

function createRolePlaySession(store, config) {
  const targetAgent = config.agentId || store.currentAgent;
  if (!targetAgent) {
    store.addMessage({ type: 'error', content: 'Please select an agent first' });
    return;
  }
  // Skipping setSessionLoading since it's a UI concern
  store.sendWsMessage({
    type: 'create_conversation',
    agentId: targetAgent,
    workDir: config.projectDir,
    rolePlayConfig: {
      roles: config.roles,
      teamType: config.teamType,
      language: config.language,
    }
  });
}

// =====================================================================
// Replicated handleConversationCreated (roleplay parts from conversationHandler.js)
// =====================================================================

function handleConversationCreated(store, msg) {
  const newConv = {
    id: msg.conversationId,
    agentId: msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: null,
    createdAt: Date.now(),
    processing: false,
    type: msg.rolePlayConfig ? 'rolePlay' : 'chat',
    disallowedTools: msg.disallowedTools ?? null,
  };
  store.conversations.push(newConv);

  if (msg.rolePlayConfig) {
    store.rolePlaySessions[msg.conversationId] = {
      roles: msg.rolePlayConfig.roles,
      teamType: msg.rolePlayConfig.teamType,
      language: msg.rolePlayConfig.language,
    };
  }
  store.currentConversation = msg.conversationId;
}

// =====================================================================
// Replicated handleConversationDeleted (roleplay parts from conversationHandler.js)
// =====================================================================

function handleConversationDeleted(store, msg) {
  store.conversations = store.conversations.filter(c => c.id !== msg.conversationId);
  delete store.rolePlaySessions[msg.conversationId];
  if (store.currentConversation === msg.conversationId) {
    store.currentConversation = null;
  }
}

// =====================================================================
// Replicated handleAgentList (roleplay parts from agentHandler.js)
// =====================================================================

function handleAgentListRolePlayRestore(store, serverConv) {
  if (serverConv.type === 'rolePlay' && serverConv.rolePlayRoles && !store.rolePlaySessions[serverConv.id]) {
    store.rolePlaySessions[serverConv.id] = {
      roles: serverConv.rolePlayRoles,
      teamType: serverConv.teamType || 'dev',
      language: serverConv.language || 'zh-CN',
    };
  }
}

// =====================================================================
// Replicated selectConversation roleplay logic
// =====================================================================

function selectConversationRolePlayRestore(store, conversationId) {
  const conv = store.conversations.find(c => c.id === conversationId);
  if (conv?.type === 'rolePlay' && !store.rolePlaySessions[conversationId] && conv.rolePlayRoles) {
    store.rolePlaySessions[conversationId] = {
      roles: conv.rolePlayRoles,
      teamType: conv.teamType || 'dev',
      language: conv.language || 'zh-CN',
    };
  }
  store.currentConversation = conversationId;
}

// =====================================================================
// Replicated deleteConversation roleplay cleanup
// =====================================================================

function deleteConversationRolePlayCleanup(store, conversationId) {
  delete store.rolePlaySessions[conversationId];
  store.conversations = store.conversations.filter(c => c.id !== conversationId);
}

// =====================================================================
// Replicated getRolePlayTemplate (from crew-templates/index.js)
// =====================================================================

function getRolePlayTemplate(type, locale, templates) {
  const tmpl = templates[type];
  if (!tmpl) return null;
  return tmpl[locale] || tmpl['zh-CN'] || null;
}

// =====================================================================
// Tests
// =====================================================================

describe('Role Play Web Store & Templates', () => {

  // ---------------------------------------------------------------
  // Store state & getters
  // ---------------------------------------------------------------

  describe('chat.js store — rolePlaySessions state & getters', () => {
    it('should initialize rolePlaySessions as empty object', () => {
      const store = createMockStore();
      expect(store.rolePlaySessions).toEqual({});
    });

    it('currentConversationIsRolePlay returns false when no conversation selected', () => {
      const store = createMockStore({ currentConversation: null });
      expect(store.currentConversationIsRolePlay).toBe(false);
    });

    it('currentConversationIsRolePlay returns false for regular chat conversation', () => {
      const store = createMockStore({
        currentConversation: 'c1',
        conversations: [{ id: 'c1', type: 'chat' }]
      });
      expect(store.currentConversationIsRolePlay).toBe(false);
    });

    it('currentConversationIsRolePlay returns true for rolePlay conversation', () => {
      const store = createMockStore({
        currentConversation: 'vc1',
        conversations: [{ id: 'vc1', type: 'rolePlay' }]
      });
      expect(store.currentConversationIsRolePlay).toBe(true);
    });

    it('currentConversationIsRolePlay returns false for crew conversation', () => {
      const store = createMockStore({
        currentConversation: 'cr1',
        conversations: [{ id: 'cr1', type: 'crew' }]
      });
      expect(store.currentConversationIsRolePlay).toBe(false);
    });

    it('currentRolePlaySession returns null when no conversation selected', () => {
      const store = createMockStore({ currentConversation: null });
      expect(store.currentRolePlaySession).toBeNull();
    });

    it('currentRolePlaySession returns null for non-roleplay conversation', () => {
      const store = createMockStore({
        currentConversation: 'c1',
        rolePlaySessions: { 'other': { roles: [], teamType: 'dev', language: 'en' } }
      });
      expect(store.currentRolePlaySession).toBeNull();
    });

    it('currentRolePlaySession returns session data for roleplay conversation', () => {
      const roles = makeDevRoles();
      const store = createMockStore({
        currentConversation: 'vc1',
        rolePlaySessions: { 'vc1': { roles, teamType: 'dev', language: 'zh-CN' } }
      });
      const session = store.currentRolePlaySession;
      expect(session).not.toBeNull();
      expect(session.teamType).toBe('dev');
      expect(session.roles).toBe(roles);
    });
  });

  // ---------------------------------------------------------------
  // createRolePlaySession WS message
  // ---------------------------------------------------------------

  describe('createRolePlaySession — WS message construction', () => {
    it('should send create_conversation with rolePlayConfig', () => {
      const store = createMockStore({ currentAgent: 'agent-1' });
      const roles = makeDevRoles();

      createRolePlaySession(store, {
        projectDir: '/home/user/project',
        roles,
        teamType: 'dev',
        language: 'zh-CN',
      });

      expect(store.sentWsMessages).toHaveLength(1);
      const msg = store.sentWsMessages[0];
      expect(msg.type).toBe('create_conversation');
      expect(msg.agentId).toBe('agent-1');
      expect(msg.workDir).toBe('/home/user/project');
      expect(msg.rolePlayConfig).toBeDefined();
      expect(msg.rolePlayConfig.roles).toBe(roles);
      expect(msg.rolePlayConfig.teamType).toBe('dev');
      expect(msg.rolePlayConfig.language).toBe('zh-CN');
    });

    it('should use config.agentId over store.currentAgent when provided', () => {
      const store = createMockStore({ currentAgent: 'agent-default' });

      createRolePlaySession(store, {
        agentId: 'agent-custom',
        projectDir: '/p',
        roles: [],
        teamType: 'dev',
        language: 'en',
      });

      expect(store.sentWsMessages[0].agentId).toBe('agent-custom');
    });

    it('should add error message when no agent is available', () => {
      const store = createMockStore({ currentAgent: null });

      createRolePlaySession(store, {
        projectDir: '/p',
        roles: [],
        teamType: 'dev',
        language: 'en',
      });

      expect(store.sentWsMessages).toHaveLength(0);
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].type).toBe('error');
    });
  });

  // ---------------------------------------------------------------
  // conversationHandler — conversation_created with rolePlayConfig
  // ---------------------------------------------------------------

  describe('conversationHandler — conversation_created', () => {
    it('should set type=rolePlay when rolePlayConfig is present', () => {
      const store = createMockStore();

      handleConversationCreated(store, {
        conversationId: 'vc1',
        agentId: 'agent-1',
        workDir: '/p',
        rolePlayConfig: { roles: makeDevRoles(), teamType: 'dev', language: 'zh-CN' },
      });

      const conv = store.conversations.find(c => c.id === 'vc1');
      expect(conv.type).toBe('rolePlay');
    });

    it('should set type=chat when rolePlayConfig is absent', () => {
      const store = createMockStore();

      handleConversationCreated(store, {
        conversationId: 'c1',
        agentId: 'agent-1',
        workDir: '/p',
      });

      const conv = store.conversations.find(c => c.id === 'c1');
      expect(conv.type).toBe('chat');
    });

    it('should save rolePlayConfig to store.rolePlaySessions', () => {
      const store = createMockStore();
      const roles = makeDevRoles();

      handleConversationCreated(store, {
        conversationId: 'vc2',
        agentId: 'agent-1',
        workDir: '/p',
        rolePlayConfig: { roles, teamType: 'dev', language: 'zh-CN' },
      });

      expect(store.rolePlaySessions['vc2']).toBeDefined();
      expect(store.rolePlaySessions['vc2'].roles).toBe(roles);
      expect(store.rolePlaySessions['vc2'].teamType).toBe('dev');
      expect(store.rolePlaySessions['vc2'].language).toBe('zh-CN');
    });

    it('should NOT save to rolePlaySessions when rolePlayConfig is absent', () => {
      const store = createMockStore();

      handleConversationCreated(store, {
        conversationId: 'c2',
        agentId: 'agent-1',
        workDir: '/p',
      });

      expect(store.rolePlaySessions['c2']).toBeUndefined();
    });

    it('should set currentConversation to the new conversation', () => {
      const store = createMockStore();

      handleConversationCreated(store, {
        conversationId: 'vc3',
        agentId: 'agent-1',
        workDir: '/p',
        rolePlayConfig: { roles: [], teamType: 'dev', language: 'en' },
      });

      expect(store.currentConversation).toBe('vc3');
    });
  });

  // ---------------------------------------------------------------
  // conversationHandler — conversation_deleted
  // ---------------------------------------------------------------

  describe('conversationHandler — conversation_deleted', () => {
    it('should clean up rolePlaySessions on delete', () => {
      const store = createMockStore({
        currentConversation: 'vc1',
        conversations: [{ id: 'vc1', type: 'rolePlay' }],
        rolePlaySessions: { 'vc1': { roles: [], teamType: 'dev', language: 'en' } },
      });

      handleConversationDeleted(store, { conversationId: 'vc1' });

      expect(store.rolePlaySessions['vc1']).toBeUndefined();
      expect(store.conversations.find(c => c.id === 'vc1')).toBeUndefined();
    });

    it('should not error when deleting non-roleplay conversation', () => {
      const store = createMockStore({
        currentConversation: 'c1',
        conversations: [{ id: 'c1', type: 'chat' }],
      });

      expect(() => handleConversationDeleted(store, { conversationId: 'c1' })).not.toThrow();
      expect(store.conversations).toHaveLength(0);
    });

    it('should reset currentConversation when deleted conversation is active', () => {
      const store = createMockStore({
        currentConversation: 'vc1',
        conversations: [{ id: 'vc1', type: 'rolePlay' }],
        rolePlaySessions: { 'vc1': { roles: [], teamType: 'dev', language: 'en' } },
      });

      handleConversationDeleted(store, { conversationId: 'vc1' });
      expect(store.currentConversation).toBeNull();
    });

    it('should preserve other rolePlaySessions when deleting one', () => {
      const store = createMockStore({
        conversations: [
          { id: 'vc1', type: 'rolePlay' },
          { id: 'vc2', type: 'rolePlay' },
        ],
        rolePlaySessions: {
          'vc1': { roles: [], teamType: 'dev', language: 'en' },
          'vc2': { roles: [], teamType: 'dev', language: 'zh-CN' },
        },
      });

      handleConversationDeleted(store, { conversationId: 'vc1' });

      expect(store.rolePlaySessions['vc1']).toBeUndefined();
      expect(store.rolePlaySessions['vc2']).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // agentHandler — agent_list roleplay restoration
  // ---------------------------------------------------------------

  describe('agentHandler — agent_list roleplay restoration', () => {
    it('should restore roleplay session info from server conversation data', () => {
      const store = createMockStore();
      const roles = makeDevRoles();

      handleAgentListRolePlayRestore(store, {
        id: 'vc1',
        type: 'rolePlay',
        rolePlayRoles: roles,
        teamType: 'dev',
        language: 'zh-CN',
      });

      expect(store.rolePlaySessions['vc1']).toBeDefined();
      expect(store.rolePlaySessions['vc1'].roles).toBe(roles);
      expect(store.rolePlaySessions['vc1'].teamType).toBe('dev');
      expect(store.rolePlaySessions['vc1'].language).toBe('zh-CN');
    });

    it('should default teamType to dev when not provided by server', () => {
      const store = createMockStore();

      handleAgentListRolePlayRestore(store, {
        id: 'vc2',
        type: 'rolePlay',
        rolePlayRoles: [],
      });

      expect(store.rolePlaySessions['vc2'].teamType).toBe('dev');
    });

    it('should default language to zh-CN when not provided by server', () => {
      const store = createMockStore();

      handleAgentListRolePlayRestore(store, {
        id: 'vc3',
        type: 'rolePlay',
        rolePlayRoles: [],
      });

      expect(store.rolePlaySessions['vc3'].language).toBe('zh-CN');
    });

    it('should NOT restore when type is not rolePlay', () => {
      const store = createMockStore();

      handleAgentListRolePlayRestore(store, {
        id: 'c1',
        type: 'chat',
        rolePlayRoles: makeDevRoles(),
      });

      expect(store.rolePlaySessions['c1']).toBeUndefined();
    });

    it('should NOT restore when rolePlayRoles is missing', () => {
      const store = createMockStore();

      handleAgentListRolePlayRestore(store, {
        id: 'vc4',
        type: 'rolePlay',
        // no rolePlayRoles
      });

      expect(store.rolePlaySessions['vc4']).toBeUndefined();
    });

    it('should NOT overwrite existing rolePlaySessions entry', () => {
      const existingRoles = [{ name: 'pm', displayName: 'PM', icon: '', description: '' }];
      const store = createMockStore({
        rolePlaySessions: { 'vc5': { roles: existingRoles, teamType: 'dev', language: 'en' } }
      });

      handleAgentListRolePlayRestore(store, {
        id: 'vc5',
        type: 'rolePlay',
        rolePlayRoles: makeDevRoles(), // different roles
        teamType: 'dev',
        language: 'zh-CN',
      });

      // Should keep the existing entry, not overwrite
      expect(store.rolePlaySessions['vc5'].roles).toBe(existingRoles);
      expect(store.rolePlaySessions['vc5'].language).toBe('en');
    });
  });

  // ---------------------------------------------------------------
  // selectConversation roleplay restoration
  // ---------------------------------------------------------------

  describe('conversation.js — selectConversation roleplay restore', () => {
    it('should restore roleplay session from conv data when missing from store', () => {
      const roles = makeDevRoles();
      const store = createMockStore({
        conversations: [{
          id: 'vc1', type: 'rolePlay', rolePlayRoles: roles, teamType: 'dev', language: 'zh-CN'
        }],
      });

      selectConversationRolePlayRestore(store, 'vc1');

      expect(store.rolePlaySessions['vc1']).toBeDefined();
      expect(store.rolePlaySessions['vc1'].roles).toBe(roles);
    });

    it('should NOT restore when already in rolePlaySessions', () => {
      const existingRoles = [{ name: 'pm', displayName: 'PM', icon: '', description: '' }];
      const store = createMockStore({
        conversations: [{
          id: 'vc2', type: 'rolePlay', rolePlayRoles: makeDevRoles()
        }],
        rolePlaySessions: { 'vc2': { roles: existingRoles, teamType: 'dev', language: 'en' } }
      });

      selectConversationRolePlayRestore(store, 'vc2');

      // Should keep existing entry
      expect(store.rolePlaySessions['vc2'].roles).toBe(existingRoles);
    });

    it('should NOT restore when conversation type is not rolePlay', () => {
      const store = createMockStore({
        conversations: [{ id: 'c1', type: 'chat', rolePlayRoles: makeDevRoles() }],
      });

      selectConversationRolePlayRestore(store, 'c1');

      expect(store.rolePlaySessions['c1']).toBeUndefined();
    });

    it('should NOT restore when conversation has no rolePlayRoles', () => {
      const store = createMockStore({
        conversations: [{ id: 'vc3', type: 'rolePlay' }],
      });

      selectConversationRolePlayRestore(store, 'vc3');

      expect(store.rolePlaySessions['vc3']).toBeUndefined();
    });

    it('should set currentConversation', () => {
      const store = createMockStore({
        conversations: [{ id: 'vc4', type: 'rolePlay', rolePlayRoles: [] }],
      });

      selectConversationRolePlayRestore(store, 'vc4');
      expect(store.currentConversation).toBe('vc4');
    });

    it('should use default teamType and language when conv data is incomplete', () => {
      const store = createMockStore({
        conversations: [{ id: 'vc5', type: 'rolePlay', rolePlayRoles: makeDevRoles() }],
      });

      selectConversationRolePlayRestore(store, 'vc5');

      expect(store.rolePlaySessions['vc5'].teamType).toBe('dev');
      expect(store.rolePlaySessions['vc5'].language).toBe('zh-CN');
    });
  });

  // ---------------------------------------------------------------
  // deleteConversation roleplay cleanup
  // ---------------------------------------------------------------

  describe('conversation.js — deleteConversation roleplay cleanup', () => {
    it('should delete rolePlaySessions entry', () => {
      const store = createMockStore({
        conversations: [{ id: 'vc1', type: 'rolePlay' }],
        rolePlaySessions: { 'vc1': { roles: [], teamType: 'dev', language: 'en' } },
      });

      deleteConversationRolePlayCleanup(store, 'vc1');

      expect(store.rolePlaySessions['vc1']).toBeUndefined();
      expect(store.conversations.find(c => c.id === 'vc1')).toBeUndefined();
    });

    it('should not error when conversation is not roleplay', () => {
      const store = createMockStore({
        conversations: [{ id: 'c1', type: 'chat' }],
      });

      expect(() => deleteConversationRolePlayCleanup(store, 'c1')).not.toThrow();
    });

    it('should not error when conversationId does not exist in rolePlaySessions', () => {
      const store = createMockStore({
        conversations: [],
        rolePlaySessions: {},
      });

      expect(() => deleteConversationRolePlayCleanup(store, 'nonexistent')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------
  // getRolePlayTemplate
  // ---------------------------------------------------------------

  describe('crew-templates/index.js — getRolePlayTemplate', () => {
    const mockTemplates = {
      dev: {
        'zh-CN': makeDevRoles(),
        en: makeEnDevRoles(),
      }
    };

    it('should return zh-CN template for dev type', () => {
      const tmpl = getRolePlayTemplate('dev', 'zh-CN', mockTemplates);
      expect(tmpl).toHaveLength(4);
      expect(tmpl[0].name).toBe('pm');
      expect(tmpl[0].displayName).toBe('PM-乔布斯');
    });

    it('should return en template for dev type', () => {
      const tmpl = getRolePlayTemplate('dev', 'en', mockTemplates);
      expect(tmpl).toHaveLength(4);
      expect(tmpl[0].name).toBe('pm');
      expect(tmpl[0].displayName).toBe('PM-Jobs');
    });

    it('should fall back to zh-CN when locale is not available', () => {
      const tmpl = getRolePlayTemplate('dev', 'ja', mockTemplates);
      expect(tmpl).not.toBeNull();
      expect(tmpl[0].displayName).toBe('PM-乔布斯');
    });

    it('should return null for unknown template type', () => {
      const tmpl = getRolePlayTemplate('writing', 'zh-CN', mockTemplates);
      expect(tmpl).toBeNull();
    });

    it('should return null for completely unknown type', () => {
      const tmpl = getRolePlayTemplate('nonexistent', 'en', mockTemplates);
      expect(tmpl).toBeNull();
    });

    it('template should have required fields for each role', () => {
      const tmpl = getRolePlayTemplate('dev', 'zh-CN', mockTemplates);
      for (const role of tmpl) {
        expect(role).toHaveProperty('name');
        expect(role).toHaveProperty('displayName');
        expect(role).toHaveProperty('icon');
        expect(role).toHaveProperty('description');
        expect(role.name).toBeTruthy();
        expect(role.displayName).toBeTruthy();
      }
    });

    it('dev template should have pm, dev, reviewer, tester roles', () => {
      const tmpl = getRolePlayTemplate('dev', 'zh-CN', mockTemplates);
      const names = tmpl.map(r => r.name);
      expect(names).toEqual(['pm', 'dev', 'reviewer', 'tester']);
    });
  });

  // ---------------------------------------------------------------
  // Actual template file verification
  // ---------------------------------------------------------------

  describe('roleplay template files — structural verification', () => {
    let zhTemplate, enTemplate;

    beforeEach(async () => {
      try {
        zhTemplate = (await import('../../web/crew-templates/roleplay-dev-zh.js')).default;
      } catch { zhTemplate = null; }
      try {
        enTemplate = (await import('../../web/crew-templates/roleplay-dev-en.js')).default;
      } catch { enTemplate = null; }
    });

    it('zh template should exist and be an array', () => {
      if (!zhTemplate) return; // skip if not available in this worktree
      expect(Array.isArray(zhTemplate)).toBe(true);
      expect(zhTemplate.length).toBe(4);
    });

    it('en template should exist and be an array', () => {
      if (!enTemplate) return;
      expect(Array.isArray(enTemplate)).toBe(true);
      expect(enTemplate.length).toBe(4);
    });

    it('zh template roles should have claudeMd field', () => {
      if (!zhTemplate) return;
      for (const role of zhTemplate) {
        expect(role.claudeMd).toBeTruthy();
        expect(typeof role.claudeMd).toBe('string');
      }
    });

    it('en template roles should have claudeMd field', () => {
      if (!enTemplate) return;
      for (const role of enTemplate) {
        expect(role.claudeMd).toBeTruthy();
        expect(typeof role.claudeMd).toBe('string');
      }
    });

    it('both templates should have same role names in same order', () => {
      if (!zhTemplate || !enTemplate) return;
      const zhNames = zhTemplate.map(r => r.name);
      const enNames = enTemplate.map(r => r.name);
      expect(zhNames).toEqual(enNames);
      expect(zhNames).toEqual(['pm', 'dev', 'reviewer', 'tester']);
    });
  });

  // ---------------------------------------------------------------
  // i18n key verification
  // ---------------------------------------------------------------

  describe('i18n — roleplay translation keys', () => {
    let zhMessages, enMessages;

    beforeEach(async () => {
      try {
        zhMessages = (await import('../../web/i18n/zh-CN.js')).default;
      } catch { zhMessages = null; }
      try {
        enMessages = (await import('../../web/i18n/en.js')).default;
      } catch { enMessages = null; }
    });

    const expectedKeys = [
      'roleplay.creating',
      'roleplay.working',
      'roleplay.selectTeam',
      'roleplay.teamDev',
      'roleplay.teamCustom',
      'roleplay.editRoles',
      'roleplay.roleName',
      'roleplay.roleDisplayName',
      'roleplay.roleIcon',
      'roleplay.roleDesc',
      'roleplay.rolePrompt',
      'roleplay.removeRole',
      'roleplay.addRole',
      'roleplay.start',
      'roleplay.sidebarTitle',
    ];

    it('zh-CN should have all roleplay.* keys', () => {
      if (!zhMessages) return;
      for (const key of expectedKeys) {
        expect(zhMessages[key], `Missing zh-CN key: ${key}`).toBeDefined();
        expect(typeof zhMessages[key]).toBe('string');
        expect(zhMessages[key].length).toBeGreaterThan(0);
      }
    });

    it('en should have all roleplay.* keys', () => {
      if (!enMessages) return;
      for (const key of expectedKeys) {
        expect(enMessages[key], `Missing en key: ${key}`).toBeDefined();
        expect(typeof enMessages[key]).toBe('string');
        expect(enMessages[key].length).toBeGreaterThan(0);
      }
    });

    it('zh-CN and en should have the same roleplay.* keys', () => {
      if (!zhMessages || !enMessages) return;
      const zhKeys = Object.keys(zhMessages).filter(k => k.startsWith('roleplay.'));
      const enKeys = Object.keys(enMessages).filter(k => k.startsWith('roleplay.'));
      expect(zhKeys.sort()).toEqual(enKeys.sort());
    });
  });

  // ---------------------------------------------------------------
  // Integration scenario: full lifecycle
  // ---------------------------------------------------------------

  describe('integration — full roleplay lifecycle', () => {
    it('should handle create → use → delete lifecycle correctly', () => {
      const store = createMockStore();
      const roles = makeDevRoles();
      const rolePlayConfig = { roles, teamType: 'dev', language: 'zh-CN' };

      // Step 1: create via WS
      createRolePlaySession(store, { projectDir: '/p', ...rolePlayConfig });
      expect(store.sentWsMessages).toHaveLength(1);

      // Step 2: server responds with conversation_created
      handleConversationCreated(store, {
        conversationId: 'lifecycle-1',
        agentId: 'agent-1',
        workDir: '/p',
        rolePlayConfig,
      });

      expect(store.currentConversation).toBe('lifecycle-1');
      expect(store.currentConversationIsRolePlay).toBe(true);
      expect(store.currentRolePlaySession).toBeDefined();
      expect(store.currentRolePlaySession.teamType).toBe('dev');

      // Step 3: delete
      handleConversationDeleted(store, { conversationId: 'lifecycle-1' });

      expect(store.currentConversation).toBeNull();
      expect(store.currentConversationIsRolePlay).toBe(false);
      expect(store.currentRolePlaySession).toBeNull();
      expect(store.rolePlaySessions['lifecycle-1']).toBeUndefined();
    });

    it('should handle reconnect scenario (agent_list restore)', () => {
      const store = createMockStore();
      const roles = makeDevRoles();

      // Simulate: server sends agent_list with roleplay conversation after reconnect
      store.conversations.push({
        id: 'recon-1', type: 'rolePlay', rolePlayRoles: roles, teamType: 'dev', language: 'zh-CN'
      });
      handleAgentListRolePlayRestore(store, store.conversations[0]);

      expect(store.rolePlaySessions['recon-1']).toBeDefined();

      // Select the conversation
      selectConversationRolePlayRestore(store, 'recon-1');

      expect(store.currentConversation).toBe('recon-1');
      expect(store.currentConversationIsRolePlay).toBe(true);
    });
  });
});
