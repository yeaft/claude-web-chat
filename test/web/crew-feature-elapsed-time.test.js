import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for dev-3/feature-elapsed-time: Feature card elapsed time display.
 *
 * Verifies:
 * 1) In-progress feature cards show real-time timer (nowTick - createdAt)
 * 2) Completed feature cards show fixed total elapsed time (lastActivityAt - createdAt)
 * 3) Format correctness: <1min → "Xs", <1h → "Xm Ys", ≥1h → "Xh Ym"
 * 4) Interval cleanup on component unmount (no memory leak)
 * 5) lastActivityAt data flow through featureKanban
 * 6) CSS styles for elapsed time display
 * 7) Structural integrity
 */

let jsSource;
let cssSource;

beforeAll(() => {
  const jsPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  jsSource = readFileSync(jsPath, 'utf-8');

  cssSource = loadAllCss();
});

/**
 * Extract a method body from the JS source by finding the method definition line.
 */
function extractMethod(methodName) {
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
 * Extract the lifecycle hook body by looking for `hookName()` pattern.
 */
function extractLifecycleBody(hookName) {
  const idx = jsSource.indexOf(`${hookName}() {`);
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
// 1. In-progress feature cards show real-time timer (nowTick - createdAt)
// =====================================================================
describe('in-progress feature cards — real-time timer', () => {
  it('nowTick data property exists', () => {
    expect(jsSource).toContain('nowTick:');
  });

  it('nowTick initialized with Date.now()', () => {
    expect(jsSource).toContain('nowTick: Date.now()');
  });

  it('in-progress template uses formatDuration(nowTick - feature.createdAt)', () => {
    const inProgressBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.inProgress"'),
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"')
    );
    expect(inProgressBlock).toContain('formatDuration(nowTick - feature.createdAt)');
  });

  it('in-progress elapsed span has v-if="feature.createdAt" guard', () => {
    const inProgressBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.inProgress"'),
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"')
    );
    expect(inProgressBlock).toContain('v-if="feature.createdAt"');
  });

  it('in-progress elapsed span uses crew-feature-card-elapsed class', () => {
    const inProgressBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.inProgress"'),
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"')
    );
    expect(inProgressBlock).toContain('crew-feature-card-elapsed');
  });

  it('mounted hook sets up 1-second interval for nowTick', () => {
    const mountedBody = extractLifecycleBody('mounted');
    expect(mountedBody).toContain('setInterval');
    expect(mountedBody).toContain('this.nowTick = Date.now()');
    expect(mountedBody).toContain('1000');
  });

  it('interval stored as this._elapsedTimer', () => {
    const mountedBody = extractLifecycleBody('mounted');
    expect(mountedBody).toContain('this._elapsedTimer');
  });
});

// =====================================================================
// 2. Completed feature cards show fixed total elapsed time
// =====================================================================
describe('completed feature cards — fixed total elapsed time', () => {
  it('completed template uses formatDuration(lastActivityAt - createdAt)', () => {
    const completedBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"'),
      jsSource.indexOf('<!-- Empty state -->')
    );
    expect(completedBlock).toContain('formatDuration(feature.lastActivityAt - feature.createdAt)');
  });

  it('completed elapsed span has guard for both createdAt and lastActivityAt', () => {
    const completedBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"'),
      jsSource.indexOf('<!-- Empty state -->')
    );
    expect(completedBlock).toContain('v-if="feature.createdAt && feature.lastActivityAt"');
  });

  it('completed elapsed span uses crew-feature-card-elapsed class', () => {
    const completedBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"'),
      jsSource.indexOf('<!-- Empty state -->')
    );
    expect(completedBlock).toContain('crew-feature-card-elapsed');
  });

  it('completed cards do NOT use nowTick (static time)', () => {
    const completedBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"'),
      jsSource.indexOf('<!-- Empty state -->')
    );
    expect(completedBlock).not.toContain('nowTick');
  });
});

