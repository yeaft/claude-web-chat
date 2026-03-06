import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for Active Messages area — persistent latest message per role.
 *
 * Verifies:
 * 1) CSS styles for the Active Messages area (plain message style, no special container)
 * 2) Persistent display — shows latest text message per role, not just streaming
 * 3) Per-role deduplication and data flow
 * 4) Task title badge display
 * 5) Uses standard crew-message styling (no special container styling)
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
// 1. CSS — .crew-active-messages container (plain, no special styling)
// =====================================================================
describe('CSS — crew-active-messages container (plain style)', () => {
  it('has .crew-active-messages rule', () => {
    expect(cssSource).toContain('.crew-active-messages {');
  });

  it('has margin for spacing', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).toContain('margin: 12px 0 8px');
  });

  it('does NOT have special background (no color-mix)', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).not.toContain('color-mix');
    expect(block).not.toContain('background');
  });

  it('does NOT have border', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).not.toContain('border');
  });

  it('does NOT have padding (messages use their own)', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).not.toContain('padding');
  });

  it('does NOT have border-radius', () => {
    const block = extractCssBlock('.crew-active-messages {');
    expect(block).not.toContain('border-radius');
  });
});

// =====================================================================
// 2. No special header/title (removed)
// =====================================================================
describe('no special header or title', () => {
  it('does NOT have crew-active-messages-header CSS rule', () => {
    expect(cssSource).not.toContain('.crew-active-messages-header {');
  });

  it('does NOT have crew-active-messages-title CSS rule', () => {
    expect(cssSource).not.toContain('.crew-active-messages-title {');
  });

  it('does NOT have typing dots in active messages template', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).not.toContain('crew-active-messages-header');
    expect(activeArea).not.toContain('crew-active-messages-title');
  });

  it('does NOT reference crew.activeMessages i18n key in active area', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).not.toContain('crew.activeMessages');
  });
});

// =====================================================================
// 3. Uses standard crew-message styling
// =====================================================================
describe('uses standard crew-message styling', () => {
  it('active messages use crew-message class', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('class="crew-message crew-msg-text"');
  });

  it('active messages use crew-msg-body wrapper', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-msg-body');
  });

  it('active messages use crew-msg-header for role info', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-msg-header');
  });

  it('does NOT have old crew-active-msg card CSS rule', () => {
    expect(cssSource).not.toContain('.crew-active-msg {');
  });

  it('does NOT have old crew-active-msg-header CSS rule', () => {
    expect(cssSource).not.toContain('.crew-active-msg-header {');
  });

  it('crew-message inside active-messages has no extra bottom margin', () => {
    const block = extractCssBlock('.crew-active-messages .crew-message {');
    expect(block).toContain('margin-bottom: 0');
  });
});

// =====================================================================
// 4. CSS — .crew-active-msg-task badge styles
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
// 5. CSS — active message content overflow control
// =====================================================================
describe('CSS — active message content overflow', () => {
  it('has .crew-active-messages .crew-msg-content rule', () => {
    expect(cssSource).toContain('.crew-active-messages .crew-msg-content {');
  });

  it('has max-height for overflow control', () => {
    const block = extractCssBlock('.crew-active-messages .crew-msg-content {');
    expect(block).toContain('max-height: 200px');
  });

  it('has overflow-y: auto for scrolling', () => {
    const block = extractCssBlock('.crew-active-messages .crew-msg-content {');
    expect(block).toContain('overflow-y: auto');
  });
});

// =====================================================================
// 6. Persistent display — shows latest text per role, not just streaming
// =====================================================================
describe('persistent display mechanism', () => {
  it('activeMessages does NOT filter by _streaming', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).not.toContain('_streaming');
  });

  it('activeMessages checks m.type === "text"', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.type === 'text'");
  });

  it('activeMessages excludes human role messages', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.role !== 'human'");
  });

  it('v-if guard hides area only when no messages exist', () => {
    expect(jsSource).toContain('v-if="activeMessages.length > 0"');
  });

  it('activeMessages filters by: type, role non-human, role uniqueness', () => {
    const body = extractComputedBody('activeMessages');
    expect(body).toContain("m.type === 'text' && m.role && m.role !== 'human' && !seen.has(m.role)");
  });
});

// =====================================================================
// 7. Per-role deduplication: one message per role
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
// 8. Task title badge in template
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
    const body = extractComputedBody('activeMessages');
    expect(body).toContain('result.push(m)');
  });
});

// =====================================================================
// 9. Template structure and data binding
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
});

// =====================================================================
// 10. activeMessages data source
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
// 11. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('CSS has balanced braces (2147/2147)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2147);
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
