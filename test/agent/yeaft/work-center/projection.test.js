import { describe, expect, it } from 'vitest';
import { projectWorkCenterEvent, projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';

describe('Work Center event projection', () => {
  it('never broadcasts local paths, Run evidence, model snapshots, or errors', () => {
    const projected = projectWorkCenterEvent({
      type: 'run.finished',
      workItem: {
        id: 'wi-1', revision: 1, title: 'Fix', goal: 'Goal', status: 'waiting',
        currentActionId: 'a-1', workDir: '/private/project',
        origin: { sessionId: 's-1', messageId: 'm-1', createdBy: 'linus' },
        linkedSessionIds: ['s-1'], createdAt: 1, updatedAt: 2,
        actions: [{ id: 'a-1', type: 'review', requiredRole: 'martin', status: 'completed' }],
        runs: [{ evidence: [{ output: 'secret' }], error: 'private', modelSnapshot: { id: 'secret-model' } }],
      },
    });
    expect(projected.workItem).toMatchObject({ id: 'wi-1', status: 'waiting' });
    const wire = JSON.stringify(projected);
    expect(wire).not.toContain('/private/project');
    expect(wire).not.toContain('secret-model');
    expect(wire).not.toContain('secret');
    expect(wire).not.toContain('m-1');
    expect(wire).not.toContain('linus');
  });

  it('projects authenticated detail without persona or execution-only tool snapshots', () => {
    const projected = projectWorkItemDetail({
      id: 'wi-1', revision: 2, title: 'Fix', goal: 'Goal', status: 'running',
      acceptanceCriteria: ['Safe detail'], workflowTemplate: 'software-change',
      currentActionId: 'a-1', currentRunId: 'r-1', workDir: '/project', reuseMemory: true,
      origin: { sessionId: 's-1', messageId: 'secret-message', createdBy: 'linus' },
      linkedSessionIds: ['s-1'], createdAt: 1, updatedAt: 2,
      actions: [{
        id: 'a-1', workItemId: 'wi-1', sequence: 1, type: 'review', stageId: 'review',
        assignmentPolicy: { mode: 'auto', capability: 'review' },
        modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' },
        status: 'running', createdAt: 1, updatedAt: 2,
      }],
      runs: [{
        id: 'r-1', actionId: 'a-1', workItemId: 'wi-1', status: 'running', startedAt: 1,
        roleSnapshot: { id: 'review', actionType: 'review', selectionReason: 'auto:review', assignmentPolicy: { mode: 'auto' } },
        vpSnapshot: { id: 'martin', name: 'Martin', role: 'Reviewer', persona: 'secret persona', personaHash: 'secret-hash' },
        modelSnapshot: { id: 'provider/review', provider: 'provider', effort: 'high', policy: { mode: 'specific' } },
        toolPolicySnapshot: {
          allowedToolNames: ['FileRead'], readRoots: ['/private/read'], writeRoots: ['/private/write'],
          shell: { fixedCwd: '/private/cwd' },
        },
      }],
      events: [{ id: 'e-1', workItemId: 'wi-1', actionId: 'a-1', runId: 'r-1', type: 'run.started', data: { secret: true }, createdAt: 1 }],
    });

    expect(projected.runs[0]).toMatchObject({
      vpSnapshot: { id: 'martin', name: 'Martin', role: 'Reviewer' },
      modelSnapshot: { id: 'provider/review', provider: 'provider', effort: 'high' },
    });
    expect(projected.events[0]).toEqual({
      id: 'e-1', workItemId: 'wi-1', actionId: 'a-1', runId: 'r-1', type: 'run.started', createdAt: 1,
    });
    const wire = JSON.stringify(projected);
    for (const secret of ['/project', 'secret persona', 'secret-hash', 'allowedToolNames', '/private/read', '/private/write', '/private/cwd', 'secret-message']) {
      expect(wire).not.toContain(secret);
    }
  });
});
