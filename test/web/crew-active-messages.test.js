import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-46c: Active Messages — single latest text message.
 *
 * Verifies:
 * 1) activeMessages computed returns exactly 1 message (latest text, any role)
 * 2) Reverse-scan picks the latest text message
 * 3) Template: getRoleStyle for role color, shows taskTitle, has "Latest Message" label
 * 4) No typing dots in dynamic message area
 * 5) CSS: .crew-active-messages styling + no border-left override + task label
 * 6) Hidden when all tasks completed (no active features)
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

/**
 * Extract the active messages template area (between crew-active-messages and crew-scroll-bottom).
 */
function getActiveArea() {
  return jsSource.substring(
    jsSource.indexOf('crew-active-messages'),
    jsSource.indexOf('crew-scroll-bottom')
  );
}

// =====================================================================
// 1. activeMessages computed — single latest text message
// =====================================================================
describe('activeMessages computed — single latest message', () => {
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

  it('skips system role', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role === 'system'");
  });

  it('returns array with single message via return [m]', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('return [m]');
  });

  it('does NOT track latestHuman or latestCrew', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('latestHuman');
    expect(body).not.toContain('latestCrew');
  });

  it('returns empty array when no text messages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('return []');
  });
});

// =====================================================================
// 2. Reverse scan algorithm
// =====================================================================
describe('reverse scan for latest message', () => {
  it('scans messages in reverse order', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toMatch(/for\s*\(\s*let\s+i\s*=\s*messages\.length\s*-\s*1;\s*i\s*>=\s*0;\s*i--\)/);
  });

  it('does NOT use Set for deduplication', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('new Set()');
    expect(body).not.toContain('seen.has');
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

  it('does NOT use result array (returns directly)', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('const result = []');
  });
});

// =====================================================================
// 4. Template — no border, task info, label, feature block structure
// =====================================================================
describe('template — role color, task info, label', () => {
  it('active messages use crew-message class', () => {
    expect(getActiveArea()).toContain('crew-message');
  });

  it('uses dynamic crew-msg-type class like feature block', () => {
    expect(getActiveArea()).toContain("'crew-msg-' + am.type");
  });

  it('has crew-msg-human-bubble conditional class', () => {
    expect(getActiveArea()).toContain('crew-msg-human-bubble');
  });

  it('uses getRoleStyle for role color', () => {
    expect(getActiveArea()).toContain('getRoleStyle');
  });

  it('shows taskTitle for feature context', () => {
    expect(getActiveArea()).toContain('am.taskTitle');
    expect(getActiveArea()).toContain('crew-msg-task');
  });

  it('has "Latest Message" label at top', () => {
    expect(getActiveArea()).toContain('crew-active-messages-label');
    expect(getActiveArea()).toContain("$t('crew.latestMessage')");
  });

  it('header conditionally hidden for human text messages', () => {
    expect(getActiveArea()).toContain("am.role !== 'human' || am.type !== 'text'");
  });

  it('crew-msg-name has is-human/is-system class binding', () => {
    expect(getActiveArea()).toContain("'is-human': am.role === 'human'");
    expect(getActiveArea()).toContain("'is-system': am.role === 'system'");
  });

  it('shows formatTime(am.timestamp) for time display', () => {
    expect(getActiveArea()).toContain('formatTime(am.timestamp)');
  });

  it('uses crew-msg-body wrapper', () => {
    expect(getActiveArea()).toContain('crew-msg-body');
  });

  it('uses crew-msg-header for role info', () => {
    expect(getActiveArea()).toContain('crew-msg-header');
  });

  it('iterates activeMessages with v-for', () => {
    expect(jsSource).toContain('v-for="am in activeMessages"');
  });

  it('renders content with mdRender', () => {
    expect(jsSource).toContain('mdRender(am.content)');
  });
});

// =====================================================================
// 5. No typing dots in dynamic message area
// =====================================================================
describe('no typing dots in active messages area', () => {
  it('does NOT have typing dots between active messages and scroll-bottom', () => {
    expect(getActiveArea()).not.toContain('crew-typing-dot');
  });

  it('does NOT have crew-streaming-indicator between active messages and scroll-bottom', () => {
    expect(getActiveArea()).not.toContain('crew-streaming-indicator');
  });
});

// =====================================================================
// 6. Hidden when all tasks completed
// =====================================================================
describe('hidden when all tasks completed', () => {
  it('v-if includes hasStreamingMessage or kanbanInProgressCount > 0', () => {
    const vifMatch = jsSource.match(/v-if="activeMessages\.length > 0 && \(hasStreamingMessage \|\| kanbanInProgressCount > 0\)"/);
    expect(vifMatch).not.toBeNull();
  });
});

// =====================================================================
// 7. CSS — .crew-active-messages styling
// =====================================================================
describe('CSS — active messages styling', () => {
  it('has .crew-active-messages rule', () => {
    expect(cssSource).toContain('.crew-active-messages {');
  });

  it('has simple margin', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toContain('margin: 8px 0');
  });

  it('overrides border-left to none for messages inside', () => {
    expect(cssSource).toContain('.crew-active-messages .crew-message');
    const block = extractCssBlock('.crew-active-messages .crew-message');
    expect(block).toContain('border-left: none');
  });

  it('has .crew-msg-task style', () => {
    expect(cssSource).toContain('.crew-msg-task');
  });

  it('has .crew-active-messages-label style', () => {
    expect(cssSource).toContain('.crew-active-messages-label');
  });

  it('removed .crew-active-msg CSS', () => {
    expect(cssSource).not.toContain('.crew-active-msg {');
  });
});

// =====================================================================
// 8. Structural integrity
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
