import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #279 — Fix feature panel disappearing features (task-103).
 *
 * Validates core business logic:
 * 1. filteredFeatures: all features shown, sorted (with-messages first, then by lastActivityAt)
 * 2. kanbanFeatureCount: equals total feature count (not just features with messages)
 * 3. expandedFeatureTitle: falls back to kanban feature title when no message block exists
 * 4. Empty feature visual distinction: is-empty class + dashed border CSS
 * 5. Expanded mode shows "暂无消息" for empty features
 * 6. i18n key crew.noMessages exists in both languages
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

// =====================================================================
// Extract filteredFeatures sorting logic for unit testing
// =====================================================================

/**
 * Simulates filteredFeatures sorting.
 * @param {Array} features - kanban features: { taskId, lastActivityAt, ... }
 * @param {Function} hasMessages - (taskId) => boolean
 */
function sortFeatures(features, hasMessages) {
  return [...features].sort((a, b) => {
    const aHas = hasMessages(a.taskId) ? 1 : 0;
    const bHas = hasMessages(b.taskId) ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas; // features with messages first
    return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
  });
}

/**
 * Simulates kanbanFeatureCount — now just total count.
 */
function kanbanFeatureCount(features) {
  return features.length;
}

/**
 * Simulates expandedFeatureTitle fallback logic.
 */
function expandedFeatureTitle(expandedTaskId, expandedBlock, featureKanban) {
  if (!expandedTaskId) return '';
  if (expandedBlock) return expandedBlock.taskTitle || expandedTaskId;
  const feature = featureKanban.find(f => f.taskId === expandedTaskId);
  return feature?.taskTitle || expandedTaskId;
}

// =====================================================================
// 1. filteredFeatures: all features shown, messages-first sort
// =====================================================================
describe('filteredFeatures: all features shown with correct sort order', () => {

  it('returns all features regardless of message state', () => {
    const features = [
      { taskId: 't1', lastActivityAt: 100 },
      { taskId: 't2', lastActivityAt: 200 },
      { taskId: 't3', lastActivityAt: 300 }
    ];
    const hasMessages = () => false; // none have messages
    const result = sortFeatures(features, hasMessages);
    expect(result).toHaveLength(3);
  });

  it('features with messages sort before those without', () => {
    const features = [
      { taskId: 'empty-1', lastActivityAt: 500 },
      { taskId: 'has-msg', lastActivityAt: 100 },
      { taskId: 'empty-2', lastActivityAt: 300 }
    ];
    const hasMessages = (id) => id === 'has-msg';
    const result = sortFeatures(features, hasMessages);
    expect(result[0].taskId).toBe('has-msg');
  });

  it('within same message-state group, sorts by lastActivityAt descending', () => {
    const features = [
      { taskId: 't1', lastActivityAt: 100 },
      { taskId: 't2', lastActivityAt: 300 },
      { taskId: 't3', lastActivityAt: 200 }
    ];
    const hasMessages = (id) => id === 't1' || id === 't2' || id === 't3';
    const result = sortFeatures(features, hasMessages);
    expect(result[0].taskId).toBe('t2'); // 300
    expect(result[1].taskId).toBe('t3'); // 200
    expect(result[2].taskId).toBe('t1'); // 100
  });

  it('empty features sort among themselves by lastActivityAt', () => {
    const features = [
      { taskId: 'e1', lastActivityAt: 50 },
      { taskId: 'e2', lastActivityAt: 150 },
      { taskId: 'msg', lastActivityAt: 10 }
    ];
    const hasMessages = (id) => id === 'msg';
    const result = sortFeatures(features, hasMessages);
    expect(result[0].taskId).toBe('msg');   // has messages → first
    expect(result[1].taskId).toBe('e2');    // 150
    expect(result[2].taskId).toBe('e1');    // 50
  });

  it('handles features with no lastActivityAt (treat as 0)', () => {
    const features = [
      { taskId: 't1', lastActivityAt: undefined },
      { taskId: 't2', lastActivityAt: 100 }
    ];
    const hasMessages = () => true;
    const result = sortFeatures(features, hasMessages);
    expect(result[0].taskId).toBe('t2');
    expect(result[1].taskId).toBe('t1');
  });

  it('handles large number of features (96+)', () => {
    const features = Array.from({ length: 100 }, (_, i) => ({
      taskId: `task-${i}`,
      lastActivityAt: i * 10
    }));
    const hasMessages = (id) => parseInt(id.split('-')[1]) % 2 === 0;
    const result = sortFeatures(features, hasMessages);
    expect(result).toHaveLength(100);
    // First half should be even-numbered (have messages)
    const firstWithMsg = result.findIndex(f => !hasMessages(f.taskId));
    expect(firstWithMsg).toBe(50); // 50 with messages, then 50 without
  });
});

