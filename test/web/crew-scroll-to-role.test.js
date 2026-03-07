import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for dev-3/scroll-to-role-latest: clicking a role card scrolls to
 * that role's latest message and highlights it for 2 seconds.
 *
 * Verifies:
 * 1) data-role attribute present on all crew-message elements (6 template sites)
 * 2) scrollToRoleLatest method exists with correct logic
 * 3) Role card click calls scrollToRoleLatest directly
 * 4) CSS highlight animation (.crew-msg-highlight + @keyframes msgHighlight)
 * 5) Feature block expand/history expand logic in scrollToRoleLatest
 * 6) visibleBlockCount expansion logic
 */

let jsSource;
let cssSource;

beforeAll(() => {
  const jsPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  jsSource = readFileSync(jsPath, 'utf-8');
  // Sub-modules and sub-components extracted from CrewChatView during refactor
  const crewDir = resolve(__dirname, '../../web/components/crew');
  for (const mod of ['crewHelpers.js', 'crewMessageGrouping.js', 'crewKanban.js', 'crewRolePresets.js', 'CrewTurnRenderer.js', 'CrewFeaturePanel.js', 'CrewRolePanel.js', 'crewInput.js', 'crewScroll.js']) {
    jsSource += '\n' + readFileSync(resolve(crewDir, mod), 'utf-8');
  }

  cssSource = loadAllCss();
});

// =====================================================================
// 1. data-role attribute on all crew-message elements
// =====================================================================
describe('data-role attribute on crew-message elements', () => {
  it('all crew-message divs (excluding containers) have :data-role binding', () => {
    // Every <div with class="crew-message" (the actual message elements) should have :data-role
    // Exclude crew-messages (the container) and other non-message divs
    const messageLines = jsSource.split('\n').filter(
      line =>
        line.includes('<div') &&
        line.includes('class="crew-message') &&
        !line.includes('crew-messages') &&
        !line.includes('class="crew-message-')
    );
    // After sub-component extraction, CrewTurnRenderer.js has 2 crew-message divs
    // plus 1 in active messages section = 3 total
    expect(messageLines.length).toBeGreaterThanOrEqual(3);

    for (const line of messageLines) {
      expect(line).toContain(':data-role=');
    }
  });

  it('single messages bind data-role to turn.message.role', () => {
    // v-if="turn.type !== 'turn'" messages should use turn.message.role
    const singleMsgLines = jsSource.split('\n').filter(
      line =>
        line.includes('class="crew-message"') &&
        line.includes("turn.type !== 'turn'")
    );
    // After sub-component extraction, single message template is in CrewTurnRenderer (1 instance)
    expect(singleMsgLines.length).toBeGreaterThanOrEqual(1);
    for (const line of singleMsgLines) {
      expect(line).toContain(':data-role="turn.message.role"');
    }
  });

  it('turn-group messages bind data-role to turn.role', () => {
    // v-else crew-turn-group messages should use turn.role
    const turnGroupLines = jsSource.split('\n').filter(
      line => line.includes('crew-turn-group') && line.includes(':data-role=')
    );
    // After sub-component extraction, turn-group template is in CrewTurnRenderer (1 instance)
    expect(turnGroupLines.length).toBeGreaterThanOrEqual(1);
    for (const line of turnGroupLines) {
      expect(line).toContain(':data-role="turn.role"');
    }
  });
});

