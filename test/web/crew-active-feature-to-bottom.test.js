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
  // Sub-modules extracted from CrewChatView during refactor
  const crewDir = resolve(__dirname, '../../web/components/crew');
  for (const mod of ['crewHelpers.js', 'crewMessageGrouping.js', 'crewKanban.js', 'crewRolePresets.js', 'CrewTurnRenderer.js', 'CrewFeaturePanel.js', 'CrewRolePanel.js', 'crewInput.js', 'crewScroll.js']) {
    jsSource += '\n' + readFileSync(resolve(crewDir, mod), 'utf-8');
  }
});

/**
 * Extract the body of a method from the source.
 */
function extractMethodBody(methodName) {
  const lines = jsSource.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if ((trimmed.startsWith(`${methodName}(`) ||
         trimmed.startsWith(`function ${methodName}(`) ||
         trimmed.startsWith(`export function ${methodName}(`)) && trimmed.endsWith('{')) {
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
describe('appendToSegments — fixed ordering (no segment move)', () => {
  let body;
  beforeAll(() => {
    body = extractMethodBody('appendToSegments');
  });

  it('appendToSegments method exists', () => {
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
    body = extractMethodBody('appendToSegments');
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
    body = extractMethodBody('appendToSegments');
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
    body = extractMethodBody('appendToSegments');
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
// 5. activeMessages computed — single latest text message
// =====================================================================
describe('activeMessages computed property', () => {
  it('activeMessages computed exists', () => {
    expect(jsSource).toContain('activeMessages()');
  });

  it('returns single latest text message (not per-role dedup)', () => {
    const activeIdx = jsSource.indexOf('activeMessages()');
    const nextComputed = jsSource.indexOf('() {', activeIdx + 20);
    const section = jsSource.substring(activeIdx, nextComputed);
    expect(section).toContain("m.type !== 'text'");
    expect(section).not.toContain('m._streaming');
  });

  it('does not track latestHuman or latestCrew', () => {
    const activeIdx = jsSource.indexOf('activeMessages()');
    const nextComputed = jsSource.indexOf('() {', activeIdx + 20);
    const section = jsSource.substring(activeIdx, nextComputed);
    expect(section).not.toContain('latestHuman');
    expect(section).not.toContain('latestCrew');
  });

  it('returns directly via return [m]', () => {
    const activeIdx = jsSource.indexOf('activeMessages()');
    const nextComputed = jsSource.indexOf('() {', activeIdx + 20);
    const section = jsSource.substring(activeIdx, nextComputed);
    expect(section).toContain('return [m]');
  });
});

// =====================================================================
// 6. Active Messages template area — no border, task info, label
// =====================================================================
describe('Active Messages template section', () => {
  it('has crew-active-messages container', () => {
    expect(jsSource).toContain('class="crew-active-messages"');
  });

  it('hidden when all tasks completed', () => {
    expect(jsSource).toMatch(/v-if="activeMessages\.length > 0 && \(hasStreamingMessage \|\| kanbanInProgressCount > 0\)"/);
  });

  it('has "Latest Message" label', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-active-messages-label');
  });

  it('uses getRoleStyle for role color', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('getRoleStyle');
  });

  it('shows taskTitle for feature context', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('am.taskTitle');
    expect(activeArea).toContain('crew-msg-task');
  });

  it('uses standard crew-message classes', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-message');
    expect(activeArea).toContain('crew-msg-body');
  });

  it('uses dynamic crew-msg-type class like feature block', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain("'crew-msg-' + am.type");
  });

  it('has crew-msg-human-bubble conditional class', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-msg-human-bubble');
  });

  it('iterates activeMessages with v-for', () => {
    expect(jsSource).toContain('v-for="am in activeMessages"');
  });

  it('shows role icon and name in each active message', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('crew-msg-header');
    expect(activeArea).toContain('am.roleIcon');
    expect(activeArea).toContain('am.roleName');
  });

  it('shows timestamp with formatTime', () => {
    const activeArea = jsSource.substring(
      jsSource.indexOf('crew-active-messages'),
      jsSource.indexOf('crew-scroll-bottom')
    );
    expect(activeArea).toContain('formatTime(am.timestamp)');
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
