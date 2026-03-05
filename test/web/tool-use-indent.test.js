import { describe, it, expect } from 'vitest';

/**
 * Tests for Chat message layout:
 *
 * Part 1: Turn aggregation logic (turnGroups from MessageList.js)
 * Part 2: CSS source verification for .assistant-turn styles
 * Part 3: Legacy processMessages logic (still used for tool-use flag computation)
 */

// =====================================================================
// Replicate turnGroups logic from MessageList.js
// =====================================================================
function buildTurnGroups(messages) {
  const result = [];
  let currentTurn = null;
  let turnCounter = 0;

  const finishTurn = () => {
    if (currentTurn) {
      result.push(currentTurn);
      currentTurn = null;
    }
  };

  const startTurn = () => {
    turnCounter++;
    currentTurn = {
      type: 'assistant-turn',
      id: 'turn_' + turnCounter,
      textContent: '',
      isStreaming: false,
      todoMsg: null,
      toolMsgs: [],
      askMsg: null,
      messages: []
    };
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.type === 'user') {
      finishTurn();
      result.push({ type: 'user', id: msg.id || 'u_' + i, message: msg });
      continue;
    }

    if (msg.type === 'system' || msg.type === 'error') {
      finishTurn();
      result.push({ type: msg.type, id: msg.id || 's_' + i, message: msg });
      continue;
    }

    if (msg.type === 'tool-result' || msg.type === 'tool_result') {
      continue;
    }

    if (msg.type === 'assistant') {
      if (!currentTurn) startTurn();
      if (msg.content) currentTurn.textContent += msg.content;
      if (msg.isStreaming) currentTurn.isStreaming = true;
      currentTurn.messages.push(msg);
      continue;
    }

    if (msg.type === 'tool-use') {
      if (!currentTurn) startTurn();
      const nextMsg = messages[i + 1];
      const hasResult = nextMsg && (nextMsg.type === 'tool-result' || nextMsg.type === 'tool_result');
      const toolEntry = { ...msg, hasResult: hasResult || msg.hasResult || false, toolResult: msg.toolResult || null };

      if (msg.toolName === 'TodoWrite') {
        currentTurn.todoMsg = toolEntry;
      } else if (msg.toolName === 'AskUserQuestion') {
        currentTurn.askMsg = toolEntry;
      } else {
        currentTurn.toolMsgs.push(toolEntry);
      }
      currentTurn.messages.push(msg);
      continue;
    }

    finishTurn();
    result.push({ type: msg.type || 'unknown', id: msg.id || 'x_' + i, message: msg });
  }

  finishTurn();
  return result;
}

// Helper to create test messages
function msg(type, extra = {}) {
  return { type, id: Math.random().toString(36).slice(2), ...extra };
}

// =====================================================================
// Part 1: Turn aggregation tests
// =====================================================================

