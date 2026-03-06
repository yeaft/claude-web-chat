import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { verifyAgent } from './auth.js';
import { encodeKey } from './encryption.js';
import { sessionDb, messageDb } from './database.js';
import { agents, webClients, pendingAgentConnections, previewFiles } from './context.js';
import {
  parseMessage, sendToAgent, sendToWebClient,
  broadcastAgentList, notifyConversationUpdate, forwardToClients,
  clearAgentDirCache, setCachedDir, invalidateParentDirCache
} from './ws-utils.js';
import {
  handleProxyResponse, handleProxyResponseChunk, handleProxyResponseEnd,
  handleProxyWsAgentMessage
} from './proxy.js';

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
      // ★ Bug #8: Agent 断连时设置所有 conversation 的 processing=false
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
    // ★ Bug #8: Agent 断连时设置所有 conversation 的 processing=false
    if (agent?.conversations) {
      for (const [, conv] of agent.conversations) {
        conv.processing = false;
      }
    }
    // ★ Phase 4: 清理目录缓存
    clearAgentDirCache(agentId);
    // ★ Phase 1: 清理同步超时
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
  // 如果是重连，保留 conversations
  const existingAgent = agents.get(agentId);
  let conversations;
  if (existingAgent) {
    conversations = existingAgent.conversations;
  } else {
    // Server 重启场景：从 DB 恢复最近 1 个 conversation，避免 sidebar 显示大量历史
    conversations = new Map();
    try {
      const dbSessions = sessionDb.getByAgent(agentId, 1);
      for (const s of dbSessions) {
        conversations.set(s.id, {
          id: s.id,
          workDir: s.work_dir,
          claudeSessionId: s.claude_session_id,
          title: s.title,
          createdAt: s.created_at,
          userId: s.user_id || ownerId,
          username: ownerUsername,
          fromDb: true
        });
      }
      if (dbSessions.length > 0) {
        console.log(`[AgentReg] Restored ${dbSessions.length} conversation(s) from DB for ${agentName}`);
      }
    } catch (e) {
      console.error(`[AgentReg] Failed to restore conversations from DB:`, e.message);
    }
  }
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

  // ★ 同步超时保护：30 秒后强制 ready
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
  // Check if agent needs upgrade
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

  // ★ Security: 需要 conversationId 的消息类型，验证该 conversation 属于此 agent
  // 排除: conversation_created/resumed (正在创建)、conversation_list (批量同步)、
  //       agent_sync_complete、sync_sessions、proxy_* (无 conversationId)
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

  switch (msg.type) {
    case 'conversation_list': {
      // Agent 发送的 conversation 列表 - 合并而非覆盖，保留已有的 userId/username
      const incomingIds = new Set(msg.conversations.map(c => c.id));
      for (const [id, conv] of agent.conversations) {
        // 保留从 DB 恢复的历史 conversations（agent 不会上报已完成的会话）
        if (!incomingIds.has(id) && !conv.fromDb) {
          agent.conversations.delete(id);
        }
      }
      for (const conv of msg.conversations) {
        const existing = agent.conversations.get(conv.id);
        if (existing) {
          // ★ 原地更新属性而非替换对象，避免其他持有旧引用的代码失效
          existing.workDir = conv.workDir || existing.workDir;
          existing.claudeSessionId = conv.claudeSessionId || existing.claudeSessionId;
          existing.createdAt = conv.createdAt || existing.createdAt;
          if (conv.processing !== undefined) existing.processing = conv.processing;
          // Agent 主动上报了这个 conversation，清除 DB 恢复标记
          delete existing.fromDb;
          // 保留 crew 相关字段
          if (conv.type) existing.type = conv.type;
          if (conv.goal) existing.goal = conv.goal;
          // ★ Security: 不信任 agent 上报的 userId/username，保留 server 端已有值
          // 仅在 server 端无值时，从 DB 或 agent.ownerId 补充
          if (!existing.userId) {
            const dbSession = sessionDb.get(conv.id);
            existing.userId = dbSession?.user_id || agent.ownerId || null;
            existing.username = dbSession?.username || agent.ownerUsername || null;
          }
        } else {
          // 新 conversation — 从 DB 或 agent.ownerId 获取 userId，不信任 agent 上报
          const dbSession = sessionDb.get(conv.id);
          const trustedUserId = dbSession?.user_id || agent.ownerId || null;
          const trustedUsername = dbSession?.username || agent.ownerUsername || null;
          agent.conversations.set(conv.id, { ...conv, userId: trustedUserId, username: trustedUsername });
        }
      }
      await broadcastAgentList();
      break;
    }

    case 'conversation_created':
    case 'conversation_resumed': {
      // 清理同 claudeSessionId 的旧条目（避免重复恢复同一个 session 累积）
      if (msg.type === 'conversation_resumed' && msg.claudeSessionId) {
        for (const [id, conv] of agent.conversations) {
          if (id !== msg.conversationId && conv.claudeSessionId === msg.claudeSessionId) {
            agent.conversations.delete(id);
          }
        }
      }
      // ★ Security: 使用 server 端可信来源的 userId，不信任 agent 回传
      // 优先级: server 已有记录 > DB > agent.ownerId > agent 上报值(最低优先)
      const existingConvData = agent.conversations.get(msg.conversationId);
      const dbSessionData = sessionDb.get(msg.conversationId);
      const trustedUserId = existingConvData?.userId || dbSessionData?.user_id || agent.ownerId || msg.userId || null;
      const trustedUsername = existingConvData?.username || dbSessionData?.username || agent.ownerUsername || msg.username || null;

      agent.conversations.set(msg.conversationId, {
        id: msg.conversationId,
        workDir: msg.workDir,
        claudeSessionId: msg.claudeSessionId,
        userId: trustedUserId,
        username: trustedUsername,
        createdAt: Date.now(),
        processing: false
      });
      try {
        if (msg.type === 'conversation_created') {
          if (!sessionDb.exists(msg.conversationId)) {
            sessionDb.create(msg.conversationId, agentId, agent.name, msg.workDir, msg.claudeSessionId, null, trustedUserId);
          }
        } else {
          if (sessionDb.exists(msg.conversationId)) {
            sessionDb.update(msg.conversationId, { claudeSessionId: msg.claudeSessionId });
          } else {
            sessionDb.create(msg.conversationId, agentId, agent.name, msg.workDir, msg.claudeSessionId, null, trustedUserId);
          }
        }
        sessionDb.setActive(msg.conversationId, true);
      } catch (e) {
        console.error('Failed to save session to database:', e.message);
      }
      // ★ Security: 覆盖 msg 中的 userId 为可信值，确保 notifyConversationUpdate 用正确的 userId
      msg.userId = trustedUserId;
      msg.username = trustedUsername;

      // ★ Phase 6.1: 将 historyMessages 同步到 DB（支持增量 merge）
      // agent 的 history 是权威数据源，bulkAddHistory 会自动找到 DB 中缺失的部分并追加
      if (msg.type === 'conversation_resumed' && msg.historyMessages && msg.historyMessages.length > 0) {
        try {
          const insertedCount = messageDb.bulkAddHistory(msg.conversationId, msg.historyMessages);
          if (insertedCount > 0) {
            console.log(`[conversation_resumed] Synced ${insertedCount} new messages to DB for ${msg.conversationId}`);
          }
        } catch (e) {
          console.error('Failed to sync history to DB:', e.message);
        }
        // 从 DB 读取最后 5 turns 发给前端
        const { messages: recentMessages, hasMore } = messageDb.getRecentTurns(msg.conversationId, 5);
        // 不再发原始 historyMessages 给前端，改为 dbMessages
        delete msg.historyMessages;
        msg.dbMessages = recentMessages;
        msg.hasMoreMessages = hasMore;
      }
      msg.dbMessageCount = messageDb.getCount(msg.conversationId);

      await notifyConversationUpdate(agentId, msg);
      await broadcastAgentList();
      break;
    }

    case 'session_id_update':
      if (msg.conversationId && msg.claudeSessionId) {
        const existingConv = agent.conversations.get(msg.conversationId);
        if (existingConv) {
          existingConv.claudeSessionId = msg.claudeSessionId;
        }
        try {
          sessionDb.update(msg.conversationId, { claudeSessionId: msg.claudeSessionId });
          console.log(`[session_id_update] Updated claudeSessionId for ${msg.conversationId}: ${msg.claudeSessionId}`);
        } catch (e) {
          console.error('Failed to update claudeSessionId in database:', e.message);
        }
      }
      await broadcastAgentList();
      break;

    // ★ turn_completed: 一个 turn 结束（Claude 回复完成），进程仍在运行
    case 'turn_completed':
      {
        const turnConv = agent.conversations.get(msg.conversationId);
        // ★ Guard: 如果 processing 已为 false，说明是重复的 turn_completed，跳过
        if (turnConv && !turnConv.processing) {
          console.warn(`[turn_completed] Ignoring duplicate for ${msg.conversationId}`);
          break;
        }
        if (turnConv) {
          turnConv.processing = false;
          if (msg.claudeSessionId) {
            turnConv.claudeSessionId = msg.claudeSessionId;
          }
          if (msg.workDir) {
            turnConv.workDir = msg.workDir;
          }
        }
        try {
          if (msg.claudeSessionId) {
            sessionDb.update(msg.conversationId, { claudeSessionId: msg.claudeSessionId });
          }
        } catch (e) {
          console.error('Failed to update session in database:', e.message);
        }
        await forwardToClients(agentId, msg.conversationId, {
          type: 'turn_completed',
          conversationId: msg.conversationId,
          claudeSessionId: msg.claudeSessionId,
          workDir: msg.workDir
        });

        await broadcastAgentList();
      }
      break;

    // ★ conversation_closed: Claude 进程真正退出（异常退出、进程终止）
    case 'conversation_closed':
      {
        const closedConv = agent.conversations.get(msg.conversationId);
        if (closedConv) {
          closedConv.processing = false;
          if (msg.claudeSessionId) {
            closedConv.claudeSessionId = msg.claudeSessionId;
          }
          if (msg.workDir) {
            closedConv.workDir = msg.workDir;
          }
        }
        try {
          sessionDb.setActive(msg.conversationId, false);
          if (msg.claudeSessionId) {
            sessionDb.update(msg.conversationId, { claudeSessionId: msg.claudeSessionId });
          }
        } catch (e) {
          console.error('Failed to update session in database:', e.message);
        }
        await forwardToClients(agentId, msg.conversationId, {
          type: 'conversation_closed',
          conversationId: msg.conversationId,
          claudeSessionId: msg.claudeSessionId,
          workDir: msg.workDir
        });

        await broadcastAgentList();
      }
      break;

    case 'conversation_deleted':
      agent.conversations.delete(msg.conversationId);
      try {
        sessionDb.setActive(msg.conversationId, false);
      } catch (e) {
        console.error('Failed to update session in database:', e.message);
      }
      await notifyConversationUpdate(agentId, msg);
      await broadcastAgentList();
      break;

    case 'history_sessions_list':
    case 'folders_list':
      console.log(`[${msg.type}] Received from agent ${agentId}, forwarding to clients...`);
      console.log(`[${msg.type}] folders count: ${msg.folders?.length || 0}`);
      // 传递 _requestClientId 以便定向发送
      await notifyConversationUpdate(agentId, msg);
      break;

    case 'conversation_refresh':
      await notifyConversationUpdate(agentId, msg);
      break;

    case 'conversation_settings_updated':
      await forwardToClients(agentId, msg.conversationId, msg);
      break;

    case 'claude_output':
      // 保存消息到数据库
      try {
        const data = msg.data;
        if (data && msg.conversationId) {
          if (data.type === 'user' && data.message?.content) {
            const rawContent = data.message.content;
            const content = typeof rawContent === 'string'
              ? rawContent
              : (Array.isArray(rawContent) ? rawContent.map(b => b.text || '').join('') : JSON.stringify(rawContent));
            const dbId = messageDb.add(msg.conversationId, 'user', content, 'user');
            msg.data.dbMessageId = dbId;
          }
          if (data.type === 'assistant' && data.message?.content) {
            let content;
            if (typeof data.message.content === 'string') {
              content = data.message.content;
            } else if (Array.isArray(data.message.content)) {
              content = data.message.content
                .filter(block => block.type === 'text' && block.text)
                .map(block => block.text)
                .join('');
            } else {
              content = JSON.stringify(data.message.content);
            }
            if (content) {
              const dbId = messageDb.add(msg.conversationId, 'assistant', content, 'assistant');
              msg.data.dbMessageId = dbId;
            }
          }
          if (data.type === 'assistant' && data.message?.content) {
            const contents = Array.isArray(data.message.content)
              ? data.message.content
              : [data.message.content];
            for (const item of contents) {
              if (item.type === 'tool_use') {
                messageDb.add(
                  msg.conversationId,
                  'assistant',
                  JSON.stringify(item.input || {}),
                  'tool_use',
                  item.name,
                  JSON.stringify(item.input || {})
                );
              }
            }
          }
          if (data.type === 'result') {
            const resultContent = typeof data.result === 'string'
              ? data.result
              : JSON.stringify(data.result);
            const truncated = resultContent.length > 10000
              ? resultContent.slice(0, 10000) + '...[truncated]'
              : resultContent;
            messageDb.add(msg.conversationId, 'tool', truncated, 'tool_result');
          }
        }
      } catch (e) {
        // 静默处理保存错误，不影响正常流程
      }
      await forwardToClients(agentId, msg.conversationId, {
        type: 'claude_output',
        conversationId: msg.conversationId,
        data: msg.data
      });
      break;

    case 'context_usage':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'context_usage',
        conversationId: msg.conversationId,
        inputTokens: msg.inputTokens,
        maxTokens: msg.maxTokens,
        percentage: msg.percentage
      });
      break;

    case 'execution_cancelled': {
      const cancelledConv = agent.conversations.get(msg.conversationId);
      if (cancelledConv) {
        cancelledConv.processing = false;
      }
      await forwardToClients(agentId, msg.conversationId, {
        type: 'execution_cancelled',
        conversationId: msg.conversationId
      });
      await broadcastAgentList();
      break;
    }

    case 'background_task_started':
      console.log(`[Background] Task started: ${msg.task?.id} in conversation ${msg.conversationId}`);
      await forwardToClients(agentId, msg.conversationId, {
        type: 'background_task_started',
        conversationId: msg.conversationId,
        task: msg.task
      });
      break;

    case 'background_task_output':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'background_task_output',
        conversationId: msg.conversationId,
        taskId: msg.taskId,
        task: msg.task,
        newOutput: msg.newOutput
      });
      break;

    case 'slash_commands_update':
      // 缓存到 agent 对象上，供 web 端选择 agent 时立即获取
      agent.slashCommands = msg.slashCommands || [];
      await forwardToClients(agentId, msg.conversationId, {
        type: 'slash_commands_update',
        conversationId: msg.conversationId,
        slashCommands: msg.slashCommands
      });
      break;

    case 'compact_status':
      console.log(`[Compact] Status: ${msg.status} for conversation ${msg.conversationId}`);
      await forwardToClients(agentId, msg.conversationId, {
        type: 'compact_status',
        conversationId: msg.conversationId,
        status: msg.status,
        message: msg.message
      });
      break;

    case 'ask_user_question':
      console.log(`[AskUser] Question for conversation ${msg.conversationId}, requestId: ${msg.requestId}`);
      await forwardToClients(agentId, msg.conversationId, {
        type: 'ask_user_question',
        conversationId: msg.conversationId,
        requestId: msg.requestId,
        questions: msg.questions
      });
      break;

    case 'error':
      await forwardToClients(agentId, msg.conversationId, {
        type: 'error',
        conversationId: msg.conversationId,
        message: msg.message
      });
      break;

    // =====================================================================
    // Crew (multi-agent) messages — 透传到 web clients
    // =====================================================================
    case 'crew_session_created': {
      // 在 agent 的 conversations 中注册 crew session（复用现有转发机制）
      const crewUserId = msg.userId || agent.ownerId || null;
      const crewUsername = msg.username || agent.ownerUsername || null;
      agent.conversations.set(msg.sessionId, {
        id: msg.sessionId,
        workDir: msg.projectDir,
        userId: crewUserId,
        username: crewUsername,
        createdAt: Date.now(),
        processing: true,
        type: 'crew',
        goal: msg.goal,
        roles: msg.roles
      });
      // 持久化到 sessionDb，这样 server 重启后删除操作仍能通过 ownership 检查
      try {
        if (!sessionDb.exists(msg.sessionId)) {
          sessionDb.create(msg.sessionId, agentId, agent.name, msg.projectDir, null, msg.goal, crewUserId);
        }
      } catch (e) {
        console.error('Failed to save crew session to database:', e.message);
      }
      await forwardToClients(agentId, msg.sessionId, msg);
      await broadcastAgentList();
      break;
    }

    case 'crew_session_restored': {
      // 恢复时重新注册到 agent.conversations（server 可能重启过）
      const restoreUserId = msg.userId || agent.ownerId || null;
      const restoreUsername = msg.username || agent.ownerUsername || null;
      if (!agent.conversations.has(msg.sessionId)) {
        agent.conversations.set(msg.sessionId, {
          id: msg.sessionId,
          workDir: msg.projectDir,
          userId: restoreUserId,
          username: restoreUsername,
          createdAt: Date.now(),
          processing: true,
          type: 'crew',
          goal: msg.goal,
          roles: msg.roles
        });
      }
      await forwardToClients(agentId, msg.sessionId, msg);
      break;
    }

    case 'crew_output':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_image': {
      // Size check
      const dataSize = msg.data ? Buffer.byteLength(msg.data, 'base64') : 0;
      if (dataSize > 10 * 1024 * 1024) {
        console.warn(`[Server] Crew image too large: ${dataSize} bytes, skipping`);
        break;
      }
      const fileId = randomUUID();
      const token = randomUUID();
      previewFiles.set(fileId, {
        buffer: Buffer.from(msg.data, 'base64'),
        mimeType: msg.mimeType,
        filename: `crew-${msg.role}-${Date.now()}.${(msg.mimeType || 'image/png').split('/')[1] || 'png'}`,
        createdAt: Date.now(),
        token
      });
      await forwardToClients(agentId, msg.sessionId, {
        type: 'crew_image',
        sessionId: msg.sessionId,
        role: msg.role,
        roleIcon: msg.roleIcon,
        roleName: msg.roleName,
        toolId: msg.toolId,
        fileId,
        previewToken: token,
        mimeType: msg.mimeType,
        taskId: msg.taskId,
        taskTitle: msg.taskTitle
      });
      console.log(`[Server] Cached crew image: fileId=${fileId}, role=${msg.role}, mime=${msg.mimeType}`);
      break;
    }

    case 'crew_status': {
      // Update conversation processing state based on crew session status
      const crewConv = agent.conversations.get(msg.sessionId);
      if (crewConv && (msg.status === 'stopped' || msg.status === 'completed')) {
        crewConv.processing = false;
      }
      await forwardToClients(agentId, msg.sessionId, msg);
      break;
    }

    case 'crew_turn_completed':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_human_needed':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_role_added':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_role_removed':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_sessions_list':
      // 定向转发给请求者（参照 folders_list）
      await notifyConversationUpdate(agentId, msg);
      break;

    case 'crew_exists_result':
      // 定向转发给请求者
      await notifyConversationUpdate(agentId, msg);
      break;

    case 'crew_history_loaded':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    // Terminal messages (forward to web clients)
    case 'terminal_created':
    case 'terminal_output':
    case 'terminal_closed':
    case 'terminal_error':
      await forwardToClients(agentId, msg.conversationId, msg);
      break;

    // File operation messages (forward to web clients)
    case 'file_content':
      if (msg.binary) {
        // Binary file: cache on server, forward fileId instead of base64 content
        const fileId = randomUUID();
        const token = randomUUID();
        const filename = msg.filePath.split('/').pop() || 'file';
        previewFiles.set(fileId, {
          buffer: Buffer.from(msg.content, 'base64'),
          mimeType: msg.mimeType,
          filename,
          createdAt: Date.now(),
          token
        });
        console.log(`[Server] Cached binary preview: fileId=${fileId}, mime=${msg.mimeType}, path=${msg.filePath}`);
        const fwdMsg = {
          type: 'file_content',
          conversationId: msg.conversationId,
          _requestUserId: msg._requestUserId,
          filePath: msg.filePath,
          binary: true,
          fileId,
          previewToken: token,
          mimeType: msg.mimeType
        };
        await forwardToClients(agentId, msg.conversationId, fwdMsg);
      } else {
        console.log(`[Server] Forwarding file_content to clients, conv=${msg.conversationId}, path=${msg.filePath}`);
        await forwardToClients(agentId, msg.conversationId, msg);
      }
      break;

    case 'file_saved': {
      // ★ Phase 4: 文件保存后失效父目录缓存
      invalidateParentDirCache(agentId, msg.filePath);
      await forwardToClients(agentId, msg.conversationId, msg);
      break;
    }

    case 'directory_listing': {
      // ★ Phase 4: 缓存目录列表结果
      if (msg.dirPath && msg.entries && !msg.error) {
        setCachedDir(agentId, msg.dirPath, msg.entries);
      }
      // 优先定向发送给请求者（解决 _workdir_picker 等虚拟 conversationId 路由问题）
      const dirTargetClientId = msg._requestClientId;
      if (dirTargetClientId) {
        const targetClient = webClients.get(dirTargetClientId);
        if (targetClient?.authenticated) {
          const { _requestClientId, ...cleanMsg } = msg;
          await sendToWebClient(targetClient, cleanMsg);
          break;
        }
      }
      await forwardToClients(agentId, msg.conversationId, msg);
      break;
    }

    case 'file_op_result':
      // ★ Phase 4: 文件创建/删除/移动 — 清空该 agent 的所有目录缓存
      clearAgentDirCache(agentId);
      await forwardToClients(agentId, msg.conversationId, msg);
      break;

    case 'git_status_result':
    case 'git_diff_result':
    case 'git_op_result':
    case 'file_search_result':
      await forwardToClients(agentId, msg.conversationId, msg);
      break;

    // ★ Phase 1: Agent 同步完成
    case 'agent_sync_complete': {
      agent.status = 'ready';
      if (agent._syncTimeout) {
        clearTimeout(agent._syncTimeout);
        delete agent._syncTimeout;
      }
      console.log(`[Sync] Agent ${agent.name} sync complete, status: ready`);
      await broadcastAgentList();
      break;
    }

    // ★ Phase 2: Session 同步
    case 'sync_sessions': {
      const sessions = msg.sessions || [];
      // ★ Security: 限制单次同步的 session 数量，防止恶意 agent 垃圾写入
      const MAX_SYNC_SESSIONS = 1000;
      if (sessions.length > MAX_SYNC_SESSIONS) {
        console.warn(`[Security] Agent ${agentId} tried to sync ${sessions.length} sessions (limit: ${MAX_SYNC_SESSIONS}), truncating`);
      }
      const safeSessions = sessions.slice(0, MAX_SYNC_SESSIONS);
      console.log(`[Sync] Received ${safeSessions.length} sessions from agent ${agent.name}`);
      let created = 0, updated = 0;
      for (const s of safeSessions) {
        // ★ Security: 校验 sessionId 格式（UUID 或合理字符串），防止注入
        if (!s.sessionId || typeof s.sessionId !== 'string' || s.sessionId.length > 200) continue;
        try {
          const existing = sessionDb.get(s.sessionId);
          if (!existing) {
            // ★ Security: 强制使用 agent.ownerId，不信任 agent 上报的 userId
            sessionDb.create(s.sessionId, agentId, agent.name, s.workDir, s.sessionId, s.title, agent.ownerId || null);
            created++;
          } else {
            if (s.lastModified > existing.updated_at) {
              sessionDb.update(s.sessionId, { title: s.title });
            }
            updated++;
          }
        } catch (e) {
          console.error(`[Sync] Error syncing session ${s.sessionId}:`, e.message);
        }
      }
      console.log(`[Sync] Sessions synced: ${created} created, ${updated} existing`);
      break;
    }

    // Port proxy responses
    case 'proxy_response':
      handleProxyResponse(msg);
      break;

    case 'proxy_response_chunk':
      handleProxyResponseChunk(msg);
      break;

    case 'proxy_response_end':
      handleProxyResponseEnd(msg);
      break;

    case 'proxy_ports_update': {
      const a = agents.get(agentId);
      if (a) {
        a.proxyPorts = msg.ports || [];
        await broadcastAgentList();
      }
      break;
    }

    case 'restart_agent_ack': {
      // 只通知该 Agent 的 owner
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, { type: 'restart_agent_ack', agentId });
        }
      }
      break;
    }

    case 'upgrade_agent_ack': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, { type: 'upgrade_agent_ack', agentId, success: msg.success, error: msg.error, alreadyLatest: msg.alreadyLatest, version: msg.version });
        }
      }
      break;
    }

    // Proxy WebSocket messages from agent to browser
    case 'proxy_ws_opened':
    case 'proxy_ws_message':
    case 'proxy_ws_closed':
    case 'proxy_ws_error':
      handleProxyWsAgentMessage(msg);
      break;
  }
}