// =====================================================================
// 2. kanbanFeatureCount: total count (not filtered)
// =====================================================================
describe('kanbanFeatureCount: counts all features', () => {

  it('returns total feature count', () => {
    const features = [{ taskId: 't1' }, { taskId: 't2' }, { taskId: 't3' }];
    expect(kanbanFeatureCount(features)).toBe(3);
  });

  it('returns 0 for empty array', () => {
    expect(kanbanFeatureCount([])).toBe(0);
  });

  it('counts features regardless of message state', () => {
    // Even if none have messages, count is still the total
    const features = Array.from({ length: 96 }, (_, i) => ({ taskId: `t-${i}` }));
    expect(kanbanFeatureCount(features)).toBe(96);
  });
});

// =====================================================================
// 3. expandedFeatureTitle: fallback logic
// =====================================================================
describe('expandedFeatureTitle: fallback to kanban feature', () => {

  it('returns empty string when no expandedTaskId', () => {
    expect(expandedFeatureTitle(null, null, [])).toBe('');
    expect(expandedFeatureTitle('', null, [])).toBe('');
  });

  it('returns block title when expandedBlock exists', () => {
    const block = { taskTitle: 'Implement login' };
    expect(expandedFeatureTitle('task-1', block, [])).toBe('Implement login');
  });

  it('returns taskId when block exists but has no taskTitle', () => {
    const block = { taskTitle: '' };
    expect(expandedFeatureTitle('task-1', block, [])).toBe('task-1');
  });

  it('falls back to kanban feature title when no block', () => {
    const kanban = [
      { taskId: 'task-1', taskTitle: '实现用户登录' },
      { taskId: 'task-2', taskTitle: '修复 bug' }
    ];
    expect(expandedFeatureTitle('task-1', null, kanban)).toBe('实现用户登录');
  });

  it('returns taskId when no block and no matching kanban feature', () => {
    expect(expandedFeatureTitle('task-99', null, [])).toBe('task-99');
  });

  it('returns taskId when kanban feature has no taskTitle', () => {
    const kanban = [{ taskId: 'task-1', taskTitle: undefined }];
    expect(expandedFeatureTitle('task-1', null, kanban)).toBe('task-1');
  });
});

// =====================================================================
// 4. Empty feature visual: CSS and template
// =====================================================================
describe('empty feature visual distinction', () => {
  const css = read('web/styles/crew-workspace.css');
  const fpSrc = read('web/components/crew/CrewFeaturePanel.js');

  it('.crew-feature-card.is-empty has dashed border', () => {
    const match = css.match(/\.crew-feature-card\.is-empty\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toContain('border-style: dashed');
  });

  it('.crew-feature-card.is-empty has reduced opacity', () => {
    const match = css.match(/\.crew-feature-card\.is-empty\s*\{([^}]+)\}/);
    expect(match[1]).toContain('opacity');
  });

  it('template applies is-empty class based on hasFeatureMessages', () => {
    expect(fpSrc).toContain("'is-empty': !hasFeatureMessages(feature.taskId)");
  });
});

// =====================================================================
// 5. Expanded empty feature shows "暂无消息"
// =====================================================================
describe('expanded empty feature shows no-messages text', () => {
  const fpSrc = read('web/components/crew/CrewFeaturePanel.js');

  it('uses crew.noMessages i18n key in expanded empty state', () => {
    expect(fpSrc).toContain("$t('crew.noMessages')");
  });
});

// =====================================================================
// 6. i18n: crew.noMessages key
// =====================================================================
describe('i18n: crew.noMessages key', () => {
  const zhCN = read('web/i18n/zh-CN.js');
  const enUS = read('web/i18n/en.js');

  it('zh-CN has crew.noMessages', () => {
    expect(zhCN).toContain("'crew.noMessages'");
  });

  it('en has crew.noMessages', () => {
    expect(enUS).toContain("'crew.noMessages'");
  });

  it('zh-CN value is "暂无消息"', () => {
    expect(zhCN).toContain("'crew.noMessages': '暂无消息'");
  });

  it('en value is "No messages yet"', () => {
    expect(enUS).toContain("'crew.noMessages': 'No messages yet'");
  });
});
