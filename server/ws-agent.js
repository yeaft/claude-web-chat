import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { verifyAgent } from './auth.js';
import { encodeKey } from './encryption.js';
import { agents, pendingAgentConnections } from './context.js';
import {
  parseMessage, broadcastAgentList, clearAgentDirCache
} from './ws-utils.js';
import { handleAgentConversation } from './handlers/agent-conversation.js';
import { handleAgentOutput } from './handlers/agent-output.js';
import { handleAgentCrew } from './handlers/agent-crew.js';
import { handleAgentFileTerminal } from './handlers/agent-file-terminal.js';
import { handleAgentSync } from './handlers/agent-sync.js';

export function handleAgentConnection(ws, url) {
  const agentId = url.searchParams.get('id') || randomUUID();
  const agentName = url.searchParams.get('name') || `Agent-${agentId.slice(0, 8)}`;
  const workDir = url.searchParams.get('workDir') || '';

  // Helper function to set up message handler for authenticated agents
  const setupAuthenticatedMessageHandler = (agentIdToUse) => {
    ws.on('message', async (data) => {
      const agent = agents.get(agentIdToUse);
      if (!agent) {
        console.error(`[Agent] No agent found for id: ${agentIdToUse}`);
        return;
      }
      const msg = await parseMessage(data, agent.sessionKey);
      if (msg) {
        console.log(`[Agent] Received message from ${agentIdToUse}: ${msg.type}`);
        handleAgentMessage(agentIdToUse, msg);
      } else {
        console.error(`[Agent] Failed to parse message from ${agentIdToUse}`);
      }
    });
  };

  // In development mode (SKIP_AUTH), register immediately
  if (CONFIG.skipAuth) {
    const capabilities = (url.searchParams.get('capabilities') || '').split(',').filter(Boolean);
    completeAgentRegistration(ws, agentId, agentName, workDir, null, capabilities);

    setupAuthenticatedMessageHandler(agentId);

    ws.on('close', () => {
      const agent = agents.get(agentId);
      // Agent 断开时禁用所有端口（保留列表）
      if (agent?.proxyPorts?.length > 0) {
        agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));
      }
      // Bug #8: Agent 断连时设置所有 conversation 的 processing=false
      if (agent?.conversations) {
        for (const [, conv] of agent.conversations) {
          conv.processing = false;
        }
      }
      clearAgentDirCache(agentId);
      if (agent?._syncTimeout) {
        clearTimeout(agent._syncTimeout);
        delete agent._syncTimeout;
      }
      console.log(`Agent disconnected: ${agentName}`);
      broadcastAgentList();
    });

    ws.on('error', (err) => {
      console.error(`Agent error (${agentName}):`, err.message);
    });
    return;
  }

  // In production mode, wait for auth message with secret
  const tempId = randomUUID();
  const authTimeout = setTimeout(() => {
    console.log(`Agent auth timeout: ${agentName}`);
    pendingAgentConnections.delete(tempId);
    ws.close(1008, 'Authentication timeout');
  }, 30000);

  pendingAgentConnections.set(tempId, {
    ws,
    agentId,
    agentName,
    workDir,
    timeout: authTimeout
  });

  // Request authentication
  ws.send(JSON.stringify({
    type: 'auth_required',
    tempId
  }));

  ws.on('message', async (data) => {
    const pending = pendingAgentConnections.get(tempId);
    if (pending) {
      // Still pending authentication
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth' && msg.tempId === tempId) {
          clearTimeout(pending.timeout);
          pendingAgentConnections.delete(tempId);

          const authResult = verifyAgent(msg.secret);
          if (!authResult.valid) {
            console.log(`Agent auth failed: ${agentName}`);
            ws.close(1008, 'Invalid agent secret');
            return;
          }

          const capabilities = msg.capabilities || [];
          const agentVersion = msg.version || null;
          completeAgentRegistration(ws, pending.agentId, pending.agentName, pending.workDir, authResult.sessionKey, capabilities, authResult.userId, authResult.username, agentVersion);
        }
      } catch (e) {
        console.error('Failed to parse agent auth message:', e.message);
      }
    } else {
      // Already authenticated, handle normally
      const agent = agents.get(agentId);
      if (!agent) {
        console.error(`[Agent] No agent found for id: ${agentId}`);
        return;
      }
      const msg = await parseMessage(data, agent.sessionKey);
      if (msg) {
        console.log(`[Agent] Received message from ${agentId}: ${msg.type}`);
        handleAgentMessage(agentId, msg);
      } else {
        console.error(`[Agent] Failed to parse message from ${agentId}`);
      }
    }
  });

  ws.on('close', () => {
    const pending = pendingAgentConnections.get(tempId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingAgentConnections.delete(tempId);
    }
    // Agent 断开时禁用所有端口（保留列表）
    const agent = agents.get(agentId);
    if (agent?.proxyPorts?.length > 0) {
      agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));
    }
    // Bug #8: Agent 断连时设置所有 conversation 的 processing=false
    if (agent?.conversations) {
      for (const [, conv] of agent.conversations) {
        conv.processing = false;
      }
    }
    // Phase 4: 清理目录缓存
    clearAgentDirCache(agentId);
    // Phase 1: 清理同步超时
    if (agent?._syncTimeout) {
      clearTimeout(agent._syncTimeout);
      delete agent._syncTimeout;
    }
    console.log(`Agent disconnected: ${agentName}`);
    broadcastAgentList();
  });

  ws.on('error', (err) => {
    console.error(`Agent error (${agentName}):`, err.message);
  });
}

