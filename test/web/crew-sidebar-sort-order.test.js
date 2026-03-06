import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for sidebar conversation ordering.
 *
 * Verifies:
 * 1) Normal conversations appear above (first) in sidebar, Crew Sessions below
 * 2) Both panels always render with their group headers
 * 3) Each group still uses its correct rendering (normal uses getConversationTitle, crew uses getCrewTitle)
 * 4) Independent scroll panels structure
 */

let chatPageSource;

beforeAll(() => {
  const chatPagePath = resolve(__dirname, '../../web/components/ChatPage.js');
  chatPageSource = readFileSync(chatPagePath, 'utf-8');
});

// =====================================================================
// 1. Normal conversations appear above, Crew Sessions below
// =====================================================================
describe('sidebar ordering — normal conversations above, crew sessions below', () => {
  it('normalConversations v-for appears before crewConversations v-for', () => {
    const normalIdx = chatPageSource.indexOf('v-for="conv in normalConversations"');
    const crewIdx = chatPageSource.indexOf('v-for="conv in crewConversations"');
    expect(normalIdx).toBeGreaterThan(-1);
    expect(crewIdx).toBeGreaterThan(-1);
    expect(normalIdx).toBeLessThan(crewIdx);
  });

  it('"recentChats" i18n key appears before "Crew Sessions" header', () => {
    const recentIdx = chatPageSource.indexOf("chat.sidebar.recentChats");
    const crewIdx = chatPageSource.indexOf('Crew Sessions');
    expect(recentIdx).toBeGreaterThan(-1);
    expect(crewIdx).toBeGreaterThan(-1);
    expect(recentIdx).toBeLessThan(crewIdx);
  });

  it('both sections are inside the session-panels container', () => {
    const panelsStart = chatPageSource.indexOf('class="session-panels"');
    const normalIdx = chatPageSource.indexOf('v-for="conv in normalConversations"');
    const crewIdx = chatPageSource.indexOf('v-for="conv in crewConversations"');
    expect(panelsStart).toBeGreaterThan(-1);
    expect(panelsStart).toBeLessThan(normalIdx);
    expect(panelsStart).toBeLessThan(crewIdx);
  });
});

// =====================================================================
// 2. Both panels always render with group headers
// =====================================================================
describe('group headers always shown in dual-panel layout', () => {
  it('has session-group-header for recent chats using i18n', () => {
    expect(chatPageSource).toContain("$t('chat.sidebar.recentChats')");
  });

  it('"Crew Sessions" header always present', () => {
    expect(chatPageSource).toContain('Crew Sessions');
  });

  it('Crew Sessions header has the crew group icon SVG', () => {
    // Find the actual <span>Crew Sessions</span>, not the comment
    const crewHeaderIdx = chatPageSource.indexOf('<span>Crew Sessions</span>');
    expect(crewHeaderIdx).toBeGreaterThan(-1);
    const precedingChunk = chatPageSource.substring(Math.max(0, crewHeaderIdx - 500), crewHeaderIdx);
    expect(precedingChunk).toContain('session-group-icon');
  });

  it('chat sessions header has the chat icon SVG', () => {
    const recentIdx = chatPageSource.indexOf("chat.sidebar.recentChats");
    const precedingChunk = chatPageSource.substring(Math.max(0, recentIdx - 300), recentIdx);
    expect(precedingChunk).toContain('session-group-icon');
  });
});

// =====================================================================
// 3. Independent scroll panel structure
// =====================================================================
describe('independent scroll panels', () => {
  it('has session-panels wrapper', () => {
    expect(chatPageSource).toContain('class="session-panels"');
  });

  it('has session-panel containers', () => {
    expect(chatPageSource).toContain('class="session-panel"');
  });

  it('has session-panel-list containers for scrollable areas', () => {
    expect(chatPageSource).toContain('class="session-panel-list"');
  });

  it('has no divider between panels (clean layout)', () => {
    expect(chatPageSource).not.toContain('session-panel-divider');
  });

  it('has add buttons in group headers', () => {
    expect(chatPageSource).toContain('session-header-add-btn');
  });
});

// =====================================================================
// 4. Each group uses correct rendering patterns
// =====================================================================
describe('group rendering correctness', () => {
  it('normal conversations use getConversationTitle', () => {
    const normalSection = chatPageSource.substring(
      chatPageSource.indexOf('v-for="conv in normalConversations"'),
      chatPageSource.indexOf('v-for="conv in crewConversations"')
    );
    expect(normalSection).toContain('getConversationTitle(conv)');
  });

  it('normal conversations do NOT use crew-specific rendering', () => {
    const normalSection = chatPageSource.substring(
      chatPageSource.indexOf('v-for="conv in normalConversations"'),
      chatPageSource.indexOf('v-for="conv in crewConversations"')
    );
    expect(normalSection).not.toContain('getCrewTitle');
    expect(normalSection).not.toContain('crew-conv-icon');
    expect(normalSection).not.toContain('session-item-crew');
  });

  it('crew conversations use getCrewTitle', () => {
    const crewIdx = chatPageSource.indexOf('v-for="conv in crewConversations"');
    const crewSection = chatPageSource.substring(crewIdx, crewIdx + 1500);
    expect(crewSection).toContain('getCrewTitle(conv)');
  });

  it('crew conversations have crew-specific classes and elements', () => {
    const crewIdx = chatPageSource.indexOf('v-for="conv in crewConversations"');
    const crewSection = chatPageSource.substring(crewIdx, crewIdx + 1500);
    expect(crewSection).toContain('session-item-crew');
    expect(crewSection).toContain('crew-conv-icon');
  });

  it('crew conversation items use class="session-item session-item-crew"', () => {
    const crewIdx = chatPageSource.indexOf('v-for="conv in crewConversations"');
    const crewSection = chatPageSource.substring(crewIdx, crewIdx + 1500);
    expect(crewSection).toContain('class="session-item session-item-crew"');
  });
});

// =====================================================================
// 5. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('ChatPage.js has no regressions in div tag balance', () => {
    const opens = (chatPageSource.match(/<div[\s>]/g) || []).length;
    const closes = (chatPageSource.match(/<\/div>/g) || []).length;
    expect(Math.abs(opens - closes)).toBeLessThanOrEqual(1);
  });

  it('ChatPage.js has balanced template tags', () => {
    const opens = (chatPageSource.match(/<template[\s>]/g) || []).length;
    const closes = (chatPageSource.match(/<\/template>/g) || []).length;
    expect(opens).toBe(closes);
  });
});
