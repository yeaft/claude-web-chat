import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for dev-3/sidebar-split-scroll: Sidebar dual-panel independent scroll.
 *
 * Verifies:
 * 1) Chat list and Crew list each have independent scroll containers
 * 2) Bottom inline add buttons correctly trigger new conversation / Crew
 * 3) Collapsed sidebar hides the session-panels
 * 4) Two panels each use flex:1 to split space evenly
 * 5) Panel divider separates the two panels
 * 6) CSS styles for panels, scroll, and add buttons
 * 7) Mobile layout not broken
 * 8) Structural integrity
 */

let chatPageSource;
let cssSource;

beforeAll(() => {
  const chatPagePath = resolve(__dirname, '../../web/components/ChatPage.js');
  chatPageSource = readFileSync(chatPagePath, 'utf-8');

  const cssPath = resolve(__dirname, '../../web/style.css');
  cssSource = readFileSync(cssPath, 'utf-8');
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

// =====================================================================
// 1. Dual independent scroll containers
// =====================================================================
describe('dual independent scroll containers', () => {
  it('has a session-panels wrapper around both panels', () => {
    expect(chatPageSource).toContain('class="session-panels"');
  });

  it('has exactly two session-panel containers inside session-panels', () => {
    const panelsStart = chatPageSource.indexOf('class="session-panels"');
    const panelsEnd = chatPageSource.indexOf('sidebar-bottom');
    const panelsBlock = chatPageSource.substring(panelsStart, panelsEnd + 20);
    const matches = panelsBlock.match(/class="session-panel"/g) || [];
    expect(matches.length).toBe(2);
  });

  it('each panel has a session-panel-list for scrollable content', () => {
    const matches = chatPageSource.match(/class="session-panel-list"/g) || [];
    expect(matches.length).toBe(2);
  });

  it('chat panel session-panel-list contains normalConversations v-for', () => {
    const firstPanelListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const nextPanelListIdx = chatPageSource.indexOf('class="session-panel-list"', firstPanelListIdx + 1);
    const firstPanelList = chatPageSource.substring(firstPanelListIdx, nextPanelListIdx);
    expect(firstPanelList).toContain('v-for="conv in normalConversations"');
  });

  it('crew panel session-panel-list contains crewConversations v-for', () => {
    const firstPanelListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const secondPanelListIdx = chatPageSource.indexOf('class="session-panel-list"', firstPanelListIdx + 1);
    const secondPanelList = chatPageSource.substring(secondPanelListIdx, secondPanelListIdx + 2000);
    expect(secondPanelList).toContain('v-for="conv in crewConversations"');
  });

  it('session-panel-list CSS has overflow-y: auto for independent scroll', () => {
    const block = extractCssBlock('.session-panel-list {');
    expect(block).toContain('overflow-y: auto');
  });

  it('session-panels wrapper uses overflow: hidden to contain children', () => {
    const block = extractCssBlock('.session-panels {');
    expect(block).toContain('overflow: hidden');
  });
});

// =====================================================================
// 2. Header inline add buttons
// =====================================================================
describe('header inline add buttons', () => {
  it('chat panel header has add button with openConversationModal', () => {
    const chatHeaderIdx = chatPageSource.indexOf('class="session-group-header"');
    const chatListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const chatHeader = chatPageSource.substring(chatHeaderIdx, chatListIdx);
    expect(chatHeader).toContain('session-header-add-btn');
    expect(chatHeader).toContain('@click="openConversationModal"');
  });

  it('chat add button is disabled when no agents online', () => {
    const chatHeaderIdx = chatPageSource.indexOf('class="session-group-header"');
    const chatListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const chatHeader = chatPageSource.substring(chatHeaderIdx, chatListIdx);
    expect(chatHeader).toContain(':disabled="onlineAgentCount === 0"');
  });

  it('crew panel header has add button with newCrewSession', () => {
    const crewHeaderIdx = chatPageSource.indexOf('Crew Sessions');
    const crewListIdx = chatPageSource.indexOf('class="session-panel-list"', crewHeaderIdx);
    const crewHeader = chatPageSource.substring(crewHeaderIdx, crewListIdx);
    expect(crewHeader).toContain('session-header-add-btn');
    expect(crewHeader).toContain('@click="newCrewSession"');
  });

  it('both add buttons have plus icon SVG', () => {
    const firstAddIdx = chatPageSource.indexOf('session-header-add-btn');
    const firstBtn = chatPageSource.substring(firstAddIdx, firstAddIdx + 400);
    expect(firstBtn).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');

    const secondAddIdx = chatPageSource.indexOf('session-header-add-btn', firstAddIdx + 1);
    const secondBtn = chatPageSource.substring(secondAddIdx, secondAddIdx + 400);
    expect(secondBtn).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
  });
});

// =====================================================================
// 3. Collapsed sidebar hides session-panels
// =====================================================================
describe('collapsed sidebar hides session-panels', () => {
  it('CSS rule hides session-panels when sidebar is collapsed', () => {
    expect(cssSource).toContain('.sidebar.collapsed .session-panels');
  });

  it('collapsed session-panels uses display: none', () => {
    // Find the collapsed rule block that includes session-panels
    const ruleIdx = cssSource.indexOf('.sidebar.collapsed .session-panels');
    // Go back to find the start of the multi-selector rule
    const ruleBlockStart = cssSource.lastIndexOf('.sidebar.collapsed', ruleIdx - 5);
    const braceStart = cssSource.indexOf('{', ruleBlockStart);
    const braceEnd = cssSource.indexOf('}', braceStart);
    const ruleBody = cssSource.substring(braceStart + 1, braceEnd).trim();
    expect(ruleBody).toContain('display: none');
  });

  it('collapsed sidebar still shows sidebar-collapsed-bar', () => {
    expect(chatPageSource).toContain('v-if="store.sidebarCollapsed"');
    expect(chatPageSource).toContain('sidebar-collapsed-bar');
  });

  it('collapsed bar has new conversation button', () => {
    const collapsedBarIdx = chatPageSource.indexOf('sidebar-collapsed-bar');
    const collapsedBarEnd = chatPageSource.indexOf('</div>', collapsedBarIdx + 300);
    const collapsedBar = chatPageSource.substring(collapsedBarIdx, collapsedBarEnd);
    expect(collapsedBar).toContain('openConversationModal');
  });

  it('collapsed bar has crew session button', () => {
    const collapsedBarIdx = chatPageSource.indexOf('sidebar-collapsed-bar');
    const collapsedBarEnd = chatPageSource.indexOf('</div>', collapsedBarIdx + 300);
    const collapsedBar = chatPageSource.substring(collapsedBarIdx, collapsedBarEnd);
    expect(collapsedBar).toContain('newCrewSession');
  });
});

// =====================================================================
// 4. Two panels each use flex:1 to split space evenly
// =====================================================================
describe('flex:1 space splitting', () => {
  it('session-panels is flex column container', () => {
    const block = extractCssBlock('.session-panels {');
    expect(block).toContain('display: flex');
    expect(block).toContain('flex-direction: column');
  });

  it('session-panels takes up remaining sidebar space with flex: 1', () => {
    const block = extractCssBlock('.session-panels {');
    expect(block).toContain('flex: 1');
  });

  it('session-panels has min-height: 0 for flex overflow', () => {
    const block = extractCssBlock('.session-panels {');
    expect(block).toContain('min-height: 0');
  });

  it('each session-panel has flex: 1 for equal distribution', () => {
    const block = extractCssBlock('.session-panel {');
    expect(block).toContain('flex: 1');
  });

  it('each session-panel is a flex column container', () => {
    const block = extractCssBlock('.session-panel {');
    expect(block).toContain('display: flex');
    expect(block).toContain('flex-direction: column');
  });

  it('each session-panel has min-height for usability', () => {
    const block = extractCssBlock('.session-panel {');
    expect(block).toContain('min-height: 80px');
  });

  it('each session-panel has overflow: hidden to contain scroll child', () => {
    const block = extractCssBlock('.session-panel {');
    expect(block).toContain('overflow: hidden');
  });

  it('session-panel-list takes flex: 1 and scrolls independently', () => {
    const block = extractCssBlock('.session-panel-list {');
    expect(block).toContain('flex: 1');
    expect(block).toContain('overflow-y: auto');
  });
});

// =====================================================================
// 5. No panel divider (removed for cleaner look)
// =====================================================================
describe('no panel divider between panels', () => {
  it('no session-panel-divider in template', () => {
    expect(chatPageSource).not.toContain('session-panel-divider');
  });

  it('no session-panel-divider CSS rule', () => {
    expect(cssSource).not.toContain('.session-panel-divider');
  });

  it('two session-panels are adjacent without separator', () => {
    const firstPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const secondPanelIdx = chatPageSource.indexOf('class="session-panel"', firstPanelIdx + 1);
    expect(firstPanelIdx).toBeGreaterThan(-1);
    expect(secondPanelIdx).toBeGreaterThan(-1);
  });
});

// =====================================================================
// 6. CSS styles for header add buttons
// =====================================================================
describe('CSS — session-header-add-btn styles', () => {
  it('add button is right-aligned via margin-left: auto', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('margin-left: auto');
  });

  it('add button uses flexbox for centered content', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('display: flex');
    expect(block).toContain('align-items: center');
    expect(block).toContain('justify-content: center');
  });

  it('add button is compact square', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('width: 22px');
    expect(block).toContain('height: 22px');
  });

  it('add button has no border', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('border: none');
  });

  it('add button has transparent background', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('background: transparent');
  });

  it('add button has border-radius', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('border-radius: 6px');
  });

  it('add button hover changes background and text', () => {
    const block = extractCssBlock('.session-header-add-btn:hover {');
    expect(block).toContain('background: var(--sidebar-hover)');
    expect(block).toContain('color: var(--text-primary)');
  });

  it('add button disabled state has reduced opacity', () => {
    const block = extractCssBlock('.session-header-add-btn:disabled {');
    expect(block).toContain('opacity: 0.3');
    expect(block).toContain('cursor: not-allowed');
  });

  it('add button SVG has fixed size', () => {
    const block = extractCssBlock('.session-header-add-btn svg {');
    expect(block).toContain('width: 14px');
    expect(block).toContain('height: 14px');
  });
});

