import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadAllCss } from '../helpers/loadCss.js';

/**
 * Tests for dev-3/feature-kanban-groups: Feature panel grouping & sorting optimization.
 *
 * Verifies:
 * 1) In-progress features displayed below total progress in the most prominent position
 * 2) Completed features collapsed by default, click to expand/collapse
 * 3) Both groups sorted by time descending (newest first)
 * 4) Double-click feature card still jumps to chat area position
 * 5) CSS styles for kanban groups
 * 6) Structural integrity (brace counts, div balance)
 */

let jsSource;
let cssSource;

beforeAll(() => {
  const jsPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  jsSource = readFileSync(jsPath, 'utf-8');
  // Sub-modules extracted from CrewChatView during refactor
  const crewDir = resolve(__dirname, '../../web/components/crew');
  for (const mod of ['crewHelpers.js', 'crewMessageGrouping.js', 'crewKanban.js', 'crewRolePresets.js', 'CrewTurnRenderer.js', 'CrewFeaturePanel.js', 'CrewRolePanel.js', 'crewInput.js', 'crewScroll.js']) {
    jsSource += '\n' + readFileSync(resolve(crewDir, mod), 'utf-8');
  }

  cssSource = loadAllCss();
});

/**
 * Extract a method body from the JS source — finds the longest match
 * to get the implementation, not a thin wrapper.
 */
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

// =====================================================================
// 1. featureKanbanGrouped computed — grouping logic
// =====================================================================
describe('featureKanbanGrouped computed property', () => {
  let body;
  beforeAll(() => {
    body = extractMethod('groupKanban');
  });

  it('should exist as a computed property', () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it('should create inProgress and completed arrays', () => {
    expect(body).toContain('inProgress');
    expect(body).toContain('completed');
  });

  it('should iterate over featureKanban', () => {
    expect(body).toContain('featureKanban');
  });

  it('should check isCompleted to split groups', () => {
    expect(body).toContain('f.isCompleted');
  });

  it('should return object with inProgress and completed keys', () => {
    expect(body).toContain('return');
    expect(body).toContain('inProgress');
    expect(body).toContain('completed');
  });
});

// =====================================================================
// 2. featureKanban computed — createdAt sorting
// =====================================================================
describe('featureKanban computed — time-based sorting', () => {
  let body;
  beforeAll(() => {
    body = extractMethod('buildFeatureKanban');
  });

  it('should include createdAt in feature objects', () => {
    expect(body).toContain('createdAt');
  });

  it('should sort by createdAt descending (newest first)', () => {
    expect(body).toContain('b.createdAt');
    expect(body).toContain('a.createdAt');
    // Sort expression: (b.createdAt || 0) - (a.createdAt || 0)
    expect(body).toMatch(/b\.createdAt.*-.*a\.createdAt/);
  });

  it('should NOT sort by hasStreaming or isCompleted (old logic removed)', () => {
    expect(body).not.toContain('a.hasStreaming');
    expect(body).not.toContain('b.hasStreaming');
    // isCompleted used for setting field, but not in sort
    expect(body).not.toMatch(/sort.*isCompleted/);
  });
});

// =====================================================================
// 3. activeTasks — createdAt data source
// =====================================================================
describe('activeTasks computed — createdAt propagation', () => {
  let body;
  beforeAll(() => {
    body = extractMethod('collectActiveTasks');
  });

  it('should extract createdAt from persisted features', () => {
    expect(body).toContain('f.createdAt');
  });

  it('should fallback to timestamp for message-based tasks', () => {
    expect(body).toContain('msg.timestamp');
  });

  it('should return objects with createdAt field', () => {
    expect(body).toContain('createdAt: info.createdAt');
  });
});

// =====================================================================
// 4. Template — In-Progress group rendered first (below total progress)
// =====================================================================
describe('template — in-progress features in prominent position', () => {
  it('should have crew-kanban-group containers', () => {
    expect(jsSource).toContain('class="crew-kanban-group"');
  });

  it('should iterate over featureKanbanGrouped.inProgress', () => {
    expect(jsSource).toContain('v-for="feature in featureKanbanGrouped.inProgress"');
  });

  it('should show in-progress group header with active dot', () => {
    expect(jsSource).toContain('crew-kanban-group-header is-active');
    expect(jsSource).toContain('crew-kanban-group-dot is-active');
  });

  it('should display in-progress count', () => {
    expect(jsSource).toContain('featureKanbanGrouped.inProgress.length');
  });

  it('in-progress group appears before completed group in template', () => {
    const inProgressIdx = jsSource.indexOf('featureKanbanGrouped.inProgress');
    const completedIdx = jsSource.indexOf('featureKanbanGrouped.completed');
    expect(inProgressIdx).toBeLessThan(completedIdx);
  });

  it('in-progress group appears after total progress bar', () => {
    // Search within CrewFeaturePanel template where both patterns live
    const panelStart = jsSource.indexOf("name: 'CrewFeaturePanel'");
    const totalProgressIdx = jsSource.indexOf('crew-kanban-total', panelStart);
    const inProgressIdx = jsSource.indexOf('featureKanbanGrouped.inProgress', panelStart);
    expect(totalProgressIdx).toBeLessThan(inProgressIdx);
  });

  it('in-progress cards do not have is-completed class', () => {
    // Find the inProgress v-for block and check it doesn't add is-completed
    const inProgressBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.inProgress"'),
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"')
    );
    expect(inProgressBlock).not.toContain("'is-completed'");
  });

  it('in-progress cards have has-streaming binding', () => {
    const inProgressBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.inProgress"'),
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"')
    );
    expect(inProgressBlock).toContain("'has-streaming': feature.hasStreaming");
  });
});

