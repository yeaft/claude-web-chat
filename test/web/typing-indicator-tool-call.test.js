import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-15: Fix typing indicator disappearing during tool calls.
 *
 * Problem: When Claude pauses text streaming to execute a tool, the typing
 * dots (showTypingDots) should reappear. But isStreaming stays true on the
 * assistant message, so hasStreamingMessage remains true, suppressing the dots.
 *
 * Fix: Call finishStreamingForConversation before adding tool-use messages
 * in claudeOutput.js, so isStreaming is cleared and typing dots can show.
 *
 * Verifies:
 * 1) Source: finishStreamingForConversation called before tool-use in claudeOutput.js
 * 2) Runtime: handleClaudeOutput clears isStreaming when tool_use block appears
 * 3) Runtime: showTypingDots logic returns true during tool execution
 * 4) Runtime: isStreaming restored when new text arrives after tool
 * 5) Runtime: finishStreamingForConversation called on turn end (result)
 * 6) Source: MessageList typing indicator logic intact
 */

const WORKTREE = resolve(__dirname, '../..');

let claudeOutputSource;
let messageListSource;

beforeEach(() => {
  claudeOutputSource = readFileSync(
    resolve(WORKTREE, 'web/stores/helpers/claudeOutput.js'), 'utf-8'
  );
  messageListSource = readFileSync(
    resolve(WORKTREE, 'web/components/MessageList.js'), 'utf-8'
  );
});

// =====================================================================
// Helper: minimal mock store for handleClaudeOutput tests
// =====================================================================
function createMockStore(conversationId) {
  const store = {
    currentConversation: conversationId,
    messages: [],
    messagesCache: {},
    executionStatusMap: {},
    processingConversations: { [conversationId]: true },
    _closedAt: {},
    _turnCompletedConvs: new Set(),

    addMessageToConversation(convId, msg) {
      const newMsg = {
        id: msg.dbMessageId || Date.now().toString() + Math.random().toString(36).substr(2, 9),
        ...msg
      };
      if (convId === this.currentConversation) {
        this.messages.push(newMsg);
      }
    },

    appendToAssistantMessageForConversation(convId, text) {
      if (convId === this.currentConversation) {
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg && lastMsg.type === 'assistant' && lastMsg.isStreaming) {
          lastMsg.content += text;
        } else {
          this.addMessageToConversation(convId, {
            type: 'assistant',
            content: text,
            isStreaming: true
          });
        }
      }
    },

    finishStreamingForConversation(convId) {
      if (convId === this.currentConversation) {
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg && lastMsg.isStreaming) {
          lastMsg.isStreaming = false;
        }
      }
    }
  };
  return store;
}

// Replicate the core logic of handleClaudeOutput (assistant + result paths)
// to test behavior in isolation without full module imports.
function simulateHandleClaudeOutput(store, conversationId, data) {
  if (!store.executionStatusMap[conversationId]) {
    store.executionStatusMap[conversationId] = {
      currentTool: null,
      toolHistory: [],
      lastActivity: null
    };
  }
  const execStatus = store.executionStatusMap[conversationId];
  execStatus.lastActivity = Date.now();

  if (data.type === 'assistant') {
    const content = data.message?.content;
    if (!content) return;

    // Mark all previous tools done
    const msgs = store.messages;
    for (const msg of msgs) {
      if (msg.type === 'tool-use' && !msg.hasResult) {
        msg.hasResult = true;
      }
    }
    execStatus.currentTool = null;

    if (typeof content === 'string') {
      store.appendToAssistantMessageForConversation(conversationId, content);
      return;
    }
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'text') {
        store.appendToAssistantMessageForConversation(conversationId, block.text);
      } else if (block.type === 'tool_use') {
        // ★ THE FIX: finish streaming before tool-use
        store.finishStreamingForConversation(conversationId);

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

        store.addMessageToConversation(conversationId, {
          type: 'tool-use',
          toolName: block.name,
          toolInput: block.input,
          startTime: Date.now()
        });
      }
    }
  } else if (data.type === 'result') {
    delete store.processingConversations[conversationId];
    execStatus.currentTool = null;
    const msgs = store.messages;
    for (const msg of msgs) {
      if (msg.type === 'tool-use' && !msg.hasResult) {
        msg.hasResult = true;
      }
    }
    store.finishStreamingForConversation(conversationId);
  }
}

// Replicate showTypingDots / hasStreamingMessage logic from MessageList.js
function hasStreamingMessage(messages) {
  return messages.some(m => m.isStreaming);
}

function showTypingDots(messages, processingConversations, conversationId) {
  const isProcessing = !!processingConversations[conversationId];
  return isProcessing && !hasStreamingMessage(messages);
}

// =====================================================================
// 1. Source: finishStreamingForConversation called before tool_use
// =====================================================================
describe('source: finishStreaming called before tool-use in claudeOutput.js', () => {
  it('finishStreamingForConversation appears before addMessageToConversation for tool_use', () => {
    // Find the tool_use block handling
    const toolUseIdx = claudeOutputSource.indexOf("block.type === 'tool_use'");
    expect(toolUseIdx).toBeGreaterThan(-1);

    // finishStreamingForConversation should appear after tool_use check but before addMessageToConversation
    const afterToolUse = claudeOutputSource.substring(toolUseIdx);
    const finishIdx = afterToolUse.indexOf('finishStreamingForConversation');
    const addMsgIdx = afterToolUse.indexOf('addMessageToConversation');
    expect(finishIdx).toBeGreaterThan(-1);
    expect(addMsgIdx).toBeGreaterThan(-1);
    expect(finishIdx).toBeLessThan(addMsgIdx);
  });

  it('has explanatory comment about typing dots', () => {
    expect(claudeOutputSource).toContain('typing dots reappear during tool execution');
  });
});

