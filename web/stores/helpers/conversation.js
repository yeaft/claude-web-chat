// Conversation lifecycle helpers

import { startProcessingWatchdog, stopProcessingWatchdog } from './watchdog.js';
import { setSessionLoading } from './session.js';
import { t } from '../../utils/i18n.js';

export function selectAgent(store, agentId) {
  if (agentId === store.currentAgent) {
    console.log('[selectAgent] Same agent, skipping:', agentId);
    return;
  }
  console.log('[selectAgent] Switching agent from', store.currentAgent, 'to', agentId);
  store.agentSwitching = true;
  store.sendWsMessage({
    type: 'select_agent',
    agentId
  });
}

export function createConversation(store, workDir, agentId = null, disallowedTools = null) {
  const targetAgent = agentId || store.currentAgent;
  if (!targetAgent) {
    store.addMessage({
      type: 'error',
      content: t('chat.agent.selectFirst')
    });
    return;
  }
  setSessionLoading(store, true, t('chat.session.creating'));
  const msg = {
    type: 'create_conversation',
    agentId: targetAgent,
    workDir: workDir || store.currentAgentWorkDir
  };
  if (disallowedTools !== null) {
    msg.disallowedTools = disallowedTools;
  }
  store.sendWsMessage(msg);
}

export function resumeConversation(store, claudeSessionId, workDir, agentId = null, disallowedTools = null) {
  const targetAgent = agentId || store.currentAgent;
  if (!targetAgent) {
    store.addMessage({
      type: 'error',
      content: t('chat.agent.selectFirst')
    });
    return;
  }
  setSessionLoading(store, true, t('chat.session.loadingHistory'));
  const msg = {
    type: 'resume_conversation',
    agentId: targetAgent,
    claudeSessionId,
    workDir: workDir || store.currentAgentWorkDir
  };
  if (disallowedTools !== null) {
    msg.disallowedTools = disallowedTools;
  }
  store.sendWsMessage(msg);
}

export function selectConversation(store, conversationId, agentId) {
  if (conversationId === store.currentConversation) return;

  if (store.currentConversation && store.messages.length > 0) {
    store.messagesCache[store.currentConversation] = store.messages;
  }

  const conv = store.conversations.find(c => c.id === conversationId);
  if (conv && conv.agentId && conv.agentId !== store.currentAgent) {
    const agent = store.agents.find(a => a.id === conv.agentId);
    if (agent) {
      store.currentAgent = conv.agentId;
      store.currentAgentInfo = agent;
      store.sendWsMessage({
        type: 'select_agent',
        agentId: conv.agentId,
        silent: true
      });
    }
  }

  store.sendWsMessage({
    type: 'select_conversation',
    conversationId
  });

  store.currentConversation = conversationId;
  if (conv) {
    store.currentWorkDir = conv.workDir;
  }

  const cachedMessages = store.messagesCache[conversationId];
  if (cachedMessages && cachedMessages.length > 0) {
    store.messages = cachedMessages;
  } else {
    store.messages = [];
    // ★ Phase 6: 使用 limit 而不是 afterMessageId: 0
    store.sendWsMessage({
      type: 'sync_messages',
      conversationId,
      limit: 100
    });
  }
  // ★ Bug #4: 重置分页状态
  store.hasMoreMessages = false;
  store.loadingMoreMessages = false;
}

export function updateConversationSettings(store, conversationId, settings) {
  if (!conversationId) return;
  store.sendWsMessage({
    type: 'update_conversation_settings',
    conversationId,
    ...settings
  });
}

export function toggleMcp(store) {
  if (!store.currentConversation) return;
  const conv = store.conversations.find(c => c.id === store.currentConversation);
  if (!conv) return;
  const isEnabled = store.currentMcpEnabled;
  const newDisallowedTools = isEnabled ? ['mcp__*'] : [];
  conv.disallowedTools = newDisallowedTools;
  store.updateConversationSettings(store.currentConversation, {
    disallowedTools: newDisallowedTools
  });
}