describe('Turn aggregation logic (turnGroups)', () => {
  describe('Basic aggregation', () => {
    it('single assistant message creates one turn', () => {
      const messages = [msg('assistant', { content: 'hello' })];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe('assistant-turn');
      expect(groups[0].textContent).toBe('hello');
    });

    it('user message is a standalone item', () => {
      const messages = [msg('user', { content: 'hi' })];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe('user');
      expect(groups[0].message.content).toBe('hi');
    });

    it('system message is a standalone item', () => {
      const messages = [msg('system', { content: 'connected' })];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe('system');
    });

    it('error message is a standalone item', () => {
      const messages = [msg('error', { content: 'oops' })];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe('error');
    });
  });

  describe('Multi-message turns', () => {
    it('consecutive assistant messages merge into one turn', () => {
      const messages = [
        msg('assistant', { content: 'part1' }),
        msg('assistant', { content: 'part2' }),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe('assistant-turn');
      expect(groups[0].textContent).toBe('part1part2');
    });

    it('assistant + tool-use merge into one turn', () => {
      const messages = [
        msg('assistant', { content: 'thinking...' }),
        msg('tool-use', { toolName: 'Read', toolInput: { file_path: '/a.js' } }),
        msg('tool-result'),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe('assistant-turn');
      expect(groups[0].textContent).toBe('thinking...');
      expect(groups[0].toolMsgs).toHaveLength(1);
      expect(groups[0].toolMsgs[0].toolName).toBe('Read');
    });

    it('assistant + tool-use + assistant merge into one turn', () => {
      const messages = [
        msg('assistant', { content: 'first' }),
        msg('tool-use', { toolName: 'Bash', toolInput: {} }),
        msg('tool-result'),
        msg('assistant', { content: 'second' }),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].textContent).toBe('firstsecond');
      expect(groups[0].toolMsgs).toHaveLength(1);
    });
  });

  describe('Turn boundaries', () => {
    it('user message ends current turn and starts new one', () => {
      const messages = [
        msg('assistant', { content: 'reply' }),
        msg('user', { content: 'question' }),
        msg('assistant', { content: 'answer' }),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(3);
      expect(groups[0].type).toBe('assistant-turn');
      expect(groups[0].textContent).toBe('reply');
      expect(groups[1].type).toBe('user');
      expect(groups[2].type).toBe('assistant-turn');
      expect(groups[2].textContent).toBe('answer');
    });

    it('system message ends current turn', () => {
      const messages = [
        msg('assistant', { content: 'text' }),
        msg('system', { content: 'sys' }),
        msg('assistant', { content: 'more' }),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(3);
      expect(groups[0].type).toBe('assistant-turn');
      expect(groups[1].type).toBe('system');
      expect(groups[2].type).toBe('assistant-turn');
    });

    it('error message ends current turn', () => {
      const messages = [
        msg('assistant', { content: 'text' }),
        msg('error', { content: 'err' }),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(2);
      expect(groups[0].type).toBe('assistant-turn');
      expect(groups[1].type).toBe('error');
    });
  });

  describe('Special tool handling', () => {
    it('TodoWrite goes to todoMsg (only latest kept)', () => {
      const messages = [
        msg('assistant', { content: 'working' }),
        msg('tool-use', { toolName: 'TodoWrite', toolInput: { todos: [{ content: 'a', status: 'pending' }] } }),
        msg('tool-result'),
        msg('tool-use', { toolName: 'TodoWrite', toolInput: { todos: [{ content: 'a', status: 'completed' }] } }),
        msg('tool-result'),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].todoMsg).toBeTruthy();
      expect(groups[0].todoMsg.toolInput.todos[0].status).toBe('completed');
      expect(groups[0].toolMsgs).toHaveLength(0); // TodoWrite not in toolMsgs
    });

    it('AskUserQuestion goes to askMsg', () => {
      const messages = [
        msg('assistant', { content: 'need input' }),
        msg('tool-use', { toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'q1' }] } }),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].askMsg).toBeTruthy();
      expect(groups[0].askMsg.toolName).toBe('AskUserQuestion');
      expect(groups[0].toolMsgs).toHaveLength(0);
    });

    it('regular tools go to toolMsgs', () => {
      const messages = [
        msg('tool-use', { toolName: 'Read', toolInput: {} }),
        msg('tool-result'),
        msg('tool-use', { toolName: 'Edit', toolInput: {} }),
        msg('tool-result'),
        msg('tool-use', { toolName: 'Bash', toolInput: {} }),
        msg('tool-result'),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].toolMsgs).toHaveLength(3);
      expect(groups[0].toolMsgs[0].toolName).toBe('Read');
      expect(groups[0].toolMsgs[1].toolName).toBe('Edit');
      expect(groups[0].toolMsgs[2].toolName).toBe('Bash');
    });
  });

  describe('Streaming', () => {
    it('streaming assistant marks turn as streaming', () => {
      const messages = [
        msg('assistant', { content: 'typing...', isStreaming: true }),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups[0].isStreaming).toBe(true);
    });

    it('non-streaming assistant does not mark turn as streaming', () => {
      const messages = [
        msg('assistant', { content: 'done' }),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups[0].isStreaming).toBe(false);
    });
  });

  describe('tool-result filtering', () => {
    it('tool-result messages are skipped', () => {
      const messages = [
        msg('tool-use', { toolName: 'Read', toolInput: {} }),
        msg('tool-result'),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      // tool-result should not appear anywhere
      expect(groups[0].messages).toHaveLength(1);
      expect(groups[0].messages[0].type).toBe('tool-use');
    });
  });

  describe('Edge cases', () => {
    it('empty message list returns empty', () => {
      expect(buildTurnGroups([])).toEqual([]);
    });

    it('only tool-results returns empty', () => {
      const messages = [msg('tool-result'), msg('tool-result')];
      expect(buildTurnGroups(messages)).toEqual([]);
    });

    it('tool-use without any assistant text', () => {
      const messages = [
        msg('tool-use', { toolName: 'Grep', toolInput: {} }),
        msg('tool-result'),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(1);
      expect(groups[0].textContent).toBe('');
      expect(groups[0].toolMsgs).toHaveLength(1);
    });

    it('complex conversation with multiple turns', () => {
      const messages = [
        msg('system', { content: 'connected' }),
        msg('user', { content: 'help me' }),
        msg('assistant', { content: 'sure' }),
        msg('tool-use', { toolName: 'Read', toolInput: {} }),
        msg('tool-result'),
        msg('tool-use', { toolName: 'Edit', toolInput: {} }),
        msg('tool-result'),
        msg('assistant', { content: 'done!' }),
        msg('user', { content: 'thanks' }),
        msg('assistant', { content: 'welcome' }),
      ];
      const groups = buildTurnGroups(messages);
      expect(groups).toHaveLength(5); // system, user, turn1, user, turn2
      expect(groups[0].type).toBe('system');
      expect(groups[1].type).toBe('user');
      expect(groups[2].type).toBe('assistant-turn');
      expect(groups[2].textContent).toBe('suredone!');
      expect(groups[2].toolMsgs).toHaveLength(2);
      expect(groups[3].type).toBe('user');
      expect(groups[4].type).toBe('assistant-turn');
      expect(groups[4].textContent).toBe('welcome');
    });
  });
});

// =====================================================================
// Part 2: CSS source verification for .assistant-turn styles
// =====================================================================

