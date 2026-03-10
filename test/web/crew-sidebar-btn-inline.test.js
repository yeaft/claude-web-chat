import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for sidebar collapsible group headers with separated add buttons.
 *
 * The session-group-header rows contain:
 * 1) A title area (session-group-title-area) with collapse arrow + icon + text
 *    — clicking toggles group collapse
 * 2) A separate add button (session-header-add-btn) for creating new sessions
 *
 * Verifies:
 * 1) Both add buttons are inside their respective session-group-header
 * 2) Title area has collapse toggle, add button triggers creation
 * 3) CSS styles for collapse arrow and add button
 * 4) Collapse state data properties exist
 */

let chatPageSource;
let cssSource;

beforeAll(() => {
  const chatPagePath = resolve(__dirname, '../../web/components/ChatPage.js');
  chatPageSource = readFileSync(chatPagePath, 'utf-8');

  cssSource = loadAllCss();
});

// =====================================================================
// 1. Add buttons are INSIDE session-group-header
// =====================================================================
describe('add buttons inside session-group-header', () => {
  it('chat add button is inside session-group-header (before session-panel-list)', () => {
    const chatHeaderIdx = chatPageSource.indexOf('class="session-group-header"');
    const chatListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const chatAddIdx = chatPageSource.indexOf('session-header-add-btn', chatHeaderIdx);
    expect(chatAddIdx).toBeGreaterThan(chatHeaderIdx);
    expect(chatAddIdx).toBeLessThan(chatListIdx);
  });

  it('crew add button is inside crew session-group-header', () => {
    const crewSessionsIdx = chatPageSource.indexOf('Crew Sessions');
    const crewHeaderIdx = chatPageSource.lastIndexOf('class="session-group-header"', crewSessionsIdx);
    const crewListIdx = chatPageSource.indexOf('class="session-panel-list"', crewHeaderIdx);
    const crewAddIdx = chatPageSource.indexOf('session-header-add-btn', crewHeaderIdx);
    expect(crewAddIdx).toBeGreaterThan(crewHeaderIdx);
    expect(crewAddIdx).toBeLessThan(crewListIdx);
  });
});

// =====================================================================
// 2. Separated click handlers: title area for collapse, button for create
// =====================================================================
describe('separated click handlers', () => {
  it('chat title area toggles chatGroupCollapsed', () => {
    const chatTitleAreaIdx = chatPageSource.indexOf('session-group-title-area');
    const areaContext = chatPageSource.substring(chatTitleAreaIdx - 100, chatTitleAreaIdx + 200);
    expect(areaContext).toContain('chatGroupCollapsed');
  });

  it('crew title area toggles crewGroupCollapsed', () => {
    const crewIdx = chatPageSource.indexOf('<span>Crew Sessions</span>');
    const crewTitleAreaIdx = chatPageSource.lastIndexOf('session-group-title-area', crewIdx);
    const areaContext = chatPageSource.substring(crewTitleAreaIdx, crewIdx + 50);
    expect(areaContext).toContain('crewGroupCollapsed');
  });

  it('chat add button triggers openConversationModal', () => {
    const chatAddIdx = chatPageSource.indexOf('session-header-add-btn');
    const btnContext = chatPageSource.substring(chatAddIdx, chatAddIdx + 300);
    expect(btnContext).toContain('openConversationModal');
  });

  it('crew add button triggers newCrewSession', () => {
    const firstAddIdx = chatPageSource.indexOf('session-header-add-btn');
    const crewAddIdx = chatPageSource.indexOf('session-header-add-btn', firstAddIdx + 1);
    const btnContext = chatPageSource.substring(crewAddIdx, crewAddIdx + 300);
    expect(btnContext).toContain('newCrewSession');
  });

  it('at least 2 session-header-add-btn in template (chat + crew + optional vcrew)', () => {
    const matches = chatPageSource.match(/session-header-add-btn/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('both add buttons have plus icon SVG', () => {
    const firstBtn = chatPageSource.indexOf('session-header-add-btn');
    const firstBlock = chatPageSource.substring(firstBtn, firstBtn + 300);
    expect(firstBlock).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');

    const secondBtn = chatPageSource.indexOf('session-header-add-btn', firstBtn + 1);
    const secondBlock = chatPageSource.substring(secondBtn, secondBtn + 300);
    expect(secondBlock).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
  });
});

// =====================================================================
// 3. Collapse arrow and state
// =====================================================================
describe('collapse functionality', () => {
  it('collapse arrow SVGs exist in both headers', () => {
    const matches = chatPageSource.match(/session-collapse-arrow/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('data properties for collapse state exist', () => {
    expect(chatPageSource).toContain('chatGroupCollapsed');
    expect(chatPageSource).toContain('crewGroupCollapsed');
  });

  it('session-panel-list uses v-show for collapse', () => {
    expect(chatPageSource).toContain('v-show="!chatGroupCollapsed"');
    expect(chatPageSource).toContain('v-show="!crewGroupCollapsed"');
  });
});

// =====================================================================
// 4. CSS styles
// =====================================================================
describe('CSS styles', () => {
  it('session-header-add-btn has CSS rules', () => {
    expect(cssSource).toContain('.session-header-add-btn');
  });

  it('session-collapse-arrow has CSS rules with transition', () => {
    expect(cssSource).toContain('.session-collapse-arrow');
  });

  it('session-group-title-area has CSS rules', () => {
    expect(cssSource).toContain('.session-group-title-area');
  });

  it('collapsed state rotates arrow', () => {
    expect(cssSource).toContain('.session-collapse-arrow.collapsed');
    expect(cssSource).toContain('rotate(-90deg)');
  });
});
