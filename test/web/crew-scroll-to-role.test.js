import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for scroll-to-role: clicking a role card scrolls to
 * that role's latest message and highlights it.
 *
 * Verifies business logic:
 * 1) scrollToRoleLatest method — reverse scan, feature expansion, highlight
 * 2) Role card click triggers scroll-to-role event
 * 3) Feature block expansion logic
 * 4) visibleBlockCount expansion
 * 5) No-message safety (graceful handling)
 */

let jsSource;

beforeAll(() => {
  const jsPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  jsSource = readFileSync(jsPath, 'utf-8');
  const crewDir = resolve(__dirname, '../../web/components/crew');
  for (const mod of ['crewHelpers.js', 'crewMessageGrouping.js', 'crewKanban.js', 'crewRolePresets.js', 'CrewTurnRenderer.js', 'CrewFeaturePanel.js', 'CrewRolePanel.js', 'crewInput.js', 'crewScroll.js']) {
    jsSource += '\n' + readFileSync(resolve(crewDir, mod), 'utf-8');
  }
});

function extractMethod(methodName) {
  const lines = jsSource.split('\n');
  let bestBody = '';
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if ((trimmed.startsWith(`${methodName}(`) ||
         trimmed.startsWith(`function ${methodName}(`) ||
         trimmed.startsWith(`export function ${methodName}(`)) && trimmed.endsWith('{')) {
      const startIdx = jsSource.indexOf(lines[i]);
      const braceStart = jsSource.indexOf('{', startIdx);
      if (braceStart === -1) continue;
      let depth = 0;
      let end = braceStart;
      for (let j = braceStart; j < jsSource.length; j++) {
        if (jsSource[j] === '{') depth++;
        if (jsSource[j] === '}') depth--;
        if (depth === 0) { end = j; break; }
      }
      const body = jsSource.substring(braceStart + 1, end).trim();
      if (body.length > bestBody.length) bestBody = body;
    }
  }
  return bestBody;
}

// =====================================================================
// 1. scrollToRoleLatest method — core logic
// =====================================================================
describe('scrollToRoleLatest method', () => {
  it('method exists in source', () => {
    expect(jsSource).toContain('scrollToRoleLatest(roleName)');
  });

  it('searches featureBlocks in reverse order', () => {
    expect(jsSource).toContain('for (let i = blocks.length - 1; i >= 0; i--)');
  });

  it('searches turns within block in reverse order', () => {
    expect(jsSource).toContain('for (let j = turns.length - 1; j >= 0; j--)');
  });

  it('checks role for both turn types', () => {
    expect(jsSource).toContain("turn.type === 'turn' ? turn.role : turn.message?.role");
  });

  it('determines if target is in latest turn of block', () => {
    expect(jsSource).toContain('isInLatestTurn = j === turns.length - 1');
  });

  it('uses scrollIntoView with smooth behavior', () => {
    expect(jsSource).toContain("scrollIntoView({ behavior: 'smooth', block: 'center' })");
  });

  it('adds and removes highlight class with 2s timeout', () => {
    expect(jsSource).toContain("el.classList.add('crew-msg-highlight')");
    expect(jsSource).toContain("el.classList.remove('crew-msg-highlight')");
    expect(jsSource).toContain('2000');
  });

  it('uses nextTick before DOM queries', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain('nextTick');
  });
});

// =====================================================================
// 2. Role card click triggers scroll
// =====================================================================
describe('role card click', () => {
  it('role card @click triggers scroll-to-role event', () => {
    expect(jsSource).toContain("$emit('scroll-to-role', role.name)");
    expect(jsSource).toContain('@scroll-to-role="scrollToRoleLatest"');
  });
});

// =====================================================================
// 3. Feature block expansion logic
// =====================================================================
describe('feature block expansion logic', () => {
  it('expands feature when target block is a feature type', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain("targetBlock.type === 'feature'");
    expect(methodBody).toContain('expandedFeatures[targetBlock.taskId] = true');
  });

  it('expands history when target is NOT in latest turn', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain('if (!isInLatestTurn)');
    expect(methodBody).toContain('expandedHistories[targetBlock.taskId] = true');
  });
});

// =====================================================================
// 4. visibleBlockCount expansion logic
// =====================================================================
describe('visibleBlockCount expansion logic', () => {
  it('calculates needed blocks from target to end', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain('blocks.length - blockIdx');
  });

  it('expands visibleBlockCount when needed > current', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain('if (needed > visibleBlockCount.value)');
    expect(methodBody).toContain('visibleBlockCount.value = needed');
  });
});

// =====================================================================
// 5. No-message safety
// =====================================================================
describe('no-message safety', () => {
  it('returns early if no block contains the role', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain('if (!targetBlock) return');
  });

  it('handles empty querySelectorAll result gracefully', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain('els.length > 0');
    expect(methodBody).toContain('? els[els.length - 1] : null');
  });

  it('only scrolls and highlights when el is found', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    const ifElIdx = methodBody.indexOf('if (el)');
    const scrollIdx = methodBody.indexOf('el.scrollIntoView');
    expect(ifElIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(ifElIdx);
  });
});