describe('CSS source verification (assistant-turn)', () => {
  let cssContent;

  it('should load style.css', async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    const mainPath = join(process.cwd(), 'web/style.css');
    cssContent = await fs.readFile(mainPath, 'utf-8');
    expect(cssContent).toBeDefined();
    expect(cssContent.length).toBeGreaterThan(0);
  });

  it('should have .assistant-turn base styles', () => {
    expect(cssContent).toContain('.assistant-turn');
    expect(cssContent).toContain('border-radius: 8px');
  });

  it('should have .assistant-turn.streaming style', () => {
    expect(cssContent).toContain('.assistant-turn.streaming');
  });

  it('should have .turn-content styles', () => {
    expect(cssContent).toContain('.turn-content');
  });

  it('should have .turn-todos with border-top separator', () => {
    expect(cssContent).toContain('.turn-todos');
    const todosSection = cssContent.split('.turn-todos')[1];
    expect(todosSection).toContain('border-top');
  });

  it('should have .turn-actions with border-top separator', () => {
    expect(cssContent).toContain('.turn-actions');
    const actionsSection = cssContent.split('.turn-actions {')[1];
    expect(actionsSection).toContain('border-top');
  });

  it('should have .turn-expand-btn styles', () => {
    expect(cssContent).toContain('.turn-expand-btn');
  });

  it('should have .turn-ask styles', () => {
    expect(cssContent).toContain('.turn-ask');
  });

  it('should still have .copy-btn styles', () => {
    expect(cssContent).toContain('.copy-btn');
  });

  it('should still have .todo-item styles', () => {
    expect(cssContent).toContain('.todo-item');
    expect(cssContent).toContain('.todo-item.completed');
    expect(cssContent).toContain('.todo-item.in_progress');
  });

  it('should still have .ask-card styles', () => {
    expect(cssContent).toContain('.ask-card');
  });

  it('should still have .cursor-blink animation', () => {
    expect(cssContent).toContain('.cursor-blink');
    expect(cssContent).toContain('@keyframes blink');
  });
});

// =====================================================================
// Part 3: Legacy processMessages logic tests (kept for regression)
// =====================================================================

function processMessages(messages) {
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.type === 'tool-result') continue;
    if (m.type === 'tool-use') {
      const nextMsg = messages[i + 1];
      const hasResult = nextMsg && nextMsg.type === 'tool-result';
      let prevIdx = i - 1;
      while (prevIdx >= 0 && messages[prevIdx].type === 'tool-result') prevIdx--;
      const prevIsToolUse = prevIdx >= 0 && messages[prevIdx].type === 'tool-use';
      let nextIdx = hasResult ? i + 2 : i + 1;
      const nextIsToolUse = nextIdx < messages.length && messages[nextIdx].type === 'tool-use';
      result.push({
        ...m, hasResult,
        isFirst: !prevIsToolUse, isLast: !nextIsToolUse,
        isRunning: !hasResult && !m.isHistory, isCompleted: !!hasResult
      });
    } else {
      result.push(m);
    }
  }
  return result;
}

describe('Legacy processMessages logic', () => {
  it('single tool-use is both isFirst and isLast', () => {
    const messages = [msg('assistant'), msg('tool-use', { toolName: 'Read' }), msg('tool-result'), msg('assistant')];
    const processed = processMessages(messages);
    const tool = processed.find(m => m.type === 'tool-use');
    expect(tool.isFirst).toBe(true);
    expect(tool.isLast).toBe(true);
  });

  it('three consecutive tool-uses: first/middle/last', () => {
    const messages = [
      msg('tool-use'), msg('tool-result'),
      msg('tool-use'), msg('tool-result'),
      msg('tool-use'), msg('tool-result'),
    ];
    const processed = processMessages(messages);
    const tools = processed.filter(m => m.type === 'tool-use');
    expect(tools[0].isFirst).toBe(true);
    expect(tools[0].isLast).toBe(false);
    expect(tools[1].isFirst).toBe(false);
    expect(tools[1].isLast).toBe(false);
    expect(tools[2].isFirst).toBe(false);
    expect(tools[2].isLast).toBe(true);
  });

  it('tool-result filtered out', () => {
    const messages = [msg('tool-use'), msg('tool-result')];
    const processed = processMessages(messages);
    expect(processed.filter(m => m.type === 'tool-result')).toHaveLength(0);
  });

  it('tool-use with result is completed', () => {
    const messages = [msg('tool-use', { toolName: 'Read' }), msg('tool-result')];
    const processed = processMessages(messages);
    expect(processed[0].isCompleted).toBe(true);
    expect(processed[0].isRunning).toBe(false);
  });

  it('tool-use without result is running', () => {
    const messages = [msg('tool-use', { toolName: 'Read' })];
    const processed = processMessages(messages);
    expect(processed[0].isRunning).toBe(true);
  });

  it('history tool-use without result is not running', () => {
    const messages = [msg('tool-use', { toolName: 'Read', isHistory: true })];
    const processed = processMessages(messages);
    expect(processed[0].isRunning).toBe(false);
  });
});
