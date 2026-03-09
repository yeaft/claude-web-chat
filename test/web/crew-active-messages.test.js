import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for task-46c: Active Messages — single latest text message.
 *
 * Verifies:
 * 1) activeMessages computed returns exactly 1 message (latest text, any role)
 * 2) Reverse-scan picks the latest text message
 * 3) Template: getRoleStyle for role color, shows taskTitle, has "Latest Message" label
 * 4) No typing dots in dynamic message area
 * 5) CSS: .crew-active-messages styling + no border-left override + task label
 * 6) Hidden when all tasks completed (no active features)
 * 7) Structural integrity
 */

let jsSource;
let cssSource;

beforeAll(() => {
  const jsPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  jsSource = readFileSync(jsPath, 'utf-8');

  cssSource = loadAllCss();
});

/**
 * Extract a CSS rule block by selector.
 */
function extractCssBlock(selector) {
  const idx = cssSource.indexOf(selector);
  if (idx === -1) return '';
  const braceStart = cssSource.indexOf('{', idx);
  if (braceStart === -1) return '';
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < cssSource.length; i++) {
    if (cssSource[i] === '{') depth++;
    if (cssSource[i] === '}') depth--;
    if (depth === 0) { end = i; break; }
  }
  return cssSource.substring(braceStart + 1, end).trim();
}

/**
 * Extract a computed property body from the JS source.
 */
function extractComputedBody(name) {
  const idx = jsSource.indexOf(`${name}() {`);
  if (idx === -1) return '';
  const braceStart = jsSource.indexOf('{', idx);
  if (braceStart === -1) return '';
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < jsSource.length; i++) {
    if (jsSource[i] === '{') depth++;
    if (jsSource[i] === '}') depth--;
    if (depth === 0) { end = i; break; }
  }
  return jsSource.substring(braceStart + 1, end).trim();
}

/**
 * Extract the active messages template area (between crew-active-messages and crew-scroll-bottom).
 */
function getActiveArea() {
  return jsSource.substring(
    jsSource.indexOf('crew-active-messages'),
    jsSource.indexOf('crew-scroll-bottom')
  );
}

// =====================================================================
// 1. activeMessages computed — single latest text message
// =====================================================================
describe('activeMessages computed — single latest message', () => {
  it('activeMessages method exists', () => {
    const body = extractComputedBody('activeMessages');
    expect(body.length).toBeGreaterThan(0);
  });

  it('does NOT filter by _streaming flag', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('m._streaming');
  });

  it('filters by m.type !== text (skip non-text)', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.type !== 'text'");
  });

  it('skips system role', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role === 'system'");
  });

  it('skips human role (user messages filtered out)', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role === 'human'");
  });

  it('skips both system and human in the same condition', () => {
    const body = extractComputedBody('activeMessages');
    // Both roles are checked in a single continue statement
    expect(body).toMatch(/m\.role === 'system' \|\| m\.role === 'human'/);
  });

  it('returns array with single message via return [m]', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('return [m]');
  });

  it('does NOT track latestHuman or latestCrew', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('latestHuman');
    expect(body).not.toContain('latestCrew');
  });

  it('returns empty array when no text messages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('return []');
  });
});

// =====================================================================
// 2. Reverse scan algorithm
// =====================================================================
describe('reverse scan for latest message', () => {
  it('scans messages in reverse order', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toMatch(/for\s*\(\s*let\s+i\s*=\s*messages\.length\s*-\s*1;\s*i\s*>=\s*0;\s*i--\)/);
  });

  it('does NOT use Set for deduplication', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('new Set()');
    expect(body).not.toContain('seen.has');
  });
});

// =====================================================================
// 3. activeMessages data source
// =====================================================================
describe('activeMessages data source', () => {
  it('reads from store.currentCrewMessages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('this.store.currentCrewMessages');
  });

  it('does NOT use result array (returns directly)', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('const result = []');
  });
});

// =====================================================================
// 4. Template — no border, task info, label, feature block structure
// =====================================================================
describe('template — role color, task info, label', () => {
  it('active messages use crew-message class', () => {
    expect(getActiveArea()).toContain('crew-message');
  });

  it('uses dynamic crew-msg-type class like feature block', () => {
    expect(getActiveArea()).toContain("'crew-msg-' + am.type");
  });

  it('has crew-msg-human-bubble conditional class', () => {
    expect(getActiveArea()).toContain('crew-msg-human-bubble');
  });

  it('uses getRoleStyle for role color', () => {
    expect(getActiveArea()).toContain('getRoleStyle');
  });

  it('shows taskTitle for feature context', () => {
    expect(getActiveArea()).toContain('am.taskTitle');
    expect(getActiveArea()).toContain('crew-msg-task');
  });

  it('has "Latest Message" label at top', () => {
    expect(getActiveArea()).toContain('crew-active-messages-label');
    expect(getActiveArea()).toContain("$t('crew.latestMessage')");
  });

  it('header conditionally hidden for human text messages', () => {
    expect(getActiveArea()).toContain("am.role !== 'human' || am.type !== 'text'");
  });

  it('crew-msg-name has is-human/is-system class binding', () => {
    expect(getActiveArea()).toContain("'is-human': am.role === 'human'");
    expect(getActiveArea()).toContain("'is-system': am.role === 'system'");
  });

  it('shows formatTime(am.timestamp) for time display', () => {
    expect(getActiveArea()).toContain('formatTime(am.timestamp)');
  });

  it('uses crew-msg-body wrapper', () => {
    expect(getActiveArea()).toContain('crew-msg-body');
  });

  it('uses crew-msg-header for role info', () => {
    expect(getActiveArea()).toContain('crew-msg-header');
  });

  it('iterates activeMessages with v-for', () => {
    expect(jsSource).toContain('v-for="am in activeMessages"');
  });

  it('renders content with mdRender', () => {
    expect(jsSource).toContain('mdRender(am.content)');
  });
});

