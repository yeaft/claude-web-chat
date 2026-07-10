import { describe, expect, it } from 'vitest';
import { projectWorkCenterEvent } from '../../../../agent/yeaft/work-center/projection.js';

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
});
