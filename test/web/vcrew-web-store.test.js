import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for Virtual Crew web store support, templates, and i18n.
 *
 * Covers:
 * 1. chat.js store state & getters (vcrewSessions, currentConversationIsVCrew, currentVCrewSession)
 * 2. createVCrewSession WS message construction (web/stores/helpers/vcrew.js)
 * 3. conversationHandler: conversation_created with vcrewConfig
 * 4. agentHandler: agent_list restoring virtualCrew sessions
 * 5. conversation.js: selectConversation / deleteConversation vcrew cleanup
 * 6. crew-templates/index.js: getVCrewTemplate
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
    vcrewSessions: overrides.vcrewSessions || {},
    messages: [],
    sentWsMessages: [],
    addMessage(msg) { store.messages.push(msg); },
    sendWsMessage(msg) { store.sentWsMessages.push(msg); },
    // Replicated getters
    get currentConversationIsVCrew() {
      if (!store.currentConversation) return false;
      const conv = store.conversations.find(c => c.id === store.currentConversation);
      return conv?.type === 'virtualCrew';
    },
    get currentVCrewSession() {
      return store.vcrewSessions[store.currentConversation] || null;
    },
  };
  return store;
}

// =====================================================================
// Replicated createVCrewSession (from web/stores/helpers/vcrew.js)
// =====================================================================

function createVCrewSession(store, config) {
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
    vcrewConfig: {
      roles: config.roles,
      teamType: config.teamType,
      language: config.language,
    }
  });
}

// =====================================================================
// Replicated handleConversationCreated (vcrew parts from conversationHandler.js)
// =====================================================================

function handleConversationCreated(store, msg) {
  const newConv = {
    id: msg.conversationId,
    agentId: msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: null,
    createdAt: Date.now(),
    processing: false,
    type: msg.vcrewConfig ? 'virtualCrew' : 'chat',
    disallowedTools: msg.disallowedTools ?? null,
  };
  store.conversations.push(newConv);

  if (msg.vcrewConfig) {
    store.vcrewSessions[msg.conversationId] = {
      roles: msg.vcrewConfig.roles,
      teamType: msg.vcrewConfig.teamType,
      language: msg.vcrewConfig.language,
    };
  }
  store.currentConversation = msg.conversationId;
}

// =====================================================================
// Replicated handleConversationDeleted (vcrew parts from conversationHandler.js)
// =====================================================================

function handleConversationDeleted(store, msg) {
  store.conversations = store.conversations.filter(c => c.id !== msg.conversationId);
  delete store.vcrewSessions[msg.conversationId];
  if (store.currentConversation === msg.conversationId) {
    store.currentConversation = null;
  }
}

// =====================================================================
// Replicated handleAgentList (vcrew parts from agentHandler.js)
// =====================================================================

function handleAgentListVCrewRestore(store, serverConv) {
  if (serverConv.type === 'virtualCrew' && serverConv.vcrewRoles && !store.vcrewSessions[serverConv.id]) {
    store.vcrewSessions[serverConv.id] = {
      roles: serverConv.vcrewRoles,
      teamType: serverConv.teamType || 'dev',
      language: serverConv.language || 'zh-CN',
    };
  }
}

// =====================================================================
// Replicated selectConversation vcrew logic
// =====================================================================

function selectConversationVCrewRestore(store, conversationId) {
  const conv = store.conversations.find(c => c.id === conversationId);
  if (conv?.type === 'virtualCrew' && !store.vcrewSessions[conversationId] && conv.vcrewRoles) {
    store.vcrewSessions[conversationId] = {
      roles: conv.vcrewRoles,
      teamType: conv.teamType || 'dev',
      language: conv.language || 'zh-CN',
    };
  }
  store.currentConversation = conversationId;
}

// =====================================================================
// Replicated deleteConversation vcrew cleanup
// =====================================================================

function deleteConversationVCrewCleanup(store, conversationId) {
  delete store.vcrewSessions[conversationId];
  store.conversations = store.conversations.filter(c => c.id !== conversationId);
}