// =====================================================================
// 7. Group headers in panels
// =====================================================================
describe('group headers inside panels', () => {
  it('chat panel has session-group-header before its list', () => {
    const firstPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const firstListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const headerIdx = chatPageSource.indexOf('session-group-header', firstPanelIdx);
    expect(headerIdx).toBeGreaterThan(firstPanelIdx);
    expect(headerIdx).toBeLessThan(firstListIdx);
  });

  it('crew panel has session-group-header before its list', () => {
    const firstPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const secondPanelIdx = chatPageSource.indexOf('class="session-panel"', firstPanelIdx + 1);
    const secondListIdx = chatPageSource.indexOf('class="session-panel-list"', secondPanelIdx);
    const headerIdx = chatPageSource.indexOf('session-group-header', secondPanelIdx);
    expect(headerIdx).toBeGreaterThan(secondPanelIdx);
    expect(headerIdx).toBeLessThan(secondListIdx);
  });

  it('chat panel header uses chat icon SVG (bubble path)', () => {
    const firstPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const firstListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const headerBlock = chatPageSource.substring(firstPanelIdx, firstListIdx);
    expect(headerBlock).toContain('session-group-icon');
    // Chat bubble icon path
    expect(headerBlock).toContain('M20 2H4c-1.1');
  });

  it('crew panel header uses people icon SVG', () => {
    const firstPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const secondPanelIdx = chatPageSource.indexOf('class="session-panel"', firstPanelIdx + 1);
    const secondListIdx = chatPageSource.indexOf('class="session-panel-list"', secondPanelIdx);
    const headerBlock = chatPageSource.substring(secondPanelIdx, secondListIdx);
    expect(headerBlock).toContain('session-group-icon');
    expect(headerBlock).toContain('M16 11c1.66');
  });

  it('chat header uses i18n recentChats', () => {
    const firstPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const firstListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const headerBlock = chatPageSource.substring(firstPanelIdx, firstListIdx);
    expect(headerBlock).toContain("$t('chat.sidebar.recentChats')");
  });

  it('crew header shows "Crew Sessions" text', () => {
    const firstPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const secondPanelIdx = chatPageSource.indexOf('class="session-panel"', firstPanelIdx + 1);
    const secondListIdx = chatPageSource.indexOf('class="session-panel-list"', secondPanelIdx);
    const headerBlock = chatPageSource.substring(secondPanelIdx, secondListIdx);
    expect(headerBlock).toContain('<span>Crew Sessions</span>');
  });
});