function completeAgentRegistration(ws, agentId, agentName, workDir, sessionKey, capabilities = [], ownerId = null, ownerUsername = null, agentVersion = null) {
  // 如果是重连，保留 conversations；否则（server 重启）创建空 Map
  const existingAgent = agents.get(agentId);
  const conversations = existingAgent?.conversations || new Map();
  const proxyPorts = (existingAgent?.proxyPorts || []).map(p => ({ ...p, enabled: false }));

  // 兼容旧版 agent：未上报 capabilities 时默认全部开启
  const effectiveCapabilities = capabilities.length > 0
    ? capabilities
    : ['terminal', 'file_editor', 'background_tasks'];

  agents.set(agentId, {
    ws,
    name: agentName,
    workDir,
    conversations,
    sessionKey,
    isAlive: true,
    capabilities: effectiveCapabilities,
    proxyPorts,
    status: 'syncing',
    ownerId,
    ownerUsername,
    version: agentVersion
  });

  // 同步超时保护：30 秒后强制 ready
  const syncTimeout = setTimeout(() => {
    const ag = agents.get(agentId);
    if (ag && ag.status === 'syncing') {
      console.warn(`[Sync] Agent ${agentName} sync timeout, forcing ready`);
      ag.status = 'ready';
      broadcastAgentList();
    }
  }, 30000);
  agents.get(agentId)._syncTimeout = syncTimeout;

  // 心跳响应处理 + latency 测量
  ws.on('pong', () => {
    const agent = agents.get(agentId);
    if (agent) {
      agent.isAlive = true;
      if (agent.pingSentAt) {
        agent.latency = Date.now() - agent.pingSentAt;
        agent.pingSentAt = null;
      }
    }
  });

  // Send registration (with session key only in production mode)
  const latestAgentVersion = process.env.AGENT_LATEST_VERSION || null;
  const upgradeAvailable = (latestAgentVersion && agentVersion && latestAgentVersion !== agentVersion) ? latestAgentVersion : null;

  ws.send(JSON.stringify({
    type: 'registered',
    agentId,
    sessionKey: sessionKey ? encodeKey(sessionKey) : null,
    ...(upgradeAvailable && { upgradeAvailable })
  }));

  console.log(`Agent connected: ${agentName} (${agentId})`);
  broadcastAgentList();
}

async function handleAgentMessage(agentId, msg) {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Security: 需要 conversationId 的消息类型，验证该 conversation 属于此 agent
  const CONV_EXEMPT_TYPES = new Set([
    'conversation_list', 'conversation_created', 'conversation_resumed',
    'agent_sync_complete', 'sync_sessions', 'proxy_response', 'proxy_response_chunk',
    'proxy_response_end', 'proxy_ports_update', 'proxy_ws_opened', 'proxy_ws_message',
    'proxy_ws_closed', 'proxy_ws_error', 'restart_agent_ack', 'upgrade_agent_ack',
    'directory_listing', 'folders_list'
  ]);
  if (msg.conversationId && !CONV_EXEMPT_TYPES.has(msg.type)) {
    if (!agent.conversations.has(msg.conversationId)) {
      console.warn(`[Security] Agent ${agentId} sent ${msg.type} for unknown conversation ${msg.conversationId}, ignoring`);
      return;
    }
  }

  // Dispatch to handler sub-modules
  if (await handleAgentConversation(agentId, agent, msg)) return;
  if (await handleAgentOutput(agentId, agent, msg)) return;
  if (await handleAgentCrew(agentId, agent, msg)) return;
  if (await handleAgentFileTerminal(agentId, agent, msg)) return;
  if (await handleAgentSync(agentId, agent, msg)) return;
}
