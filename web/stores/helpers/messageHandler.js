// handleMessage switch dispatcher

import { useAuthStore } from '../auth.js';
import { decodeKey } from '../../utils/encryption.js';
import { isRecentlyClosed } from './watchdog.js';
import { t } from '../../utils/i18n.js';
import { stopProcessingWatchdog } from './watchdog.js';
import { clearSessionLoading, setSessionLoading } from './session.js';

export function handleMessage(store, msg) {
  const authStore = useAuthStore();

  // Any message means connection is alive
  store._lastPongAt = Date.now();

  switch (msg.type) {
    case 'auth_result':
      if (msg.success) {
        store.authenticated = true;

        if (msg.sessionKey) {
          store.sessionKey = decodeKey(msg.sessionKey);
          authStore.setSessionKey(msg.sessionKey);
        }

        // Save role from WebSocket auth
        if (msg.role) {
          authStore.role = msg.role;
        }

        store.sendWsMessage({ type: 'get_agents' });

        // ★ Reconnect 时不再提前发 select_agent/sync_messages/refresh_conversation
        // 等 agent_list 返回后，确认 agent 在线再恢复状态，避免时序问题导致 "Agent access denied"

        store.checkPendingRecovery();
      } else {
        store.addMessage({
          type: 'error',
          content: msg.error || t('login.error.loginFailed')
        });
        authStore.reset();
      }
      break;

    case 'agent_list':
      store.agents = msg.agents;
      {
        const agentIds = new Set(msg.agents.map(a => a.id));
        for (const agent of msg.agents) {
          store.proxyPorts[agent.id] = agent.proxyPorts || [];
        }
        for (const id of Object.keys(store.proxyPorts)) {
          if (!agentIds.has(id)) {
            delete store.proxyPorts[id];
          }
        }
      }
      if (store.currentAgent) {
        const agent = msg.agents.find(a => a.id === store.currentAgent);
        if (agent) {
          store.currentAgentInfo = agent;
        }
      }
      // ★ 同步所有 agent 的 conversations 到 store.conversations
      {
        // 收集所有 server 端的 conversations
        const allServerConvs = [];
        const allServerConvIds = new Set();
        for (const agent of msg.agents) {
          for (const serverConv of (agent.conversations || [])) {
            if (allServerConvIds.has(serverConv.id)) continue;
            allServerConvIds.add(serverConv.id);
            allServerConvs.push({
              ...serverConv,
              agentId: agent.id,
              agentName: agent.name
            });
            // 同步 title
            if (serverConv.title && !store.conversationTitles[serverConv.id]) {
              store.conversationTitles[serverConv.id] = serverConv.title;
            }
          }
        }

        // 合并到 store.conversations：更新已有的，添加缺失的
        for (const serverConv of allServerConvs) {
          const existing = store.conversations.find(c => c.id === serverConv.id);
          if (existing) {
            existing.claudeSessionId = serverConv.claudeSessionId || existing.claudeSessionId;
            existing.processing = serverConv.processing;
            existing.userId = serverConv.userId;
            existing.username = serverConv.username;
            existing.agentId = serverConv.agentId;
            existing.agentName = serverConv.agentName;
            if (serverConv.type) existing.type = serverConv.type;
            if (serverConv.goal) existing.goal = serverConv.goal;
            if (serverConv.status) existing.status = serverConv.status;
          } else {
            store.conversations.push(serverConv);
          }
        }
        // 清理不在 server 中的 conversations
        store.conversations = store.conversations.filter(c => allServerConvIds.has(c.id));

        // 同步 processing 状态
        for (const serverConv of allServerConvs) {
          if (serverConv.processing && !isRecentlyClosed(store, serverConv.id)) {
            store.processingConversations[serverConv.id] = true;
          } else if (store.processingConversations[serverConv.id]) {
            delete store.processingConversations[serverConv.id];
            stopProcessingWatchdog(store, serverConv.id);
            const status = store.executionStatusMap[serverConv.id];
            if (status) status.currentTool = null;
            store.finishStreamingForConversation(serverConv.id);
          }
        }
        for (const convId of Object.keys(store.processingConversations)) {
          if (!allServerConvIds.has(convId)) {
            console.log(`[agent_list] Clearing stale processing state for ${convId}`);
            delete store.processingConversations[convId];
            stopProcessingWatchdog(store, convId);
            const status = store.executionStatusMap[convId];
            if (status) status.currentTool = null;
            store.finishStreamingForConversation(convId);
          }
        }
      }
      // ★ Reconnect 恢复：currentAgent 已有值说明是 WebSocket 重连（非页面刷新）
      if (store.currentAgent) {
        const agent = msg.agents.find(a => a.id === store.currentAgent && a.online);
        if (agent) {
          console.log('[Reconnect] Agent online, restoring selection:', store.currentAgent);
          store.currentAgentInfo = agent;
          store.sendWsMessage({ type: 'select_agent', agentId: store.currentAgent, silent: true });
          if (store.currentConversation) {
            store.sendWsMessage({ type: 'select_conversation', conversationId: store.currentConversation });
            if (store.messages.length > 0) {
              const lastMessageId = store.messages[store.messages.length - 1]?.id;
              console.log('[Reconnect] Requesting missed messages after:', lastMessageId);
              store.sendWsMessage({
                type: 'sync_messages',
                conversationId: store.currentConversation,
                afterMessageId: lastMessageId
              });
            } else {
              store.sendWsMessage({
                type: 'sync_messages',
                conversationId: store.currentConversation,
                turns: 5
              });
            }
            store.sendWsMessage({
              type: 'refresh_conversation',
              conversationId: store.currentConversation
            });
          }
          break;
        } else {
          console.log('[Reconnect] Agent not online yet:', store.currentAgent);
          // agent 还没上线，保留 currentAgent 等下次 agent_list 更新
        }
      }
      // ★ 自动恢复上次查看的 conversation（UI 刷新后）
      if (!store.currentConversation && !store.currentAgent && !store.recoveryDismissed) {
        const lastViewed = store.lastViewedConversation || localStorage.getItem('lastViewedConversation');
        const lastAgent = store.lastUsedAgent;

        if (lastViewed) {
          // 优先恢复上次查看的 conversation
          const conv = store.conversations.find(c => c.id === lastViewed);
          if (conv) {
            const agent = msg.agents.find(a => a.id === conv.agentId && a.online);
            if (agent) {
              console.log('[AutoRestore] Restoring last viewed conversation:', lastViewed, 'on agent:', conv.agentId);
              store.currentAgent = conv.agentId;
              store.currentAgentInfo = agent;
              store.currentConversation = lastViewed;
              store.currentWorkDir = conv.workDir;
              store.messages = [];
              // 加载最近 5 turns 消息
              store.sendWsMessage({
                type: 'sync_messages',
                conversationId: lastViewed,
                turns: 5
              });
              // 通知 server 选择了这个 agent 和 conversation
              store.sendWsMessage({ type: 'select_agent', agentId: conv.agentId, silent: true });
              store.sendWsMessage({ type: 'select_conversation', conversationId: lastViewed });
              // 查询 processing 状态
              store.sendWsMessage({ type: 'refresh_conversation', conversationId: lastViewed });
              break;
            }
          }
        }

        // 回退：恢复上次使用的 agent
        if (lastAgent) {
          const agent = store.agents.find(a => a.id === lastAgent && a.online);
          if (agent) {
            console.log('[AutoRestore] Auto-selecting last used agent:', lastAgent);
            store.selectAgent(lastAgent);
          } else {
            store.checkPendingRecovery();
          }
        }
      }
      break;

    case 'agent_selected':
      handleAgentSelected(store, msg);
      break;

    case 'conversation_created':
      handleConversationCreated(store, msg);
      break;

    case 'conversation_resumed':
      handleConversationResumed(store, msg);
      break;

    case 'conversation_selected':
      if (store.currentConversation === msg.conversationId) {
        return;
      }
      store.currentConversation = msg.conversationId;
      {
        const conv = store.conversations.find(c => c.id === msg.conversationId);
        if (conv) {
          store.currentWorkDir = conv.workDir;
        }
      }
      store.messages = [];
      store.saveOpenSessions();
      break;

    case 'conversation_settings_updated': {
      const settingsConv = store.conversations.find(c => c.id === msg.conversationId);
      if (settingsConv && msg.disallowedTools !== undefined) {
        settingsConv.disallowedTools = msg.disallowedTools;
      }
      break;
    }

    case 'sync_messages_result':
      if (msg.conversationId === store.currentConversation) {
        const formatted = (msg.messages || []).map(m => store.formatDbMessage(m)).filter(Boolean);

        if (formatted.length > 0) {
          // ★ Phase 6.1: 判断是向上分页还是正常加载
          // 找到当前消息列表中第一条有 dbMessageId 的消息
          const firstDbMsg = store.messages.find(m => m.dbMessageId);
          if (firstDbMsg &&
              formatted[0].dbMessageId &&
              formatted[formatted.length - 1].dbMessageId < firstDbMsg.dbMessageId) {
            // 向上加载：插入到消息列表中第一条 DB 消息之前
            const insertIdx = store.messages.indexOf(firstDbMsg);
            console.log(`[Sync] Prepending ${formatted.length} older messages at index ${insertIdx}`);
            store.messages.splice(insertIdx, 0, ...formatted);
          } else {
            // 正常同步（首次加载或追加）
            console.log(`[Sync] Received ${formatted.length} messages`);
            for (const m of formatted) {
              // ★ Bug #3: 去重：检查是否已存在
              if (m.dbMessageId && store.messages.some(existing => existing.dbMessageId === m.dbMessageId)) {
                continue;
              }
              store.messages.push(m);
            }
          }
        }

        store.hasMoreMessages = msg.hasMore ?? false;
        clearSessionLoading(store);
      }
      store.loadingMoreMessages = false;
      break;

    case 'conversation_deleted':
      store.conversations = store.conversations.filter(c => c.id !== msg.conversationId);
      delete store.messagesCache[msg.conversationId];
      delete store.conversationTitles[msg.conversationId];
      delete store.processingConversations[msg.conversationId];
      if (store._closedAt) delete store._closedAt[msg.conversationId];
      stopProcessingWatchdog(store, msg.conversationId);
      delete store.executionStatusMap[msg.conversationId];
      // 清理 crew 数据
      delete store.crewSessions?.[msg.conversationId];
      delete store.crewMessagesMap?.[msg.conversationId];
      delete store.crewStatuses?.[msg.conversationId];
      window.dispatchEvent(new CustomEvent('conversation-deleted', { detail: { conversationId: msg.conversationId } }));
      if (store.currentConversation === msg.conversationId) {
        store.currentConversation = null;
        store.messages = [];
        store.addMessage({
          type: 'system',
          content: t('chat.session.closed')
        });
      }
      store.saveOpenSessions();
      break;

    // ★ turn_completed: 一个 turn 结束，Claude 进程仍在运行
    case 'turn_completed':
      {
        const convId = msg.conversationId;
        if (convId) {
          delete store.processingConversations[convId];
          stopProcessingWatchdog(store, convId);
          // ★ 设置防护窗口，防止后续 agent_list 中的 stale processing:true 重新设回
          if (!store._closedAt) store._closedAt = {};
          store._closedAt[convId] = Date.now();
          const status = store.executionStatusMap[convId];
          if (status) {
            status.currentTool = null;
          }
          store.finishStreamingForConversation(convId);
          // 更新 conversation 的 claudeSessionId 和 workDir
          const conv = store.conversations.find(c => c.id === convId);
          if (conv) {
            if (msg.claudeSessionId) conv.claudeSessionId = msg.claudeSessionId;
            if (msg.workDir) conv.workDir = msg.workDir;
          }
          store.saveOpenSessions();
        }
      }
      break;

    // ★ conversation_closed: Claude 进程真正退出
    case 'conversation_closed':
      {
        const convId = msg.conversationId;
        if (convId) {
          delete store.processingConversations[convId];
          stopProcessingWatchdog(store, convId);
          if (!store._closedAt) store._closedAt = {};
          store._closedAt[convId] = Date.now();
          const status = store.executionStatusMap[convId];
          if (status) {
            status.currentTool = null;
          }
          store.finishStreamingForConversation(convId);
          // 更新 conversation 的 claudeSessionId 和 workDir
          const conv = store.conversations.find(c => c.id === convId);
          if (conv) {
            if (msg.claudeSessionId) conv.claudeSessionId = msg.claudeSessionId;
            if (msg.workDir) conv.workDir = msg.workDir;
          }
          store.saveOpenSessions();
        }
      }
      break;

    case 'claude_output':
      store.handleClaudeOutput(msg.conversationId, msg.data);
      break;

    case 'error': {
      const errorConvId = msg.conversationId || store.currentConversation;
      const isSystemError = ['Permission denied', 'Agent not found', 'No conversation selected', 'Agent is still syncing', 'Agent access denied'].some(
        s => msg.message?.includes(s)
      );
      // ★ Bug #6: 清除 sessionLoading 状态
      if (msg.message?.includes('Agent is still syncing') || msg.message?.includes('Agent not found')) {
        clearSessionLoading(store);
      }
      const errorId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      store.addMessageToConversation(errorConvId, {
        type: 'error',
        content: msg.message,
        transient: isSystemError,
        dbMessageId: isSystemError ? ('err_' + errorId) : undefined
      });
      if (isSystemError && errorConvId) {
        const convId = errorConvId;
        const errMsgId = 'err_' + errorId;
        setTimeout(() => {
          if (store.currentConversation === convId) {
            const idx = store.messages.findIndex(m => m.id === errMsgId);
            if (idx >= 0) {
              store.messages.splice(idx, 1);
            }
          } else {
            const cached = store.messagesCache[convId];
            if (cached) {
              const idx = cached.findIndex(m => m.id === errMsgId);
              if (idx >= 0) {
                cached.splice(idx, 1);
              }
            }
          }
        }, 5000);
      }
      if (!isSystemError && errorConvId) {
        delete store.processingConversations[errorConvId];
        stopProcessingWatchdog(store, errorConvId);
        store.finishStreamingForConversation(errorConvId);
      }
      break;
    }

    case 'history_sessions_list':
      if (msg.requestId && store._historySessionsRequestId && msg.requestId !== store._historySessionsRequestId) {
        console.log('[history_sessions_list] Stale response ignored');
        break;
      }
      store.historySessions = msg.sessions || [];
      store.historySessionsLoading = false;
      break;

    case 'folders_list':
      console.log('[folders_list] Received:', msg.folders?.length || 0, 'folders, requestId:', msg.requestId);
      // 忽略过期的请求（竞态条件：快速切换 agent 时旧请求晚到）
      if (msg.requestId && store._foldersRequestId && msg.requestId !== store._foldersRequestId) {
        console.log('[folders_list] Stale response ignored, expected:', store._foldersRequestId);
        break;
      }
      store.folders = msg.folders || [];
      store.foldersLoading = false;
      if (store._foldersResolve) {
        store._foldersResolve();
        store._foldersResolve = null;
      }
      break;

    case 'crew_sessions_list':
      store.crewSessionsList = msg.sessions || [];
      break;

    case 'conversation_refresh':
      if (msg.conversationId) {
        if (msg.isProcessing && !isRecentlyClosed(store, msg.conversationId)) {
          store.processingConversations[msg.conversationId] = true;
        } else if (store.processingConversations[msg.conversationId]) {
          delete store.processingConversations[msg.conversationId];
          stopProcessingWatchdog(store, msg.conversationId);
          const status = store.executionStatusMap[msg.conversationId];
          if (status) status.currentTool = null;
          store.finishStreamingForConversation(msg.conversationId);
        }
      }
      break;

    case 'execution_cancelled':
      {
        const convId = msg.conversationId || store.currentConversation;
        if (convId) {
          delete store.processingConversations[convId];
          stopProcessingWatchdog(store, convId);
          if (!store._closedAt) store._closedAt = {};
          store._closedAt[convId] = Date.now();
          const status = store.executionStatusMap[convId];
          if (status) {
            status.currentTool = null;
          }
          store.finishStreamingForConversation(convId);
        }
      }
      break;

    case 'slash_commands_update':
      if (msg.slashCommands && msg.slashCommands.length > 0) {
        store.slashCommands = msg.slashCommands;
      }
      break;

    case 'compact_status':
      {
        const convId = msg.conversationId;
        console.log(`[Compact] Status: ${msg.status} for ${convId}`);
        store.compactStatus = {
          conversationId: convId,
          status: msg.status,
          message: msg.message
        };
        if (msg.status === 'completed') {
          setTimeout(() => {
            if (store.compactStatus?.conversationId === convId && store.compactStatus?.status === 'completed') {
              store.compactStatus = null;
            }
          }, 3000);
        } else if (msg.status === 'compacting') {
          // 安全超时：30 秒后如果仍在 compacting 状态，自动清除
          setTimeout(() => {
            if (store.compactStatus?.conversationId === convId && store.compactStatus?.status === 'compacting') {
              console.warn(`[Compact] Timeout: clearing stale compacting status for ${convId}`);
              store.compactStatus = null;
            }
          }, 30000);
        }
      }
      break;

    case 'ask_user_question':
      if (msg.conversationId) {
        const tryLink = () => {
          const msgs = msg.conversationId === store.currentConversation
            ? store.messages
            : (store.messagesCache[msg.conversationId] || []);
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].type === 'tool-use' && msgs[i].toolName === 'AskUserQuestion' && !msgs[i].askRequestId) {
              msgs[i].askRequestId = msg.requestId;
              msgs[i].askQuestions = msg.questions;
              return true;
            }
          }
          return false;
        };
        if (!tryLink()) {
          let retries = 0;
          const retryInterval = setInterval(() => {
            retries++;
            if (tryLink() || retries >= 10) {
              clearInterval(retryInterval);
            }
          }, 200);
        }
      }
      break;

    case 'restart_agent_ack':
      console.log(`[Agent] Restart acknowledged by agent: ${msg.agentId}`);
      // Agent 即将重启，通过 CustomEvent 通知 UI 组件
      window.dispatchEvent(new CustomEvent('agent-restart-ack', { detail: { agentId: msg.agentId } }));
      break;

    case 'upgrade_agent_ack':
      console.log(`[Agent] Upgrade ${msg.success ? 'succeeded' : 'failed'} for agent: ${msg.agentId}`, msg.error || '');
      window.dispatchEvent(new CustomEvent('agent-upgrade-ack', { detail: { agentId: msg.agentId, success: msg.success, error: msg.error, alreadyLatest: msg.alreadyLatest, version: msg.version } }));
      break;

    // Workbench messages - forward to components
    case 'terminal_created':
    case 'terminal_output':
    case 'terminal_closed':
    case 'terminal_error':
    case 'file_content':
    case 'file_saved':
    case 'directory_listing':
    case 'git_status_result':
    case 'git_diff_result':
    case 'git_op_result':
    case 'file_op_result':
    case 'file_search_result':
      if (msg.type === 'file_content') console.log('[Store] Dispatching file_content workbench-message:', msg.type, msg.filePath);
      if (msg.type === 'directory_listing') console.log('[Store] Dispatching directory_listing workbench-message, convId:', msg.conversationId, 'entries:', msg.entries?.length);
      window.dispatchEvent(new CustomEvent('workbench-message', { detail: msg }));
      break;

    case 'server_updating':
      console.log('[WS] Server is updating, will reconnect automatically');
      store.connectionState = 'updating';
      break;

    case 'context_usage':
      store.contextUsage = {
        inputTokens: msg.inputTokens,
        maxTokens: msg.maxTokens,
        percentage: msg.percentage,
        conversationId: msg.conversationId
      };
      break;

    // =====================================================================
    // Crew (multi-agent) messages
    // =====================================================================
    case 'crew_session_created':
    case 'crew_session_restored':
    case 'crew_output':
    case 'crew_status':
    case 'crew_turn_completed':
    case 'crew_human_needed':
    case 'crew_role_added':
    case 'crew_role_removed':
      store.handleCrewOutput(msg);
      break;
  }
}

