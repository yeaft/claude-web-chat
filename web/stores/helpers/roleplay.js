/**
 * Role Play (single-conversation multi-role) store helpers.
 * Sends create_conversation with rolePlayConfig attached.
 */

import { setSessionLoading } from './session.js';
import { t } from '../../utils/i18n.js';

/**
 * Create a Role Play session.
 * Under the hood this is a normal conversation with rolePlayConfig attached,
 * so the agent knows to inject the multi-role system prompt.
 *
 * @param {Object} store  - Pinia chat store instance
 * @param {Object} config - { agentId?, projectDir, roles, teamType, language }
 */
export function createRolePlaySession(store, config) {
  const targetAgent = config.agentId || store.currentAgent;
  if (!targetAgent) {
    store.addMessage({ type: 'error', content: t('chat.agent.selectFirst') });
    return;
  }
  setSessionLoading(store, true, t('roleplay.creating'));

  store.sendWsMessage({
    type: 'create_conversation',
    agentId: targetAgent,
    workDir: config.projectDir,
    // ★ rolePlayConfig is piggybacked onto the standard create_conversation message.
    // The agent will persist this in rolePlaySessions and inject appendSystemPrompt.
    rolePlayConfig: {
      roles: config.roles,        // [{ name, displayName, icon, description, claudeMd }]
      teamType: config.teamType,  // 'dev' | 'writing' | ...
      language: config.language,  // 'zh-CN' | 'en'
    }
  });
}

/**
 * Restore an existing Role Play session from .roleplay/session.json.
 *
 * If the original conversationId still exists on the server, we select it.
 * Otherwise we create a new conversation and attach the same rolePlayConfig
 * so the agent re-initializes the session state.
 *
 * @param {Object} store  - Pinia chat store instance
 * @param {Object} config - { agentId, projectDir, session }
 *   session: { name, teamType, language, conversationId, roles, createdAt }
 */
export function restoreRolePlaySession(store, config) {
  const targetAgent = config.agentId || store.currentAgent;
  if (!targetAgent) {
    store.addMessage({ type: 'error', content: t('chat.agent.selectFirst') });
    return;
  }
  const { session, projectDir } = config;

  // Populate frontend rolePlaySessions state immediately
  // so that when conversation_selected fires, the UI renders RolePlayChatView
  const roles = (session.roles || []).map(r => ({
    name: r.name,
    displayName: r.displayName,
    icon: r.icon || '',
    description: r.description || '',
  }));

  // Check if the conversation still exists on the agent
  // We do this by looking at the agent's conversation list
  const agent = store.agents.find(a => a.id === targetAgent);
  const convExists = agent?.conversations?.some(c => c.id === session.conversationId);

  if (convExists && session.conversationId) {
    // Conversation still alive — just select it
    store.rolePlaySessions[session.conversationId] = {
      roles,
      teamType: session.teamType,
      language: session.language || store.locale || 'zh-CN',
    };
    store.sendWsMessage({
      type: 'select_conversation',
      conversationId: session.conversationId,
    });
    store.currentConversation = session.conversationId;
  } else {
    // Conversation lost (server restart etc.) — create a new one with the same config
    // The agent will detect .roleplay/session.json and update the conversationId
    setSessionLoading(store, true, t('roleplay.restoring'));
    store.sendWsMessage({
      type: 'create_conversation',
      agentId: targetAgent,
      workDir: projectDir,
      rolePlayConfig: {
        roles,
        teamType: session.teamType,
        language: session.language || store.locale || 'zh-CN',
        restoreSessionName: session.name,  // Tell agent this is a restore
      },
    });
  }
}