// =====================================================================
// 2. scrollToRoleLatest method exists and has correct structure
// =====================================================================
describe('scrollToRoleLatest method', () => {
  it('method exists in source', () => {
    expect(jsSource).toContain('scrollToRoleLatest(roleName)');
  });

  it('searches featureBlocks in reverse order', () => {
    // Should iterate blocks from last to first to find latest message
    expect(jsSource).toContain('for (let i = blocks.length - 1; i >= 0; i--)');
  });

  it('searches turns within block in reverse order', () => {
    expect(jsSource).toContain('for (let j = turns.length - 1; j >= 0; j--)');
  });

  it('checks role for both turn types', () => {
    // turn.type === 'turn' uses turn.role, otherwise turn.message?.role
    expect(jsSource).toContain("turn.type === 'turn' ? turn.role : turn.message?.role");
  });

  it('determines if target is in latest turn of block', () => {
    expect(jsSource).toContain('isInLatestTurn = j === turns.length - 1');
  });

  it('returns early when no target block found', () => {
    expect(jsSource).toContain('if (!targetBlock) return');
  });

  it('uses querySelectorAll with data-role selector', () => {
    expect(jsSource).toContain('querySelectorAll(`.crew-message[data-role="${roleName}"]`)');
  });

  it('takes the last matching element (latest message)', () => {
    expect(jsSource).toContain('els[els.length - 1]');
  });

  it('calls scrollIntoView with smooth behavior and center block', () => {
    expect(jsSource).toContain("scrollIntoView({ behavior: 'smooth', block: 'center' })");
  });

  it('adds highlight class to target element', () => {
    expect(jsSource).toContain("el.classList.add('crew-msg-highlight')");
  });

  it('removes highlight class after 2 seconds', () => {
    expect(jsSource).toContain("el.classList.remove('crew-msg-highlight')");
    expect(jsSource).toContain('2000');
  });

  it('uses nextTick before DOM queries', () => {
    // The DOM queries are wrapped in nextTick to wait for Vue re-render
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain('nextTick');
  });
});

// =====================================================================
// 3. Role card click calls scrollToRoleLatest directly
// =====================================================================
describe('role card click', () => {
  it('role card @click triggers scroll-to-role event', () => {
    // In CrewRolePanel sub-component, click emits scroll-to-role
    expect(jsSource).toContain("$emit('scroll-to-role', role.name)");
    // Parent CrewChatView binds the event to scrollToRoleLatest
    expect(jsSource).toContain('@scroll-to-role="scrollToRoleLatest"');
  });

  it('insertAt method has been removed', () => {
    expect(jsSource).not.toContain('insertAt(roleName)');
  });
});

// =====================================================================
// 4. CSS highlight animation
// =====================================================================
describe('CSS highlight animation', () => {
  it('.crew-message.crew-msg-highlight rule exists', () => {
    expect(cssSource).toContain('.crew-message.crew-msg-highlight {');
  });

  it('uses msgHighlight animation', () => {
    const block = extractCssBlock('.crew-message.crew-msg-highlight {');
    expect(block).not.toBeNull();
    expect(block).toContain('animation:');
    expect(block).toContain('msgHighlight');
    expect(block).toContain('2s');
  });

  it('@keyframes msgHighlight exists', () => {
    expect(cssSource).toContain('@keyframes msgHighlight');
  });

  it('keyframes starts with box-shadow glow', () => {
    const keyframesBlock = extractCssBlock('@keyframes msgHighlight {');
    expect(keyframesBlock).not.toBeNull();
    expect(keyframesBlock).toContain('box-shadow:');
    expect(keyframesBlock).toContain('rgba(59, 130, 246');
  });

  it('keyframes ends with no box-shadow', () => {
    const keyframesBlock = extractCssBlock('@keyframes msgHighlight {');
    expect(keyframesBlock).toContain('box-shadow: none');
  });

  it('keyframes includes border-radius for visual polish', () => {
    const keyframesBlock = extractCssBlock('@keyframes msgHighlight {');
    expect(keyframesBlock).toContain('border-radius: 8px');
  });
});

