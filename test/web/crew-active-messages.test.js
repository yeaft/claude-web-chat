import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for dev-3/active-messages: Active Messages area and CSS styles.
 *
 * Supplements crew-active-feature-to-bottom.test.js with:
 * 1) CSS styles for the Active Messages area
 * 2) Streaming auto-disappear mechanism
 * 3) Per-role deduplication and data flow
 * 4) Task title badge display
 * 5) Typing dots animation header
 * 6) Markdown content rendering with overflow control
 * 7) activeMessages reverse-scan algorithm
 * 8) Structural integrity
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
// 1. CSS — .crew-active-messages container styles
// =====================================================================
describe('CSS — crew-active-messages container', () => {
  it('has .crew-active-messages rule', () => {
    expect(cssSource).toContain('.crew-active-messages {');
  });

  it('has margin for spacing', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toContain('margin: 12px 0 8px');
  });

  it('has padding for content', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toContain('padding: 12px 16px');
  });

  it('has border', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toContain('border: 1px solid var(--border-color)');
  });

  it('has rounded corners', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toContain('border-radius: 12px');
  });

  it('has subtle tinted background using color-mix', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toContain('color-mix');
    expect(block).toContain('var(--bg-main)');
  });
});

// =====================================================================
// 2. CSS — .crew-active-messages-header styles
// =====================================================================
describe('CSS — crew-active-messages-header', () => {
  it('has .crew-active-messages-header rule', () => {
    expect(cssSource).toContain('.crew-active-messages-header {');
  });

  it('uses flexbox for layout', () => {
    const block = extractCssBlock('.crew-active-messages-header {');
    expect(block).toContain('display: flex');
    expect(block).toContain('align-items: center');
  });

  it('has uppercase text style', () => {
    const block = extractCssBlock('.crew-active-messages-header {');
    expect(block).toContain('text-transform: uppercase');
  });

  it('has small font size', () => {
    const block = extractCssBlock('.crew-active-messages-header {');
    expect(block).toContain('font-size: 11px');
  });

  it('uses secondary text color', () => {
    const block = extractCssBlock('.crew-active-messages-header {');
    expect(block).toContain('color: var(--text-secondary)');
  });

  it('has letter spacing', () => {
    const block = extractCssBlock('.crew-active-messages-header {');
    expect(block).toContain('letter-spacing: 0.5px');
  });
});

// =====================================================================
// 3. CSS — .crew-active-msg card styles
// =====================================================================
describe('CSS — crew-active-msg card', () => {
  it('has .crew-active-msg rule', () => {
    expect(cssSource).toContain('.crew-active-msg {');
  });

  it('has padding', () => {
    const block = extractCssBlock('.crew-active-msg {');
    expect(block).toContain('padding: 8px 10px');
  });

  it('has rounded corners', () => {
    const block = extractCssBlock('.crew-active-msg {');
    expect(block).toContain('border-radius: 8px');
  });

  it('has background color', () => {
    const block = extractCssBlock('.crew-active-msg {');
    expect(block).toContain('background: var(--bg-main)');
  });

  it('has border', () => {
    const block = extractCssBlock('.crew-active-msg {');
    expect(block).toContain('border: 1px solid var(--border-color)');
  });

  it('sibling cards have margin-top spacing', () => {
    const block = extractCssBlock('.crew-active-msg + .crew-active-msg {');
    expect(block).toContain('margin-top: 8px');
  });
});

// =====================================================================
// 4. CSS — .crew-active-msg-header styles
// =====================================================================
describe('CSS — crew-active-msg-header', () => {
  it('has .crew-active-msg-header rule', () => {
    expect(cssSource).toContain('.crew-active-msg-header {');
  });

  it('uses flexbox', () => {
    const block = extractCssBlock('.crew-active-msg-header {');
    expect(block).toContain('display: flex');
    expect(block).toContain('align-items: center');
  });

  it('has gap between items', () => {
    const block = extractCssBlock('.crew-active-msg-header {');
    expect(block).toContain('gap: 6px');
  });

  it('has small font size', () => {
    const block = extractCssBlock('.crew-active-msg-header {');
    expect(block).toContain('font-size: 12px');
  });
});

// =====================================================================
// 5. CSS — .crew-active-msg-task badge styles
// =====================================================================
describe('CSS — crew-active-msg-task badge', () => {
  it('has .crew-active-msg-task rule', () => {
    expect(cssSource).toContain('.crew-active-msg-task {');
  });

  it('has small font size', () => {
    const block = extractCssBlock('.crew-active-msg-task {');
    expect(block).toContain('font-size: 11px');
  });

  it('uses secondary text color', () => {
    const block = extractCssBlock('.crew-active-msg-task {');
    expect(block).toContain('color: var(--text-secondary)');
  });

  it('has sidebar-hover background', () => {
    const block = extractCssBlock('.crew-active-msg-task {');
    expect(block).toContain('background: var(--sidebar-hover)');
  });

  it('has rounded corners', () => {
    const block = extractCssBlock('.crew-active-msg-task {');
    expect(block).toContain('border-radius: 4px');
  });

  it('pushes to right with margin-left: auto', () => {
    const block = extractCssBlock('.crew-active-msg-task {');
    expect(block).toContain('margin-left: auto');
  });
});