// =====================================================================
// 2. Runtime: isStreaming cleared when tool_use block appears
// =====================================================================
describe('runtime: isStreaming cleared on tool_use', () => {
  it('assistant text sets isStreaming true, then tool_use clears it', () => {
    const convId = 'conv-1';
    const store = createMockStore(convId);

    // Step 1: assistant sends text (streaming)
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me help you with that...' }
        ]
      }
    });

    // Text message should be streaming
    const textMsg = store.messages.find(m => m.type === 'assistant');
    expect(textMsg).toBeDefined();
    expect(textMsg.isStreaming).toBe(true);
    expect(hasStreamingMessage(store.messages)).toBe(true);

    // Step 2: assistant sends tool_use
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { path: '/foo' } }
        ]
      }
    });

    // isStreaming should now be false on the text message
    expect(textMsg.isStreaming).toBe(false);
    expect(hasStreamingMessage(store.messages)).toBe(false);
  });

  it('handles mixed text + tool_use in same message', () => {
    const convId = 'conv-2';
    const store = createMockStore(convId);

    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will read the file now.' },
          { type: 'tool_use', name: 'Read', input: { path: '/bar' } }
        ]
      }
    });

    // The text message created by the text block should have isStreaming=false
    // because finishStreaming is called before tool_use is processed
    const assistantMsg = store.messages.find(m => m.type === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.isStreaming).toBe(false);
    expect(hasStreamingMessage(store.messages)).toBe(false);
  });
});

// =====================================================================
// 3. Runtime: showTypingDots is true during tool execution
// =====================================================================
describe('runtime: typing dots visible during tool execution', () => {
  it('typing dots show while tool is running (processing=true, no streaming)', () => {
    const convId = 'conv-3';
    const store = createMockStore(convId);

    // Text streaming
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Analyzing...' }] }
    });
    // During text streaming: typing dots should be hidden (streaming visible)
    expect(showTypingDots(store.messages, store.processingConversations, convId)).toBe(false);

    // Tool use starts
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }
    });
    // During tool execution: typing dots should be visible
    expect(showTypingDots(store.messages, store.processingConversations, convId)).toBe(true);
  });

  it('typing dots hidden once turn completes', () => {
    const convId = 'conv-4';
    const store = createMockStore(convId);

    // Text + tool
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Done.' }] }
    });
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] }
    });
    expect(showTypingDots(store.messages, store.processingConversations, convId)).toBe(true);

    // Turn completes
    simulateHandleClaudeOutput(store, convId, { type: 'result' });
    expect(showTypingDots(store.messages, store.processingConversations, convId)).toBe(false);
  });
});

// =====================================================================
// 4. Runtime: isStreaming restored when new text arrives after tool
// =====================================================================
describe('runtime: streaming resumes after tool result', () => {
  it('new assistant text after tool result creates new streaming message', () => {
    const convId = 'conv-5';
    const store = createMockStore(convId);

    // Text → tool
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Reading file...' }] }
    });
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] }
    });
    expect(hasStreamingMessage(store.messages)).toBe(false);

    // New text after tool result
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Here is the result...' }] }
    });

    // Should have a new streaming message
    expect(hasStreamingMessage(store.messages)).toBe(true);
    // typing dots hidden while text is streaming
    expect(showTypingDots(store.messages, store.processingConversations, convId)).toBe(false);
  });
});

// =====================================================================
// 5. Runtime: finishStreamingForConversation called on turn end
// =====================================================================
describe('runtime: result type clears streaming and processing', () => {
  it('result event clears isStreaming and processingConversations', () => {
    const convId = 'conv-6';
    const store = createMockStore(convId);

    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: 'Final answer text' }
    });
    expect(hasStreamingMessage(store.messages)).toBe(true);

    simulateHandleClaudeOutput(store, convId, { type: 'result' });
    expect(hasStreamingMessage(store.messages)).toBe(false);
    expect(store.processingConversations[convId]).toBeUndefined();
  });
});

// =====================================================================
// 6. Source: MessageList typing indicator logic intact
// =====================================================================
describe('source: MessageList typing indicator structure', () => {
  it('has typing-indicator element', () => {
    expect(messageListSource).toContain('typing-indicator');
  });

  it('showTypingDots computed exists', () => {
    expect(messageListSource).toContain('showTypingDots');
  });

  it('showTypingDots depends on isProcessing and hasStreamingMessage', () => {
    expect(messageListSource).toContain('store.isProcessing');
    expect(messageListSource).toContain('hasStreamingMessage');
  });

  it('hasStreamingMessage checks isStreaming flag', () => {
    expect(messageListSource).toContain('m.isStreaming');
  });

  it('typing dots v-if uses showTypingDots', () => {
    expect(messageListSource).toContain('v-if="showTypingDots"');
  });
});

// =====================================================================
// 7. Multiple consecutive tool calls
// =====================================================================
describe('runtime: multiple consecutive tool calls', () => {
  it('typing dots stay visible through consecutive tool calls', () => {
    const convId = 'conv-7';
    const store = createMockStore(convId);

    // Text
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Let me check multiple files.' }] }
    });

    // First tool
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/a' } }] }
    });
    expect(showTypingDots(store.messages, store.processingConversations, convId)).toBe(true);

    // Second tool (no text in between)
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/b' } }] }
    });
    expect(showTypingDots(store.messages, store.processingConversations, convId)).toBe(true);

    // Third tool
    simulateHandleClaudeOutput(store, convId, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }
    });
    expect(showTypingDots(store.messages, store.processingConversations, convId)).toBe(true);
  });
});