// Internal helpers for handleMessage

function handleAgentSelected(store, msg) {
  console.log('[agent_selected] Switching to agent:', msg.agentId);
  store.agentSwitching = false;
  const isSameAgent = store.currentAgent === msg.agentId;
  store.currentAgent = msg.agentId;
  store.currentAgentInfo = {
    id: msg.agentId,
    name: msg.agentName,
    workDir: msg.workDir,
    capabilities: msg.capabilities || ['terminal', 'file_editor', 'background_tasks']
  };

  // 加载 agent 缓存的 slash commands（如果有）
  if (msg.slashCommands && msg.slashCommands.length > 0) {
    store.slashCommands = msg.slashCommands;
  }

  const serverConvs = msg.conversations || [];
  const seenIds = new Set();
  let activeConvs = serverConvs.filter(c => {
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  }).map(c => ({
    ...c,
    agentId: msg.agentId,
    agentName: msg.agentName
  }));

  if (isSameAgent && store.currentConversation) {
    const currentConvInServer = serverConvs.find(c => c.id === store.currentConversation);
    if (currentConvInServer && !activeConvs.find(c => c.id === currentConvInServer.id)) {
      activeConvs.push({
        ...currentConvInServer,
        agentId: msg.agentId,
        agentName: msg.agentName
      });
    }
  }

  const otherAgentConvs = store.conversations.filter(c => c.agentId !== msg.agentId);
  store.conversations = [...otherAgentConvs, ...activeConvs];

  // Populate conversation titles from server data
  for (const conv of serverConvs) {
    if (conv.title && !store.conversationTitles[conv.id]) {
      store.conversationTitles[conv.id] = conv.title;
    }
  }

  console.log('[agent_selected] Merged conversations:', store.conversations.length,
              'from agent:', msg.agentId, 'kept from others:', otherAgentConvs.length);

  const agentConvIds = new Set(serverConvs.map(c => c.id));
  for (const conv of serverConvs) {
    if (conv.processing && !isRecentlyClosed(store, conv.id)) {
      store.processingConversations[conv.id] = true;
    } else if (store.processingConversations[conv.id]) {
      delete store.processingConversations[conv.id];
      stopProcessingWatchdog(store, conv.id);
      const status = store.executionStatusMap[conv.id];
      if (status) status.currentTool = null;
      store.finishStreamingForConversation(conv.id);
    }
  }
  for (const convId of Object.keys(store.processingConversations)) {
    if (!agentConvIds.has(convId)) {
      const isOtherAgent = otherAgentConvs.some(c => c.id === convId);
      if (!isOtherAgent) {
        console.log(`[agent_selected] Clearing stale processing state for ${convId}`);
        delete store.processingConversations[convId];
        stopProcessingWatchdog(store, convId);
        const status = store.executionStatusMap[convId];
        if (status) status.currentTool = null;
        store.finishStreamingForConversation(convId);
      }
    }
  }

  if (isSameAgent && store.currentConversation) {
    const currentConv = store.conversations.find(c => c.id === store.currentConversation);
    store.currentWorkDir = currentConv?.workDir || store.currentWorkDir || msg.workDir;
    console.log('[Reconnect] Restoring conversation selection:', store.currentConversation);
    clearSessionLoading(store);
    store.sendWsMessage({
      type: 'select_conversation',
      conversationId: store.currentConversation
    });
    // 确保消息被加载（重连时 auth_result 已发 sync_messages，这里不再重复）
  } else {
    store.currentConversation = null;
    store.currentWorkDir = msg.workDir;
    store.messages = [];

    const lastViewed = store.lastViewedConversation || localStorage.getItem('lastViewedConversation');
    if (lastViewed && store.conversations.find(c => c.id === lastViewed)) {
      console.log('[AutoRestore] Restoring last viewed conversation:', lastViewed);
      store.autoRestoreConversation(lastViewed);
      store.pendingRecovery = null;
    }
  }
}

