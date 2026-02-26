import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { verifyAgent } from './auth.js';
import { encodeKey } from './encryption.js';
import { sessionDb, messageDb } from './database.js';
import { agents, webClients, pendingAgentConnections, serverMessageQueues, previewFiles } from './context.js';
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
  const workDir = url.searchParams.get('workDir') || 'unknown';

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
      // ★ Phase 3: 清空队列
      if (agent?.conversations) {
        for (const [convId] of agent.conversations) {
          const queue = serverMessageQueues.get(convId);
          if (queue && queue.length > 0) {
            forwardToClients(agentId, convId, {
              type: 'queue_cleared',
              conversationId: convId,
              count: queue.length,
              reason: 'agent_disconnected'
            });
            serverMessageQueues.delete(convId);
          }
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
    // ★ Phase 3: Agent 断连时清空该 agent 所有 conversation 的队列
    if (agent?.conversations) {
      for (const [convId] of agent.conversations) {
        const queue = serverMessageQueues.get(convId);
        if (queue && queue.length > 0) {
          forwardToClients(agentId, convId, {
            type: 'queue_cleared',
            conversationId: convId,
            count: queue.length,
            reason: 'agent_disconnected'
          });
          serverMessageQueues.delete(convId);
        }
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
    'proxy_ws_closed', 'proxy_ws_error', 'restart_agent_ack', 'upgrade_agent_ack'
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
      for (const id of agent.conversations.keys()) {
        if (!incomingIds.has(id)) {
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
      // 附加数据库消息数量，供 web 端判断是否可向上加载
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

        // ★ Phase 3: 处理队列中下一条消息
        const turnQueue = serverMessageQueues.get(msg.conversationId);
        if (turnQueue && turnQueue.length > 0) {
          const next = turnQueue.shift();

          // 通知 web 端队列更新
          await forwardToClients(agentId, msg.conversationId, {
            type: 'queue_update',
            conversationId: msg.conversationId,
            queue: turnQueue.map(m => ({ id: m.id, prompt: m.prompt.substring(0, 100), queuedAt: m.queuedAt })),
            nowProcessing: { id: next.id, prompt: next.prompt.substring(0, 100) }
          });

          // 标记为 processing
          if (turnConv) turnConv.processing = true;

          // 用队列消息的 prompt 更新标题
          if (next.prompt && next.prompt.trim()) {
            const title = next.prompt.trim().substring(0, 100);
            sessionDb.update(msg.conversationId, { title });
            if (turnConv) turnConv.title = title;
          }

          // 处理附件
          if (next.files && next.files.length > 0) {
            await sendToAgent(agent, {
              type: 'transfer_files',
              conversationId: msg.conversationId,
              files: next.files,
              prompt: next.prompt,
              workDir: next.workDir || turnConv?.workDir,
              claudeSessionId: msg.claudeSessionId || turnConv?.claudeSessionId
            });
          } else {
            await sendToAgent(agent, {
              type: 'execute',
              conversationId: msg.conversationId,
              prompt: next.prompt,
              workDir: next.workDir || turnConv?.workDir,
              claudeSessionId: msg.claudeSessionId || turnConv?.claudeSessionId,
              queueId: next.id
            });
          }
        }

        // 如果队列空了，清理
        if (!turnQueue || turnQueue.length === 0) {
          serverMessageQueues.delete(msg.conversationId);
        }

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

        // 进程退出也要处理队列（如果有的话）
        const closedQueue = serverMessageQueues.get(msg.conversationId);
        if (closedQueue && closedQueue.length > 0) {
          // 进程已退出，队列中的消息需要重新启动进程处理
          const next = closedQueue.shift();

          await forwardToClients(agentId, msg.conversationId, {
            type: 'queue_update',
            conversationId: msg.conversationId,
            queue: closedQueue.map(m => ({ id: m.id, prompt: m.prompt.substring(0, 100), queuedAt: m.queuedAt })),
            nowProcessing: { id: next.id, prompt: next.prompt.substring(0, 100) }
          });

          if (closedConv) closedConv.processing = true;

          // 用队列消息的 prompt 更新标题
          if (next.prompt && next.prompt.trim()) {
            const title = next.prompt.trim().substring(0, 100);
            sessionDb.update(msg.conversationId, { title });
            if (closedConv) closedConv.title = title;
          }

          if (next.files && next.files.length > 0) {
            await sendToAgent(agent, {
              type: 'transfer_files',
              conversationId: msg.conversationId,
              files: next.files,
              prompt: next.prompt,
              workDir: next.workDir || closedConv?.workDir,
              claudeSessionId: msg.claudeSessionId || closedConv?.claudeSessionId
            });
          } else {
            await sendToAgent(agent, {
              type: 'execute',
              conversationId: msg.conversationId,
              prompt: next.prompt,
              workDir: next.workDir || closedConv?.workDir,
              claudeSessionId: msg.claudeSessionId || closedConv?.claudeSessionId,
              queueId: next.id
            });
          }
        }

        if (!closedQueue || closedQueue.length === 0) {
          serverMessageQueues.delete(msg.conversationId);
        }

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

    case 'execution_cancelled': {
      // ★ Bug #2: 设置 processing=false
      const cancelledConv = agent.conversations.get(msg.conversationId);
      if (cancelledConv) {
        cancelledConv.processing = false;
      }
      // ★ Bug #2: 清空队列
      const cancelQueue = serverMessageQueues.get(msg.conversationId);
      if (cancelQueue && cancelQueue.length > 0) {
        await forwardToClients(agentId, msg.conversationId, {
          type: 'queue_cleared',
          conversationId: msg.conversationId,
          count: cancelQueue.length,
          reason: 'execution_cancelled'
        });
        serverMessageQueues.delete(msg.conversationId);
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

    case 'directory_listing':
      // ★ Phase 4: 缓存目录列表结果
      if (msg.dirPath && msg.entries && !msg.error) {
        setCachedDir(agentId, msg.dirPath, msg.entries);
      }
      await forwardToClients(agentId, msg.conversationId, msg);
      break;

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
