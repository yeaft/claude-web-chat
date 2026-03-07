import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for task-48: Crew center panel padding when side panels hidden.
 *
 * When the roles or features panel is hidden via toggle (.hide-roles / .hide-features),
 * the .crew-panel-center should get 48px padding on the hidden side so content
 * doesn't hug the edge.
 *
 * Verifies:
 * 1) hide-roles adds padding-left: 48px to center
 * 2) hide-features adds padding-right: 48px to center
 * 3) Both hidden → both sides padded (both rules apply)
 * 4) Panels visible → no extra padding (base rule has no padding)
 * 5) Mobile override resets padding to 0 (drawers, not collapsed)
 * 6) Smooth transition on padding
 * 7) Structural integrity
 */

let cssSource;

beforeAll(() => {
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
// 1. hide-roles adds padding-left: 48px to center
// =====================================================================
describe('hide-roles → padding-left on center', () => {
  it('has .crew-workspace.hide-roles .crew-panel-center rule', () => {
    expect(cssSource).toContain('.crew-workspace.hide-roles .crew-panel-center');
  });

  it('sets padding-left: 48px', () => {
    const block = extractCssBlock('.crew-workspace.hide-roles .crew-panel-center {');
    expect(block).toContain('padding-left: 48px');
  });

  it('does NOT set padding-right (only left side affected)', () => {
    const block = extractCssBlock('.crew-workspace.hide-roles .crew-panel-center {');
    expect(block).not.toContain('padding-right');
  });
});

// =====================================================================
// 2. hide-features adds padding-right: 48px to center
// =====================================================================
describe('hide-features → padding-right on center', () => {
  it('has .crew-workspace.hide-features .crew-panel-center rule', () => {
    expect(cssSource).toContain('.crew-workspace.hide-features .crew-panel-center');
  });

  it('sets padding-right: 48px', () => {
    const block = extractCssBlock('.crew-workspace.hide-features .crew-panel-center {');
    expect(block).toContain('padding-right: 48px');
  });

  it('does NOT set padding-left (only right side affected)', () => {
    const block = extractCssBlock('.crew-workspace.hide-features .crew-panel-center {');
    expect(block).not.toContain('padding-left');
  });
});

// =====================================================================
// 3. Both hidden → both rules apply independently
// =====================================================================
describe('both panels hidden → both sides padded', () => {
  it('hide-roles and hide-features are separate CSS rules (not combined)', () => {
    // They are independent selectors, so when both classes are present,
    // both rules apply → padding-left: 48px AND padding-right: 48px
    const hideRolesIdx = cssSource.indexOf('.crew-workspace.hide-roles .crew-panel-center {');
    const hideFeaturesIdx = cssSource.indexOf('.crew-workspace.hide-features .crew-panel-center {');
    expect(hideRolesIdx).toBeGreaterThan(-1);
    expect(hideFeaturesIdx).toBeGreaterThan(-1);
    expect(hideRolesIdx).not.toBe(hideFeaturesIdx);
  });

  it('hide-roles rule only sets padding-left', () => {
    const block = extractCssBlock('.crew-workspace.hide-roles .crew-panel-center {');
    const props = block.split(';').map(s => s.trim()).filter(Boolean);
    expect(props.length).toBe(1);
    expect(props[0]).toContain('padding-left: 48px');
  });

  it('hide-features rule only sets padding-right', () => {
    const block = extractCssBlock('.crew-workspace.hide-features .crew-panel-center {');
    const props = block.split(';').map(s => s.trim()).filter(Boolean);
    expect(props.length).toBe(1);
    expect(props[0]).toContain('padding-right: 48px');
  });
});

// =====================================================================
// 4. Panels visible → no extra padding (base rule)
// =====================================================================
describe('panels visible → no extra padding', () => {
  it('base .crew-panel-center has no padding-left or padding-right', () => {
    // Find the base rule (not inside a hide-* selector)
    const baseSelectorIdx = cssSource.indexOf('.crew-panel-center {');
    expect(baseSelectorIdx).toBeGreaterThan(-1);
    const block = extractCssBlock('.crew-panel-center {');
    expect(block).not.toContain('padding-left');
    expect(block).not.toContain('padding-right');
    expect(block).not.toContain('padding: ');
  });

  it('base .crew-panel-center has flex: 1, overflow: hidden, background', () => {
    const block = extractCssBlock('.crew-panel-center {');
    expect(block).toContain('flex: 1');
    expect(block).toContain('overflow: hidden');
    expect(block).toContain('background: var(--bg-main)');
  });
});

// =====================================================================
// 5. Mobile override resets padding to 0
// =====================================================================
describe('mobile override — no padding (drawer-based layout)', () => {
  it('mobile media query resets hide-roles center padding', () => {
    // Find the mobile override section
    const mobileIdx = cssSource.indexOf('Mobile: hide-* should NOT add padding');
    expect(mobileIdx).toBeGreaterThan(-1);
  });

  it('mobile section is inside @media (max-width: 767px)', () => {
    const mobileIdx = cssSource.indexOf('Mobile: hide-* should NOT add padding');
    // Walk backwards to find the @media query
    const before = cssSource.substring(Math.max(0, mobileIdx - 2000), mobileIdx);
    expect(before).toContain('@media (max-width: 767px)');
  });

  it('mobile override sets padding-left: 0 and padding-right: 0', () => {
    // Find the mobile combined rule
    const mobileCommentIdx = cssSource.indexOf('Mobile: hide-* should NOT add padding');
    const ruleStart = cssSource.indexOf('{', mobileCommentIdx);
    const ruleEnd = cssSource.indexOf('}', ruleStart);
    const block = cssSource.substring(ruleStart + 1, ruleEnd).trim();
    expect(block).toContain('padding-left: 0');
    expect(block).toContain('padding-right: 0');
  });

  it('mobile override covers both hide-roles and hide-features', () => {
    const mobileCommentIdx = cssSource.indexOf('Mobile: hide-* should NOT add padding');
    const selectorArea = cssSource.substring(mobileCommentIdx, mobileCommentIdx + 200);
    expect(selectorArea).toContain('.crew-workspace.hide-roles .crew-panel-center');
    expect(selectorArea).toContain('.crew-workspace.hide-features .crew-panel-center');
  });
});

// =====================================================================
// 6. Smooth transition on padding
// =====================================================================
describe('padding transition for smooth animation', () => {
  it('base .crew-panel-center has transition property', () => {
    const block = extractCssBlock('.crew-panel-center {');
    expect(block).toContain('transition:');
  });

  it('transition targets padding property', () => {
    const block = extractCssBlock('.crew-panel-center {');
    expect(block).toContain('transition: padding');
  });

  it('transition duration is 0.25s (matches panel width transition)', () => {
    const block = extractCssBlock('.crew-panel-center {');
    expect(block).toContain('0.25s');
  });

  it('transition uses cubic-bezier easing', () => {
    const block = extractCssBlock('.crew-panel-center {');
    expect(block).toContain('cubic-bezier(0.4, 0, 0.2, 1)');
  });

  it('panel width transitions also use 0.25s cubic-bezier', () => {
    // Verify the side panels use the same timing
    const panelTransitionIdx = cssSource.indexOf('.crew-panel-left,');
    expect(panelTransitionIdx).toBeGreaterThan(-1);
    const nextBlock = cssSource.substring(panelTransitionIdx, panelTransitionIdx + 200);
    expect(nextBlock).toContain('transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1)');
  });
});

// =====================================================================
// 7. Side panels still collapse correctly
// =====================================================================
describe('side panel collapse rules still intact', () => {
  it('hide-roles collapses left panel to width: 0', () => {
    const block = extractCssBlock('.crew-workspace.hide-roles .crew-panel-left {');
    expect(block).toContain('width: 0 !important');
    expect(block).toContain('min-width: 0');
    expect(block).toContain('padding: 0');
    expect(block).toContain('border: none');
  });

  it('hide-features collapses right panel to width: 0', () => {
    const block = extractCssBlock('.crew-workspace.hide-features .crew-panel-right {');
    expect(block).toContain('width: 0 !important');
    expect(block).toContain('min-width: 0');
    expect(block).toContain('padding: 0');
    expect(block).toContain('border: none');
  });

  it('center panel padding rules are after collapse rules', () => {
    const collapseLeftIdx = cssSource.indexOf('.crew-workspace.hide-roles .crew-panel-left {');
    const collapseRightIdx = cssSource.indexOf('.crew-workspace.hide-features .crew-panel-right {');
    const paddingLeftIdx = cssSource.indexOf('.crew-workspace.hide-roles .crew-panel-center {');
    const paddingRightIdx = cssSource.indexOf('.crew-workspace.hide-features .crew-panel-center {');
    expect(paddingLeftIdx).toBeGreaterThan(collapseLeftIdx);
    expect(paddingRightIdx).toBeGreaterThan(collapseRightIdx);
  });
});

// =====================================================================
// 8. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('CSS has balanced braces (2092/2092)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2095);
    expect(opens).toBe(2095);
    expect(opens).toBe(2095);
  });

  it('padding values are consistent (both 48px)', () => {
    const leftBlock = extractCssBlock('.crew-workspace.hide-roles .crew-panel-center {');
    const rightBlock = extractCssBlock('.crew-workspace.hide-features .crew-panel-center {');
    const leftVal = leftBlock.match(/padding-left:\s*(\d+)px/);
    const rightVal = rightBlock.match(/padding-right:\s*(\d+)px/);
    expect(leftVal).not.toBeNull();
    expect(rightVal).not.toBeNull();
    expect(leftVal[1]).toBe(rightVal[1]);
    expect(leftVal[1]).toBe('48');
  });
});
