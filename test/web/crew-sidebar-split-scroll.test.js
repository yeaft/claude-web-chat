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
    const panelsEnd = chatPageSource.indexOf('</div>', chatPageSource.indexOf('session-panel-add-btn crew-add-btn'));
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
// 2. Bottom inline add buttons
// =====================================================================
describe('bottom inline add buttons', () => {
  it('chat panel has add button with openConversationModal', () => {
    const normalIdx = chatPageSource.indexOf('v-for="conv in normalConversations"');
    const dividerIdx = chatPageSource.indexOf('session-panel-divider');
    const chatPanel = chatPageSource.substring(normalIdx, dividerIdx);
    expect(chatPanel).toContain('session-panel-add-btn');
    expect(chatPanel).toContain('@click="openConversationModal"');
  });

  it('chat add button is disabled when no agents online', () => {
    const normalIdx = chatPageSource.indexOf('v-for="conv in normalConversations"');
    const dividerIdx = chatPageSource.indexOf('session-panel-divider');
    const chatPanel = chatPageSource.substring(normalIdx, dividerIdx);
    expect(chatPanel).toContain(':disabled="onlineAgentCount === 0"');
  });

  it('chat add button shows i18n newConv label', () => {
    const normalIdx = chatPageSource.indexOf('v-for="conv in normalConversations"');
    const dividerIdx = chatPageSource.indexOf('session-panel-divider');
    const chatPanel = chatPageSource.substring(normalIdx, dividerIdx);
    expect(chatPanel).toContain("$t('chat.sidebar.newConv')");
  });

  it('crew panel has add button with newCrewSession', () => {
    const crewIdx = chatPageSource.indexOf('v-for="conv in crewConversations"');
    const crewPanel = chatPageSource.substring(crewIdx, crewIdx + 2500);
    expect(crewPanel).toContain('session-panel-add-btn');
    expect(crewPanel).toContain('@click="newCrewSession"');
  });

  it('crew add button has crew-add-btn modifier class', () => {
    expect(chatPageSource).toContain('class="session-panel-add-btn crew-add-btn"');
  });

  it('crew add button shows "Crew" label', () => {
    const crewAddIdx = chatPageSource.indexOf('session-panel-add-btn crew-add-btn');
    const crewAddBlock = chatPageSource.substring(crewAddIdx, crewAddIdx + 400);
    expect(crewAddBlock).toContain('<span>Crew</span>');
  });

  it('add buttons appear after their respective session-panel-list', () => {
    // Chat add button after chat panel list
    const chatListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const chatAddIdx = chatPageSource.indexOf('session-panel-add-btn');
    expect(chatAddIdx).toBeGreaterThan(chatListIdx);

    // Crew add button after crew panel list
    const crewListIdx = chatPageSource.indexOf('class="session-panel-list"', chatListIdx + 1);
    const crewAddIdx = chatPageSource.indexOf('session-panel-add-btn crew-add-btn');
    expect(crewAddIdx).toBeGreaterThan(crewListIdx);
  });

  it('both add buttons have plus icon SVG', () => {
    // Find both add buttons
    const firstAddIdx = chatPageSource.indexOf('session-panel-add-btn');
    const secondAddIdx = chatPageSource.indexOf('session-panel-add-btn', firstAddIdx + 1);
    const firstBtn = chatPageSource.substring(firstAddIdx, firstAddIdx + 400);
    const secondBtn = chatPageSource.substring(secondAddIdx, secondAddIdx + 400);
    // Plus icon path
    expect(firstBtn).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
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
// 5. Panel divider
// =====================================================================
describe('panel divider between chat and crew panels', () => {
  it('panel divider exists in template', () => {
    expect(chatPageSource).toContain('class="session-panel-divider"');
  });

  it('divider is between the two session-panel containers', () => {
    const firstPanelEnd = chatPageSource.indexOf('session-panel-add-btn');
    const dividerIdx = chatPageSource.indexOf('session-panel-divider');
    const secondPanelStart = chatPageSource.indexOf('class="session-panel"', dividerIdx);
    expect(dividerIdx).toBeGreaterThan(firstPanelEnd);
    expect(secondPanelStart).toBeGreaterThan(dividerIdx);
  });

  it('divider has 1px height', () => {
    const block = extractCssBlock('.session-panel-divider {');
    expect(block).toContain('height: 1px');
  });

  it('divider uses border-color variable', () => {
    const block = extractCssBlock('.session-panel-divider {');
    expect(block).toContain('var(--border-color)');
  });

  it('divider has horizontal margin', () => {
    const block = extractCssBlock('.session-panel-divider {');
    expect(block).toContain('margin: 0 12px');
  });

  it('divider does not shrink', () => {
    const block = extractCssBlock('.session-panel-divider {');
    expect(block).toContain('flex-shrink: 0');
  });
});

// =====================================================================
// 6. CSS styles for add buttons
// =====================================================================
describe('CSS — session-panel-add-btn styles', () => {
  it('add button uses dashed border', () => {
    const block = extractCssBlock('.session-panel-add-btn {');
    expect(block).toContain('border: 1.5px dashed var(--border-color)');
  });

  it('add button uses flexbox for centered content', () => {
    const block = extractCssBlock('.session-panel-add-btn {');
    expect(block).toContain('display: flex');
    expect(block).toContain('align-items: center');
    expect(block).toContain('justify-content: center');
  });

  it('add button has gap between icon and text', () => {
    const block = extractCssBlock('.session-panel-add-btn {');
    expect(block).toContain('gap: 8px');
  });

  it('add button has border-radius: 10px', () => {
    const block = extractCssBlock('.session-panel-add-btn {');
    expect(block).toContain('border-radius: 10px');
  });

  it('add button has transparent background', () => {
    const block = extractCssBlock('.session-panel-add-btn {');
    expect(block).toContain('background: transparent');
  });

  it('add button uses secondary text color', () => {
    const block = extractCssBlock('.session-panel-add-btn {');
    expect(block).toContain('color: var(--text-secondary)');
  });

  it('add button does not shrink in flex layout', () => {
    const block = extractCssBlock('.session-panel-add-btn {');
    expect(block).toContain('flex-shrink: 0');
  });

  it('add button hover changes background and text', () => {
    const block = extractCssBlock('.session-panel-add-btn:hover {');
    expect(block).toContain('background: var(--sidebar-hover)');
    expect(block).toContain('color: var(--text-primary)');
  });

  it('add button disabled state has reduced opacity', () => {
    const block = extractCssBlock('.session-panel-add-btn:disabled {');
    expect(block).toContain('opacity: 0.4');
    expect(block).toContain('cursor: not-allowed');
  });

  it('add button SVG has fixed size', () => {
    const block = extractCssBlock('.session-panel-add-btn svg {');
    expect(block).toContain('width: 18px');
    expect(block).toContain('height: 18px');
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
    const dividerIdx = chatPageSource.indexOf('session-panel-divider');
    const secondPanelIdx = chatPageSource.indexOf('class="session-panel"', dividerIdx);
    const secondListIdx = chatPageSource.indexOf('class="session-panel-list"', dividerIdx);
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
    const dividerIdx = chatPageSource.indexOf('session-panel-divider');
    const secondPanelIdx = chatPageSource.indexOf('class="session-panel"', dividerIdx);
    const secondListIdx = chatPageSource.indexOf('class="session-panel-list"', dividerIdx);
    const headerBlock = chatPageSource.substring(secondPanelIdx, secondListIdx);
    expect(headerBlock).toContain('session-group-icon');
    // People icon path
    expect(headerBlock).toContain('M16 11c1.66');
  });

  it('chat header uses i18n recentChats', () => {
    const firstPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const firstListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const headerBlock = chatPageSource.substring(firstPanelIdx, firstListIdx);
    expect(headerBlock).toContain("$t('chat.sidebar.recentChats')");
  });

  it('crew header shows "Crew Sessions" text', () => {
    const dividerIdx = chatPageSource.indexOf('session-panel-divider');
    const secondPanelIdx = chatPageSource.indexOf('class="session-panel"', dividerIdx);
    const secondListIdx = chatPageSource.indexOf('class="session-panel-list"', dividerIdx);
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

  it('panel structure: header → list → add-button for each panel', () => {
    // Chat panel
    const chatPanelIdx = chatPageSource.indexOf('class="session-panel"');
    const chatHeaderIdx = chatPageSource.indexOf('session-group-header', chatPanelIdx);
    const chatListIdx = chatPageSource.indexOf('session-panel-list', chatPanelIdx);
    const chatAddIdx = chatPageSource.indexOf('session-panel-add-btn', chatPanelIdx);
    expect(chatHeaderIdx).toBeLessThan(chatListIdx);
    expect(chatListIdx).toBeLessThan(chatAddIdx);

    // Crew panel
    const dividerIdx = chatPageSource.indexOf('session-panel-divider');
    const crewPanelIdx = chatPageSource.indexOf('class="session-panel"', dividerIdx);
    const crewHeaderIdx = chatPageSource.indexOf('session-group-header', crewPanelIdx);
    const crewListIdx = chatPageSource.indexOf('session-panel-list', crewPanelIdx);
    const crewAddIdx = chatPageSource.indexOf('session-panel-add-btn', crewPanelIdx);
    expect(crewHeaderIdx).toBeLessThan(crewListIdx);
    expect(crewListIdx).toBeLessThan(crewAddIdx);
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

  it('CSS has balanced braces (2151/2151)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2151);
  });

  it('session-group-header CSS rule exists', () => {
    expect(cssSource).toContain('.session-group-header');
  });
});
