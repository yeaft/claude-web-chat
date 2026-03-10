/**
 * Virtual Crew (single-conversation multi-role) store helpers.
 * Sends create_conversation with vcrewConfig attached.
 */

import { setSessionLoading } from './session.js';
import { t } from '../../utils/i18n.js';

/**
 * Create a Virtual Crew session.
 * Under the hood this is a normal conversation with vcrewConfig attached,
 * so the agent knows to inject the multi-role system prompt.
 *
 * @param {Object} store  - Pinia chat store instance
 * @param {Object} config - { agentId?, projectDir, roles, teamType, language }
 */
export function createVCrewSession(store, config) {
  const targetAgent = config.agentId || store.currentAgent;
  if (!targetAgent) {
    store.addMessage({ type: 'error', content: t('chat.agent.selectFirst') });
    return;
  }
  setSessionLoading(store, true, t('vcrew.creating'));

  store.sendWsMessage({
    type: 'create_conversation',
    agentId: targetAgent,
    workDir: config.projectDir,
    // ★ vcrewConfig is piggybacked onto the standard create_conversation message.
    // The agent will persist this in vcrewSessions and inject appendSystemPrompt.
    vcrewConfig: {
      roles: config.roles,        // [{ name, displayName, icon, description, claudeMd }]
      teamType: config.teamType,  // 'dev' | 'writing' | ...
      language: config.language,  // 'zh-CN' | 'en'
    }
  });
}
