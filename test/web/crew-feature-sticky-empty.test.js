import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for Feature panel — sticky header fix + feature filtering + completion detection.
 *
 * Verification points:
 * 1) Sticky header blocks content bleed — top:-12px + padding-top:24px
 * 2) Features filtered: keep those with messages/todos/streaming/activity, drop empty shells
 * 3) Two groups: filteredInProgress + filteredCompleted (collapsed by default)
 * 4) isFeatureCompleted detects merge/tag keywords in decision maker messages
 * 5) ChatHeader badge (kanbanFeatureCount) counts filtered features
 */

let cssSource;
let featurePanelSource;
let chatViewSource;

beforeAll(() => {
  const cssPath = resolve(__dirname, '../../web/styles/crew-workspace.css');
  cssSource = readFileSync(cssPath, 'utf-8');
  const fpPath = resolve(__dirname, '../../web/components/crew/CrewFeaturePanel.js');
  featurePanelSource = readFileSync(fpPath, 'utf-8');
  const cvPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  chatViewSource = readFileSync(cvPath, 'utf-8');
});

// =====================================================================
// 1. Sticky header blocks content bleed through parent padding
// =====================================================================
describe('sticky header content bleed fix', () => {
  it('header uses negative top offset to cover parent scroll padding', () => {
    const headerBlock = cssSource.substring(
      cssSource.indexOf('.crew-feature-expanded-header {'),
      cssSource.indexOf('}', cssSource.indexOf('.crew-feature-expanded-header {')) + 1
    );
    expect(headerBlock).toContain('top: -12px');
  });

  it('header has extra padding-top to compensate for negative offset', () => {
    const headerBlock = cssSource.substring(
      cssSource.indexOf('.crew-feature-expanded-header {'),
      cssSource.indexOf('}', cssSource.indexOf('.crew-feature-expanded-header {')) + 1
    );
    expect(headerBlock).toContain('padding-top: 24px');
  });

  it('header remains sticky with z-index for layering', () => {
    const headerBlock = cssSource.substring(
      cssSource.indexOf('.crew-feature-expanded-header {'),
      cssSource.indexOf('}', cssSource.indexOf('.crew-feature-expanded-header {')) + 1
    );
    expect(headerBlock).toContain('position: sticky');
    expect(headerBlock).toContain('z-index: 10');
  });

  it('header has opaque background to fully occlude scrolled content', () => {
    const headerBlock = cssSource.substring(
      cssSource.indexOf('.crew-feature-expanded-header {'),
      cssSource.indexOf('}', cssSource.indexOf('.crew-feature-expanded-header {')) + 1
    );
    expect(headerBlock).toContain('background: var(--bg-main)');
  });
});

// =====================================================================
// 2. Features filtered and split into inProgress/completed groups
// =====================================================================
describe('feature filtering and grouping', () => {
  it('filteredFeatures filters empty shells before sorting', () => {
    expect(featurePanelSource).toContain('filteredFeatures()');
    expect(featurePanelSource).toContain('.filter(f =>');
    expect(featurePanelSource).toContain('.sort((a, b) =>');
  });

  it('filter keeps features with messages', () => {
    expect(featurePanelSource).toContain('this.hasFeatureMessages(f.taskId)) return true');
  });

  it('filter keeps features with todo progress', () => {
    expect(featurePanelSource).toContain('f.totalCount > 0) return true');
  });

  it('filter keeps features that are streaming', () => {
    expect(featurePanelSource).toContain('f.hasStreaming) return true');
  });

  it('filter keeps features with activity', () => {
    expect(featurePanelSource).toContain('f.lastActivityAt > 0) return true');
  });

  it('filter drops empty shells (returns false)', () => {
    // After all checks, return false for empty shells
    expect(featurePanelSource).toContain('return false;');
  });

  it('sort prioritizes features with messages first', () => {
    expect(featurePanelSource).toContain('this.hasFeatureMessages(a.taskId)');
  });

  it('filteredInProgress filters out completed features', () => {
    expect(featurePanelSource).toContain('filteredInProgress()');
    expect(featurePanelSource).toContain('!this.isFeatureCompleted(f)');
  });

  it('filteredCompleted keeps only completed features', () => {
    expect(featurePanelSource).toContain('filteredCompleted()');
    expect(featurePanelSource).toContain('this.isFeatureCompleted(f)');
  });

  it('v-for uses filteredInProgress for active group', () => {
    expect(featurePanelSource).toContain('v-for="feature in filteredInProgress"');
  });

  it('v-for uses filteredCompleted for completed group', () => {
    expect(featurePanelSource).toContain('v-for="feature in filteredCompleted"');
  });

  it('completed group is collapsible (showCompletedFeatures toggle)', () => {
    expect(featurePanelSource).toContain('showCompletedFeatures');
    expect(featurePanelSource).toContain('v-if="showCompletedFeatures"');
  });
});

// =====================================================================
// 3. isFeatureCompleted method detects merge keywords
// =====================================================================
describe('isFeatureCompleted detection', () => {
  it('method exists in CrewFeaturePanel', () => {
    expect(featurePanelSource).toContain('isFeatureCompleted(feature)');
  });

  it('returns false for streaming features', () => {
    expect(featurePanelSource).toContain('feature.hasStreaming');
  });

  it('uses merge/tag pattern to detect completion', () => {
    expect(featurePanelSource).toContain('MERGE_PATTERN');
    expect(featurePanelSource).toContain('isDecisionMaker');
  });
});

// =====================================================================
// 4. ChatHeader badge (kanbanFeatureCount) counts filtered features
// =====================================================================
describe('ChatHeader badge counts filtered features', () => {
  it('kanbanFeatureCount filters by signals before counting', () => {
    expect(chatViewSource).toContain('kanbanFeatureCount()');
    expect(chatViewSource).toContain('this.featureKanban.filter(f =>');
  });

  it('kanbanFeatureCount keeps features with todo progress', () => {
    expect(chatViewSource).toContain('f.totalCount > 0');
  });

  it('kanbanFeatureCount keeps features with streaming', () => {
    expect(chatViewSource).toContain('f.hasStreaming');
  });

  it('kanbanFeatureCount keeps features with activity', () => {
    expect(chatViewSource).toContain('f.lastActivityAt > 0');
  });
});

// =====================================================================
// 5. hasFeatureMessages method still exists (used by sorting and styling)
// =====================================================================
describe('hasFeatureMessages method preserved', () => {
  it('method exists in CrewFeaturePanel', () => {
    expect(featurePanelSource).toContain('hasFeatureMessages(taskId)');
  });
});

// =====================================================================
// 6. Empty features get visual distinction
// =====================================================================
describe('empty feature visual distinction', () => {
  it('feature card applies is-empty class for features without messages', () => {
    expect(featurePanelSource).toContain("'is-empty': !hasFeatureMessages(feature.taskId)");
  });

  it('CSS defines dashed border for empty feature cards', () => {
    expect(cssSource).toContain('.crew-feature-card.is-empty');
    expect(cssSource).toContain('border-style: dashed');
  });
});

// =====================================================================
// 7. Expanded mode title falls back to kanban feature
// =====================================================================
describe('expanded mode title fallback', () => {
  it('expandedFeatureTitle falls back to kanban feature title when no block', () => {
    expect(featurePanelSource).toContain('featureKanban.find(f => f.taskId === this.expandedFeatureTaskId)');
    expect(featurePanelSource).toContain('feature?.taskTitle');
  });
});