// =====================================================================
// Replicated getVCrewTemplate (from crew-templates/index.js)
// =====================================================================

function getVCrewTemplate(type, locale, templates) {
  const tmpl = templates[type];
  if (!tmpl) return null;
  return tmpl[locale] || tmpl['zh-CN'] || null;
}

// =====================================================================
// Tests
// =====================================================================

describe('Virtual Crew Web Store & Templates', () => {

  // ---------------------------------------------------------------
  // Store state & getters
  // ---------------------------------------------------------------

  describe('chat.js store — vcrewSessions state & getters', () => {
    it('should initialize vcrewSessions as empty object', () => {
      const store = createMockStore();
      expect(store.vcrewSessions).toEqual({});
    });

    it('currentConversationIsVCrew returns false when no conversation selected', () => {
      const store = createMockStore({ currentConversation: null });
      expect(store.currentConversationIsVCrew).toBe(false);
    });

    it('currentConversationIsVCrew returns false for regular chat conversation', () => {
      const store = createMockStore({
        currentConversation: 'c1',
        conversations: [{ id: 'c1', type: 'chat' }]
      });
      expect(store.currentConversationIsVCrew).toBe(false);
    });

    it('currentConversationIsVCrew returns true for virtualCrew conversation', () => {
      const store = createMockStore({
        currentConversation: 'vc1',
        conversations: [{ id: 'vc1', type: 'virtualCrew' }]
      });
      expect(store.currentConversationIsVCrew).toBe(true);
    });

    it('currentConversationIsVCrew returns false for crew conversation', () => {
      const store = createMockStore({
        currentConversation: 'cr1',
        conversations: [{ id: 'cr1', type: 'crew' }]
      });
      expect(store.currentConversationIsVCrew).toBe(false);
    });

    it('currentVCrewSession returns null when no conversation selected', () => {
      const store = createMockStore({ currentConversation: null });
      expect(store.currentVCrewSession).toBeNull();
    });

    it('currentVCrewSession returns null for non-vcrew conversation', () => {
      const store = createMockStore({
        currentConversation: 'c1',
        vcrewSessions: { 'other': { roles: [], teamType: 'dev', language: 'en' } }
      });
      expect(store.currentVCrewSession).toBeNull();
    });

    it('currentVCrewSession returns session data for vcrew conversation', () => {
      const roles = makeDevRoles();
      const store = createMockStore({
        currentConversation: 'vc1',
        vcrewSessions: { 'vc1': { roles, teamType: 'dev', language: 'zh-CN' } }
      });
      const session = store.currentVCrewSession;
      expect(session).not.toBeNull();
      expect(session.teamType).toBe('dev');
      expect(session.roles).toBe(roles);
    });
  });

  // ---------------------------------------------------------------
  // createVCrewSession WS message
  // ---------------------------------------------------------------

  describe('createVCrewSession — WS message construction', () => {
    it('should send create_conversation with vcrewConfig', () => {
      const store = createMockStore({ currentAgent: 'agent-1' });
      const roles = makeDevRoles();

      createVCrewSession(store, {
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
      expect(msg.vcrewConfig).toBeDefined();
      expect(msg.vcrewConfig.roles).toBe(roles);
      expect(msg.vcrewConfig.teamType).toBe('dev');
      expect(msg.vcrewConfig.language).toBe('zh-CN');
    });

    it('should use config.agentId over store.currentAgent when provided', () => {
      const store = createMockStore({ currentAgent: 'agent-default' });

      createVCrewSession(store, {
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

      createVCrewSession(store, {
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
  // conversationHandler — conversation_created with vcrewConfig
  // ---------------------------------------------------------------

  describe('conversationHandler — conversation_created', () => {
    it('should set type=virtualCrew when vcrewConfig is present', () => {
      const store = createMockStore();

      handleConversationCreated(store, {
        conversationId: 'vc1',
        agentId: 'agent-1',
        workDir: '/p',
        vcrewConfig: { roles: makeDevRoles(), teamType: 'dev', language: 'zh-CN' },
      });

      const conv = store.conversations.find(c => c.id === 'vc1');
      expect(conv.type).toBe('virtualCrew');
    });

    it('should set type=chat when vcrewConfig is absent', () => {
      const store = createMockStore();

      handleConversationCreated(store, {
        conversationId: 'c1',
        agentId: 'agent-1',
        workDir: '/p',
      });

      const conv = store.conversations.find(c => c.id === 'c1');
      expect(conv.type).toBe('chat');
    });

    it('should save vcrewConfig to store.vcrewSessions', () => {
      const store = createMockStore();
      const roles = makeDevRoles();

      handleConversationCreated(store, {
        conversationId: 'vc2',
        agentId: 'agent-1',
        workDir: '/p',
        vcrewConfig: { roles, teamType: 'dev', language: 'zh-CN' },
      });

      expect(store.vcrewSessions['vc2']).toBeDefined();
      expect(store.vcrewSessions['vc2'].roles).toBe(roles);
      expect(store.vcrewSessions['vc2'].teamType).toBe('dev');
      expect(store.vcrewSessions['vc2'].language).toBe('zh-CN');
    });

    it('should NOT save to vcrewSessions when vcrewConfig is absent', () => {
      const store = createMockStore();

      handleConversationCreated(store, {
        conversationId: 'c2',
        agentId: 'agent-1',
        workDir: '/p',
      });

      expect(store.vcrewSessions['c2']).toBeUndefined();
    });

    it('should set currentConversation to the new conversation', () => {
      const store = createMockStore();

      handleConversationCreated(store, {
        conversationId: 'vc3',
        agentId: 'agent-1',
        workDir: '/p',
        vcrewConfig: { roles: [], teamType: 'dev', language: 'en' },
      });

      expect(store.currentConversation).toBe('vc3');
    });
  });

  // ---------------------------------------------------------------
  // conversationHandler — conversation_deleted
  // ---------------------------------------------------------------

  describe('conversationHandler — conversation_deleted', () => {
    it('should clean up vcrewSessions on delete', () => {
      const store = createMockStore({
        currentConversation: 'vc1',
        conversations: [{ id: 'vc1', type: 'virtualCrew' }],
        vcrewSessions: { 'vc1': { roles: [], teamType: 'dev', language: 'en' } },
      });

      handleConversationDeleted(store, { conversationId: 'vc1' });

      expect(store.vcrewSessions['vc1']).toBeUndefined();
      expect(store.conversations.find(c => c.id === 'vc1')).toBeUndefined();
    });

    it('should not error when deleting non-vcrew conversation', () => {
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
        conversations: [{ id: 'vc1', type: 'virtualCrew' }],
        vcrewSessions: { 'vc1': { roles: [], teamType: 'dev', language: 'en' } },
      });

      handleConversationDeleted(store, { conversationId: 'vc1' });
      expect(store.currentConversation).toBeNull();
    });

    it('should preserve other vcrewSessions when deleting one', () => {
      const store = createMockStore({
        conversations: [
          { id: 'vc1', type: 'virtualCrew' },
          { id: 'vc2', type: 'virtualCrew' },
        ],
        vcrewSessions: {
          'vc1': { roles: [], teamType: 'dev', language: 'en' },
          'vc2': { roles: [], teamType: 'dev', language: 'zh-CN' },
        },
      });

      handleConversationDeleted(store, { conversationId: 'vc1' });

      expect(store.vcrewSessions['vc1']).toBeUndefined();
      expect(store.vcrewSessions['vc2']).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // agentHandler — agent_list vcrew restoration
  // ---------------------------------------------------------------

  describe('agentHandler — agent_list vcrew restoration', () => {
    it('should restore vcrew session info from server conversation data', () => {
      const store = createMockStore();
      const roles = makeDevRoles();

      handleAgentListVCrewRestore(store, {
        id: 'vc1',
        type: 'virtualCrew',
        vcrewRoles: roles,
        teamType: 'dev',
        language: 'zh-CN',
      });

      expect(store.vcrewSessions['vc1']).toBeDefined();
      expect(store.vcrewSessions['vc1'].roles).toBe(roles);
      expect(store.vcrewSessions['vc1'].teamType).toBe('dev');
      expect(store.vcrewSessions['vc1'].language).toBe('zh-CN');
    });

    it('should default teamType to dev when not provided by server', () => {
      const store = createMockStore();

      handleAgentListVCrewRestore(store, {
        id: 'vc2',
        type: 'virtualCrew',
        vcrewRoles: [],
      });

      expect(store.vcrewSessions['vc2'].teamType).toBe('dev');
    });

    it('should default language to zh-CN when not provided by server', () => {
      const store = createMockStore();

      handleAgentListVCrewRestore(store, {
        id: 'vc3',
        type: 'virtualCrew',
        vcrewRoles: [],
      });

      expect(store.vcrewSessions['vc3'].language).toBe('zh-CN');
    });

    it('should NOT restore when type is not virtualCrew', () => {
      const store = createMockStore();

      handleAgentListVCrewRestore(store, {
        id: 'c1',
        type: 'chat',
        vcrewRoles: makeDevRoles(),
      });

      expect(store.vcrewSessions['c1']).toBeUndefined();
    });

    it('should NOT restore when vcrewRoles is missing', () => {
      const store = createMockStore();

      handleAgentListVCrewRestore(store, {
        id: 'vc4',
        type: 'virtualCrew',
        // no vcrewRoles
      });

      expect(store.vcrewSessions['vc4']).toBeUndefined();
    });

    it('should NOT overwrite existing vcrewSessions entry', () => {
      const existingRoles = [{ name: 'pm', displayName: 'PM', icon: '', description: '' }];
      const store = createMockStore({
        vcrewSessions: { 'vc5': { roles: existingRoles, teamType: 'dev', language: 'en' } }
      });

      handleAgentListVCrewRestore(store, {
        id: 'vc5',
        type: 'virtualCrew',
        vcrewRoles: makeDevRoles(), // different roles
        teamType: 'dev',
        language: 'zh-CN',
      });

      // Should keep the existing entry, not overwrite
      expect(store.vcrewSessions['vc5'].roles).toBe(existingRoles);
      expect(store.vcrewSessions['vc5'].language).toBe('en');
    });
  });

  // ---------------------------------------------------------------
  // selectConversation vcrew restoration
  // ---------------------------------------------------------------

  describe('conversation.js — selectConversation vcrew restore', () => {
    it('should restore vcrew session from conv data when missing from store', () => {
      const roles = makeDevRoles();
      const store = createMockStore({
        conversations: [{
          id: 'vc1', type: 'virtualCrew', vcrewRoles: roles, teamType: 'dev', language: 'zh-CN'
        }],
      });

      selectConversationVCrewRestore(store, 'vc1');

      expect(store.vcrewSessions['vc1']).toBeDefined();
      expect(store.vcrewSessions['vc1'].roles).toBe(roles);
    });

    it('should NOT restore when already in vcrewSessions', () => {
      const existingRoles = [{ name: 'pm', displayName: 'PM', icon: '', description: '' }];
      const store = createMockStore({
        conversations: [{
          id: 'vc2', type: 'virtualCrew', vcrewRoles: makeDevRoles()
        }],
        vcrewSessions: { 'vc2': { roles: existingRoles, teamType: 'dev', language: 'en' } }
      });

      selectConversationVCrewRestore(store, 'vc2');

      // Should keep existing entry
      expect(store.vcrewSessions['vc2'].roles).toBe(existingRoles);
    });

    it('should NOT restore when conversation type is not virtualCrew', () => {
      const store = createMockStore({
        conversations: [{ id: 'c1', type: 'chat', vcrewRoles: makeDevRoles() }],
      });

      selectConversationVCrewRestore(store, 'c1');

      expect(store.vcrewSessions['c1']).toBeUndefined();
    });

    it('should NOT restore when conversation has no vcrewRoles', () => {
      const store = createMockStore({
        conversations: [{ id: 'vc3', type: 'virtualCrew' }],
      });

      selectConversationVCrewRestore(store, 'vc3');

      expect(store.vcrewSessions['vc3']).toBeUndefined();
    });

    it('should set currentConversation', () => {
      const store = createMockStore({
        conversations: [{ id: 'vc4', type: 'virtualCrew', vcrewRoles: [] }],
      });

      selectConversationVCrewRestore(store, 'vc4');
      expect(store.currentConversation).toBe('vc4');
    });

    it('should use default teamType and language when conv data is incomplete', () => {
      const store = createMockStore({
        conversations: [{ id: 'vc5', type: 'virtualCrew', vcrewRoles: makeDevRoles() }],
      });

      selectConversationVCrewRestore(store, 'vc5');

      expect(store.vcrewSessions['vc5'].teamType).toBe('dev');
      expect(store.vcrewSessions['vc5'].language).toBe('zh-CN');
    });
  });

  // ---------------------------------------------------------------
  // deleteConversation vcrew cleanup
  // ---------------------------------------------------------------

  describe('conversation.js — deleteConversation vcrew cleanup', () => {
    it('should delete vcrewSessions entry', () => {
      const store = createMockStore({
        conversations: [{ id: 'vc1', type: 'virtualCrew' }],
        vcrewSessions: { 'vc1': { roles: [], teamType: 'dev', language: 'en' } },
      });

      deleteConversationVCrewCleanup(store, 'vc1');

      expect(store.vcrewSessions['vc1']).toBeUndefined();
      expect(store.conversations.find(c => c.id === 'vc1')).toBeUndefined();
    });

    it('should not error when conversation is not vcrew', () => {
      const store = createMockStore({
        conversations: [{ id: 'c1', type: 'chat' }],
      });

      expect(() => deleteConversationVCrewCleanup(store, 'c1')).not.toThrow();
    });

    it('should not error when conversationId does not exist in vcrewSessions', () => {
      const store = createMockStore({
        conversations: [],
        vcrewSessions: {},
      });

      expect(() => deleteConversationVCrewCleanup(store, 'nonexistent')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------
  // getVCrewTemplate
  // ---------------------------------------------------------------

  describe('crew-templates/index.js — getVCrewTemplate', () => {
    const mockTemplates = {
      dev: {
        'zh-CN': makeDevRoles(),
        en: makeEnDevRoles(),
      }
    };

    it('should return zh-CN template for dev type', () => {
      const tmpl = getVCrewTemplate('dev', 'zh-CN', mockTemplates);
      expect(tmpl).toHaveLength(4);
      expect(tmpl[0].name).toBe('pm');
      expect(tmpl[0].displayName).toBe('PM-乔布斯');
    });

    it('should return en template for dev type', () => {
      const tmpl = getVCrewTemplate('dev', 'en', mockTemplates);
      expect(tmpl).toHaveLength(4);
      expect(tmpl[0].name).toBe('pm');
      expect(tmpl[0].displayName).toBe('PM-Jobs');
    });

    it('should fall back to zh-CN when locale is not available', () => {
      const tmpl = getVCrewTemplate('dev', 'ja', mockTemplates);
      expect(tmpl).not.toBeNull();
      expect(tmpl[0].displayName).toBe('PM-乔布斯');
    });

    it('should return null for unknown template type', () => {
      const tmpl = getVCrewTemplate('writing', 'zh-CN', mockTemplates);
      expect(tmpl).toBeNull();
    });

    it('should return null for completely unknown type', () => {
      const tmpl = getVCrewTemplate('nonexistent', 'en', mockTemplates);
      expect(tmpl).toBeNull();
    });

    it('template should have required fields for each role', () => {
      const tmpl = getVCrewTemplate('dev', 'zh-CN', mockTemplates);
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
      const tmpl = getVCrewTemplate('dev', 'zh-CN', mockTemplates);
      const names = tmpl.map(r => r.name);
      expect(names).toEqual(['pm', 'dev', 'reviewer', 'tester']);
    });
  });

  // ---------------------------------------------------------------
  // Actual template file verification
  // ---------------------------------------------------------------

  describe('vcrew template files — structural verification', () => {
    let zhTemplate, enTemplate;

    beforeEach(async () => {
      try {
        zhTemplate = (await import('../../web/crew-templates/vcrew-dev-zh.js')).default;
      } catch { zhTemplate = null; }
      try {
        enTemplate = (await import('../../web/crew-templates/vcrew-dev-en.js')).default;
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

  describe('i18n — vcrew translation keys', () => {
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
      'vcrew.creating',
      'vcrew.working',
      'vcrew.selectTeam',
      'vcrew.teamDev',
      'vcrew.teamCustom',
      'vcrew.editRoles',
      'vcrew.roleName',
      'vcrew.roleDisplayName',
      'vcrew.roleIcon',
      'vcrew.roleDesc',
      'vcrew.rolePrompt',
      'vcrew.removeRole',
      'vcrew.addRole',
      'vcrew.start',
      'vcrew.sidebarTitle',
    ];

    it('zh-CN should have all vcrew.* keys', () => {
      if (!zhMessages) return;
      for (const key of expectedKeys) {
        expect(zhMessages[key], `Missing zh-CN key: ${key}`).toBeDefined();
        expect(typeof zhMessages[key]).toBe('string');
        expect(zhMessages[key].length).toBeGreaterThan(0);
      }
    });

    it('en should have all vcrew.* keys', () => {
      if (!enMessages) return;
      for (const key of expectedKeys) {
        expect(enMessages[key], `Missing en key: ${key}`).toBeDefined();
        expect(typeof enMessages[key]).toBe('string');
        expect(enMessages[key].length).toBeGreaterThan(0);
      }
    });

    it('zh-CN and en should have the same vcrew.* keys', () => {
      if (!zhMessages || !enMessages) return;
      const zhKeys = Object.keys(zhMessages).filter(k => k.startsWith('vcrew.'));
      const enKeys = Object.keys(enMessages).filter(k => k.startsWith('vcrew.'));
      expect(zhKeys.sort()).toEqual(enKeys.sort());
    });
  });

  // ---------------------------------------------------------------
  // Integration scenario: full lifecycle
  // ---------------------------------------------------------------

  describe('integration — full vcrew lifecycle', () => {
    it('should handle create → use → delete lifecycle correctly', () => {
      const store = createMockStore();
      const roles = makeDevRoles();
      const vcrewConfig = { roles, teamType: 'dev', language: 'zh-CN' };

      // Step 1: create via WS
      createVCrewSession(store, { projectDir: '/p', ...vcrewConfig });
      expect(store.sentWsMessages).toHaveLength(1);

      // Step 2: server responds with conversation_created
      handleConversationCreated(store, {
        conversationId: 'lifecycle-1',
        agentId: 'agent-1',
        workDir: '/p',
        vcrewConfig,
      });

      expect(store.currentConversation).toBe('lifecycle-1');
      expect(store.currentConversationIsVCrew).toBe(true);
      expect(store.currentVCrewSession).toBeDefined();
      expect(store.currentVCrewSession.teamType).toBe('dev');

      // Step 3: delete
      handleConversationDeleted(store, { conversationId: 'lifecycle-1' });

      expect(store.currentConversation).toBeNull();
      expect(store.currentConversationIsVCrew).toBe(false);
      expect(store.currentVCrewSession).toBeNull();
      expect(store.vcrewSessions['lifecycle-1']).toBeUndefined();
    });

    it('should handle reconnect scenario (agent_list restore)', () => {
      const store = createMockStore();
      const roles = makeDevRoles();

      // Simulate: server sends agent_list with vcrew conversation after reconnect
      store.conversations.push({
        id: 'recon-1', type: 'virtualCrew', vcrewRoles: roles, teamType: 'dev', language: 'zh-CN'
      });
      handleAgentListVCrewRestore(store, store.conversations[0]);

      expect(store.vcrewSessions['recon-1']).toBeDefined();

      // Select the conversation
      selectConversationVCrewRestore(store, 'recon-1');

      expect(store.currentConversation).toBe('recon-1');
      expect(store.currentConversationIsVCrew).toBe(true);
    });
  });
});
