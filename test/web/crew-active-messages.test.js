import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-46: Active Messages shows max 2 messages
 * (latest human + latest crew).
 *
 * Verifies:
 * 1) activeMessages computed returns at most 2 messages (1 human + 1 crew)
 * 2) Reverse-scan picks latest of each category
 * 3) Template renders with v-for and standard classes
 * 4) No special header/title
 * 5) CSS: .crew-active-messages has only simple margin
 * 6) Structural integrity
 */

let jsSource;
let cssSource;

beforeAll(() => {
  const jsPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  jsSource = readFileSync(jsPath, 'utf-8');

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

/**
 * Extract a computed property body from the JS source.
 */
function extractComputedBody(name) {
  const idx = jsSource.indexOf(`${name}() {`);
  if (idx === -1) return '';
  const braceStart = jsSource.indexOf('{', idx);
  if (braceStart === -1) return '';
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < jsSource.length; i++) {
    if (jsSource[i] === '{') depth++;
    if (jsSource[i] === '}') depth--;
    if (depth === 0) { end = i; break; }
  }
  return jsSource.substring(braceStart + 1, end).trim();
}

// =====================================================================
// 1. activeMessages computed — max 2 messages (human + crew)
// =====================================================================
describe('activeMessages computed — max 2 messages', () => {
  it('activeMessages method exists', () => {
    const body = extractComputedBody('activeMessages');
    expect(body.length).toBeGreaterThan(0);
  });

  it('does NOT filter by _streaming flag', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('m._streaming');
  });

  it('filters by m.type !== text (skip non-text)', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.type !== 'text'");
  });

  it('tracks latestHuman variable', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('latestHuman');
  });

  it('tracks latestCrew variable', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('latestCrew');
  });

  it('identifies human messages by role', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role === 'human'");
  });

  it('excludes system role from crew messages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role !== 'system'");
  });

  it('breaks early when both found', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('if (latestHuman && latestCrew) break');
  });

  it('pushes latestHuman to result when found', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('result.push(latestHuman)');
  });

  it('pushes latestCrew to result when found', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('result.push(latestCrew)');
  });

  it('v-if guard shows area when any messages exist', () => {
    expect(jsSource).toContain('v-if="activeMessages.length > 0"');
  });
});

// =====================================================================
// 2. Reverse scan algorithm
// =====================================================================
describe('reverse scan for latest messages', () => {
  it('scans messages in reverse order', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toMatch(/for\s*\(\s*let\s+i\s*=\s*messages\.length\s*-\s*1;\s*i\s*>=\s*0;\s*i--\)/);
  });

  it('does NOT use Set for deduplication (no per-role grouping)', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('new Set()');
    expect(body).not.toContain('seen.has');
    expect(body).not.toContain('seen.add');
  });

  it('does NOT reverse result (human always before crew)', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('result.reverse()');
  });
});

// =====================================================================
// 3. activeMessages data source
// =====================================================================
describe('activeMessages data source', () => {
  it('reads from store.currentCrewMessages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('this.store.currentCrewMessages');
  });

  it('result is an array', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('const result = []');
  });

  it('initializes latestHuman as null', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('let latestHuman = null');
  });

  it('initializes latestCrew as null', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('let latestCrew = null');
  });
});

// =====================================================================
// 4. Template uses standard crew-message classes (plain styling)
// =====================================================================
describe('template — plain styling with standard classes', () => {
  it('active messages use crew-message class', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-message');
  });

  it('active messages use crew-msg-text class', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-msg-text');
  });

  it('uses crew-msg-body wrapper', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-msg-body');
  });

  it('uses crew-msg-header for role info', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-msg-header');
  });

  it('iterates activeMessages with v-for', () => {
    expect(jsSource).toContain('v-for="am in activeMessages"');
  });

  it('renders content with mdRender', () => {
    expect(jsSource).toContain('mdRender(am.content)');
  });
});

// =====================================================================
// 5. No special header/title
// =====================================================================
describe('no special header or title', () => {
  it('does NOT have crew-active-messages-header', () => {
    expect(jsSource).not.toContain('crew-active-messages-header');
  });

  it('does NOT have crew-active-messages-title', () => {
    expect(jsSource).not.toContain('crew-active-messages-title');
  });

  it('does NOT have typing dots in active messages area', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).not.toContain('crew-typing-dot');
  });
});

// =====================================================================
// 6. CSS — minimal .crew-active-messages styling
// =====================================================================
describe('CSS — minimal active messages styling', () => {
  it('has .crew-active-messages rule', () => {
    expect(cssSource).toContain('.crew-active-messages {');
  });

  it('has simple margin', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toContain('margin: 8px 0');
  });

  it('does NOT have special border', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).not.toContain('border:');
    expect(block).not.toContain('border-radius');
  });

  it('does NOT have special background with color-mix', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).not.toContain('color-mix');
    expect(block).not.toContain('background');
  });

  it('removed .crew-active-msg CSS', () => {
    expect(cssSource).not.toContain('.crew-active-msg {');
  });
});

// =====================================================================
// 7. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('CSS has balanced braces', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('JS template has balanced div tags', () => {
    const opens = (jsSource.match(/<div[\s>]/g) || []).length;
    const closes = (jsSource.match(/<\/div>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('active messages area is inside the crew-messages-wrapper', () => {
    const wrapperIdx = jsSource.indexOf('crew-messages-wrapper');
    const activeIdx = jsSource.indexOf('crew-active-messages');
    expect(activeIdx).toBeGreaterThan(wrapperIdx);
  });

  it('active messages area appears before scroll-bottom button', () => {
    const activeIdx = jsSource.indexOf('crew-active-messages');
    const scrollIdx = jsSource.indexOf('crew-scroll-bottom');
    expect(activeIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeLessThan(scrollIdx);
  });
});
