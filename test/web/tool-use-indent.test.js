import { describe, it, expect } from 'vitest';

/**
 * Tests for tool-use indent/connection line logic.
 *
 * Verifies the processedMessages logic from MessageList.js:
 * 1) tool-use messages get isFirst/isLast/isRunning/isCompleted flags
 * 2) Consecutive tool-use sequences have correct first/last markers
 * 3) Single tool-use is both first and last (dot only, no line)
 * 4) Running state = no result + not history; Completed = has result
 * 5) Non-tool-use messages are passed through unchanged
 *
 * Verifies the messageClass logic from MessageItem.js:
 * 6) CSS classes are correctly generated from flags
 *
 * Verifies CSS rules (source verification):
 * 7) tool-use has margin-left: 24px
 * 8) AskUserQuestion (.ask-card) and TodoWrite (.todo-list) excluded
 * 9) Mobile responsive reduces to 16px
 */

// =====================================================================
// Replicate processedMessages logic from MessageList.js:88-128
// =====================================================================
function processMessages(messages) {
  const result = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.type === 'tool-result') {
      continue;
    }

    if (msg.type === 'tool-use') {
      const nextMsg = messages[i + 1];
      const hasResult = nextMsg && nextMsg.type === 'tool-result';

      // Check previous non-tool-result message
      let prevIdx = i - 1;
      while (prevIdx >= 0 && messages[prevIdx].type === 'tool-result') prevIdx--;
      const prevIsToolUse = prevIdx >= 0 && messages[prevIdx].type === 'tool-use';

      // Check next non-tool-result message
      let nextIdx = hasResult ? i + 2 : i + 1;
      const nextIsToolUse = nextIdx < messages.length && messages[nextIdx].type === 'tool-use';

      result.push({
        ...msg,
        hasResult,
        isFirst: !prevIsToolUse,
        isLast: !nextIsToolUse,
        isRunning: !hasResult && !msg.isHistory,
        isCompleted: !!hasResult
      });
    } else {
      result.push(msg);
    }
  }

  return result;
}

// Replicate messageClass logic from MessageItem.js:374-384
function computeMessageClass(message) {
  const base = ['message', message.type];
  if (message.isStreaming) base.push('streaming');
  if (message.type === 'tool-use') {
    if (message.isFirst) base.push('is-first');
    if (message.isLast) base.push('is-last');
    if (message.isRunning) base.push('is-running');
    if (message.isCompleted) base.push('is-completed');
  }
  return base;
}

// Helper to create test messages
function msg(type, extra = {}) {
  return { type, id: Math.random().toString(36).slice(2), ...extra };
}

// =====================================================================
// Tests
// =====================================================================