// =====================================================================
// 3. formatDuration method — format correctness
// =====================================================================
describe('formatDuration method — format correctness', () => {
  let body;
  beforeAll(() => {
    body = extractMethod('formatDuration');
  });

  it('should exist as a method', () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it('accepts ms parameter', () => {
    expect(jsSource).toContain('formatDuration(ms)');
  });

  it('returns empty string for falsy or negative ms', () => {
    expect(body).toContain("!ms || ms < 0");
    expect(body).toContain("return ''");
  });

  it('converts ms to seconds with Math.floor', () => {
    expect(body).toContain('Math.floor(ms / 1000)');
  });

  it('< 1 minute: returns "Xs" format', () => {
    // s < 60 → s + 's'
    expect(body).toContain("s < 60");
    expect(body).toContain("s + 's'");
  });

  it('< 1 hour: returns "Xm Ys" format', () => {
    // m < 60 → m + 'm ' + (s % 60) + 's'
    expect(body).toContain("m < 60");
    expect(body).toContain("m + 'm '");
    expect(body).toContain("(s % 60) + 's'");
  });

  it('>= 1 hour: returns "Xh Ym" format', () => {
    // h + 'h ' + (m % 60) + 'm'
    expect(body).toContain("h + 'h '");
    expect(body).toContain("(m % 60) + 'm'");
  });

  it('uses Math.floor for all time unit conversions', () => {
    expect(body).toContain('Math.floor(ms / 1000)');
    expect(body).toContain('Math.floor(s / 60)');
    expect(body).toContain('Math.floor(m / 60)');
  });

  it('format logic covers three tiers: seconds, minutes+seconds, hours+minutes', () => {
    // Three return statements for three tiers
    const returns = body.match(/return /g) || [];
    expect(returns.length).toBe(4); // 1 early return for falsy + 3 format returns
  });
});

// =====================================================================
// 4. Interval cleanup on component unmount (no memory leak)
// =====================================================================
describe('interval cleanup on component unmount', () => {
  it('beforeUnmount hook exists', () => {
    expect(jsSource).toContain('beforeUnmount()');
  });

  it('beforeUnmount clears _elapsedTimer with clearInterval', () => {
    const unmountBody = extractLifecycleBody('beforeUnmount');
    expect(unmountBody).toContain('clearInterval(this._elapsedTimer)');
  });

  it('clearInterval guarded by if check', () => {
    const unmountBody = extractLifecycleBody('beforeUnmount');
    expect(unmountBody).toContain('if (this._elapsedTimer)');
  });

  it('both mounted and beforeUnmount reference _elapsedTimer', () => {
    const mountedBody = extractLifecycleBody('mounted');
    const unmountBody = extractLifecycleBody('beforeUnmount');
    expect(mountedBody).toContain('_elapsedTimer');
    expect(unmountBody).toContain('_elapsedTimer');
  });
});

// =====================================================================
// 5. lastActivityAt data flow through featureKanban
// =====================================================================
describe('lastActivityAt data flow', () => {
  let kanbanBody;
  beforeAll(() => {
    kanbanBody = extractMethod('featureKanban');
  });

  it('featureKanban initializes lastActivityAt: 0 for activeTasks features', () => {
    expect(kanbanBody).toContain('lastActivityAt: 0');
  });

  it('featureKanban initializes lastActivityAt: 0 for fallback features', () => {
    // Two occurrences of lastActivityAt: 0 — one for activeTasks, one for todosByFeature fallback
    const matches = kanbanBody.match(/lastActivityAt: 0/g) || [];
    expect(matches.length).toBe(2);
  });

  it('featureKanban merges lastActivityAt from featureBlocks', () => {
    expect(kanbanBody).toContain('block.lastActivityAt');
    expect(kanbanBody).toContain('feature.lastActivityAt');
  });

  it('featureKanban uses max comparison for lastActivityAt', () => {
    expect(kanbanBody).toContain('block.lastActivityAt > feature.lastActivityAt');
  });

  it('_rebuildBlocksFromSegments sets lastActivityAt from last message timestamp', () => {
    expect(jsSource).toContain('lastActivityAt: seg.messages[seg.messages.length - 1]?.timestamp || 0');
  });
});

// =====================================================================
// 6. CSS — elapsed time display styles
// =====================================================================
describe('CSS — crew-feature-card-elapsed styles', () => {
  it('should have .crew-feature-card-elapsed rule', () => {
    expect(cssSource).toContain('.crew-feature-card-elapsed');
  });

  it('should have small font size', () => {
    const block = extractCssBlock('.crew-feature-card-elapsed {');
    expect(block).toContain('font-size: 10px');
  });

  it('should use muted color', () => {
    const block = extractCssBlock('.crew-feature-card-elapsed {');
    expect(block).toContain('var(--text-muted)');
  });

  it('should push to the right with margin-left: auto', () => {
    const block = extractCssBlock('.crew-feature-card-elapsed {');
    expect(block).toContain('margin-left: auto');
  });

  it('should prevent shrinking', () => {
    const block = extractCssBlock('.crew-feature-card-elapsed {');
    expect(block).toContain('flex-shrink: 0');
  });

  it('should use tabular numbers for stable width', () => {
    const block = extractCssBlock('.crew-feature-card-elapsed {');
    expect(block).toContain('font-variant-numeric: tabular-nums');
  });

  it('should have reduced opacity', () => {
    const block = extractCssBlock('.crew-feature-card-elapsed {');
    expect(block).toContain('opacity: 0.7');
  });
});

// =====================================================================
// 7. Structural integrity
// =====================================================================
describe('structural integrity', () => {
  it('CSS has balanced braces (2085/2085)', () => {
    const opens = (cssSource.match(/\{/g) || []).length;
    const closes = (cssSource.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(2085);
  });

  it('JS template has balanced div tags', () => {
    const opens = (jsSource.match(/<div[\s>]/g) || []).length;
    const closes = (jsSource.match(/<\/div>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('all test files use same CSS brace count', () => {
    const agentTestPath = resolve(__dirname, '../../test/agent/crew.test.js');
    const agentTestSource = readFileSync(agentTestPath, 'utf-8');
    expect(agentTestSource).toContain('expect(opens).toBe(2085)');

    const rmTestPath = resolve(__dirname, '../../test/web/crew-remove-maxwidth.test.js');
    const rmTestSource = readFileSync(rmTestPath, 'utf-8');
    expect(rmTestSource).toContain('expect(opens).toBe(2085)');

    const scrollTestPath = resolve(__dirname, '../../test/web/crew-scroll-to-role.test.js');
    const scrollTestSource = readFileSync(scrollTestPath, 'utf-8');
    expect(scrollTestSource).toContain('expect(opens).toBe(2085)');

    const kanbanTestPath = resolve(__dirname, '../../test/web/crew-feature-kanban-groups.test.js');
    const kanbanTestSource = readFileSync(kanbanTestPath, 'utf-8');
    expect(kanbanTestSource).toContain('expect(opens).toBe(2085)');
  });
});

// =====================================================================
// 8. Template placement — elapsed spans in correct positions
// =====================================================================
describe('template placement of elapsed time spans', () => {
  it('in-progress elapsed span is inside crew-feature-card-header', () => {
    // The elapsed span should be a sibling of crew-feature-card-count inside the header
    const inProgressBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.inProgress"'),
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"')
    );
    const headerStart = inProgressBlock.indexOf('crew-feature-card-header');
    const elapsedPos = inProgressBlock.indexOf('crew-feature-card-elapsed');
    const countPos = inProgressBlock.indexOf('crew-feature-card-count');
    // elapsed is after count, both inside header
    expect(elapsedPos).toBeGreaterThan(countPos);
    expect(elapsedPos).toBeGreaterThan(headerStart);
  });

  it('completed elapsed span is inside crew-feature-card-header', () => {
    const completedBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"'),
      jsSource.indexOf('<!-- Empty state -->')
    );
    const headerStart = completedBlock.indexOf('crew-feature-card-header');
    const elapsedPos = completedBlock.indexOf('crew-feature-card-elapsed');
    const countPos = completedBlock.indexOf('crew-feature-card-count');
    expect(elapsedPos).toBeGreaterThan(countPos);
    expect(elapsedPos).toBeGreaterThan(headerStart);
  });

  it('exactly 2 crew-feature-card-elapsed spans in template', () => {
    const matches = jsSource.match(/crew-feature-card-elapsed/g) || [];
    // 2 in template (in-progress + completed)
    expect(matches.length).toBe(2);
  });
});