export function deleteConversation(store, conversationId, agentId) {
  // 如果目标 conversation 在其他 agent 上，需要先通知 server 切换 agent
  // 否则 server 端 forwardToAgent 会发送到 client.currentAgent
  if (agentId && agentId !== store.currentAgent) {
    // 先选择目标 agent，再发删除，最后切回
    store.sendWsMessage({ type: 'select_agent', agentId, silent: true });
    store.sendWsMessage({
      type: 'delete_conversation',
      conversationId
    });
    // 切回原 agent
    store.sendWsMessage({ type: 'select_agent', agentId: store.currentAgent, silent: true });
  } else {
    store.sendWsMessage({
      type: 'delete_conversation',
      conversationId
    });
  }
}

export function sendMessage(store, text, attachments = []) {
  if ((!text.trim() && attachments.length === 0) || !store.currentAgent || !store.currentConversation) return;

  const isQueued = !!store.processingConversations[store.currentConversation];
  const queueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  store.addMessage({
    type: 'user',
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    queueId: isQueued ? queueId : undefined,
    isQueued
  });

  if (text.trim()) {
    const title = text.trim().substring(0, 100);
    store.conversationTitles[store.currentConversation] = title;
  }

  if (!store.processingConversations[store.currentConversation]) {
    store.processingConversations[store.currentConversation] = true;
    if (store._closedAt?.[store.currentConversation]) {
      delete store._closedAt[store.currentConversation];
    }
    // 预初始化 executionStatus entry，确保 getter 返回 reactive 对象
    store.getOrCreateExecutionStatus(store.currentConversation);
    startProcessingWatchdog(store, store.currentConversation);
  }

  const fileIds = attachments.map(a => a.fileId);
  store.sendWsMessage({
    type: 'chat',
    prompt: text,
    fileIds,
    workDir: store.currentWorkDir,
    queueId
  });
}

export function cancelExecution(store) {
  if (!store.currentConversation) return;
  if (!store.processingConversations[store.currentConversation]) return;

  const convId = store.currentConversation;

  store.sendWsMessage({
    type: 'cancel_execution',
    conversationId: convId
  });

  delete store.processingConversations[convId];
  stopProcessingWatchdog(store, convId);
  if (!store._closedAt) store._closedAt = {};
  store._closedAt[convId] = Date.now();
  delete store.messageQueues[convId];
  const status = store.executionStatusMap[convId];
  if (status) status.currentTool = null;
  store.finishStreamingForConversation(convId);

  const msgs = store.messages;
  for (const m of msgs) {
    if (m.isQueued && m.queueId) {
      m.isQueued = false;
      m.isCancelled = true;
    }
  }

  store.addMessage({
    type: 'system',
    content: t('chat.execution.cancelled')
  });
}

export function cancelQueuedMessage(store, queueId) {
  if (!store.currentConversation) return;
  store.sendWsMessage({
    type: 'cancel_queued_message',
    conversationId: store.currentConversation,
    queueId
  });
}

export function answerUserQuestion(store, requestId, answers) {
  store.sendWsMessage({
    type: 'ask_user_answer',
    conversationId: store.currentConversation,
    requestId,
    answers
  });
  const msg = store.messages.find(m => m.type === 'user-question' && m.requestId === requestId);
  if (msg) {
    msg.answered = true;
    msg.selectedAnswers = answers;
  }
}

export function refreshAgents(store) {
  if (store.ws && store.ws.readyState === WebSocket.OPEN) {
    store.sendWsMessage({ type: 'get_agents' });
  }
}

export function refreshConversation(store) {
  if (!store.currentAgent || !store.currentConversation) return;
  store.sendWsMessage({
    type: 'refresh_conversation',
    conversationId: store.currentConversation
  });
}

export function restartAgent(store, agentId) {
  if (!agentId) return;
  store.sendWsMessage({
    type: 'restart_agent',
    agentId
  });
}

export function upgradeAgent(store, agentId) {
  if (!agentId) return;
  store.sendWsMessage({
    type: 'upgrade_agent',
    agentId
  });
}