describe('Tool-use sequence position marking', () => {

  describe('Single tool-use (dot only, no connecting line)', () => {
    it('single tool-use with result should be both isFirst and isLast', () => {
      const messages = [
        msg('assistant'),
        msg('tool-use', { toolName: 'Read' }),
        msg('tool-result'),
        msg('assistant'),
      ];
      const processed = processMessages(messages);
      const toolUse = processed.find(m => m.type === 'tool-use');
      expect(toolUse.isFirst).toBe(true);
      expect(toolUse.isLast).toBe(true);
    });

    it('single tool-use without result should be both isFirst and isLast', () => {
      const messages = [
        msg('assistant'),
        msg('tool-use', { toolName: 'Read' }),
      ];
      const processed = processMessages(messages);
      const toolUse = processed.find(m => m.type === 'tool-use');
      expect(toolUse.isFirst).toBe(true);
      expect(toolUse.isLast).toBe(true);
    });
  });

  describe('Consecutive tool-use sequence (connecting lines)', () => {
    it('three consecutive tool-uses: first/middle/last marked correctly', () => {
      const messages = [
        msg('tool-use', { toolName: 'Read' }),
        msg('tool-result'),
        msg('tool-use', { toolName: 'Edit' }),
        msg('tool-result'),
        msg('tool-use', { toolName: 'Bash' }),
        msg('tool-result'),
      ];
      const processed = processMessages(messages);
      const tools = processed.filter(m => m.type === 'tool-use');
      expect(tools).toHaveLength(3);

      // First tool
      expect(tools[0].isFirst).toBe(true);
      expect(tools[0].isLast).toBe(false);

      // Middle tool
      expect(tools[1].isFirst).toBe(false);
      expect(tools[1].isLast).toBe(false);

      // Last tool
      expect(tools[2].isFirst).toBe(false);
      expect(tools[2].isLast).toBe(true);
    });

    it('two consecutive tool-uses: both are first/last respectively', () => {
      const messages = [
        msg('tool-use', { toolName: 'Read' }),
        msg('tool-result'),
        msg('tool-use', { toolName: 'Edit' }),
        msg('tool-result'),
      ];
      const processed = processMessages(messages);
      const tools = processed.filter(m => m.type === 'tool-use');
      expect(tools).toHaveLength(2);

      expect(tools[0].isFirst).toBe(true);
      expect(tools[0].isLast).toBe(false);

      expect(tools[1].isFirst).toBe(false);
      expect(tools[1].isLast).toBe(true);
    });
  });

  describe('Tool-use sequence broken by non-tool messages', () => {
    it('assistant message between tool-uses breaks the sequence', () => {
      const messages = [
        msg('tool-use', { toolName: 'Read' }),
        msg('tool-result'),
        msg('assistant'),  // breaks sequence
        msg('tool-use', { toolName: 'Edit' }),
        msg('tool-result'),
      ];
      const processed = processMessages(messages);
      const tools = processed.filter(m => m.type === 'tool-use');
      expect(tools).toHaveLength(2);

      // Each tool-use should be isolated (both first and last)
      expect(tools[0].isFirst).toBe(true);
      expect(tools[0].isLast).toBe(true);

      expect(tools[1].isFirst).toBe(true);
      expect(tools[1].isLast).toBe(true);
    });

    it('user message between tool-uses breaks the sequence', () => {
      const messages = [
        msg('tool-use', { toolName: 'Read' }),
        msg('tool-result'),
        msg('user'),
        msg('tool-use', { toolName: 'Edit' }),
        msg('tool-result'),
      ];
      const processed = processMessages(messages);
      const tools = processed.filter(m => m.type === 'tool-use');

      expect(tools[0].isFirst).toBe(true);
      expect(tools[0].isLast).toBe(true);

      expect(tools[1].isFirst).toBe(true);
      expect(tools[1].isLast).toBe(true);
    });
  });
});

describe('Tool-use running/completed state', () => {

  it('tool-use with result is completed', () => {
    const messages = [
      msg('tool-use', { toolName: 'Read' }),
      msg('tool-result'),
    ];
    const processed = processMessages(messages);
    const tool = processed.find(m => m.type === 'tool-use');
    expect(tool.isCompleted).toBe(true);
    expect(tool.isRunning).toBe(false);
  });

  it('tool-use without result and not history is running', () => {
    const messages = [
      msg('tool-use', { toolName: 'Read', isHistory: false }),
    ];
    const processed = processMessages(messages);
    const tool = processed.find(m => m.type === 'tool-use');
    expect(tool.isRunning).toBe(true);
    expect(tool.isCompleted).toBe(false);
  });

  it('tool-use without result but isHistory is NOT running', () => {
    const messages = [
      msg('tool-use', { toolName: 'Read', isHistory: true }),
    ];
    const processed = processMessages(messages);
    const tool = processed.find(m => m.type === 'tool-use');
    expect(tool.isRunning).toBe(false);
    expect(tool.isCompleted).toBe(false);
  });

  it('last tool in sequence without result is running (active tool)', () => {
    const messages = [
      msg('tool-use', { toolName: 'Read' }),
      msg('tool-result'),
      msg('tool-use', { toolName: 'Edit' }),
      msg('tool-result'),
      msg('tool-use', { toolName: 'Bash' }),  // no result = running
    ];
    const processed = processMessages(messages);
    const tools = processed.filter(m => m.type === 'tool-use');

    expect(tools[0].isCompleted).toBe(true);
    expect(tools[0].isRunning).toBe(false);

    expect(tools[1].isCompleted).toBe(true);
    expect(tools[1].isRunning).toBe(false);

    expect(tools[2].isCompleted).toBe(false);
    expect(tools[2].isRunning).toBe(true);
  });
});

