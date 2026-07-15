import { describe, expect, it } from 'vitest';
import {
  applyWorkItemSummary,
  isWorkItemSummaryStale,
  mergeWorkItemSummary,
  workItemDetailNeedsRefresh,
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
      id: 'action-1', loopCount: 2, toolCount: 5,
      executionStats: { llmRequestCount: 2, loopCount: 2, toolCount: 5, totalTokens: 100 },
      response: 'Reading files', progressRevision: 2,
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

  it('requests a detail refresh only when the current Action is missing locally', () => {
    expect(workItemDetailNeedsRefresh(detail, { id: 'wi-1', currentActionId: 'action-1' })).toBe(false);
    expect(workItemDetailNeedsRefresh(detail, { id: 'wi-1', currentActionId: 'action-2' })).toBe(true);
    expect(workItemDetailNeedsRefresh(detail, { id: 'wi-2', currentActionId: 'action-2' })).toBe(false);
  });

  it('patches live Action aggregate counts without replacing detail Actions', () => {
    const merged = mergeWorkItemSummary(detail, {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      actionStats: [{
        id: 'action-1', status: 'running', loopCount: 4, toolCount: 9,
        executionStats: { llmRequestCount: 5, loopCount: 4, toolCount: 9, totalTokens: 450 },
        response: 'Implemented the fix', progressRevision: 3,
      }],
    });
    expect(merged.actions).toEqual([{
      id: 'action-1', status: 'running', loopCount: 4, toolCount: 9,
      executionStats: { llmRequestCount: 5, loopCount: 4, toolCount: 9, totalTokens: 450 },
      response: 'Implemented the fix', progressRevision: 3,
    }]);
    expect(merged.actions[0].executionStats.totalTokens).toBe(450);
  });

  it('merges a stable live assistant message into the selected Action', () => {
    const merged = mergeWorkItemSummary(detail, {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      actionStats: [{
        id: 'action-1', status: 'running', progressRevision: 3,
        liveMessage: {
          id: 'run:run-live', role: 'assistant', status: 'running',
          text: 'Live AI text', progressRevision: 3,
        },
      }],
    });
    expect(merged.actions[0].liveMessage).toMatchObject({
      id: 'run:run-live', text: 'Live AI text', progressRevision: 3,
    });
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

  it('rejects an out-of-order Action and WorkItem aggregate within the same revision', () => {
    const current = {
      ...detail,
      updatedAt: 31,
      executionStats: { llmRequestCount: 5, loopCount: 4, toolCount: 9, totalTokens: 500 },
      actions: [{
        ...detail.actions[0], progressRevision: 5,
        executionStats: { llmRequestCount: 5, loopCount: 4, toolCount: 9, totalTokens: 500 },
      }],
    };
    const merged = mergeWorkItemSummary(current, {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      executionStats: { llmRequestCount: 2, loopCount: 1, toolCount: 1, totalTokens: 200 },
      actionStats: [{
        id: 'action-1', status: 'running', loopCount: 1, toolCount: 1,
        executionStats: { llmRequestCount: 2, loopCount: 1, toolCount: 1, totalTokens: 200 },
        response: 'Stale response', progressRevision: 2,
      }],
    });
    expect(merged.actions).toEqual(current.actions);
    expect(merged.executionStats.totalTokens).toBe(500);
  });

  it('does not let an out-of-order list event roll aggregate usage backwards', () => {
    const fresh = {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      executionStats: { llmRequestCount: 5, loopCount: 4, toolCount: 9, totalTokens: 500 },
      actionStats: [{
        id: 'action-1', status: 'running', progressRevision: 5,
        executionStats: { llmRequestCount: 5, loopCount: 4, toolCount: 9, totalTokens: 500 },
      }],
    };
    const stale = {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      executionStats: { llmRequestCount: 2, loopCount: 1, toolCount: 1, totalTokens: 200 },
      actionStats: [{
        id: 'action-1', status: 'running', progressRevision: 2,
        executionStats: { llmRequestCount: 2, loopCount: 1, toolCount: 1, totalTokens: 200 },
      }],
    };

    const items = applyWorkItemSummary(applyWorkItemSummary([], fresh), stale);
    expect(items[0].executionStats.totalTokens).toBe(500);
    expect(items[0].actionStats[0].progressRevision).toBe(5);
  });

  it('keeps aggregate usage when any Action in a list event is stale', () => {
    const current = {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      executionStats: { llmRequestCount: 8, loopCount: 6, toolCount: 12, totalTokens: 800 },
      actionStats: [
        { id: 'action-1', progressRevision: 5, executionStats: { totalTokens: 500 } },
        { id: 'action-2', progressRevision: 3, executionStats: { totalTokens: 300 } },
      ],
    };
    const mixed = {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      executionStats: { llmRequestCount: 7, loopCount: 5, toolCount: 11, totalTokens: 700 },
      actionStats: [
        { id: 'action-1', progressRevision: 4, executionStats: { totalTokens: 400 } },
        { id: 'action-2', progressRevision: 4, executionStats: { totalTokens: 300 } },
      ],
    };

    const result = applyWorkItemSummary([current], mixed)[0];
    expect(result.executionStats.totalTokens).toBe(800);
    expect(result.actionStats).toEqual(current.actionStats);
  });

  it('accepts lower Action progress after the WorkItem version advances', () => {
    const current = {
      id: 'wi-1', revision: 3, status: 'running', updatedAt: 31,
      executionStats: { totalTokens: 500 },
      actionStats: [{ id: 'action-1', progressRevision: 5 }],
    };
    const next = {
      id: 'wi-1', revision: 4, status: 'ready', updatedAt: 32,
      executionStats: { totalTokens: 0 },
      actionStats: [{ id: 'action-2', progressRevision: 1 }],
    };

    expect(applyWorkItemSummary([current], next)[0]).toEqual(next);
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
