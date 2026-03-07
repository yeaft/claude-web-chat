import { agents, userFileTabs } from '../context.js';
import {
  sendToWebClient, forwardToAgent, broadcastAgentList
} from '../ws-utils.js';

/**
 * Handle miscellaneous messages from web client.
 * Types: ping, restart_agent, upgrade_agent,
 *        proxy_update_ports, update_file_tabs, restore_file_tabs
 */
export async function handleClientMisc(clientId, client, msg, checkAgentAccess) {
  switch (msg.type) {
    case 'ping':
      await sendToWebClient(client, { type: 'pong' });
      break;

    case 'restart_agent': {
      const restartAgentId = msg.agentId;
      if (!restartAgentId) break;
      if (!await checkAgentAccess(restartAgentId)) break;
      await forwardToAgent(restartAgentId, { type: 'restart_agent' });
      break;
    }

    case 'upgrade_agent': {
      const upgradeAgentId = msg.agentId;
      if (!upgradeAgentId) break;
      if (!await checkAgentAccess(upgradeAgentId)) break;
      await forwardToAgent(upgradeAgentId, { type: 'upgrade_agent' });
      break;
    }

    case 'proxy_update_ports': {
      const proxyAgentId = msg.agentId || client.currentAgent;
      if (!proxyAgentId) break;
      if (!await checkAgentAccess(proxyAgentId)) break;
      const agent = agents.get(proxyAgentId);
      if (agent) agent.proxyPorts = msg.ports || [];
      await forwardToAgent(proxyAgentId, {
        type: 'proxy_update_ports',
        ports: msg.ports || []
      });
      break;
    }

    // File Tab 状态保存/恢复
    case 'update_file_tabs': {
      if (client.userId && client.currentAgent) {
        const key = `${client.userId}:${client.currentAgent}`;
        userFileTabs.set(key, {
          files: (msg.openFiles || []).map(f => ({ path: f.path })),
          activeIndex: msg.activeIndex || 0,
          timestamp: Date.now()
        });
      }
      break;
    }

    case 'restore_file_tabs': {
      const ftAgentId = msg.agentId || client.currentAgent;
      if (client.userId && ftAgentId) {
        if (!await checkAgentAccess(ftAgentId)) break;
        const key = `${client.userId}:${ftAgentId}`;
        const saved = userFileTabs.get(key);
        await sendToWebClient(client, {
          type: 'file_tabs_restored',
          openFiles: saved?.files || [],
          activeIndex: saved?.activeIndex || 0
        });
      }
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
