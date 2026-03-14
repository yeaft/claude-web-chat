import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for chat-body / chat-body-main flex layout (task-66).
 *
 * PR #228 fixes a P0 bug where ChatInput was pushed off-screen on mobile
 * because .chat-body-main lacked `min-height: 0`, preventing flex shrink.
 *
 * These tests guard the critical CSS properties that make the layout work:
 * - .chat-body: horizontal flex container for main + expert panel
 * - .chat-body-main: vertical flex container for MessageList + ChatInput
 * - .chat-container (MessageList): scrollable, flex-shrink capable
 * - .input-area (ChatInput): pinned at bottom, no shrink
 */

// ---- Helpers ----
const cssPath = resolve(__dirname, '../../web/styles/expert-panel.css');
const chatInputCssPath = resolve(__dirname, '../../web/styles/chat-input.css');
const mainCssPath = resolve(__dirname, '../../web/styles/sidebar.css');
const chatPagePath = resolve(__dirname, '../../web/components/ChatPage.js');

function readFile(p) {
  return readFileSync(p, 'utf-8');
}

/**
 * Extract a CSS rule block by selector name.
 * Returns the content between { and } for the first matching rule.
 */
function extractCssRule(css, selector) {
  // Escape dots and special chars for regex
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match selector followed by { ... } (non-greedy, handles nested blocks simply)
  const regex = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'm');
  const match = css.match(regex);
  return match ? match[1] : null;
}

/**
 * Check if a CSS rule contains a specific property: value pair.
 */
function hasProperty(ruleContent, property, value) {
  if (!ruleContent) return false;
  // Normalize whitespace and look for property: value
  const normalized = ruleContent.replace(/\s+/g, ' ');
  const regex = new RegExp(`${property}\\s*:\\s*${value}`);
  return regex.test(normalized);
}

// =====================================================================
// CSS flex layout properties — the core of the fix
// =====================================================================

describe('chat-body flex layout (task-66 fix)', () => {
  const css = readFile(cssPath);

  describe('.chat-body container', () => {
    const rule = extractCssRule(css, '.chat-body');

    it('uses flex layout', () => {
      expect(hasProperty(rule, 'display', 'flex')).toBe(true);
    });

    it('has min-height: 0 to allow shrinking in parent flex', () => {
      expect(hasProperty(rule, 'min-height', '0')).toBe(true);
    });

    it('fills available space with flex: 1', () => {
      expect(hasProperty(rule, 'flex', '1')).toBe(true);
    });
  });

  describe('.chat-body-main — the fix target', () => {
    const rule = extractCssRule(css, '.chat-body-main');

    it('uses column flex layout', () => {
      expect(hasProperty(rule, 'display', 'flex')).toBe(true);
      expect(hasProperty(rule, 'flex-direction', 'column')).toBe(true);
    });

    it('has min-height: 0 — the critical fix for mobile input visibility', () => {
      // Without min-height: 0, flex children default to min-height: auto,
      // which prevents shrinking below content size. This pushes ChatInput
      // off-screen when MessageList content is tall.
      expect(hasProperty(rule, 'min-height', '0')).toBe(true);
    });

    it('fills available space with flex: 1', () => {
      expect(hasProperty(rule, 'flex', '1')).toBe(true);
    });

    it('has overflow: hidden to contain children', () => {
      expect(hasProperty(rule, 'overflow', 'hidden')).toBe(true);
    });
  });
});

// =====================================================================
// Supporting layout properties — ensuring no regression
// =====================================================================

describe('supporting layout properties', () => {
  it('.chat-container (MessageList) is scrollable and shrinkable', () => {
    const css = readFile(mainCssPath);
    const rule = extractCssRule(css, '.chat-container');
    expect(hasProperty(rule, 'flex', '1')).toBe(true);
    expect(hasProperty(rule, 'overflow-y', 'auto')).toBe(true);
    expect(hasProperty(rule, 'min-height', '0')).toBe(true);
  });

  it('.input-area (ChatInput) does not shrink', () => {
    const css = readFile(chatInputCssPath);
    const rule = extractCssRule(css, '.input-area');
    expect(hasProperty(rule, 'flex-shrink', '0')).toBe(true);
  });
});

// =====================================================================
// ChatPage template — structural guard
// =====================================================================

describe('ChatPage template structure', () => {
  const source = readFile(chatPagePath);

  it('wraps MessageList and ChatInput in chat-body-main', () => {
    // Verify the nesting: chat-body > chat-body-main > [MessageList, ChatInput]
    const bodyMainStart = source.indexOf('class="chat-body-main"');
    const messageList = source.indexOf('<MessageList', bodyMainStart);
    const chatInput = source.indexOf('<ChatInput', bodyMainStart);

    expect(bodyMainStart).toBeGreaterThan(-1);
    expect(messageList).toBeGreaterThan(bodyMainStart);
    expect(chatInput).toBeGreaterThan(messageList);
  });

  it('chat-body-main is inside chat-body', () => {
    const bodyStart = source.indexOf('class="chat-body"');
    const bodyMainStart = source.indexOf('class="chat-body-main"');
    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyMainStart).toBeGreaterThan(bodyStart);
  });

  it('ExpertPanel is sibling of chat-body-main (not inside it)', () => {
    const bodyMainEnd = source.indexOf('</div>', source.indexOf('class="chat-body-main"'));
    const expertPanel = source.indexOf('<ExpertPanel', bodyMainEnd);
    // ExpertPanel should appear after chat-body-main closes
    expect(expertPanel).toBeGreaterThan(bodyMainEnd);
  });
});
