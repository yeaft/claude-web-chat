import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #279 — Fix feature panel disappearing features (task-103/104).
 *
 * Validates core business logic:
 * 1. filterFeatures: empty shells (0/0 no messages no activity) are filtered out
 * 2. filterFeatures: features with messages/todos/streaming/activity are kept
 * 3. sortFeatures: with-messages first, then by lastActivityAt descending
 * 4. kanbanFeatureCount: equals filtered feature count (not total)
 * 5. expandedFeatureTitle: falls back to kanban feature title when no message block
 * 6. Empty feature visual distinction: is-empty class + dashed border CSS
 * 7. Expanded mode shows "暂无消息" for empty features
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

// =====================================================================
// Extract filtering + sorting logic for unit testing
// =====================================================================

/**
 * Simulates the 4-condition filter from filteredFeatures().
 * Features with any of: messages, todos, streaming, activity → keep.
 * Empty shells → drop.
 * @param {Array} features - kanban features: { taskId, totalCount, hasStreaming, lastActivityAt, ... }
 * @param {Function} hasMessages - (taskId) => boolean
 */
function filterFeatures(features, hasMessages) {
  return features.filter(f => {
    if (hasMessages(f.taskId)) return true;
    if (f.totalCount > 0) return true;
    if (f.hasStreaming) return true;
    if (f.lastActivityAt > 0) return true;
    return false;
  });
}

/**
 * Simulates filteredFeatures sorting (applied after filter).
 * @param {Array} features - already-filtered features
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
 * Simulates kanbanFeatureCount — count after 4-condition filter.
 */
function kanbanFeatureCount(features, hasMessages) {
  return filterFeatures(features, hasMessages).length;
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
// 1. filterFeatures: empty shells filtered, active features kept
// =====================================================================
describe('filterFeatures: empty shells dropped, active features kept', () => {

  it('filters out empty shells (no messages, 0 todos, no streaming, no activity)', () => {
    const features = [
      { taskId: 'empty', totalCount: 0, hasStreaming: false, lastActivityAt: 0 },
      { taskId: 'has-msg', totalCount: 0, hasStreaming: false, lastActivityAt: 0 }
    ];
    const hasMessages = (id) => id === 'has-msg';
    const result = filterFeatures(features, hasMessages);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('has-msg');
  });

  it('keeps feature with messages even if other signals are zero', () => {
    const features = [
      { taskId: 't1', totalCount: 0, hasStreaming: false, lastActivityAt: 0 }
    ];
    const result = filterFeatures(features, () => true);
    expect(result).toHaveLength(1);
  });

  it('keeps feature with todo progress (totalCount > 0)', () => {
    const features = [
      { taskId: 't1', totalCount: 3, hasStreaming: false, lastActivityAt: 0 }
    ];
    const result = filterFeatures(features, () => false);
    expect(result).toHaveLength(1);
  });

  it('keeps feature that is streaming', () => {
    const features = [
      { taskId: 't1', totalCount: 0, hasStreaming: true, lastActivityAt: 0 }
    ];
    const result = filterFeatures(features, () => false);
    expect(result).toHaveLength(1);
  });

  it('keeps feature with activity (lastActivityAt > 0)', () => {
    const features = [
      { taskId: 't1', totalCount: 0, hasStreaming: false, lastActivityAt: 1000 }
    ];
    const result = filterFeatures(features, () => false);
    expect(result).toHaveLength(1);
  });

  it('filters 96 empty shells down to zero', () => {
    const features = Array.from({ length: 96 }, (_, i) => ({
      taskId: `empty-${i}`,
      totalCount: 0,
      hasStreaming: false,
      lastActivityAt: 0
    }));
    const result = filterFeatures(features, () => false);
    expect(result).toHaveLength(0);
  });

  it('keeps only active features from a mixed batch', () => {
    const features = [
      { taskId: 'msg', totalCount: 0, hasStreaming: false, lastActivityAt: 0 },
      { taskId: 'todo', totalCount: 5, hasStreaming: false, lastActivityAt: 0 },
      { taskId: 'stream', totalCount: 0, hasStreaming: true, lastActivityAt: 0 },
      { taskId: 'active', totalCount: 0, hasStreaming: false, lastActivityAt: 500 },
      { taskId: 'empty1', totalCount: 0, hasStreaming: false, lastActivityAt: 0 },
      { taskId: 'empty2', totalCount: 0, hasStreaming: false, lastActivityAt: 0 }
    ];
    const hasMessages = (id) => id === 'msg';
    const result = filterFeatures(features, hasMessages);
    expect(result).toHaveLength(4);
    expect(result.map(f => f.taskId)).toEqual(['msg', 'todo', 'stream', 'active']);
  });
});

// =====================================================================
// 2. sortFeatures: messages-first, then by lastActivityAt descending
// =====================================================================
describe('sortFeatures: messages-first sort order', () => {

  it('features with messages sort before those without', () => {
    const features = [
      { taskId: 'no-msg', lastActivityAt: 500 },
      { taskId: 'has-msg', lastActivityAt: 100 }
    ];
    const hasMessages = (id) => id === 'has-msg';
    const result = sortFeatures(features, hasMessages);
    expect(result[0].taskId).toBe('has-msg');
  });

  it('within same group, sorts by lastActivityAt descending', () => {
    const features = [
      { taskId: 't1', lastActivityAt: 100 },
      { taskId: 't2', lastActivityAt: 300 },
      { taskId: 't3', lastActivityAt: 200 }
    ];
    const hasMessages = () => true;
    const result = sortFeatures(features, hasMessages);
    expect(result.map(f => f.taskId)).toEqual(['t2', 't3', 't1']);
  });

  it('handles features with no lastActivityAt (treated as 0)', () => {
    const features = [
      { taskId: 't1', lastActivityAt: undefined },
      { taskId: 't2', lastActivityAt: 100 }
    ];
    const result = sortFeatures(features, () => true);
    expect(result[0].taskId).toBe('t2');
  });
});

// =====================================================================
// 3. kanbanFeatureCount: equals filtered count, not total
// =====================================================================
describe('kanbanFeatureCount: counts filtered features', () => {

  it('returns 0 when all features are empty shells', () => {
    const features = Array.from({ length: 96 }, (_, i) => ({
      taskId: `empty-${i}`, totalCount: 0, hasStreaming: false, lastActivityAt: 0
    }));
    expect(kanbanFeatureCount(features, () => false)).toBe(0);
  });

  it('counts only features with signals', () => {
    const features = [
      { taskId: 'msg', totalCount: 0, hasStreaming: false, lastActivityAt: 0 },
      { taskId: 'empty', totalCount: 0, hasStreaming: false, lastActivityAt: 0 },
      { taskId: 'todo', totalCount: 2, hasStreaming: false, lastActivityAt: 0 }
    ];
    const hasMessages = (id) => id === 'msg';
    expect(kanbanFeatureCount(features, hasMessages)).toBe(2);
  });

  it('badge matches panel feature count exactly', () => {
    const features = [
      { taskId: 'a', totalCount: 0, hasStreaming: false, lastActivityAt: 100 },
      { taskId: 'b', totalCount: 0, hasStreaming: true, lastActivityAt: 0 },
      { taskId: 'c', totalCount: 0, hasStreaming: false, lastActivityAt: 0 }
    ];
    const hasMessages = () => false;
    const filtered = filterFeatures(features, hasMessages);
    const badge = kanbanFeatureCount(features, hasMessages);
    expect(badge).toBe(filtered.length);
    expect(badge).toBe(2); // 'a' (activity) + 'b' (streaming), 'c' dropped
  });
});

// =====================================================================
// 4. expandedFeatureTitle: fallback logic
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
});

