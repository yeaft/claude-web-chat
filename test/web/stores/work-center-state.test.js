import { describe, expect, it } from 'vitest';
import {
  applyWorkItemSummary,
  isWorkItemSummaryStale,
  mergeWorkItemSummary,
} from '../../../web/stores/helpers/work-center.js';

describe('Work Center summary state', () => {
  const detail = {
    id: 'wi-1',
    revision: 3,
    title: 'Current title',
    goal: 'Current goal',
    status: 'running',
    updatedAt: 30,
    workDir: '/local/project',
    actions: [{
      id: 'action-1', loopCount: 2, toolCount: 5, response: 'Reading files',
      progressRevision: 2,
    }],
  };

  it('merges a redacted summary without dropping loaded detail data', () => {
    const merged = mergeWorkItemSummary(detail, {
      id: 'wi-1', revision: 3, title: 'Updated title', status: 'waiting', updatedAt: 31,
      workItemType: 'bug-fix', planningMode: 'ai',
    });
    expect(merged).toMatchObject({
      title: 'Updated title', status: 'waiting', updatedAt: 31,
      workItemType: 'bug-fix', planningMode: 'ai',
    });
    expect(merged.actions).toEqual(detail.actions);
    expect(merged.workDir).toBe('/local/project');
  });

  it('patches live Action aggregate counts without replacing detail Actions', () => {
    const merged = mergeWorkItemSummary(detail, {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      actionStats: [{
        id: 'action-1', status: 'running', loopCount: 4, toolCount: 9,
        response: 'Implemented the fix', progressRevision: 3,
      }],
    });
    expect(merged.actions).toEqual([{
      id: 'action-1', status: 'running', loopCount: 4, toolCount: 9,
      response: 'Implemented the fix', progressRevision: 3,
    }]);
  });

  it('does not let a legacy Action patch without a progress revision erase live response text', () => {
    const merged = mergeWorkItemSummary(detail, {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      actionStats: [{ id: 'action-1', status: 'running', loopCount: 3, toolCount: 7 }],
    });
    expect(merged.actions[0]).toMatchObject({
      response: 'Reading files', progressRevision: 2, loopCount: 3, toolCount: 7,
    });
  });

  it('rejects an out-of-order Action progress patch within the same WorkItem revision', () => {
    const merged = mergeWorkItemSummary(detail, {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      actionStats: [{
        id: 'action-1', status: 'running', loopCount: 1, toolCount: 1,
        response: 'Stale response', progressRevision: 1,
      }],
    });
    expect(merged.actions).toEqual(detail.actions);
  });

  it('rejects an older revision even when its timestamp is newer', () => {
    const stale = { id: 'wi-1', revision: 2, status: 'done', updatedAt: 99 };
    expect(isWorkItemSummaryStale(stale, detail)).toBe(true);
    expect(mergeWorkItemSummary(detail, stale)).toBe(detail);
    expect(applyWorkItemSummary([detail], stale)[0]).toBe(detail);
  });

  it('rejects an older event within the same revision', () => {
    const stale = { id: 'wi-1', revision: 3, status: 'ready', updatedAt: 29 };
    expect(isWorkItemSummaryStale(stale, detail)).toBe(true);
    expect(mergeWorkItemSummary(detail, stale)).toBe(detail);
  });

  it('accepts a newer revision even if clocks move backwards', () => {
    const next = { id: 'wi-1', revision: 4, status: 'ready', updatedAt: 20 };
    expect(isWorkItemSummaryStale(next, detail)).toBe(false);
    expect(mergeWorkItemSummary(detail, next)).toMatchObject({ revision: 4, status: 'ready' });
  });
});
