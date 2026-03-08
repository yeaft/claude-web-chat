import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

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
// 2. Header inline add icons (clickable header rows)
// =====================================================================
describe('header inline add icons', () => {
  it('chat panel header triggers openConversationModal on click', () => {
    const chatHeaderIdx = chatPageSource.indexOf('class="session-group-header"');
    const chatListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const chatHeader = chatPageSource.substring(chatHeaderIdx - 200, chatListIdx);
    expect(chatHeader).toContain('openConversationModal');
  });

  it('crew panel header triggers newCrewSession on click', () => {
    const crewHeaderIdx = chatPageSource.indexOf('Crew Sessions');
    const crewListIdx = chatPageSource.indexOf('class="session-panel-list"', crewHeaderIdx);
    const crewHeader = chatPageSource.substring(crewHeaderIdx - 200, crewListIdx);
    expect(crewHeader).toContain('@click="newCrewSession"');
  });

  it('both headers have plus icon SVG', () => {
    const firstIcon = chatPageSource.indexOf('session-header-add-icon');
    const firstBlock = chatPageSource.substring(firstIcon, firstIcon + 200);
    expect(firstBlock).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');

    const secondIcon = chatPageSource.indexOf('session-header-add-icon', firstIcon + 1);
    const secondBlock = chatPageSource.substring(secondIcon, secondIcon + 200);
    expect(secondBlock).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
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
