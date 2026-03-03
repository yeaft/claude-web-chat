// Claude output processing helpers

import { resetProcessingWatchdog, stopProcessingWatchdog } from './watchdog.js';

export function getOrCreateExecutionStatus(store, conversationId) {
  if (!store.executionStatusMap[conversationId]) {
    store.executionStatusMap[conversationId] = {
      currentTool: null,
      toolHistory: [],
      lastActivity: null
    };
  }
  return store.executionStatusMap[conversationId];
}

export function handleClaudeOutput(store, conversationId, data) {
  if (!conversationId) return;

  const execStatus = getOrCreateExecutionStatus(store, conversationId);
  execStatus.lastActivity = Date.now();

  resetProcessingWatchdog(store, conversationId);

  if (data.type === 'system') {
    if (data.subtype === 'init') {
      return;
    }
    if (data.message) {
      store.addMessageToConversation(conversationId, {
        type: 'system',
        content: typeof data.message === 'string' ? data.message : JSON.stringify(data.message, null, 2)
      });
    }
    return;
  }

  if (data.type === 'assistant') {
    const content = data.message?.content;
    if (!content) return;

    // New assistant message means all previous tools are done
    const msgs = conversationId === store.currentConversation
      ? store.messages
      : (store.messagesCache[conversationId] || []);
    for (const msg of msgs) {
      if (msg.type === 'tool-use' && !msg.hasResult) {
        msg.hasResult = true;
      }
    }
    for (const t of execStatus.toolHistory) {
      if (t.status === 'running') t.status = 'done';
    }
    execStatus.currentTool = null;

    // content 可能是字符串或数组
    if (typeof content === 'string') {
      store.appendToAssistantMessageForConversation(conversationId, content);
      return;
    }
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'text') {
        store.appendToAssistantMessageForConversation(conversationId, block.text);
      } else if (block.type === 'tool_use') {
        execStatus.currentTool = {
          name: block.name,
          input: block.input,
          startTime: Date.now()
        };
        execStatus.toolHistory.unshift({
          name: block.name,
          input: block.input,
          timestamp: Date.now(),
          status: 'running'
        });
        if (execStatus.toolHistory.length > 20) {
          execStatus.toolHistory.pop();
        }

        store.addMessageToConversation(conversationId, {
          type: 'tool-use',
          toolName: block.name,
          toolInput: block.input
        });
      }
    }
  } else if (data.type === 'user') {
    // 检查是否是 skill/slash command 的本地输出（如 /context, /cost 等）
    // Claude CLI 将这些结果以 user 消息返回，content 用 <local-command-stdout> 包裹
    const userContent = data.message?.content;

    // 过滤 compact summary 消息（compact 后的上下文摘要，不应显示在 UI 中）
    if (typeof userContent === 'string' && userContent.includes('This session is being continued from a previous conversation')) {
      return;
    }

    if (typeof userContent === 'string' && userContent.includes('<local-command-stdout>')) {
      const match = userContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (match) {
        store.appendToAssistantMessageForConversation(conversationId, match[1].trim());
        store.finishStreamingForConversation(conversationId);
        return;
      }
    }

    let toolResults = [];

    if (data.tool_use_result) {
      const results = Array.isArray(data.tool_use_result) ? data.tool_use_result : [data.tool_use_result];
      toolResults = results;
    } else if (data.message?.content) {
      const content = data.message.content;
      const blocks = Array.isArray(content) ? content : [];
      toolResults = blocks.filter(b => b.type === 'tool_result');
    }

    if (toolResults.length > 0) {
      const msgs = conversationId === store.currentConversation
        ? store.messages
        : (store.messagesCache[conversationId] || []);

      for (const result of toolResults) {
        if (execStatus.toolHistory.length > 0) {
          const runningIdx = execStatus.toolHistory.findIndex(t => t.status === 'running');
          if (runningIdx >= 0) execStatus.toolHistory[runningIdx].status = 'done';
        }

        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].type === 'tool-use' && !msgs[i].hasResult) {
            msgs[i].hasResult = true;
            msgs[i].toolResult = result.content || result;
            break;
          }
        }
      }

      execStatus.currentTool = null;
    }
  } else if (data.type === 'result') {
    // ★ result 表示当前 turn 已完成，立即清除 processing 状态
    delete store.processingConversations[conversationId];
    stopProcessingWatchdog(store, conversationId);
    execStatus.currentTool = null;
    const msgs = conversationId === store.currentConversation
      ? store.messages
      : (store.messagesCache[conversationId] || []);
    for (const msg of msgs) {
      if (msg.type === 'tool-use' && !msg.hasResult) {
        msg.hasResult = true;
      }
    }
    store.finishStreamingForConversation(conversationId);
  }
}
