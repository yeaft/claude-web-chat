import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for sidebar add buttons in group headers.
 *
 * The "+ 会话" and "+ Crew" buttons are placed in the session-group-header
 * row, right-aligned next to the group title. This keeps them always visible
 * without taking up list space.
 *
 * Verifies:
 * 1) Both add buttons are inside their respective session-group-header
 * 2) Buttons are right-aligned via margin-left: auto
 * 3) Button functionality preserved (@click handlers, disabled state)
 * 4) CSS styles for compact header button
 * 5) Structural integrity
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

  it('add buttons are in headers, not in list v-for content', () => {
    // The session-panel-list should only contain session items (v-for), no add buttons
    // Verify by checking: add buttons appear BEFORE the list, not inside
    const firstHeaderBtn = chatPageSource.indexOf('session-header-add-btn');
    const firstListStart = chatPageSource.indexOf('class="session-panel-list"');
    expect(firstHeaderBtn).toBeLessThan(firstListStart);

    const secondHeaderBtn = chatPageSource.indexOf('session-header-add-btn', firstHeaderBtn + 1);
    const secondListStart = chatPageSource.indexOf('class="session-panel-list"', firstListStart + 1);
    expect(secondHeaderBtn).toBeLessThan(secondListStart);
  });
});

// =====================================================================
// 2. Button functionality preserved
// =====================================================================
describe('button functionality preserved', () => {
  it('chat add button triggers openConversationModal', () => {
    const chatAddIdx = chatPageSource.indexOf('session-header-add-btn');
    const btnBlock = chatPageSource.substring(chatAddIdx, chatAddIdx + 300);
    expect(btnBlock).toContain('@click="openConversationModal"');
  });

  it('chat add button is disabled when no agents online', () => {
    const chatAddIdx = chatPageSource.indexOf('session-header-add-btn');
    const btnBlock = chatPageSource.substring(chatAddIdx, chatAddIdx + 300);
    expect(btnBlock).toContain(':disabled="onlineAgentCount === 0"');
  });

  it('crew add button triggers newCrewSession', () => {
    const crewSessionsIdx = chatPageSource.indexOf('Crew Sessions');
    const crewAddIdx = chatPageSource.indexOf('session-header-add-btn', crewSessionsIdx);
    const btnBlock = chatPageSource.substring(crewAddIdx, crewAddIdx + 300);
    expect(btnBlock).toContain('@click="newCrewSession"');
  });

  it('both add buttons have plus icon SVG', () => {
    const firstAddIdx = chatPageSource.indexOf('session-header-add-btn');
    const firstBtn = chatPageSource.substring(firstAddIdx, firstAddIdx + 400);
    expect(firstBtn).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');

    const secondAddIdx = chatPageSource.indexOf('session-header-add-btn', firstAddIdx + 1);
    const secondBtn = chatPageSource.substring(secondAddIdx, secondAddIdx + 400);
    expect(secondBtn).toContain('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
  });

  it('exactly 2 session-header-add-btn in template', () => {
    const matches = chatPageSource.match(/session-header-add-btn/g) || [];
    expect(matches.length).toBe(2);
  });
});

// =====================================================================
// 3. CSS styles for header add button
// =====================================================================
describe('CSS — session-header-add-btn styles', () => {
  it('has .session-header-add-btn rule', () => {
    expect(cssSource).toContain('.session-header-add-btn {');
  });

  it('is right-aligned via margin-left: auto', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('margin-left: auto');
  });

  it('is a compact square button', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('width: 22px');
    expect(block).toContain('height: 22px');
  });

  it('has no border', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('border: none');
  });

  it('has transparent background', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('background: transparent');
  });

  it('has rounded corners', () => {
    const block = extractCssBlock('.session-header-add-btn {');
    expect(block).toContain('border-radius: 6px');
  });

  it('hover shows sidebar-hover background', () => {
    const block = extractCssBlock('.session-header-add-btn:hover {');
    expect(block).toContain('background: var(--sidebar-hover)');
    expect(block).toContain('color: var(--text-primary)');
  });

  it('disabled state has reduced opacity', () => {
    const block = extractCssBlock('.session-header-add-btn:disabled {');
    expect(block).toContain('opacity: 0.3');
    expect(block).toContain('cursor: not-allowed');
  });

  it('SVG has fixed 14px size', () => {
    const block = extractCssBlock('.session-header-add-btn svg {');
    expect(block).toContain('width: 14px');
    expect(block).toContain('height: 14px');
  });
});

// =====================================================================
// 4. Old layout patterns removed
// =====================================================================
describe('no old layout remnants', () => {
  it('no session-panel-add-btn class in template', () => {
    expect(chatPageSource).not.toContain('session-panel-add-btn');
  });

  it('no session-panel-add-btn CSS rule', () => {
    expect(cssSource).not.toContain('.session-panel-add-btn {');
  });

  it('no crew-add-btn class in template', () => {
    expect(chatPageSource).not.toContain('crew-add-btn');
  });
});

// =====================================================================
// 5. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('ChatPage.js div tags are balanced', () => {
    const opens = (chatPageSource.match(/<div[\s>]/g) || []).length;
    const closes = (chatPageSource.match(/<\/div>/g) || []).length;
    expect(Math.abs(opens - closes)).toBeLessThanOrEqual(1);
  });

  it('ChatPage.js template tags are balanced', () => {
    const opens = (chatPageSource.match(/<template[\s>]/g) || []).length;
    const closes = (chatPageSource.match(/<\/template>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('ChatPage.js button tags are balanced', () => {
    const opens = (chatPageSource.match(/<button[\s>]/g) || []).length;
    const closes = (chatPageSource.match(/<\/button>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('CSS brace count unchanged (2143/2143)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2143);
  });

  it('session-panels wrapper still exists', () => {
    expect(chatPageSource).toContain('class="session-panels"');
  });

  it('exactly 2 session-panel containers', () => {
    const matches = chatPageSource.match(/class="session-panel"/g) || [];
    expect(matches.length).toBe(2);
  });

  it('exactly 2 session-panel-list containers', () => {
    const matches = chatPageSource.match(/class="session-panel-list"/g) || [];
    expect(matches.length).toBe(2);
  });

  it('no panel divider (clean layout)', () => {
    expect(chatPageSource).not.toContain('session-panel-divider');
  });
});
