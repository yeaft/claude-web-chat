import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for fixed-order feature blocks (task-41 replaces task-32).
 *
 * task-32 added splice+push logic to move active feature segments to the bottom.
 * task-41 reverts this: segments stay in first-appearance order.
 *
 * Verifies:
 * 1) No splice+push segment repositioning in _appendToSegments
 * 2) Feature segments stay in first-appearance order
 * 3) New feature still correctly appended to end
 * 4) Global segment handling not affected
 * 5) activeMessages computed exists for streaming preview
 */

let jsSource;

beforeAll(() => {
  const jsPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  jsSource = readFileSync(jsPath, 'utf-8');
});

/**
 * Extract the body of a method from the source.
 */
function extractMethodBody(methodName) {
  const lines = jsSource.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(`${methodName}(`) && trimmed.endsWith('{')) {
      startIdx = jsSource.indexOf(lines[i]);
      break;
    }
  }
  if (startIdx === -1) return '';
  const braceStart = jsSource.indexOf('{', startIdx);
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
// 1. No segment repositioning (task-32 splice+push removed)
// =====================================================================
describe('_appendToSegments — fixed ordering (no segment move)', () => {
  let body;
  beforeAll(() => {
    body = extractMethodBody('_appendToSegments');
  });

  it('_appendToSegments method exists', () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it('does NOT splice segments to reposition them', () => {
    // task-32 used segments.splice(oldIdx, 1) to move — this should be gone
    expect(body).not.toContain('segments.splice(oldIdx, 1)');
  });

  it('does NOT check oldIdx !== segments.length - 1', () => {
    expect(body).not.toContain('oldIdx !== segments.length - 1');
  });

  it('does NOT have segIndex.clear() for rebuild after move', () => {
    // segIndex.clear() was only needed for splice+push reindexing
    expect(body).not.toContain('segIndex.clear()');
  });

  it('does NOT reference oldIdx at all', () => {
    expect(body).not.toContain('oldIdx');
  });

  it('has comment about fixed ordering', () => {
    // Should have a comment indicating segments stay in order
    expect(body).toMatch(/first.appearance|no repositioning|stay.*order/i);
  });
});

// =====================================================================
// 2. Feature segments merge into existing segment (stays in place)
// =====================================================================
describe('feature segment merge without repositioning', () => {
  let body;
  beforeAll(() => {
    body = extractMethodBody('_appendToSegments');
  });

  it('looks up existing segment via segIndex.has(taskId)', () => {
    expect(body).toContain('segIndex.has(taskId)');
  });

  it('retrieves segment from segIndex', () => {
    expect(body).toContain('segIndex.get(taskId)');
  });

  it('pushes message into existing segment', () => {
    expect(body).toContain('.messages.push(msg)');
  });

  it('marks segment as dirty', () => {
    expect(body).toContain('._dirty = true');
  });
});

// =====================================================================
// 3. New feature still appended correctly
// =====================================================================
describe('new feature creation path preserved', () => {
  let body;
  beforeAll(() => {
    body = extractMethodBody('_appendToSegments');
  });

  it('new feature segment pushed to end', () => {
    expect(body).toContain('segments.push({ taskId, messages: [msg], _dirty: true })');
  });

  it('new feature indexed in segIndex', () => {
    expect(body).toContain('segIndex.set(taskId, idx)');
  });

  it('new feature index computed from segments.length', () => {
    expect(body).toContain('const idx = segments.length');
  });
});

// =====================================================================
// 4. Global segment handling not affected
// =====================================================================
describe('global segment handling unaffected', () => {
  let body;
  beforeAll(() => {
    body = extractMethodBody('_appendToSegments');
  });

  it('global messages still merge into last global segment', () => {
    expect(body).toContain('!lastSeg.taskId');
    expect(body).toContain('lastSeg.messages.push(msg)');
  });

  it('global messages create new segment when last is not global', () => {
    expect(body).toContain("segments.push({ taskId: null, messages: [msg], _dirty: true })");
  });

  it('isGlobal check is based on no taskId or human role', () => {
    expect(body).toContain("!taskId || msg.role === 'human'");
  });

  it('global path does not use segIndex', () => {
    const isGlobalIdx = body.indexOf('if (isGlobal)');
    const elseIdx = body.indexOf('} else {', isGlobalIdx + 1);
    const globalBlock = body.substring(isGlobalIdx, elseIdx);
    expect(globalBlock).not.toContain('segIndex');
  });
});

// =====================================================================
// 5. activeMessages computed for streaming preview
// =====================================================================
describe('activeMessages computed property', () => {
  it('activeMessages computed exists', () => {
    expect(jsSource).toContain('activeMessages()');
  });

  it('collects streaming text messages', () => {
    // Should check m._streaming && m.type === 'text'
    expect(jsSource).toContain("m._streaming && m.type === 'text'");
  });

  it('deduplicates by role (one message per role)', () => {
    // seen set to track roles
    const activeIdx = jsSource.indexOf('activeMessages()');
    const nextComputed = jsSource.indexOf('() {', activeIdx + 20);
    const section = jsSource.substring(activeIdx, nextComputed);
    expect(section).toContain('seen.has(m.role)');
  });

  it('returns results in chronological order', () => {
    const activeIdx = jsSource.indexOf('activeMessages()');
    const nextComputed = jsSource.indexOf('() {', activeIdx + 20);
    const section = jsSource.substring(activeIdx, nextComputed);
    expect(section).toContain('result.reverse()');
  });
});

// =====================================================================
// 6. Active Messages template area
// =====================================================================
describe('Active Messages template section', () => {
  it('has crew-active-messages container', () => {
    expect(jsSource).toContain('class="crew-active-messages"');
  });

  it('only renders when activeMessages has items', () => {
    expect(jsSource).toContain('v-if="activeMessages.length > 0"');
  });

  it('has header with i18n title', () => {
    expect(jsSource).toContain("crew.activeMessages");
    expect(jsSource).toContain('crew-active-messages-header');
    expect(jsSource).toContain('crew-active-messages-title');
  });

  it('iterates activeMessages with v-for', () => {
    expect(jsSource).toContain('v-for="am in activeMessages"');
  });

  it('shows role icon and name in each active message', () => {
    expect(jsSource).toContain('crew-active-msg-header');
    expect(jsSource).toContain('am.roleIcon');
    expect(jsSource).toContain('am.roleName');
  });

  it('shows task title badge when available', () => {
    expect(jsSource).toContain('crew-active-msg-task');
    expect(jsSource).toContain('am.taskTitle');
  });

  it('renders markdown content', () => {
    expect(jsSource).toContain('mdRender(am.content)');
  });

  it('active messages area appears before scroll-bottom button', () => {
    const activeIdx = jsSource.indexOf('crew-active-messages');
    const scrollIdx = jsSource.indexOf('crew-scroll-bottom');
    expect(activeIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeLessThan(scrollIdx);
  });
});

// =====================================================================
// 7. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('JS template has balanced div tags', () => {
    const opens = (jsSource.match(/<div[\s>]/g) || []).length;
    const closes = (jsSource.match(/<\/div>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('_appendToSegments and _rebuildBlocksFromSegments both exist', () => {
    const appendBody = extractMethodBody('_appendToSegments');
    const rebuildBody = extractMethodBody('_rebuildBlocksFromSegments');
    expect(appendBody.length).toBeGreaterThan(0);
    expect(rebuildBody.length).toBeGreaterThan(0);
  });
});