// =====================================================================
// 5. Template — Completed group collapsed by default
// =====================================================================
describe('template — completed features collapsed by default', () => {
  it('should have showCompletedFeatures data property', () => {
    expect(jsSource).toContain('showCompletedFeatures');
  });

  it('showCompletedFeatures defaults to false', () => {
    expect(jsSource).toContain('showCompletedFeatures: false');
  });

  it('should iterate over featureKanbanGrouped.completed', () => {
    expect(jsSource).toContain('v-for="feature in featureKanbanGrouped.completed"');
  });

  it('completed group header has click handler to toggle', () => {
    expect(jsSource).toContain('@click="showCompletedFeatures = !showCompletedFeatures"');
  });

  it('completed group header shows is-completed class', () => {
    expect(jsSource).toContain('crew-kanban-group-header is-completed');
  });

  it('completed group uses v-if="showCompletedFeatures" for content', () => {
    expect(jsSource).toContain('v-if="showCompletedFeatures"');
  });

  it('completed group wrapped in template tag for conditional rendering', () => {
    // The completed cards are inside <template v-if="showCompletedFeatures">
    const completedSection = jsSource.substring(
      jsSource.indexOf('crew-kanban-group-header is-completed'),
      jsSource.indexOf('<!-- Empty state -->')
    );
    expect(completedSection).toContain('<template v-if="showCompletedFeatures">');
    expect(completedSection).toContain('</template>');
  });

  it('completed cards have is-completed class', () => {
    expect(jsSource).toContain('crew-feature-card is-completed');
  });

  it('completed group header has chevron with is-expanded binding', () => {
    expect(jsSource).toContain("'is-expanded': showCompletedFeatures");
  });

  it('completed group shows count', () => {
    expect(jsSource).toContain('featureKanbanGrouped.completed.length');
  });

  it('completed feature card empty state uses i18n crew.statusCompleted', () => {
    const completedSection = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"'),
      jsSource.indexOf('<!-- Empty state -->')
    );
    expect(completedSection).toContain('crew.statusCompleted');
  });

  it('in-progress feature card empty state uses i18n crew.statusInProgress', () => {
    const inProgressSection = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.inProgress"'),
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"')
    );
    expect(inProgressSection).toContain('crew.statusInProgress');
  });
});

// =====================================================================
// 6. Double-click feature card still works (scrollToFeature preserved)
// =====================================================================
describe('double-click feature card — scrollToFeature integration', () => {
  it('in-progress cards have @dblclick handler for scrollToFeature', () => {
    const inProgressBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.inProgress"'),
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"')
    );
    // Sub-component emits event, parent handles scrollToFeature
    expect(inProgressBlock).toContain("@dblclick=\"$emit('scroll-to-feature', feature.taskId)\"");
  });

  it('completed cards have @dblclick handler for scrollToFeature', () => {
    const completedBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"'),
      jsSource.indexOf('<!-- Empty state -->')
    );
    expect(completedBlock).toContain("@dblclick=\"$emit('scroll-to-feature', feature.taskId)\"");
  });

  it('scrollToFeature method still exists', () => {
    const body = extractMethod('scrollToFeature');
    expect(body.length).toBeGreaterThan(0);
  });

  it('scrollToFeature uses scrollIntoView', () => {
    const body = extractMethod('scrollToFeature');
    expect(body).toContain('scrollIntoView');
  });

  it('both groups have @click="toggleFeatureCard(feature.taskId)" for single click', () => {
    const inProgressBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.inProgress"'),
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"')
    );
    const completedBlock = jsSource.substring(
      jsSource.indexOf('v-for="feature in featureKanbanGrouped.completed"'),
      jsSource.indexOf('<!-- Empty state -->')
    );
    expect(inProgressBlock).toContain('@click="toggleFeatureCard(feature.taskId)"');
    expect(completedBlock).toContain('@click="toggleFeatureCard(feature.taskId)"');
  });
});
// =====================================================================
// 9. Data flow — createdAt field propagation chain
// =====================================================================
describe('createdAt data flow through computed chain', () => {
  it('activeTasks passes createdAt from persistedFeatures', () => {
    const body = extractMethod('collectActiveTasks');
    expect(body).toContain('createdAt: f.createdAt');
  });

  it('activeTasks uses msg.timestamp as fallback createdAt', () => {
    const body = extractMethod('collectActiveTasks');
    expect(body).toContain('createdAt: msg.timestamp');
  });

  it('featureKanban sets createdAt from task.createdAt', () => {
    const body = extractMethod('buildFeatureKanban');
    expect(body).toContain('createdAt: task.createdAt || 0');
  });

  it('fallback features get createdAt: 0', () => {
    const body = extractMethod('buildFeatureKanban');
    // Features created from todosByFeature (not in activeTasks) get createdAt: 0
    expect(body).toContain('createdAt: 0');
  });
});

// =====================================================================
// 10. Old template pattern removed
// =====================================================================
describe('old single-list template pattern removed', () => {
  it('should NOT have v-for="feature in featureKanban" (old pattern)', () => {
    // The template should NOT directly iterate featureKanban; it uses grouped version
    expect(jsSource).not.toMatch(/v-for="feature in featureKanban"/);
  });

  it('should NOT have old sorting by hasStreaming/isCompleted in featureKanban', () => {
    const body = extractMethod('featureKanban');
    expect(body).not.toContain('a.hasStreaming ? -1 : 1');
    expect(body).not.toContain('a.isCompleted ? 1 : -1');
  });

  it('should NOT have ternary for empty state text (old pattern)', () => {
    // Old: feature.isCompleted ? '已完成' : '进行中'
    // New: separate text in each group
    expect(jsSource).not.toContain("feature.isCompleted ? '已完成' : '进行中'");
  });
});
