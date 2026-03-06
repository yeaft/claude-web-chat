import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-45: Active Messages persistent display with plain styling.
 *
 * Verifies:
 * 1) activeMessages computed collects latest text message per role (not just streaming)
 * 2) activeMessages excludes human and system roles
 * 3) Per-role deduplication with reverse-scan algorithm
 * 4) Template uses standard crew-message/crew-msg-* classes (no special styling)
 * 5) No special header/title (removed "实时动态" header)
 * 6) CSS: .crew-active-messages has only simple margin (no border, background, padding)
 * 7) Structural integrity
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
// 1. activeMessages computed — persistent (not just streaming)
// =====================================================================
describe('activeMessages computed — persistent display', () => {
  it('does NOT filter by _streaming flag', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('m._streaming');
  });

  it('filters by m.type === "text"', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.type === 'text'");
  });

  it('filters by m.role existence', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('m.role');
  });

  it('excludes human role', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role !== 'human'");
  });

  it('excludes system role', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role !== 'system'");
  });

  it('v-if guard shows area when any messages exist', () => {
    expect(jsSource).toContain('v-if="activeMessages.length > 0"');
  });
});

// =====================================================================
// 2. Per-role deduplication: one message per role
// =====================================================================
describe('per-role deduplication', () => {
  it('uses Set for role tracking', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('new Set()');
  });

  it('adds role to seen set after first encounter', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('seen.add(m.role)');
  });

  it('skips messages from already-seen roles', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('!seen.has(m.role)');
  });

  it('scans messages in reverse order (latest first)', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toMatch(/for\s*\(\s*let\s+i\s*=\s*messages\.length\s*-\s*1;\s*i\s*>=\s*0;\s*i--\)/);
  });

  it('reverses result for chronological display', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('result.reverse()');
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

  it('pushes matching messages to result', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('result.push(m)');
  });
});

// =====================================================================
// 4. Template uses standard crew-message classes (plain styling)
// =====================================================================
describe('template — plain styling with standard classes', () => {
  it('active messages use crew-message class (same as normal messages)', () => {
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

  it('uses crew-msg-name for role name', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-msg-name');
  });

  it('uses crew-msg-time for task title (instead of crew-active-msg-task)', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-msg-time');
    expect(activeArea).not.toContain('crew-active-msg-task');
  });

  it('does NOT use special crew-active-msg class', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).not.toContain('"crew-active-msg"');
  });
});

// =====================================================================
// 5. No special header/title (removed "实时动态")
// =====================================================================
describe('no special header or title', () => {
  it('does NOT have crew-active-messages-header', () => {
    expect(jsSource).not.toContain('crew-active-messages-header');
  });

  it('does NOT have crew-active-messages-title', () => {
    expect(jsSource).not.toContain('crew-active-messages-title');
  });

  it('does NOT reference crew.activeMessages i18n key', () => {
    expect(jsSource).not.toContain("crew.activeMessages");
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
// 6. Template data binding
// =====================================================================
describe('template data binding', () => {
  it('each active message card has :data-role binding', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain(':data-role="am.role"');
  });

  it('each active message card has :style="getRoleStyle(am.role)"', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain(':style="getRoleStyle(am.role)"');
  });

  it('uses :key="am.id" for v-for', () => {
    expect(jsSource).toContain(':key="am.id"');
    const vForIdx = jsSource.indexOf('v-for="am in activeMessages"');
    const keyIdx = jsSource.indexOf(':key="am.id"');
    expect(Math.abs(vForIdx - keyIdx)).toBeLessThan(100);
  });

  it('shows role icon when available', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('v-if="am.roleIcon"');
    expect(activeArea).toContain('am.roleIcon');
  });

  it('shows role name via shortName helper', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('shortName(am.roleName)');
  });

  it('renders content with mdRender for full markdown', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('v-html="mdRender(am.content)"');
  });

  it('task title has v-if guard', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('v-if="am.taskTitle"');
  });

  it('dynamic role class binding', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain("'crew-role-' + am.role");
  });
});

// =====================================================================
// 7. CSS — minimal .crew-active-messages styling (no special background/border)
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

  it('does NOT have padding', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).not.toContain('padding');
  });

  it('removed .crew-active-messages-header CSS', () => {
    expect(cssSource).not.toContain('.crew-active-messages-header {');
  });

  it('removed .crew-active-msg CSS', () => {
    expect(cssSource).not.toContain('.crew-active-msg {');
  });

  it('removed .crew-active-msg-header CSS', () => {
    expect(cssSource).not.toContain('.crew-active-msg-header {');
  });

  it('removed .crew-active-msg-task CSS', () => {
    expect(cssSource).not.toContain('.crew-active-msg-task {');
  });

  it('removed .crew-active-msg .crew-msg-content CSS', () => {
    expect(cssSource).not.toContain('.crew-active-msg .crew-msg-content {');
  });
});

// =====================================================================
// 8. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('CSS has balanced braces (2144/2144)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2144);
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