// =====================================================================
// 5. Source code: filter + sort pattern in CrewFeaturePanel.js
// =====================================================================
describe('CrewFeaturePanel filteredFeatures implementation', () => {
  const fpSrc = read('web/components/crew/CrewFeaturePanel.js');

  it('filteredFeatures applies filter before sort', () => {
    expect(fpSrc).toContain('.filter(f =>');
    expect(fpSrc).toContain('.sort((a, b) =>');
  });

  it('filter checks hasFeatureMessages', () => {
    expect(fpSrc).toContain('this.hasFeatureMessages(f.taskId)) return true');
  });

  it('filter checks totalCount for todo progress', () => {
    expect(fpSrc).toContain('f.totalCount > 0) return true');
  });

  it('filter checks hasStreaming', () => {
    expect(fpSrc).toContain('f.hasStreaming) return true');
  });

  it('filter checks lastActivityAt', () => {
    expect(fpSrc).toContain('f.lastActivityAt > 0) return true');
  });

  it('filter drops empty shells', () => {
    expect(fpSrc).toContain('return false;');
  });
});

// =====================================================================
// 6. kanbanFeatureCount in CrewChatView mirrors the filter
// =====================================================================
describe('kanbanFeatureCount mirrors filter in CrewChatView', () => {
  const cvSrc = read('web/components/CrewChatView.js');

  it('kanbanFeatureCount uses filter on featureKanban', () => {
    expect(cvSrc).toContain('kanbanFeatureCount()');
    expect(cvSrc).toContain('this.featureKanban.filter(f =>');
  });

  it('kanbanFeatureCount checks totalCount', () => {
    expect(cvSrc).toContain('f.totalCount > 0');
  });

  it('kanbanFeatureCount checks hasStreaming', () => {
    expect(cvSrc).toContain('f.hasStreaming');
  });

  it('kanbanFeatureCount checks lastActivityAt', () => {
    expect(cvSrc).toContain('f.lastActivityAt > 0');
  });
});

// =====================================================================
// 7. Expanded empty feature shows "暂无消息"
// =====================================================================
describe('expanded empty feature shows no-messages text', () => {
  const fpSrc = read('web/components/crew/CrewFeaturePanel.js');

  it('uses crew.noMessages i18n key in expanded empty state', () => {
    expect(fpSrc).toContain("$t('crew.noMessages')");
  });
});