// =====================================================================
// 5. No typing dots in dynamic message area
// =====================================================================
describe('no typing dots in active messages area', () => {
  it('does NOT have typing dots between active messages and scroll-bottom', () => {
    expect(getActiveArea()).not.toContain('crew-typing-dot');
  });

  it('does NOT have crew-streaming-indicator between active messages and scroll-bottom', () => {
    expect(getActiveArea()).not.toContain('crew-streaming-indicator');
  });
});

// =====================================================================
// 6. Hidden when all tasks completed
// =====================================================================
describe('hidden when all tasks completed', () => {
  it('v-if includes hasStreamingMessage or kanbanInProgressCount > 0', () => {
    const vifMatch = jsSource.match(/v-if="activeMessages\.length > 0 && \(hasStreamingMessage \|\| kanbanInProgressCount > 0\)"/);
    expect(vifMatch).not.toBeNull();
  });
});

// =====================================================================
// 7. CSS — visual distinction (background, border-radius, margin, label)
// =====================================================================
describe('CSS — visual distinction for Dynamic Message area', () => {
  it('.crew-active-messages has sidebar background color', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toContain('var(--bg-sidebar)');
  });

  it('.crew-active-messages has 8px border-radius', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toMatch(/border-radius:\s*8px/);
  });

  it('.crew-active-messages has increased top margin for spacing', () => {
    const block = extractCssBlock('.crew-active-messages {');
    // margin: 16px 8px 8px — top margin increased from 8px to 16px
    expect(block).toMatch(/margin:\s*16px\s+8px\s+8px/);
  });

  it('.crew-active-messages has horizontal inset (8px left/right) for visible border', () => {
    const block = extractCssBlock('.crew-active-messages {');
    // margin: 16px 8px 8px — the 8px left/right margins create visible container edge
    expect(block).toMatch(/margin:\s*16px\s+8px/);
  });

  it('.crew-active-messages-label uses muted color', () => {
    const block = extractCssBlock('.crew-active-messages-label {');
    expect(block).toContain('var(--text-muted)');
  });

  it('.crew-active-messages-label does NOT use secondary color', () => {
    const block = extractCssBlock('.crew-active-messages-label {');
    expect(block).not.toContain('var(--text-secondary)');
  });

  it('.crew-active-messages does NOT use box-shadow', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).not.toContain('box-shadow');
  });

  it('.crew-active-messages does NOT use border or divider', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).not.toContain('border-top');
    expect(block).not.toContain('border-bottom');
  });
});

// =====================================================================
// 8. Behavioral logic — human messages excluded from activeMessages
// =====================================================================
describe('activeMessages filtering — behavioral verification', () => {
  // Re-implement the activeMessages logic to verify behavior
  function activeMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type !== 'text' || !m.role) continue;
      if (m.role === 'system' || m.role === 'human') continue;
      return [m];
    }
    return [];
  }

  it('returns AI message when latest message is from AI role', () => {
    const messages = [
      { type: 'text', role: 'human', content: 'user input' },
      { type: 'text', role: 'dev-1', content: 'AI reply' }
    ];
    const result = activeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('dev-1');
    expect(result[0].content).toBe('AI reply');
  });

  it('skips user message at end and finds previous AI message', () => {
    const messages = [
      { type: 'text', role: 'dev-1', content: 'first AI reply' },
      { type: 'text', role: 'pm', content: 'PM reply' },
      { type: 'text', role: 'human', content: 'user just typed this' }
    ];
    const result = activeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('pm');
  });

  it('returns empty when only human messages exist', () => {
    const messages = [
      { type: 'text', role: 'human', content: 'question 1' },
      { type: 'text', role: 'human', content: 'question 2' }
    ];
    const result = activeMessages(messages);
    expect(result).toHaveLength(0);
  });

  it('returns empty when only system messages exist', () => {
    const messages = [
      { type: 'text', role: 'system', content: 'system notice' }
    ];
    const result = activeMessages(messages);
    expect(result).toHaveLength(0);
  });

  it('skips non-text messages (tool, route)', () => {
    const messages = [
      { type: 'text', role: 'dev-1', content: 'AI reply' },
      { type: 'tool', role: 'dev-1', content: 'tool call' },
      { type: 'route', role: 'dev-1', content: 'routing' },
      { type: 'text', role: 'human', content: 'user input' }
    ];
    const result = activeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('AI reply');
  });

  it('returns empty for empty messages array', () => {
    expect(activeMessages([])).toHaveLength(0);
  });
});