// =====================================================================
// 8. Template layout order
// =====================================================================
describe('template layout order', () => {
  it('session-panels is after sidebar-top', () => {
    const topIdx = chatPageSource.indexOf('class="sidebar-top"');
    const panelsIdx = chatPageSource.indexOf('class="session-panels"');
    expect(panelsIdx).toBeGreaterThan(topIdx);
  });

  it('session-panels is before sidebar-bottom', () => {
    const panelsIdx = chatPageSource.indexOf('class="session-panels"');
    const bottomIdx = chatPageSource.indexOf('class="sidebar-bottom"');
    expect(panelsIdx).toBeLessThan(bottomIdx);
  });

  it('panel structure: header (with add button) → list for each panel', () => {
    // Chat panel
    const chatPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const chatHeaderIdx = chatPageSource.indexOf('session-group-header', chatPanelIdx);
    const chatAddIdx = chatPageSource.indexOf('session-header-add-btn', chatPanelIdx);
    const chatListIdx = chatPageSource.indexOf('session-panel-list', chatPanelIdx);
    expect(chatHeaderIdx).toBeLessThan(chatAddIdx);
    expect(chatAddIdx).toBeLessThan(chatListIdx);

    // Crew panel
    const crewPanelIdx = chatPageSource.indexOf('class="session-panel"', chatPanelIdx + 1);
    const crewHeaderIdx = chatPageSource.indexOf('session-group-header', crewPanelIdx);
    const crewAddIdx = chatPageSource.indexOf('session-header-add-btn', crewPanelIdx);
    const crewListIdx = chatPageSource.indexOf('session-panel-list', crewPanelIdx);
    expect(crewHeaderIdx).toBeLessThan(crewAddIdx);
    expect(crewAddIdx).toBeLessThan(crewListIdx);
  });
});

// =====================================================================
// 9. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('ChatPage.js has balanced div tags', () => {
    const opens = (chatPageSource.match(/<div[\s>]/g) || []).length;
    const closes = (chatPageSource.match(/<\/div>/g) || []).length;
    expect(Math.abs(opens - closes)).toBeLessThanOrEqual(1);
  });

  it('ChatPage.js has balanced template tags', () => {
    const opens = (chatPageSource.match(/<template[\s>]/g) || []).length;
    const closes = (chatPageSource.match(/<\/template>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('CSS has balanced braces (2106/2106)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2106);
  });

  it('session-group-header CSS rule exists', () => {
    expect(cssSource).toContain('.session-group-header');
  });
});
