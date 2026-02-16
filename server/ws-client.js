import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { verifyToken, generateSkipAuthSession } from './auth.js';
import { encodeKey } from './encryption.js';
import { messageDb, userDb, sessionDb } from './database.js';
import { agents, webClients, pendingFiles, serverMessageQueues, userFileTabs } from './context.js';
import {
  parseMessage, sendToWebClient, sendToAgent,
  broadcastAgentList, forwardToAgent, forwardToClients,
  verifyConversationOwnership, verifyAgentOwnership, getCachedDir
} from './ws-utils.js';

export function handleWebConnection(ws, url) {
  const clientId = randomUUID();
  const token = url.searchParams.get('token');

  let authenticated = false;
  let sessionKey = null;
  let username = null;
  let userId = null;
  let role = null;

  // Check for skip auth mode
  if (CONFIG.skipAuth) {
    authenticated = true;
    const session = generateSkipAuthSession();
    sessionKey = session.sessionKey;
    username = 'dev-user';
    role = 'admin';
  } else if (token) {
    const result = verifyToken(token);
    if (result.valid) {
      authenticated = true;
      sessionKey = result.sessionKey;
      username = result.username;
      role = result.role || 'user';
    }
  }

  // 获取或创建用户
  if (authenticated && username) {
    try {
      const user = userDb.getOrCreate(username);
      userId = user.id;
      userDb.updateLogin(userId);
    } catch (e) {
      console.error('Failed to get/create user:', e.message);
    }
  }

  webClients.set(clientId, {
    ws,
    authenticated,
    username,
    userId,
    role,
    currentAgent: null,
    currentConversation: null,
    sessionKey,
    isAlive: true
  });

  // 心跳响应处理
  ws.on('pong', () => {
    const client = webClients.get(clientId);
    if (client) client.isAlive = true;
  });

  console.log(`Web client connected: ${clientId} (authenticated: ${authenticated})`);

  const client = webClients.get(clientId);

  if (authenticated) {
    // Send auth result unencrypted (client doesn't have key yet)
    ws.send(JSON.stringify({
      type: 'auth_result',
      success: true,
      sessionKey: sessionKey ? encodeKey(sessionKey) : null,
      role
    }));
    setTimeout(() => broadcastAgentList(), 100);
  } else {
    ws.send(JSON.stringify({ type: 'auth_result', success: false, error: 'Authentication required' }));
    ws.close(1008, 'Authentication required');
    return;
  }

  ws.on('message', async (data) => {
    const client = webClients.get(clientId);
    const msg = await parseMessage(data, client?.sessionKey);
    if (msg) {
      handleWebMessage(clientId, msg);
    }
  });

  ws.on('close', () => {
    const client = webClients.get(clientId);
    // Web 客户端断开时，检查是否需要禁用其关联 Agent 的端口
    if (client?.currentAgent) {
      const agentId = client.currentAgent;
      const agent = agents.get(agentId);
      if (agent?.proxyPorts?.length > 0) {
        // 检查是否还有其他 Web 客户端连接到同一个 agent
        let otherClientsOnAgent = false;
        for (const [otherId, otherClient] of webClients.entries()) {
          if (otherId !== clientId && otherClient.currentAgent === agentId && otherClient.ws.readyState === WebSocket.OPEN) {
            otherClientsOnAgent = true;
            break;
          }
        }
        // 只有当没有其他 Web 客户端连接到同一 agent 时才禁用
        if (!otherClientsOnAgent) {
          agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));
          if (agent.ws.readyState === WebSocket.OPEN) {
            sendToAgent(agent, { type: 'proxy_update_ports', ports: agent.proxyPorts });
          }
          broadcastAgentList();
        }
      }
    }
    webClients.delete(clientId);
    console.log(`Web client disconnected: ${clientId}`);
  });

  ws.on('error', (err) => {
    console.error(`Web client error (${clientId}):`, err.message);
  });
}

// Workbench 功能（terminal、file、git、proxy）仅 admin/pro 可用
const WORKBENCH_TYPES = new Set([
  'terminal_create', 'terminal_input', 'terminal_resize', 'terminal_close',
  'read_file', 'write_file', 'create_file', 'delete_files', 'move_files', 'copy_files', 'upload_to_dir', 'file_search',
  'git_status', 'git_diff', 'git_add', 'git_reset', 'git_restore', 'git_commit', 'git_push',
  'proxy_update_ports', 'update_file_tabs', 'restore_file_tabs'
]);

