import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #261 — sticky header content bleed fix + empty feature cleanup.
 *
 * Verification points:
 * 1) Sticky header blocks content bleed — top:-12px + padding-top:24px
 * 2) Empty features filtered out of inProgress/completed lists
 * 3) Group header counts use filtered data (filteredInProgress.length)
 * 4) Total progress bar uses filteredProgressData (excludes empty features)
 * 5) ChatHeader badge (kanbanInProgressCount) excludes empty features
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
    // .crew-feature-expanded-header should have top: -12px
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
// 2. Empty features filtered at data level (not just v-show)
// =====================================================================
describe('empty feature filtering at data level', () => {
  it('filteredInProgress computed filters via hasFeatureMessages', () => {
    expect(featurePanelSource).toContain('filteredInProgress()');
    expect(featurePanelSource).toContain(
      'this.featureKanbanGrouped.inProgress.filter'
    );
    expect(featurePanelSource).toContain('this.hasFeatureMessages(f.taskId)');
  });

  it('filteredCompleted computed filters via hasFeatureMessages', () => {
    expect(featurePanelSource).toContain('filteredCompleted()');
    expect(featurePanelSource).toContain(
      'this.featureKanbanGrouped.completed.filter'
    );
  });

  it('v-show removed from feature card iteration', () => {
    // Old pattern: v-show="hasFeatureMessages(feature.taskId)" in v-for loops
    // Should no longer exist since we filter at computed level
    expect(featurePanelSource).not.toContain('v-show="hasFeatureMessages');
  });

  it('v-for uses filteredInProgress instead of featureKanbanGrouped.inProgress', () => {
    expect(featurePanelSource).toContain('v-for="feature in filteredInProgress"');
    // The old unfiltered iteration should not be in v-for
    expect(featurePanelSource).not.toContain(
      'v-for="feature in featureKanbanGrouped.inProgress"'
    );
  });

  it('v-for uses filteredCompleted instead of featureKanbanGrouped.completed', () => {
    expect(featurePanelSource).toContain('v-for="feature in filteredCompleted"');
    expect(featurePanelSource).not.toContain(
      'v-for="feature in featureKanbanGrouped.completed"'
    );
  });
});

// =====================================================================
// 3. Group header counts use filtered data
// =====================================================================
describe('group header counts use filtered arrays', () => {
  it('inProgress group header shows filteredInProgress.length', () => {
    expect(featurePanelSource).toContain('filteredInProgress.length');
    // Group header condition also uses filtered
    expect(featurePanelSource).toContain('v-if="filteredInProgress.length > 0"');
  });

  it('completed group header shows filteredCompleted.length', () => {
    expect(featurePanelSource).toContain('filteredCompleted.length');
    expect(featurePanelSource).toContain('v-if="filteredCompleted.length > 0"');
  });
});

// =====================================================================
// 4. Total progress bar uses filteredProgressData
// =====================================================================
describe('total progress bar uses filteredProgressData', () => {
  it('filteredProgressData computed aggregates from filtered arrays', () => {
    expect(featurePanelSource).toContain('filteredProgressData()');
    // Aggregates totalCount and doneCount from both filtered arrays
    expect(featurePanelSource).toContain('this.filteredInProgress');
    expect(featurePanelSource).toContain('this.filteredCompleted');
    expect(featurePanelSource).toContain('f.totalCount');
    expect(featurePanelSource).toContain('f.doneCount');
  });

  it('progress bar condition uses filteredProgressData.total', () => {
    expect(featurePanelSource).toContain('filteredProgressData.total > 0');
  });

  it('progress bar display uses filteredProgressData done/total', () => {
    expect(featurePanelSource).toContain('filteredProgressData.done');
    expect(featurePanelSource).toContain('filteredProgressData.total');
  });

  it('percentage calculation uses filteredProgressData', () => {
    expect(featurePanelSource).toContain(
      'Math.round(filteredProgressData.done / filteredProgressData.total * 100)'
    );
  });

  it('progress bar width uses filteredProgressData', () => {
    expect(featurePanelSource).toContain(
      'filteredProgressData.done / filteredProgressData.total * 100'
    );
  });
});

// =====================================================================
// 5. ChatHeader badge (kanbanInProgressCount) excludes empty features
// =====================================================================
describe('ChatHeader badge excludes empty features', () => {
  it('kanbanInProgressCount filters features with no messages', () => {
    expect(chatViewSource).toContain('kanbanInProgressCount()');
    // It filters featureKanbanGrouped.inProgress
    expect(chatViewSource).toContain(
      'this.featureKanbanGrouped.inProgress.filter(f =>'
    );
  });

  it('kanbanInProgressCount checks featureBlocks for matching block', () => {
    // Finds the feature block by taskId
    expect(chatViewSource).toContain(
      "b.type === 'feature' && b.taskId === f.taskId"
    );
  });

  it('kanbanInProgressCount returns false for features with no block', () => {
    expect(chatViewSource).toContain('if (!block) return false');
  });

  it('kanbanInProgressCount checks turns length > 0', () => {
    expect(chatViewSource).toContain('turns && turns.length > 0');
  });
});

// =====================================================================
// 6. hasFeatureMessages method still exists (used by computed)
// =====================================================================
describe('hasFeatureMessages method preserved', () => {
  it('method exists in CrewFeaturePanel', () => {
    expect(featurePanelSource).toContain('hasFeatureMessages(taskId)');
  });
});
