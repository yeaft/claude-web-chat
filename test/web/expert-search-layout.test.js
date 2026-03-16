import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for ExpertPanel search box layout change (task-84, PR #245).
 *
 * Validates:
 * 1. Search box is a separate row below team tabs, above role list (not inside header)
 * 2. Header contains only title + close button; title left-aligned, close right-aligned
 * 3. No border dividers between header / team tabs / search / role list
 * 4. Search box is block-level (not inline flex child)
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

function extractCssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'm');
  const match = css.match(regex);
  return match ? match[1] : null;
}

function hasProp(rule, prop, val) {
  if (!rule) return false;
  const regex = new RegExp(`${prop}\\s*:\\s*${val}`);
  return regex.test(rule.replace(/\s+/g, ' '));
}

// =====================================================================
// 1. Template structure: search box placement
// =====================================================================
describe('Search box placement in template', () => {
  const template = read('web/components/ExpertPanel.js');

  it('search box is NOT inside .expert-panel-header', () => {
    // Extract the header block content
    const headerStart = template.indexOf('class="expert-panel-header"');
    expect(headerStart).toBeGreaterThan(-1);

    // Find the closing </div> for the header (next </div> after header start)
    const afterHeader = template.indexOf('</div>', headerStart);
    const headerContent = template.slice(headerStart, afterHeader);

    expect(headerContent).not.toContain('expert-panel-search');
    expect(headerContent).not.toContain('expert-search-input');
  });

  it('header contains title and close button only', () => {
    const headerStart = template.indexOf('class="expert-panel-header"');
    const afterHeader = template.indexOf('</div>', headerStart);
    const headerContent = template.slice(headerStart, afterHeader);

    expect(headerContent).toContain('expert-panel-title');
    expect(headerContent).toContain('expert-panel-close');
  });

  it('search box appears after team tabs and before role list', () => {
    const teamTabsPos = template.indexOf('class="expert-team-tabs"');
    const searchPos = template.indexOf('class="expert-panel-search"');
    const roleListPos = template.indexOf('class="expert-role-list"');

    expect(teamTabsPos).toBeGreaterThan(-1);
    expect(searchPos).toBeGreaterThan(-1);
    expect(roleListPos).toBeGreaterThan(-1);

    // Order: team-tabs → search → role-list
    expect(searchPos).toBeGreaterThan(teamTabsPos);
    expect(roleListPos).toBeGreaterThan(searchPos);
  });

  it('layout order is: header → team-tabs → search → role-list', () => {
    const headerPos = template.indexOf('class="expert-panel-header"');
    const teamTabsPos = template.indexOf('class="expert-team-tabs"');
    const searchPos = template.indexOf('class="expert-panel-search"');
    const roleListPos = template.indexOf('class="expert-role-list"');

    expect(headerPos).toBeLessThan(teamTabsPos);
    expect(teamTabsPos).toBeLessThan(searchPos);
    expect(searchPos).toBeLessThan(roleListPos);
  });
});

// =====================================================================
// 2. CSS: header title pushes close button to the right
// =====================================================================
describe('Header layout: title left, close right', () => {
  const css = read('web/styles/expert-panel.css');

  it('.expert-panel-header is flex row', () => {
    const rule = extractCssRule(css, '.expert-panel-header');
    expect(hasProp(rule, 'display', 'flex')).toBe(true);
  });

  it('.expert-panel-title has flex: 1 to fill space and push close button right', () => {
    const rule = extractCssRule(css, '.expert-panel-title');
    expect(hasProp(rule, 'flex', '1')).toBe(true);
  });
});

// =====================================================================
// 3. CSS: no border dividers between sections
// =====================================================================
describe('No border dividers between sections', () => {
  const css = read('web/styles/expert-panel.css');

  it('.expert-panel-header has no border-bottom', () => {
    const rule = extractCssRule(css, '.expert-panel-header');
    // Rule should NOT have border-bottom
    if (rule) {
      expect(rule).not.toMatch(/border-bottom/);
    }
  });

  it('.expert-team-tabs has no border-top or border-bottom', () => {
    const rule = extractCssRule(css, '.expert-team-tabs');
    if (rule) {
      expect(rule).not.toMatch(/border-top/);
      expect(rule).not.toMatch(/border-bottom/);
    }
  });

  it('.expert-panel-search has no border-top or border-bottom', () => {
    const rule = extractCssRule(css, '.expert-panel-search');
    if (rule) {
      expect(rule).not.toMatch(/border-top/);
      expect(rule).not.toMatch(/border-bottom/);
    }
  });
});

// =====================================================================
// 4. CSS: search box is block-level (not inline flex)
// =====================================================================
describe('Search box is block-level independent row', () => {
  const css = read('web/styles/expert-panel.css');

  it('.expert-panel-search does NOT have flex: 1 (no longer inline flex child)', () => {
    const rule = extractCssRule(css, '.expert-panel-search');
    // Should not have flex: 1 since it's no longer an inline flex child
    expect(rule).not.toMatch(/flex:\s*1/);
  });

  it('.expert-panel-search does NOT have min-width: 0 (no longer inline flex)', () => {
    const rule = extractCssRule(css, '.expert-panel-search');
    expect(rule).not.toMatch(/min-width:\s*0/);
  });

  it('.expert-panel-search has horizontal spacing for alignment', () => {
    const rule = extractCssRule(css, '.expert-panel-search');
    // Should have margin or padding to align with header content
    expect(rule).toMatch(/margin|padding/);
  });

  it('.expert-panel-search has flex-shrink: 0 (fixed height, not collapsible)', () => {
    const rule = extractCssRule(css, '.expert-panel-search');
    expect(hasProp(rule, 'flex-shrink', '0')).toBe(true);
  });

  it('.expert-panel-search uses margin (not padding) so absolute-positioned icons stay inside input', () => {
    const rule = extractCssRule(css, '.expert-panel-search');
    // margin doesn't affect the padding box, so absolute-positioned children
    // (search icon, clear button) with right: Xpx stay relative to the element edge
    expect(rule).toMatch(/margin/);
    expect(rule).not.toMatch(/padding/);
  });

  it('.expert-panel-search has position: relative for icon positioning', () => {
    const rule = extractCssRule(css, '.expert-panel-search');
    expect(hasProp(rule, 'position', 'relative')).toBe(true);
  });
});
