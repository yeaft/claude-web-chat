import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for ExpertPanel mobile touch scroll + drag handle fix (task-68, PR #230).
 *
 * Covers 3 bugs:
 * 1. Mobile touch scroll — .expert-panel.open overrides overflow:hidden with overflow-y:auto
 * 2. iOS inertia scroll — .expert-role-list has -webkit-overflow-scrolling + overscroll-behavior
 * 3. Drag handle position — .expert-panel-header has position:relative in mobile media query
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
  const escaped = prop.replace(/[-]/g, '\\-');
  const regex = new RegExp(`${escaped}\\s*:\\s*${val}`);
  return regex.test(rule.replace(/\s+/g, ' '));
}

function extractMediaBlock(css, query) {
  const escaped = query.replace(/[()]/g, '\\$&');
  const regex = new RegExp(`@media\\s*\\(${escaped}\\)\\s*\\{`, 'g');
  const match = regex.exec(css);
  if (!match) return '';
  let depth = 1;
  let i = match.index + match[0].length;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(match.index + match[0].length, i - 1);
}

const css = read('web/styles/expert-panel.css');
const mobileBlock = extractMediaBlock(css, 'max-width: 768px');

// =====================================================================
// Bug 1: Mobile touch scroll — panel overflow override
// =====================================================================

describe('Bug 1: mobile panel overflow override', () => {
  it('.expert-panel base has overflow: hidden (for closed state)', () => {
    const rule = extractCssRule(css, '.expert-panel');
    expect(hasProp(rule, 'overflow', 'hidden')).toBe(true);
  });

  it('.expert-panel.open in mobile overrides with overflow-y: auto', () => {
    const rule = extractCssRule(mobileBlock, '.expert-panel.open');
    expect(hasProp(rule, 'overflow-y', 'auto')).toBe(true);
  });
});

// =====================================================================
// Bug 2: iOS inertia scroll + scroll containment
// =====================================================================

describe('Bug 2: iOS inertia scroll and scroll containment', () => {
  const rule = extractCssRule(css, '.expert-role-list');

  it('.expert-role-list has -webkit-overflow-scrolling: touch for iOS inertia', () => {
    expect(hasProp(rule, '-webkit-overflow-scrolling', 'touch')).toBe(true);
  });

  it('.expert-role-list has overscroll-behavior: contain to prevent scroll chaining', () => {
    expect(hasProp(rule, 'overscroll-behavior', 'contain')).toBe(true);
  });

  it('.expert-role-list still has overflow-y: auto (base scroll capability)', () => {
    expect(hasProp(rule, 'overflow-y', 'auto')).toBe(true);
  });
});