function handleConversationCreated(store, msg) {
  clearSessionLoading(store);
  if (store.currentConversation && store.messages.length > 0) {
    store.messagesCache[store.currentConversation] = store.messages;
  }
  const createdAgent = store.agents.find(a => a.id === msg.agentId);
  store.conversations = store.conversations.filter(c => c.id !== msg.conversationId);
  store.conversations.push({
    id: msg.conversationId,
    agentId: msg.agentId,
    agentName: createdAgent?.name || msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: null,
    createdAt: Date.now(),
    processing: false,
    type: 'chat',
    disallowedTools: msg.disallowedTools ?? null
  });
  store.currentAgent = msg.agentId;
  store.currentAgentInfo = createdAgent;
  store.currentConversation = msg.conversationId;
  store.currentWorkDir = msg.workDir;
  store.messages = [];
  store.sendWsMessage({
    type: 'select_conversation',
    conversationId: msg.conversationId
  });
  store.addMessage({
    type: 'system',
    content: t('store.convCreated', { agent: createdAgent?.name || msg.agentId, workDir: msg.workDir })
  });
  store.saveOpenSessions();
}

function handleConversationResumed(store, msg) {
  clearSessionLoading(store);
  if (store.currentConversation && store.messages.length > 0) {
    store.messagesCache[store.currentConversation] = store.messages;
  }
  const resumedAgent = store.agents.find(a => a.id === msg.agentId);
  store.conversations = store.conversations.filter(c =>
    c.id !== msg.conversationId &&
    !(c.claudeSessionId && c.claudeSessionId === msg.claudeSessionId)
  );
  store.conversations.push({
    id: msg.conversationId,
    agentId: msg.agentId,
    agentName: resumedAgent?.name || msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: msg.claudeSessionId,
    createdAt: Date.now(),
    processing: false,
    type: 'chat',
    disallowedTools: msg.disallowedTools ?? null
  });
  store.currentAgent = msg.agentId;
  store.currentAgentInfo = resumedAgent;
  store.currentConversation = msg.conversationId;
  store.currentWorkDir = msg.workDir;
  store.messages = [];
  if (store._pendingSessionTitle) {
    store.conversationTitles[msg.conversationId] = store._pendingSessionTitle;
    store._pendingSessionTitle = null;
  }
  store.sendWsMessage({
    type: 'select_conversation',
    conversationId: msg.conversationId
  });
  store.addMessage({
    type: 'system',
    content: t('store.convResumed', { agent: resumedAgent?.name || msg.agentId, sessionId: msg.claudeSessionId ? msg.claudeSessionId.slice(0, 8) + '...' : '' })
  });
  console.log('dbMessages received:', msg.dbMessages?.length || 0, 'dbMessageCount:', msg.dbMessageCount || 0);
  // ★ Phase 6.1: server 已将 history 写入 DB 并返回最后 5 turns 的 DB 消息
  if (msg.dbMessages && msg.dbMessages.length > 0) {
    const formatted = msg.dbMessages.map(m => store.formatDbMessage(m)).filter(Boolean);
    for (const m of formatted) {
      store.messages.push(m);
    }
  }
  store.hasMoreMessages = !!msg.hasMoreMessages;
  store.saveOpenSessions();
}
