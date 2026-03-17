import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #261 — sticky header content bleed fix + empty feature cleanup.
 *
 * Verification points:
 * 1) Sticky header blocks content bleed — top:-12px + padding-top:24px
 * 2) Features filtered at data level — flat list sorted by activity
 * 3) Header count uses filteredFeatures.length
 * 4) (Removed — total progress bar deleted)
 * 5) ChatHeader badge (kanbanFeatureCount) excludes empty features
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
// 2. Features filtered at data level — flat list sorted by activity
// =====================================================================
describe('feature filtering at data level', () => {
  it('filteredFeatures computed filters via hasFeatureMessages', () => {
    expect(featurePanelSource).toContain('filteredFeatures()');
    expect(featurePanelSource).toContain('this.hasFeatureMessages(f.taskId)');
  });

  it('v-show removed from feature card iteration', () => {
    expect(featurePanelSource).not.toContain('v-show="hasFeatureMessages');
  });

  it('v-for uses filteredFeatures (flat list)', () => {
    expect(featurePanelSource).toContain('v-for="feature in filteredFeatures"');
    // No separate inProgress/completed groups
    expect(featurePanelSource).not.toContain('v-for="feature in filteredInProgress"');
    expect(featurePanelSource).not.toContain('v-for="feature in filteredCompleted"');
  });
});

// =====================================================================
// 3. Header count uses filteredFeatures
// =====================================================================
describe('header count uses flat filtered list', () => {
  it('shows filteredFeatures.length in header', () => {
    expect(featurePanelSource).toContain('filteredFeatures.length');
  });
});

// =====================================================================
// 4. (Removed — total progress bar deleted per user request)
// =====================================================================

// =====================================================================
// 5. ChatHeader badge (kanbanFeatureCount) excludes empty features
// =====================================================================
describe('ChatHeader badge excludes empty features', () => {
  it('kanbanFeatureCount filters features with no messages', () => {
    expect(chatViewSource).toContain('kanbanFeatureCount()');
    expect(chatViewSource).toContain('this.featureKanban.filter(f =>');
  });

  it('kanbanFeatureCount checks featureBlocks for matching block', () => {
    expect(chatViewSource).toContain(
      "b.type === 'feature' && b.taskId === f.taskId"
    );
  });

  it('kanbanFeatureCount returns false for features with no block', () => {
    expect(chatViewSource).toContain('if (!block) return false');
  });

  it('kanbanFeatureCount checks turns length > 0', () => {
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
