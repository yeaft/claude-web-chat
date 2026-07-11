import { describe, expect, it } from 'vitest';
import { projectWorkCenterEvent, projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';

function internalDetail() {
  return {
    id: 'wi-1', revision: 2, title: 'Fix', goal: 'Goal', status: 'waiting',
    acceptanceCriteria: ['Safe detail'], workflowTemplate: 'software-change',
    currentActionId: 'a-1', currentRunId: 'r-2', workDir: '/project', reuseMemory: true,
    origin: { sessionId: 's-1', messageId: 'secret-message', createdBy: 'linus' },
    linkedSessionIds: ['s-1'], createdAt: 1, updatedAt: 2,
    actions: [{
      id: 'a-1', workItemId: 'wi-1', sequence: 1, type: 'review', stageId: 'review',
      assignmentPolicy: { mode: 'auto', capability: 'review', candidateVpIds: ['martin'] },
      modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' },
      status: 'completed', createdAt: 1, updatedAt: 2,
    }],
    runs: [{
      id: 'r-2', actionId: 'a-1', workItemId: 'wi-1', status: 'waiting', startedAt: 2,
      summary: 'private latest summary', evidence: [{ output: 'secret latest evidence' }],
      waitingReason: 'Choose the compatibility behavior', error: 'private latest error',
      loopCount: 2, toolCount: 5,
      roleSnapshot: { id: 'review', actionType: 'review', selectionReason: 'auto:review' },
      vpSnapshot: { id: 'martin', name: 'Martin', persona: 'secret persona' },
      modelSnapshot: { id: 'provider/review', provider: 'provider', effort: 'high' },
      toolPolicySnapshot: { allowedToolNames: ['FileRead'], readRoots: ['/private/read'] },
    }, {
      id: 'r-1', actionId: 'a-1', workItemId: 'wi-1', status: 'retryable', startedAt: 1,
      summary: 'private earlier summary', evidence: [{ output: 'secret earlier evidence' }],
      loopCount: 1, toolCount: 3,
    }],
    events: [{
      id: 'e-1', workItemId: 'wi-1', actionId: 'a-1', runId: 'r-1',
      type: 'run.started', data: { secret: true }, createdAt: 1,
    }],
  };
}

describe('Work Center event projection', () => {
  it('broadcasts only list state plus live Action aggregate counts', () => {
    const detail = internalDetail();
    const projected = projectWorkCenterEvent({ type: 'run.finished', workItem: detail });

    expect(projected.workItem).toMatchObject({ id: 'wi-1', status: 'waiting' });
    expect(projected.workItem.actionStats).toEqual([
      { id: 'a-1', status: 'completed', loopCount: 3, toolCount: 8 },
    ]);
    const wire = JSON.stringify(projected);
    for (const secret of [
      '/project', 'provider/review', 'private latest summary', 'secret latest evidence',
      'private latest error', 'secret-message', 'linus', 'Choose the compatibility behavior',
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('projects Action aggregate counts without Run, event, model, or evidence detail', () => {
    const projected = projectWorkItemDetail(internalDetail());

    expect(projected).toMatchObject({
      id: 'wi-1',
      waitingReason: 'Choose the compatibility behavior',
      actions: [{
        id: 'a-1', sequence: 1, type: 'review', stageId: 'review',
        assignmentPolicy: { mode: 'auto', fixedVpId: null },
        status: 'completed', loopCount: 3, toolCount: 8,
      }],
    });
    expect(projected).not.toHaveProperty('currentRunId');
    expect(projected).not.toHaveProperty('runs');
    expect(projected).not.toHaveProperty('events');
    expect(projected.actions[0]).not.toHaveProperty('modelPolicy');
    const wire = JSON.stringify(projected);
    for (const secret of [
      '/project', 'provider/review', 'private latest summary', 'secret latest evidence',
      'private latest error', 'secret persona', 'allowedToolNames', '/private/read',
      'secret-message', 'candidateVpIds',
    ]) {
      expect(wire).not.toContain(secret);
    }
  });
});
