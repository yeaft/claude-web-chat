// Message CRUD and streaming helpers

export function addMessageToConversation(store, conversationId, msg) {
  if (!conversationId) return;

  const newMsg = {
    id: msg.dbMessageId || Date.now().toString() + Math.random().toString(36).substr(2, 9),
    ...msg
  };

  if (conversationId === store.currentConversation) {
    store.messages.push(newMsg);
    store.messagesCache[conversationId] = store.messages;
  } else {
    if (!store.messagesCache[conversationId]) {
      store.messagesCache[conversationId] = [];
    }
    store.messagesCache[conversationId].push(newMsg);
  }
}

export function appendToAssistantMessageForConversation(store, conversationId, text) {
  if (!conversationId) return;
  if (!text) return;

  if (conversationId === store.currentConversation) {
    const lastMsg = store.messages[store.messages.length - 1];
    if (lastMsg && lastMsg.type === 'assistant' && lastMsg.isStreaming) {
      lastMsg.content += text;
    } else {
      addMessageToConversation(store, conversationId, {
        type: 'assistant',
        content: text,
        isStreaming: true
      });
    }
  } else {
    if (!store.messagesCache[conversationId]) {
      store.messagesCache[conversationId] = [];
    }
    const cached = store.messagesCache[conversationId];
    const lastMsg = cached[cached.length - 1];
    if (lastMsg && lastMsg.type === 'assistant' && lastMsg.isStreaming) {
      lastMsg.content += text;
    } else {
      cached.push({
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        type: 'assistant',
        content: text,
        isStreaming: true
      });
    }
  }
}

export function finishStreamingForConversation(store, conversationId) {
  if (!conversationId) return;

  if (conversationId === store.currentConversation) {
    const lastMsg = store.messages[store.messages.length - 1];
    if (lastMsg && lastMsg.isStreaming) {
      lastMsg.isStreaming = false;
    }
  } else {
    const cached = store.messagesCache[conversationId];
    if (cached && cached.length > 0) {
      const lastMsg = cached[cached.length - 1];
      if (lastMsg && lastMsg.isStreaming) {
        lastMsg.isStreaming = false;
      }
    }
  }
}

export function loadHistoryMessages(store, historyMessages) {
  console.log('Loading history messages:', historyMessages);
  let lastUserMessage = null;
  for (const msg of historyMessages) {
    console.log('Processing message:', msg.type, msg);
    if (msg.type === 'user') {
      const content = msg.message?.content;
      console.log('User content:', content);
      if (content) {
        const text = typeof content === 'string'
          ? content
          : (Array.isArray(content) ? content.map(block => block.text || '').join('') : '');
        console.log('User text:', text);
        if (text) {
          lastUserMessage = text;
          store.addMessage({
            type: 'user',
            content: text,
            isHistory: true
          });
        }
      }
    } else if (msg.type === 'assistant') {
      const content = msg.message?.content;
      console.log('Assistant content:', content);
      if (content && Array.isArray(content)) {
        for (const block of content) {
          console.log('Assistant block:', block);
          if (block.type === 'text' && block.text) {
            store.addMessage({
              type: 'assistant',
              content: block.text,
              isHistory: true
            });
          } else if (block.type === 'tool_use') {
            store.addMessage({
              type: 'tool-use',
              toolName: block.name,
              toolInput: block.input,
              isHistory: true
            });
          } else if (block.type === 'tool_result') {
            for (let i = store.messages.length - 1; i >= 0; i--) {
              if (store.messages[i].type === 'tool-use' && !store.messages[i].hasResult) {
                store.messages[i].hasResult = true;
                store.messages[i].toolResult = block.content;
                break;
              }
            }
          }
        }
      }
    }
  }
  if (lastUserMessage && store.currentConversation && !store.conversationTitles[store.currentConversation]) {
    const title = lastUserMessage.trim().substring(0, 100);
    store.conversationTitles[store.currentConversation] = title;
  }
  console.log('Messages after loading:', store.messages);
}

export function formatDbMessage(dbMsg) {
  if (!dbMsg) return null;

  const base = {
    id: dbMsg.id,
    dbMessageId: dbMsg.id,  // ★ Bug #3: 保留 DB id 用于分页锚点
    timestamp: dbMsg.created_at
  };

  if (dbMsg.message_type === 'tool_use') {
    return {
      ...base,
      type: 'tool-use',
      toolName: dbMsg.tool_name || 'unknown',
      toolInput: (() => {
        try { return JSON.parse(dbMsg.tool_input || dbMsg.content || '{}'); }
        catch { return {}; }
      })(),
      hasResult: true,
      isHistory: true,
      startTime: dbMsg.created_at || 0
    };
  }

  const extractTextContent = (content) => {
    if (!content) return '';
    if (typeof content !== 'string') return String(content);
    if (content.startsWith('[')) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          return parsed
            .filter(block => block.type === 'text' && block.text)
            .map(block => block.text)
            .join('');
        }
      } catch { /* not JSON, use as-is */ }
    }
    return content;
  };

  if (dbMsg.role === 'user') {
    return {
      ...base,
      type: 'user',
      content: typeof dbMsg.content === 'string' ? dbMsg.content : String(dbMsg.content || '')
    };
  } else if (dbMsg.role === 'assistant') {
    const text = extractTextContent(dbMsg.content);
    if (!text) return null;
    return {
      ...base,
      type: 'assistant',
      content: text
    };
  } else if (dbMsg.role === 'tool' || dbMsg.message_type === 'tool_result') {
    return {
      ...base,
      type: 'tool_result',
      tool: dbMsg.tool_name || 'unknown',
      content: typeof dbMsg.content === 'string' ? dbMsg.content : String(dbMsg.content || '')
    };
  }

  return null;
}
