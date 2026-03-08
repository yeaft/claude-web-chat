import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for sidebar clickable group headers.
 *
 * The session-group-header rows are fully clickable to create new
 * conversations. A "+" icon (session-header-add-icon) is right-aligned
 * as a visual hint.
 *
 * Verifies:
 * 1) Both add icons are inside their respective session-group-header
 * 2) Click handlers are on the header div, not on a separate button
 * 3) CSS styles for header add icon
 * 4) Old layout patterns removed
 * 5) Structural integrity
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
// 1. Add icons are INSIDE session-group-header
// =====================================================================
describe('add icons inside session-group-header', () => {
  it('chat add icon is inside session-group-header (before session-panel-list)', () => {
    const chatHeaderIdx = chatPageSource.indexOf('class="session-group-header"');
    const chatListIdx = chatPageSource.indexOf('class="session-panel-list"');
    const chatAddIdx = chatPageSource.indexOf('session-header-add-icon', chatHeaderIdx);
    expect(chatAddIdx).toBeGreaterThan(chatHeaderIdx);
    expect(chatAddIdx).toBeLessThan(chatListIdx);
  });

  it('crew add icon is inside crew session-group-header', () => {
    const crewSessionsIdx = chatPageSource.indexOf('Crew Sessions');
    const crewHeaderIdx = chatPageSource.lastIndexOf('class="session-group-header"', crewSessionsIdx);
    const crewListIdx = chatPageSource.indexOf('class="session-panel-list"', crewHeaderIdx);
    const crewAddIdx = chatPageSource.indexOf('session-header-add-icon', crewHeaderIdx);
    expect(crewAddIdx).toBeGreaterThan(crewHeaderIdx);
    expect(crewAddIdx).toBeLessThan(crewListIdx);
  });

  it('add icons are in headers, not in list v-for content', () => {
    const firstIcon = chatPageSource.indexOf('session-header-add-icon');
    const firstListStart = chatPageSource.indexOf('class="session-panel-list"');
    expect(firstIcon).toBeLessThan(firstListStart);

    const secondIcon = chatPageSource.indexOf('session-header-add-icon', firstIcon + 1);
    const secondListStart = chatPageSource.indexOf('class="session-panel-list"', firstListStart + 1);
    expect(secondIcon).toBeLessThan(secondListStart);
  });
});

// =====================================================================
// 2. Click handlers on header row (not separate button)
// =====================================================================
describe('clickable header rows', () => {
  it('chat header triggers openConversationModal on click', () => {
    const chatHeaderIdx = chatPageSource.indexOf('class="session-group-header"');
    const headerLine = chatPageSource.substring(chatHeaderIdx - 200, chatHeaderIdx + 200);
    expect(headerLine).toContain('openConversationModal');
  });

  it('crew header triggers newCrewSession on click', () => {
    const crewSpanIdx = chatPageSource.indexOf('<span>Crew Sessions</span>');
    const divStart = chatPageSource.lastIndexOf('<div', crewSpanIdx);
    const headerLine = chatPageSource.substring(divStart, crewSpanIdx);
    expect(headerLine).toContain('@click="newCrewSession"');
  });

  it('both headers have plus icon SVG', () => {
    const firstIcon = chatPageSource.indexOf('session-header-add-icon');
    const firstBlock = chatPageSource.substring(firstIcon, firstIcon + 200);
    expect(firstBlock).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');

    const secondIcon = chatPageSource.indexOf('session-header-add-icon', firstIcon + 1);
    const secondBlock = chatPageSource.substring(secondIcon, secondIcon + 200);
    expect(secondBlock).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
  });

  it('exactly 2 session-header-add-icon in template', () => {
    const matches = chatPageSource.match(/session-header-add-icon/g) || [];
    expect(matches.length).toBe(2);
  });

  it('no separate add button elements (click is on header)', () => {
    expect(chatPageSource).not.toContain('session-header-add-btn');
  });
});