describe('tool-result messages are filtered out', () => {
  it('tool-result should not appear in processed output', () => {
    const messages = [
      msg('tool-use'),
      msg('tool-result'),
      msg('tool-use'),
      msg('tool-result'),
      msg('assistant'),
    ];
    const processed = processMessages(messages);
    const toolResults = processed.filter(m => m.type === 'tool-result');
    expect(toolResults).toHaveLength(0);
  });

  it('non-tool messages pass through unchanged', () => {
    const messages = [
      msg('user', { content: 'hello' }),
      msg('assistant', { content: 'hi' }),
    ];
    const processed = processMessages(messages);
    expect(processed).toHaveLength(2);
    expect(processed[0].type).toBe('user');
    expect(processed[1].type).toBe('assistant');
    // Should NOT have tool-use specific flags
    expect(processed[0].isFirst).toBeUndefined();
    expect(processed[0].isLast).toBeUndefined();
    expect(processed[0].isRunning).toBeUndefined();
    expect(processed[0].isCompleted).toBeUndefined();
  });
});

describe('CSS class generation (MessageItem messageClass)', () => {
  it('completed first+last tool-use gets correct classes', () => {
    const message = {
      type: 'tool-use',
      isFirst: true,
      isLast: true,
      isRunning: false,
      isCompleted: true
    };
    const classes = computeMessageClass(message);
    expect(classes).toContain('message');
    expect(classes).toContain('tool-use');
    expect(classes).toContain('is-first');
    expect(classes).toContain('is-last');
    expect(classes).toContain('is-completed');
    expect(classes).not.toContain('is-running');
  });

  it('running middle tool-use gets correct classes', () => {
    const message = {
      type: 'tool-use',
      isFirst: false,
      isLast: false,
      isRunning: true,
      isCompleted: false
    };
    const classes = computeMessageClass(message);
    expect(classes).toContain('message');
    expect(classes).toContain('tool-use');
    expect(classes).toContain('is-running');
    expect(classes).not.toContain('is-first');
    expect(classes).not.toContain('is-last');
    expect(classes).not.toContain('is-completed');
  });

  it('streaming tool-use includes streaming class', () => {
    const message = {
      type: 'tool-use',
      isFirst: true,
      isLast: true,
      isRunning: true,
      isCompleted: false,
      isStreaming: true
    };
    const classes = computeMessageClass(message);
    expect(classes).toContain('streaming');
    expect(classes).toContain('is-running');
  });

  it('non-tool-use message does not get tool-use flags', () => {
    const message = { type: 'assistant', isFirst: true };
    const classes = computeMessageClass(message);
    expect(classes).toEqual(['message', 'assistant']);
    // isFirst is ignored for non-tool-use types
    expect(classes).not.toContain('is-first');
  });
});

