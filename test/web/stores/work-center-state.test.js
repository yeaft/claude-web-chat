import { describe, expect, it } from 'vitest';
import {
  applyWorkItemSummary,
  isWorkItemSummaryStale,
  mergeActionMessages,
  mergeWorkItemSummary,
  workItemDetailNeedsRefresh,
} from '../../../web/stores/helpers/work-center.js';
import { projectWorkCenterEvent, projectWorkItemSummary } from '../../../agent/yeaft/work-center/projection.js';

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
      workItemType: 'bug-fix', planningMode: 'ai', failureReason: 'Action failed safely',
    });
    expect(merged).toMatchObject({
      title: 'Updated title', status: 'waiting', updatedAt: 31,
      workItemType: 'bug-fix', planningMode: 'ai', failureReason: 'Action failed safely',
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
        response: 'Implemented the fix', failureReason: 'Tests failed', progressRevision: 3,
      }],
    });
    expect(merged.actions).toEqual([{
      id: 'action-1', status: 'running', loopCount: 4, toolCount: 9,
      executionStats: { llmRequestCount: 5, loopCount: 4, toolCount: 9, totalTokens: 450 },
      response: 'Implemented the fix', failureReason: 'Tests failed', progressRevision: 3,
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

  it('keeps a newer paged terminal message over stale current and live copies', () => {
    const messageId = 'run:run-1';
    const messages = mergeActionMessages(
      [{ id: messageId, status: 'completed', text: 'Final result', progressRevision: 6, updatedAt: 60 }],
      [{ id: messageId, status: 'running', text: 'Current stale text', progressRevision: 5, updatedAt: 50 }],
      { id: messageId, status: 'running', text: 'Live stale text', progressRevision: 5, updatedAt: 55 },
    );

    expect(messages).toEqual([{
      id: messageId, status: 'completed', text: 'Final result', progressRevision: 6, updatedAt: 60,
    }]);
  });

  it('prefers a terminal message over running text at the same revision', () => {
    const messageId = 'run:run-1';
    const messages = mergeActionMessages(
      [{ id: messageId, status: 'completed', text: 'Final result', progressRevision: 6, updatedAt: 60 }],
      [{ id: messageId, status: 'running', text: 'Late running frame', progressRevision: 6, updatedAt: 70 }],
    );

    expect(messages[0]).toMatchObject({
      id: messageId, status: 'completed', text: 'Final result', progressRevision: 6,
    });
  });

  it('does not treat an intermediate status as terminal at the same revision', () => {
    const messageId = 'run:run-1';
    const messages = mergeActionMessages(
      [{ id: messageId, status: 'waiting', text: 'Waiting for input', progressRevision: 6, updatedAt: 50 }],
      [{ id: messageId, status: 'running', text: 'Work resumed', progressRevision: 6, updatedAt: 60 }],
    );

    expect(messages[0]).toMatchObject({
      id: messageId, status: 'running', text: 'Work resumed', progressRevision: 6,
    });
  });

  it('converges on the same fresh Action messages regardless of source order', () => {
    const stale = { id: 'run:run-1', status: 'running', text: 'Working', progressRevision: 4, updatedAt: 40 };
    const fresh = { id: 'run:run-1', status: 'failed', text: 'Provider rejected the request', progressRevision: 5, updatedAt: 50 };
    const other = { id: 'event:input-1', status: 'sent', text: 'Retry with a smaller file', createdAt: 30 };

    expect(mergeActionMessages([stale, other], fresh))
      .toEqual(mergeActionMessages(fresh, [other, stale]));
    expect(mergeActionMessages([stale, other], fresh).find(message => message.id === 'run:run-1'))
      .toMatchObject({ id: 'run:run-1', status: 'failed', progressRevision: 5 });
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

  it('keeps detail status and failure reason behind the same stale Action progress fence', () => {
    const current = {
      ...detail,
      status: 'needs_attention',
      currentAction: { id: 'action-1', status: 'failed' },
      failureReason: 'NEW failure',
      updatedAt: 31,
      actions: [{ ...detail.actions[0], status: 'failed', failureReason: 'NEW failure', progressRevision: 9 }],
    };
    const merged = mergeWorkItemSummary(current, {
      id: 'wi-1', revision: 3, updatedAt: 31, status: 'running',
      currentActionId: 'action-1', currentAction: { id: 'action-1', status: 'running' },
      failureReason: 'OLD failure',
      actionStats: [{ id: 'action-1', status: 'running', failureReason: 'OLD failure', progressRevision: 8 }],
    });

    expect(merged).toMatchObject({
      status: 'needs_attention', currentAction: { status: 'failed' }, failureReason: 'NEW failure',
    });
    expect(merged.actions[0]).toMatchObject({ status: 'failed', failureReason: 'NEW failure', progressRevision: 9 });
  });

  it('keeps the safe current Action objective after a live event replaces the list summary', () => {
    const listDetail = {
      id: 'wi-1', revision: 3, title: 'Verify recovery', goal: 'Keep recovery reliable',
      status: 'running', currentActionId: 'action-1', actionCount: 1, completedActionCount: 0,
      currentAction: {
        id: 'action-1', type: 'test', stageId: 'verify', status: 'running',
        brief: {
          objective: 'Verify login recovery',
          approach: 'Read private execution context',
          expectedOutcome: 'Do not expose this result',
        },
      },
      createdAt: 10, updatedAt: 30,
    };
    const eventDetail = {
      ...listDetail,
      updatedAt: 31,
      actions: [{
        ...listDetail.currentAction,
        assignmentPolicy: { mode: 'auto', capability: 'test' },
        context: [{ kind: 'private', value: 'secret context' }],
      }],
      runs: [],
      events: [],
    };

    const initial = projectWorkItemSummary(listDetail);
    const eventSummary = projectWorkCenterEvent({ type: 'run.progress', workItem: eventDetail }).workItem;
    const updated = applyWorkItemSummary([initial], eventSummary)[0];

    expect(updated.currentAction).toEqual({
      id: 'action-1', type: 'test', stageId: 'verify', assignmentMode: 'auto',
      status: 'running', objective: 'Verify login recovery',
    });
    expect(JSON.stringify(updated.currentAction)).not.toContain('private execution context');
    expect(JSON.stringify(updated.currentAction)).not.toContain('Do not expose this result');
    expect(JSON.stringify(eventSummary)).not.toContain('secret context');
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

  it('keeps list status and failure reason behind the same stale Action progress fence', () => {
    const current = {
      id: 'wi-1', revision: 3, updatedAt: 31, status: 'needs_attention',
      currentActionId: 'action-1', currentAction: { id: 'action-1', status: 'failed' },
      failureReason: 'NEW failure', executionStats: { totalTokens: 500 },
      actionStats: [{ id: 'action-1', status: 'failed', failureReason: 'NEW failure', progressRevision: 9 }],
    };
    const stale = {
      id: 'wi-1', revision: 3, updatedAt: 31, status: 'running',
      currentActionId: 'action-1', currentAction: { id: 'action-1', status: 'running' },
      failureReason: 'OLD failure', executionStats: { totalTokens: 400 },
      actionStats: [{ id: 'action-1', status: 'running', failureReason: 'OLD failure', progressRevision: 8 }],
    };

    expect(applyWorkItemSummary([current], stale)[0]).toEqual(current);
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