async function handleWebMessage(clientId, msg) {
  const client = webClients.get(clientId);
  if (!client || !client.authenticated) return;

  // Workbench 权限检查：普通用户禁止使用
  if (!CONFIG.skipAuth && WORKBENCH_TYPES.has(msg.type) && client.role !== 'admin' && client.role !== 'pro') {
    console.warn(`[Security] User ${client.userId} (role=${client.role}) denied workbench action: ${msg.type}`);
    await sendToWebClient(client, { type: 'error', message: 'Permission denied: workbench access requires pro or admin role' });
    return;
  }

  // Helper: check agent access (ownership)
  const checkAgentAccess = async (agentId) => {
    if (!agentId) {
      await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
      return false;
    }
    if (!verifyAgentOwnership(agentId, client.userId, client.role)) {
      console.warn(`[Security] User ${client.userId} denied access to agent ${agentId}`);
      await sendToWebClient(client, { type: 'error', message: 'Agent access denied' });
      return false;
    }
    return true;
  };

  switch (msg.type) {
    case 'ping':
      await sendToWebClient(client, { type: 'pong' });
      break;

    case 'get_agents':
      await broadcastAgentList();
      break;

    case 'select_agent': {
      if (!await checkAgentAccess(msg.agentId)) break;
      const agent = agents.get(msg.agentId);
      if (agent && agent.ws.readyState === WebSocket.OPEN) {
        client.currentAgent = msg.agentId;
        if (!msg.silent) {
          client.currentConversation = null;
        }

        if (msg.silent) break;

        const filteredConvs = Array.from(agent.conversations.values()).filter(c =>
          CONFIG.skipAuth || !c.userId || c.userId === client.userId
        ).map(c => {
          if (!c.title) {
            const dbSession = sessionDb.get(c.id);
            if (dbSession?.title) c.title = dbSession.title;
          }
          return c;
        });
        await sendToWebClient(client, {
          type: 'agent_selected',
          agentId: msg.agentId,
          agentName: agent.name,
          workDir: agent.workDir,
          capabilities: agent.capabilities || ['terminal', 'file_editor', 'background_tasks'],
          conversations: filteredConvs,
          slashCommands: agent.slashCommands || []
        });
      } else {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found or offline' });
      }
      break;
    }

    case 'create_conversation': {
      const createAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(createAgentId)) return;
      const createAgent = agents.get(createAgentId);
      if (!createAgent) {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        return;
      }
      if (createAgent.status === 'syncing') {
        await sendToWebClient(client, { type: 'error', message: 'Agent is still syncing, please wait...' });
        return;
      }
      client.currentAgent = createAgentId;
      await forwardToAgent(createAgentId, {
        type: 'create_conversation',
        conversationId: msg.conversationId || randomUUID(),
        workDir: msg.workDir,
        userId: client.userId,
        username: client.username,
        disallowedTools: msg.disallowedTools
      });
      break;
    }

    case 'resume_conversation': {
      const resumeAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(resumeAgentId)) return;
      const resumeAgent = agents.get(resumeAgentId);
      if (!resumeAgent) {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        return;
      }
      if (resumeAgent.status === 'syncing') {
        await sendToWebClient(client, { type: 'error', message: 'Agent is still syncing, please wait...' });
        return;
      }
      client.currentAgent = resumeAgentId;
      await forwardToAgent(resumeAgentId, {
        type: 'resume_conversation',
        conversationId: msg.conversationId || randomUUID(),
        claudeSessionId: msg.claudeSessionId,
        workDir: msg.workDir,
        userId: client.userId,
        username: client.username,
        disallowedTools: msg.disallowedTools
      });
      break;
    }

    case 'delete_conversation':
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(msg.conversationId, client.userId)) {
        console.warn(`[Security] User ${client.userId} attempted to delete conversation ${msg.conversationId} they don't own`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      serverMessageQueues.delete(msg.conversationId);
      await forwardToAgent(client.currentAgent, {
        type: 'delete_conversation',
        conversationId: msg.conversationId
      });
      break;

    case 'select_conversation':
      if (!CONFIG.skipAuth && !verifyConversationOwnership(msg.conversationId, client.userId)) {
        console.warn(`[Security] User ${client.userId} attempted to select conversation ${msg.conversationId} they don't own`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      client.currentConversation = msg.conversationId;
      await sendToWebClient(client, {
        type: 'conversation_selected',
        conversationId: msg.conversationId
      });
      break;

    case 'sync_messages':
      if (msg.conversationId) {
        if (!CONFIG.skipAuth && !verifyConversationOwnership(msg.conversationId, client.userId)) {
          console.warn(`[Security] User ${client.userId} attempted to sync messages for conversation ${msg.conversationId} they don't own`);
          return;
        }
        try {
          const limit = msg.limit || 100;
          let messages;
          if (msg.beforeId) {
            messages = messageDb.getBeforeId(msg.conversationId, msg.beforeId, limit);
          } else if (msg.afterMessageId) {
            messages = messageDb.getAfterId(msg.conversationId, msg.afterMessageId);
          } else {
            messages = messageDb.getRecent(msg.conversationId, limit);
          }

          const total = messageDb.getCount(msg.conversationId);
          const oldestId = messages.length > 0 ? messages[0].id : null;
          const hasMore = oldestId ? messageDb.getBeforeId(msg.conversationId, oldestId, 1).length > 0 : false;

          console.log(`[sync_messages] Found ${messages.length} messages (total=${total}, hasMore=${hasMore})`);
          await sendToWebClient(client, {
            type: 'sync_messages_result',
            conversationId: msg.conversationId,
            messages,
            hasMore,
            total
          });
        } catch (e) {
          console.error('Failed to sync messages:', e.message);
        }
      }
      break;

    case 'chat': {
      if (!client.currentAgent || !client.currentConversation) {
        await sendToWebClient(client, { type: 'error', message: 'No conversation selected' });
        return;
      }

      if (!await checkAgentAccess(client.currentAgent)) return;

      const chatAgent = agents.get(client.currentAgent);
      if (chatAgent?.status === 'syncing') {
        await sendToWebClient(client, { type: 'error', message: 'Agent is still syncing, please wait...' });
        return;
      }

      const convId = client.currentConversation;
      const convInfo = chatAgent?.conversations.get(convId);

      const isProcessing = convInfo?.processing === true;

      // 处理附件
      const fileIds = msg.fileIds || [];
      let resolvedFiles = [];
      if (fileIds.length > 0) {
        for (const fileId of fileIds) {
          const file = pendingFiles.get(fileId);
          if (file && (!file.userId || CONFIG.skipAuth || file.userId === client.userId)) {
            resolvedFiles.push({
              name: file.name,
              mimeType: file.mimeType,
              data: file.buffer.toString('base64')
            });
            pendingFiles.delete(fileId);
          } else if (file && file.userId !== client.userId) {
            console.warn(`[Security] User ${client.userId} attempted to use file ${fileId} owned by ${file.userId}`);
          }
        }
      }

      if (isProcessing) {
        const queueItem = {
          id: msg.queueId || randomUUID(),
          prompt: msg.prompt,
          workDir: msg.workDir || convInfo?.workDir,
          userId: client.userId,
          clientId: clientId,
          queuedAt: Date.now(),
          files: resolvedFiles.length > 0 ? resolvedFiles : undefined
        };

        if (!serverMessageQueues.has(convId)) {
          serverMessageQueues.set(convId, []);
        }
        const queue = serverMessageQueues.get(convId);

        if (queue.length >= 10) {
          await sendToWebClient(client, { type: 'error', message: 'Queue full (max 10 messages)' });
          return;
        }

        queue.push(queueItem);

        await forwardToClients(client.currentAgent, convId, {
          type: 'queue_update',
          conversationId: convId,
          queue: queue.map(m => ({ id: m.id, prompt: m.prompt.substring(0, 100), queuedAt: m.queuedAt }))
        });
        return;
      }

      if (convInfo) convInfo.processing = true;

      // 用用户输入的 prompt 更新会话标题（始终用最新的用户消息）
      if (msg.prompt && msg.prompt.trim()) {
        const title = msg.prompt.trim().substring(0, 100);
        sessionDb.update(convId, { title });
        if (convInfo) convInfo.title = title;
      }

      if (resolvedFiles.length > 0) {
        await forwardToAgent(client.currentAgent, {
          type: 'transfer_files',
          conversationId: convId,
          files: resolvedFiles,
          prompt: msg.prompt,
          workDir: msg.workDir || convInfo?.workDir,
          claudeSessionId: convInfo?.claudeSessionId
        });
      } else {
        await forwardToAgent(client.currentAgent, {
          type: 'execute',
          conversationId: convId,
          prompt: msg.prompt,
          workDir: msg.workDir || convInfo?.workDir,
          claudeSessionId: convInfo?.claudeSessionId,
          queueId: msg.queueId
        });
      }
      break;
    }

    case 'get_conversations':
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      await forwardToAgent(client.currentAgent, { type: 'get_conversations' });
      break;

    case 'list_history_sessions': {
      const historyAgentId = msg.agentId || client.currentAgent;
      if (!historyAgentId) return;
      if (!await checkAgentAccess(historyAgentId)) return;
      await forwardToAgent(historyAgentId, {
        type: 'list_history_sessions',
        workDir: msg.workDir,
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'list_folders': {
      const foldersAgentId = msg.agentId || client.currentAgent;
      if (!foldersAgentId) return;
      if (!await checkAgentAccess(foldersAgentId)) return;
      await forwardToAgent(foldersAgentId, {
        type: 'list_folders',
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'cancel_execution': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const cancelConvId = msg.conversationId || client.currentConversation;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(cancelConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} cancel denied for ${cancelConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      const cancelQueue = serverMessageQueues.get(cancelConvId);
      if (cancelQueue && cancelQueue.length > 0) {
        await forwardToClients(client.currentAgent, cancelConvId, {
          type: 'queue_cleared',
          conversationId: cancelConvId,
          count: cancelQueue.length,
          reason: 'execution_cancelled'
        });
        serverMessageQueues.delete(cancelConvId);
      }
      await forwardToAgent(client.currentAgent, {
        type: 'cancel_execution',
        conversationId: cancelConvId
      });
      break;
    }

    case 'cancel_queued_message': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const cqmConvId = msg.conversationId || client.currentConversation;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(cqmConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} cancel_queued denied for ${cqmConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      const queue = serverMessageQueues.get(cqmConvId);
      if (queue) {
        const idx = queue.findIndex(m => m.id === msg.queueId);
        if (idx >= 0) {
          queue.splice(idx, 1);
          await forwardToClients(client.currentAgent, cqmConvId, {
            type: 'queued_message_cancelled',
            conversationId: cqmConvId,
            queueId: msg.queueId
          });
          await forwardToClients(client.currentAgent, cqmConvId, {
            type: 'queue_update',
            conversationId: cqmConvId,
            queue: queue.map(m => ({ id: m.id, prompt: m.prompt.substring(0, 100), queuedAt: m.queuedAt }))
          });
        }
      }
      break;
    }

    case 'clear_queue': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const clrConvId = msg.conversationId || client.currentConversation;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(clrConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} clear_queue denied for ${clrConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      const clrQueue = serverMessageQueues.get(clrConvId);
      if (clrQueue) {
        const count = clrQueue.length;
        serverMessageQueues.delete(clrConvId);
        await forwardToClients(client.currentAgent, clrConvId, {
          type: 'queue_cleared',
          conversationId: clrConvId,
          count
        });
      }
      break;
    }

    case 'refresh_conversation': {
      const refreshAgent = msg.agentId || client.currentAgent;
      if (!refreshAgent) return;
      if (!await checkAgentAccess(refreshAgent)) return;
      const refreshConvId = msg.conversationId || client.currentConversation;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(refreshConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} refresh denied for ${refreshConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      await forwardToAgent(refreshAgent, {
        type: 'refresh_conversation',
        conversationId: refreshConvId,
        clientId
      });
      break;
    }

    // Terminal messages (forward to agent)
    case 'terminal_create':
    case 'terminal_input':
    case 'terminal_resize':
    case 'terminal_close': {
      const termAgentId = msg.agentId || client.currentAgent;
      if (!termAgentId) return;
      if (!await checkAgentAccess(termAgentId)) return;
      const termConvId = msg.conversationId || client.currentConversation;
      if (!termConvId) return;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(termConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} terminal access denied for ${termConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      await forwardToAgent(termAgentId, { ...msg, conversationId: termConvId });
      break;
    }

    case 'read_file': {
      const fileAgentId = msg.agentId || client.currentAgent;
      if (!fileAgentId) { console.warn('[Server] read_file: no agentId'); return; }
      if (!await checkAgentAccess(fileAgentId)) return;
      const fileConvId = msg.conversationId || client.currentConversation || '_explorer';
      console.log(`[Server] Forwarding read_file to agent ${fileAgentId}, conv=${fileConvId}, path=${msg.filePath}`);
      await forwardToAgent(fileAgentId, { ...msg, conversationId: fileConvId, _requestUserId: client.userId });
      break;
    }

    case 'write_file': {
      const writeAgentId = msg.agentId || client.currentAgent;
      if (!writeAgentId) return;
      if (!await checkAgentAccess(writeAgentId)) return;
      const writeConvId = msg.conversationId || client.currentConversation || '_explorer';
      const isAgentLevelWrite = writeConvId.startsWith('_');
      if (!isAgentLevelWrite) {
        if (!CONFIG.skipAuth && !verifyConversationOwnership(writeConvId, client.userId)) {
          console.warn(`[Security] User ${client.userId} file write denied for ${writeConvId}`);
          await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
          return;
        }
      }
      await forwardToAgent(writeAgentId, { ...msg, conversationId: writeConvId, _requestUserId: client.userId });
      break;
    }

    case 'list_directory': {
      const dirAgentId = msg.agentId || client.currentAgent;
      if (!dirAgentId) return;
      if (!await checkAgentAccess(dirAgentId)) return;

      // 先查缓存
      const cached = getCachedDir(dirAgentId, msg.dirPath);
      if (cached) {
        await sendToWebClient(client, {
          type: 'directory_listing',
          conversationId: msg.conversationId,
          dirPath: msg.dirPath,
          entries: cached,
          fromCache: true
        });
        return;
      }

      await forwardToAgent(dirAgentId, {
        type: 'list_directory',
        dirPath: msg.dirPath,
        conversationId: msg.conversationId || client.currentConversation,
        requestId: msg.requestId,
        _requestUserId: client.userId
      });
      break;
    }

    case 'git_status':
    case 'git_diff':
    case 'git_add':
    case 'git_reset':
    case 'git_restore':
    case 'git_commit':
    case 'git_push':
    case 'file_search': {
      const gitAgentId = msg.agentId || client.currentAgent;
      if (!gitAgentId) return;
      if (!await checkAgentAccess(gitAgentId)) return;
      await forwardToAgent(gitAgentId, {
        ...msg,
        conversationId: msg.conversationId || client.currentConversation,
        _requestUserId: client.userId
      });
      break;
    }

    case 'create_file':
    case 'delete_files':
    case 'move_files':
    case 'copy_files':
    case 'upload_to_dir': {
      const fopAgentId = msg.agentId || client.currentAgent;
      if (!fopAgentId) return;
      if (!await checkAgentAccess(fopAgentId)) return;
      await forwardToAgent(fopAgentId, {
        ...msg,
        conversationId: msg.conversationId || client.currentConversation,
        _requestUserId: client.userId
      });
      break;
    }

    case 'update_conversation_settings': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const settingsConvId = msg.conversationId || client.currentConversation;
      if (!settingsConvId) return;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(settingsConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} settings update denied for ${settingsConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      await forwardToAgent(client.currentAgent, {
        type: 'update_conversation_settings',
        conversationId: settingsConvId,
        disallowedTools: msg.disallowedTools
      });
      break;
    }

    case 'ask_user_answer': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const answerConvId = msg.conversationId || client.currentConversation;
      if (!answerConvId) return;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(answerConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} ask_user_answer denied for ${answerConvId}`);
        return;
      }
      await forwardToAgent(client.currentAgent, {
        type: 'ask_user_answer',
        conversationId: answerConvId,
        requestId: msg.requestId,
        answers: msg.answers
      });
      break;
    }

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
  }
}