describe('CSS source verification', () => {
  let cssContent;

  it('should load style.css from dev-3 worktree', async () => {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    // Try worktree first, fallback to main
    const worktreePath = join(process.cwd(), '.worktrees/dev-3/web/style.css');
    const mainPath = join(process.cwd(), 'web/style.css');
    try {
      cssContent = await fs.readFile(worktreePath, 'utf-8');
    } catch {
      cssContent = await fs.readFile(mainPath, 'utf-8');
    }
    expect(cssContent).toBeDefined();
    expect(cssContent.length).toBeGreaterThan(0);
  });

  it('tool-use should have margin-left: 24px', () => {
    // The CSS block for .message.tool-use should contain margin-left: 24px
    expect(cssContent).toContain('margin-left: 24px');
  });

  it('should have connection line via ::before pseudo-element', () => {
    expect(cssContent).toContain('.message.tool-use::before');
  });

  it('should have node dot via ::after pseudo-element', () => {
    expect(cssContent).toContain('.message.tool-use::after');
  });

  it('running tool should have pulse animation', () => {
    expect(cssContent).toContain('.message.tool-use.is-running::after');
    expect(cssContent).toContain('toolNodePulse');
  });

  it('completed tool should have green dot', () => {
    expect(cssContent).toContain('.message.tool-use.is-completed::after');
    expect(cssContent).toContain('var(--success)');
  });

  it('is-first should clip line to start at midpoint', () => {
    expect(cssContent).toContain('.message.tool-use.is-first::before');
  });

  it('is-last should clip line to end at midpoint', () => {
    expect(cssContent).toContain('.message.tool-use.is-last::before');
  });

  it('AskUserQuestion (.ask-card) should be excluded from indent', () => {
    expect(cssContent).toContain('.message.tool-use:has(.ask-card)');
    // Check that it resets margin-left
    const askCardSection = cssContent.split('.message.tool-use:has(.ask-card)')[1];
    expect(askCardSection).toContain('margin-left: 0');
  });

  it('TodoWrite (.todo-list) should be excluded from indent', () => {
    expect(cssContent).toContain('.message.tool-use:has(.todo-list)');
    const todoSection = cssContent.split('.message.tool-use:has(.todo-list)')[1];
    expect(todoSection).toContain('margin-left: 0');
  });

  it('AskUserQuestion pseudo-elements should be hidden', () => {
    expect(cssContent).toContain('.message.tool-use:has(.ask-card)::before');
    expect(cssContent).toContain('.message.tool-use:has(.ask-card)::after');
  });

  it('TodoWrite pseudo-elements should be hidden', () => {
    expect(cssContent).toContain('.message.tool-use:has(.todo-list)::before');
    expect(cssContent).toContain('.message.tool-use:has(.todo-list)::after');
  });

  it('mobile responsive should reduce indent to 16px', () => {
    // Check that @media (max-width: 768px) section contains reduced margin
    const mobileSection = cssContent.split('@media (max-width: 768px)').slice(1).join('');
    expect(mobileSection).toContain('margin-left: 16px');
  });
});

describe('Edge cases', () => {
  it('empty message list returns empty', () => {
    expect(processMessages([])).toEqual([]);
  });

  it('only tool-result messages (orphaned) are all filtered', () => {
    const messages = [
      msg('tool-result'),
      msg('tool-result'),
    ];
    expect(processMessages(messages)).toEqual([]);
  });

  it('tool-use at start of messages is isFirst', () => {
    const messages = [
      msg('tool-use', { toolName: 'Read' }),
      msg('tool-result'),
    ];
    const processed = processMessages(messages);
    expect(processed[0].isFirst).toBe(true);
  });

  it('tool-use at end of messages is isLast', () => {
    const messages = [
      msg('assistant'),
      msg('tool-use', { toolName: 'Read' }),
    ];
    const processed = processMessages(messages);
    const tool = processed.find(m => m.type === 'tool-use');
    expect(tool.isLast).toBe(true);
  });

  it('five consecutive tool-uses: only first and last marked', () => {
    const messages = [];
    for (let i = 0; i < 5; i++) {
      messages.push(msg('tool-use', { toolName: `Tool${i}` }));
      messages.push(msg('tool-result'));
    }
    const processed = processMessages(messages);
    const tools = processed.filter(m => m.type === 'tool-use');
    expect(tools).toHaveLength(5);

    expect(tools[0].isFirst).toBe(true);
    expect(tools[0].isLast).toBe(false);

    for (let i = 1; i < 4; i++) {
      expect(tools[i].isFirst).toBe(false);
      expect(tools[i].isLast).toBe(false);
    }

    expect(tools[4].isFirst).toBe(false);
    expect(tools[4].isLast).toBe(true);
  });

  it('tool-use without result followed by tool-use: first is running, second starts new context', () => {
    // Scenario: tool-use (no result) → tool-use (with result)
    // This can happen if a tool times out and the next tool starts
    const messages = [
      msg('tool-use', { toolName: 'Bash' }),  // no result
      msg('tool-use', { toolName: 'Read' }),   // has result
      msg('tool-result'),
    ];
    const processed = processMessages(messages);
    const tools = processed.filter(m => m.type === 'tool-use');
    expect(tools).toHaveLength(2);

    // First tool: is first, NOT last (next is also tool-use)
    expect(tools[0].isFirst).toBe(true);
    expect(tools[0].isLast).toBe(false);
    expect(tools[0].isRunning).toBe(true);  // no result, not history

    // Second tool: NOT first (prev is tool-use), is last
    expect(tools[1].isFirst).toBe(false);
    expect(tools[1].isLast).toBe(true);
    expect(tools[1].isCompleted).toBe(true);
  });
});