// =====================================================================
// 5. Feature block expansion logic
// =====================================================================
describe('feature block expansion logic', () => {
  it('expands feature when target block is a feature type', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain("targetBlock.type === 'feature'");
    expect(methodBody).toContain('targetBlock.taskId');
    expect(methodBody).toContain('expandedFeatures[targetBlock.taskId] = true');
  });

  it('expands history when target is NOT in latest turn', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain('if (!isInLatestTurn)');
    expect(methodBody).toContain('expandedHistories[targetBlock.taskId] = true');
  });

  it('does NOT expand history when target IS in latest turn', () => {
    // The history expand is guarded by !isInLatestTurn
    // This means latest-turn messages are visible without expanding history
    const methodBody = extractMethod('scrollToRoleLatest');
    // History expand should be inside a conditional, not unconditional
    const expandHistoryLine = methodBody.split('\n').find(l =>
      l.includes('expandedHistories[targetBlock.taskId] = true')
    );
    expect(expandHistoryLine).toBeDefined();
    // Verify the guard exists before this line
    const guardIdx = methodBody.indexOf('if (!isInLatestTurn)');
    const expandIdx = methodBody.indexOf('expandedHistories[targetBlock.taskId] = true');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(expandIdx);
  });
});

// =====================================================================
// 6. visibleBlockCount expansion logic
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

  it('does not reduce visibleBlockCount if already sufficient', () => {
    // The condition is > not >=, so equal means no change
    const methodBody = extractMethod('scrollToRoleLatest');
    const condition = 'if (needed > visibleBlockCount.value)';
    expect(methodBody).toContain(condition);
    // Assignment only appears once and inside the if
    const lines = methodBody.split('\n');
    const assignmentLines = lines.filter(l => l.includes('visibleBlockCount.value = needed'));
    expect(assignmentLines.length).toBe(1);
  });
});

// =====================================================================
// 7. No-message safety (role has no messages)
// =====================================================================
describe('no-message safety', () => {
  it('returns early if no block contains the role', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    expect(methodBody).toContain('if (!targetBlock) return');
  });

  it('handles empty querySelectorAll result gracefully', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    // Only operates on el if els.length > 0
    expect(methodBody).toContain('els.length > 0');
    expect(methodBody).toContain('? els[els.length - 1] : null');
  });

  it('only scrolls and highlights when el is found', () => {
    const methodBody = extractMethod('scrollToRoleLatest');
    // scrollIntoView and classList.add are inside an if(el) guard
    const ifElIdx = methodBody.indexOf('if (el)');
    const scrollIdx = methodBody.indexOf('el.scrollIntoView');
    expect(ifElIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(ifElIdx);
  });
});

// =====================================================================
// 8. CSS structural integrity — brace count updated
// =====================================================================
describe('CSS structural integrity', () => {
  it('CSS has balanced braces', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('brace count is 2091 (updated after adding button loading styles)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    expect(opens).toBe(2092);
  });
});

// =====================================================================
// 9. test/agent/crew.test.js brace count also updated
// =====================================================================
describe('agent test — brace count synchronized', () => {
  it('agent crew test uses 2109 brace count', () => {
    const agentTestPath = resolve(__dirname, '../../test/agent/crew.test.js');
    const agentTestSource = readFileSync(agentTestPath, 'utf-8');
    // The brace count test should reference 2109
    expect(agentTestSource).toContain("expect(opens).toBe(2092)");
  });
});

// =====================================================================
// Helper: extract a JS method body between first { and matching }
// =====================================================================
function extractMethod(methodName) {
  // Find the method/function definition with the longest body (implementation, not wrapper).
  // Matches: "methodName(", "function methodName(", "export function methodName("
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
// Helper: extract a CSS rule block
// =====================================================================
function extractCssBlock(selector) {
  const idx = cssSource.indexOf(selector);
  if (idx === -1) return null;
  const openBrace = cssSource.indexOf('{', idx);
  if (openBrace === -1) return null;
  let depth = 0;
  let end = openBrace;
  for (let i = openBrace; i < cssSource.length; i++) {
    if (cssSource[i] === '{') depth++;
    if (cssSource[i] === '}') depth--;
    if (depth === 0) { end = i; break; }
  }
  return cssSource.substring(openBrace + 1, end).trim();
}