// =====================================================================
// 6. CSS — crew-active-msg content overflow control
// =====================================================================
describe('CSS — active message content overflow', () => {
  it('has .crew-active-msg .crew-msg-content rule', () => {
    expect(cssSource).toContain('.crew-active-msg .crew-msg-content {');
  });

  it('has smaller font size than normal messages', () => {
    const block = extractCssBlock('.crew-active-msg .crew-msg-content {');
    expect(block).toContain('font-size: 13px');
  });

  it('has max-height for overflow control', () => {
    const block = extractCssBlock('.crew-active-msg .crew-msg-content {');
    expect(block).toContain('max-height: 200px');
  });

  it('has overflow-y: auto for scrolling', () => {
    const block = extractCssBlock('.crew-active-msg .crew-msg-content {');
    expect(block).toContain('overflow-y: auto');
  });
});

// =====================================================================
// 7. Streaming auto-disappear mechanism
// =====================================================================
describe('streaming auto-disappear mechanism', () => {
  it('activeMessages only includes _streaming messages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('m._streaming');
  });

  it('activeMessages checks m.type === "text"', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.type === 'text'");
  });

  it('v-if guard ensures area disappears when no streaming', () => {
    // When _streaming becomes false, activeMessages returns [],
    // and v-if="activeMessages.length > 0" hides the area
    expect(jsSource).toContain('v-if="activeMessages.length > 0"');
  });

  it('activeMessages filters by three conditions: _streaming, type, role', () => {
    const body = extractComputedBody('activeMessages');
    // All three conditions in the same if statement
    expect(body).toContain("m._streaming && m.type === 'text' && m.role && !seen.has(m.role)");
  });
});

// =====================================================================
// 8. Per-role deduplication: one message per role
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
    // for loop counting down: i >= 0; i--
    expect(body).toMatch(/for\s*\(\s*let\s+i\s*=\s*messages\.length\s*-\s*1;\s*i\s*>=\s*0;\s*i--\)/);
  });

  it('reverses result for chronological display', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('result.reverse()');
  });
});

// =====================================================================
// 9. Task title badge in template
// =====================================================================
describe('task title badge display', () => {
  it('task title badge has v-if guard', () => {
    expect(jsSource).toContain('v-if="am.taskTitle"');
  });

  it('task title uses crew-active-msg-task class', () => {
    expect(jsSource).toContain('class="crew-active-msg-task"');
  });

  it('task title renders am.taskTitle content', () => {
    const taskIdx = jsSource.indexOf('crew-active-msg-task');
    const taskBlock = jsSource.substring(taskIdx, taskIdx + 100);
    expect(taskBlock).toContain('am.taskTitle');
  });

  it('activeMessages passes through message objects containing taskTitle', () => {
    // activeMessages does result.push(m), where m is the full message object
    // from store.currentCrewMessages, which already has taskTitle property.
    // The template then accesses am.taskTitle from the passed-through object.
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('result.push(m)');
  });
});

// =====================================================================
// 10. Typing dots animation header
// =====================================================================
describe('typing dots animation header', () => {
  it('has three crew-typing-dot elements', () => {
    const headerIdx = jsSource.indexOf('crew-active-messages-header');
    const headerEnd = jsSource.indexOf('</div>', headerIdx);
    const headerBlock = jsSource.substring(headerIdx, headerEnd);
    const dots = headerBlock.match(/crew-typing-dot/g) || [];
    expect(dots.length).toBe(3);
  });

  it('typing dots appear before the title', () => {
    const headerIdx = jsSource.indexOf('crew-active-messages-header');
    const headerEnd = jsSource.indexOf('</div>', headerIdx);
    const headerBlock = jsSource.substring(headerIdx, headerEnd);
    const dotIdx = headerBlock.indexOf('crew-typing-dot');
    const titleIdx = headerBlock.indexOf('crew-active-messages-title');
    expect(dotIdx).toBeLessThan(titleIdx);
  });

  it('title uses i18n key crew.activeMessages', () => {
    expect(jsSource).toContain("crew.activeMessages");
  });
});

// =====================================================================
// 11. Template structure and data binding
// =====================================================================
describe('active message template data binding', () => {
  it('each active message card has :data-role binding', () => {
    expect(jsSource).toContain(':data-role="am.role"');
  });

  it('each active message card has :style="getRoleStyle(am.role)"', () => {
    expect(jsSource).toContain(':style="getRoleStyle(am.role)"');
  });

  it('uses :key="am.id" for v-for', () => {
    expect(jsSource).toContain(':key="am.id"');
    // Should be on the same element as v-for="am in activeMessages"
    const vForIdx = jsSource.indexOf('v-for="am in activeMessages"');
    const keyIdx = jsSource.indexOf(':key="am.id"');
    // key should be close to v-for (on same element)
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
});

// =====================================================================
// 12. activeMessages data source
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
// 13. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('CSS has balanced braces (2151/2151)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2151);
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
});
